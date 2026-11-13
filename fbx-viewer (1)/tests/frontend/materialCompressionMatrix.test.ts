import { describe, expect, it, vi } from 'vitest';
import type { CompressedTexture } from 'three';
import { decodeLevel } from '../../utils/textureCompression/materialTextureEncoder';
import { checkMaterialCompression } from '../visual/materialCompression';

describe('material texture backend evidence', () => {
    it('checks all six saved formats and raw RGBA channel semantics against the stripe fixture', async () => {
        const results = await checkMaterialCompression('webgpu', () => true, async (format, texture) => {
            // The software preview reconstructs blue for normal maps and displays single-channel masks as grey.
            // The shader samples the stored R or RG, with zero in the missing colour channels.
            const compressed = texture as CompressedTexture;
            const pixels = decodeLevel(new Uint8Array(compressed.mipmaps[0].data), 8, 8, format);
            for (let i = 0; i < pixels.length; i += 4) {
                if (format === 'bc4') pixels[i + 1] = 0;
                if (format === 'bc4' || format === 'bc5') pixels[i + 2] = 0;
            }
            return pixels;
        });
        expect(Object.keys(results).sort()).toEqual(['astc', 'bc4', 'bc5', 'bc7', 'etc2', 'etc2a']);
        for (const result of Object.values(results)) expect(result).toMatchObject({ supported: true, status: 'verified' });
    });

    it('records the active backend feature, skips missing formats and continues after individual failures', async () => {
        const dispose = vi.fn();
        const sampled: string[] = [];
        const results = await checkMaterialCompression('webgl2', feature => feature === 'WEBGL_compressed_texture_etc', async (format, texture) => {
            sampled.push(format);
            texture.addEventListener('dispose', dispose);
            if (format === 'etc2') throw new Error('draw failed');
            return new Uint8Array(8 * 8 * 4);
        });
        expect(sampled).toEqual(['etc2', 'etc2a']);
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(results.etc2).toMatchObject({ status: 'failed', reason: 'draw failed' });
        expect(results.etc2a).toMatchObject({ status: 'failed', reason: expect.stringContaining('pixel (0, 0) channel 0') });
        expect(results.astc).toEqual({ status: 'not-tested', supported: false, feature: 'WEBGL_compressed_texture_astc' });
        expect(results.bc7).toEqual({ status: 'not-tested', supported: false, feature: 'EXT_texture_compression_bptc' });
    });
});
