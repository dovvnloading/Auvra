import * as THREE from 'three';
import { limitPictureSize, pictureToHalf, pictureToRgba8, type DecodedPicture } from './textureDecode';
import { decodePictureOffPage, encodeTextureOffPage } from './texturePipeline';
import { keptFormat, textureRole, wholeFormat, textureSettingsOf, type CompressionSupport, type KeptFormat } from './textureSettings';
import { gpuExtensions } from '../utils/textureCompression/compressTextures';
import type { MaterialTextureFormat } from '../utils/textureCompression/materialTextureEncoder';

/**
 * MATERIAL TEXTURES FROM THEIR FILES
 *
 * How the material library makes a texture for a graph: the file decoded at its own depth (off the page),
 * scaled down to its size limit, then compressed for its role where the GPU can take it (BC7 colour, BC5
 * normals, BC4 single channels, with Kaiser mip levels), or kept whole as 8-bit or half floats. Its wrap,
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
};

const WRAPS = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping } as const;

let support: CompressionSupport | null = null;

/** Which compressed formats this device's GPU samples (asked once). */
export const compressionSupport = (): CompressionSupport => {
    if (!support) {
        const extensions = gpuExtensions();
        support = { bptc: extensions.has('EXT_texture_compression_bptc'), rgtc: extensions.has('EXT_texture_compression_rgtc') };
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

/** A texture made from a decoded picture as its settings and role say (exported for the tests). */
export const textureFromPicture = async (picture: DecodedPicture, request: MaterialTextureRequest, compress: boolean): Promise<{ texture: THREE.Texture; format: KeptFormat }> => {
    const settings = textureSettingsOf(request.textureId);
    const sized = limitPictureSize(picture, settings?.maxSize);
    const { width, height } = sized;
    const role = textureRole(request.slot, settings);
    const format = compress ? keptFormat(role, settings, compressionSupport(), sized) : wholeFormat(sized);
    const mips = settings?.mips !== false;
    let texture: THREE.Texture;
    if (format === 'half') {
        const half = pictureToHalf(sized);
        texture = new THREE.DataTexture(request.flipY ? flipped(half, width, height) : half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
        // Half floats are not filtered into mip levels here.
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
    } else {
        // Floating-point colour is encoded to sRGB, as the colour formats read it.
        const bytes = pictureToRgba8(sized, sized.depth === 32 && role === 'colour');
        const rgba = request.flipY ? flipped(bytes, width, height) : bytes;
        if (format === 'rgba8') {
            texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
            texture.generateMipmaps = mips;
            texture.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        } else {
            const levels = await encodeTextureOffPage(rgba, width, height, format, role === 'colour' ? 'colour' : role, mips);
            texture = new THREE.CompressedTexture(levels as unknown as ImageData[], width, height, COMPRESSED_FORMATS[format]);
            texture.generateMipmaps = false;
            texture.minFilter = levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        }
    }
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
    return { texture, format };
};

/** The material library's loader: `compress` off (the game's quality settings) keeps every texture whole. */
export const createMaterialTextureLoader = (options: { compress: boolean }) => async (url: string, request?: MaterialTextureRequest): Promise<THREE.Texture> => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const picture = await decodePictureOffPage(bytes);
    const { texture } = await textureFromPicture(picture, request ?? { textureId: '', slot: 'map', flipY: true }, options.compress);
    return texture;
};
