/// <reference lib="webworker" />

import RecastWasm from '@recast-navigation/wasm';
import { bakeNavMeshData, recastReady, type NavBakeInput } from '../runtime/navMesh';

/** Bakes level navmeshes off the main thread (runtime/navigation.ts asks); one bake per request. */

type BakeRequest = { id: number; input: NavBakeInput };
export type BakeResponse = { id: number; data: Uint8Array } | { id: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<BakeRequest>) => {
    const { id, input } = event.data;
    try {
        await recastReady(RecastWasm);
        const data = bakeNavMeshData(input);
        scope.postMessage({ id, data } satisfies BakeResponse, [data.buffer as ArrayBuffer]);
    } catch (error) {
        scope.postMessage({ id, error: error instanceof Error ? error.message : 'The navmesh could not be baked' } satisfies BakeResponse);
    }
};
