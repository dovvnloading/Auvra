import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHOTO_NODES, atlasPlace, pickBand, shadingFit } from '../../texturing/graph/nodes/photo';
import { closedCut, seamMasks, seamTile, type Picture } from '../../texturing/graph/seamCut';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

/** A smooth random picture that does not tile: a slope across it and lumps of noise. */
const photo = (width: number, height: number, seed = 1): Picture => {
    let state = seed * 9301 + 49297;
    const random = () => { state = (state * 233280 + 49297) % 2147483647; return state / 2147483647; };
    const bumps = Array.from({ length: 12 }, () => [random() * width, random() * height, 4 + random() * 10, random() - 0.5]);
    const data = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v = 0.2 + 0.5 * (x / width) + 0.2 * (y / height);
            for (const [bx, by, r, a] of bumps) v += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (r * r));
            for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = v * (0.8 + 0.1 * c);
        }
    }
    return { data, width, height, channels: 3 };
};

const at = (p: Picture, x: number, y: number, c = 0) => p.data[(((y % p.height) + p.height) % p.height * p.width + (((x % p.width) + p.width) % p.width)) * p.channels + c];

/** The mean step between neighbours across the wrap (left and right edges, top and bottom) and inside. */
const steps = (p: Picture) => {
    let wrap = 0;
    let inside = 0;
    let n = 0;
    for (let y = 0; y < p.height; y++) { wrap += Math.abs(at(p, 0, y) - at(p, p.width - 1, y)); n++; }
    for (let x = 0; x < p.width; x++) { wrap += Math.abs(at(p, x, 0) - at(p, x, p.height - 1)); n++; }
    let m = 0;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width - 1; x++) { inside += Math.abs(at(p, x, y) - at(p, x + 1, y)); m++; }
    return { wrap: wrap / n, inside: inside / m };
};

describe('photo and scan processing', () => {
    it('finds the cheapest cut down a band, closing up top to bottom', () => {
        const height = 40;
        const groove = (y: number) => 10 + Math.round(4 * Math.sin((y / height) * Math.PI * 2));
        const path = closedCut((x, y) => (x === groove(y) ? 0 : 1), 3, 20, height);
        for (let y = 0; y < height; y++) expect(path[y]).toBe(groove(y));
        // With nothing to follow it still stays in its band and its ends meet.
        const flat = closedCut((x, y) => ((x * 7 + y * 13) % 5) / 5, 5, 15, height);
        expect(Math.abs(flat[0] - flat[height - 1])).toBeLessThanOrEqual(1);
        for (let y = 0; y < height; y++) { expect(flat[y]).toBeGreaterThanOrEqual(5); expect(flat[y]).toBeLessThan(15); }
        for (let y = 1; y < height; y++) expect(Math.abs(flat[y] - flat[y - 1])).toBeLessThanOrEqual(1);
    });

    it('makes a photo tile by cutting, every pixel its own, with no seam where it repeats', () => {
        const input = photo(64, 64);
        const before = steps(input);
        expect(before.wrap).toBeGreaterThan(before.inside * 5);
        const masks = seamMasks(input, 12);
        const tiled = seamTile(input, masks);
        const after = steps(tiled);
        expect(after.wrap).toBeLessThan(after.inside * 2.5);
        // No ghosting: each pixel is one of the four pixels of the photo it may come from, never a mix.
        for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
                const value = at(tiled, x, y);
                const sources = [at(input, x, y), at(input, x - 32, y), at(input, x, y + 32), at(input, x - 32, y + 32)];
                expect(sources.some((source) => Math.abs(source - value) < 1e-6), `${x},${y}`).toBe(true);
            }
        }
        // The middle of the photo is left as it was.
        for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) expect(at(tiled, x, y)).toBeCloseTo(at(input, x, y), 6);
    });

    it('chooses the narrowest band that hides its joins about as well as the best', () => {
        expect(pickBand([1, 0.5, 0.45, 0.44])).toBe(1);
        expect(pickBand([0.3, 0.29, 0.28, 0.2])).toBe(3);
        expect(pickBand([0.1, 0.1, 0.1, 0.1])).toBe(0);
    });

    it('finds the direction of baked-in light from slopes and brightness', () => {
        let state = 7;
        const random = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
        const sums = { nx: 0, ny: 0, l: 0, nxx: 0, nyy: 0, nxy: 0, lnx: 0, lny: 0 };
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const nx = (random() - 0.5) * 0.6;
            const ny = (random() - 0.5) * 0.6;
            const l = 0.5 + 0.2 * nx - 0.1 * ny;
            sums.nx += nx / n; sums.ny += ny / n; sums.l += l / n;
            sums.nxx += (nx * nx) / n; sums.nyy += (ny * ny) / n; sums.nxy += (nx * ny) / n; sums.lnx += (l * nx) / n; sums.lny += (l * ny) / n;
        }
        const fit = shadingFit(sums);
        expect(fit.a).toBeCloseTo(0.2, 4);
        expect(fit.b).toBeCloseTo(-0.1, 4);
        expect(fit.mean).toBeCloseTo(0.5, 2);
        // Flat (no slopes at all): nothing to fit, nothing taken out.
        expect(shadingFit({ nx: 0, ny: 0, l: 0.4, nxx: 0, nyy: 0, nxy: 0, lnx: 0, lny: 0 })).toMatchObject({ a: 0, b: 0 });
    });

    it('takes atlas pieces counted from the top left', () => {
        expect(atlasPlace(0, 0, 4, 4, 1)).toEqual([0, 0.75]);
        expect(atlasPlace(0, 0, 4, 4, 6)).toEqual([0.25, 0.5]);
        expect(atlasPlace(1, 1, 4, 4, 16)).toEqual([1, 0.25]);
        const [u, v] = atlasPlace(0, 0, 2, 2, 1, 0.1);
        expect(u).toBeCloseTo(0.05, 9);
        expect(v).toBeCloseTo(0.55, 9);
    });

    it('every node says what it does, in its own group', () => {
        for (const definition of PHOTO_NODES) {
            expect(definition.category, definition.type).toBe('Photo and scans');
            expect(definition.description.length, definition.type).toBeGreaterThan(40);
            expect(textureNodeDefinitionByType(definition.type), definition.type).toBe(definition);
        }
        expect(textureNodeDefinitionByType('makeTile')?.params.find((param) => param.key === 'method')?.default).toBe('seams');
    });
});

describe('shaders', () => {
    /** Names every pass already declares (its prelude and the kit): a node declaring one again does not compile. */
    const TAKEN = ['uSize', 'vUv', 'outColor', 'uSeed', 'uTiles', 'uWorld', 'uIteration', 'uIterations'];
    it('never declare a name the pass already has', () => {
        const folder = resolve(__dirname, '../../texturing/graph/nodes');
        for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
            const source = readFileSync(resolve(folder, file), 'utf8');
            for (const name of TAKEN) {
                // Raw passes that set uWorld themselves (curvature) declare it: only kit passes may not.
                if (name === 'uWorld' && file === 'distance.ts') continue;
                if (name === 'uSeed' && file === 'scatter.ts') continue;
                expect(source, `${file} declares ${name}`).not.toMatch(new RegExp(`uniform\\s+\\w+\\s+${name}\\b`));
            }
        }
    });
});
