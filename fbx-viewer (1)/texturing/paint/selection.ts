import { buildTopology, edgeKey, type UvTopology } from '../uv/uvTopology';

/**
 * PICKING PARTS OF THE SURFACE
 *
 * Sets of triangles picked on the model, for polygon fills and polygon masks: a triangle, the quad it
 * makes with its neighbour, its whole mesh part, its UV piece, or a loop of quads running round the
 * model. Sets are kept as sorted runs of triangle numbers, which stay small for the usual picks (a part
 * or a piece is mostly one stretch of triangles).
 */

export type PickMode = 'triangle' | 'quad' | 'mesh' | 'island' | 'loop';

export const PICK_LABELS: Record<PickMode, string> = { triangle: 'Triangle', quad: 'Quad', mesh: 'Mesh part', island: 'UV piece', loop: 'Edge loop' };
export const PICK_MODES = Object.keys(PICK_LABELS) as PickMode[];

/** Triangle numbers as sorted runs: start, count, start, count... */
export const encodeTriangles = (triangles: Iterable<number>): number[] => {
    const sorted = [...new Set(triangles)].filter((t) => Number.isInteger(t) && t >= 0).sort((a, b) => a - b);
    const runs: number[] = [];
    for (const t of sorted) {
        const last = runs.length - 2;
        if (last >= 0 && runs[last] + runs[last + 1] === t) runs[last + 1]++;
        else runs.push(t, 1);
    }
    return runs;
};

/** The triangle numbers of sorted runs (runs that do not read are left out). */
export const decodeTriangles = (runs: readonly number[] | undefined): number[] => {
    const triangles: number[] = [];
    if (!runs) return triangles;
    for (let i = 0; i + 1 < runs.length; i += 2) {
        const start = runs[i], count = runs[i + 1];
        if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count <= 0) continue;
        for (let k = 0; k < count; k++) triangles.push(start + k);
    }
    return triangles;
};

/** How many triangles sorted runs hold. */
export const countTriangles = (runs: readonly number[] | undefined): number => {
    let count = 0;
    for (let i = 1; runs && i < runs.length; i += 2) count += Math.max(0, runs[i]);
    return count;
};

/** Runs with `triangles` added to them, or taken out. */
export const changeTriangles = (runs: readonly number[] | undefined, triangles: readonly number[], remove = false): number[] => {
    const set = new Set(decodeTriangles(runs));
    for (const t of triangles) {
        if (remove) set.delete(t);
        else set.add(t);
    }
    return encodeTriangles(set);
};

/** Triangles per row of a selection picture (one byte each, 1 for picked). */
export const SELECTION_WIDTH = 2048;

/** A selection as a picture's bytes: triangle t at (t mod width, t div width). */
export const selectionBytes = (runs: readonly number[], triangleCount: number): { data: Uint8Array; width: number; height: number } => {
    const width = SELECTION_WIDTH;
    const height = Math.max(1, Math.ceil(triangleCount / width));
    const data = new Uint8Array(width * height);
    for (let i = 0; i + 1 < runs.length; i += 2) {
        const end = Math.min(triangleCount, runs[i] + runs[i + 1]);
        for (let t = Math.max(0, runs[i]); t < end; t++) data[t] = 255;
    }
    return { data, width, height };
};

/** Whether an ID map colour is one of `colours`: within `tolerance` of it in every channel (0..1). */
export const matchesId = (colour: readonly number[], colours: ReadonlyArray<readonly number[]>, tolerance: number): boolean =>
    colours.some((wanted) => Math.max(Math.abs(colour[0] - wanted[0]), Math.abs(colour[1] - wanted[1]), Math.abs(colour[2] - wanted[2])) <= tolerance);

export interface SelectableSurface {
    positions: Float32Array;
    indices: Uint32Array;
    triangleMesh: Uint16Array;
    triangleIsland: Uint32Array;
}

/** Finds the triangles a pick takes in, from the surface's shape (worked out the first time it is needed). */
export class SurfaceSelector {
    private topology: UvTopology | null = null;
    private partners: Int32Array | null = null;

    constructor(private readonly surface: SelectableSurface) {}

    private shape(): UvTopology {
        if (!this.topology) this.topology = buildTopology(this.surface.positions, this.surface.indices);
        return this.topology;
    }

    /** For each triangle, the one it makes a quad with (across the longest edge of both, lying flat with it), or -1. */
    private quadPartners(): Int32Array {
        if (this.partners) return this.partners;
        const shape = this.shape();
        const { faces, positions: p, normals, faceCount, vertexCount } = shape;
        const longest = new Float64Array(faceCount);
        const longestEdge = new Float64Array(faceCount).fill(-1);
        for (let f = 0; f < faceCount; f++) {
            for (let k = 0; k < 3; k++) {
                const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
                const length = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
                if (length > longest[f]) { longest[f] = length; longestEdge[f] = edgeKey(a, b, vertexCount); }
            }
        }
        const partners = new Int32Array(faceCount).fill(-1);
        for (let f = 0; f < faceCount; f++) {
            if (partners[f] >= 0 || longestEdge[f] < 0) continue;
            const across = shape.edgeFaces.get(longestEdge[f]);
            if (!across || across.length !== 2) continue;
            const g = across[0] === f ? across[1] : across[0];
            if (partners[g] >= 0 || longestEdge[g] !== longestEdge[f]) continue;
            const facing = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
            if (facing < 0.9) continue;
            partners[f] = g;
            partners[g] = f;
        }
        this.partners = partners;
        return partners;
    }

    /** The quad a triangle belongs to (itself alone when it has no partner). */
    quadOf(triangle: number): number[] {
        const partner = this.quadPartners()[triangle];
        return partner >= 0 ? [triangle, partner] : [triangle];
    }

    /**
     * The corners of a quad (welded), in order round it, from its two triangles: the diagonal's ends p and
     * q, and each triangle's third corner, r and s, give p, r, q, s.
     */
    private quadCorners(t: number, u: number): [number, number, number, number] | null {
        const faces = this.shape().faces;
        const a = [faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]];
        const b = [faces[u * 3], faces[u * 3 + 1], faces[u * 3 + 2]];
        const shared = a.filter((corner) => b.includes(corner));
        if (shared.length !== 2) return null;
        const r = a.find((corner) => !shared.includes(corner))!;
        const s = b.find((corner) => !shared.includes(corner))!;
        return [shared[0], r, shared[1], s];
    }

    /**
     * A loop of quads running across the quad under `point` through its edge nearest `point` and the edge
     * opposite it, both ways, until it meets a triangle that is not part of a quad or comes round to the
     * start.
     */
    loopOf(triangle: number, point: readonly [number, number, number]): number[] {
        const shape = this.shape();
        const partners = this.quadPartners();
        const start = partners[triangle];
        if (start < 0) return [triangle];
        const corners = this.quadCorners(triangle, start);
        if (!corners) return [triangle];
        const p = shape.positions;
        const distance = (a: number, b: number) => {
            const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
            const dx = p[b * 3] - ax, dy = p[b * 3 + 1] - ay, dz = p[b * 3 + 2] - az;
            const length = dx * dx + dy * dy + dz * dz;
            const along = length > 0 ? Math.min(1, Math.max(0, ((point[0] - ax) * dx + (point[1] - ay) * dy + (point[2] - az) * dz) / length)) : 0;
            return Math.hypot(point[0] - (ax + dx * along), point[1] - (ay + dy * along), point[2] - (az + dz * along));
        };
        let nearest = 0;
        for (let k = 1; k < 4; k++) if (distance(corners[k], corners[(k + 1) % 4]) < distance(corners[nearest], corners[(nearest + 1) % 4])) nearest = k;
        const picked = new Set<number>([triangle, start]);
        const walk = (edge: [number, number]) => {
            let from = [triangle, start];
            let across = edge;
            for (let steps = 0; steps < 100000; steps++) {
                const faces = shape.edgeFaces.get(edgeKey(across[0], across[1], shape.vertexCount));
                if (!faces || faces.length !== 2) return;
                const next = faces[0] === from[0] || faces[0] === from[1] ? faces[1] : faces[0];
                const partner = partners[next];
                if (partner < 0 || picked.has(next)) return;
                const quad = this.quadCorners(next, partner);
                if (!quad) return;
                picked.add(next);
                picked.add(partner);
                // Leave by the edge opposite the one come in by.
                const at = [0, 1, 2, 3].find((k) => (quad[k] === across[0] && quad[(k + 1) % 4] === across[1]) || (quad[k] === across[1] && quad[(k + 1) % 4] === across[0]));
                if (at === undefined) return;
                across = [quad[(at + 2) % 4], quad[(at + 3) % 4]];
                from = [next, partner];
            }
        };
        walk([corners[nearest], corners[(nearest + 1) % 4]]);
        walk([corners[(nearest + 2) % 4], corners[(nearest + 3) % 4]]);
        return [...picked];
    }

    /** The triangles a pick of `mode` on `triangle` (at `point` on it) takes in. */
    pick(mode: PickMode, triangle: number, point: readonly [number, number, number]): number[] {
        const { triangleMesh, triangleIsland } = this.surface;
        if (triangle < 0 || triangle >= triangleMesh.length) return [];
        if (mode === 'triangle') return [triangle];
        if (mode === 'quad') return this.quadOf(triangle);
        if (mode === 'loop') return this.loopOf(triangle, point);
        const triangles: number[] = [];
        if (mode === 'mesh') {
            const mesh = triangleMesh[triangle];
            for (let t = 0; t < triangleMesh.length; t++) if (triangleMesh[t] === mesh) triangles.push(t);
        } else {
            const island = triangleIsland[triangle];
            for (let t = 0; t < triangleIsland.length; t++) if (triangleIsland[t] === island) triangles.push(t);
        }
        return triangles;
    }
}
