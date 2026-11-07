import { describe, expect, it } from 'vitest';
import { compressionAdvice } from '../../texturing/compressionAdvice';

const SIZE = 64;

const picture = (fill: (x: number, y: number) => [number, number, number]): Uint8Array => {
    const out = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) out.set([...fill(x, y), 255], (y * SIZE + x) * 4);
    return out;
};

describe('where compression hurts', () => {
    it('says nothing of a picture that compresses well', () => {
        const flat = picture(() => [120, 90, 60]);
        expect(compressionAdvice(flat, SIZE, SIZE, 'colour', 'bc7').problem).toBeUndefined();
        const level = picture(() => [128, 128, 255]);
        expect(compressionAdvice(level, SIZE, SIZE, 'normal', 'bc5').problem).toBeUndefined();
    });

    it('finds sharp normal detail softened, with keeping it uncompressed as the fix', () => {
        // Facets turning hard every pixel: a block holds directions it cannot all keep.
        const sharp = picture((x, y) => {
            const nx = Math.sin(x * 2.3 + y * 0.7) * 0.9;
            const ny = Math.cos(y * 1.9 - x * 0.4) * 0.9;
            return [Math.round((nx * 0.5 + 0.5) * 255), Math.round((ny * 0.5 + 0.5) * 255), 255];
        });
        const advice = compressionAdvice(sharp, SIZE, SIZE, 'normal', 'etc2');
        expect(advice.problem).toMatch(/Sharp normal detail softens/);
        expect(advice.fix).toBe('uncompressed');
    });

    it('finds banding in smooth gradients, and offers the size limit when that is what shrank it', () => {
        // A gentle gradient with unrelated hues inside each block: smooth, but more than one line of colour.
        const gentle = picture((x, y) => [100 + ((x * 7 + y * 3) % 20), 100 + ((x * 3 + y * 11) % 20), 100 + ((x * 13 + y * 5) % 20)]);
        const advice = compressionAdvice(gentle, SIZE, SIZE, 'colour', 'etc2');
        expect(advice.problem).toMatch(/Smooth gradients band/);
        expect(advice.fix).toBe('uncompressed');
        expect(compressionAdvice(gentle, SIZE, SIZE, 'colour', 'etc2', true).fix).toBe('raiseLimit');
    });
});
