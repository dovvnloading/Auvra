import { dot, sub, type PinCorrectionBudget, type Point } from './contactGeometry';
import type { CookedGarment } from './pattern';

export interface LayerFace { a: number; b: number; c: number }
type Weights = [number, number, number];
interface Corner { inner: Weights; outer: Weights }
interface Contact extends Corner {
    innerFace: LayerFace; outerFace: LayerFace; normal: Point;
    denom: number; guardPins: boolean; maxMove: number; blocked: boolean;
}

export const GARMENT_LAYER_LIMITS = Object.freeze({
    contacts: 4096, passes: 8, minimumNormalDot: 0.5, recoveryGaps: 3,
    sweptIterations: 48, sweptToleranceFraction: 0.005, maxPinLeverage: 4,
});

export interface LayerContactStats {
    layeredPairs: number; layerFallbackPairs: number; layerContacts: number;
    layerProjections: number; layerBlocked: number; maxLayerDeficit: number;
    layerCapacityLimited: boolean;
}
export const newLayerStats = (): LayerContactStats => ({
    layeredPairs: 0, layerFallbackPairs: 0, layerContacts: 0, layerProjections: 0, layerBlocked: 0, maxLayerDeficit: 0, layerCapacityLimited: false,
});

export function hasGarmentLayers(mesh: CookedGarment): boolean {
    const first = mesh.panelRanges[0]?.layer ?? 0;
    return mesh.panelRanges.some(p => (p.layer ?? 0) !== first);
}

const vertex = (p: Float32Array, i: number): Point => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
const cross = (a: Point, b: Point): Point => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

function frame(p: Float32Array, face: LayerFace) {
    const a = vertex(p, face.a), ab = sub(vertex(p, face.b), a), ac = sub(vertex(p, face.c), a);
    const n = cross(ab, ac), area = Math.hypot(...n);
    if (area < 1e-12) return null;
    const normal: Point = [n[0] / area, n[1] / area, n[2] / area];
    return { a, ab, ac, normal, area };
}

function interpolate(a: Weights, b: Weights, t: number): Weights {
    return [a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1]), a[2] + t*(b[2]-a[2])];
}

/** Clip the outer triangle's projection to the inner triangle in its own barycentric chart.
 * Each resulting point has material coordinates on both surfaces, including interior edge crossings. */
function footprint(outer: LayerFace, p: Float32Array, inner: NonNullable<ReturnType<typeof frame>>): Corner[] {
    const { a, ab, ac, normal, area } = inner;
    const gradB = cross(ac, normal), gradC = cross(normal, ab);
    let polygon: Corner[] = [outer.a, outer.b, outer.c].map((index, k) => {
        const r = sub(vertex(p, index), a), b = dot(r, gradB) / area, c = dot(r, gradC) / area;
        const outerWeights: Weights = [0, 0, 0];
        outerWeights[k] = 1;
        return { inner: [1-b-c, b, c], outer: outerWeights };
    });
    for (let k = 0; k < 3 && polygon.length; k++) {
        const cut: Corner[] = [];
        let prev = polygon[polygon.length - 1];
        for (const next of polygon) {
            const d0 = prev.inner[k], d1 = next.inner[k];
            if ((d0 < -1e-9) !== (d1 < -1e-9)) {
                const t = Math.max(0, Math.min(1, d0 / (d0 - d1)));
                cut.push({ inner: interpolate(prev.inner, next.inner, t), outer: interpolate(prev.outer, next.outer, t) });
            }
            if (d1 >= -1e-9) cut.push(next);
            prev = next;
        }
        polygon = cut;
    }
    return polygon;
}

function signedGap(p: Float32Array, inner: LayerFace, outer: LayerFace, point: Corner, n: Point): number {
    let s = 0;
    for (let j = 0; j < 3; j++) {
        const lo = point.inner[0]*p[3*inner.a+j] + point.inner[1]*p[3*inner.b+j] + point.inner[2]*p[3*inner.c+j];
        const hi = point.outer[0]*p[3*outer.a+j] + point.outer[1]*p[3*outer.b+j] + point.outer[2]*p[3*outer.c+j];
        s += n[j] * (hi - lo);
    }
    return s;
}

const vertexAt = (f: LayerFace, k: number) => k === 0 ? f.a : k === 1 ? f.b : f.c;

/** A unilateral separation manifold for assigned layers in one garment instance.
 * Rank chooses a side, independent of rank distance. Clearance is the sum of the two
 * surface offsets. Known pin constraints take precedence over an impossible contact. */
export class GarmentLayerContact {
    private readonly contacts: Contact[] = [];
    constructor(private readonly inverseMass: Float64Array, private readonly pinBudget: PinCorrectionBudget) {}
    reset(): void { this.contacts.length = 0; }

    gather(start: Float32Array, end: Float32Array, inner: LayerFace, outer: LayerFace, gap: number,
        stats: LayerContactStats & { testedFeatures: number; limited: boolean }, featureBudget: number): boolean {
        const lo = frame(end, inner), hi = frame(end, outer), prevLo = frame(start, inner), prevHi = frame(start, outer);
        const aligned = GARMENT_LAYER_LIMITS.minimumNormalDot;
        if (!lo || !hi || !prevLo || !prevHi || dot(lo.normal, hi.normal) < aligned ||
            dot(prevLo.normal, prevHi.normal) < aligned || dot(lo.normal, prevLo.normal) < aligned || dot(hi.normal, prevHi.normal) < aligned) {
            stats.layerFallbackPairs++;
            return false;
        }
        const corners = footprint(outer, end, lo);
        if (!corners.length) {
            // Endpoints can separate after touching mid-tick while sliding past a boundary.
            stats.layerFallbackPairs++;
            return false;
        }
        stats.layeredPairs++;
        for (const corner of corners) {
            if (stats.testedFeatures >= featureBudget) { stats.limited = true; break; }
            stats.testedFeatures++;
            const s1 = signedGap(end, inner, outer, corner, lo.normal);
            if (s1 > 2 * gap) continue;
            // Recover a locally inverted arrangement, or block a fast crossing from the expected side.
            // Distant back-side layers are never drawn through another part of the garment.
            const recovery = gap === 0 ? -1e-7 : -GARMENT_LAYER_LIMITS.recoveryGaps * gap;
            if (s1 < recovery && signedGap(start, inner, outer, corner, prevLo.normal) < recovery) continue;
            if (this.contacts.length >= GARMENT_LAYER_LIMITS.contacts) {
                stats.layerCapacityLimited = stats.limited = true;
                break;
            }
            let pinned = false, maxGradient = 0, denom = 0;
            for (let k = 0; k < 3; k++) {
                const m0 = this.inverseMass[vertexAt(inner, k)], m1 = this.inverseMass[vertexAt(outer, k)];
                pinned ||= (m0 === 0 && corner.inner[k] > 0) || (m1 === 0 && corner.outer[k] > 0);
                maxGradient = Math.max(maxGradient, m0 * Math.abs(corner.inner[k]), m1 * Math.abs(corner.outer[k]));
                denom += m0 * corner.inner[k]**2 + m1 * corner.outer[k]**2;
            }
            // A contact close to a pinned edge can have arbitrarily small free barycentric
            // weight. Resolving it exactly would lever the opposite corner metres away.
            // Bound travel across all such witnesses and solver sweeps, retaining room
            // to undo a genuinely fast incoming crossing.
            const s0 = signedGap(start, inner, outer, corner, prevLo.normal);
            const maxMove = GARMENT_LAYER_LIMITS.maxPinLeverage * Math.max(gap, gap - s1, Math.abs(s1 - s0));
            const guardPins = pinned && maxGradient > GARMENT_LAYER_LIMITS.maxPinLeverage * denom;
            this.contacts.push({ ...corner, innerFace: inner, outerFace: outer, normal: lo.normal,
                denom, guardPins, maxMove, blocked: denom === 0 });
            stats.layerContacts++;
        }
        return true;
    }

    project(p: Float32Array, gap: number, stats: LayerContactStats): void {
        for (let pass = 0; pass < GARMENT_LAYER_LIMITS.passes; pass++) {
            let corrected = false;
            for (let i = 0; i < this.contacts.length; i++) {
                const q = this.contacts[pass % 2 ? this.contacts.length - 1 - i : i];
                const violation = gap - signedGap(p, q.innerFace, q.outerFace, q, q.normal);
                if (violation < 1e-7) continue;
                if (q.denom <= 0) continue;
                const requested = violation / q.denom;
                let lambda = requested;
                if (q.guardPins) {
                    for (let k = 0; k < 3; k++) {
                        const a = vertexAt(q.innerFace, k), b = vertexAt(q.outerFace, k);
                        lambda = this.pinBudget.limit(lambda, a, this.inverseMass[a] * Math.abs(q.inner[k]), q.maxMove);
                        lambda = this.pinBudget.limit(lambda, b, this.inverseMass[b] * Math.abs(q.outer[k]), q.maxMove);
                    }
                    if (lambda < requested) q.blocked = true;
                    if (lambda <= 0) continue;
                }
                for (let k = 0; k < 3; k++) {
                    const a = vertexAt(q.innerFace, k), b = vertexAt(q.outerFace, k);
                    const da = -lambda * this.inverseMass[a] * q.inner[k], db = lambda * this.inverseMass[b] * q.outer[k];
                    if (q.guardPins) {
                        this.pinBudget.record(a, da);
                        this.pinBudget.record(b, db);
                    }
                    for (let j = 0; j < 3; j++) {
                        p[3*a+j] += da * q.normal[j];
                        p[3*b+j] += db * q.normal[j];
                    }
                }
                stats.layerProjections++;
                corrected = true;
            }
            if (!corrected) break;
        }
        for (const q of this.contacts) {
            const deficit = gap - signedGap(p, q.innerFace, q.outerFace, q, q.normal);
            if (deficit > 1e-7 && q.blocked) stats.layerBlocked++;
            stats.maxLayerDeficit = Math.max(stats.maxLayerDeficit, deficit);
        }
    }
}
