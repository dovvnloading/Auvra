import { describe, expect, it } from 'vitest';
import { decodeGarmentCache, encodeGarmentCache, sampleGarmentCache, type GarmentCacheFrame } from '../../runtime/garments/cache';

const frames: GarmentCacheFrame[] = [0, 1, 2].map(n => ({
    positions: new Float32Array([-.5 + n * .05, 1.125, n * .375, .25 + n * .075, 1.125, -.34 * n]),
    torso: [n * .03, 1.25, -.15 * n],
}));

describe('fixed-topology fitting cache', () => {
    it('round trips frame endpoints, a constant axis and moving torso within half a quantization step', () => {
        const bytes = encodeGarmentCache(frames, 30), cache = decodeGarmentCache(bytes, 2);
        const out = new Float32Array(6), torso: [number, number, number] = [0, 0, 0];
        expect(cache.frameCount).toBe(3);
        expect(cache.duration).toBe(2 / 30);
        expect(cache.quantum[1]).toBe(0);
        expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4))).toBe('AUVC');
        for (let i = 0; i < frames.length; i++) {
            sampleGarmentCache(cache, i / 30, out, torso);
            for (let j = 0; j < out.length; j++)
                expect(Math.abs(out[j] - frames[i].positions[j])).toBeLessThanOrEqual(cache.quantum[j % 3] / 2 + 1e-7);
            expect(out[1]).toBe(1.125);
            expect(torso).toEqual(frames[i].torso.map(Math.fround));
        }
    });

    it('interpolates position and body at the same fraction, and clamps negative and late times', () => {
        const cache = decodeGarmentCache(encodeGarmentCache(frames, 24), 2);
        const out = new Float32Array(6), torso: [number, number, number] = [0, 0, 0];
        sampleGarmentCache(cache, .5 / 24, out, torso);
        for (let j = 0; j < out.length; j++) expect(out[j]).toBeCloseTo((frames[0].positions[j] + frames[1].positions[j]) / 2, 4);
        expect(torso[2]).toBeCloseTo(-.075);
        sampleGarmentCache(cache, -2, out, torso);
        expect(out[0]).toBeCloseTo(frames[0].positions[0]);
        sampleGarmentCache(cache, 1000, out, torso);
        expect(out[0]).toBeCloseTo(frames[2].positions[0]);
        expect(torso[0]).toBeCloseTo(.06);
        expect(() => sampleGarmentCache(cache, NaN, out, torso)).toThrow(/finite/);
        expect(() => sampleGarmentCache(cache, 0, new Float32Array(3), torso)).toThrow(/dimensions/);
    });

    it('handles a one-frame bake and unaligned input offsets, with owned decoded arrays', () => {
        const bytes = new Uint8Array(encodeGarmentCache([frames[0]], 60));
        const wrapped = new Uint8Array(bytes.length + 7);
        wrapped.set(bytes, 3);
        const cache = decodeGarmentCache(wrapped.subarray(3, 3 + bytes.length), 2);
        wrapped.fill(0);
        const out = new Float32Array(6);
        sampleGarmentCache(cache, 100, out, [0, 0, 0]);
        expect(cache.duration).toBe(0);
        expect(out.every((v, i) => v === frames[0].positions[i])).toBe(true);
    });

    it('validates counts, frame rate, size, axis range, torso finiteness and encoding compatibility', () => {
        const bytes = encodeGarmentCache(frames, 30);
        expect(() => decodeGarmentCache(bytes, 12)).toThrow(/current cook/);
        expect(() => decodeGarmentCache(bytes.slice(0, -2), 2)).toThrow(/length/);
        expect(() => decodeGarmentCache(bytes.slice(0, 24), 2)).toThrow(/size/);
        for (const [offset, value] of [[0, 0], [4, 8], [12, 3601], [8, 8193], [16, 0], [18, 1], [20, 999]]) {
            const altered = bytes.slice(0);
            new DataView(altered).setUint16(offset, value, true);
            expect(() => decodeGarmentCache(altered, 2)).toThrow();
        }
        for (const offset of [24, 36, 48]) {
            const altered = bytes.slice(0);
            new DataView(altered).setFloat32(offset, NaN, true);
            expect(() => decodeGarmentCache(altered, 2)).toThrow(/bounds|torso/);
        }
        const inverted = bytes.slice(0);
        new DataView(inverted).setFloat32(36, -2, true);
        expect(() => decodeGarmentCache(inverted, 2)).toThrow(/bounds/);
        expect(() => encodeGarmentCache([], 30)).toThrow(/frame count/);
        expect(() => encodeGarmentCache(frames, 29.5)).toThrow(/rate/);
        expect(() => encodeGarmentCache([frames[0], { ...frames[0], positions: new Float32Array(3) }], 30)).toThrow(/vertex count/);
        expect(() => encodeGarmentCache([{ ...frames[0], positions: new Float32Array([1, Infinity, 0]) }], 30)).toThrow(/finite/);
        expect(() => encodeGarmentCache([{ ...frames[0], torso: [1e200, 0, 0] }], 30)).toThrow(/finite/);
        const large = { ...frames[0], positions: new Float32Array(8192 * 3) };
        expect(() => encodeGarmentCache(Array(2000).fill(large), 60)).toThrow(/64 MiB/);
    });
});
