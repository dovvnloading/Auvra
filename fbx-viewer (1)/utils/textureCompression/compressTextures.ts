import * as THREE from 'three';
import type { BlockFormat } from './bcEncoder';
import type { CompressResponse, TextureKind } from '../../workers/textureCompress.worker';

/**
 * GPU TEXTURE COMPRESSION
 *
 * A loaded model's colour and material maps are swapped for BC-compressed textures (an eighth of
 * the memory for BC1, a quarter for BC3 when the texture has alpha) with their full mip chains,
 * compressed in workers and cached by the pixels' hash so each texture is compressed once. Normal
 * maps become BC5 (their two angles, a quarter of the memory), and their materials rebuild the
 * third component in the shader. Where the GPU cannot sample BC textures, or a texture's sides are
 * not powers of two, the texture is left alone.
 */

/** Changing the encoder changes this, so textures cached by an older encoder are made again. */
export const TEXTURE_COMPRESSION_VERSION = 1;

/** Material slots compressed, and what each holds. */
const COMPRESSED_SLOTS: readonly { key: string; kind: TextureKind }[] = [
    { key: 'map', kind: 'colour' },
    { key: 'emissiveMap', kind: 'colour' },
    { key: 'aoMap', kind: 'data' },
    { key: 'roughnessMap', kind: 'data' },
    { key: 'metalnessMap', kind: 'data' },
    { key: 'normalMap', kind: 'normal' },
];
/** Textures smaller than this on a side are left as they are. */
const MIN_COMPRESSED_SIZE = 64;

/** Each compressed texture's source image, for editor tools that read a texture's pixels. */
const sourceImages = new WeakMap<THREE.Texture, unknown>();

/**
 * The image a texture was made from: its own, or the source of a texture compressed here. A texture
 * that arrived compressed (a model's Basis textures) has no image to read, only GPU blocks.
 */
export const textureSourceImage = (texture: THREE.Texture): unknown =>
    sourceImages.get(texture) ?? ((texture as THREE.CompressedTexture).isCompressedTexture ? null : texture.image);

let extensions: ReadonlySet<string> | null = null;
/** The WebGL extensions this device offers, the compressed texture formats among them, probed once. */
export const gpuExtensions = (): ReadonlySet<string> => {
    if (extensions) return extensions;
    extensions = new Set();
    try {
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        if (gl) {
            extensions = new Set(gl.getSupportedExtensions() ?? []);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        extensions = new Set();
    }
    return extensions;
};

/** Whether this device's GPU samples BC1/BC3 textures (in sRGB as well as linear), and BC5 for normal maps. */
export const blockCompressionSupport = (): { colour: boolean; normal: boolean } => {
    const offered = gpuExtensions();
    return {
        colour: offered.has('WEBGL_compressed_texture_s3tc') && offered.has('WEBGL_compressed_texture_s3tc_srgb'),
        normal: offered.has('EXT_texture_compression_rgtc'),
    };
};

/** The shader line that reads a tangent-space normal, and its replacement that rebuilds z from a two-channel (BC5) map. */
export const NORMAL_READ = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;';
const NORMAL_REBUILD = 'vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0, 0.0 ); mapN.z = sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) );';
const rebuildsNormals = new WeakSet<THREE.Material>();

/**
 * Makes `material` rebuild its normal map's third component from the first two, as a BC5 normal map
 * keeps only those. It gives the same result for a full normal map, so it stays if the map changes.
 */
const rebuildNormalZ = (material: THREE.Material): void => {
    if (rebuildsNormals.has(material)) return;
    rebuildsNormals.add(material);
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        previous.call(material, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_READ, NORMAL_REBUILD));
    };
    const previousKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${previousKey()}|normal-rg`;
    material.needsUpdate = true;
};

const isPowerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;

type CompressResult = { format: BlockFormat; levels: { data: ArrayBuffer; width: number; height: number }[]; cached: boolean };

/** A small pool of compression workers, shared by every load. */
const pool = (() => {
    const workers: Worker[] = [];
    const idle: Worker[] = [];
    const queue: ((worker: Worker) => void)[] = [];
    const pending = new Map<number, { resolve: (result: CompressResult) => void; reject: (error: Error) => void; worker: Worker }>();
    let nextId = 1;
    const size = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4) - 1));
    // A finished worker goes straight to the next waiting job, else back to the idle list.
    const release = (worker: Worker) => {
        const next = queue.shift();
        if (next) next(worker);
        else idle.push(worker);
    };
    const acquire = (): Promise<Worker> => new Promise((resolve) => {
        const worker = idle.pop();
        if (worker) { resolve(worker); return; }
        if (workers.length < size) {
            const created = new Worker(new URL('../../workers/textureCompress.worker.ts', import.meta.url), { type: 'module' });
            created.onmessage = (event: MessageEvent<CompressResponse>) => {
                const job = pending.get(event.data.id);
                if (!job) return;
                pending.delete(event.data.id);
                if ('error' in event.data) job.reject(new Error(event.data.error));
                else job.resolve(event.data);
                release(job.worker);
            };
            workers.push(created);
            resolve(created);
            return;
        }
        queue.push(resolve);
    });
    return {
        compress: async (bitmap: ImageBitmap, kind: TextureKind, flipY: boolean): Promise<CompressResult> => {
            const worker = await acquire();
            const id = nextId++;
            return new Promise<CompressResult>((resolve, reject) => {
                pending.set(id, { resolve, reject, worker });
                worker.postMessage({ id, bitmap, kind, flipY, version: TEXTURE_COMPRESSION_VERSION }, [bitmap]);
            });
        },
    };
})();

/** The compressed texture standing in for `texture`, keeping how it is sampled and placed. */
const compressedTexture = (texture: THREE.Texture, result: CompressResult): THREE.CompressedTexture => {
    const levels = result.levels.map(level => ({ data: new Uint8Array(level.data), width: level.width, height: level.height }));
    const format = result.format === 'bc5' ? THREE.RED_GREEN_RGTC2_Format : result.format === 'bc3' ? THREE.RGBA_S3TC_DXT5_Format : THREE.RGB_S3TC_DXT1_Format;
    const compressed = new THREE.CompressedTexture(levels as unknown as ImageData[], levels[0].width, levels[0].height, format, THREE.UnsignedByteType);
    compressed.name = texture.name;
    compressed.wrapS = texture.wrapS;
    compressed.wrapT = texture.wrapT;
    compressed.repeat.copy(texture.repeat);
    compressed.offset.copy(texture.offset);
    compressed.center.copy(texture.center);
    compressed.rotation = texture.rotation;
    compressed.channel = texture.channel;
    compressed.colorSpace = result.format === 'bc5' ? THREE.NoColorSpace : texture.colorSpace;
    compressed.anisotropy = texture.anisotropy;
    compressed.magFilter = texture.magFilter;
    compressed.minFilter = THREE.LinearMipmapLinearFilter;
    compressed.generateMipmaps = false;
    compressed.flipY = false;
    compressed.userData = { ...texture.userData };
    compressed.needsUpdate = true;
    return compressed;
};

export interface TextureCompressionReport {
    compressed: number;
    cached: number;
    skipped: number;
    /** GPU bytes of the textures before and after, mip chains included. */
    bytesBefore: number;
    bytesAfter: number;
}

/**
 * Swaps the colour and material maps of every material under `root` for BC-compressed textures,
 * shared textures once. Does nothing where the GPU cannot sample BC textures.
 */
export const compressModelTextures = async (root: THREE.Object3D): Promise<TextureCompressionReport> => {
    const report: TextureCompressionReport = { compressed: 0, cached: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };
    const supported = typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined' ? blockCompressionSupport() : { colour: false, normal: false };
    if (!supported.colour && !supported.normal) return report;
    // Each texture with every material slot that uses it.
    const uses = new Map<THREE.Texture, { kind: TextureKind; slots: { material: THREE.Material; key: string }[] }>();
    root.traverse((node) => {
        const material = (node as THREE.Mesh).material;
        if (!material) return;
        for (const candidate of Array.isArray(material) ? material : [material]) {
            for (const { key, kind } of COMPRESSED_SLOTS) {
                if (!(kind === 'normal' ? supported.normal : supported.colour)) continue;
                // Only tangent-space normal maps (the default) are read as two angles.
                if (kind === 'normal' && (candidate as THREE.MeshStandardMaterial).normalMapType === THREE.ObjectSpaceNormalMap) continue;
                const texture = (candidate as unknown as Record<string, THREE.Texture | null | undefined>)[key];
                if (!texture?.isTexture || (texture as THREE.CompressedTexture).isCompressedTexture || (texture as THREE.DataTexture).isDataTexture) continue;
                const entry = uses.get(texture) ?? { kind, slots: [] };
                entry.slots.push({ material: candidate, key });
                uses.set(texture, entry);
            }
        }
    });
    await Promise.all([...uses].map(async ([texture, { kind, slots }]) => {
        const image = texture.image as { width?: number; height?: number } | null;
        const width = image?.width ?? 0;
        const height = image?.height ?? 0;
        if (!image || !isPowerOfTwo(width) || !isPowerOfTwo(height) || Math.min(width, height) < MIN_COMPRESSED_SIZE) {
            report.skipped++;
            return;
        }
        try {
            const bitmap = await createImageBitmap(image as ImageBitmapSource);
            const result = await pool.compress(bitmap, kind === 'colour' && texture.colorSpace !== THREE.SRGBColorSpace ? 'data' : kind, texture.flipY);
            const compressed = compressedTexture(texture, result);
            sourceImages.set(compressed, sourceImages.get(texture) ?? texture.image);
            for (const { material, key } of slots) {
                (material as unknown as Record<string, THREE.Texture>)[key] = compressed;
                if (result.format === 'bc5') rebuildNormalZ(material);
            }
            report.bytesBefore += Math.round(width * height * 4 * 4 / 3);
            report.bytesAfter += result.levels.reduce((sum, level) => sum + level.data.byteLength, 0);
            report.compressed++;
            if (result.cached) report.cached++;
            texture.dispose();
        } catch {
            report.skipped++;
        }
    }));
    return report;
};
