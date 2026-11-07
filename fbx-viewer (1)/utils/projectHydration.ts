import type { AttachmentData, AudioData, Blueprint, LevelData, LevelObject, LoadedModelData, ModelSourceImage, PrefabData, SocketData, TerrainData, TextureData } from '../types';
import { importFailureMessage, importPhaseLabel, loadFBXFile, type ModelLoadOptions } from './modelLoader';
import { resolveTerrainHeightfield } from './terrainHeightfield';
import { isTerrainHeightfieldPending } from './terrainHeightfieldCodec';
import { resolveTerrainHolemap, resolveTerrainSplatmap } from '../components/Environment/Terrain/terrainSplat';
import { isTerrainHolesPending, isTerrainSplat2Pending, isTerrainSplatPending } from '../components/Environment/Terrain/terrainSplatCodec';
import { isFoliageTypePending, resolveFoliageInstances } from '../runtime/foliage';
import { applyModelImportSettings, convertOptionsFor, stripGeometry } from './processing/ModelTransforms';
import { generateThumbnail } from './thumbnailGenerator';
import { disposeModel, disposeObject } from './processing/ModelLifecycle';
import { applyStoredClipNames, mirrorModelClips, prepareAnimationClips } from './animationBinding';
import { cutAttachedClips, noteAttachedClips, wholeClips } from './clipRanges';
import { hydrateMaterialOverrides } from './materialOverrides';
import {
  assetDiagnosticAttributes,
  diagnosticErrorType,
  frontendDiagnostics,
  type DiagnosticAttributes,
  type DiagnosticContext,
} from '../diagnostics/runtime';
import {
  GAME_SETTINGS_DOCUMENT_ID,
  normalizeGameSettings,
  type GameContent,
  type HUDDocumentData,
  type LoadedGameContent,
  type RefusedModel,
} from '../runtime/types';
import { MATERIALS_DOMAIN, materialLibrary, readMaterialAsset, type MaterialAsset } from '../runtime/materials/materialLibrary';
import { loadSkinPaint } from './skinPaint/modelSkin';
import { applyLayout, decodeLayout } from '../texturing/uv/uvLayout';
import { setLightVolumeSource } from '../runtime/lighting/lightVolumeLoader';
import { normalizeTextureSettings, setTextureSettings } from '../texturing/textureSettings';
import { createMaterialTextureLoader } from '../texturing/materialTextureLoader';

/** The HUD document in the project 'hud' domain. */
export const HUD_DOCUMENT_ID = 'hud-main';

export type GameContentProgress = (
  progress: number,
  label?: string,
  phase?: string,
  diagnostic?: DiagnosticAttributes,
) => void;

export interface LoadGameContentOptions {
  /** Resolves a project asset id to a fetchable URL (a host ticket or a game pack file). */
  resolveAssetUrl(assetId: string, diagnostics?: DiagnosticContext): Promise<string>;
  /** Reads a project asset where there is more to it than fetching its URL. */
  fetchAsset?(assetId: string, init: { signal?: AbortSignal; diagnostics?: DiagnosticContext }): Promise<Response>;
  /** Library thumbnails are only needed by the editor. */
  generateThumbnails: boolean;
  onProgress?: GameContentProgress;
  signal?: AbortSignal;
  /** Trace context for per-asset diagnostics. */
  diagnostics?: DiagnosticContext;
  /** Returns false once the caller no longer wants this result, e.g. the project was replaced. */
  isCurrent?: () => boolean;
  /**
   * Resolve terrain heightfield and splat map references of 'objects'
   * documents into terrainData.heights / terrainData.splat. The standalone
   * player needs this; the editor resolves them after a level opens
   * (useLevelManager) and leaves it off.
   */
  resolveTerrains?: boolean;
  /** Told when an asset's bytes have been read, for a source that keeps its own copy of them (a game pack). */
  releaseAssetUrl?(assetId: string): void;
  /** Models keep their source file and their textures' images for reimporting and editor tools, which only the editor has. */
  dropSourceFiles?: boolean;
  /** The asset holding a model's prepared copy, for a game built with them (utils/preparedModels). */
  preparedAssetFor?(assetId: string): string | undefined;
}

/** Which of a project's assets to load or free, by document id. A kind left out means none of it. */
export interface AssetSelection {
  textures?: ReadonlySet<string>;
  audio?: ReadonlySet<string>;
  models?: ReadonlySet<string>;
  attachments?: ReadonlySet<string>;
  /** Levels whose terrain heights and paint to resolve, with `resolveTerrains`. */
  levels?: ReadonlySet<string>;
}

export interface GameContentLoader {
  /** Loads what `selection` names and is not held yet, or everything without one. Rejects if an asset failed; the rest stay held. */
  load(selection?: AssetSelection): Promise<void>;
  /** Frees what `selection` names. Nothing may still be drawing it. */
  release(selection: AssetSelection): void;
  releaseAll(): void;
  /** What is held now, in new lists, so memos over them notice. */
  content(): GameContent;
  /** The 'objects' documents, with the terrains resolved so far. */
  objects(): LevelObject[];
  /** Models whose files could not be read, which the game goes on without. */
  refusedModels(): RefusedModel[];
}

interface TerrainAssetReference {
  assetId: string;
  columns: number;
  rows: number;
}

/** One read per asset and grid in a load; every later terrain gets its own copy. */
const resolveSharedTerrainAsset = async (
  cache: Map<string, Promise<number[]>>,
  reference: TerrainAssetReference,
  resolve: () => Promise<number[]>,
): Promise<number[]> => {
  const key = `${reference.assetId}:${reference.columns}x${reference.rows}`;
  const existing = cache.get(key);
  if (existing) return (await existing).slice();
  const pending = resolve();
  cache.set(key, pending);
  return pending;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Project loading was cancelled.', 'AbortError');
};

/**
 * Loads and frees a project's assets from its authored documents, as much of them as is asked
 * for. Binary assets are fetched through `resolveAssetUrl` and never embedded in JSON. The loader
 * owns what it holds: its models, attachments and blob URLs.
 */
export function createGameContentLoader(
  domains: Record<string, any[]>,
  options: LoadGameContentOptions,
): GameContentLoader {
  const { resolveAssetUrl, generateThumbnails, onProgress, signal, diagnostics, isCurrent, resolveTerrains = false, releaseAssetUrl, dropSourceFiles = false, preparedAssetFor } = options;
  const fetchProjectAsset = options.fetchAsset ?? (async (assetId: string, init: { signal?: AbortSignal; diagnostics?: DiagnosticContext }) => {
    const url = await resolveAssetUrl(assetId, init.diagnostics);
    assertCurrent();
    return fetch(url, { method: 'GET', signal: init.signal });
  });
  const assertCurrent = () => {
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  };
  const documents = (key: string): any[] => (Array.isArray(domains[key]) ? domains[key] : []);
  const textures: TextureData[] = [];
  const audioAssets: AudioData[] = [];
  const models: LoadedModelData[] = [];
  const attachments: AttachmentData[] = [];
  const ownedUrls: string[] = [];

  const loadProjectAssetFile = async (assetId: string, name: string, trace?: DiagnosticContext): Promise<File> => {
    throwIfAborted(signal);
    const response = await fetchProjectAsset(assetId, { signal, diagnostics: trace });
    assertCurrent();
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    const blob = await response.blob();
    releaseAssetUrl?.(assetId);
    assertCurrent();
    return new File([blob], name, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
  };
  /**
   * Reads and loads a model file: its prepared copy where the game has one. A copy that cannot be
   * read or parsed is logged and the source used, so only the source failing fails the asset.
   * `onRead` hears of each file as reading it starts, and of null when a copy failed and the source
   * is fetched instead. `images` fetches what the source names beside it, which a copy already holds.
   */
  const loadModelAsset = async (
    assetId: string,
    name: string,
    trace: DiagnosticContext | undefined,
    loadOptions: ModelLoadOptions,
    onRead: (file: File | null) => void,
    images?: () => Promise<File[]>,
  ): Promise<LoadedModelData> => {
    const preparedId = preparedAssetFor?.(assetId);
    if (preparedId) {
      try {
        const file = await loadProjectAssetFile(preparedId, name, trace);
        assertCurrent();
        onRead(file);
        return await loadFBXFile(file, { ...loadOptions, prepared: true });
      } catch (error) {
        assertCurrent();
        if (diagnosticErrorType(error) === 'AbortError') throw error;
        recordAssetDiagnostic('prepared_model_unreadable', error, 'source_read', { fallback: 'source' });
        onRead(null);
      }
    }
    const file = await loadProjectAssetFile(assetId, name, trace);
    const beside = images ? await images() : undefined;
    assertCurrent();
    onRead(file);
    return loadFBXFile(file, beside ? { ...loadOptions, images: beside } : loadOptions);
  };
  const loadProjectAssetUrl = async (assetId: string, trace?: DiagnosticContext): Promise<string> => {
    const file = await loadProjectAssetFile(assetId, assetId, trace);
    assertCurrent();
    const url = URL.createObjectURL(file);
    ownedUrls.push(url);
    return url;
  };
  const loadProjectAssetBytes = async (assetId: string, trace?: DiagnosticContext): Promise<ArrayBuffer> => {
    throwIfAborted(signal);
    const response = await fetchProjectAsset(assetId, { signal, diagnostics: trace });
    assertCurrent();
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    releaseAssetUrl?.(assetId);
    assertCurrent();
    return bytes;
  };

  const objectDocuments = documents('objects') as LevelObject[];
  let objects = objectDocuments;
  let assetWork = 1;
  let completedWork = 0;
  const report = (detail: string, fraction = 0, phase?: string, diagnostic?: DiagnosticAttributes) => {
    assertCurrent();
    onProgress?.(Math.min(0.99, (completedWork + fraction) / assetWork), detail, phase, diagnostic);
  };
  const complete = (detail: string, diagnostic?: DiagnosticAttributes) => {
    completedWork += 1;
    report(detail, 0, 'library_publication', diagnostic);
  };
  let assetFailureCount = 0;
  const refusedModels: RefusedModel[] = [];
  const refusedIds = new Set<string>();
  const traceAsset = (assetAlias: string) => diagnostics?.operationId && diagnostics.traceId
    ? { operationId: diagnostics.operationId, traceId: diagnostics.traceId, assetAlias }
    : undefined;
  const recordAssetDiagnostic = (
    code: string,
    error: unknown,
    phase: string,
    diagnostic: DiagnosticAttributes,
  ) => {
    frontendDiagnostics.record('frontend', 'frontend.failure', {
      ...diagnostic,
      phase,
      code,
      errorType: diagnosticErrorType(error),
    }, diagnostics, true);
  };
  const recordAssetFailure = (
    code: string,
    error: unknown,
    phase: string,
    diagnostic: DiagnosticAttributes,
  ) => {
    assetFailureCount += 1;
    recordAssetDiagnostic(code, error, phase, diagnostic);
  };

  const textureAssetUrls = new Map<string, string>();
  let materialsReady = false;
  const animationDocuments = documents('animations') as Array<{ assetId?: string; modelId?: string; name?: string; clipNames?: unknown }>;
  // Models and attachments load with GPU-compressed textures unless the game turns that off.
  const compressTextures = normalizeGameSettings(documents('metadata').find((doc) => doc?.id === GAME_SETTINGS_DOCUMENT_ID)?.settings).quality.textureCompression;
  const holds = (list: ReadonlyArray<{ id: string }>, id: unknown): boolean => list.some((entry) => entry.id === id);

  const load = async (selection?: AssetSelection): Promise<void> => {
    assertCurrent();
    const wantedDocuments = (key: string, kind: ReadonlySet<string> | undefined, held: ReadonlyArray<{ id: string }>): any[] => documents(key)
      .filter((doc) => (!selection || Boolean(kind?.has(doc?.id))) && !holds(held, doc?.id));
    const wantedTextures = wantedDocuments('textures', selection?.textures, textures);
    const wantedAudio = wantedDocuments('audio', selection?.audio, audioAssets);
    const wantedModels = wantedDocuments('models', selection?.models, models).filter((doc) => !refusedIds.has(doc?.id));
    const wantedAttachments = wantedDocuments('attachments', selection?.attachments, attachments);
    const wantedModelIds = new Set(wantedModels.map((doc) => doc?.id));
    const wantedAnimations = selection ? animationDocuments.filter((animation) => wantedModelIds.has(animation?.modelId)) : animationDocuments;
    const resolvesLevel = (object: LevelObject): boolean => !selection || Boolean(selection.levels?.has(object?.levelId));
    let terrainWork = 0;
    if (resolveTerrains) {
      for (const object of objects) {
        if (!resolvesLevel(object)) continue;
        if (isTerrainHeightfieldPending(object?.terrainData)) terrainWork += 1;
        if (isTerrainSplatPending(object?.terrainData)) terrainWork += 1;
        if (isTerrainSplat2Pending(object?.terrainData)) terrainWork += 1;
        if (isTerrainHolesPending(object?.terrainData)) terrainWork += 1;
        terrainWork += object?.foliageData?.types.filter(isFoliageTypePending).length ?? 0;
      }
    }
    assetWork = Math.max(1, wantedTextures.length + wantedAudio.length + wantedModels.length + wantedAnimations.length + wantedAttachments.length + terrainWork);
    completedWork = 0;
    assetFailureCount = 0;

    for (const value of wantedTextures) {
      const item = value as Partial<TextureData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'texture' };
      try {
        report(`Loading texture — ${item.name}`, 0.1, 'source_read', diagnostic);
        const settings = normalizeTextureSettings((item as { settings?: unknown }).settings);
        const source = await loadProjectAssetUrl(item.assetId, traceAsset(assetAlias));
        // A deep picture is shown through its 8-bit preview; material assets draw with the file itself.
        const url = settings?.preview ? await loadProjectAssetUrl(settings.preview.assetId, traceAsset(assetAlias)) : source;
        assertCurrent();
        textureAssetUrls.set(item.id, source);
        setTextureSettings(item.id, settings);
        materialLibrary.releaseTexture(item.id);
        textures.push({
          id: item.id, name: item.name, dimensions: item.dimensions || { width: 0, height: 0 }, url,
          ...(typeof item.folder === 'string' ? { folder: item.folder } : {}),
          ...(settings ? { settings } : {}),
          ...(settings?.preview ? { sourceUrl: source } : {}),
        });
      }
      catch (error) { recordAssetFailure('texture_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded texture — ${item.name}`, diagnostic);
    }
    if (!materialsReady) {
      materialsReady = true;
      // Material assets, before the models whose materials use them.
      // Material textures are decoded at their own depth and compressed by role, unless the game turns compression off.
      materialLibrary.setTextureSource((textureId) => textureAssetUrls.get(textureId), createMaterialTextureLoader({ compress: compressTextures }));
      materialLibrary.replaceAll(documents(MATERIALS_DOMAIN).map(readMaterialAsset).filter((asset): asset is MaterialAsset => asset !== null));
      // Levels' baked light volumes are read when a level is shown.
      setLightVolumeSource((assetId) => resolveAssetUrl(assetId), releaseAssetUrl);
    }
    for (const value of wantedAudio) {
      const item = value as Partial<AudioData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'audio' };
      try {
        report(`Loading audio — ${item.name}`, 0.1, 'source_read', diagnostic);
        const url = await loadProjectAssetUrl(item.assetId, traceAsset(assetAlias));
        assertCurrent();
        audioAssets.push({ id: item.id, name: item.name, type: item.type || 'application/octet-stream', duration: item.duration || 0, url, ...(typeof item.folder === 'string' ? { folder: item.folder } : {}) });
      }
      catch (error) { recordAssetFailure('audio_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded audio — ${item.name}`, diagnostic);
    }
    for (const value of wantedModels) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: item.category === 'Animation' ? 'animation' : 'model' };
      let activePhase: string = 'source_read';
      let loadedModel: LoadedModelData | null = null;
      let reading = false;
      try {
        report(`Downloading model — ${item.name}`, 0.05, activePhase, diagnostic);
        const sourceImages: ModelSourceImage[] = Array.isArray(item.sourceImages) ? item.sourceImages : [];
        const loaded = await loadModelAsset(item.assetId, item.name, traceAsset(assetAlias), {
          normalize: item.category !== 'Animation',
          convert: convertOptionsFor(item.category === 'Animation' ? undefined : item.importSettings),
          manualId: item.id,
          // An animation model keeps only its clips, so compressing its textures would be wasted.
          compressTextures: compressTextures && item.category !== 'Animation',
          keepTextureSources: !dropSourceFiles,
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.8 + 0.1, phase, diagnostic);
          },
        }, (file) => {
          if (file) diagnostic = assetDiagnosticAttributes(file, item.category === 'Animation' ? 'animation' : 'model', assetAlias);
          // A file that is read and cannot be is refused; one that cannot be fetched fails the load.
          reading = Boolean(file);
        }, () => Promise.all(sourceImages.map((image) => loadProjectAssetFile(image.assetId, image.name, traceAsset(assetAlias)))));
        reading = false;
        loadedModel = loaded;
        assertCurrent();
        dropSourceFile(loaded);
        // Clips keep the names stored at import, not the model's current name (see applyStoredClipNames).
        applyStoredClipNames(loaded.animations, item.clipNames);
        loaded.sourceClipNames = wholeClips(loaded.animations).map((clip) => clip.name);
        loaded.category = item.category || 'Prop';
        loaded.isPlacedInScene = Boolean(item.isPlacedInScene);
        if (sourceImages.length) loaded.sourceImages = sourceImages;
        if (Array.isArray(item.boneRoles) && item.boneRoles.length) loaded.boneRoles = item.boneRoles;
        if (item.uvLayout?.assetId) {
          loaded.uvLayout = item.uvLayout;
          try {
            const bytes = await loadProjectAssetBytes(item.uvLayout.assetId, traceAsset(assetAlias));
            applyLayout(loaded.object, decodeLayout(bytes));
            assertCurrent();
          } catch (error) {
            assertCurrent();
            // A model keeps its file's own coordinates when its layout cannot be read.
            recordAssetDiagnostic('uv_layout_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'file_uvs' });
          }
        }
        if (item.skinPaint?.assetId) {
          loaded.skinPaint = item.skinPaint;
          if (loaded.category !== 'Animation') {
            try {
              // Only the editor can take painting back, so only it keeps what the file said.
              await loadSkinPaint(loaded.object, item.skinPaint, (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)), { keepFileWeights: generateThumbnails });
              assertCurrent();
            } catch (error) {
              assertCurrent();
              // Painted weights are not essential to play: the model keeps those of its file.
              recordAssetDiagnostic('skin_paint_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'file_weights' });
            }
          }
        }
        if (typeof item.folder === 'string') loaded.folder = item.folder;
        // A missing importSettings document field means the default (old) normalization.
        applyModelImportSettings(loaded, item.importSettings);
        // A model's older per-material texture overrides are painted base maps: they are taken into its
        // material overrides (where a material has not decided its base map there) and put on the same
        // way as every other map, so Material Overrides shows them and can clear or replace them.
        loaded.materialOverrides = await hydrateMaterialOverrides(loaded.object, withCurrentMaterialNames(item.materialOverrides), {
          resolveTextureUrl: (textureId) => textureAssetUrls.get(textureId),
          assertCurrent,
        }, withCurrentMaterialNames(item.textureOverrides));
        loaded.textureOverrides = {};
        if (loaded.category === 'Animation') stripGeometry(loaded.object);
        if (generateThumbnails && !item.thumbnail && loaded.category !== 'Animation') {
          activePhase = 'thumbnail_generation';
          report(`Generating thumbnail — ${item.name}`, 0.94, activePhase, diagnostic);
          loaded.thumbnail = generateThumbnail(loaded.object);
        }
        const animations = animationDocuments.filter((animation) => animation.modelId === item.id);
        complete(`Loaded model — ${item.name}`, diagnostic);
        for (const animation of animations) {
          if (!animation?.assetId) continue;
          const animationAlias = frontendDiagnostics.nextAssetAlias();
          let animationDiagnostic: DiagnosticAttributes = { assetAlias: animationAlias, assetKind: 'animation' };
          let animationPhase: string = 'source_read';
          try {
            const animationName = animation.name || 'animation.fbx';
            report(`Downloading animation — ${animationName}`, 0.05, animationPhase, animationDiagnostic);
            let animationModel: LoadedModelData | null = null;
            try {
              animationModel = await loadModelAsset(animation.assetId, animationName, traceAsset(animationAlias), {
                normalize: false,
                // Only its clips are kept.
                compressTextures: false,
                signal,
                diagnostics: traceAsset(animationAlias),
                onProgress: (progress, phase) => {
                  animationPhase = phase;
                  report(`${importPhaseLabel(phase)} — ${animationName}`, progress * 0.85 + 0.1, phase, animationDiagnostic);
                },
              }, (file) => { if (file) animationDiagnostic = assetDiagnosticAttributes(file, 'animation', animationAlias); });
              assertCurrent();
              animationPhase = 'animation_binding';
              report(`Binding animation — ${animationName}`, 0.96, animationPhase, animationDiagnostic);
              const prepared = prepareAnimationClips(loaded.object, animationModel.object, animationModel.animations, item.boneRoles);
              applyStoredClipNames(prepared.clips, animation.clipNames);
              noteAttachedClips(prepared.clips, animationModel.animations);
              animationDiagnostic = { ...animationDiagnostic, bindingMode: prepared.mode, clipCount: prepared.clips.length };
              loaded.animations.push(...cutAttachedClips(prepared.clips, loaded.importSettings ?? {}, loaded.object));
            } finally {
              if (animationModel) disposeModel(animationModel);
            }
          } catch (error) { recordAssetFailure('animation_hydration_failed', error, animationPhase, animationDiagnostic); }
          complete(`Loaded animation — ${animation.name || 'animation.fbx'}`, animationDiagnostic);
        }
        if (Array.isArray(item.mirroredClips) && item.mirroredClips.length) {
          loaded.mirroredClips = item.mirroredClips.filter((name: unknown): name is string => typeof name === 'string');
          try {
            loaded.animations.push(...mirrorModelClips(loaded.object, loaded.animations, loaded.mirroredClips, loaded.boneRoles));
          } catch (error) { recordAssetFailure('clip_mirror_failed', error, 'animation_binding', diagnostic); }
        }
        models.push(loaded);
      } catch (error) {
        if (loadedModel) {
          try { disposeModel(loadedModel); } catch { /* best effort */ }
        }
        // A file that cannot be read now could be when it was imported. It stays in the project, and
        // the rest of the project opens: nothing else can be done about it from outside.
        const cancelled = (error as { name?: string } | null)?.name === 'AbortError';
        if (reading && !cancelled) {
          refusedModels.push({ name: item.name, reason: importFailureMessage(item.name, error) });
          refusedIds.add(item.id);
          recordAssetDiagnostic('model_hydration_failed', error, activePhase, diagnostic);
        } else {
          recordAssetFailure('model_hydration_failed', error, activePhase, diagnostic);
        }
        complete(`Skipped model — ${item.name}`, diagnostic);
      }
    }
    for (const value of wantedAttachments) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'attachment' };
      let activePhase: string = 'source_read';
      let loadedAttachment: LoadedModelData | null = null;
      try {
        report(`Downloading attachment — ${item.name}`, 0.05, activePhase, diagnostic);
        const loaded = await loadModelAsset(item.assetId, item.name, traceAsset(assetAlias), {
          normalize: false,
          manualId: item.id,
          compressTextures,
          keepTextureSources: !dropSourceFiles,
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.85 + 0.1, phase, diagnostic);
          },
        }, (file) => { if (file) diagnostic = assetDiagnosticAttributes(file, 'attachment', assetAlias); });
        loadedAttachment = loaded;
        assertCurrent();
        dropSourceFile(loaded);
        attachments.push({ id: item.id, name: item.name, url: loaded.url, object: loaded.object, parentModelId: item.parentModelId || '', boneName: item.boneName || 'Hips', position: item.position || [0, 0, 0], rotation: item.rotation || [0, 0, 0], scale: item.scale || [1, 1, 1] });
      } catch (error) {
        if (loadedAttachment) {
          try { disposeModel(loadedAttachment); } catch { /* best effort */ }
        }
        recordAssetFailure('attachment_hydration_failed', error, activePhase, diagnostic);
      }
      complete(`Loaded attachment — ${item.name}`, diagnostic);
    }
    if (resolveTerrains) {
      // Terrain heights and paint weights are binary assets referenced by the
      // object documents. Resolved objects are copies; the input is not touched.
      const heightfields = new Map<string, Promise<number[]>>();
      const splatmaps = new Map<string, Promise<number[]>>();
      const resolvedObjects: LevelObject[] = [];
      for (const object of objects) {
        if (object?.foliageData && resolvesLevel(object)) {
          // A type whose instances cannot be read draws nothing; the rest of the level still plays.
          const types = await Promise.all(object.foliageData.types.map(async (type) => {
            if (!type.instancemap || !isFoliageTypePending(type)) return type;
            const assetAlias = frontendDiagnostics.nextAssetAlias();
            const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'foliage_instances' };
            try {
              report('Loading foliage', 0.1, 'source_read', diagnostic);
              const instances = await resolveFoliageInstances(type.instancemap, (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)));
              assertCurrent();
              return { ...type, instances };
            } catch (error) {
              assertCurrent();
              recordAssetDiagnostic('foliage_instances_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'not_drawn' });
              return type;
            } finally {
              complete('Loaded foliage', diagnostic);
            }
          }));
          // A level loaded again keeps the objects it resolved before.
          resolvedObjects.push(types.every((type, index) => type === object.foliageData!.types[index]) ? object : { ...object, foliageData: { types } });
          continue;
        }
        const terrain = object?.terrainData;
        if (!terrain || !resolvesLevel(object)) {
          resolvedObjects.push(object);
          continue;
        }
        const label = object.name || 'Terrain';
        let resolved: TerrainData = terrain;
        const heightfield = terrain.heightfield;
        if (heightfield && isTerrainHeightfieldPending(terrain)) {
          const assetAlias = frontendDiagnostics.nextAssetAlias();
          const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'terrain_heightfield' };
          try {
            report(`Loading terrain heights — ${label}`, 0.1, 'source_read', diagnostic);
            const heights = await resolveSharedTerrainAsset(heightfields, heightfield, () => resolveTerrainHeightfield(
              heightfield,
              (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)),
            ));
            assertCurrent();
            resolved = { ...resolved, heights };
          } catch (error) {
            assertCurrent();
            recordAssetFailure('terrain_heightfield_hydration_failed', error, 'source_read', diagnostic);
          }
          complete(`Loaded terrain heights — ${label}`, diagnostic);
        }
        const splatmap = terrain.splatmap;
        if (splatmap && isTerrainSplatPending(terrain)) {
          const assetAlias = frontendDiagnostics.nextAssetAlias();
          const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'terrain_splatmap' };
          try {
            report(`Loading terrain paint — ${label}`, 0.1, 'source_read', diagnostic);
            const splat = await resolveSharedTerrainAsset(splatmaps, splatmap, () => resolveTerrainSplatmap(
              splatmap,
              (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)),
            ));
            assertCurrent();
            resolved = { ...resolved, splat };
          } catch (error) {
            assertCurrent();
            // Paint is not essential to play: the terrain keeps its base layer.
            recordAssetDiagnostic('terrain_splatmap_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'base_layer' });
          }
          complete(`Loaded terrain paint — ${label}`, diagnostic);
        }
        const splatmap2 = terrain.splatmap2;
        if (splatmap2 && isTerrainSplat2Pending(terrain)) {
          const assetAlias = frontendDiagnostics.nextAssetAlias();
          const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'terrain_splatmap' };
          try {
            report(`Loading terrain paint — ${label}`, 0.1, 'source_read', diagnostic);
            const splat2 = await resolveSharedTerrainAsset(splatmaps, splatmap2, () => resolveTerrainSplatmap(
              splatmap2,
              (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)),
            ));
            assertCurrent();
            resolved = { ...resolved, splat2 };
          } catch (error) {
            assertCurrent();
            recordAssetDiagnostic('terrain_splatmap_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'base_layer' });
          }
          complete(`Loaded terrain paint — ${label}`, diagnostic);
        }
        const holemap = terrain.holemap;
        if (holemap && isTerrainHolesPending(terrain)) {
          const assetAlias = frontendDiagnostics.nextAssetAlias();
          const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'terrain_splatmap' };
          try {
            report(`Loading terrain holes — ${label}`, 0.1, 'source_read', diagnostic);
            const holes = await resolveTerrainHolemap(holemap, (assetId) => loadProjectAssetBytes(assetId, traceAsset(assetAlias)));
            assertCurrent();
            resolved = { ...resolved, holes };
          } catch (error) {
            assertCurrent();
            recordAssetDiagnostic('terrain_holes_hydration_failed', error, 'source_read', { ...diagnostic, fallback: 'solid_ground' });
          }
          complete(`Loaded terrain holes — ${label}`, diagnostic);
        }
        resolvedObjects.push(resolved === terrain ? object : { ...object, terrainData: resolved });
      }
      objects = resolvedObjects;
    }
    assertCurrent();
    if (assetFailureCount > 0) {
      throw new Error(`Project hydration failed for ${assetFailureCount} asset${assetFailureCount === 1 ? '' : 's'}`);
    }
  };

  const dropSourceFile = (model: LoadedModelData): void => {
    if (!dropSourceFiles || !model.url) return;
    URL.revokeObjectURL(model.url);
    model.url = '';
  };

  const revokeOwnedUrl = (url: string): void => {
    const index = ownedUrls.indexOf(url);
    if (index >= 0) ownedUrls.splice(index, 1);
    try { URL.revokeObjectURL(url); } catch { /* best effort */ }
  };

  /** Takes the entries `ids` names out of `list`, in place, and returns them. */
  const takeOut = <T extends { id: string }>(list: T[], ids: ReadonlySet<string> | undefined): T[] => {
    if (!ids?.size) return [];
    const taken = list.filter((entry) => ids.has(entry.id));
    for (const entry of taken) list.splice(list.indexOf(entry), 1);
    return taken;
  };

  const release = (selection: AssetSelection): void => {
    for (const texture of takeOut(textures, selection.textures)) {
      textureAssetUrls.delete(texture.id);
      materialLibrary.releaseTexture(texture.id);
      revokeOwnedUrl(texture.url);
    }
    for (const audio of takeOut(audioAssets, selection.audio)) revokeOwnedUrl(audio.url);
    releaseLoadedAssets(takeOut(models, selection.models), takeOut(attachments, selection.attachments), []);
    const levels = selection.levels;
    if (levels?.size) {
      // Back to the documents, whose terrains hold only references to their heights and paint.
      objects = objects.map((object, index) => (levels.has(object?.levelId) ? objectDocuments[index] : object));
    }
  };

  /** A list in the project's order, whatever order it loaded in: where names repeat, the first one wins. */
  const inDocumentOrder = <T extends { id: string }>(list: readonly T[], key: string): T[] => {
    const order = new Map(documents(key).map((doc, index) => [doc?.id, index]));
    return [...list].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  };

  const content = (): GameContent => ({
    models: inDocumentOrder(models, 'models'),
    blueprints: documents('blueprints') as Blueprint[],
    attachments: inDocumentOrder(attachments, 'attachments'),
    sockets: documents('sockets') as SocketData[],
    textures: inDocumentOrder(textures, 'textures'),
    audioAssets: inDocumentOrder(audioAssets, 'audio'),
    prefabs: documents('prefabs') as PrefabData[],
  });

  return {
    load,
    release,
    releaseAll: () => {
      releaseLoadedAssets(models.splice(0), attachments.splice(0), ownedUrls.splice(0));
      textures.length = 0;
      audioAssets.length = 0;
      textureAssetUrls.clear();
      objects = objectDocuments;
    },
    content,
    objects: () => objects,
    refusedModels: () => [...refusedModels],
  };
}

/** The documents of a game that are not assets: its levels, HUD and settings. */
export const readGameDocuments = (domains: Record<string, any[]>): Omit<LoadedGameContent, 'content' | 'objects' | 'refusedModels'> => {
  const documents = (key: string): any[] => (Array.isArray(domains[key]) ? domains[key] : []);
  const settingsDocument = documents('metadata').find((doc) => doc?.id === GAME_SETTINGS_DOCUMENT_ID);
  const hudDocument = documents('hud').find((doc) => doc?.id === HUD_DOCUMENT_ID);
  return {
    levels: documents('levels') as LevelData[],
    hud: (hudDocument as HUDDocumentData | undefined) ?? null,
    hudDocuments: documents('hud').filter(
      (doc): doc is HUDDocumentData => typeof doc?.id === 'string' && Array.isArray(doc.elements),
    ),
    settings: normalizeGameSettings(settingsDocument?.settings),
  };
};

/**
 * Load authored domain documents into runtime-ready content, all of it. The result owns its
 * models, attachments and blob URLs; if loading fails, is cancelled or any asset fails, everything
 * loaded so far is released before the error is thrown.
 */
export async function loadGameContent(
  domains: Record<string, any[]>,
  options: LoadGameContentOptions,
): Promise<LoadedGameContent> {
  const loader = createGameContentLoader(domains, options);
  try {
    await loader.load();
  } catch (error) {
    loader.releaseAll();
    throw error;
  }
  options.onProgress?.(1, 'Project assets ready');
  return { ...readGameDocuments(domains), content: loader.content(), objects: loader.objects(), refusedModels: loader.refusedModels() };
}

/** The name projects saved a mesh with no material under, before models came to call it Default. */
const currentMaterialName = (name: string): string => (name === '__DEFAULT' ? 'Default' : name);

const withCurrentMaterialNames = <T,>(overrides: T): T => {
  if (!overrides || typeof overrides !== 'object' || !('__DEFAULT' in overrides)) return overrides;
  return Object.fromEntries(Object.entries(overrides).map(([name, value]) => [currentMaterialName(name), value])) as T;
};

/** Dispose content that was loaded but will not be published. Best effort. */
function releaseLoadedAssets(models: LoadedModelData[], attachments: AttachmentData[], ownedUrls: string[]): void {
  const urls = new Set<string>(ownedUrls);
  for (const model of models) {
    try { disposeModel(model); } catch { /* best effort */ }
  }
  for (const attachment of attachments) {
    try { disposeObject(attachment.object); } catch { /* best effort */ }
    if (attachment.url) urls.add(attachment.url);
  }
  for (const url of urls) {
    try { URL.revokeObjectURL(url); } catch { /* best effort */ }
  }
}
