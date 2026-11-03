/**
 * UV TOPOLOGY
 *
 * A texture set's triangles welded by position into one connected surface, with every edge and the
 * faces on each side of it, so seams can be chosen and charts (the pieces cut apart along seams)
 * found. Within a chart a corner is split wherever a seam runs through it, so a chart cut open along
 * a seam (a sleeve opened along one line) still lies flat as one piece.
 */

export interface UvTopology {
    /** Welded corners: three per vertex. */
    positions: Float64Array;
    /** Triangles over welded corners. */
    faces: Uint32Array;
    /** For each source corner (index into the part's vertices), its welded corner. */
    weldOf: Uint32Array;
    faceCount: number;
    vertexCount: number;
    /** Edge key (`a*n+b` with a<b) to the faces on it. */
    edgeFaces: Map<number, number[]>;
    /** Face normals and areas. */
    normals: Float64Array;
    areas: Float64Array;
}

export const edgeKey = (a: number, b: number, n: number): number => (a < b ? a * n + b : b * n + a);
export const edgeEnds = (key: number, n: number): [number, number] => [Math.floor(key / n), key % n];

/** Welds `positions` (three per vertex) by place, quantised to a millionth of the shape's size. */
export const buildTopology = (positions: ArrayLike<number>, indices: ArrayLike<number>): UvTopology => {
    const sourceCount = positions.length / 3;
    let size = 0;
    for (let i = 0; i < positions.length; i++) size = Math.max(size, Math.abs(positions[i]));
    const step = Math.max(size, 1e-9) * 1e-6;
    const weldOf = new Uint32Array(sourceCount);
    const lookup = new Map<string, number>();
    const welded: number[] = [];
    for (let v = 0; v < sourceCount; v++) {
        const key = `${Math.round(positions[v * 3] / step)},${Math.round(positions[v * 3 + 1] / step)},${Math.round(positions[v * 3 + 2] / step)}`;
        let id = lookup.get(key);
        if (id === undefined) {
            id = welded.length / 3;
            lookup.set(key, id);
            welded.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        }
        weldOf[v] = id;
    }
    const vertexCount = welded.length / 3;
    const faceCount = indices.length / 3;
    const faces = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) faces[i] = weldOf[indices[i]];
    const edgeFaces = new Map<number, number[]>();
    const normals = new Float64Array(faceCount * 3);
    const areas = new Float64Array(faceCount);
    const p = new Float64Array(welded);
    for (let f = 0; f < faceCount; f++) {
        const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
        for (const [x, y] of [[a, b], [b, c], [c, a]]) {
            if (x === y) continue;
            const key = edgeKey(x, y, vertexCount);
            const list = edgeFaces.get(key);
            if (list) list.push(f);
            else edgeFaces.set(key, [f]);
        }
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        areas[f] = length / 2;
        if (length > 0) normals.set([nx / length, ny / length, nz / length], f * 3);
    }
    return { positions: p, faces, weldOf, faceCount, vertexCount, edgeFaces, normals, areas };
};

/** Seams the mesh already has: edges where the corners' texture coordinates differ on either side. */
export const existingSeams = (topology: UvTopology, indices: ArrayLike<number>, uvs: ArrayLike<number>): Set<number> => {
    const seams = new Set<number>();
    const n = topology.vertexCount;
    // For each edge, the texture coordinates its ends have in the first face found on it.
    const seen = new Map<number, [number, number, number, number]>();
    for (let f = 0; f < topology.faceCount; f++) {
        for (let k = 0; k < 3; k++) {
            const i0 = indices[f * 3 + k];
            const i1 = indices[f * 3 + ((k + 1) % 3)];
            const a = topology.weldOf[i0];
            const b = topology.weldOf[i1];
            if (a === b) continue;
            const key = edgeKey(a, b, n);
            const [ua, va, ub, vb] = a < b ? [uvs[i0 * 2], uvs[i0 * 2 + 1], uvs[i1 * 2], uvs[i1 * 2 + 1]] : [uvs[i1 * 2], uvs[i1 * 2 + 1], uvs[i0 * 2], uvs[i0 * 2 + 1]];
            const before = seen.get(key);
            if (!before) { seen.set(key, [ua, va, ub, vb]); continue; }
            const differs = Math.abs(before[0] - ua) + Math.abs(before[1] - va) + Math.abs(before[2] - ub) + Math.abs(before[3] - vb) > 1e-6;
            if (differs) seams.add(key);
        }
    }
    // Open edges (one face) are boundaries already; they need no seam.
    return seams;
};

export interface Chart {
    /** Faces of the chart. */
    faces: number[];
    /** Chart corners: each welded corner once per fan of chart faces round it that seams split apart. */
    vertexWeld: number[];
    /** Per chart face, its three chart corners. */
    corners: Uint32Array;
}

/**
 * Charts: pieces of faces joined across edges that are neither seams nor open, with their corners
 * split where seams cut into them.
 */
export const buildCharts = (topology: UvTopology, seams: ReadonlySet<number>): Chart[] => {
    const { faces, faceCount, vertexCount, edgeFaces } = topology;
    const n = vertexCount;
    const chartOf = new Int32Array(faceCount).fill(-1);
    const charts: Chart[] = [];
    const joined = (key: number) => !seams.has(key) && (edgeFaces.get(key)?.length ?? 0) === 2;
    for (let start = 0; start < faceCount; start++) {
        if (chartOf[start] >= 0) continue;
        const id = charts.length;
        const list: number[] = [];
        const stack = [start];
        chartOf[start] = id;
        while (stack.length) {
            const f = stack.pop()!;
            list.push(f);
            for (let k = 0; k < 3; k++) {
                const a = faces[f * 3 + k];
                const b = faces[f * 3 + ((k + 1) % 3)];
                const key = edgeKey(a, b, n);
                if (!joined(key)) continue;
                for (const g of edgeFaces.get(key)!) {
                    if (g === f || chartOf[g] >= 0) continue;
                    chartOf[g] = id;
                    stack.push(g);
                }
            }
        }
        charts.push({ faces: list, vertexWeld: [], corners: new Uint32Array(list.length * 3) });
    }
    // Corners: faces of a chart round one welded corner, grouped into fans joined by non-seam edges.
    for (const chart of charts) {
        const local = new Map<number, number>();
        for (let i = 0; i < chart.faces.length; i++) local.set(chart.faces[i], i);
        const around = new Map<number, number[]>();
        chart.faces.forEach((f, i) => {
            for (let k = 0; k < 3; k++) {
                const v = faces[f * 3 + k];
                const entry = around.get(v);
                if (entry) entry.push(i * 3 + k);
                else around.set(v, [i * 3 + k]);
            }
        });
        for (const [v, slots] of around) {
            // Union the slots of faces sharing a non-seam edge through v.
            const parent = new Map<number, number>(slots.map((slot) => [slot, slot]));
            const find = (x: number): number => { while (parent.get(x)! !== x) x = parent.get(x)!; return x; };
            const byFace = new Map(slots.map((slot) => [Math.floor(slot / 3), slot]));
            for (const slot of slots) {
                const fi = Math.floor(slot / 3);
                const f = chart.faces[fi];
                for (let k = 0; k < 3; k++) {
                    const a = faces[f * 3 + k];
                    const b = faces[f * 3 + ((k + 1) % 3)];
                    if (a !== v && b !== v) continue;
                    const key = edgeKey(a, b, n);
                    if (!joined(key)) continue;
                    for (const g of edgeFaces.get(key)!) {
                        const gi = local.get(g);
                        if (gi === undefined || gi === fi) continue;
                        const other = byFace.get(gi);
                        if (other === undefined) continue;
                        const ra = find(slot);
                        const rb = find(other);
                        if (ra !== rb) parent.set(ra, rb);
                    }
                }
            }
            const ids = new Map<number, number>();
            for (const slot of slots) {
                const root = find(slot);
                let id = ids.get(root);
                if (id === undefined) {
                    id = chart.vertexWeld.length;
                    chart.vertexWeld.push(v);
                    ids.set(root, id);
                }
                chart.corners[slot] = id;
            }
        }
    }
    return charts;
};

/** Boundary loops of a chart, as runs of chart corners. */
export const chartBoundaries = (chart: Chart): number[][] => {
    const count = new Map<string, number>();
    const next = new Map<number, number[]>();
    for (let i = 0; i < chart.faces.length; i++) {
        for (let k = 0; k < 3; k++) {
            const a = chart.corners[i * 3 + k];
            const b = chart.corners[i * 3 + ((k + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            count.set(key, (count.get(key) ?? 0) + 1);
        }
    }
    for (let i = 0; i < chart.faces.length; i++) {
        for (let k = 0; k < 3; k++) {
            const a = chart.corners[i * 3 + k];
            const b = chart.corners[i * 3 + ((k + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            if (count.get(key) !== 1) continue;
            const list = next.get(a);
            if (list) list.push(b);
            else next.set(a, [b]);
        }
    }
    const loops: number[][] = [];
    const used = new Set<string>();
    for (const [start, ends] of next) {
        for (const first of ends) {
            if (used.has(`${start},${first}`)) continue;
            const loop = [start];
            used.add(`${start},${first}`);
            let at = first;
            let guard = 0;
            while (at !== start && guard++ < 1e6) {
                loop.push(at);
                const options = next.get(at) ?? [];
                const step = options.find((candidate) => !used.has(`${at},${candidate}`));
                if (step === undefined) break;
                used.add(`${at},${step}`);
                at = step;
            }
            loops.push(loop);
        }
    }
    return loops;
};
