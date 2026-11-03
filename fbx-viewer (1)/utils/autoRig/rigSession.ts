import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';
import { readGltfSource } from '../modelLoader';
import { fileName as nameInFile, readModelConventions } from '../modelConventions';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { Point } from './bodyMarkers';
import { bakedPositions, buildRiggedGlb, trianglesOf, type RigPrimitive, type RigShape, type RigSource } from './riggedGlb';
import type { BodyKind, RigMarkerName, RigMarkers, RigReading } from './rigBody';

/**
 * A model being given a skeleton: shared between the panel in the sidebar and the markers in the
 * viewport, which sit in different React roots, and alive until the skeleton is made or given up.
 */

export type RigStage = 'idle' | 'reading' | 'placing' | 'binding' | 'saving';

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
  /** The model's object when its file was read: a reimport replaces it, and the file with it. */
  object: THREE.Object3D;
  source: RigSource;
  primitives: RigPrimitive[];
  /** Its collision shapes, which go along with it. */
  shapes: RigShape[];
  triangles: Float32Array;
  /** The markers as they were read, before any moved. */
  original: RigMarkers;
  moved: Set<RigMarkerName>;
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
  state = { ...IDLE, ...keptChoices(), modelId, error: error instanceof Error ? error.message : fallback };
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
  setState({ ...IDLE, ...keptChoices(), stage: 'reading', modelId });
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
    // The body's middle runs through the groin or the hips, square to the way it faces.
    const middle = reading.kind === 'fourLegs' ? reading.markers.hips : reading.markers.groin;
    const [fx, fz] = reading.facing;
    const across: [number, number] = [fz, -fx];
    const away = (place[0] - middle[0]) * across[0] + (place[2] - middle[2]) * across[1];
    markers[partner] = [place[0] - 2 * away * across[0], place[1], place[2] - 2 * away * across[1]];
    working.moved.add(partner);
  }
  // The markers are the same kind of body's, so the reading stays that kind.
  setState({ reading: { ...reading, markers } as unknown as RigReading });
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
      { type: 'rig', triangles: current.triangles, parts, reading, moved: [...current.moved], original: current.original, withFingers: state.withFingers, withTail: state.withTail },
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
