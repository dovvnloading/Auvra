import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';
import { disposeModel, disposeObject, loadModelFile, readGltfSource } from '../modelLoader';
import type { LoadedModelData } from '../../types';
import { DEFAULT_SKIN_BINDING, type SkinBindingSettings } from './skinWeights';
import { clearPreviewWeights } from './previewWeights';
import { inspectRig, reviewBones, type RigReviewStats, type RigPose } from './rigReview';
import { fileName as nameInFile, readModelConventions } from '../modelConventions';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { Point } from './bodyMarkers';
import type { RigIkGoals, RigIkLimb } from './reviewIk';
import { guidePlanePosition, guidePointAt, guideStep, markerAt, RigGuideEdits } from './guideEditing';
import { isEditableTarget } from '../history';
import { captureGuideProfile, restoreGuideProfile, type RigGuideProfile } from './guideProfile';
import { bakedPositions, buildRiggedGlb, trianglesOf, type RigPrimitive, type RigShape } from './riggedGlb';
import type { BodyKind, RigMarkerName, RigMarkers, RigReading } from './rigBody';

export type { RigPose } from './rigReview';

/**
 * A model being given a skeleton: shared between the panel in the sidebar and the markers in the
 * viewport, which sit in different React roots, and alive until the skeleton is made or given up.
 */

export type RigStage = 'idle' | 'reading' | 'placing' | 'binding' | 'review' | 'saving';

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
  /** The selected guide stays selected when the pointer leaves. */
  activeMarker: RigMarkerName | null;
  frameRequest: number;
  canUndoGuides: boolean;
  canRedoGuides: boolean;
  editedGuides: readonly RigMarkerName[];
  /** How far the skeleton is along, from 0 to 1. */
  progress: number;
  error: string | null;
  binding: SkinBindingSettings;
  review: RigReviewStats | null;
  pose: RigPose;
  ikLimb: RigIkLimb;
  ikGoals: RigIkGoals;
  poseStrength: number;
  poseBone: string;
  poseAxis: 'x' | 'y' | 'z';
  poseAngle: number;
  showRigBones: boolean;
  inspectBone: string | null;
}

const IDLE: RigSessionState = {
  stage: 'idle', modelId: null, reading: null, guessed: false, bothSides: true, withFingers: true, withTail: true,
  activeMarker: null, canUndoGuides: false, canRedoGuides: false, editedGuides: [], frameRequest: 0, progress: 0, error: null,
  binding: DEFAULT_SKIN_BINDING, review: null, pose: 'rest', ikLimb: 'leftHand', ikGoals: {}, poseStrength: 1, poseBone: 'Spine', poseAxis: 'x', poseAngle: 30,
  showRigBones: true, inspectBone: null,
};

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
  source: Awaited<ReturnType<typeof readGltfSource>>;
  controller: AbortController;
  preview?: { file: File; model: LoadedModelData; bones: ReturnType<typeof reviewBones> };
  primitives: RigPrimitive[];
  /** Its collision shapes, which go along with it. */
  shapes: RigShape[];
  triangles: Float32Array;
  /** The markers as they were read, before any moved. */
  original: RigMarkers;
  guides: RigGuideEdits;
  moved: Set<RigMarkerName>;
}

let working: Working | null = null;
let session = 0;
/** Aborts source decoding, the active worker request and preview materialization together. */
let controller: AbortController | null = null;
let sourceObject: THREE.Object3D | null = null;

const discardPreview = (current: Working): void => {
  if (!current.preview) return;
  const { model } = current.preview;
  clearPreviewWeights(model.object);
  const skeletons = new Set<THREE.Skeleton>();
  model.object.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  disposeModel(model);
  delete current.preview;
};

const dropWorking = (): void => {
  controller?.abort();
  controller = null;
  if (working) {
    discardPreview(working);
    working.worker.terminate();
    disposeObject(working.source.scene);
  }
  working = null;
  sourceObject = null;
  session += 1;
};

/** Choices that apply to the next model as well. */
const keptChoices = (): Pick<RigSessionState, 'bothSides' | 'withFingers' | 'withTail' | 'binding'> => ({
  bothSides: state.bothSides, withFingers: state.withFingers, withTail: state.withTail, binding: state.binding,
});

export const cancelRig = (): void => {
  dropWorking();
  state = { ...IDLE, ...keptChoices() };
  for (const listener of listeners) listener();
};

/** A rig belongs to one model revision even if its inspector tab is closed. */
export const syncRigTarget = (modelId: string | null, object: THREE.Object3D | null): void => {
  if (state.modelId === null) return;
  if (state.modelId !== modelId || (sourceObject && sourceObject !== object && state.stage !== 'saving')) cancelRig();
};

export const setRigBinding = (binding: SkinBindingSettings): void => {
  if (state.stage === 'placing') setState({ binding });
};
export const setRigBothSides = (bothSides: boolean): void => setState({ bothSides });
export const setRigWithFingers = (withFingers: boolean): void => setState({ withFingers });
export const setRigWithTail = (withTail: boolean): void => setState({ withTail });
export const frameRigGuides = (): void => {
  if (state.stage === 'placing') setState({ frameRequest: state.frameRequest + 1 });
};

export const setActiveRigMarker = (activeMarker: RigMarkerName | null): void => {
  if (state.stage !== 'placing' || !state.reading || (activeMarker && !markerAt(state.reading, activeMarker))) return;
  setState({ activeMarker });
};

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

const askWorker = (worker: Worker, request: AutoRigRequest, signal: AbortSignal, onProgress?: (share: number) => void): Promise<AutoRigResponse> => new Promise((resolve, reject) => {
  const clear = (): void => {
    worker.onmessage = null;
    worker.onerror = null;
    signal.removeEventListener('abort', stop);
  };
  const stop = (): void => {
    clear();
    reject(new DOMException('Rigging was cancelled.', 'AbortError'));
  };
  if (signal.aborted) { stop(); return; }
  signal.addEventListener('abort', stop, { once: true });
  worker.onerror = () => {
    clear();
    reject(new Error('The rigging worker stopped.'));
  };
  worker.onmessage = (event: MessageEvent<AutoRigResponse>) => {
    const message = event.data;
    if (message.type === 'progress') { onProgress?.(message.share); return; }
    clear();
    if (message.type === 'error') reject(new Error(message.message));
    else resolve(message);
  };
  try { worker.postMessage(request); } catch (error) { clear(); reject(error); }
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
  sourceObject = object;
  setState({ ...IDLE, ...keptChoices(), stage: 'reading', modelId });
  const reading = new AbortController();
  controller = reading;
  let pendingScene: THREE.Group | null = null;
  let pendingWorker: Worker | null = null;
  try {
    const source = await readGltfSource(file, { ...options, signal: reading.signal });
    pendingScene = source.scene;
    if (mine !== session) return;
    const conventions = readModelConventions(source.scene);
    const primitives = primitivesOf(source.scene, source.associations, new Set([...conventions.leftOut, ...conventions.shapes]));
    if (!primitives.length) throw new Error('The model has no mesh to rig.');
    const shapes = conventions.shapes.flatMap((shape) => primitivesOf(shape, source.associations).map((part): RigShape => ({ name: nameInFile(shape), positions: part.positions, indices: part.indices ? Uint32Array.from(part.indices) : null })));
    const triangles = trianglesOf(primitives);
    const worker = new Worker(new URL('../../workers/autoRig.worker.ts', import.meta.url), { type: 'module' });
    pendingWorker = worker;
    const response = await askWorker(worker, { type: 'read', triangles }, reading.signal);
    if (mine !== session) return;
    if (response.type !== 'read' || !response.reading) throw new Error('The model has no surface to read.');
    working = { worker, object, controller: reading, source, primitives, shapes, triangles, original: response.reading.markers, guides: new RigGuideEdits(response.reading), moved: new Set() };
    pendingScene = null;
    pendingWorker = null;
    setState({ stage: 'placing', reading: response.reading, guessed: response.guessed });
  } catch (error) {
    if (mine === session) failRig(error, 'The model could not be read.');
  } finally {
    pendingWorker?.terminate();
    if (pendingScene) disposeObject(pendingScene);
  }
};

/** Reads the model again as another kind of body, or turned the other way: anything moved so far no longer holds. */
const readAgain = async (kind: BodyKind, facing?: [number, number]): Promise<void> => {
  const current = working;
  if (state.stage !== 'placing' || !current) return;
  const mine = session;
  setState({ stage: 'reading', activeMarker: null, error: null });
  try {
    const response = await askWorker(current.worker, { type: 'read', triangles: current.triangles, kind, facing }, current.controller.signal);
    if (mine !== session) return;
    if (response.type !== 'read' || !response.reading) throw new Error('The model has no surface to read.');
    current.original = response.reading.markers;
    current.guides = new RigGuideEdits(response.reading);
    current.moved = new Set();
    setState({ stage: 'placing', reading: response.reading, guessed: response.guessed, editedGuides: [], canUndoGuides: false, canRedoGuides: false });
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

/** The worker uses the changed guide names to re-center only those limbs. */
const updateGuides = (edit: (guides: RigGuideEdits) => void): void => {
  if (state.stage !== 'placing' || !state.reading || !working) return;
  const guides = working.guides;
  const before = guides.markers;
  edit(guides);
  if (before === guides.markers && state.canUndoGuides === guides.canUndo && state.canRedoGuides === guides.canRedo) return;
  const editedGuides = guides.edited;
  working.moved = new Set(editedGuides);
  setState({
    reading: { ...state.reading, markers: guides.markers } as RigReading,
    editedGuides, canUndoGuides: guides.canUndo, canRedoGuides: guides.canRedo,
  });
};

export const getRigGuideProfile = (): RigGuideProfile | null => {
  if (state.stage !== 'placing' || !state.reading || !working) return null;
  return captureGuideProfile(state.reading, working.guides.original);
};

export const applyRigGuideProfile = (profile: RigGuideProfile): void => {
  if (state.stage !== 'placing' || !state.reading || !working) throw new Error('Fit the guides before applying a guide profile.');
  const markers = restoreGuideProfile(profile, state.reading, working.guides.original);
  updateGuides((guides) => guides.replace(markers));
};

export const beginRigGuideDrag = (): void => {
  if (state.stage === 'placing') working?.guides.beginDrag();
};
export const endRigGuideDrag = (cancel = false): void => updateGuides((guides) => guides.endDrag(cancel));
export const moveRigMarker = (name: RigMarkerName, place: Point): void =>
  updateGuides((guides) => guides.move(name, place, state.bothSides));
export const resetRigGuides = (name?: RigMarkerName): void => updateGuides((guides) => guides.reset(name, state.bothSides));
export const undoRigGuides = (): void => updateGuides((guides) => guides.undo());
export const redoRigGuides = (): void => updateGuides((guides) => guides.redo());

export const setRigGuidePosition = (name: RigMarkerName, horizontal: number, vertical: number): void => {
  if (state.stage !== 'placing' || !state.reading) return;
  const point = guidePointAt(state.reading, name, horizontal, vertical);
  if (point) moveRigMarker(name, point);
};

export const nudgeRigGuide = (xSteps: number, ySteps: number, fine = false): void => {
  const { reading, activeMarker } = state;
  if (state.stage !== 'placing' || !reading || !activeMarker) return;
  const position = guidePlanePosition(reading, activeMarker);
  if (!position) return;
  const step = guideStep(reading) * (fine ? 0.1 : 1);
  setRigGuidePosition(activeMarker, position[0] + xSteps * step, position[1] + ySteps * step);
};

/** Called only from the rig inspector or focused canvas, to leave the rest of the editor's keys alone. */
export const handleRigGuideKey = (event: KeyboardEvent): void => {
  if (state.stage !== 'placing' || isEditableTarget(event.target) || event.altKey || event.defaultPrevented) return;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    if (key === 'z' && !event.shiftKey) undoRigGuides();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) redoRigGuides();
    else return;
  } else if (state.activeMarker) {
    if (key === 'arrowleft') nudgeRigGuide(-1, 0, event.shiftKey);
    else if (key === 'arrowright') nudgeRigGuide(1, 0, event.shiftKey);
    else if (key === 'arrowup') nudgeRigGuide(0, 1, event.shiftKey);
    else if (key === 'arrowdown') nudgeRigGuide(0, -1, event.shiftKey);
    else return;
  } else return;
  event.preventDefault();
  event.stopPropagation();
};

const sameSource = (current: Working, object: THREE.Object3D): boolean => {
  if (current.object === object) return true;
  failRig(new Error('The source model changed. Fit its guides again.'), 'The source model changed.');
  return false;
};

/** Bind once and load the exact GLB that Apply will persist, through the normal model importer. */
export const previewRig = async (fileName: string, object: THREE.Object3D): Promise<void> => {
  const current = working;
  const { reading, binding } = state;
  if (state.stage !== 'placing' || !current || !reading || !sameSource(current, object)) return;
  endRigGuideDrag();
  const mine = session;
  setState({ stage: 'binding', progress: 0, error: null });
  let pendingModel: LoadedModelData | null = null;
  try {
    const parts = current.primitives.map((part) => ({ positions: part.positions, indices: part.indices }));
    const response = await askWorker(
      current.worker,
      { type: 'rig', triangles: current.triangles, parts, reading, moved: [...current.moved], original: current.original, withFingers: state.withFingers, withTail: state.withTail, binding },
      current.controller.signal,
      (share) => { if (mine === session) setState({ progress: share * 0.9 }); },
    );
    if (mine !== session) return;
    if (response.type !== 'rigged') throw new Error('The body could not be rigged.');
    const review = inspectRig(response.joints, parts, response.weights, binding.maxInfluences);
    const glb = buildRiggedGlb(current.source, current.primitives, response.joints, response.weights, current.shapes);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const file = new File([glb], `${stem}.glb`, { type: 'model/gltf-binary' });
    pendingModel = await loadModelFile(file, { normalize: false, compressTextures: false, signal: current.controller.signal });
    if (mine !== session) return;
    const bones = reviewBones(pendingModel.object, response.joints);
    current.preview = { file, model: pendingModel, bones };
    pendingModel = null;
    setState({ stage: 'review', review, pose: 'rest', ikLimb: 'leftHand', ikGoals: {}, poseStrength: 1, poseBone: review.boneNames.includes('Spine') ? 'Spine' : review.boneNames[0], inspectBone: null, progress: 1 });
  } catch (error) {
    if (mine !== session) return;
    frontendDiagnostics.failure('auto_rig_failed', error);
    setState({ stage: 'placing', progress: 0, error: error instanceof Error ? error.message : 'The body could not be rigged.' });
  } finally {
    if (pendingModel) disposeModel(pendingModel);
  }
};

export const getRigPreview = (modelId: string, root: THREE.Object3D) =>
  (state.stage === 'review' || state.stage === 'saving') && state.modelId === modelId && working?.object === root ? working.preview : undefined;

export const reviewedRigFile = (object: THREE.Object3D): File | null =>
  state.stage === 'review' && working?.object === object ? working.preview?.file ?? null : null;

export const setRigIkLimb = (ikLimb: RigIkLimb): void => {
  if (state.stage === 'review' && state.pose === 'ik') setState({ ikLimb });
};

export const setRigIkGoal = (limb: RigIkLimb, point: Point): void => {
  if (state.stage !== 'review' || state.pose !== 'ik' || state.ikLimb !== limb || !point.every(Number.isFinite)) return;
  setState({ ikGoals: { ...state.ikGoals, [limb]: point } });
};

export const resetRigIkGoal = (limb?: RigIkLimb): void => {
  if (state.stage !== 'review' || state.pose !== 'ik') return;
  const ikGoals = limb ? { ...state.ikGoals } : {};
  if (limb) delete ikGoals[limb];
  setState({ ikGoals });
};

export const setRigPoseBone = (poseBone: string): void => {
  if (state.stage === 'review' && state.review?.boneNames.includes(poseBone)) setState({ poseBone });
};
export const setRigPoseAxis = (poseAxis: 'x' | 'y' | 'z'): void => {
  if (state.stage === 'review') setState({ poseAxis });
};
export const setRigPoseAngle = (poseAngle: number): void => {
  if (state.stage === 'review' && Number.isFinite(poseAngle)) setState({ poseAngle: THREE.MathUtils.clamp(poseAngle, -90, 90) });
};
export const setRigPose = (pose: RigPose): void => {
  if (state.stage === 'review') setState({ pose });
};
export const setRigPoseStrength = (poseStrength: number): void => {
  if (state.stage === 'review' && Number.isFinite(poseStrength)) setState({ poseStrength: THREE.MathUtils.clamp(poseStrength, 0, 1) });
};
export const setShowRigBones = (showRigBones: boolean): void => {
  if (state.stage === 'review') setState({ showRigBones });
};
export const setRigInspectBone = (inspectBone: string | null): void => {
  if (state.stage === 'review' && (inspectBone === null || state.review?.boneNames.includes(inspectBone))) setState({ inspectBone });
};

export const reviseRig = (): void => {
  if (state.stage !== 'review' || !working) return;
  discardPreview(working);
  setState({ stage: 'placing', progress: 0, review: null, inspectBone: null, pose: 'rest', error: null });
};

/** Only the last reviewed file can be applied. Posing and inspecting its scene never change its bytes. */
export const finishRig = async (_fileName: string, object: THREE.Object3D): Promise<File | null> => {
  if (state.stage !== 'review' || !working?.preview || !sameSource(working, object)) return null;
  const { file } = working.preview;
  setState({ stage: 'saving', error: null });
  return file;
};

export const rigNotSaved = (message?: string): void => {
  if (state.stage === 'saving') setState({ stage: 'review', error: message || 'The skeleton could not be saved. You can retry with this preview.' });
};

export const completeRigSave = (file: File, success: boolean, message?: string): void => {
  if (state.stage !== 'saving' || file !== working?.preview?.file) return;
  if (success) cancelRig();
  else rigNotSaved(message);
};
