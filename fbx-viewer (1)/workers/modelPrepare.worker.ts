/// <reference lib="webworker" />

import { isDedicatedWorkerMessage } from './dedicatedWorkerMessage';
import { prepareGlb, UnpreparableModelError, type CompressImage, type PrepareOptions } from '../utils/preparedModels/prepareGlb';
import { compressBitmap, isCompressibleSize } from '../utils/textureCompression/textureEncoding';

/** Makes one prepared model per worker (see utils/preparedModels/format.ts), out of the way of the editor. */

export type ModelPrepareRequest = { glb: ArrayBuffer; format: 'glb' | 'gltf'; options: PrepareOptions; textureVersion: number };
export type ModelPrepareResponse =
    | { type: 'complete'; glb: ArrayBuffer }
    | { type: 'unpreparable'; reason: string }
    | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<ModelPrepareRequest>) => {
    if (!isDedicatedWorkerMessage(event)) return;
    const { glb, format, options, textureVersion } = event.data;
    // The pixels a loading model would read: GLTFLoader decodes its images with these same options.
    const compress: CompressImage = async (bytes, mimeType, kind) => {
        const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        if (isCompressibleSize(bitmap.width, bitmap.height)) return compressBitmap(bitmap, kind, false, textureVersion);
        bitmap.close();
        return null;
    };
    try {
        const prepared = await prepareGlb(glb, format, options, compress);
        scope.postMessage({ type: 'complete', glb: prepared } satisfies ModelPrepareResponse, [prepared]);
    } catch (error) {
        if (error instanceof UnpreparableModelError) scope.postMessage({ type: 'unpreparable', reason: error.message } satisfies ModelPrepareResponse);
        else scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Model preparation failed' } satisfies ModelPrepareResponse);
    }
};
