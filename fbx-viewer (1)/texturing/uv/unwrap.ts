import { flattenChart, type Flattened } from './lscm';
import { buildCharts, chartBoundaries, edgeKey, type Chart, type UvTopology } from './uvTopology';

/**
 * AUTOMATIC SEAMS AND UNWRAPPING
 *
 * Seams are placed in three steps:
 *   1. hard edges (where faces meet at more than the chosen angle) are always seams;
 *   2. charts grow outward from the flattest unclaimed face, taking neighbours across soft edges
 *      while their normals stay within a cone of the chart's average, smoothest first, so seams fall
 *      along creases and turns rather than across smooth areas;
 *   3. each chart is flattened conformally; one that folds over, stretches past the limit, or is not
 *      a disc (a closed shell, a handle) is cut in two across its longest direction and tried again.
 * The user's own seams (painted in the UV view) are kept and added to.
 */

export interface UnwrapSettings {
    /** Edges sharper than this many degrees are always cut. */
    hardAngle: number;
    /** How far a chart's faces may turn from its average, in degrees. */
    coneAngle: number;
    /** Largest stretch allowed before a chart is cut again (1 is none). */
    stretchLimit: number;
    /** Charts smaller than this share of the surface join a neighbour when they can. */
    smallChart: number;
}

export const DEFAULT_UNWRAP: UnwrapSettings = { hardAngle: 66, coneAngle: 70, stretchLimit: 2.2, smallChart: 0.002 };

export interface UnwrapResult {
    seams: Set<number>;
    charts: Chart[];
    flat: Flattened[];
}

const dihedral = (topology: UvTopology, a: number, b: number): number => {
    const n = topology.normals;
    const dot = n[a * 3] * n[b * 3] + n[a * 3 + 1] * n[b * 3 + 1] + n[a * 3 + 2] * n[b * 3 + 2];
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
};

/** Seams from hard edges and grown charts (step 1 and 2). */
export const chooseSeams = (topology: UvTopology, settings: UnwrapSettings, keep: ReadonlySet<number> = new Set()): Set<number> => {
    const { faceCount, faces, vertexCount, edgeFaces, normals, areas } = topology;
    const n = vertexCount;
    const seams = new Set<number>(keep);
    for (const [key, list] of edgeFaces) {
        if (list.length !== 2) continue;
        if (dihedral(topology, list[0], list[1]) > settings.hardAngle) seams.add(key);
    }
    const chartOf = new Int32Array(faceCount).fill(-1);
    const cosCone = Math.cos((settings.coneAngle * Math.PI) / 180);
    // Seeds in order of flatness: faces whose neighbours agree with them most.
    const flatness = new Float64Array(faceCount);
    for (let f = 0; f < faceCount; f++) {
        let agree = 0;
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(faces[f * 3 + k], faces[f * 3 + ((k + 1) % 3)], n);
            for (const g of edgeFaces.get(key) ?? []) if (g !== f) agree += normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
        }
        flatness[f] = agree;
    }
    const order = [...Array(faceCount).keys()].sort((a, b) => flatness[b] - flatness[a] || areas[b] - areas[a]);
    let chart = 0;
    for (const seed of order) {
        if (chartOf[seed] >= 0) continue;
        const sum = [normals[seed * 3] * areas[seed], normals[seed * 3 + 1] * areas[seed], normals[seed * 3 + 2] * areas[seed]];
        chartOf[seed] = chart;
        // A simple priority queue on how far a face's normal is from the chart's (smaller first).
        const heap: Array<[number, number]> = [];
        const push = (cost: number, face: number) => {
            heap.push([cost, face]);
            let i = heap.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (heap[parent][0] <= heap[i][0]) break;
                [heap[parent], heap[i]] = [heap[i], heap[parent]];
                i = parent;
            }
        };
        const pop = (): [number, number] | undefined => {
            const top = heap[0];
            const last = heap.pop();
            if (heap.length && last) {
                heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        };
        const offer = (f: number) => {
            for (let k = 0; k < 3; k++) {
                const key = edgeKey(faces[f * 3 + k], faces[f * 3 + ((k + 1) % 3)], n);
                if (seams.has(key)) continue;
                const list = edgeFaces.get(key);
                if (!list || list.length !== 2) continue;
                for (const g of list) {
                    if (g === f || chartOf[g] >= 0) continue;
                    const length = Math.hypot(sum[0], sum[1], sum[2]) || 1;
                    const dot = (normals[g * 3] * sum[0] + normals[g * 3 + 1] * sum[1] + normals[g * 3 + 2] * sum[2]) / length;
                    push(1 - dot, g);
                }
            }
        };
        offer(seed);
        let next = pop();
        while (next) {
            const [, g] = next;
            next = pop();
            if (chartOf[g] >= 0) continue;
            const length = Math.hypot(sum[0], sum[1], sum[2]) || 1;
            const dot = (normals[g * 3] * sum[0] + normals[g * 3 + 1] * sum[1] + normals[g * 3 + 2] * sum[2]) / length;
            if (dot < cosCone) continue;
            chartOf[g] = chart;
            sum[0] += normals[g * 3] * areas[g];
            sum[1] += normals[g * 3 + 1] * areas[g];
            sum[2] += normals[g * 3 + 2] * areas[g];
            offer(g);
        }
        chart++;
    }
    // Tiny charts join the neighbour they share the longest edge with.
    let total = 0;
    for (let f = 0; f < faceCount; f++) total += areas[f];
    const chartArea = new Float64Array(chart);
    for (let f = 0; f < faceCount; f++) chartArea[chartOf[f]] += areas[f];
    for (let f = 0; f < faceCount; f++) {
        const own = chartOf[f];
        if (chartArea[own] >= total * settings.smallChart) continue;
        let best = -1;
        let bestLength = 0;
        for (let k = 0; k < 3; k++) {
            const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
            const key = edgeKey(a, b, n);
            if (seams.has(key) && !keep.has(key) && dihedral(topology, ...(edgeFaces.get(key)!.slice(0, 2) as [number, number])) > settings.hardAngle) continue;
            for (const g of edgeFaces.get(key) ?? []) {
                if (chartOf[g] === own) continue;
                const p = topology.positions;
                const length = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
                if (length > bestLength) { bestLength = length; best = chartOf[g]; }
            }
        }
        if (best < 0) continue;
        chartArea[best] += chartArea[own];
        chartArea[own] = 0;
        for (let g = 0; g < faceCount; g++) if (chartOf[g] === own) chartOf[g] = best;
    }
    for (const [key, list] of edgeFaces) if (list.length === 2 && chartOf[list[0]] !== chartOf[list[1]]) seams.add(key);
    return seams;
};

/** Whether a chart is a disc with holes at most (genus 0 with a boundary): what flattening needs. */
const flattenable = (chart: Chart): boolean => {
    const edges = new Set<string>();
    for (let i = 0; i < chart.faces.length; i++) {
        for (let k = 0; k < 3; k++) {
            const a = chart.corners[i * 3 + k], b = chart.corners[i * 3 + ((k + 1) % 3)];
            edges.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
    }
    const boundaries = chartBoundaries(chart).length;
    if (boundaries === 0) return false;
    const euler = chart.vertexWeld.length - edges.size + chart.faces.length;
    // Genus 0 with b holes: V - E + F = 2 - b.
    return euler + boundaries === 2;
};

/** The direction a set of 3D points spreads most (power iteration on their covariance), and their mean. */
const mainAxis = (points: number[][]): { axis: number[]; mean: number[] } => {
    const mean = [0, 1, 2].map((axis) => points.reduce((sum, c) => sum + c[axis], 0) / points.length);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const c of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (c[i] - mean[i]) * (c[j] - mean[j]);
    let axis = [1, 0.7, 0.3];
    for (let iteration = 0; iteration < 30; iteration++) {
        const next = [0, 1, 2].map((i) => cov[i][0] * axis[0] + cov[i][1] * axis[1] + cov[i][2] * axis[2]);
        const length = Math.hypot(next[0], next[1], next[2]) || 1;
        axis = next.map((x) => x / length);
    }
    return { axis, mean };
};

/**
 * Cuts a chart in two, adding the cut to `seams`. A chart whose faces turn far (a curled strip, a ring
 * round a post) is split between the two ways its faces mostly face, which unrolls it; a flatter one is
 * cut across its longest direction.
 */
const split = (topology: UvTopology, chart: Chart, seams: Set<number>): void => {
    const p = topology.positions;
    const normals = chart.faces.map((f) => [topology.normals[f * 3], topology.normals[f * 3 + 1], topology.normals[f * 3 + 2]]);
    const average = [0, 1, 2].map((axis) => normals.reduce((sum, n) => sum + n[axis], 0) / normals.length);
    const spread = 1 - Math.hypot(average[0], average[1], average[2]);
    let side: boolean[];
    if (spread > 0.3) {
        const { axis, mean } = mainAxis(normals);
        side = normals.map((n) => (n[0] - mean[0]) * axis[0] + (n[1] - mean[1]) * axis[1] + (n[2] - mean[2]) * axis[2] >= 0);
    } else {
        const centres = chart.faces.map((f) => [0, 1, 2].map((axis) => (p[topology.faces[f * 3] * 3 + axis] + p[topology.faces[f * 3 + 1] * 3 + axis] + p[topology.faces[f * 3 + 2] * 3 + axis]) / 3));
        const { axis, mean } = mainAxis(centres);
        side = centres.map((c) => (c[0] - mean[0]) * axis[0] + (c[1] - mean[1]) * axis[1] + (c[2] - mean[2]) * axis[2] >= 0);
    }
    // Both sides must hold something, or the cut changes nothing.
    if (side.every((value) => value === side[0])) side = side.map((_, i) => i < side.length / 2);
    const sideOf = new Map(chart.faces.map((f, i) => [f, side[i]]));
    const n = topology.vertexCount;
    for (const f of chart.faces) {
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(topology.faces[f * 3 + k], topology.faces[f * 3 + ((k + 1) % 3)], n);
            for (const g of topology.edgeFaces.get(key) ?? []) {
                if (g !== f && sideOf.has(g) && sideOf.get(g) !== sideOf.get(f)) seams.add(key);
            }
        }
    }
};

/** Seams and flattened charts for the whole surface (step 3 included). */
export const unwrap = (topology: UvTopology, settings: UnwrapSettings = DEFAULT_UNWRAP, keep: ReadonlySet<number> = new Set(), seamsGiven?: ReadonlySet<number>): UnwrapResult => {
    const seams = seamsGiven ? new Set(seamsGiven) : chooseSeams(topology, settings, keep);
    // A chart left whole by a round is the same next round: flatten it once.
    const done = new Map<string, Flattened>();
    const keyOf = (chart: Chart) => `${chart.faces.length}:${chart.vertexWeld.length}:${[...chart.faces].sort((a, b) => a - b).join(',')}`;
    const flatten = (chart: Chart): Flattened => {
        const key = keyOf(chart);
        let result = done.get(key);
        if (!result) done.set(key, result = flattenChart(topology, chart));
        return result;
    };
    const ROUNDS = 12;
    for (let round = 0; round < ROUNDS; round++) {
        const charts = buildCharts(topology, seams);
        const flat: Flattened[] = [];
        let cut = false;
        for (const chart of charts) {
            if (!flattenable(chart) && chart.faces.length > 1) {
                split(topology, chart, seams);
                cut = true;
                flat.push({ uv: new Float64Array(chart.vertexWeld.length * 2), flipped: 0, worstStretch: 1, meanStretch: 1 });
                continue;
            }
            const result = flatten(chart);
            flat.push(result);
            if (round < ROUNDS - 1 && chart.faces.length > 2 && (result.flipped > 0 || result.meanStretch > settings.stretchLimit)) {
                split(topology, chart, seams);
                cut = true;
            }
        }
        if (!cut) return { seams, charts, flat };
    }
    const charts = buildCharts(topology, seams);
    return { seams, charts, flat: charts.map(flatten) };
};
