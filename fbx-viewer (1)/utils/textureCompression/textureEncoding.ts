import { compressMipChain, hasAlpha, type BlockFormat } from './bcEncoder';

/** Compressing one texture off the main thread, and the cache that means it happens once. */

/** colour: sRGB colour (BC1, BC3 with alpha); data: linear data maps (same); normal: tangent-space normals (BC5). */
export type TextureKind = 'colour' | 'data' | 'normal';
export type CompressedLevelMessage = { data: ArrayBuffer; width: number; height: number };
export type CompressedTextureData = { format: BlockFormat; levels: CompressedLevelMessage[]; cached: boolean };

/** Textures smaller than this on a side are left as they are. */
const MIN_COMPRESSED_SIZE = 64;

const isPowerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;

/** Whether a texture of this size is compressed. */
export const isCompressibleSize = (width: number, height: number): boolean =>
    isPowerOfTwo(width) && isPowerOfTwo(height) && Math.min(width, height) >= MIN_COMPRESSED_SIZE;

const DATABASE = 'auvra-texture-cache';
const STORE = 'bc';

let database: Promise<IDBDatabase | null> | null = null;
const openCache = (): Promise<IDBDatabase | null> => {
    if (!database) {
        database = new Promise((resolve) => {
            try {
                const request = indexedDB.open(DATABASE, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(STORE);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    return database;
};

type CachedTexture = { format: BlockFormat; levels: CompressedLevelMessage[] };

const readCache = async (key: string): Promise<CachedTexture | null> => {
    const db = await openCache();
    if (!db) return null;
    return new Promise((resolve) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        request.onsuccess = () => resolve((request.result as CachedTexture | undefined) ?? null);
        request.onerror = () => resolve(null);
    });
};

const writeCache = async (key: string, value: CachedTexture): Promise<void> => {
    const db = await openCache();
    if (!db) return;
    await new Promise<void>((resolve) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
    });
};

const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Reads a bitmap's pixels (and closes it), and returns its BC-compressed mip chain from the cache
 * (by the pixels' SHA-256) or freshly made and cached.
 */
export const compressBitmap = async (bitmap: ImageBitmap, kind: TextureKind, flipY: boolean, version: number): Promise<CompressedTextureData> => {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No 2D context in the texture worker');
    if (flipY) {
        // A texture that flips on upload is stored the way it is sampled: compressed data cannot flip.
        context.translate(0, height);
        context.scale(1, -1);
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height).data;
    const digest = hex(await crypto.subtle.digest('SHA-256', pixels));
    const key = `${version}|${kind}|${width}x${height}|${digest}`;
    const cached = await readCache(key);
    if (cached) return { format: cached.format, levels: cached.levels, cached: true };
    const format: BlockFormat = kind === 'normal' ? 'bc5' : hasAlpha(pixels) ? 'bc3' : 'bc1';
    const levels = compressMipChain(pixels, width, height, format, kind === 'colour').map(level => ({
        data: level.data.buffer.slice(level.data.byteOffset, level.data.byteOffset + level.data.byteLength) as ArrayBuffer,
        width: level.width,
        height: level.height,
    }));
    await writeCache(key, { format, levels });
    return { format, levels, cached: false };
};
