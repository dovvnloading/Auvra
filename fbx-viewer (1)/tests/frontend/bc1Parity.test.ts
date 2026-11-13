import { describe, expect, it, vi } from 'vitest';
import { checkBc1Parity, compareBc1Pixels } from '../visual/bc1Parity';

const both = { webgpuBC: true, webgl2S3TC: true };

describe('BC1 visual parity evidence', () => {
    it.each([
        [false, true, 'Missing texture-compression-bc'],
        [true, false, 'Missing WEBGL_compressed_texture_s3tc'],
        [false, false, 'Missing texture-compression-bc and WEBGL_compressed_texture_s3tc'],
    ] as const)('records the missing capabilities when WebGPU BC=%s and WebGL2 S3TC=%s', async (webgpuBC, webgl2S3TC, reason) => {
        const compare = vi.fn();
        expect(await checkBc1Parity({ webgpuBC, webgl2S3TC }, compare)).toEqual({ webgpuBC, webgl2S3TC, status: 'not-tested', reason });
        expect(compare).not.toHaveBeenCalled();
    });

    it('verifies the four sampled pixels only after each backend draws the expected stripes', async () => {
        const pixels = new Uint8Array(8 * 8 * 4);
        for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) pixels[(y * 8 + x) * 4 + (x < 4 ? 0 : 1)] = 255;
        const webgpu = pixels.slice();
        const compare = () => Promise.resolve(compareBc1Pixels(webgpu, pixels));
        expect(await checkBc1Parity(both, compare)).toEqual({ ...both, status: 'verified' });
        webgpu[(6 * 8 + 6) * 4 + 1] = 0;
        expect(await checkBc1Parity(both, compare)).toMatchObject({ ...both, status: 'failed', reason: expect.stringContaining('(6, 6)') });
        pixels.fill(0);
        webgpu.fill(0);
        expect(await checkBc1Parity(both, compare)).toMatchObject({ status: 'failed' });
    });
});
