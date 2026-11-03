import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';
import { readGltfSource } from '../modelLoader';
import { fileName as nameInFile, readModelConventions } from '../modelConventions';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { BodyMarkers, BodyReading, MarkerName, Point } from './bodyMarkers';
import { bakedPositions, buildRiggedGlb, trianglesOf, type RigPrimitive, type RigShape, type RigSource } from './riggedGlb';

/**
 * A model being given a skeleton: shared between the panel in the sidebar and the markers in the
 * viewport, which sit in different React roots, and alive until the skeleton is made or given up.
 */

export type RigStage = 'idle' | 'reading' | 'placing' | 'binding' | 'saving';

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
  /** The model's object when its file was read: a reimport replaces it, and the file with it. */
  object: THREE.Object3D;
  source: RigSource;
  primitives: RigPrimitive[];
  /** Its collision shapes, which go along with it. */
  shapes: RigShape[];
  triangles: Float32Array;
  /** The markers as they were read, before any moved. */
  original: BodyMarkers;
  moved: Set<MarkerName>;
}

let working: Working | null = null;
let session = 0;
/** Stops a read under way, while there is nothing in `working` yet. */
let stopReading: (() => void) | null = null;

const dropWorking = (): void => {
  stopReading?.();
  stopReading = null;
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

/** Whether `object` is one of `nodes` or under one. */
const isUnder = (object: THREE.Object3D, nodes: ReadonlySet<THREE.Object3D>): boolean => {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (nodes.has(node)) return true;
  return false;
};

/** The primitives of the geometry under `root`, but for what `skip` holds, in the document's space. */
const primitivesOf = (root: THREE.Object3D, associations: Awaited<ReturnType<typeof readGltfSource>>['associations'], skip: ReadonlySet<THREE.Object3D> = new Set()): RigPrimitive[] => {
  const primitives: RigPrimitive[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (isUnder(object, skip)) return;
    const part = object as Partial<THREE.InstancedMesh & THREE.Line & THREE.Points>;
    // Writing the file anew would lose them, so nothing is changed instead.
    if (part.isInstancedMesh || part.isLine || part.isPoints) throw new Error('This model has instanced parts or lines, which a skeleton cannot carry, so it was left as it is.');
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

/** Ends the session, saying why: to the panel of the model it was for, and no other. */
export const failRig = (error: unknown, fallback: string, modelId: string | null = state.modelId): void => {
  frontendDiagnostics.failure('auto_rig_read_failed', error);
  dropWorking();
  state = { ...IDLE, bothSides: state.bothSides, withFingers: state.withFingers, modelId, error: error instanceof Error ? error.message : fallback };
  for (const listener of listeners) listener();
};

/**
 * Reads a model's file and its body, and puts the markers where it thinks the joints are. `object`
 * is the model as it is now. Only what the model draws counts as its body: its collision shapes go
 * along as they are, and what the import leaves out goes.
 */
export const startRig = async (modelId: string, object: THREE.Object3D, file: File, options: { convert?: ModelConvertOptions; images?: readonly File[] } = {}): Promise<void> => {
  dropWorking();
  const mine = session;
  setState({ ...IDLE, bothSides: state.bothSides, withFingers: state.withFingers, stage: 'reading', modelId });
  const reading = new AbortController();
  stopReading = () => reading.abort();
  try {
    const source = await readGltfSource(file, { ...options, signal: reading.signal });
    if (mine !== session) return;
    const conventions = readModelConventions(source.scene);
    const primitives = primitivesOf(source.scene, source.associations, new Set([...conventions.leftOut, ...conventions.shapes]));
    if (!primitives.length) throw new Error('The model has no mesh to rig.');
    const shapes = conventions.shapes.flatMap((shape) => primitivesOf(shape, source.associations).map((part): RigShape => ({ name: nameInFile(shape), positions: part.positions, indices: part.indices ? Uint32Array.from(part.indices) : null })));
    const triangles = trianglesOf(primitives);
    const worker = new Worker(new URL('../../workers/autoRig.worker.ts', import.meta.url), { type: 'module' });
    stopReading = () => worker.terminate();
    const response = await askWorker(worker, { type: 'read', triangles });
    if (mine !== session) return;
    if (response.type !== 'read' || !response.reading) throw new Error('The model has no surface to read.');
    stopReading = null;
    working = { worker, object, source, primitives, shapes, triangles, original: { ...response.reading.markers }, moved: new Set() };
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
    // The body's middle runs through the groin, square to the way it faces.
    const middle = reading.markers.groin;
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
 * file, to be saved. `object` is the model as it is now. The session goes on until that is known, for
 * the markers not to be lost: `cancelRig` once saved, or `rigNotSaved`.
 */
export const finishRig = async (fileName: string, object: THREE.Object3D): Promise<File | null> => {
  const current = working;
  const { reading } = state;
  if (!current || !reading) return null;
  if (current.object !== object) {
    failRig(new Error('The model was reimported after its body was read, so its skeleton has to be started again.'), 'The model has changed.');
    return null;
  }
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
    const glb = buildRiggedGlb(current.source, current.primitives, response.joints, response.weights, current.shapes);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const file = new File([glb], `${stem}.glb`, { type: 'model/gltf-binary' });
    setState({ stage: 'saving', progress: 1 });
    return file;
  } catch (error) {
    if (mine !== session) return null;
    frontendDiagnostics.failure('auto_rig_failed', error);
    setState({ stage: 'placing', progress: 0, error: error instanceof Error ? error.message : 'The body could not be rigged.' });
    return null;
  }
};

/** The rigged file could not be saved: back to the markers, as they were. */
export const rigNotSaved = (): void => setState({ stage: 'placing', progress: 0, error: 'The skeleton was not saved. The message that came up says why.' });
