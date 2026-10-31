import * as THREE from 'three';
import type { AttachmentData, AudioData, Blueprint, LevelData, LevelObject, LoadedModelData, PrefabData, SocketData, TerrainData, TextureData } from '../types';
import { importPhaseLabel, loadFBXFile, type ModelLoadOptions } from './modelLoader';
import { resolveTerrainHeightfield } from './terrainHeightfield';
import { isTerrainHeightfieldPending } from './terrainHeightfieldCodec';
import { resolveTerrainSplatmap } from '../components/Environment/Terrain/terrainSplat';
import { isTerrainSplatPending } from '../components/Environment/Terrain/terrainSplatCodec';
import { applyModelImportSettings, stripGeometry } from './processing/ModelTransforms';
import { generateThumbnail } from './thumbnailGenerator';
import { disposeModel, disposeObject } from './processing/ModelLifecycle';
import { applyStoredClipNames, mirrorModelClips, prepareAnimationClips } from './animationBinding';
import { hydrateMaterialOverrides, overrideTextureFlipY } from './materialOverrides';
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
} from '../runtime/types';
import { MATERIALS_DOMAIN, materialLibrary, readMaterialAsset, type MaterialAsset } from '../runtime/materials/materialLibrary';
import { setLightVolumeSource } from '../runtime/lighting/lightVolumeLoader';

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
  /** Models keep their source file for reimporting and for attachments copied from them, which only the editor does. */
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
    const url = await resolveAssetUrl(assetId, trace);
    assertCurrent();
    const response = await fetch(url, { method: 'GET', signal });
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    const blob = await response.blob();
    releaseAssetUrl?.(assetId);
    assertCurrent();
    return new File([blob], name, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
  };
  /**
   * Reads and loads a model file: its prepared copy where the game has one. A copy that cannot be
   * read or parsed is logged and the source used, so only the source failing fails the asset.
   */
  const loadModelAsset = async (assetId: string, name: string, trace: DiagnosticContext | undefined, loadOptions: ModelLoadOptions, onRead: (file: File) => void): Promise<LoadedModelData> => {
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
      }
    }
    const file = await loadProjectAssetFile(assetId, name, trace);
    assertCurrent();
    onRead(file);
    return loadFBXFile(file, loadOptions);
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
    const url = await resolveAssetUrl(assetId, trace);
    assertCurrent();
    const response = await fetch(url, { method: 'GET', signal });
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
    const wantedModels = wantedDocuments('models', selection?.models, models);
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
        const url = await loadProjectAssetUrl(item.assetId, traceAsset(assetAlias));
        assertCurrent();
        textureAssetUrls.set(item.id, url);
        materialLibrary.releaseTexture(item.id);
        textures.push({ id: item.id, name: item.name, dimensions: item.dimensions || { width: 0, height: 0 }, url, ...(typeof item.folder === 'string' ? { folder: item.folder } : {}) });
      }
      catch (error) { recordAssetFailure('texture_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded texture — ${item.name}`, diagnostic);
    }
    if (!materialsReady) {
      materialsReady = true;
      // Material assets, before the models whose materials use them.
      materialLibrary.setTextureSource((textureId) => textureAssetUrls.get(textureId));
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
      try {
        report(`Downloading model — ${item.name}`, 0.05, activePhase, diagnostic);
        const loaded = await loadModelAsset(item.assetId, item.name, traceAsset(assetAlias), {
          normalize: item.category !== 'Animation',
          manualId: item.id,
          // An animation model keeps only its clips, so compressing its textures would be wasted.
          compressTextures: compressTextures && item.category !== 'Animation',
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.8 + 0.1, phase, diagnostic);
          },
        }, (file) => { diagnostic = assetDiagnosticAttributes(file, item.category === 'Animation' ? 'animation' : 'model', assetAlias); });
        loadedModel = loaded;
        assertCurrent();
        dropSourceFile(loaded);
        // Clips keep the names stored at import, not the model's current name (see applyStoredClipNames).
        applyStoredClipNames(loaded.animations, item.clipNames);
        loaded.sourceClipNames = loaded.animations.map((clip) => clip.name);
        loaded.category = item.category || 'Prop';
        loaded.isPlacedInScene = Boolean(item.isPlacedInScene);
        loaded.textureOverrides = item.textureOverrides;
        if (typeof item.folder === 'string') loaded.folder = item.folder;
        // A missing importSettings document field means the default (old) normalization.
        applyModelImportSettings(loaded, item.importSettings);
        for (const [materialName, textureId] of Object.entries(item.textureOverrides || {}) as Array<[string, string]>) {
          const textureUrl = textureAssetUrls.get(textureId);
          if (!textureUrl) continue;
          const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          let attached = false;
          try {
            assertCurrent();
            texture.colorSpace = THREE.SRGBColorSpace;
            // glTF UVs start top-left; the editor's retexture orients it the same way.
            texture.flipY = overrideTextureFlipY(loaded.object);
            loaded.object.traverse((child) => {
              if (!(child as THREE.Mesh).isMesh) return;
              const material = (child as THREE.Mesh).material;
              const materials = Array.isArray(material) ? material : [material];
              for (const candidate of materials as any[]) {
                if (candidate.name !== materialName) continue;
                attached = true;
                if (candidate.map) candidate.map.dispose();
                candidate.map = texture;
                candidate.transparent = true;
                candidate.alphaTest = 0.5;
                candidate.side = THREE.DoubleSide;
                candidate.needsUpdate = true;
              }
            });
          } finally {
            // An attached texture is owned by the model's materials; any other
            // is never referenced again.
            if (!attached) texture.dispose();
          }
        }
        // Material overrides layer on top of the texture overrides above, so a
        // material without its own map override keeps the overridden texture.
        loaded.materialOverrides = await hydrateMaterialOverrides(loaded.object, item.materialOverrides, {
          resolveTextureUrl: (textureId) => textureAssetUrls.get(textureId),
          assertCurrent,
        });
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
              }, (file) => { animationDiagnostic = assetDiagnosticAttributes(file, 'animation', animationAlias); });
              assertCurrent();
              animationPhase = 'animation_binding';
              report(`Binding animation — ${animationName}`, 0.96, animationPhase, animationDiagnostic);
              const prepared = prepareAnimationClips(loaded.object, animationModel.object, animationModel.animations);
              applyStoredClipNames(prepared.clips, animation.clipNames);
              animationDiagnostic = { ...animationDiagnostic, bindingMode: prepared.mode, clipCount: prepared.clips.length };
              loaded.animations.push(...prepared.clips);
            } finally {
              if (animationModel) disposeModel(animationModel);
            }
          } catch (error) { recordAssetFailure('animation_hydration_failed', error, animationPhase, animationDiagnostic); }
          complete(`Loaded animation — ${animation.name || 'animation.fbx'}`, animationDiagnostic);
        }
        if (Array.isArray(item.mirroredClips) && item.mirroredClips.length) {
          loaded.mirroredClips = item.mirroredClips.filter((name: unknown): name is string => typeof name === 'string');
          try {
            loaded.animations.push(...mirrorModelClips(loaded.object, loaded.animations, loaded.mirroredClips));
          } catch (error) { recordAssetFailure('clip_mirror_failed', error, 'animation_binding', diagnostic); }
        }
        models.push(loaded);
      } catch (error) {
        if (loadedModel) {
          try { disposeModel(loadedModel); } catch { /* best effort */ }
        }
        recordAssetFailure('model_hydration_failed', error, activePhase, diagnostic);
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
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.85 + 0.1, phase, diagnostic);
          },
        }, (file) => { diagnostic = assetDiagnosticAttributes(file, 'attachment', assetAlias); });
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
  };
}

/** The documents of a game that are not assets: its levels, HUD and settings. */
export const readGameDocuments = (domains: Record<string, any[]>): Omit<LoadedGameContent, 'content' | 'objects'> => {
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
  return { ...readGameDocuments(domains), content: loader.content(), objects: loader.objects() };
}

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
