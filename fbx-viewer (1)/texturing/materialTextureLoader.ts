import * as THREE from 'three';
import { limitPictureSize, pictureToHalf, pictureToRgba8, type DecodedPicture } from './textureDecode';
import { decodePictureOffPage, encodeTextureOffPage } from './texturePipeline';
import { keptFormat, textureRole, wholeFormat, textureSettingsOf, type CompressionSupport, type KeptFormat } from './textureSettings';
import { gpuExtensions } from '../utils/textureCompression/compressTextures';
import type { MaterialTextureFormat } from '../utils/textureCompression/materialTextureEncoder';
import { compressionSignature, packCompressed, unpackCompressed, type CompressedPicture } from './compressedContainer';
import { textureSourceAssetOf, type TextureRole, type TextureSettings } from './textureSettings';

/**
 * MATERIAL TEXTURES FROM THEIR FILES
 *
 * How the material library makes a texture for a graph: the file decoded at its own depth (off the page),
 * scaled down to its size limit, then compressed for its role where the GPU can take it (BC7 colour, BC5
 * normals, BC4 single channels, with Kaiser mip levels; ASTC or ETC2 on phones), or kept whole as 8-bit or
 * half floats. The editor also keeps each texture's phone versions, so built games carry them. Its wrap,
 * filter, mips and colour space come from its settings (textureSettings.ts).
 */

export interface MaterialTextureRequest {
    textureId: string;
    slot: 'map' | 'normal' | 'data';
    flipY: boolean;
}

/** What marks a texture this loader set up, so the library leaves its settings alone. */
export const SET_UP_KEY = 'auvraTextureSettings';

const COMPRESSED_FORMATS: Record<MaterialTextureFormat, THREE.CompressedPixelFormat> = {
    bc7: THREE.RGBA_BPTC_Format,
    bc5: THREE.RED_GREEN_RGTC2_Format,
    // Signed: three r164 cannot upload unsigned BC4 (materialTextureEncoder.ts).
    bc4: THREE.SIGNED_RED_RGTC1_Format,
    astc: THREE.RGBA_ASTC_4x4_Format,
    etc2: THREE.RGB_ETC2_Format,
    etc2a: THREE.RGBA_ETC2_EAC_Format,
};

const WRAPS = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping } as const;

let support: CompressionSupport | null = null;

/** Which compressed formats this device's GPU samples (asked once). */
export const compressionSupport = (): CompressionSupport => {
    if (!support) {
        const extensions = gpuExtensions();
        support = {
            bptc: extensions.has('EXT_texture_compression_bptc'),
            rgtc: extensions.has('EXT_texture_compression_rgtc'),
            astc: extensions.has('WEBGL_compressed_texture_astc'),
            etc2: extensions.has('WEBGL_compressed_texture_etc'),
        };
    }
    return support;
};

/** Rows turned over, so a picture read from the top lies the way three's flipY would lay it. */
const flipped = <T extends Uint8Array | Uint16Array>(data: T, width: number, height: number): T => {
    const row = width * 4;
    const out = new (data.constructor as new (length: number) => T)(data.length);
    for (let y = 0; y < height; y++) out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out;
};

/** A sized picture's 8-bit pixels as they are compressed or uploaded: sRGB-encoded floating-point colour, DirectX green turned over, laid the right way up. */
const preparedBytes = (sized: DecodedPicture, request: MaterialTextureRequest, role: TextureRole, flipGreen: boolean): Uint8Array => {
    // Floating-point colour is encoded to sRGB, as the colour formats read it.
    const bytes = pictureToRgba8(sized, sized.depth === 32 && role === 'colour');
    // A DirectX normal map's green points down: turned over so it reads as the others do.
    if (flipGreen) for (let i = 1; i < bytes.length; i += 4) bytes[i] = 255 - bytes[i];
    return request.flipY ? flipped(bytes, sized.width, sized.height) : bytes;
};

/** A texture made from a decoded picture as its settings and role say (exported for the tests). */
export const textureFromPicture = async (
    picture: DecodedPicture, request: MaterialTextureRequest, compress: boolean, support: CompressionSupport = compressionSupport(),
): Promise<{ texture: THREE.Texture; format: KeptFormat }> => {
    const settings = textureSettingsOf(request.textureId);
    const sized = limitPictureSize(picture, settings?.maxSize);
    const { width, height } = sized;
    const role = textureRole(request.slot, settings);
    const format = compress ? keptFormat(role, settings, support, sized) : wholeFormat(sized);
    const mips = settings?.mips !== false;
    let texture: THREE.Texture;
    if (format !== 'half' && format !== 'rgba8') {
        const levels = await encodeTextureOffPage(preparedBytes(sized, request, role, settings?.flipGreen === true), width, height, format, role === 'colour' ? 'colour' : role, mips);
        texture = new THREE.CompressedTexture(levels as unknown as ImageData[], width, height, COMPRESSED_FORMATS[format]);
        texture.generateMipmaps = false;
        texture.minFilter = levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    } else if (format === 'half') {
        const half = pictureToHalf(sized);
        texture = new THREE.DataTexture(request.flipY ? flipped(half, width, height) : half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
        // Half floats are not filtered into mip levels here.
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
    } else {
        texture = new THREE.DataTexture(preparedBytes(sized, request, role, settings?.flipGreen === true), width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.generateMipmaps = mips;
        texture.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    }
    setUp(texture, role, format, settings);
    return { texture, format };
};

/** A texture's colour space, wrap and filter from its settings, marked as set up. */
const setUp = (texture: THREE.Texture, role: TextureRole, format: KeptFormat, settings: TextureSettings | undefined): void => {
    // Colour pictures are decoded from sRGB; floating-point light, normals and data are read as stored.
    texture.colorSpace = role === 'colour' && format !== 'half' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const wrap = WRAPS[settings?.wrap ?? 'repeat'];
    texture.wrapS = wrap;
    texture.wrapT = wrap;
    if (settings?.filter === 'nearest') {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = texture.minFilter === THREE.LinearFilter ? THREE.NearestFilter : THREE.NearestMipmapNearestFilter;
    } else {
        texture.anisotropy = 8;
    }
    texture.userData[SET_UP_KEY] = true;
    texture.needsUpdate = true;
};

/** A texture from blocks kept in the project. */
export const textureFromCompressed = (picture: CompressedPicture, role: TextureRole, settings: TextureSettings | undefined): THREE.Texture => {
    const texture = new THREE.CompressedTexture(picture.levels as unknown as ImageData[], picture.width, picture.height, COMPRESSED_FORMATS[picture.format]);
    texture.generateMipmaps = false;
    texture.minFilter = picture.levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    setUp(texture, role, picture.format, settings);
    return texture;
};

let projectLoader: ((url: string, request?: MaterialTextureRequest) => Promise<THREE.Texture>) | null = null;
let projectCache: CompressedTextureCache | null = null;

/** The open project's store of compressed blocks (set as it loads), for what compresses outside material textures: terrain arrays. */
export const setProjectCompressedCache = (cache: CompressedTextureCache | null): void => { projectCache = cache; };
export const projectCompressedCache = (): CompressedTextureCache | null => projectCache;

/** The open project's texture loader (set as it loads), for textures outside material assets: decals. */
export const setProjectTextureLoader = (loader: typeof projectLoader): void => { projectLoader = loader; };

/** Loads a project texture the way the open project does, or as a plain picture before one has opened. */
export const loadProjectTexture = (url: string, request: MaterialTextureRequest): Promise<THREE.Texture> =>
    (projectLoader ?? createMaterialTextureLoader({ compress: false }))(url, request);

/**
 * Where compressed textures are kept: found by signature (in the project, or a built game), and kept
 * there once made (only where the project can be written, the editor).
 */
export interface CompressedTextureCache {
    find(textureId: string, signature: string): Promise<Uint8Array | null>;
    keep?(textureId: string, signature: string, packed: Uint8Array): Promise<void>;
}

/**
 * The material library's loader: `compress` off (the game's quality settings) keeps every texture whole.
 * With a cache, a texture compressed before loads its kept blocks instead of being compressed again.
 */
/** Phone versions waiting to be made, one at a time, behind what is being drawn. */
let phoneQueue: Promise<void> = Promise.resolve();

type KeepingCache = CompressedTextureCache & { keep: NonNullable<CompressedTextureCache['keep']> };

/**
 * Keeps a texture's versions for other graphics cards (phones: ASTC, ETC2) under their own signatures, where
 * none is kept yet, so built games carry the format each device needs. Made one at a time, in the background.
 */
const keepOtherVersions = (picture: DecodedPicture, request: MaterialTextureRequest, source: string, supports: readonly CompressionSupport[], cache: KeepingCache): Promise<void> => {
    const settings = textureSettingsOf(request.textureId);
    const role = textureRole(request.slot, settings);
    const sized = limitPictureSize(picture, settings?.maxSize);
    const mips = settings?.mips !== false;
    for (const support of supports) {
        phoneQueue = phoneQueue.then(async () => {
            const format = keptFormat(role, settings, support, sized);
            if (format === 'rgba8' || format === 'half') return;
            const signature = compressionSignature(source, role, settings, request.flipY, support);
            if (await cache.find(request.textureId, signature).catch(() => null)) return;
            const levels = await encodeTextureOffPage(preparedBytes(sized, request, role, settings?.flipGreen === true), sized.width, sized.height, format, role === 'colour' ? 'colour' : role, mips);
            await cache.keep(request.textureId, signature, packCompressed({ format, width: sized.width, height: sized.height, levels }));
        }).catch(() => undefined);
    }
    return phoneQueue;
};

/** Settles once every phone version asked for so far is kept (tests). */
export const phoneVersionsKept = (): Promise<void> => phoneQueue;

export const createMaterialTextureLoader = (options: { compress: boolean; cache?: CompressedTextureCache; support?: CompressionSupport; alsoKeepFor?: readonly CompressionSupport[] }) => async (url: string, request?: MaterialTextureRequest): Promise<THREE.Texture> => {
    const support = options.support ?? compressionSupport();
    const asked = request ?? { textureId: '', slot: 'map' as const, flipY: true };
    const settings = textureSettingsOf(asked.textureId);
    const role = textureRole(asked.slot, settings);
    const source = textureSourceAssetOf(asked.textureId);
    const signature = options.compress && options.cache && source ? compressionSignature(source, role, settings, asked.flipY, support) : null;
    if (signature) {
        const kept = await options.cache!.find(asked.textureId, signature).catch(() => null);
        const picture = kept ? unpackCompressed(kept) : null;
        if (picture) return textureFromCompressed(picture, role, settings);
    }
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const picture = await decodePictureOffPage(bytes);
    const { texture, format } = await textureFromPicture(picture, asked, options.compress, support);
    if (signature && options.cache?.keep && texture instanceof THREE.CompressedTexture && format !== 'rgba8' && format !== 'half') {
        const levels = texture.mipmaps as unknown as Array<{ data: Uint8Array; width: number; height: number }>;
        const packed = packCompressed({ format, width: levels[0].width, height: levels[0].height, levels });
        // Kept for next time; a failure (a read-only project) only means compressing again then.
        void options.cache.keep(asked.textureId, signature, packed).catch(() => undefined);
    }
    // Its versions for phones are kept as well (in the editor), behind what is being drawn.
    if (options.compress && options.alsoKeepFor?.length && options.cache?.keep && source) {
        void keepOtherVersions(picture, asked, source, options.alsoKeepFor, options.cache as KeepingCache);
    }
    return texture;
};
