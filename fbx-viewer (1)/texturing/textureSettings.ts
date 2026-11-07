import type { PictureFormat } from './textureDecode';
import type { MaterialTextureFormat } from '../utils/textureCompression/materialTextureEncoder';

/**
 * TEXTURE SETTINGS
 *
 * How each imported texture is kept and drawn, set in the Content Browser's Texture Settings and stored
 * with the texture (its `settings`): read as colour or as data, whether it is a normal map, how it is
 * compressed, the largest size it is drawn at, how it wraps and filters, and whether it has mip levels.
 * Deep pictures (16-bit, floating point, TIFF, TGA, PSD) also keep what their file was and an 8-bit
 * preview for the places that show a picture. Absent settings mean "as it is used": a texture read for
 * base colour is colour, one read for a normal is a normal map, the rest data.
 */

export type TextureColourSpace = 'colour' | 'data';
export type TextureCompressionChoice = 'auto' | 'none' | MaterialTextureFormat;
export type TextureWrap = 'repeat' | 'clamp' | 'mirror';
export type TextureFilter = 'linear' | 'nearest';

export interface TextureSource {
    format: PictureFormat;
    depth: 8 | 16 | 32;
    channels: 1 | 2 | 3 | 4;
    hdr?: boolean;
}

export interface TextureSettings {
    colorSpace?: TextureColourSpace;
    normalMap?: boolean;
    compression?: TextureCompressionChoice;
    /** The largest side it is drawn at; absent or 0 for its own size. */
    maxSize?: number;
    wrap?: TextureWrap;
    filter?: TextureFilter;
    /** Mip levels (smaller copies for far away); absent means yes. */
    mips?: boolean;
    /** A normal map made for DirectX (green pointing down): its green is turned over as it loads. */
    flipGreen?: boolean;
    /** What the imported file was, for deep or non-browser pictures. */
    source?: TextureSource;
    /** An 8-bit picture of it, for the places that show one (the Content Browser, terrain, decals). */
    preview?: { assetId: string };
    /** Its compressed blocks, kept by signature (texturing/compressedContainer.ts), so they are made once. */
    compressed?: Array<{ signature: string; assetId: string }>;
}

/** How many compressed versions a texture keeps (one per way it has been drawn), newest last. */
export const MAX_KEPT_COMPRESSIONS = 4;

export const MAX_SIZE_CHOICES = [256, 512, 1024, 2048, 4096, 8192] as const;

/** A file name's last word, without its extension or a size such as "_4k" or "_2048px": "rock_nor_gl_4k.exr" ends "nor_gl". */
const nameEnding = (name: string): string => name.toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[_\-. ](?:\d+k|\d+px|\d+)$/, '');

const DIRECTX_NORMAL = /(?:^|[_\-. ])(?:nor_dx|nrm_dx|normal_dx|normaldx|n_dx)$/;
const NORMAL = /(?:^|[_\-. ])(?:n|nrm|nor|normal|nor_gl|nrm_gl|normal_gl|normalgl|n_gl)$/;
const DATA = /(?:^|[_\-. ])(?:rough|roughness|rgh|gloss|metal|metallic|metalness|mtl|ao|occ|occlusion|ambientocclusion|arm|orm|height|disp|displacement|bump|mask)$/;

/**
 * What a texture's file name says it is: a normal map ("_n", "_nrm", "_normal", "_nor", "_nor_gl", and
 * "_nor_dx" for DirectX ones, whose green is turned over), or data read as stored (roughness, metallic,
 * occlusion, height and packed maps). Nothing for the rest, which are read by use. Texture Settings can
 * change any of it.
 */
export const settingsFromName = (name: string): TextureSettings | undefined => {
    const ending = nameEnding(name);
    if (DIRECTX_NORMAL.test(ending)) return { normalMap: true, flipGreen: true };
    if (NORMAL.test(ending)) return { normalMap: true };
    if (DATA.test(ending)) return { colorSpace: 'data' };
    return undefined;
};
const COMPRESSIONS: readonly TextureCompressionChoice[] = ['auto', 'none', 'bc7', 'bc5', 'bc4'];
const FORMATS: readonly PictureFormat[] = ['png', 'jpeg', 'webp', 'tiff', 'exr', 'hdr', 'tga', 'psd'];
const ASSET_ID = /^[0-9a-f]{64}$/;

/** Stored settings made safe; undefined when nothing is set. */
export const normalizeTextureSettings = (value: unknown): TextureSettings | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const result: TextureSettings = {};
    if (source.colorSpace === 'colour' || source.colorSpace === 'data') result.colorSpace = source.colorSpace;
    if (typeof source.normalMap === 'boolean') result.normalMap = source.normalMap;
    if (COMPRESSIONS.includes(source.compression as TextureCompressionChoice)) result.compression = source.compression as TextureCompressionChoice;
    if ((MAX_SIZE_CHOICES as readonly number[]).includes(source.maxSize as number)) result.maxSize = source.maxSize as number;
    if (source.wrap === 'repeat' || source.wrap === 'clamp' || source.wrap === 'mirror') result.wrap = source.wrap;
    if (source.filter === 'linear' || source.filter === 'nearest') result.filter = source.filter;
    if (typeof source.mips === 'boolean') result.mips = source.mips;
    if (typeof source.flipGreen === 'boolean') result.flipGreen = source.flipGreen;
    const file = source.source as Record<string, unknown> | undefined;
    if (file && FORMATS.includes(file.format as PictureFormat) && [8, 16, 32].includes(file.depth as number) && [1, 2, 3, 4].includes(file.channels as number)) {
        result.source = { format: file.format as PictureFormat, depth: file.depth as 8 | 16 | 32, channels: file.channels as 1 | 2 | 3 | 4, ...(file.hdr === true ? { hdr: true } : {}) };
    }
    const preview = source.preview as Record<string, unknown> | undefined;
    if (preview && typeof preview.assetId === 'string' && ASSET_ID.test(preview.assetId)) result.preview = { assetId: preview.assetId };
    if (Array.isArray(source.compressed)) {
        const kept = source.compressed.filter((entry): entry is { signature: string; assetId: string } => !!entry && typeof entry === 'object'
            && typeof (entry as { signature?: unknown }).signature === 'string' && (entry as { signature: string }).signature.length <= 512
            && ASSET_ID.test(String((entry as { assetId?: unknown }).assetId))).slice(-MAX_KEPT_COMPRESSIONS)
            .map(entry => ({ signature: entry.signature, assetId: entry.assetId }));
        if (kept.length) result.compressed = kept;
    }
    return Object.keys(result).length ? result : undefined;
};

// --- The settings of the open project's textures -------------------------------------------------

const registry = new Map<string, TextureSettings>();
const listeners = new Set<() => void>();
let version = 0;

/** A texture's settings, as the open project has them. */
export const textureSettingsOf = (textureId: string): TextureSettings | undefined => registry.get(textureId);

/** Records a texture's settings (when the project opens, a texture is imported, or its settings change). */
export const setTextureSettings = (textureId: string, settings: TextureSettings | undefined): void => {
    if (settings) registry.set(textureId, settings);
    else registry.delete(textureId);
    version += 1;
    for (const listener of listeners) listener();
};

/** The asset holding each texture's file (its hash), which compressed blocks are kept against. */
const sourceAssets = new Map<string, string>();
export const textureSourceAssetOf = (textureId: string): string | undefined => sourceAssets.get(textureId);
export const setTextureSourceAsset = (textureId: string, assetId: string): void => { sourceAssets.set(textureId, assetId); };

/** The settings with `assetId` kept as the compressed blocks for `signature` (replacing older ones of it, keeping the newest few). */
export const withKeptCompression = (settings: TextureSettings | undefined, signature: string, assetId: string): TextureSettings => ({
    ...(settings ?? {}),
    compressed: [...(settings?.compressed ?? []).filter(entry => entry.signature !== signature), { signature, assetId }].slice(-MAX_KEPT_COMPRESSIONS),
});

/** Forgets every texture's settings (another project opens). */
export const clearTextureSettings = (): void => {
    registry.clear();
    sourceAssets.clear();
    version += 1;
};

export const subscribeTextureSettings = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
export const textureSettingsVersion = (): number => version;

// --- What a texture is kept as -------------------------------------------------------------------

/** What a texture is for where a material reads it. */
export type TextureRole = 'colour' | 'normal' | 'data';

/** Its role from the slot a material reads it in, unless its settings say otherwise. */
export const textureRole = (slot: 'map' | 'normal' | 'data', settings: TextureSettings | undefined): TextureRole => {
    if (settings?.normalMap || (slot === 'normal' && settings?.normalMap !== false)) return 'normal';
    if (settings?.colorSpace === 'colour') return 'colour';
    if (settings?.colorSpace === 'data' || slot === 'data') return 'data';
    return 'colour';
};

/** What the GPU can take compressed. */
export interface CompressionSupport { bptc: boolean; rgtc: boolean }

export type KeptFormat = MaterialTextureFormat | 'rgba8' | 'half';

/**
 * The format a texture is kept in on the GPU: BC7 for colour, BC5 for normal maps and BC4 for one channel
 * of data, unless its settings pick one, or it holds light beyond white, or it is floating-point colour
 * (both kept as half floats: no compressed format for either is written here), or the GPU cannot take it.
 * Kept whole, a floating-point picture stays in half floats and any other in 8 bits.
 */
export const keptFormat = (
    role: TextureRole,
    settings: TextureSettings | undefined,
    support: CompressionSupport,
    picture: { channels: number; depth: number; hdr: boolean; width: number; height: number },
): KeptFormat => {
    const whole = wholeFormat(picture);
    const choice = settings?.compression ?? 'auto';
    // Floating-point colour holds light, not sRGB values, so the sRGB colour formats do not fit it.
    const linearColour = picture.depth === 32 && role === 'colour' && choice === 'auto';
    if (choice === 'none' || picture.hdr || linearColour) return whole;
    // Compressed blocks are 4 pixels a side.
    if (picture.width % 4 !== 0 || picture.height % 4 !== 0) return whole;
    const wanted: MaterialTextureFormat = choice !== 'auto' ? choice : role === 'normal' ? 'bc5' : role === 'data' && picture.channels === 1 ? 'bc4' : 'bc7';
    const supported = wanted === 'bc7' ? support.bptc : support.rgtc;
    return supported ? wanted : whole;
};

/** The format a texture is kept in uncompressed: half floats for floating-point pictures, 8 bits for the rest. */
export const wholeFormat = (picture: { depth: number; hdr: boolean }): KeptFormat => (picture.hdr || picture.depth === 32 ? 'half' : 'rgba8');

/** The size a texture is drawn at, after its size limit (halving until it fits). */
export const limitedSize = (width: number, height: number, maxSize: number | undefined): { width: number; height: number } => {
    let w = width;
    let h = height;
    while (maxSize && (w > maxSize || h > maxSize) && w > 1 && h > 1) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
    }
    return { width: w, height: h };
};

/** A format in plain words, for the settings and memory views. */
export const FORMAT_WORDS: Record<KeptFormat, string> = {
    bc7: 'Compressed (BC7)',
    bc5: 'Compressed normal map (BC5)',
    bc4: 'Compressed, one channel (BC4)',
    rgba8: 'Uncompressed, 8 bits a channel',
    half: 'Uncompressed, 16-bit floating point',
};
