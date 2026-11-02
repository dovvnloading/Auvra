/// <reference lib="webworker" />

import { readBody, type BodyMarkers, type BodyReading, type MarkerName } from '../utils/autoRig/bodyMarkers';
import { rigBody, standardReading } from '../utils/autoRig/rigBody';
import type { RigJoint } from '../utils/autoRig/bodySkeleton';
import type { PartWeights, SkinnedPart } from '../utils/autoRig/skinWeights';

// Reads a body from its mesh and fits a skeleton and weights to it, which takes too long for the UI thread.
export type AutoRigRequest =
  | { type: 'read'; triangles: Float32Array }
  | { type: 'rig'; triangles: Float32Array; parts: SkinnedPart[]; reading: BodyReading; moved: MarkerName[]; original: BodyMarkers };

export type AutoRigResponse =
  | { type: 'progress'; share: number }
  /** `guessed`: the mesh did not read as a person, so the markers only start from a person's proportions. */
  | { type: 'read'; reading: BodyReading | null; guessed: boolean }
  | { type: 'rigged'; joints: RigJoint[]; weights: PartWeights[] }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<AutoRigRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'read') {
      const reading = readBody(request.triangles);
      scope.postMessage({
        type: 'read',
        reading: reading ?? standardReading(request.triangles),
        guessed: !reading,
      } satisfies AutoRigResponse);
      return;
    }
    const { joints, weights } = rigBody(request.triangles, request.parts, request.reading, request.moved, (share) => {
      scope.postMessage({ type: 'progress', share } satisfies AutoRigResponse);
    }, request.original);
    const buffers = weights.flatMap((part) => [part.joints.buffer, part.weights.buffer]) as ArrayBuffer[];
    scope.postMessage({ type: 'rigged', joints, weights } satisfies AutoRigResponse, buffers);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The body could not be rigged.' } satisfies AutoRigResponse);
  }
};
