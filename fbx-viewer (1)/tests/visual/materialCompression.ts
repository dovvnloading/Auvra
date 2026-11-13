import type { Texture } from 'three';
import type { TexturingGpu } from '../../texturing/gpu/texturingGpu';
import { textureFromCompressed } from '../../texturing/materialTextureLoader';
import { encodeLevel, type MaterialTextureFormat } from '../../utils/textureCompression/materialTextureEncoder';

/** One fixture for each format Auvra writes into saved material textures. */
const FEATURES = {
    bc4: { webgl2: 'EXT_texture_compression_rgtc', webgpu: 'texture-compression-bc' },
    bc5: { webgl2: 'EXT_texture_compression_rgtc', webgpu: 'texture-compression-bc' },
    bc7: { webgl2: 'EXT_texture_compression_bptc', webgpu: 'texture-compression-bc' },
    etc2: { webgl2: 'WEBGL_compressed_texture_etc', webgpu: 'texture-compression-etc2' },
    etc2a: { webgl2: 'WEBGL_compressed_texture_etc', webgpu: 'texture-compression-etc2' },
    astc: { webgl2: 'WEBGL_compressed_texture_astc', webgpu: 'texture-compression-astc' },
} as const satisfies Record<MaterialTextureFormat, { webgl2: string; webgpu: GPUFeatureName }>;

type Backend = 'webgl2' | 'webgpu';
type Feature = typeof FEATURES[MaterialTextureFormat][Backend];
type Result =
    | { feature: Feature; supported: false; status: 'not-tested' }
    | { feature: Feature; supported: true; status: 'verified' }
    | { feature: Feature; supported: true; status: 'failed'; reason: string };

const SIZE = 8;

/** Flat, block-aligned stripes. Vary alpha on formats which store it, and R/G independently. */
const stripe = (x: number) => x < 4 ? [255, 0, 0, 85] : [0, 255, 0, 170];

export function verifyMaterialPixels(format: MaterialTextureFormat, pixels: Uint8Array): void {
    if (pixels.length !== SIZE * SIZE * 4) throw new Error(`Incomplete ${format} readback (${pixels.length} bytes)`);
    for (let x = 0; x < SIZE; x++) {
        const expected = stripe(x);
        if (format === 'bc4') expected[1] = 0;
        if (format === 'bc4' || format === 'bc5' || format === 'etc2') expected[3] = 255;
        for (let y = 0; y < SIZE; y++) {
            for (let channel = 0; channel < 4; channel++) {
                const value = pixels[(y * SIZE + x) * 4 + channel];
                if (Math.abs(value - expected[channel]) > 4) {
                    throw new Error(`${format} pixel (${x}, ${y}) channel ${channel}: got ${value}, expected ${expected[channel]}`);
                }
            }
        }
    }
}

export async function checkMaterialCompression<B extends Backend>(
    backend: B,
    hasFeature: (feature: typeof FEATURES[MaterialTextureFormat][B]) => boolean,
    draw: (format: MaterialTextureFormat, texture: Texture) => Promise<Uint8Array>,
): Promise<Record<MaterialTextureFormat, Result>> {
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) rgba.set(stripe(x), (y * SIZE + x) * 4);
    }
    const results = {} as Record<MaterialTextureFormat, Result>;
    for (const format of Object.keys(FEATURES) as MaterialTextureFormat[]) {
        const feature = FEATURES[format][backend];
        if (!hasFeature(feature)) {
            results[format] = { feature, supported: false, status: 'not-tested' };
            continue;
        }
        let texture: Texture | undefined;
        try {
            const data = encodeLevel(rgba, SIZE, SIZE, format);
            texture = textureFromCompressed({
                format, width: SIZE, height: SIZE, levels: [{ data, width: SIZE, height: SIZE }],
            }, 'data', { filter: 'nearest' });
            verifyMaterialPixels(format, await draw(format, texture));
            results[format] = { feature, supported: true, status: 'verified' };
        } catch (error) {
            results[format] = { feature, supported: true, status: 'failed', reason: String(error instanceof Error ? error.message : error) };
        } finally {
            texture?.dispose();
        }
    }
    return results;
}

export async function readMaterialTexture(gpu: TexturingGpu, texture: Texture): Promise<Uint8Array> {
    const image = gpu.image(SIZE, SIZE, 'color', 8);
    try {
        await gpu.pass(image, { fragment: 'void main() { outColor = texture(picture, vUv); }', inputs: { picture: texture } });
        const rgba = await gpu.readRgba8Later(image);
        if (!rgba) throw new Error('Could not read sampled material texture');
        return rgba;
    } finally {
        gpu.release(image);
    }
}
