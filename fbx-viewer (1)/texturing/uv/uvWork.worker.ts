/// <reference lib="webworker" />

import { isDedicatedWorkerMessage } from '../../workers/dedicatedWorkerMessage';
import { handleUvRequest, type UvRequest, type UvWorkState } from './uvWork';

/** Unwraps, packs and measures UV layouts off the main thread (texturing/uv/uvWork.ts asks). */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const state: UvWorkState = { topology: null };

scope.onmessage = (event: MessageEvent<UvRequest>) => {
    if (!isDedicatedWorkerMessage(event)) return;
    const { response, transfer } = handleUvRequest(state, event.data);
    scope.postMessage(response, transfer);
};
