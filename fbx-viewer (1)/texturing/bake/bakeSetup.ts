/**
 * SETTING A BAKE UP
 *
 * The reckoning a bake needs before it runs, kept apart from the GPU work so it can be checked:
 *   - cages: which way and from how far each low-poly point looks for the high-poly surface (along its own
 *     normal, along normals averaged across hard edges so rays leave no gaps, or towards a cage mesh: the
 *     low-poly model pushed out by hand), and how far an automatic cage reaches;
 *   - supersampling: baking at a larger size and averaging each block of texels back down, weighting by
 *     how much of each the surface covers so island edges do not darken;
 *   - what is carried over from the high-poly model: each of its triangles' material colour, opacity and
 *     material number, looked up by the triangle a ray meets;
 *   - which high-poly meshes each low-poly mesh is baked from: matched by name (\`_low\` / \`_high\`), else
 *     the ones near it.
 */

export type CageMode = 'distance' | 'auto' | 'mesh';

/**
 * Normals averaged over every corner at the same place (welded by place, each face weighted by its area),
 * three per vertex: rays along them leave no gaps or overlaps at hard edges.
 */
export const averagedNormals = (positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array => {
    const count = positions.length / 3;
    let size = 0;
    for (let i = 0; i < positions.length; i++) size = Math.max(size, Math.abs(positions[i]));
    const step = Math.max(size, 1e-9) * 1e-6;
    const weld = new Map<string, number>();
    const weldOf = new Uint32Array(count);
    for (let v = 0; v < count; v++) {
        const key = `${Math.round(positions[v * 3] / step)},${Math.round(positions[v * 3 + 1] / step)},${Math.round(positions[v * 3 + 2] / step)}`;
        let id = weld.get(key);
        if (id === undefined) weld.set(key, id = weld.size);
        weldOf[v] = id;
    }
    const sums = new Float64Array(weld.size * 3);
    for (let f = 0; f + 2 < indices.length; f += 3) {
        const a = indices[f], b = indices[f + 1], c = indices[f + 2];
        const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
        const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
        // The cross product's length is twice the area: an area-weighted normal as it is.
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
            const w = weldOf[v] * 3;
            sums[w] += nx;
            sums[w + 1] += ny;
            sums[w + 2] += nz;
        }
    }
    const out = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
        const w = weldOf[v] * 3;
        const length = Math.hypot(sums[w], sums[w + 1], sums[w + 2]) || 1;
        out[v * 3] = sums[w] / length;
        out[v * 3 + 1] = sums[w + 1] / length;
        out[v * 3 + 2] = sums[w + 2] / length;
    }
    return out;
};

/**
 * Each low-poly vertex's ray towards its cage-mesh vertex (the same vertex pushed out), four per vertex:
 * the unit direction outwards and the distance; null when the cage has another number of vertices.
 */
export const meshCage = (low: ArrayLike<number>, cage: ArrayLike<number>): Float32Array | null => {
    if (low.length !== cage.length) return null;
    const count = low.length / 3;
    const out = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
        const dx = cage[v * 3] - low[v * 3], dy = cage[v * 3 + 1] - low[v * 3 + 1], dz = cage[v * 3 + 2] - low[v * 3 + 2];
        const length = Math.hypot(dx, dy, dz);
        out.set(length > 0 ? [dx / length, dy / length, dz / length, length] : [0, 0, 0, 0], v * 4);
    }
    return out;
};

/**
 * How far an automatic cage reaches, in front of and behind the low-poly surface: the gaps measured
 * between it and the high-poly surface (positive in front, negative behind), each side's `share`
 * (0.95: all but the furthest twentieth, which are usually rays that met another part) with a margin.
 * Sides with no gaps measured reach `fallback`.
 */
export const autoCage = (gaps: readonly number[], fallback: number, share = 0.95, margin = 1.25): { front: number; rear: number } => {
    const reach = (values: number[]) => {
        if (!values.length) return fallback;
        values.sort((a, b) => a - b);
        return Math.max(values[Math.min(values.length - 1, Math.floor(share * (values.length - 1)))] * margin, fallback * 0.05);
    };
    return { front: reach(gaps.filter((gap) => gap > 0)), rear: reach(gaps.filter((gap) => gap < 0).map((gap) => -gap)) };
};

/** Supersampling choices: texels baked per texel kept, along each side. */
export const SUPERSAMPLE = [1, 2, 4, 8] as const;
export type Supersample = typeof SUPERSAMPLE[number];

/**
 * The size (a power of two) a bake of `size` runs at with `factor` × `factor` supersampling, within what the
 * GPU takes (`maxSize`, a power of two), and the factor that leaves.
 */
export const supersampled = (size: number, factor: Supersample, maxSize: number): { size: number; factor: number } => {
    const most = Math.floor(Math.log2(Math.max(1, maxSize)));
    const runs = Math.min(most, size + Math.round(Math.log2(factor)));
    return { size: Math.max(size, runs), factor: 2 ** Math.max(0, runs - size) };
};

/**
 * A block of baked texels averaged into one, each weighted by how much the surface covers it (so texels
 * off the surface add nothing): the values, and the coverage of the texel kept (the blocks' average).
 */
export const blockAverage = (values: ReadonlyArray<readonly number[]>, coverage: readonly number[]): { value: number[]; coverage: number } => {
    const channels = values[0]?.length ?? 0;
    const sum = new Array<number>(channels).fill(0);
    let weight = 0;
    values.forEach((value, i) => {
        const w = coverage[i] ?? 0;
        for (let c = 0; c < channels; c++) sum[c] += value[c] * w;
        weight += w;
    });
    return { value: weight > 0 ? sum.map((v) => v / weight) : [...(values[0] ?? [])], coverage: values.length ? weight / values.length : 0 };
};

/** A material carried over from the high-poly model: its colour (sRGB) and opacity. */
export interface TransferMaterial { color: [number, number, number]; opacity: number }

/** A material's number as a colour (steps round the hue wheel by the golden ratio, as the ID bake does). */
export const materialColour = (index: number): [number, number, number] => {
    const h = (index * 0.618034 + 0.13) % 1;
    const s = 0.65, l = 0.55;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = (t: number) => {
        const u = ((t % 1) + 1) % 1;
        return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
};

/** Triangles per row of the transfer tables. */
export const TABLE_WIDTH = 2048;

/**
 * What each high-poly triangle carries over, as rows of a table read by triangle number t at
 * (t mod TABLE_WIDTH, t div TABLE_WIDTH): its material's colour and opacity, and its material's number as a colour.
 */
export const transferTables = (triangleMaterial: ArrayLike<number>, materials: readonly TransferMaterial[]): { surface: Float32Array; material: Float32Array; width: number; height: number } => {
    const count = triangleMaterial.length;
    const width = TABLE_WIDTH;
    const height = Math.max(1, Math.ceil(count / width));
    const surface = new Float32Array(width * height * 4);
    const material = new Float32Array(width * height * 4);
    for (let t = 0; t < count; t++) {
        const index = triangleMaterial[t];
        const found = materials[index] ?? { color: [1, 1, 1] as [number, number, number], opacity: 1 };
        surface.set([...found.color, found.opacity], t * 4);
        material.set([...materialColour(index), 1], t * 4);
    }
    return { surface, material, width, height };
};

/** A mesh's name without the low- and high-poly marks people give them (\`Helmet_low\`, \`helmet_HP\`, \`Visor.high.001\`). */
export const baseName = (name: string): string => name.trim().toLowerCase()
    .replace(/[._]\d{3}$/, '')
    .replace(/[._ -]?(low|lo|lowpoly|lp|high|hi|highpoly|hp)$/, '')
    .replace(/[._ -]+$/, '');

export interface NamedBox { name: string; min: [number, number, number]; max: [number, number, number] }

const overlaps = (a: NamedBox, b: NamedBox, margin: number): boolean => [0, 1, 2].every((k) => a.min[k] - margin <= b.max[k] && b.min[k] - margin <= a.max[k]);

/**
 * For each low-poly mesh, the high-poly meshes it is baked from: those with the same name once the low
 * and high marks are taken off; failing that (with `byName` on, or always without it), those whose boxes
 * come within `margin` of it; failing that, all of them.
 */
export const bakeGroups = (low: readonly NamedBox[], high: readonly NamedBox[], margin: number, byName = true): number[][] => low.map((mesh) => {
    const all = high.map((_, i) => i);
    if (byName) {
        const named = all.filter((i) => baseName(high[i].name) === baseName(mesh.name) && baseName(mesh.name) !== '');
        if (named.length) return named;
    }
    const near = all.filter((i) => overlaps(mesh, high[i], margin));
    return near.length ? near : all;
});
