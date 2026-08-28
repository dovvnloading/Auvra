
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LoadedModelData } from '../types';
import { optimizeModelMaterials } from './processing/ModelMaterials';
import { normalizeModel } from './processing/ModelTransforms';
import { frontendDiagnostics } from '../diagnostics/runtime';

// Re-export specific utilities for consumers (hooks) to maintain API compatibility
export { disposeModel, disposeObject } from './processing/ModelLifecycle';
export { stripGeometry } from './processing/ModelTransforms';

export type ImportPhase =
  | 'source_read'
  | 'worker_creation'
  | 'fbx_structure_parse'
  | 'embedded_texture_decode'
  | 'runtime_asset_construction'
  | 'runtime_asset_transfer'
  | 'viewport_materialization'
  | 'material_optimization_normalization';

export const importPhaseLabel = (phase: ImportPhase): string => ({
  source_read: 'Reading source file',
  worker_creation: 'Starting background importer',
  fbx_structure_parse: 'Parsing FBX structure',
  embedded_texture_decode: 'Decoding embedded textures',
  runtime_asset_construction: 'Building runtime asset',
  runtime_asset_transfer: 'Transferring runtime asset',
  viewport_materialization: 'Creating viewport resources',
  material_optimization_normalization: 'Optimizing materials and scale',
}[phase]);

interface LoadOptions {
  normalize?: boolean;
  manualId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, phase: ImportPhase) => void;
  diagnostics?: { operationId: string; traceId: string; spanId?: string; assetAlias: string };
}

type WorkerResponse =
  | { type: 'progress'; progress: number; phase: ImportPhase; workerState: string }
  | { type: 'complete'; glb: ArrayBuffer; itemCount: number; clipCount: number }
  | { type: 'error'; message: string };

const abortError = (): DOMException => new DOMException('Asset import was cancelled.', 'AbortError');

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const parseFBXOffThread = async (
  file: File,
  signal?: AbortSignal,
  onProgress?: (progress: number, phase: ImportPhase) => void,
  diagnostics?: { operationId: string; traceId: string; spanId?: string; assetAlias: string },
): Promise<{ object: THREE.Group; animations: THREE.AnimationClip[]; itemCount: number; clipCount: number }> => {
  if (typeof Worker === 'undefined') throw new Error('Background FBX processing is unavailable in this environment.');
  throwIfAborted(signal);
  onProgress?.(0.03, 'source_read');
  const source = await file.arrayBuffer();
  throwIfAborted(signal);
  const worker = new Worker(new URL('../workers/fbxImport.worker.ts', import.meta.url), { type: 'module' });
  onProgress?.(0.08, 'worker_creation');
  if (diagnostics) frontendDiagnostics.record('worker', 'worker.phase', {
    phase: 'worker_creation', workerState: 'created', queueState: 'worker_active', assetAlias: diagnostics.assetAlias, progressBucket: 0,
  }, diagnostics);
  try {
    const converted = await new Promise<{ glb: ArrayBuffer; itemCount: number; clipCount: number }>((resolve, reject) => {
      const onAbort = () => {
        worker.terminate();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        if (diagnostics) frontendDiagnostics.record('worker', 'worker.failed', {
          phase: 'fbx_structure_parse', workerState: 'failed', assetAlias: diagnostics.assetAlias,
          code: 'worker_error', errorType: 'WorkerError',
        }, diagnostics, true);
        reject(new Error('Background FBX worker failed.'));
      };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === 'progress') {
          onProgress?.(message.progress, message.phase);
          if (diagnostics) frontendDiagnostics.record('worker', 'worker.phase', {
            phase: message.phase, workerState: message.workerState, queueState: 'worker_active', assetAlias: diagnostics.assetAlias,
            progressBucket: message.progress >= 0.75 ? 75 : message.progress >= 0.5 ? 50 : message.progress >= 0.25 ? 25 : 0,
          }, diagnostics);
          return;
        }
        signal?.removeEventListener('abort', onAbort);
        if (message.type === 'error') {
          if (diagnostics) frontendDiagnostics.record('worker', 'worker.failed', {
            phase: 'runtime_asset_construction', workerState: 'failed', assetAlias: diagnostics.assetAlias,
            code: 'worker_parse_failed', errorType: 'ImportError',
          }, diagnostics, true);
          reject(new Error(message.message));
        } else if (message.type === 'complete') {
          if (diagnostics) frontendDiagnostics.record('worker', 'worker.phase', {
            phase: 'runtime_asset_transfer', workerState: 'completed', assetAlias: diagnostics.assetAlias,
            progressBucket: 75, itemCount: message.itemCount, clipCount: message.clipCount,
          }, diagnostics);
          resolve(message);
        }
      };
      worker.postMessage({ type: 'parse', buffer: source }, [source]);
    });
    throwIfAborted(signal);
    onProgress?.(0.86, 'viewport_materialization');
    const loaded = await new GLTFLoader().parseAsync(converted.glb, '');
    throwIfAborted(signal);
    const object = loaded.scene;
    object.animations = loaded.animations;
    return { object, animations: loaded.animations, itemCount: converted.itemCount, clipCount: converted.clipCount };
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
    const parsed = await parseFBXOffThread(file, options.signal, options.onProgress, options.diagnostics);
    const object = parsed.object;

    // --- FILTER ANIMATIONS ---
    // Reject only empty/invalid clips. Short authored clips are valid assets.
    if (object.animations) {
       object.animations = object.animations.filter(
         clip => Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks.length > 0,
       );
    }

    // --- OPTIMIZE MATERIALS ---
    options.onProgress?.(0.91, 'material_optimization_normalization');
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
      options.onProgress?.(0.96, 'material_optimization_normalization');
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
    options.onProgress?.(1, 'material_optimization_normalization');

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
