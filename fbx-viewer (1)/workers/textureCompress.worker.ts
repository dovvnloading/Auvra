/// <reference lib="webworker" />

import type { BlockFormat } from '../utils/textureCompression/bcEncoder';
import { compressBitmap, type CompressedLevelMessage, type TextureKind } from '../utils/textureCompression/textureEncoding';

/**
 * Compresses one texture per request, off the main thread: reads the image's pixels, and returns
 * its BC-compressed mip chain from the cache (by the pixels' SHA-256) or freshly made and cached.
 */

export type { CompressedLevelMessage, TextureKind };
type CompressRequest = { id: number; bitmap: ImageBitmap; kind: TextureKind; flipY: boolean; version: number };
export type CompressResponse =
    | { id: number; format: BlockFormat; levels: CompressedLevelMessage[]; cached: boolean }
    | { id: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<CompressRequest>) => {
    const { id, bitmap, kind, flipY, version } = event.data;
    try {
        const { format, levels, cached } = await compressBitmap(bitmap, kind, flipY, version);
        scope.postMessage({ id, format, levels, cached } satisfies CompressResponse, cached ? [] : levels.map(level => level.data));
    } catch (error) {
        scope.postMessage({ id, error: error instanceof Error ? error.message : 'Texture compression failed' } satisfies CompressResponse);
    }
};
