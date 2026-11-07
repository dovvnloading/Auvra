import { describe, expect, it } from 'vitest';
import { readTextureGraph } from '../../texturing/graph/document';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { captureMaps, captureMaterialGraph } from '../../texturing/paint/captureMaterial';
import { estimateLightAzimuths, heightFromNormals, integrateSlopes, lightDirection, linearBrightness, photometricStereo, type CapturePhoto, type Vec3 } from '../../texturing/paint/photometricStereo';

/**
 * A known height and colour rendered on the CPU under four lights, as photos would be taken of it,
 * and the normal, colour, lights and height worked back out of the renders checked against it.
 */

const S = 64;
const TAU = Math.PI * 2;
/** The height (in pixels) at a column and a row (counted down), and its slopes: right, and up the picture. */
const heightAt = (x: number, r: number) => 1.5 * Math.sin((TAU * x) / 32) * Math.cos((TAU * r) / 32) + 1.5 * Math.sin((TAU * (x + 2 * r)) / 64);
const slopes = (x: number, r: number): [number, number] => {
    const dx = 1.5 * (TAU / 32) * Math.cos((TAU * x) / 32) * Math.cos((TAU * r) / 32) + 1.5 * (TAU / 64) * Math.cos((TAU * (x + 2 * r)) / 64);
    const dr = -1.5 * (TAU / 32) * Math.sin((TAU * x) / 32) * Math.sin((TAU * r) / 32) + 1.5 * (2 * TAU / 64) * Math.cos((TAU * (x + 2 * r)) / 64);
    return [dx, -dr];
};
const trueNormal = (x: number, r: number): Vec3 => { const [sx, sy] = slopes(x, r); const l = Math.hypot(sx, sy, 1); return [-sx / l, -sy / l, 1 / l]; };
/** The surface's colour (as light), darker where it is low, as crevices photograph. */
const heights = Array.from({ length: S * S }, (_, i) => heightAt(i % S, Math.floor(i / S)));
const [lowest, highest] = [Math.min(...heights), Math.max(...heights)];
const colourAt = (x: number, r: number): Vec3 => {
    const shade = 0.75 + 0.25 * (heightAt(x, r) - lowest) / (highest - lowest);
    return [(0.5 + 0.2 * Math.sin(x / 5)) * shade, (0.4 + 0.15 * Math.cos(r / 7)) * shade, (0.3 + 0.1 * Math.sin((x + r) / 9)) * shade];
};
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** A steady small wobble for a place and photo (the camera's noise). */
const noise = (i: number, k: number) => { let h = Math.imul(i * 374761393 + k * 668265263, 3266489917); h ^= h >>> 15; return ((h >>> 0) / 4294967295 - 0.5) * 0.006; };

const AZIMUTHS = [20, 110, 200, 290].map((degrees) => (degrees * Math.PI) / 180);
const ELEVATION = (40 * Math.PI) / 180;
const lights = AZIMUTHS.map((azimuth) => lightDirection(azimuth, ELEVATION));
const photos: CapturePhoto[] = lights.map((light, k) => {
    const rgb = new Float32Array(S * S * 3);
    for (let r = 0; r < S; r++) for (let x = 0; x < S; x++) {
        const n = trueNormal(x, r);
        const shade = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
        const colour = colourAt(x, r);
        for (let c = 0; c < 3; c++) rgb[(r * S + x) * 3 + c] = Math.min(1, Math.max(0, toSrgb(Math.max(0, colour[c] * shade + noise(r * S + x, k * 3 + c)))));
    }
    return { rgb };
});

const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * (180 / Math.PI);
const meanNormalError = (normal: Float32Array) => {
    let sum = 0;
    for (let r = 0; r < S; r++) for (let x = 0; x < S; x++) { const i = (r * S + x) * 3; sum += angleBetween([normal[i], normal[i + 1], normal[i + 2]], trueNormal(x, r)); }
    return sum / (S * S);
};
const correlation = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i] / n; mb += b[i] / n; }
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
    return { r: ab / Math.sqrt(aa * bb), ratio: Math.sqrt(aa / bb) };
};
const turnDifference = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI) * (180 / Math.PI);

describe('multi-angle capture', () => {
    it('works out each photo\'s light direction from the photos alone', () => {
        const estimate = estimateLightAzimuths(photos.map(linearBrightness), S, S);
        estimate.azimuths.forEach((azimuth, k) => expect(turnDifference(azimuth, AZIMUTHS[k])).toBeLessThan(10));
        expect(estimate.fit).toBeGreaterThan(0.8);
    });

    it('recovers the normal and the colour with the lights known', () => {
        const maps = photometricStereo(photos, lights, S, S);
        expect(meanNormalError(maps.normal)).toBeLessThan(2);
        // The colour has no light and shade left in it: it follows the surface's own colour.
        const albedoLuma = Array.from({ length: S * S }, (_, i) => maps.albedo[i * 3]);
        const truth = Array.from({ length: S * S }, (_, i) => toSrgb(colourAt(i % S, Math.floor(i / S))[0]));
        expect(correlation(albedoLuma, truth).r).toBeGreaterThan(0.98);
    });

    it('recovers the normal with the lights worked out', () => {
        const estimate = estimateLightAzimuths(photos.map(linearBrightness), S, S);
        const maps = photometricStereo(photos, estimate.azimuths.map((azimuth) => lightDirection(azimuth, ELEVATION)), S, S);
        expect(meanNormalError(maps.normal)).toBeLessThan(5);
    });

    it('integrates the recovered normal into the height it came from', () => {
        const maps = photometricStereo(photos, lights, S, S);
        const height = heightFromNormals(maps.normal, S, S, true);
        const match = correlation(height, heights);
        expect(match.r).toBeGreaterThan(0.98);
        expect(match.ratio).toBeGreaterThan(0.85);
        expect(match.ratio).toBeLessThan(1.15);
    });

    it('integrates slopes of a picture that does not tile, its edges free', () => {
        const bump = (x: number, r: number) => 6 * Math.exp(-((x - 20) ** 2 + (r - 40) ** 2) / 120) + 0.05 * x;
        const slopeX = new Float32Array(S * S), slopeY = new Float32Array(S * S), truth = new Float32Array(S * S);
        for (let r = 0; r < S; r++) for (let x = 0; x < S; x++) {
            const i = r * S + x;
            truth[i] = bump(x, r);
            slopeX[i] = (bump(x + 0.5, r) - bump(x - 0.5, r));
            slopeY[i] = -(bump(x, r + 0.5) - bump(x, r - 0.5));
        }
        expect(correlation(integrateSlopes(slopeX, slopeY, S, S, false), truth).r).toBeGreaterThan(0.99);
    });

    it('makes maps that tile, the height agreeing with the normal', () => {
        const maps = captureMaps(photos, lights, S, S);
        // Across the picture's edge the height steps no more than it does between neighbours inside.
        let edge = 0, inside = 0;
        for (let r = 0; r < S; r++) {
            edge += Math.abs(maps.heightMap[r * S] - maps.heightMap[r * S + S - 1]);
            inside += Math.abs(maps.heightMap[r * S + S / 2] - maps.heightMap[r * S + S / 2 - 1]);
        }
        expect(edge).toBeLessThan(inside * 2 + 0.05 * S);
        for (let i = 0; i < S * S; i++) expect(Math.hypot(maps.normal[i * 3], maps.normal[i * 3 + 1], maps.normal[i * 3 + 2])).toBeCloseTo(1, 4);
        expect(Math.min(...maps.heightMap)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...maps.heightMap)).toBeLessThanOrEqual(1);
    });

    it('builds a graph of ordinary nodes from the maps', () => {
        const graph = captureMaterialGraph({ colour: 'c', normal: 'n', height: 'h' }, 10);
        for (const link of graph.links) {
            const from = textureNodeDefinition(graph.nodes.find((node) => node.id === link.from)!, () => undefined)!;
            const to = textureNodeDefinition(graph.nodes.find((node) => node.id === link.to)!, () => undefined)!;
            expect(from.outputs.map((port) => port.key)).toContain(link.fromOutput);
            expect(to.inputs.map((port) => port.key)).toContain(link.toInput);
        }
        expect(graph.nodes.filter((node) => node.type === 'output').map((node) => node.params.channel).sort()).toEqual(['ambientOcclusion', 'baseColor', 'height', 'metallic', 'normal', 'roughness']);
        expect(graph.nodes.filter((node) => node.type === 'bitmap').map((node) => node.params.texture).sort()).toEqual(['c', 'h', 'n']);
        const back = readTextureGraph(JSON.parse(JSON.stringify(graph)));
        expect(back.problems).toEqual([]);
        expect(graph.parameters.map((parameter) => parameter.name)).toEqual(['normalStrength', 'depth', 'roughLow', 'roughHigh', 'metalColour', 'metalRange']);
    });
});

/** A wrapping Gaussian blur of a square picture of one value a pixel. */
const blurred = (values: Float32Array, side: number, sigma: number): Float32Array => {
    const reach = Math.ceil(sigma * 3);
    const weights = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const pass = (from: Float32Array, dx: number, dy: number) => {
        const out = new Float32Array(from.length);
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
            let sum = 0;
            for (let i = 0; i < weights.length; i++) sum += weights[i] * from[(((y + (i - reach) * dy) % side + side) % side) * side + (((x + (i - reach) * dx) % side) + side) % side];
            out[y * side + x] = sum / total;
        }
        return out;
    };
    return pass(pass(values, 1, 0), 0, 1);
};

/**
 * A brick wall as a capture would photograph it: bricks raised over recessed mortar, the mortar light and
 * a quarter of the bricks dark, so the parts dark on average are high (no shadow in the crevices). Lit from
 * the left, top, right and bottom, as photos would be; `broad` adds a slow swell to the height.
 */
const brickCapture = (side: number, broad = 0) => {
    const isMortar = (x: number, r: number) => r % 16 < 3 || (x + (Math.floor(r / 16) % 2) * 16) % 32 < 3;
    const isDark = (x: number, r: number) => (Math.floor((x + (Math.floor(r / 16) % 2) * 16) / 32) * 3 + Math.floor(r / 16)) % 4 === 0;
    const sharp = new Float32Array(side * side);
    for (let r = 0; r < side; r++) for (let x = 0; x < side; x++) sharp[r * side + x] = isMortar(x, r) ? 0 : 2;
    const relief = blurred(sharp, side, 1.2);
    const height = relief.map((value, i) => value + broad * Math.cos((TAU * (i % side)) / side) * Math.cos((TAU * Math.floor(i / side)) / side));
    const slope = (x: number, r: number): Vec3 => {
        const at = (px: number, pr: number) => height[(((pr % side) + side) % side) * side + (((px % side) + side) % side)];
        const sx = (at(x + 1, r) - at(x - 1, r)) / 2, sy = -(at(x, r + 1) - at(x, r - 1)) / 2;
        const l = Math.hypot(sx, sy, 1);
        return [-sx / l, -sy / l, 1 / l];
    };
    const azimuths = [180, 90, 0, 270].map((degrees) => (degrees * Math.PI) / 180);
    const shots = azimuths.map((azimuth, k) => {
        const light = lightDirection(azimuth, ELEVATION);
        const rgb = new Float32Array(side * side * 3);
        for (let r = 0; r < side; r++) for (let x = 0; x < side; x++) {
            const n = slope(x, r);
            const shade = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
            const colour = isMortar(x, r) ? [0.62, 0.6, 0.56] : isDark(x, r) ? [0.09, 0.04, 0.03] : [0.4, 0.14, 0.1];
            for (let c = 0; c < 3; c++) rgb[(r * side + x) * 3 + c] = Math.min(1, toSrgb(Math.max(0, colour[c] * shade + noise(r * side + x, k * 3 + c))));
        }
        return { rgb };
    });
    return { shots, azimuths, relief, lights: azimuths.map((azimuth) => lightDirection(azimuth, ELEVATION)) };
};

describe('multi-angle capture of a brick wall', () => {
    it('turns the lights the right way round where dark bricks stand above light mortar', () => {
        const wall = brickCapture(128);
        const estimate = estimateLightAzimuths(wall.shots.map(linearBrightness), 128, 128);
        estimate.azimuths.forEach((azimuth, k) => expect(turnDifference(azimuth, wall.azimuths[k])).toBeLessThan(15));
    });

    it('takes the broad drift out of the height and keeps the bricks', () => {
        const wall = brickCapture(128, 3);
        const maps = captureMaps(wall.shots, wall.lights, 128, 128);
        const spread = (values: Float32Array) => { const mean = values.reduce((sum, v) => sum + v, 0) / values.length; return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length); };
        // What is left at a scale wider than a brick is small beside the height's whole variation.
        expect(spread(blurred(maps.heightMap, 128, 16)) / spread(maps.heightMap)).toBeLessThan(0.25);
        // The bricks stand up and the mortar is sunk: the height follows the wall's own relief.
        expect(correlation(maps.heightMap, wall.relief).r).toBeGreaterThan(0.8);
    });

});
