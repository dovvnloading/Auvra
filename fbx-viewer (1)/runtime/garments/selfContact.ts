import type { CookedGarment } from './pattern';

import { dot, sub, segmentWeights, triangleWeights, type Point } from './contactGeometry';
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

export interface SelfContactStats {
    facePairs: number;
    testedFeatures: number;
    vertexFace: number;
    edgeEdge: number;
    limited: boolean;
}

/** Bounded preview of contacts within one cooked instance. Each query follows linear
 * trajectories from the accepted start to the current endpoint. One contact sweep
 * can create another contact elsewhere. The external diagnostic reports truncated work. */
export class GarmentSelfContact {
    readonly stats: SelfContactStats = { facePairs: 0, testedFeatures: 0, vertexFace: 0, edgeEdge: 0, limited: false };
    private readonly faces: Face[] = [];
    private readonly edges: Edge[] = [];
    private readonly canonical: Int32Array;
    private readonly bounds: Bounds[] = [];
    private readonly vertexCount: number;
    private readonly vertexFaceSeen = new Set<number>();
    private readonly edgeEdgeSeen = new Set<number>();
    private readonly inverseMass: Float64Array;
    private readonly maxFeatures: number;
    private readonly maxBroadTests: number;
    private broadTests = 0;

    constructor(mesh: CookedGarment, inverseMass: Float64Array, maxFeatures = 40000, maxBroadTests = 120000) {
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
        Object.assign(this.stats, { facePairs: 0, testedFeatures: 0, vertexFace: 0, edgeEdge: 0, limited: false });
    }

    solve(start: Float32Array, positions: Float32Array, gap: number): void {
        this.reset();
        this.broadTests = 0;
        this.vertexFaceSeen.clear();
        this.edgeEdgeSeen.clear();
        if (!(gap > 0)) return;
        for (const box of this.bounds) {
            const { a, b, c } = this.faces[box.face];
            for (let j = 0; j < 3; j++) {
                box.min[j] = Math.min(start[3 * a + j], start[3 * b + j], start[3 * c + j], positions[3 * a + j], positions[3 * b + j], positions[3 * c + j]) - gap;
                box.max[j] = Math.max(start[3 * a + j], start[3 * b + j], start[3 * c + j], positions[3 * a + j], positions[3 * b + j], positions[3 * c + j]);
            }
        }
        this.bounds.sort((a, b) => a.min[0] - b.min[0] || a.face - b.face);
        for (let i = 0; i < this.bounds.length; i++) {
            const a = this.bounds[i];
            for (let j = i + 1; j < this.bounds.length; j++) {
                const b = this.bounds[j];
                if (b.min[0] > a.max[0]) break;
                if (++this.broadTests > this.maxBroadTests) { this.stats.limited = true; return; }
                if (b.min[1] > a.max[1] || a.min[1] > b.max[1] || b.min[2] > a.max[2] || a.min[2] > b.max[2]) continue;
                const fa = this.faces[a.face], fb = this.faces[b.face];
                const va = [fa.a, fa.b, fa.c], vb = [fb.a, fb.b, fb.c];
                // Surface neighbours and stitch-equivalent neighbours already meet at zero gap.
                if (va.some(v => vb.some(w => this.canonical[v] === this.canonical[w]))) continue;
                this.stats.facePairs++;
                for (const [vertices, tri, id] of [[va, fb, b.face], [vb, fa, a.face]] as const) {
                    for (const v of vertices) {
                        const key = v * this.faces.length + id;
                        if (this.vertexFaceSeen.has(key)) continue;
                        this.vertexFaceSeen.add(key);
                        if (!this.feature(start, positions, gap, [v, tri.a, tri.b, tri.c], true)) return;
                    }
                }
                for (const ei of fa.edges) for (const ej of fb.edges) {
                    const key = Math.min(ei, ej) * this.edges.length + Math.max(ei, ej);
                    if (this.edgeEdgeSeen.has(key)) continue;
                    this.edgeEdgeSeen.add(key);
                    const u = this.edges[ei], v = this.edges[ej];
                    if (!this.feature(start, positions, gap, [u[0], u[1], v[0], v[1]], false)) return;
                }
            }
        }
    }

    private feature(start: Float32Array, end: Float32Array, gap: number, ids: Stencil, vf: boolean): boolean {
        if (this.stats.testedFeatures >= this.maxFeatures) { this.stats.limited = true; return false; }
        this.stats.testedFeatures++;
        for (let j = 0; j < 3; j++) {
            const left = vf ? [ids[0]] : [ids[0], ids[1]];
            const right = vf ? [ids[1], ids[2], ids[3]] : [ids[2], ids[3]];
            let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
            for (const i of left) { const k = 3 * i + j; leftMin = Math.min(leftMin, start[k], end[k]); leftMax = Math.max(leftMax, start[k], end[k]); }
            for (const i of right) { const k = 3 * i + j; rightMin = Math.min(rightMin, start[k], end[k]); rightMax = Math.max(rightMax, start[k], end[k]); }
            if (leftMin > rightMax + gap || rightMin > leftMax + gap) return true;
        }
        const motion = ids.map(i => sub(sample(end, end, i, 0), sample(start, start, i, 0)));
        // Subtract common translation before bounding relative speed along t in [0,1].
        const speeds = motion.map(v => length(sub(v, motion[0])));
        const maxSpeed = vf ? Math.max(speeds[1], speeds[2], speeds[3]) : speeds[1] + Math.max(speeds[2], speeds[3]);
        const tolerance = Math.max(1e-7, gap * 1e-3);
        let t = 0;
        for (let iteration = 0; iteration < 12; iteration++) {
            const s = separation(ids.map(i => sample(start, end, i, t)), vf);
            if (!s) return true;
            if (s.distance <= gap + tolerance) {
                // Initial coincident surfaces have no reliable side. They require arrangement/repair.
                if (s.distance <= 1e-12) return true;
                let signedEnd = 0, denom = 0;
                for (let k = 0; k < 4; k++) {
                    const j = 3 * ids[k], w = s.weights[k];
                    signedEnd += w * (end[j] * s.normal[0] + end[j + 1] * s.normal[1] + end[j + 2] * s.normal[2]);
                    denom += this.inverseMass[ids[k]] * w * w;
                }
                if (signedEnd < gap && denom > 0) {
                    const lambda = (gap - signedEnd) / denom;
                    for (let k = 0; k < 4; k++) {
                        const amount = this.inverseMass[ids[k]] * s.weights[k] * lambda;
                        for (let j = 0; j < 3; j++) end[3 * ids[k] + j] += amount * s.normal[j];
                    }
                    if (vf) this.stats.vertexFace++; else this.stats.edgeEdge++;
                }
                return true;
            }
            if (maxSpeed <= 1e-12) return true;
            const advance = (s.distance - gap) / maxSpeed;
            if (t + advance > 1) return true;
            t += Math.max(0, advance);
        }
        this.stats.limited = true;
        return true;
    }
}
