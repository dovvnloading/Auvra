import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';
import { readGltfSource } from '../modelLoader';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { Point } from './bodyMarkers';
import { bakedPositions, buildRiggedGlb, trianglesOf, type RigPrimitive, type RigSource } from './riggedGlb';
import type { BodyKind, RigMarkerName, RigMarkers, RigReading } from './rigBody';

/**
 * A model being given a skeleton: shared between the panel in the sidebar and the markers in the
 * viewport, which sit in different React roots, and alive until the skeleton is made or given up.
 */

export type RigStage = 'idle' | 'reading' | 'placing' | 'binding';

export interface RigSessionState {
  stage: RigStage;
  modelId: string | null;
  reading: RigReading | null;
  /** The mesh did not read as this kind of body, so the markers only start from its usual proportions. */
  guessed: boolean;
  /** Moving a marker moves its partner on the other side, as in a mirror. */
  bothSides: boolean;
  /** Hands that have room for them get finger bones. */
  withFingers: boolean;
  /** An animal's tail gets bones. */
  withTail: boolean;
  /** The marker under the pointer, or being moved. */
  activeMarker: RigMarkerName | null;
  /** How far the skeleton is along, from 0 to 1. */
  progress: number;
  error: string | null;
}

const IDLE: RigSessionState = { stage: 'idle', modelId: null, reading: null, guessed: false, bothSides: true, withFingers: true, withTail: true, activeMarker: null, progress: 0, error: null };

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
  original: RigMarkers;
  moved: Set<RigMarkerName>;
}

let working: Working | null = null;
let session = 0;

const dropWorking = (): void => {
  working?.worker.terminate();
  working = null;
  session += 1;
};

/** What stays from one session to the next. */
const keptChoices = (): Pick<RigSessionState, 'bothSides' | 'withFingers' | 'withTail'> => ({ bothSides: state.bothSides, withFingers: state.withFingers, withTail: state.withTail });

export const cancelRig = (): void => {
  dropWorking();
  state = { ...IDLE, ...keptChoices() };
  for (const listener of listeners) listener();
};

export const setRigBothSides = (bothSides: boolean): void => setState({ bothSides });
export const setRigWithFingers = (withFingers: boolean): void => setState({ withFingers });
export const setRigWithTail = (withTail: boolean): void => setState({ withTail });
export const setActiveRigMarker = (activeMarker: RigMarkerName | null): void => setState({ activeMarker });

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
  state = { ...IDLE, ...keptChoices(), error: error instanceof Error ? error.message : fallback };
  for (const listener of listeners) listener();
};

/** Reads a model's file and its body, and puts the markers where it thinks the joints are. */
export const startRig = async (modelId: string, file: File, options: { convert?: ModelConvertOptions; images?: readonly File[] } = {}): Promise<void> => {
  dropWorking();
  const mine = session;
  setState({ ...IDLE, ...keptChoices(), stage: 'reading', modelId });
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

/** A marker's partner on the other side of the body, if it has one. */
const partnerOf = (name: RigMarkerName): RigMarkerName | null => {
  if (name.startsWith('left')) return `right${name.slice(4)}` as RigMarkerName;
  if (name.startsWith('right')) return `left${name.slice(5)}` as RigMarkerName;
  return null;
};

/** Reads the model again as another kind of body, or turned the other way: anything moved so far no longer holds. */
const readAgain = async (kind: BodyKind, facing?: [number, number]): Promise<void> => {
  const current = working;
  if (!current) return;
  const mine = session;
  setState({ stage: 'reading', activeMarker: null, error: null });
  try {
    const response = await askWorker(current.worker, { type: 'read', triangles: current.triangles, kind, facing });
    if (mine !== session) return;
    if (response.type !== 'read' || !response.reading) throw new Error('The model has no surface to read.');
    current.original = { ...response.reading.markers };
    current.moved = new Set();
    setState({ stage: 'placing', reading: response.reading, guessed: response.guessed });
  } catch (error) {
    if (mine === session) failRig(error, 'The model could not be read.');
  }
};

/** Reads the model as this kind of body. */
export const setRigBody = (kind: BodyKind): void => {
  if (state.reading?.kind !== kind) void readAgain(kind);
};

/** Reads the model again facing the other way, for a body that was read back to front. */
export const turnRigAround = (): void => {
  const { reading } = state;
  if (reading) void readAgain(reading.kind, [-reading.facing[0], -reading.facing[1]]);
};

/** Moves a marker to a place in the model's space, and its partner to match when both sides move together. */
export const moveRigMarker = (name: RigMarkerName, place: Point): void => {
  const { reading, bothSides } = state;
  if (!reading || !working) return;
  const markers = { ...reading.markers, [name]: place } as Record<string, Point>;
  working.moved.add(name);
  const partner = partnerOf(name);
  if (partner && bothSides) {
    // The body's middle runs through the groin or the hips as they were read, square to the way it faces.
    const middle = reading.kind === 'fourLegs' ? (working.original as typeof reading.markers).hips : (working.original as typeof reading.markers).groin;
    const [fx, fz] = reading.facing;
    const across: [number, number] = [fz, -fx];
    const away = (place[0] - middle[0]) * across[0] + (place[2] - middle[2]) * across[1];
    markers[partner] = [place[0] - 2 * away * across[0], place[1], place[2] - 2 * away * across[1]];
    working.moved.add(partner);
  }
  setState({ reading: { ...reading, markers } as RigReading });
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
      { type: 'rig', triangles: current.triangles, parts, reading, moved: [...current.moved], original: current.original, withFingers: state.withFingers, withTail: state.withTail },
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
