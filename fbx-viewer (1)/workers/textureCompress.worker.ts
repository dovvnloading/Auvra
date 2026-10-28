/// <reference lib="webworker" />

import { compressMipChain, hasAlpha, type BlockFormat } from '../utils/textureCompression/bcEncoder';

/**
 * Compresses one texture per request, off the main thread: reads the image's pixels, and returns
 * its BC-compressed mip chain from the cache (by the pixels' SHA-256) or freshly made and cached.
 */

/** colour: sRGB colour (BC1, BC3 with alpha); data: linear data maps (same); normal: tangent-space normals (BC5). */
export type TextureKind = 'colour' | 'data' | 'normal';
type CompressRequest = { id: number; bitmap: ImageBitmap; kind: TextureKind; flipY: boolean; version: number };
export type CompressedLevelMessage = { data: ArrayBuffer; width: number; height: number };
export type CompressResponse =
    | { id: number; format: BlockFormat; levels: CompressedLevelMessage[]; cached: boolean }
    | { id: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
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

scope.onmessage = async (event: MessageEvent<CompressRequest>) => {
    const { id, bitmap, kind, flipY, version } = event.data;
    try {
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
        if (cached) {
            scope.postMessage({ id, format: cached.format, levels: cached.levels, cached: true } satisfies CompressResponse);
            return;
        }
        const format: BlockFormat = kind === 'normal' ? 'bc5' : hasAlpha(pixels) ? 'bc3' : 'bc1';
        const levels = compressMipChain(pixels, width, height, format, kind === 'colour').map(level => ({
            data: level.data.buffer.slice(level.data.byteOffset, level.data.byteOffset + level.data.byteLength) as ArrayBuffer,
            width: level.width,
            height: level.height,
        }));
        await writeCache(key, { format, levels });
        scope.postMessage({ id, format, levels, cached: false } satisfies CompressResponse, levels.map(level => level.data));
    } catch (error) {
        scope.postMessage({ id, error: error instanceof Error ? error.message : 'Texture compression failed' } satisfies CompressResponse);
    }
};
