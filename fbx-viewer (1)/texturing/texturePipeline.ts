import { decodePicture, type DecodedPicture } from './textureDecode';
import { encodeMaterialTexture, type EncodedLevel, type MaterialTextureFormat, type MaterialTextureKind } from '../utils/textureCompression/materialTextureEncoder';

/**
 * The texture pipeline's client: decoding and compressing in a worker (texturePipeline.worker.ts), one
 * request at a time in the order asked, or here where there are no workers (tests).
 */

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

const workerOf = (): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (!worker) {
        worker = new Worker(new URL('../workers/texturePipeline.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
            const pending = waiting.get(event.data.id);
            if (!pending) return;
            waiting.delete(event.data.id);
            if (event.data.error) pending.reject(new Error(event.data.error));
            else pending.resolve(event.data as never);
        };
    }
    return worker;
};

const ask = <T>(message: Record<string, unknown>, transfer: Transferable[]): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve: resolve as (value: never) => void, reject });
    workerOf()!.postMessage({ ...message, id }, transfer);
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
