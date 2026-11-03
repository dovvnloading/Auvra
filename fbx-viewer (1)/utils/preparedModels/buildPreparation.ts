import * as THREE from 'three';
import { frontendDiagnostics, type DiagnosticContext } from '../../diagnostics/runtime';
import { GAME_SETTINGS_DOCUMENT_ID, normalizeGameSettings } from '../../runtime/types';
import type { ModelConvertOptions } from '../../workers/fbxImport.worker';
import type { ModelPrepareRequest, ModelPrepareResponse } from '../../workers/modelPrepare.worker';
import { importerOptions } from '../clipRanges';
import { convertOffThread, detectModelFormat, modelFormatFromName, sniffModelFormat } from '../modelLoader';
import { convertOptionsFor } from '../processing/ModelTransforms';
import { projectService } from '../projectService';
import { TEXTURE_COMPRESSION_VERSION } from '../textureCompression/compressTextures';
import { PREPARED_MODEL_VERSION, type PreparedKind, type PreparedModels } from './format';

/**
 * Prepares a project's models for a build, one at a time in a worker, before the build is asked
 * for: the host handles one request at a time and holds its lock through a build, so nothing can be
 * uploaded during one. What the host already holds is not made again, whichever project made it.
 * Preparation never fails a build: a model it cannot prepare stays its source, and is reported.
 */

/** What fits in one host message. */
const MAX_PREPARED_MODELS = 1500;
const SHA256 = /^[A-Fa-f0-9]{64}$/;

export interface PreparedSource {
  assetId: string;
  kind: PreparedKind;
  name: string;
  /** How an FBX or OBJ is read, as loading it reads it: the importer's options and the images found beside it. */
  convert?: ModelConvertOptions;
  images?: { name: string; assetId: string }[];
  /** Documents read the file in different ways, so no one copy can stand in for it. */
  readDifferently?: boolean;
}

export interface ModelPreparation {
  /** What the build should put in the game; undefined when there is nothing. */
  prepared?: PreparedModels;
  /** The models that stay their source files, by name. */
  unprepared: string[];
}

export interface PrepareModelsOptions {
  signal?: AbortSignal;
  diagnostics?: DiagnosticContext;
  onProgress?: (progress: number, detail: string) => void;
}

const isAbort = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === 'AbortError';

const documentsOf = async (domain: string, diagnostics?: DiagnosticContext): Promise<Array<Record<string, any>>> => {
  const raw = (await projectService.getSnapshotAll(domain, diagnostics))?.domains?.[domain];
  return Array.isArray(raw) ? raw.filter((value) => value && typeof value === 'object') : [];
};

/** A value with its objects' keys in order, so two readings that are the same write the same. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
};

/**
 * How a document has its file read, the way loading it does (utils/projectHydration): a model by its
 * import settings and with the images found beside it, an attachment or a clip file as it comes.
 * A glTF comes as it is.
 */
const readingOf = (document: Record<string, any>, domain: 'models' | 'attachments' | 'animations', name: string): Pick<PreparedSource, 'convert' | 'images'> => {
  const format = modelFormatFromName(name);
  if (domain !== 'models' || format === 'glb' || format === 'gltf') return {};
  const convert = importerOptions(convertOptionsFor(document.category === 'Animation' ? undefined : document.importSettings));
  const images = Array.isArray(document.sourceImages)
    ? document.sourceImages.map((image: Record<string, unknown>) => ({ name: String(image?.name), assetId: String(image?.assetId) }))
    : [];
  return { ...(convert ? { convert } : {}), ...(images.length ? { images } : {}) };
};

const readingKey = (source: Pick<PreparedSource, 'convert' | 'images'>): string =>
  JSON.stringify([canonical(source.convert ?? null), (source.images ?? []).map((image) => [image.name, image.assetId])]);

/**
 * The model files a project's documents use, one entry per file. A file used both as a model and
 * for its clips keeps what a model keeps, which holds its clips too. A file its documents read in
 * different ways is marked, as one prepared copy would be right for only some of them.
 */
export const preparedModelSources = (domains: { models: Array<Record<string, any>>; attachments: Array<Record<string, any>>; animations: Array<Record<string, any>> }): PreparedSource[] => {
  const sources = new Map<string, PreparedSource>();
  const add = (document: Record<string, any>, kind: PreparedKind, fallbackName: string, domain: 'models' | 'attachments' | 'animations') => {
    const assetId = document.assetId;
    if (typeof assetId !== 'string' || !SHA256.test(assetId)) return;
    const name = typeof document.name === 'string' ? document.name : fallbackName;
    const reading = readingOf(document, domain, name);
    const known = sources.get(assetId);
    if (!known) {
      sources.set(assetId, { assetId, kind, name, ...reading });
      return;
    }
    if (readingKey(known) !== readingKey(reading)) known.readDifferently = true;
    if (known.kind === 'animation' && kind === 'model') {
      known.kind = kind;
      known.name = name;
    }
  };
  for (const document of domains.models) add(document, document.category === 'Animation' ? 'animation' : 'model', 'model.fbx', 'models');
  for (const document of domains.attachments) add(document, 'model', 'attachment.fbx', 'attachments');
  for (const document of domains.animations) add(document, 'animation', 'animation.fbx', 'animations');
  return [...sources.values()];
};

/**
 * Names a prepared model by what went into it, the way its file is read included. Renames,
 * overrides, clip ranges and the build target stay out, because none of them is baked: changing
 * them prepares nothing again.
 */
export const preparedModelKey = async (source: Pick<PreparedSource, 'assetId' | 'kind' | 'convert' | 'images'>, textureCompression: boolean, meshLod: boolean): Promise<string> => {
  const parts = [PREPARED_MODEL_VERSION, TEXTURE_COMPRESSION_VERSION, THREE.REVISION, source.kind, source.assetId, textureCompression, meshLod, readingKey(source)];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const prepareInWorker = (request: ModelPrepareRequest, signal?: AbortSignal): Promise<ModelPrepareResponse> => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('../../workers/modelPrepare.worker.ts', import.meta.url), { type: 'module' });
  const finish = (settle: () => void) => {
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
    settle();
  };
  const onAbort = () => finish(() => reject(new DOMException('Model preparation was cancelled.', 'AbortError')));
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.onerror = () => finish(() => reject(new Error('The model preparation worker failed.')));
  worker.onmessage = (event: MessageEvent<ModelPrepareResponse>) => finish(() => resolve(event.data));
  worker.postMessage(request, [request.glb]);
});

/** One model's prepared bytes, or null when this version does not prepare it. */
const prepareModelFile = async (
  source: PreparedSource,
  quality: { textureCompression: boolean; meshLod: boolean },
  { signal, diagnostics }: PrepareModelsOptions,
): Promise<ArrayBuffer | null> => {
  // A large file comes a piece at a time, as the editor reads any stored file.
  const response = await projectService.fetchAsset(source.assetId, { signal, diagnostics });
  if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const format = detectModelFormat({ name: source.name, type: response.headers.get('Content-Type') ?? undefined }) ?? sniffModelFormat(bytes) ?? 'fbx';
  const reads = format === 'fbx' || format === 'obj';
  const images = reads ? await Promise.all((source.images ?? []).map(async (image) => {
    const found = await projectService.fetchAsset(image.assetId, { signal, diagnostics });
    if (!found.ok) throw new Error(`Asset download failed (${found.status})`);
    return new File([await found.blob()], image.name, { type: found.headers.get('Content-Type') || 'application/octet-stream' });
  })) : [];
  // Read as loading reads it, so the copy holds what the source would: the importer welds as it goes.
  const converted = reads ? await convertOffThread(bytes, format, signal, undefined, undefined, source.name, source.convert, images) : null;
  const reply = await prepareInWorker({
    glb: converted?.glb ?? bytes,
    format: format === 'gltf' ? 'gltf' : 'glb',
    options: {
      kind: source.kind,
      sourceFormat: format,
      metresPerUnit: converted?.metresPerUnit ?? null,
      missingTextures: converted?.missingTextures.length ?? 0,
      ...(converted ? { report: converted.report } : {}),
      ...quality,
    },
    textureVersion: TEXTURE_COMPRESSION_VERSION,
  }, signal);
  if (reply.type === 'error') throw new Error(reply.message);
  return reply.type === 'complete' ? reply.glb : null;
};

const prepareAll = async (options: PrepareModelsOptions): Promise<ModelPreparation> => {
  const { signal, diagnostics, onProgress } = options;
  const [metadata, models, attachments, animations] = await Promise.all(['metadata', 'models', 'attachments', 'animations'].map((domain) => documentsOf(domain, diagnostics)));
  const { textureCompression, meshLod } = normalizeGameSettings(metadata.find((document) => document?.id === GAME_SETTINGS_DOCUMENT_ID)?.settings).quality;
  const found = preparedModelSources({ models, attachments, animations });
  if (!found.length) return { unprepared: [] };
  const sources = found.filter((source) => !source.readDifferently);
  const chosen = sources.slice(0, MAX_PREPARED_MODELS);
  const unprepared = [...found.filter((source) => source.readDifferently), ...sources.slice(MAX_PREPARED_MODELS)].map((source) => source.name);
  const entries = await Promise.all(chosen.map(async (source) => ({ source, key: await preparedModelKey(source, textureCompression, meshLod) })));
  const held = new Set(await projectService.queryPreparedModels(entries.map(({ key }) => key), diagnostics));
  const missing = entries.filter(({ key }) => !held.has(key));
  for (const [index, { source, key }] of missing.entries()) {
    onProgress?.(index / missing.length, `Preparing ${source.name}`);
    try {
      const prepared = await prepareModelFile(source, { textureCompression, meshLod }, options);
      if (prepared) {
        await projectService.uploadPreparedModel(key, prepared, { signal, diagnostics });
        held.add(key);
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      frontendDiagnostics.failure('model_preparation_failed', error);
    }
  }
  unprepared.unshift(...entries.filter(({ key }) => !held.has(key)).map(({ source }) => source.name));
  const included = entries.filter(({ key }) => held.has(key)).map(({ source, key }) => ({ source: source.assetId, asset: key }));
  return {
    unprepared,
    ...(included.length ? { prepared: { version: PREPARED_MODEL_VERSION, textures: textureCompression ? 'bc' as const : 'none' as const, models: included } } : {}),
  };
};

/** Prepares what the host does not hold yet. Only cancelling rejects. */
export const prepareModelsForBuild = async (options: PrepareModelsOptions = {}): Promise<ModelPreparation> => {
  try {
    return await prepareAll(options);
  } catch (error) {
    if (isAbort(error)) throw error;
    frontendDiagnostics.failure('model_preparation_failed', error);
    return { unprepared: ['every model'] };
  }
};

/**
 * What to tell the user about models that stayed their source files, if any: those preparation
 * gave up on and those the build could not use, since the host's warnings do not reach the editor.
 */
export const unpreparedNotice = (preparation: ModelPreparation, report: Record<string, unknown> | undefined): string | null => {
  const asked = preparation.prepared?.models.length ?? 0;
  const used = typeof report?.preparedModels === 'number' ? report.preparedModels : asked;
  const notes = [...preparation.unprepared];
  if (used < asked) notes.push(`${asked - used} more the build could not use`);
  if (!notes.length) return null;
  const listed = notes.slice(0, 3).join(', ') + (notes.length > 3 ? ` and ${notes.length - 3} more` : '');
  return `Not every model could be prepared, so the game loads these from their source files: ${listed}.`;
};
