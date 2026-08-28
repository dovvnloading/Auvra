
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LoadedModelData } from '../types';
import { optimizeModelMaterials } from './processing/ModelMaterials';
import { normalizeModel } from './processing/ModelTransforms';

// Re-export specific utilities for consumers (hooks) to maintain API compatibility
export { disposeModel, disposeObject } from './processing/ModelLifecycle';
export { stripGeometry } from './processing/ModelTransforms';

interface LoadOptions {
  normalize?: boolean;
  manualId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, phase: string) => void;
}

type WorkerResponse =
  | { type: 'progress'; progress: number; phase: string }
  | { type: 'complete'; glb: ArrayBuffer }
  | { type: 'error'; message: string };

const abortError = (): DOMException => new DOMException('Asset import was cancelled.', 'AbortError');

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const parseFBXOffThread = async (
  file: File,
  signal?: AbortSignal,
  onProgress?: (progress: number, phase: string) => void,
): Promise<{ object: THREE.Group; animations: THREE.AnimationClip[] }> => {
  if (typeof Worker === 'undefined') throw new Error('Background FBX processing is unavailable in this environment.');
  throwIfAborted(signal);
  onProgress?.(0.03, 'Reading source file');
  const source = await file.arrayBuffer();
  throwIfAborted(signal);
  const worker = new Worker(new URL('../workers/fbxImport.worker.ts', import.meta.url), { type: 'module' });
  try {
    const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
      const onAbort = () => {
        worker.terminate();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('Background FBX worker failed.'));
      };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === 'progress') {
          onProgress?.(message.progress, message.phase);
          return;
        }
        signal?.removeEventListener('abort', onAbort);
        if (message.type === 'error') reject(new Error(message.message));
        else if (message.type === 'complete') resolve(message.glb);
      };
      worker.postMessage({ type: 'parse', buffer: source }, [source]);
    });
    throwIfAborted(signal);
    onProgress?.(0.86, 'Creating viewport resources');
    const loaded = await new GLTFLoader().parseAsync(glb, '');
    throwIfAborted(signal);
    const object = loaded.scene;
    object.animations = loaded.animations;
    return { object, animations: loaded.animations };
  } finally {
    worker.terminate();
  }
};

/**
 * Orchestrates the loading of an FBX file.
 * 1. Loads the file via FBXLoader.
 * 2. Cleanses animations.
 * 3. Optimizes materials (Phong -> Standard, PBR fixes).
 * 4. Normalizes scale and position (optional).
 */
export const loadFBXFile = async (file: File, options: LoadOptions = { normalize: true }): Promise<LoadedModelData> => {
  // Create object URL for the file
  const url = URL.createObjectURL(file);
  
  try {
    // FBXLoader.load() fetches asynchronously but invokes its CPU-heavy
    // parse() synchronously on the calling renderer thread. Parse and compact
    // conversion therefore happen in an isolated worker; only the optimized
    // GLB handoff is materialized into Three objects here.
    const parsed = await parseFBXOffThread(file, options.signal, options.onProgress);
    const object = parsed.object;

    // --- FILTER ANIMATIONS ---
    // Reject only empty/invalid clips. Short authored clips are valid assets.
    if (object.animations) {
       object.animations = object.animations.filter(
         clip => Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks.length > 0,
       );
    }

    // --- OPTIMIZE MATERIALS ---
    options.onProgress?.(0.91, 'Optimizing materials');
    optimizeModelMaterials(object);
    
    // --- RENAME ANIMATIONS ---
    if (object.animations && object.animations.length > 0) {
        const cleanName = file.name.replace(/\.(fbx|FBX)$/, '');
        
        if (object.animations.length === 1) {
             // If strictly one animation, assume it belongs to the file and rename it to file name
             object.animations[0].name = cleanName;
        } else {
             // If multiple, only rename known generic names
             object.animations.forEach((clip, index) => {
                if (clip.name === 'Take 001' || clip.name === 'mixamo.com') {
                    clip.name = `${cleanName} ${index + 1}`;
                }
             });
        }
    }
    
    let initialScale: [number, number, number] = [1, 1, 1];
    
    if (options.normalize) {
      options.onProgress?.(0.96, 'Normalizing model');
      initialScale = normalizeModel(object) as [number, number, number];
    } else {
      // For attachments, scale down only if massive (unit conversion artifact)
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxAxis = Math.max(size.x, size.y, size.z);
      if (maxAxis > 50) { // If it's huge (cm vs m), scale down
         object.scale.setScalar(0.01);
         initialScale = object.scale.toArray() as [number, number, number];
      }
    }

    throwIfAborted(options.signal);
    options.onProgress?.(1, 'Ready');

    return {
      id: options.manualId || crypto.randomUUID(),
      name: file.name,
      url, // Keep URL to revoke later
      object,
      animations: object.animations || [],
      category: 'Prop',
      isPlacedInScene: false,
      initialScale
    };

  } catch (err) {
      // Clean up URL if loading fails
      URL.revokeObjectURL(url);
      throw err;
  }
};
