/**
 * RELAXING, STRAIGHTENING AND EVENING OUT UV ISLANDS
 *
 * Working on one island's texture coordinates, given per corner (two per corner, face by face) with the
 * island's corners naming its vertices and each vertex's place on the model:
 *   - relax: each free vertex moves towards the middle of its neighbours, nearer ones (on the model)
 *     pulling harder, until the island settles with less stretch; its edge and any pinned vertices stay;
 *   - straighten: the island turned so most of its edges (by their length on the model) run along U or V;
 *   - texel density: how many texture units the island has per model unit, and the scales that bring
 *     islands to one density.
 */

export interface IslandShape {
    /** Two per corner (face by face, three corners a face). */
    uv: Float64Array;
    /** The island vertex at each corner. */
    corners: ArrayLike<number>;
    /** Three per island vertex: where it is on the model. */
    positions: ArrayLike<number>;
}

const vertexCount = (corners: ArrayLike<number>): number => {
    let most = -1;
    for (let i = 0; i < corners.length; i++) most = Math.max(most, corners[i]);
    return most + 1;
};

/** Each vertex's neighbours, and which vertices lie on the island's edge (an edge only one face has). */
export const islandLinks = (corners: ArrayLike<number>): { neighbours: Array<Set<number>>; edge: Set<number> } => {
    const count = vertexCount(corners);
    const neighbours = Array.from({ length: count }, () => new Set<number>());
    const uses = new Map<string, number>();
    for (let f = 0; f + 2 < corners.length; f += 3) {
        for (let k = 0; k < 3; k++) {
            const a = corners[f + k], b = corners[f + ((k + 1) % 3)];
            neighbours[a].add(b);
            neighbours[b].add(a);
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            uses.set(key, (uses.get(key) ?? 0) + 1);
        }
    }
    const edge = new Set<number>();
    for (const [key, count] of uses) {
        if (count !== 1) continue;
        const [a, b] = key.split(',').map(Number);
        edge.add(a);
        edge.add(b);
    }
    return { neighbours, edge };
};

/** Each vertex's place on the island (from its first corner). */
const vertexUvs = (shape: IslandShape): Float64Array => {
    const out = new Float64Array(vertexCount(shape.corners) * 2);
    const seen = new Uint8Array(out.length / 2);
    for (let i = 0; i < shape.corners.length; i++) {
        const v = shape.corners[i];
        if (seen[v]) continue;
        seen[v] = 1;
        out[v * 2] = shape.uv[i * 2];
        out[v * 2 + 1] = shape.uv[i * 2 + 1];
    }
    return out;
};

const writeBack = (shape: IslandShape, vertices: Float64Array): Float64Array => {
    const uv = new Float64Array(shape.uv.length);
    for (let i = 0; i < shape.corners.length; i++) {
        uv[i * 2] = vertices[shape.corners[i] * 2];
        uv[i * 2 + 1] = vertices[shape.corners[i] * 2 + 1];
    }
    return uv;
};

/**
 * The island relaxed: free vertices (not on its edge unless `freeEdge`, not pinned) moved towards the
 * middle of their neighbours, weighted by how near each is on the model, `iterations` times.
 */
export const relaxIsland = (shape: IslandShape, options: { iterations?: number; pinned?: ReadonlySet<number>; freeEdge?: boolean } = {}): Float64Array => {
    const { neighbours, edge } = islandLinks(shape.corners);
    const uv = vertexUvs(shape);
    const p = shape.positions;
    const fixed = (v: number) => options.pinned?.has(v) || (!options.freeEdge && edge.has(v));
    const weights = neighbours.map((around, v) => [...around].map((j) => {
        const d = Math.hypot(p[v * 3] - p[j * 3], p[v * 3 + 1] - p[j * 3 + 1], p[v * 3 + 2] - p[j * 3 + 2]);
        return { j, w: 1 / Math.max(d, 1e-9) };
    }));
    for (let step = 0; step < (options.iterations ?? 40); step++) {
        const next = Float64Array.from(uv);
        weights.forEach((around, v) => {
            if (fixed(v) || !around.length) return;
            let x = 0, y = 0, total = 0;
            for (const { j, w } of around) { x += uv[j * 2] * w; y += uv[j * 2 + 1] * w; total += w; }
            next[v * 2] = uv[v * 2] * 0.5 + (x / total) * 0.5;
            next[v * 2 + 1] = uv[v * 2 + 1] * 0.5 + (y / total) * 0.5;
        });
        uv.set(next);
    }
    return writeBack(shape, uv);
};

/**
 * The turn (radians) that lines most of an island's edges up with U or V: the average of its edges'
 * directions folded into a quarter turn, each weighted by its length on the model.
 */
export const straighteningTurn = (shape: IslandShape): number => {
    const { neighbours } = islandLinks(shape.corners);
    const uv = vertexUvs(shape);
    const p = shape.positions;
    let c = 0, s = 0;
    neighbours.forEach((around, a) => {
        for (const b of around) {
            if (b < a) continue;
            const length = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
            const angle = Math.atan2(uv[b * 2 + 1] - uv[a * 2 + 1], uv[b * 2] - uv[a * 2]);
            c += Math.cos(angle * 4) * length;
            s += Math.sin(angle * 4) * length;
        }
    });
    return c === 0 && s === 0 ? 0 : -Math.atan2(s, c) / 4;
};

/** The island turned by `angle` round its middle. */
export const turnIsland = (uv: Float64Array, angle: number): Float64Array => {
    let cx = 0, cy = 0;
    for (let i = 0; i < uv.length; i += 2) { cx += uv[i]; cy += uv[i + 1]; }
    cx /= uv.length / 2; cy /= uv.length / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const out = new Float64Array(uv.length);
    for (let i = 0; i < uv.length; i += 2) {
        const x = uv[i] - cx, y = uv[i + 1] - cy;
        out[i] = cx + x * cos - y * sin;
        out[i + 1] = cy + x * sin + y * cos;
    }
    return out;
};

/** An island's areas: on the picture (UV units squared) and on the model. */
export const islandAreas = (shape: IslandShape): { uv: number; model: number } => {
    let uvArea = 0, modelArea = 0;
    const p = shape.positions;
    for (let f = 0; f + 2 < shape.corners.length; f += 3) {
        const [i, j, k] = [f, f + 1, f + 2];
        uvArea += Math.abs((shape.uv[j * 2] - shape.uv[i * 2]) * (shape.uv[k * 2 + 1] - shape.uv[i * 2 + 1]) - (shape.uv[k * 2] - shape.uv[i * 2]) * (shape.uv[j * 2 + 1] - shape.uv[i * 2 + 1])) / 2;
        const [a, b, c] = [shape.corners[i], shape.corners[j], shape.corners[k]];
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
        modelArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return { uv: uvArea, model: modelArea };
};

/** Texels per model unit for an island on a picture `size` texels across. */
export const texelDensity = (areas: { uv: number; model: number }, size: number): number => (areas.model > 0 ? Math.sqrt(areas.uv / areas.model) * size : 0);

/**
 * The scale for each island that brings it to `target` texels per unit (by default, the density of all of
 * them together, so the layout keeps its overall size).
 */
export const densityScales = (islands: ReadonlyArray<{ uv: number; model: number }>, size: number, target?: number): number[] => {
    const total = islands.reduce((sum, island) => ({ uv: sum.uv + island.uv, model: sum.model + island.model }), { uv: 0, model: 0 });
    const goal = target ?? texelDensity(total, size);
    return islands.map((island) => {
        const density = texelDensity(island, size);
        return density > 0 && goal > 0 ? goal / density : 1;
    });
};

/**
 * Texels per model unit of a whole mesh laid out on a picture `size` texels across: positions three per
 * vertex, texture coordinates two per vertex, triangles by index.
 */
export const meshTexelDensity = (positions: ArrayLike<number>, uvs: ArrayLike<number>, indices: ArrayLike<number>, size: number): number => {
    let uvArea = 0, modelArea = 0;
    for (let f = 0; f + 2 < indices.length; f += 3) {
        const [a, b, c] = [indices[f], indices[f + 1], indices[f + 2]];
        uvArea += Math.abs((uvs[b * 2] - uvs[a * 2]) * (uvs[c * 2 + 1] - uvs[a * 2 + 1]) - (uvs[c * 2] - uvs[a * 2]) * (uvs[b * 2 + 1] - uvs[a * 2 + 1])) / 2;
        const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
        const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
        modelArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return texelDensity({ uv: uvArea, model: modelArea }, size);
};

/** The island vertex nearest a place on the picture within `reach`, as [corner, vertex], or null. */
export const nearestVertex = (shape: Pick<IslandShape, 'uv' | 'corners'>, u: number, v: number, reach: number): number | null => {
    let best: number | null = null;
    let distance = reach;
    for (let i = 0; i < shape.corners.length; i++) {
        const d = Math.hypot(shape.uv[i * 2] - u, shape.uv[i * 2 + 1] - v);
        if (d <= distance) { distance = d; best = shape.corners[i]; }
    }
    return best;
};
