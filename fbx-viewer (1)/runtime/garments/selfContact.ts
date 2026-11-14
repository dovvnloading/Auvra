import type { CookedGarment } from './pattern';
import { GARMENT_LAYER_LIMITS, GarmentLayerContact, hasGarmentLayers, newLayerStats, type LayerContactStats } from './layerContact';
import { dot, sub, PinCorrectionBudget, segmentWeights, triangleWeights, type Point } from './contactGeometry';
type Edge = [number, number];
interface Face { a: number; b: number; c: number; edges: [number, number, number] }
interface Bounds { min: Point; max: Point; face: number }

const length = (p: Point) => Math.sqrt(dot(p, p));

function sample(start: Float32Array, end: Float32Array, vertex: number, t: number): Point {
    const j = vertex * 3;
    return [
        start[j] + t * (end[j] - start[j]),
        start[j + 1] + t * (end[j + 1] - start[j + 1]),
        start[j + 2] + t * (end[j + 2] - start[j + 2]),
    ];
}

const ZERO_GAP_TOLERANCE = 1e-7; // metres; used for CCD evaluation, never as the separation target
type Stencil = [number, number, number, number];
interface Separation { weights: Stencil; normal: Point; distance: number }

function separation(vertices: Point[], vertexFace: boolean): Separation | null {
    let weights: Stencil;
    if (vertexFace) {
        const bary = triangleWeights(vertices[0], vertices[1], vertices[2], vertices[3]);
        if (!bary) return null;
        weights = [1, -bary[0], -bary[1], -bary[2]];
    } else {
        const [u, v] = segmentWeights(vertices[0], vertices[1], vertices[2], vertices[3]);
        weights = [1 - u, u, v - 1, -v];
    }
    const normal: Point = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
        for (let j = 0; j < 3; j++) normal[j] += vertices[k][j] * weights[k];
    }
    const distance = length(normal);
    if (distance > 1e-12) for (let j = 0; j < 3; j++) normal[j] /= distance;
    return { weights, normal, distance };
}

export interface SelfContactStats extends LayerContactStats {
    facePairs: number;
    testedFeatures: number;
    vertexFace: number;
    edgeEdge: number;
    limited: boolean;
    broadPhaseLimited: boolean;
    featureCapacityLimited: boolean;
    advancementLimited: number;
    pinLimited: number;
}

const EMPTY_CONTACT_STATS: Readonly<SelfContactStats> = Object.freeze({
    ...newLayerStats(), facePairs: 0, testedFeatures: 0, vertexFace: 0, edgeEdge: 0,
    limited: false, broadPhaseLimited: false, featureCapacityLimited: false, advancementLimited: 0, pinLimited: 0,
});

/** Bounded preview of contacts within one cooked instance. Each query follows linear
 * trajectories from the accepted start to the current endpoint. One contact sweep
 * can create another contact elsewhere. The external diagnostic reports truncated work. */
export class GarmentSelfContact {
    readonly stats: SelfContactStats = { ...EMPTY_CONTACT_STATS };
    private readonly faces: Face[] = [];
    private readonly edges: Edge[] = [];
    private readonly canonical: Int32Array;
    private readonly bounds: Bounds[] = [];
    private readonly vertexCount: number;
    private readonly vertexFaceSeen = new Set<number>();
    private readonly edgeEdgeSeen = new Set<number>();
    private previousZeroNormals = new Map<number, Point>();
    private currentZeroNormals = new Map<number, Point>();
    private readonly inverseMass: Float64Array;
    private readonly maxFeatures: number;
    private readonly maxBroadTests: number;
    private broadTests = 0;
    private readonly faceRanks: Uint8Array | null;
    private readonly layerContact: GarmentLayerContact | null;
    private readonly pinBudget: PinCorrectionBudget;

    constructor(mesh: CookedGarment, inverseMass: Float64Array, maxFeatures = 40000, maxBroadTests = 120000, private readonly includeSameLayer = true) {
        this.faceRanks = hasGarmentLayers(mesh) ? new Uint8Array(mesh.indices.length / 3) : null;
        this.pinBudget = new PinCorrectionBudget(inverseMass.length);
        this.layerContact = this.faceRanks ? new GarmentLayerContact(inverseMass, this.pinBudget) : null;
        if (this.faceRanks) {
            for (const panel of mesh.panelRanges) {
                this.faceRanks.fill(panel.layer ?? 0, panel.indexStart / 3, (panel.indexStart + panel.indexCount) / 3);
            }
        }
        this.vertexCount = inverseMass.length;
        this.inverseMass = inverseMass;
        this.maxFeatures = maxFeatures;
        this.maxBroadTests = maxBroadTests;
        this.canonical = Int32Array.from({ length: this.vertexCount }, (_, i) => i);
        const root = (i: number) => {
            while (this.canonical[i] !== i) { this.canonical[i] = this.canonical[this.canonical[i]]; i = this.canonical[i]; }
            return i;
        };
        // Only points sewn directly or transitively to each other share incidence.
        for (const { a, b } of mesh.seams) this.canonical[root(b)] = root(a);
        for (let i = 0; i < this.vertexCount; i++) this.canonical[i] = root(i);
        const map = new Map<number, number>();
        const edge = (a: number, b: number) => {
            const key = Math.min(a, b) * this.vertexCount + Math.max(a, b);
            const known = map.get(key);
            if (known !== undefined) return known;
            const id = this.edges.length;
            map.set(key, id);
            this.edges.push([a, b]);
            return id;
        };
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
            this.faces.push({ a, b, c, edges: [edge(a, b), edge(b, c), edge(c, a)] });
            this.bounds.push({ min: [0, 0, 0], max: [0, 0, 0], face: t / 3 });
        }
    }

    reset(): void {
        this.previousZeroNormals.clear();
        this.currentZeroNormals.clear();
        this.resetWork();
    }

    private resetWork(): void {
        this.layerContact?.reset();
        this.pinBudget.reset();
        Object.assign(this.stats, EMPTY_CONTACT_STATS);
    }

    solve(start: Float32Array, positions: Float32Array, gap: number): void {
        this.resetWork();
        const last = this.currentZeroNormals;
        this.currentZeroNormals = this.previousZeroNormals;
        this.previousZeroNormals = last;
        this.currentZeroNormals.clear();
        if (!Number.isFinite(gap) || gap < 0) return;
        this.gather(start, positions, gap);
        this.layerContact?.project(positions, gap, this.stats);
    }

    private gather(start: Float32Array, positions: Float32Array, gap: number): void {
        this.broadTests = 0;
        this.vertexFaceSeen.clear();
        this.edgeEdgeSeen.clear();
        const broadGap = gap === 0 ? ZERO_GAP_TOLERANCE : this.layerContact ? gap * GARMENT_LAYER_LIMITS.recoveryGaps : gap;
        for (const box of this.bounds) {
            const { a, b, c } = this.faces[box.face];
            for (let j = 0; j < 3; j++) {
                box.min[j] = Math.min(start[3 * a + j], start[3 * b + j], start[3 * c + j], positions[3 * a + j], positions[3 * b + j], positions[3 * c + j]) - broadGap;
                box.max[j] = Math.max(start[3 * a + j], start[3 * b + j], start[3 * c + j], positions[3 * a + j], positions[3 * b + j], positions[3 * c + j]);
            }
        }
        // Estimate work with projected box width / occupied span. A narrow vertical strip
        // has quadratic overlap on X even when almost every face is separated on Y.
        // Keep the established order for ordinary garments and switch only for a
        // strongly directional layout to avoid changing their contact sweep order.
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], widths = [0, 0, 0];
        for (const box of this.bounds) {
            for (let j = 0; j < 3; j++) {
                min[j] = Math.min(min[j], box.min[j]);
                max[j] = Math.max(max[j], box.max[j]);
                widths[j] += box.max[j] - box.min[j];
            }
        }
        const cost = widths.map((w, j) => w / Math.max(1e-12, max[j] - min[j]));
        const best = cost.indexOf(Math.min(...cost));
        const axis = cost[best] * 4 < cost[0] ? best : 0;
        this.bounds.sort((a, b) => a.min[axis] - b.min[axis] || a.face - b.face);
        for (let i = 0; i < this.bounds.length; i++) {
            const a = this.bounds[i];
            for (let j = i + 1; j < this.bounds.length; j++) {
                const b = this.bounds[j];
                if (b.min[axis] > a.max[axis]) break;
                if (++this.broadTests > this.maxBroadTests) {
                    this.stats.broadPhaseLimited = this.stats.limited = true;
                    return;
                }
                if (a.min[0] > b.max[0] || b.min[0] > a.max[0] || a.min[1] > b.max[1] || b.min[1] > a.max[1] ||
                    a.min[2] > b.max[2] || b.min[2] > a.max[2]) continue;
                const rankA = this.faceRanks?.[a.face] ?? 0, rankB = this.faceRanks?.[b.face] ?? 0;
                const ranked = rankA !== rankB;
                if (!ranked && !this.includeSameLayer) continue;
                const fa = this.faces[a.face], fb = this.faces[b.face];
                const va = [fa.a, fa.b, fa.c], vb = [fb.a, fb.b, fb.c];
                // Surface neighbours and stitch-equivalent neighbours already meet at zero gap.
                if (va.some(v => vb.some(w => this.canonical[v] === this.canonical[w]))) continue;
                this.stats.facePairs++;
                if (ranked && this.layerContact) {
                    const [inner, outer] = rankA < rankB ? [fa, fb] : [fb, fa];
                    const handled = this.layerContact.gather(start, positions, inner, outer, gap, this.stats, this.maxFeatures);
                    if (this.stats.limited && this.stats.testedFeatures >= this.maxFeatures) {
                        this.stats.featureCapacityLimited = true;
                        return;
                    }
                    if (this.stats.layerCapacityLimited) return;
                    if (handled) continue;
                }
                for (const [vertices, tri, id] of [[va, fb, b.face], [vb, fa, a.face]] as const) {
                    for (const v of vertices) {
                        const key = v * this.faces.length + id;
                        if (this.vertexFaceSeen.has(key)) continue;
                        this.vertexFaceSeen.add(key);
                        if (!this.feature(start, positions, gap, [v, tri.a, tri.b, tri.c], true, key)) return;
                    }
                }
                for (const ei of fa.edges) for (const ej of fb.edges) {
                    const key = Math.min(ei, ej) * this.edges.length + Math.max(ei, ej);
                    if (this.edgeEdgeSeen.has(key)) continue;
                    this.edgeEdgeSeen.add(key);
                    // A stable side is defined for a particular edge ordering.
                    const u = this.edges[gap === 0 ? Math.min(ei, ej) : ei], v = this.edges[gap === 0 ? Math.max(ei, ej) : ej];
                    if (!this.feature(start, positions, gap, [u[0], u[1], v[0], v[1]], false, -1 - key)) return;
                }
            }
        }
    }

    private feature(start: Float32Array, end: Float32Array, gap: number, ids: Stencil, vf: boolean, key: number): boolean {
        if (this.stats.testedFeatures >= this.maxFeatures) {
            this.stats.featureCapacityLimited = this.stats.limited = true;
            return false;
        }
        this.stats.testedFeatures++;
        const shell = gap === 0 ? ZERO_GAP_TOLERANCE : gap;
        for (let j = 0; j < 3; j++) {
            const left = vf ? [ids[0]] : [ids[0], ids[1]];
            const right = vf ? [ids[1], ids[2], ids[3]] : [ids[2], ids[3]];
            let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
            for (const i of left) { const k = 3 * i + j; leftMin = Math.min(leftMin, start[k], end[k]); leftMax = Math.max(leftMax, start[k], end[k]); }
            for (const i of right) { const k = 3 * i + j; rightMin = Math.min(rightMin, start[k], end[k]); rightMax = Math.max(rightMax, start[k], end[k]); }
            if (leftMin > rightMax + shell || rightMin > leftMax + shell) return true;
        }
        const motion = ids.map(i => sub(sample(end, end, i, 0), sample(start, start, i, 0)));
        // Subtract common translation before bounding relative speed along t in [0,1].
        const relative = motion.map(v => sub(v, motion[0]));
        const tolerance = Math.max(ZERO_GAP_TOLERANCE, gap * GARMENT_LAYER_LIMITS.sweptToleranceFraction);
        let t = 0;
        for (let iteration = 0; iteration < GARMENT_LAYER_LIMITS.sweptIterations; iteration++) {
            const s = separation(ids.map(i => sample(start, end, i, t)), vf);
            if (!s) return true;
            if (s.distance <= gap + tolerance) {
                // A zero-offset feature can spend multiple ticks at exact coincidence.
                // Retain the last observed approach side; a freshly arranged, exactly
                // coincident two-sided feature has no unique side until it separates.
                if (gap === 0) {
                    const last = this.previousZeroNormals.get(key);
                    if (s.distance < 1e-12 && !last) return true;
                    if (last && t === 0 && (s.distance < 1e-12 || dot(last, s.normal) < 0)) s.normal = last;
                    this.currentZeroNormals.set(key, s.normal);
                } else if (s.distance < 1e-12) return true;
                let signedEnd = 0, denom = 0;
                for (let k = 0; k < 4; k++) {
                    const j = 3 * ids[k], w = s.weights[k];
                    signedEnd += w * (end[j] * s.normal[0] + end[j + 1] * s.normal[1] + end[j + 2] * s.normal[2]);
                    denom += this.inverseMass[ids[k]] * w * w;
                }
                if (signedEnd < gap && denom > 0) {
                    const requested = (gap - signedEnd) / denom;
                    let lambda = requested;
                    const maxGradient = Math.max(...ids.map((id, k) => this.inverseMass[id] * Math.abs(s.weights[k])));
                    const guardPins = maxGradient > GARMENT_LAYER_LIMITS.maxPinLeverage * denom &&
                        ids.some((id, k) => this.inverseMass[id] === 0 && s.weights[k] !== 0);
                    if (guardPins) {
                        const maxMove = GARMENT_LAYER_LIMITS.maxPinLeverage * Math.max(gap, gap - signedEnd);
                        for (let k = 0; k < 4; k++) {
                            lambda = this.pinBudget.limit(lambda, ids[k], this.inverseMass[ids[k]] * Math.abs(s.weights[k]), maxMove);
                        }
                        if (lambda < requested) this.stats.pinLimited++;
                        if (lambda <= 0) return true;
                    }
                    for (let k = 0; k < 4; k++) {
                        const amount = this.inverseMass[ids[k]] * s.weights[k] * lambda;
                        if (guardPins) this.pinBudget.record(ids[k], amount);
                        for (let j = 0; j < 3; j++) end[3 * ids[k] + j] += amount * s.normal[j];
                    }
                    if (vf) this.stats.vertexFace++; else this.stats.edgeEdge++;
                }
                return true;
            }
            // The closest-feature normal separates these convex primitives. Bound the
            // closing speed of that plane, including every linearly moving vertex.
            const speed = relative.map(v => dot(v, s.normal));
            const closingSpeed = vf ? Math.max(speed[1], speed[2], speed[3]) :
                Math.max(speed[2], speed[3]) - Math.min(0, speed[1]);
            if (closingSpeed <= 1e-12) return true;
            // Stop just before a zero-distance impact to sample its approach normal.
            // Projection still uses exactly zero as the physical clearance.
            const advance = (s.distance - (gap === 0 ? 0.5 * ZERO_GAP_TOLERANCE : gap)) / closingSpeed;
            if (t + advance > 1) return true;
            t += Math.max(0, advance);
        }
        this.stats.limited = true;
        this.stats.advancementLimited++;
        return true;
    }
}
