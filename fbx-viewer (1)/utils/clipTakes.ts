import * as THREE from 'three';
import type { LoadedModelData, ModelImportSettings } from '../types';
import { clipTake, clipTiming, takeLabel, wholeClips } from './clipRanges';
import type { ModelFileReport } from './fbxImport/nativeImporter';
import { detectModelFormat, nameAnimations, readGltfSource } from './modelLoader';
import { clonePreviewResources, disposePreviewResources } from './previewResources';
import { disposeObject } from './processing/ModelLifecycle';
import { convertOptionsFor } from './processing/ModelTransforms';

/**
 * What the clip editor works on: a file's takes whole, as they are before anything is cut from them,
 * and something to show them on.
 */

/** A take to cut clips from. */
export interface ClipTake {
  /** What a range calls its take: its name in the file, or for a clip imported onto the model, that clip's name. */
  id: string;
  /** It is a clip imported onto the model from a file of its own. */
  attached: boolean;
  label: string;
  clip: THREE.AnimationClip;
  /** Where the take starts on its file's timeline, in seconds. */
  start: number;
  framesPerSecond: number;
  /** The name its whole clip has, or would have. */
  clipName: string;
}

export interface ClipTakeSource {
  /** A copy to play the takes on, its own to pose. */
  object: THREE.Object3D;
  takes: ClipTake[];
  dispose: () => void;
}

/** Frames counted when a file does not say its rate, as glTF does not. */
const DEFAULT_FRAMES_PER_SECOND = 30;
/** The largest side of what the takes are shown on, whatever the file's unit. */
const PREVIEW_SIZE = 2;
const BONE_PADDING = 1.2;

/** Stands `object` on the floor at a size a fixed camera can frame, and keeps it drawn when its root walks away from where it was bound. */
const prepareToShow = (object: THREE.Object3D): void => {
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.scale.set(1, 1, 1);
  object.updateWorldMatrix(true, true);
  // A skinned mesh's own bounds only hold once it has been drawn; its bones hold now.
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  object.traverse((child) => {
    if ((child as THREE.Bone).isBone) bounds.expandByPoint(child.getWorldPosition(point));
    if ((child as THREE.Mesh).isMesh) child.frustumCulled = false;
  });
  const skinned = !bounds.isEmpty();
  if (!skinned) bounds.setFromObject(object);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) * (skinned ? BONE_PADDING : 1);
  if (!(largest > 0)) return;
  const scale = PREVIEW_SIZE / largest;
  const centre = bounds.getCenter(new THREE.Vector3());
  object.scale.setScalar(scale);
  object.position.set(-centre.x * scale, -bounds.min.y * scale, -centre.z * scale);
};

const usable = (clip: THREE.AnimationClip): boolean => Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks.length > 0;

const takesOfFile = (clips: readonly THREE.AnimationClip[], report: ModelFileReport | undefined, fileName: string): ClipTake[] => {
  const kept = clips.filter(usable);
  const names = kept.map((clip) => ({ name: clip.name }));
  nameAnimations(names, fileName, detectModelFormat({ name: fileName }) ?? 'fbx');
  return kept.map((clip, index) => ({
    id: clip.name,
    attached: false,
    label: takeLabel(clip.name),
    clip,
    start: report?.clips.find((read) => read.name === clip.name)?.start ?? 0,
    framesPerSecond: report?.framesPerSecond || DEFAULT_FRAMES_PER_SECOND,
    clipName: names[index].name,
  }));
};

/** How a file is read for its takes: as these settings read it, but with every take whole. */
const wholeTakesOptions = (settings: Partial<ModelImportSettings> | null | undefined) => {
  const { excludedClips: _left, clipRanges: _cut, animation: _on, ...convert } = convertOptionsFor(settings) ?? {};
  return { ...convert, tangents: false };
};

/** A file not imported yet: its takes, and its shape in plain grey to show them on. */
export const readFileTakes = async (file: File, settings: Partial<ModelImportSettings> | null | undefined, signal?: AbortSignal): Promise<ClipTakeSource> => {
  const source = await readGltfSource(file, { convert: wholeTakesOptions(settings), signal });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9a9fa6, roughness: 0.75 });
  source.scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = grey;
  });
  prepareToShow(source.scene);
  return {
    object: source.scene,
    takes: takesOfFile(source.animations, source.report, file.name),
    dispose: () => {
      disposeObject(source.scene);
      grey.dispose();
    },
  };
};

/**
 * An imported model: its file's takes, the clips imported onto it (`attached`, each under its name
 * on the model), and a copy of it to show them on, wearing what the model wears.
 */
export const readModelTakes = async (model: LoadedModelData, file: File, attached: readonly THREE.AnimationClip[], signal?: AbortSignal): Promise<ClipTakeSource> => {
  let own: ClipTake[] = [];
  if (model.importSettings?.animation !== false) {
    // The clips are all that is wanted of this read, and the model is there to show them on.
    const source = await readGltfSource(file, { convert: { ...wholeTakesOptions(model.importSettings), meshes: false }, signal });
    disposeObject(source.scene);
    own = takesOfFile(source.animations, source.report, model.name);
    const held = wholeClips(model.animations);
    for (const take of own) {
      const clip = held.find((candidate) => clipTake(candidate) === take.id);
      if (clip) take.clipName = clip.name;
    }
  }
  const copy = clonePreviewResources(model.object);
  prepareToShow(copy.object);
  const imported: ClipTake[] = attached.filter(usable).map((clip) => {
    const { start, framesPerSecond } = clipTiming(clip);
    return { id: clip.name, attached: true, label: clip.name, clip, start, framesPerSecond: framesPerSecond || DEFAULT_FRAMES_PER_SECOND, clipName: clip.name };
  });
  return { object: copy.object, takes: [...own, ...imported], dispose: () => disposePreviewResources(copy) };
};
