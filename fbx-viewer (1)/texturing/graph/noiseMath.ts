import { floatBits, hash1, hashU } from './scatter';

/**
 * NOISE MATHS ON THE CPU
 *
 * The shaders' noise functions (glslLibrary.ts) and the building blocks of the noise, pattern and
 * grunge nodes, written again for the CPU step for step. The nodes' shaders and these give the same
 * pictures (to float rounding); the tests read these to check every node tiles (its edges match).
 * Periods are cells across and down; a period of 0 means it does not repeat.
 */

export const TAU = Math.PI * 2;
export const fract = (x: number): number => x - Math.floor(x);
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const saturate = (x: number): number => Math.min(1, Math.max(0, x));
export const smoothstep = (low: number, high: number, x: number): number => {
    const t = saturate((x - low) / (high - low));
    return t * t * (3 - 2 * t);
};
export const step = (edge: number, x: number): number => (x < edge ? 0 : 1);
/** A cell kept inside its period (as the shaders' wrapCell); left as it is where nothing repeats. */
export const wrap = (c: number, period: number): number => (period > 0 ? ((c % period) + period) % period : c);

/** The shaders' hashU(uvec3). */
export const hashU3 = (x: number, y: number, z: number): number => hashU((x ^ hashU((y ^ hashU((z + 0x85ebca6b) >>> 0)) >>> 0)) >>> 0);
/** The shaders' hash3(ivec2, seed). */
export const hash3 = (x: number, y: number, seed: number): [number, number, number] => {
    const s = Math.fround(seed);
    return [hash1(x, y, s), hash1(x, y, Math.fround(s + 17.137)), hash1(x, y, Math.fround(s + 41.773))];
};
export const hash2 = (x: number, y: number, seed: number): [number, number] => {
    const s = Math.fround(seed);
    return [hash1(x, y, s), hash1(x, y, Math.fround(s + 17.137))];
};
export { hash1, floatBits, hashU };

/** Gradient (Perlin) noise, about -1 to 1. */
export const perlin = (x: number, y: number, px: number, py: number, seed: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const corner = (cx: number, cy: number, dx: number, dy: number) => {
        const a = hash1(wrap(cx, px), wrap(cy, py), seed) * TAU;
        return Math.cos(a) * dx + Math.sin(a) * dy;
    };
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = corner(ix, iy, fx, fy);
    const b = corner(ix + 1, iy, fx - 1, fy);
    const c = corner(ix, iy + 1, fx, fy - 1);
    const d = corner(ix + 1, iy + 1, fx - 1, fy - 1);
    return mix(mix(a, b, ux), mix(c, d, ux), uy) * 1.41421356;
};

/** Value noise, 0 to 1. */
export const valueNoise = (x: number, y: number, px: number, py: number, seed: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const at = (cx: number, cy: number) => hash1(wrap(cx, px), wrap(cy, py), seed);
    return mix(mix(at(ix, iy), at(ix + 1, iy), ux), mix(at(ix, iy + 1), at(ix + 1, iy + 1), ux), uy);
};

/** Cellular (Worley) noise: nearest distance, second nearest, and the nearest cell's random value. */
export const worley = (x: number, y: number, px: number, py: number, jitter: number, metric: number, seed: number): [number, number, number] => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    let d1 = 8;
    let d2 = 8;
    let id = 0;
    for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
            const cx = wrap(ix + ox, px);
            const cy = wrap(iy + oy, py);
            const [hx, hy] = hash2(cx, cy, seed);
            const dx = ox + 0.5 + (hx - 0.5) * jitter - fx;
            const dy = oy + 0.5 + (hy - 0.5) * jitter - fy;
            const d = metric === 1 ? Math.abs(dx) + Math.abs(dy) : metric === 2 ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
            if (d < d1) { d2 = d1; d1 = d; id = hash1(cx, cy, Math.fround(seed + 3.71)); } else if (d < d2) d2 = d;
        }
    }
    return [d1, d2, id];
};

/** Octaves of Perlin noise, each twice as fine and `roughness` as strong, about -1 to 1 (the shaders' fbmNoise). */
export const fbm = (u: number, v: number, scale: number, octaves: number, roughness: number, seed: number): number => {
    let sum = 0;
    let amplitude = 1;
    let total = 0;
    let s = scale;
    for (let o = 0; o < Math.min(12, octaves); o++) {
        sum += perlin(u * s, v * s, s, s, Math.fround(seed + o * 13.17)) * amplitude;
        total += amplitude;
        amplitude *= roughness;
        s *= 2;
    }
    return sum / Math.max(total, 1e-5);
};

/** A place pushed about by smooth noise, `amount` of the way (the shaders' disorderAt): it still tiles. */
export const disorderAt = (u: number, v: number, amount: number, seed: number): [number, number] => {
    if (amount <= 0) return [u, v];
    return [
        u + perlin(u * 3, v * 3, 3, 3, Math.fround(seed + 91.7)) * amount * 0.15,
        v + perlin(u * 3 + 0.5, v * 3 + 0.5, 3, 3, Math.fround(seed + 37.3)) * amount * 0.15,
    ];
};

/** Stretched value noise, smoothed across and sharpened by `sharpness` (the shaders' strandNoise). */
export const strandNoise = (x: number, y: number, px: number, py: number, seed: number, sharpness: number): number => {
    const value = valueNoise(x, y, px, py, seed);
    return Math.pow(value, mix(1, 6, sharpness));
};

/** Round spots scattered in cells, the brightest that reaches each place (the shaders' spotField). */
export const spotField = (x: number, y: number, px: number, py: number, density: number, size: number, variation: number, softness: number, seed: number, randomBrightness: boolean): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    let value = 0;
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const cx = wrap(ix + ox, px);
            const cy = wrap(iy + oy, py);
            if (hash1(cx, cy, Math.fround(seed + 2.9)) > density) continue;
            const [rx, ry, rz] = hash3(cx, cy, seed);
            const centreX = ox + 0.5 + (rx - 0.5) * (1 - size);
            const centreY = oy + 0.5 + (ry - 0.5) * (1 - size);
            const radius = size * 0.5 * mix(1, rz, variation);
            const d = Math.hypot(fx - centreX, fy - centreY);
            const spot = 1 - smoothstep(radius * (1 - softness) - 1e-4, radius, d);
            value = Math.max(value, spot * (randomBrightness ? hash1(cx, cy, Math.fround(seed + 7.7)) : 1));
        }
    }
    return value;
};

/** Thin tapering lines along the first axis, in cells (the shaders' scratchField). */
export const scratchField = (x: number, y: number, px: number, py: number, density: number, length: number, thickness: number, variation: number, seed: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let value = 0;
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -3; ox <= 0; ox++) {
            const cellX = ix + ox;
            const cellY = iy + oy;
            const cx = wrap(cellX, px);
            const cy = wrap(cellY, py);
            if (hash1(cx, cy, Math.fround(seed + 5.5)) > density) continue;
            const [rx, ry, rz] = hash3(cx, cy, seed);
            const start = cellX + rx;
            const span = Math.min(3, length) * (0.4 + 0.6 * ry);
            const t = (x - start) / span;
            if (t < 0 || t > 1) continue;
            const lineY = cellY + 0.15 + 0.7 * rz;
            const width = thickness * 0.5 * (1 - Math.abs(t * 2 - 1));
            const line = 1 - smoothstep(width * 0.5, width + 1e-3, Math.abs(y - lineY));
            value = Math.max(value, line * mix(1, hash1(cx, cy, Math.fround(seed + 9.1)), variation));
        }
    }
    return value;
};

// ---- simplex noise in four dimensions (round a ring each way, so it tiles) ----

const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

/** The dot of a lattice corner's gradient (one of the 32 edges of a tesseract) with the offset. */
const simplexGradient = (c: readonly number[], d: readonly number[], seed: number): number => {
    const h = hashU3(c[0] >>> 0, c[1] >>> 0, hashU3(c[2] >>> 0, c[3] >>> 0, floatBits(Math.fround(seed))));
    const g = h & 31;
    const zero = g >> 3;
    const signs = [(g & 1) === 0 ? 1 : -1, (g & 2) === 0 ? 1 : -1, (g & 4) === 0 ? 1 : -1];
    const gradient = zero === 0 ? [0, ...signs] : zero === 1 ? [signs[0], 0, signs[1], signs[2]] : zero === 2 ? [signs[0], signs[1], 0, signs[2]] : [...signs, 0];
    return gradient[0] * d[0] + gradient[1] * d[1] + gradient[2] * d[2] + gradient[3] * d[3];
};

/** Four-dimensional simplex noise, about -1 to 1. */
export const simplex4 = (p: readonly number[], seed: number): number => {
    const s = (p[0] + p[1] + p[2] + p[3]) * F4;
    const i = p.map((value) => Math.floor(value + s));
    const t = (i[0] + i[1] + i[2] + i[3]) * G4;
    const x0 = p.map((value, k) => value - (i[k] - t));
    const rank = [0, 0, 0, 0];
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) { if (x0[a] > x0[b]) rank[a]++; else rank[b]++; }
    const corners = [[0, 0, 0, 0], rank.map((r) => (r >= 3 ? 1 : 0)), rank.map((r) => (r >= 2 ? 1 : 0)), rank.map((r) => (r >= 1 ? 1 : 0)), [1, 1, 1, 1]];
    let n = 0;
    corners.forEach((offset, k) => {
        const x = x0.map((value, axis) => value - offset[axis] + k * G4);
        let weight = 0.6 - (x[0] * x[0] + x[1] * x[1] + x[2] * x[2] + x[3] * x[3]);
        if (weight <= 0) return;
        weight *= weight;
        n += weight * weight * simplexGradient(i.map((value, axis) => value + offset[axis]), x, seed);
    });
    return 27 * n;
};

/** Where a place of the picture lies in four dimensions: round a ring each way that repeats, else straight on. */
export const ringPlace = (u: number, v: number, scale: number, tiles: [boolean, boolean]): number[] => {
    const r = scale / TAU;
    const across = tiles[0] ? [Math.cos(TAU * u) * r, Math.sin(TAU * u) * r] : [u * scale, 0];
    const down = tiles[1] ? [Math.cos(TAU * v) * r, Math.sin(TAU * v) * r] : [v * scale, 0];
    return [...across, ...down];
};

// ---- blue noise ----

/**
 * A square of blue noise `size` across (it tiles): every value from 0 to 1 once, spread so that no two
 * near values sit close together. Made by "void and cluster": from a few scattered dots, the tightest
 * cluster and the largest void are swapped until they settle; then dots are taken away from the
 * tightest clusters, and added in the largest voids, each given the next rank.
 */
export const blueNoiseTile = (size: number, seed: number): Float32Array => {
    const count = size * size;
    const sigma = 1.5;
    // The weight one dot gives another, by their distance round the tile.
    const kernel = new Float32Array(count);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = Math.min(x, size - x);
            const dy = Math.min(y, size - y);
            kernel[y * size + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        }
    }
    const energy = new Float32Array(count);
    const dots = new Uint8Array(count);
    const spread = (at: number, sign: number) => {
        const ax = at % size;
        const ay = (at / size) | 0;
        for (let y = 0; y < size; y++) {
            const row = ((y - ay + size) % size) * size;
            for (let x = 0; x < size; x++) energy[y * size + x] += sign * kernel[row + ((x - ax + size) % size)];
        }
    };
    let state = hashU((Math.round(seed * 2) ^ 0x9e3779b9) >>> 0);
    const random = () => { state = hashU((state + 0x6d2b79f5) >>> 0); return state / 4294967296; };
    const start = Math.max(1, Math.round(count * 0.1));
    while ([...dots].filter(Boolean).length < start) {
        const at = Math.floor(random() * count);
        if (!dots[at]) { dots[at] = 1; spread(at, 1); }
    }
    const tightest = (wanted: number, list: Uint8Array) => {
        let best = -1;
        for (let i = 0; i < count; i++) if (list[i] === wanted && (best < 0 || energy[i] > energy[best])) best = i;
        return best;
    };
    const emptiest = (wanted: number, list: Uint8Array) => {
        let best = -1;
        for (let i = 0; i < count; i++) if (list[i] === wanted && (best < 0 || energy[i] < energy[best])) best = i;
        return best;
    };
    // Settle the first dots: move the tightest cluster's dot to the largest void until it would go back.
    for (let guard = 0; guard < count; guard++) {
        const cluster = tightest(1, dots);
        dots[cluster] = 0;
        spread(cluster, -1);
        const gap = emptiest(0, dots);
        dots[gap] = 1;
        spread(gap, 1);
        if (gap === cluster) break;
    }
    const rank = new Float32Array(count);
    // Ranks below the first dots: take dots away from the tightest clusters.
    const first = dots.slice();
    const saved = energy.slice();
    for (let r = start - 1; r >= 0; r--) {
        const cluster = tightest(1, first);
        first[cluster] = 0;
        spread(cluster, -1);
        rank[cluster] = r;
    }
    energy.set(saved);
    // Ranks above: fill the largest voids up to half, then the tightest clusters of what is left empty.
    let next = start;
    for (; next < count / 2; next++) {
        const gap = emptiest(0, dots);
        dots[gap] = 1;
        spread(gap, 1);
        rank[gap] = next;
    }
    // With most places taken, the empty ones are the minority: their energy, from the empty places, finds the clusters.
    energy.fill(0);
    for (let i = 0; i < count; i++) if (!dots[i]) spread(i, 1);
    for (; next < count; next++) {
        const cluster = tightest(0, dots);
        dots[cluster] = 1;
        spread(cluster, -1);
        rank[cluster] = next;
    }
    for (let i = 0; i < count; i++) rank[i] = (rank[i] + 0.5) / count;
    return rank;
};
