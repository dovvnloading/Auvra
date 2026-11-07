import { describe, expect, it } from 'vitest';
import { formulaScope, resolveNodeParams } from '../../texturing/graph/document';
import { shadingFit } from '../../texturing/graph/nodes/photo';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import type { TexGraphNode, TextureGraph } from '../../texturing/graph/types';
import { guessInvertHeight, photoMaterialGraph } from '../../texturing/paint/photoMaterial';

/**
 * The photo material's graph run on the CPU, node by node as it is wired, each node doing the sums its
 * shader does (the GPU is not here): enough to see what the base colour, occlusion and normal come out as.
 */

interface Picture { size: number; channels: 1 | 4; data: Float32Array }

const picture = (size: number, channels: 1 | 4, fill: (x: number, y: number, c: number) => number): Picture => {
    const data = new Float32Array(size * size * channels);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < channels; c++) data[(y * size + x) * channels + c] = fill(x, y, c);
    return { size, channels, data };
};
const at = (image: Picture, x: number, y: number, c: number): number => {
    const n = image.size;
    const wrap = (v: number) => ((v % n) + n) % n;
    return image.data[(wrap(y) * n + wrap(x)) * image.channels + Math.min(c, image.channels - 1)];
};
/** Bilinear, wrapping, at a place given in texels. */
const sample = (image: Picture, fx: number, fy: number, c: number): number => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    return (at(image, x0, y0, c) * (1 - tx) + at(image, x0 + 1, y0, c) * tx) * (1 - ty) + (at(image, x0, y0 + 1, c) * (1 - tx) + at(image, x0 + 1, y0 + 1, c) * tx) * ty;
};
const map = (image: Picture, channels: 1 | 4, f: (x: number, y: number, c: number) => number): Picture => picture(image.size, channels, f);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const gaussian = (image: Picture, sigma: number): Picture => {
    if (sigma <= 0.01) return image;
    const reach = Math.ceil(sigma * 3);
    const weights = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const pass = (from: Picture, dx: number, dy: number) => map(from, from.channels, (x, y, c) => {
        let sum = 0;
        for (let i = 0; i < weights.length; i++) sum += weights[i] * at(from, x + (i - reach) * dx, y + (i - reach) * dy, c);
        return sum / total;
    });
    return pass(pass(image, 1, 0), 0, 1);
};
const mean = (image: Picture, c: number): number => {
    let sum = 0;
    for (let y = 0; y < image.size; y++) for (let x = 0; x < image.size; x++) sum += at(image, x, y, c);
    return sum / (image.size * image.size);
};

/** Each node's sums, as its shader does them. */
const run = (graph: TextureGraph, photo: Picture, output: string): Picture => {
    const N = photo.size;
    const values = Object.fromEntries(graph.parameters.map((parameter) => [parameter.name, parameter.default]));
    const scope = formulaScope(graph, values, N, N);
    const made = new Map<string, Picture>();
    const input = (node: TexGraphNode, key: string): Picture | null => {
        const link = graph.links.find((each) => each.to === node.id && each.toInput === key);
        return link ? evaluate(graph.nodes.find((each) => each.id === link.from)!) : null;
    };
    const evaluate = (node: TexGraphNode): Picture => {
        const known = made.get(node.id);
        if (known) return known;
        const p = resolveNodeParams(textureNodeDefinition(node, () => undefined)!, node, values, scope) as Record<string, number & string>;
        const one = (key: string) => input(node, key)!;
        let result: Picture;
        switch (node.type) {
            case 'bitmap': result = photo; break;
            case 'makeTile': result = one('in'); break; // The test pictures tile already.
            case 'output': result = one('in'); break;
            case 'grayscale': { const from = one('in'); result = map(from, 1, (x, y) => luma(at(from, x, y, 0), at(from, x, y, 1), at(from, x, y, 2))); break; }
            case 'levels': {
                const from = one('in');
                const gamma = Math.log(0.5) / Math.log(p.mid);
                result = map(from, from.channels, (x, y, c) => { const t = Math.min(1, Math.max(0, (at(from, x, y, c) - p.inLow) / Math.max(p.inHigh - p.inLow, 1e-5))) ** gamma; return p.outLow + (p.outHigh - p.outLow) * t; });
                break;
            }
            case 'blur': result = gaussian(one('in'), p.radius * N / 3); break;
            case 'highpass': { const from = one('in'); const blurred = gaussian(from, p.radius * N / 3); result = map(from, from.channels, (x, y, c) => Math.min(1, Math.max(0, at(from, x, y, c) - at(blurred, x, y, c) + 0.5))); break; }
            case 'blend': {
                const fg = one('foreground'), bg = one('background');
                const mix = (a: number, b: number) => (p.mode === 'overlay' ? (b < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)) : p.mode === 'multiply' ? a * b : a);
                result = map(bg, bg.channels, (x, y, c) => { const b = at(bg, x, y, c); return Math.min(1, Math.max(0, b + (mix(at(fg, x, y, c), b) - b) * p.opacity)); });
                break;
            }
            case 'aoFromHeight': {
                const from = one('in');
                const quality = Number(p.quality) || 2;
                const directions = 4 + 4 * quality, steps = 4 + 4 * quality, jitter = 0.5;
                result = map(from, 1, (x, y) => {
                    const h0 = at(from, x, y, 0) * p.depth;
                    let occlusion = 0;
                    for (let d = 0; d < directions; d++) {
                        const a = ((d + jitter) / directions) * Math.PI * 2;
                        let horizon = 0;
                        for (let s = 1; s <= steps; s++) {
                            const r = (p.radius * (s - 0.5 * jitter)) / steps;
                            const h = sample(from, x + Math.cos(a) * r * N, y + Math.sin(a) * r * N, 0) * p.depth;
                            horizon = Math.max(horizon, (h - h0) / r);
                        }
                        occlusion += horizon / Math.sqrt(1 + horizon * horizon);
                    }
                    return Math.min(1, Math.max(0, 1 - (occlusion / directions) * p.intensity));
                });
                break;
            }
            case 'lightingRemoval': {
                const colour = one('in'), ao = input(node, 'occlusion'), height = input(node, 'height');
                const unoccluded = (x: number, y: number, c: number) => at(colour, x, y, c) / Math.max(1 + ((ao ? at(ao, x, y, 0) : 1) - 1) * p.occlusionAmount, 0.05);
                const normal = (x: number, y: number): [number, number] => {
                    if (!height) return [0, 0];
                    const dx = (at(height, x + 1, y, 0) - at(height, x - 1, y, 0)) * 0.5 * N * p.depth, dy = (at(height, x, y + 1, 0) - at(height, x, y - 1, 0)) * 0.5 * N * p.depth;
                    const length = Math.hypot(dx, dy, 1);
                    return [-dx / length, -dy / length];
                };
                const sums = { nx: 0, ny: 0, l: 0, nxx: 0, nyy: 0, nxy: 0, lnx: 0, lny: 0 };
                for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                    const [nx, ny] = normal(x, y);
                    const l = luma(unoccluded(x, y, 0), unoccluded(x, y, 1), unoccluded(x, y, 2));
                    sums.nx += nx; sums.ny += ny; sums.l += l; sums.nxx += nx * nx; sums.nyy += ny * ny; sums.nxy += nx * ny; sums.lnx += l * nx; sums.lny += l * ny;
                }
                for (const key of Object.keys(sums) as Array<keyof typeof sums>) sums[key] /= N * N;
                const fit = shadingFit(sums);
                result = map(colour, 4, (x, y, c) => {
                    if (c === 3) return 1;
                    const [nx, ny] = normal(x, y);
                    const shade = 1 + (fit.a * (nx - fit.nx) + fit.b * (ny - fit.ny)) / Math.max(fit.mean, 1e-3);
                    return unoccluded(x, y, c) / Math.max(1 + (shade - 1) * p.shadingAmount, 0.2);
                });
                break;
            }
            case 'colourEqualizer': {
                const from = one('in');
                const low = gaussian(from, Math.max(0.5, (p.size * N) / 3));
                const overall = luma(mean(low, 0), mean(low, 1), mean(low, 2));
                result = map(from, from.channels, (x, y, c) => {
                    if (c === 3) return at(from, x, y, c);
                    const gain = Math.min(8, Math.max(0, overall / Math.max(luma(at(low, x, y, 0), at(low, x, y, 1), at(low, x, y, 2)), 1e-4)));
                    return at(from, x, y, c) * (1 + (gain - 1) * p.amount);
                });
                break;
            }
            case 'normalFromHeight': {
                // Sobel over pixels of the height, as slope per unit of the image over 64, per metre of the graph's
                // size in the world (one metre here).
                const from = one('in');
                const h = (x: number, y: number) => at(from, x, y, 0);
                const normals = new Float32Array(N * N * 3);
                for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                    const dx = ((h(x + 1, y + 1) + 2 * h(x + 1, y) + h(x + 1, y - 1)) - (h(x - 1, y + 1) + 2 * h(x - 1, y) + h(x - 1, y - 1))) / 8 * N / 64;
                    const dy = ((h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1))) / 8 * N / 64;
                    const nx = -dx * p.intensity, ny = -dy * p.intensity, length = Math.hypot(nx, ny, 1);
                    normals.set([nx / length, ny / length, 1 / length], (y * N + x) * 3);
                }
                result = map(from, 4, (x, y, c) => (c === 3 ? 1 : normals[(y * N + x) * 3 + c] * 0.5 + 0.5));
                break;
            }
            default: throw new Error(`No CPU sums for ${node.type}`);
        }
        made.set(node.id, result);
        return result;
    };
    return evaluate(graph.nodes.find((node) => node.type === 'output' && node.params.channel === output)!);
};

/** A steady value in 0..1 for a place (the photo's grain). */
const grain = (x: number, y: number, c: number) => { let h = Math.imul(x * 374761393 + y * 668265263 + c * 2246822519, 3266489917); h = Math.imul(h ^ (h >>> 15), 2246822519); return ((h ^ (h >>> 13)) >>> 0) / 4294967295; };

/** A wall of bricks `width` × `height` texels, every other row shifted by half, with `mortar` texels of mortar between. */
const wall = (width: number, height: number, mortar: number) => {
    const row = (y: number) => Math.floor(y / height);
    const along = (x: number, y: number) => x + (row(y) % 2) * (width / 2);
    return {
        isMortar: (x: number, y: number) => y % height < mortar || along(x, y) % width < mortar,
        /** Which brick a place is on, as a column and a row. */
        brick: (x: number, y: number): [number, number] => [Math.floor(along(x, y) / width), row(y)],
    };
};

const N = 64;
/** Bright mortar lines (two texels) between darker bricks (16 × 8), with grain. */
const small = wall(16, 8, 2);
const isMortar = small.isMortar;
const bricks = picture(N, 4, (x, y, c) => {
    if (c === 3) return 1;
    const base = isMortar(x, y) ? [0.82, 0.8, 0.76][c] : [0.5, 0.2, 0.14][c] * (0.9 + 0.2 * grain(...small.brick(x, y), 9));
    return Math.min(1, Math.max(0, base + (grain(x, y, 0) - 0.5) * 0.12));
});
const stats = (image: Picture) => {
    const lumas: number[] = [];
    for (let y = 0; y < image.size; y++) for (let x = 0; x < image.size; x++) lumas.push(luma(at(image, x, y, 0), at(image, x, y, 1), at(image, x, y, 2)));
    const average = lumas.reduce((sum, v) => sum + v, 0) / lumas.length;
    const spread = Math.sqrt(lumas.reduce((sum, v) => sum + (v - average) ** 2, 0) / lumas.length);
    return { means: [0, 1, 2].map((c) => mean(image, c)), spread, blown: lumas.filter((v) => v > 0.98).length / lumas.length };
};
const brightnessOf = (image: Picture) => Array.from({ length: image.size * image.size }, (_, i) => luma(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]));

/**
 * A brick photo as the importer looks at one (128 × 128): bright mortar in thin lines, about 14% of it,
 * and about a fifth of the bricks dark, in blocks, so the dark share is the larger one (as on a real red
 * brick wall), its edges a little soft and grain over all of it.
 */
const mixedWall = wall(40, 20, 2);
const isDarkBrick = (x: number, y: number) => { const [column, row] = mixedWall.brick(x, y); return !mixedWall.isMortar(x, y) && (column * 7 + row * 3) % 4 === 0; };
const mixedBricks = (() => {
    const sharp = picture(128, 1, (x, y) => (mixedWall.isMortar(x, y) ? 0.55 : isDarkBrick(x, y) ? 0.2 : 0.34 + (grain(...mixedWall.brick(x, y), 4) - 0.5) * 0.06));
    const soft = gaussian(sharp, 0.6);
    return picture(128, 4, (x, y, c) => (c === 3 ? 1 : Math.min(1, Math.max(0, at(soft, x, y, 0) + (grain(x, y, 1) - 0.5) * 0.1))));
})();

/** A brick photo at the smallest size the importer makes a graph (512): 128 × 32 bricks, 5 texels of soft mortar, some dark bricks, mottling and grain. */
const largeWall = wall(128, 32, 5);
const largeBricks = (() => {
    const sharp = picture(512, 1, (x, y) => {
        if (largeWall.isMortar(x, y)) return 0.55;
        const [column, row] = largeWall.brick(x, y);
        return (column * 7 + row * 3) % 4 === 0 ? 0.2 : 0.34 + (grain(column, row, 4) - 0.5) * 0.06;
    });
    const soft = gaussian(sharp, 1);
    const mottling = gaussian(picture(512, 1, (x, y) => grain(x, y, 2) - 0.5), 3);
    return picture(512, 4, (x, y, c) => (c === 3 ? 1 : Math.min(1, Math.max(0, at(soft, x, y, 0) + at(mottling, x, y, 0) * 0.5 + (grain(x, y, 1) - 0.5) * 0.12))));
})();

describe('photo material output', () => {
    it('guesses bright mortar between darker bricks is low, and dark grout between light tiles is not', () => {
        expect(guessInvertHeight(brightnessOf(bricks))).toBe(true);
        const tiles = picture(N, 4, (x, y, c) => (c === 3 ? 1 : isMortar(x, y) ? 0.15 : 0.85));
        expect(guessInvertHeight(brightnessOf(tiles))).toBe(false);
        // Dark cracks wandering over a light stone are low too.
        const cracks = picture(128, 4, (x, y, c) => (c === 3 ? 1 : Math.abs(y - 64 - 20 * Math.sin(x / 13)) < 1.5 || Math.abs(x - 40 - 15 * Math.sin(y / 9)) < 1.5 ? 0.18 : 0.6 + (grain(x, y, 3) - 0.5) * 0.1));
        expect(guessInvertHeight(brightnessOf(cracks), 128)).toBe(false);
    });

    it('guesses bright mortar is low even when dark bricks make the dark share the larger one', () => {
        let mortar = 0, dark = 0;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { if (mixedWall.isMortar(x, y)) mortar++; if (isDarkBrick(x, y)) dark++; }
        expect(mortar / 128 ** 2).toBeCloseTo(0.14, 1);
        expect(dark / 128 ** 2).toBeCloseTo(0.2, 1);
        expect(guessInvertHeight(brightnessOf(mixedBricks), 128)).toBe(true);
    });

    it('keeps a brick photo\'s colour as it is: no white specks, the same brightness and spread', () => {
        const graph = photoMaterialGraph('bricks', 6, { invertHeight: true });
        const before = stats(bricks);
        const after = stats(run(graph, bricks, 'baseColor'));
        for (let c = 0; c < 3; c++) expect(Math.abs(after.means[c] - before.means[c])).toBeLessThan(0.1);
        expect(after.spread).toBeLessThan(before.spread * 1.5);
        expect(after.blown).toBeLessThan(0.01);
    });

    it('makes a soft occlusion, mostly near white, darker along the mortar', () => {
        const occlusion = run(photoMaterialGraph('bricks', 6, { invertHeight: true }), bricks, 'ambientOcclusion');
        const mortar: number[] = [];
        const brick: number[] = [];
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) (isMortar(x, y) ? mortar : brick).push(at(occlusion, x, y, 0));
        const average = (list: number[]) => list.reduce((sum, v) => sum + v, 0) / list.length;
        expect(average(brick)).toBeGreaterThan(0.85);
        expect(average(mortar)).toBeLessThan(average(brick) - 0.02);
        expect(Math.min(...mortar)).toBeGreaterThan(0.3);
    });

    it('makes a normal that is mostly flat with clear mortar edges, not glittering grain', () => {
        const normal = run(photoMaterialGraph('bricks', 9, { invertHeight: true }), largeBricks, 'normal');
        const size = normal.size;
        const n = (x: number, y: number): [number, number] => [at(normal, x, y, 0) * 2 - 1, at(normal, x, y, 1) * 2 - 1];
        // How far a place is from the mortar, up to 8 texels.
        const fromMortar = (x: number, y: number) => {
            for (let r = 0; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && largeWall.isMortar(((x + dx) % size + size) % size, ((y + dy) % size + size) % size)) return r;
            return 9;
        };
        let tilt = 0, change = 0, faces = 0, faceTilt = 0, edges = 0, edgeTilt = 0;
        const [meanX, meanY] = [mean(normal, 0) * 2 - 1, mean(normal, 1) * 2 - 1];
        let spread = 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const [nx, ny] = n(x, y);
            const here = Math.hypot(nx, ny);
            tilt += here;
            spread += Math.hypot(nx - meanX, ny - meanY);
            const [rx, ry] = n(x + 1, y), [dx, dy] = n(x, y + 1);
            change += (Math.hypot(rx - nx, ry - ny) + Math.hypot(dx - nx, dy - ny)) / 2;
            const distance = fromMortar(x, y);
            if (distance >= 6) { faces++; faceTilt += here; } else if (distance >= 1 && distance <= 3) { edges++; edgeTilt += here; }
        }
        const count = size * size;
        // Mostly flat: a modest lean on average, less on the brick faces.
        expect(tilt / count).toBeLessThan(0.4);
        expect(faceTilt / faces).toBeLessThan(0.2);
        // The mortar's edges stand out clearly from the faces.
        expect(edgeTilt / edges).toBeGreaterThan((faceTilt / faces) * 2);
        // From one pixel to the next the normal changes far less than it varies: noise changes as much again.
        expect(change / spread).toBeLessThan(0.5);
    });
});
