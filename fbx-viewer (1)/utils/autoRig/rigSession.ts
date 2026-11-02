import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';
import { readGltfSource } from '../modelLoader';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { BodyMarkers, BodyReading, MarkerName, Point } from './bodyMarkers';
import { bakedPositions, buildRiggedGlb, trianglesOf, type RigPrimitive, type RigSource } from './riggedGlb';

/**
 * A model being given a skeleton: shared between the panel in the sidebar and the markers in the
 * viewport, which sit in different React roots, and alive until the skeleton is made or given up.
 */

export type RigStage = 'idle' | 'reading' | 'placing' | 'binding';

export interface RigSessionState {
  stage: RigStage;
  modelId: string | null;
  reading: BodyReading | null;
  /** The mesh did not read as a person, so the markers only start from a person's proportions. */
  guessed: boolean;
  /** Moving a marker moves its partner on the other side, as in a mirror. */
  bothSides: boolean;
  /** Hands that have room for them get finger bones. */
  withFingers: boolean;
  /** The marker under the pointer, or being moved. */
  activeMarker: MarkerName | null;
  /** How far the skeleton is along, from 0 to 1. */
  progress: number;
  error: string | null;
}

const IDLE: RigSessionState = { stage: 'idle', modelId: null, reading: null, guessed: false, bothSides: true, withFingers: true, activeMarker: null, progress: 0, error: null };

let state: RigSessionState = IDLE;
const listeners = new Set<() => void>();

const setState = (next: Partial<RigSessionState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export const useRigSession = (): RigSessionState => useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  () => state,
);

/** What a running session holds but no one draws. */
interface Working {
  worker: Worker;
  source: RigSource;
  primitives: RigPrimitive[];
  triangles: Float32Array;
  /** The markers as they were read, before any moved. */
  original: BodyMarkers;
  moved: Set<MarkerName>;
}

let working: Working | null = null;
let session = 0;

const dropWorking = (): void => {
  working?.worker.terminate();
  working = null;
  session += 1;
};

export const cancelRig = (): void => {
  dropWorking();
  state = { ...IDLE, bothSides: state.bothSides, withFingers: state.withFingers };
  for (const listener of listeners) listener();
};

export const setRigBothSides = (bothSides: boolean): void => setState({ bothSides });
export const setRigWithFingers = (withFingers: boolean): void => setState({ withFingers });
export const setActiveRigMarker = (activeMarker: MarkerName | null): void => setState({ activeMarker });

/** The primitives of a source's geometry, in the document's space, skipping what is not a triangle mesh. */
const primitivesOf = (scene: THREE.Object3D, associations: Awaited<ReturnType<typeof readGltfSource>>['associations']): RigPrimitive[] => {
  const primitives: RigPrimitive[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const own = associations.get(mesh);
    const node = own?.nodes ?? associations.get(mesh.parent)?.nodes;
    if (own?.meshes === undefined || own.primitives === undefined || node === undefined) return;
    const index = mesh.geometry.index;
    const indices = index ? (index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array as ArrayLike<number>)) : null;
    primitives.push({
      node,
      mesh: own.meshes,
      primitive: own.primitives,
      geometry: mesh.geometry,
      matrix: mesh.matrixWorld.clone(),
      positions: bakedPositions(mesh.geometry, mesh.matrixWorld),
      indices,
    });
  });
  return primitives;
};

const askWorker = (worker: Worker, request: AutoRigRequest, onProgress?: (share: number) => void): Promise<AutoRigResponse> => new Promise((resolve, reject) => {
  worker.onerror = () => reject(new Error('The rigging worker stopped.'));
  worker.onmessage = (event: MessageEvent<AutoRigResponse>) => {
    const message = event.data;
    if (message.type === 'progress') onProgress?.(message.share);
    else if (message.type === 'error') reject(new Error(message.message));
    else resolve(message);
  };
  worker.postMessage(request);
});

/** Ends the session, saying why. */
export const failRig = (error: unknown, fallback: string): void => {
  frontendDiagnostics.failure('auto_rig_read_failed', error);
  dropWorking();
  state = { ...IDLE, bothSides: state.bothSides, withFingers: state.withFingers, error: error instanceof Error ? error.message : fallback };
  for (const listener of listeners) listener();
};

/** Reads a model's file and its body, and puts the markers where it thinks the joints are. */
export const startRig = async (modelId: string, file: File, options: { convert?: ModelConvertOptions; images?: readonly File[] } = {}): Promise<void> => {
  dropWorking();
  const mine = session;
  setState({ ...IDLE, bothSides: state.bothSides, withFingers: state.withFingers, stage: 'reading', modelId });
  try {
    const source = await readGltfSource(file, options);
    if (mine !== session) return;
    const primitives = primitivesOf(source.scene, source.associations);
    if (!primitives.length) throw new Error('The model has no mesh to rig.');
    const triangles = trianglesOf(primitives);
    const worker = new Worker(new URL('../../workers/autoRig.worker.ts', import.meta.url), { type: 'module' });
    const response = await askWorker(worker, { type: 'read', triangles });
    if (mine !== session) {
      worker.terminate();
      return;
    }
    if (response.type !== 'read' || !response.reading) throw new Error('The model has no surface to read.');
    working = { worker, source, primitives, triangles, original: { ...response.reading.markers }, moved: new Set() };
    setState({ stage: 'placing', reading: response.reading, guessed: response.guessed });
  } catch (error) {
    if (mine === session) failRig(error, 'The model could not be read.');
  }
};

const PARTNER: Record<MarkerName, MarkerName | null> = {
  chin: null,
  groin: null,
  leftShoulder: 'rightShoulder',
  rightShoulder: 'leftShoulder',
  leftElbow: 'rightElbow',
  rightElbow: 'leftElbow',
  leftWrist: 'rightWrist',
  rightWrist: 'leftWrist',
  leftKnee: 'rightKnee',
  rightKnee: 'leftKnee',
  leftAnkle: 'rightAnkle',
  rightAnkle: 'leftAnkle',
};

/** Moves a marker to a place in the model's space, and its partner to match when both sides move together. */
export const moveRigMarker = (name: MarkerName, place: Point): void => {
  const { reading, bothSides } = state;
  if (!reading || !working) return;
  const markers: BodyMarkers = { ...reading.markers, [name]: place };
  working.moved.add(name);
  const partner = PARTNER[name];
  if (partner && bothSides) {
    // The body's middle runs through the groin as it was read, square to the way it faces.
    const middle = working.original.groin;
    const [fx, fz] = reading.facing;
    const across: [number, number] = [fz, -fx];
    const away = (place[0] - middle[0]) * across[0] + (place[2] - middle[2]) * across[1];
    markers[partner] = [place[0] - 2 * away * across[0], place[1], place[2] - 2 * away * across[1]];
    working.moved.add(partner);
  }
  setState({ reading: { ...reading, markers } });
};

/**
 * Makes the skeleton and weights for the markers as they are now, and hands back the model's rigged
 * file. The session ends with it.
 */
export const finishRig = async (fileName: string): Promise<File | null> => {
  const current = working;
  const { reading } = state;
  if (!current || !reading) return null;
  const mine = session;
  setState({ stage: 'binding', progress: 0 });
  try {
    const parts = current.primitives.map((part) => ({ positions: part.positions, indices: part.indices }));
    const response = await askWorker(
      current.worker,
      { type: 'rig', triangles: current.triangles, parts, reading, moved: [...current.moved], original: current.original, withFingers: state.withFingers },
      (share) => { if (mine === session) setState({ progress: share }); },
    );
    if (mine !== session) return null;
    if (response.type !== 'rigged') throw new Error('The body could not be rigged.');
    const glb = buildRiggedGlb(current.source, current.primitives, response.joints, response.weights);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const file = new File([glb], `${stem}.glb`, { type: 'model/gltf-binary' });
    cancelRig();
    return file;
  } catch (error) {
    if (mine !== session) return null;
    frontendDiagnostics.failure('auto_rig_failed', error);
    setState({ stage: 'placing', progress: 0, error: error instanceof Error ? error.message : 'The body could not be rigged.' });
    return null;
  }
};
