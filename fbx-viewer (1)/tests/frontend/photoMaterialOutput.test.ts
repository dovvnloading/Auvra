import { describe, expect, it } from 'vitest';
import { formulaScope, resolveNodeParams } from '../../texturing/graph/document';
import { shadingFit } from '../../texturing/graph/nodes/photo';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import type { TexGraphNode, TextureGraph } from '../../texturing/graph/types';
import { guessInvertHeight, photoMaterialGraph } from '../../texturing/paint/photoMaterial';

/**
 * The photo material's graph run on the CPU, node by node as it is wired, each node doing the sums its
 * shader does (the GPU is not here): enough to see what the base colour and occlusion come out as.
 */

interface Picture { size: number; channels: 1 | 4; data: Float32Array }

const N = 64;
const picture = (channels: 1 | 4, fill: (x: number, y: number, c: number) => number): Picture => {
    const data = new Float32Array(N * N * channels);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < channels; c++) data[(y * N + x) * channels + c] = fill(x, y, c);
    return { size: N, channels, data };
};
const at = (image: Picture, x: number, y: number, c: number): number => {
    const wrap = (v: number) => ((v % N) + N) % N;
    return image.data[(wrap(y) * N + wrap(x)) * image.channels + Math.min(c, image.channels - 1)];
};
/** Bilinear, wrapping, at a place given in texels. */
const sample = (image: Picture, fx: number, fy: number, c: number): number => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    return (at(image, x0, y0, c) * (1 - tx) + at(image, x0 + 1, y0, c) * tx) * (1 - ty) + (at(image, x0, y0 + 1, c) * (1 - tx) + at(image, x0 + 1, y0 + 1, c) * tx) * ty;
};
const map = (_image: Picture, channels: 1 | 4, f: (x: number, y: number, c: number) => number): Picture => picture(channels, f);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const gaussian = (image: Picture, sigma: number): Picture => {
    if (sigma <= 0.01) return image;
    const reach = Math.ceil(sigma * 3);
    const weights = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const pass = (from: Picture, dx: number, dy: number) => map(from, from.channels, (x, y, c) => weights.reduce((sum, w, i) => sum + w * at(from, x + (i - reach) * dx, y + (i - reach) * dy, c), 0) / total);
    return pass(pass(image, 1, 0), 0, 1);
};
const mean = (image: Picture, c: number): number => { let sum = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) sum += at(image, x, y, c); return sum / (N * N); };

/** Each node's sums, as its shader does them. */
const run = (graph: TextureGraph, photo: Picture, output: string): Picture => {
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
            case 'makeTile': result = one('in'); break; // The test picture tiles already.
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
            default: throw new Error(`No CPU sums for ${node.type}`);
        }
        made.set(node.id, result);
        return result;
    };
    return evaluate(graph.nodes.find((node) => node.type === 'output' && node.params.channel === output)!);
};

/** A steady value in 0..1 for a place (the photo's grain). */
const grain = (x: number, y: number, c: number) => { let h = Math.imul(x * 374761393 + y * 668265263 + c * 2246822519, 3266489917); h = Math.imul(h ^ (h >>> 15), 2246822519); return ((h ^ (h >>> 13)) >>> 0) / 4294967295; };
/** Bright mortar lines (two texels) between darker bricks (16 × 8, every other row shifted), with grain. */
const isMortar = (x: number, y: number) => y % 8 < 2 || (x + (Math.floor(y / 8) % 2) * 8) % 16 < 2;
const bricks = picture(4, (x, y, c) => {
    if (c === 3) return 1;
    const base = isMortar(x, y) ? [0.82, 0.8, 0.76][c] : [0.5, 0.2, 0.14][c] * (0.9 + 0.2 * grain(Math.floor((x + (Math.floor(y / 8) % 2) * 8) / 16), Math.floor(y / 8), 9));
    return Math.min(1, Math.max(0, base + (grain(x, y, 0) - 0.5) * 0.12));
});
const stats = (image: Picture) => {
    const lumas: number[] = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) lumas.push(luma(at(image, x, y, 0), at(image, x, y, 1), at(image, x, y, 2)));
    const average = lumas.reduce((sum, v) => sum + v, 0) / lumas.length;
    const spread = Math.sqrt(lumas.reduce((sum, v) => sum + (v - average) ** 2, 0) / lumas.length);
    return { means: [0, 1, 2].map((c) => mean(image, c)), spread, blown: lumas.filter((v) => v > 0.98).length / lumas.length };
};

describe('photo material output', () => {
    it('guesses bright mortar between darker bricks is low, and dark grout between light tiles is too', () => {
        const brightness = (image: Picture) => Array.from({ length: N * N }, (_, i) => luma(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]));
        expect(guessInvertHeight(brightness(bricks))).toBe(true);
        const tiles = picture(4, (x, y, c) => (c === 3 ? 1 : isMortar(x, y) ? 0.15 : 0.85));
        expect(guessInvertHeight(brightness(tiles))).toBe(false);
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
});
