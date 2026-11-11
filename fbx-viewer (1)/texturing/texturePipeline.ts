import { decodePicture, type DecodedPicture } from './textureDecode';
import { encodeMaterialTexture, type EncodedLevel, type MaterialTextureFormat, type MaterialTextureKind } from '../utils/textureCompression/materialTextureEncoder';

/**
 * The texture pipeline's client: decoding and compressing in a worker (texturePipeline.worker.ts), one
 * request at a time in the order asked, or here where there are no workers (tests).
 */

let worker: Worker | null = null;
let nextId = 1;
/** An unresponsive worker must not hold transferred image buffers forever. */
export const TEXTURE_WORKER_TIMEOUT_MS = 120_000;
const waiting = new Map<number, {
    resolve: (value: never) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}>();

const failWorker = (error: Error, source: Worker): void => {
    if (worker !== source) return;
    worker = null;
    try { source.terminate(); } catch { /* A failed worker may already be gone. */ }
    for (const pending of waiting.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
    }
    waiting.clear();
};

const workerOf = (): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (!worker) {
        const active = new Worker(new URL('../workers/texturePipeline.worker.ts', import.meta.url), { type: 'module' });
        worker = active;
        active.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
            if (worker !== active) return;
            const reply = event.data;
            if (!reply || typeof reply.id !== 'number') {
                failWorker(new Error('Texture worker returned an invalid response'), active);
                return;
            }
            const pending = waiting.get(reply.id);
            if (!pending) return;
            waiting.delete(reply.id);
            clearTimeout(pending.timeout);
            if (reply.error) pending.reject(new Error(reply.error));
            else pending.resolve(reply as never);
        };
        active.onerror = () => failWorker(new Error('Texture worker failed'), active);
        active.onmessageerror = () => failWorker(new Error('Texture worker response could not be read'), active);
    }
    return worker;
};

const ask = <T>(message: Record<string, unknown>, transfer: Transferable[]): Promise<T> => new Promise<T>((resolve, reject) => {
    let active: Worker | null;
    try {
        active = workerOf();
    } catch {
        reject(new Error('Texture worker could not start'));
        return;
    }
    if (!active) {
        reject(new Error('Texture worker is unavailable'));
        return;
    }
    const id = nextId++;
    const timeout = setTimeout(() => failWorker(new Error('Texture worker timed out'), active), TEXTURE_WORKER_TIMEOUT_MS);
    waiting.set(id, { resolve: resolve as (value: never) => void, reject, timeout });
    try {
        active.postMessage({ ...message, id }, transfer);
    } catch {
        failWorker(new Error('Texture worker could not accept the request'), active);
    }
});

/** Decodes a picture file at its own depth, off the page. The bytes are handed over. */
export const decodePictureOffPage = async (bytes: Uint8Array, name = ''): Promise<DecodedPicture> => {
    if (!workerOf()) return decodePicture(bytes, name);
    const { picture } = await ask<{ picture: DecodedPicture }>({ op: 'decode', bytes, name }, [bytes.buffer]);
    return picture;
};

/** Compresses a texture (8-bit RGBA) with its mip levels, off the page. The pixels are handed over. */
export const encodeTextureOffPage = async (
    rgba: Uint8Array, width: number, height: number, format: MaterialTextureFormat, kind: MaterialTextureKind, mips: boolean,
): Promise<EncodedLevel[]> => {
    if (!workerOf()) return encodeMaterialTexture(rgba, width, height, format, kind, mips);
    const { levels } = await ask<{ levels: EncodedLevel[] }>({ op: 'encode', rgba, width, height, format, kind, mips }, [rgba.buffer]);
    return levels;
};
