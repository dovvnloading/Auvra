import { decodePicture } from '../texturing/textureDecode';
import { encodeMaterialTexture, type MaterialTextureFormat, type MaterialTextureKind } from '../utils/textureCompression/materialTextureEncoder';

/**
 * The texture pipeline's heavy work, off the page: decoding pictures at their own depth, and compressing
 * textures with their mip levels (texturing/texturePipeline.ts is the client).
 */

type Request =
    | { id: number; op: 'decode'; bytes: Uint8Array; name: string }
    | { id: number; op: 'encode'; rgba: Uint8Array; width: number; height: number; format: MaterialTextureFormat; kind: MaterialTextureKind; mips: boolean };

const reply = (message: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<Request>) => {
    const request = event.data;
    try {
        if (request.op === 'decode') {
            const picture = await decodePicture(request.bytes, request.name);
            reply({ id: request.id, picture }, [picture.rgba.buffer]);
        } else {
            const levels = encodeMaterialTexture(request.rgba, request.width, request.height, request.format, request.kind, request.mips);
            reply({ id: request.id, levels }, levels.map(level => level.data.buffer));
        }
    } catch (error) {
        reply({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
};
