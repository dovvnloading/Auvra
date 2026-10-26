import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LoadedModelData } from '../types';
import { optimizeModelMaterials } from './processing/ModelMaterials';
import { normalizeModel } from './processing/ModelTransforms';
import { disposeObject } from './processing/ModelLifecycle';
import { frontendDiagnostics } from '../diagnostics/runtime';

// Re-export specific utilities for consumers (hooks) to maintain API compatibility
export { disposeModel, disposeObject } from './processing/ModelLifecycle';
export { stripGeometry } from './processing/ModelTransforms';

export type ImportPhase =
  | 'source_read'
  | 'worker_creation'
  | 'fbx_structure_parse'
  | 'model_structure_parse'
  | 'embedded_texture_decode'
  | 'runtime_asset_construction'
  | 'runtime_asset_transfer'
  | 'viewport_materialization'
  | 'material_optimization_normalization';

export const importPhaseLabel = (phase: ImportPhase): string => ({
  source_read: 'Reading source file',
  worker_creation: 'Starting background importer',
  fbx_structure_parse: 'Parsing FBX structure',
  model_structure_parse: 'Parsing model structure',
  embedded_texture_decode: 'Decoding embedded textures',
  runtime_asset_construction: 'Building runtime asset',
  runtime_asset_transfer: 'Transferring runtime asset',
  viewport_materialization: 'Creating viewport resources',
  material_optimization_normalization: 'Optimizing materials and scale',
}[phase]);

// --- MODEL FORMATS ---

export type ModelFormat = 'fbx' | 'glb' | 'gltf' | 'obj';

/** MIME type recorded for each importable model format. */
export const MODEL_MIME_TYPES: Readonly<Record<ModelFormat, string>> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  fbx: 'model/fbx',
};

/** Importable model extensions; MODEL_FILE_ACCEPT is ready for an `<input accept>`. */
export const MODEL_FILE_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj'] as const;
export const MODEL_FILE_ACCEPT = MODEL_FILE_EXTENSIONS.join(',');

const MODEL_EXTENSION_PATTERN = /\.(fbx|glb|gltf|obj)$/i;

export const modelFormatFromName = (name: string): ModelFormat | null => {
  const match = MODEL_EXTENSION_PATTERN.exec(name.trim());
  return match ? match[1].toLowerCase() as ModelFormat : null;
};

export const modelFormatFromMimeType = (mimeType: string | undefined): ModelFormat | null => {
  const essence = (mimeType || '').split(';')[0].trim().toLowerCase();
  const entry = (Object.entries(MODEL_MIME_TYPES) as Array<[ModelFormat, string]>).find(([, type]) => type === essence);
  return entry ? entry[0] : null;
};

/** The format named by a file's extension, else by its MIME type; null when neither is a model. */
export const detectModelFormat = (file: { name: string; type?: string }): ModelFormat | null =>
  modelFormatFromName(file.name) ?? modelFormatFromMimeType(file.type);

export const isSupportedModelFile = (file: { name: string; type?: string }): boolean => detectModelFormat(file) !== null;

/** Recognises a model from its leading bytes when neither name nor MIME type says what it is. */
export const sniffModelFormat = (source: ArrayBuffer): ModelFormat | null => {
  const head = String.fromCharCode(...new Uint8Array(source, 0, Math.min(source.byteLength, 32)));
  if (head.startsWith('glTF')) return 'glb';
  if (head.startsWith('Kaydara FBX Binary')) return 'fbx';
  if (/^\s*;\s*FBX/.test(head)) return 'fbx';
  if (/^\s*\{/.test(head)) return 'gltf';
  return null;
};

export interface ModelLoadOptions {
  normalize?: boolean;
  /** Largest dimension after normalization; omitted keeps the normalizer's own size (5). */
  targetSize?: number;
  manualId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, phase: ImportPhase) => void;
  diagnostics?: { operationId: string; traceId: string; spanId?: string; assetAlias: string };
}

type WorkerFormat = 'fbx' | 'obj';

type WorkerResponse =
  | { type: 'progress'; progress: number; phase: ImportPhase; workerState: string }
  | { type: 'complete'; glb: ArrayBuffer; itemCount: number; clipCount: number }
  | { type: 'error'; message: string };

type ParsedGltf = Awaited<ReturnType<GLTFLoader['parseAsync']>>;

interface ParsedModel { object: THREE.Group; animations: THREE.AnimationClip[] }

const abortError = (): DOMException => new DOMException('Asset import was cancelled.', 'AbortError');

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

/**
 * Materializes glTF content into Three objects on this thread. GLTFLoader has
 * no AbortSignal parameter, so its parse is raced against cancellation:
 * callers stop waiting immediately, and a scene that finishes afterwards is
 * disposed. `release` runs once the parser itself has settled.
 */
const materializeGltf = async (data: ArrayBuffer | string, signal?: AbortSignal, release?: () => void): Promise<ParsedGltf> => {
  const parsedPromise = new GLTFLoader().parseAsync(data, '').then((loaded) => {
    if (signal?.aborted) {
      try { disposeObject(loaded.scene); } catch { /* best effort on cancellation */ }
      throw abortError();
    }
    return loaded;
  });
  // Promise.race observes the eventual parse rejection even if cancellation
  // wins first, preventing an unhandled rejection from a late parser.
  void parsedPromise.catch(() => undefined).finally(() => release?.());
  if (!signal) return parsedPromise;
  const cancelled = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    parsedPromise.then(
      () => signal.removeEventListener('abort', onAbort),
      () => signal.removeEventListener('abort', onAbort),
    );
  });
  return Promise.race([parsedPromise, cancelled]);
};

const parseOffThread = async (
  source: ArrayBuffer,
  format: WorkerFormat,
  signal?: AbortSignal,
  onProgress?: (progress: number, phase: ImportPhase) => void,
  diagnostics?: { operationId: string; traceId: string; spanId?: string; assetAlias: string },
): Promise<ParsedModel> => {
  const label = format.toUpperCase();
  const parsePhase: ImportPhase = format === 'fbx' ? 'fbx_structure_parse' : 'model_structure_parse';
  if (typeof Worker === 'undefined') throw new Error(`Background ${label} processing is unavailable in this environment.`);
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
          phase: parsePhase, workerState: 'failed', assetAlias: diagnostics.assetAlias,
          code: 'worker_error', errorType: 'WorkerError',
        }, diagnostics, true);
        reject(new Error(`Background ${label} worker failed.`));
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
      worker.postMessage({ type: 'parse', buffer: source, format }, [source]);
    });
    throwIfAborted(signal);
    onProgress?.(0.86, 'viewport_materialization');
    const loaded = await materializeGltf(converted.glb, signal);
    throwIfAborted(signal);
    const object = loaded.scene;
    object.animations = loaded.animations;
    return { object, animations: loaded.animations };
  } finally {
    worker.terminate();
  }
};

// --- NATIVE glTF / GLB ---

interface GltfResource { uri?: string; mimeType?: string }
interface GltfDocument {
  asset?: { version?: string };
  buffers?: GltfResource[];
  images?: GltfResource[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_JSON_CHUNK = 0x4e4f534a; // 'JSON'

// The decoders these extensions need are not bundled (they are WASM/JS
// payloads the editor CSP does not load), so name the problem up front rather
// than failing deep inside GLTFLoader. Draco fails even when merely used; the
// others fall back to plain data unless they are required.
const UNSUPPORTED_GLTF_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'meshopt compression',
  KHR_texture_basisu: 'KTX2/Basis textures',
};

const invalidGltf = (detail: string): Error => new Error(`This file is not a valid glTF 2.0 model: ${detail}.`);

const parseGltfJson = (text: string): GltfDocument => {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw invalidGltf('its JSON could not be parsed'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalidGltf('its JSON is not an object');
  const document = json as GltfDocument;
  const major = Number.parseInt(String(document.asset?.version ?? ''), 10);
  if (major !== 2) throw new Error('Only glTF 2.0 models are supported; re-export as glTF 2.0.');
  for (const [extension, label] of Object.entries(UNSUPPORTED_GLTF_EXTENSIONS)) {
    const required = document.extensionsRequired?.includes(extension);
    const used = extension === 'KHR_draco_mesh_compression' && document.extensionsUsed?.includes(extension);
    if (required || used) throw new Error(`This glTF uses ${label}, which Auvra cannot decode yet. Re-export it without that compression.`);
  }
  return document;
};

const readGlb = (source: ArrayBuffer): { json: GltfDocument; jsonEnd: number } => {
  if (source.byteLength < 20) throw invalidGltf('the binary header is truncated');
  const view = new DataView(source);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw invalidGltf('the binary header is missing');
  if (view.getUint32(4, true) < 2) throw new Error('Only glTF 2.0 models are supported; re-export as glTF 2.0.');
  const jsonLength = view.getUint32(12, true);
  const jsonEnd = 20 + jsonLength;
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK || jsonEnd > source.byteLength) throw invalidGltf('the JSON chunk is malformed');
  return { json: parseGltfJson(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength))), jsonEnd };
};

const decodeDataUri = (uri: string): { bytes: Uint8Array<ArrayBuffer>; mimeType: string } => {
  const comma = uri.indexOf(',');
  if (comma < 0) throw invalidGltf('an embedded resource is malformed');
  const [mimeType, ...parameters] = uri.slice(5, comma).split(';');
  const payload = uri.slice(comma + 1);
  const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64');
  let binary: string;
  try {
    // Percent-decoding to code units (not UTF-8) keeps %XX bytes intact.
    binary = isBase64
      ? atob(payload.replace(/\s+/g, ''))
      : payload.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  } catch {
    throw invalidGltf('an embedded resource is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return { bytes, mimeType: mimeType || 'application/octet-stream' };
};

/**
 * Only self-contained glTF is importable: an imported File has no sibling
 * files to resolve. Embedded data: URIs are swapped for blob: URLs because the
 * editor and player CSPs allow blob: (not data:) for GLTFLoader's fetches.
 * Returns whether anything was rewritten; created URLs are pushed to `urls`.
 */
const embedGltfResources = (json: GltfDocument, urls: string[]): boolean => {
  let rewritten = false;
  const embed = (resource: GltfResource, kind: 'buffer' | 'image') => {
    if (resource.uri === undefined) return;
    if (!/^data:/i.test(resource.uri)) {
      const name = resource.uri.split(/[\\/]/).pop()?.slice(0, 80) || resource.uri.slice(0, 80);
      throw new Error(`This glTF references an external ${kind} file (${name}). Import it as .glb, or export the .gltf with embedded resources.`);
    }
    const { bytes, mimeType } = decodeDataUri(resource.uri);
    const url = URL.createObjectURL(new Blob([bytes], { type: resource.mimeType || mimeType }));
    urls.push(url);
    resource.uri = url;
    rewritten = true;
  };
  json.buffers?.forEach((buffer) => embed(buffer, 'buffer'));
  json.images?.forEach((image) => embed(image, 'image'));
  return rewritten;
};

/** Replaces a GLB's JSON chunk, keeping every following chunk byte for byte. */
const rebuildGlb = (source: ArrayBuffer, jsonEnd: number, json: GltfDocument): ArrayBuffer => {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = (jsonBytes.byteLength + 3) & ~3;
  const rest = new Uint8Array(source, jsonEnd);
  const output = new Uint8Array(20 + paddedLength + rest.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, GLB_JSON_CHUNK, true);
  output.set(jsonBytes, 20);
  output.fill(0x20, 20 + jsonBytes.byteLength, 20 + paddedLength);
  output.set(rest, 20 + paddedLength);
  return output.buffer;
};

const parseGltfNative = async (
  source: ArrayBuffer,
  format: 'glb' | 'gltf',
  signal?: AbortSignal,
  onProgress?: (progress: number, phase: ImportPhase) => void,
): Promise<ParsedModel> => {
  onProgress?.(0.12, 'model_structure_parse');
  const urls: string[] = [];
  const release = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url); };
  let data: ArrayBuffer | string;
  try {
    if (format === 'glb') {
      const { json, jsonEnd } = readGlb(source);
      data = embedGltfResources(json, urls) ? rebuildGlb(source, jsonEnd, json) : source;
    } else {
      const json = parseGltfJson(new TextDecoder().decode(source));
      embedGltfResources(json, urls);
      data = JSON.stringify(json);
    }
    throwIfAborted(signal);
  } catch (error) {
    release();
    throw error;
  }
  onProgress?.(0.4, 'viewport_materialization');
  const loaded = await materializeGltf(data, signal, release);
  throwIfAborted(signal);
  const object = loaded.scene;
  object.animations = loaded.animations;
  return { object, animations: loaded.animations };
};

/**
 * Authored glTF materials are already metal/rough PBR with correct colour
 * spaces, alpha modes and sidedness; the FBX repair heuristics would force
 * blended materials opaque and strip legitimate white emissive. Only enable
 * shadows, as every other import does.
 */
const prepareNativeGltfMaterials = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
};

const isGenericClipName = (name: string): boolean => {
  const trimmed = name.trim();
  return !trimmed || /mixamo\.com/i.test(trimmed) || /^take\s*0*\d+$/i.test(trimmed);
};

const nameAnimations = (animations: THREE.AnimationClip[], fileName: string, format: ModelFormat): void => {
  if (animations.length === 0) return;
  const cleanName = fileName.replace(MODEL_EXTENSION_PATTERN, '');
  if (format === 'fbx') {
    if (animations.length === 1) {
      // If strictly one animation, assume it belongs to the file and rename it to file name
      animations[0].name = cleanName;
    } else {
      // If multiple, only rename known generic names
      animations.forEach((clip, index) => {
        if (clip.name === 'Take 001' || clip.name === 'mixamo.com') {
          clip.name = `${cleanName} ${index + 1}`;
        }
      });
    }
    return;
  }
  // glTF clips carry authored names; only fill in missing or exporter-generic ones.
  animations.forEach((clip, index) => {
    if (isGenericClipName(clip.name)) clip.name = animations.length === 1 ? cleanName : `${cleanName} ${index + 1}`;
  });
};

/**
 * Orchestrates the loading of a model file (.fbx, .glb, .gltf or .obj).
 * 1. Picks the loader by extension, then MIME type, then leading bytes
 *    (FBX when nothing else matches). FBX and OBJ parse in a worker and
 *    arrive as a GLB handoff; glTF/GLB materialize directly on this thread.
 * 2. Cleanses and names animations (glTF clips keep their authored names).
 * 3. Optimizes FBX/OBJ materials (Phong -> Standard, PBR fixes).
 * 4. Normalizes scale and position (optional).
 */
export const loadModelFile = async (file: File, options: ModelLoadOptions = { normalize: true }): Promise<LoadedModelData> => {
  // Create object URL for the file
  const url = URL.createObjectURL(file);
  let object: THREE.Group | null = null;
  try {
    throwIfAborted(options.signal);
    options.onProgress?.(0.03, 'source_read');
    const source = await file.arrayBuffer();
    throwIfAborted(options.signal);
    const format = detectModelFormat(file) ?? sniffModelFormat(source) ?? 'fbx';

    // FBXLoader.load() fetches asynchronously but invokes its CPU-heavy
    // parse() synchronously on the calling renderer thread. FBX (and OBJ)
    // parse and compact conversion therefore happen in an isolated worker;
    // only the optimized GLB handoff is materialized into Three objects here.
    const parsed = format === 'glb' || format === 'gltf'
      ? await parseGltfNative(source, format, options.signal, options.onProgress)
      : await parseOffThread(source, format, options.signal, options.onProgress, options.diagnostics);
    object = parsed.object;

    // --- FILTER ANIMATIONS ---
    // Reject only empty/invalid clips. Short authored clips are valid assets.
    if (object.animations) {
       object.animations = object.animations.filter(
         clip => Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks.length > 0,
       );
    }

    // --- OPTIMIZE MATERIALS ---
    options.onProgress?.(0.91, 'material_optimization_normalization');
    if (format === 'glb' || format === 'gltf') prepareNativeGltfMaterials(object);
    else optimizeModelMaterials(object);

    // --- RENAME ANIMATIONS ---
    nameAnimations(object.animations || [], file.name, format);

    let initialScale: [number, number, number] = [1, 1, 1];

    if (options.normalize) {
      options.onProgress?.(0.96, 'material_optimization_normalization');
      initialScale = normalizeModel(object) as [number, number, number];
      const targetSize = options.targetSize;
      if (targetSize !== undefined && Number.isFinite(targetSize) && targetSize > 0) {
        // normalizeModel fits a fixed size with the base on y=0 and the
        // footprint centred; scaling scale and offset together about the
        // origin keeps that placement while fitting the requested size.
        const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
        const maxAxis = Math.max(size.x, size.y, size.z);
        if (maxAxis > 0 && Number.isFinite(maxAxis)) {
          const factor = targetSize / maxAxis;
          object.scale.multiplyScalar(factor);
          object.position.multiplyScalar(factor);
          object.updateMatrix();
          initialScale = object.scale.toArray() as [number, number, number];
        }
      }
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
      // Parsing can finish after cancellation or a later normalization step
      // can fail. The partially materialized scene is owned by this call until
      // it is returned, so release it before dropping the URL.
      if (object) {
        try { disposeObject(object); } catch { /* best effort during failure */ }
      }
      URL.revokeObjectURL(url);
      throw err;
  }
};

/** Historical name kept for existing callers; it loads every supported model format. */
export const loadFBXFile = loadModelFile;
