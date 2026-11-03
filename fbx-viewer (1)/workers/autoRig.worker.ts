/// <reference lib="webworker" />

import { readAnyBody, readAs, rigBody, type BodyKind, type RigMarkerName, type RigMarkers, type RigReading } from '../utils/autoRig/rigBody';
import type { RigJoint } from '../utils/autoRig/bodySkeleton';
import type { PartWeights, SkinnedPart } from '../utils/autoRig/skinWeights';

// Reads a body from its mesh and fits a skeleton and weights to it, which takes too long for the UI thread.
export type AutoRigRequest =
  /** `kind` is the body to read it as, and `facing` the way it faces, where those have been chosen. */
  | { type: 'read'; triangles: Float32Array; kind?: BodyKind; facing?: [number, number] }
  | { type: 'rig'; triangles: Float32Array; parts: SkinnedPart[]; reading: RigReading; moved: RigMarkerName[]; original: RigMarkers; withFingers: boolean; withTail: boolean };

export type AutoRigResponse =
  | { type: 'progress'; share: number }
  /** `guessed`: the mesh did not read as that kind of body, so the markers only start from its usual proportions. */
  | { type: 'read'; reading: RigReading | null; guessed: boolean }
  | { type: 'rigged'; joints: RigJoint[]; weights: PartWeights[] }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<AutoRigRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'read') {
      const read = request.kind ? readAs(request.triangles, request.kind, request.facing) : readAnyBody(request.triangles);
      scope.postMessage({ type: 'read', reading: read.reading, guessed: read.guessed } satisfies AutoRigResponse);
      return;
    }
    const { joints, weights } = rigBody(request.triangles, request.parts, request.reading, request.moved, (share) => {
      scope.postMessage({ type: 'progress', share } satisfies AutoRigResponse);
    }, request.original, request.withFingers, request.withTail);
    const buffers = weights.flatMap((part) => [part.joints.buffer, part.weights.buffer]) as ArrayBuffer[];
    scope.postMessage({ type: 'rigged', joints, weights } satisfies AutoRigResponse, buffers);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The body could not be rigged.' } satisfies AutoRigResponse);
  }
};
