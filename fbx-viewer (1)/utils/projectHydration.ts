import * as THREE from 'three';
import type { AttachmentData, AudioData, Blueprint, LevelData, LevelObject, LoadedModelData, SocketData, TextureData } from '../types';
import { importPhaseLabel, loadFBXFile } from './modelLoader';
import { stripGeometry } from './processing/ModelTransforms';
import { generateThumbnail } from './thumbnailGenerator';
import { disposeModel, disposeObject } from './processing/ModelLifecycle';
import { prepareAnimationClips } from './animationBinding';
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
  type HUDDocumentData,
  type LoadedGameContent,
} from '../runtime/types';

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
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Project loading was cancelled.', 'AbortError');
};

/**
 * Load authored domain documents into runtime-ready content. Binary assets are
 * fetched through `resolveAssetUrl` and never embedded in JSON. The result owns
 * its models, attachments and blob URLs; if loading fails, is cancelled or any
 * asset fails, everything loaded so far is released before the error is thrown.
 */
export async function loadGameContent(
  domains: Record<string, any[]>,
  options: LoadGameContentOptions,
): Promise<LoadedGameContent> {
  const { resolveAssetUrl, generateThumbnails, onProgress, signal, diagnostics, isCurrent } = options;
  const assertCurrent = () => {
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  };
  assertCurrent();
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
    assertCurrent();
    return new File([blob], name, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
  };
  const loadProjectAssetUrl = async (assetId: string, trace?: DiagnosticContext): Promise<string> => {
    const file = await loadProjectAssetFile(assetId, assetId, trace);
    assertCurrent();
    const url = URL.createObjectURL(file);
    ownedUrls.push(url);
    return url;
  };

  const assetWork = Math.max(1,
    documents('textures').length + documents('audio').length + documents('models').length
    + documents('animations').length + documents('attachments').length,
  );
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
  const recordAssetFailure = (
    code: string,
    error: unknown,
    phase: string,
    diagnostic: DiagnosticAttributes,
  ) => {
    assetFailureCount += 1;
    frontendDiagnostics.record('frontend', 'frontend.failure', {
      ...diagnostic,
      phase,
      code,
      errorType: diagnosticErrorType(error),
    }, diagnostics, true);
  };

  try {
    const textureAssetUrls = new Map<string, string>();
    for (const value of documents('textures')) {
      const item = value as Partial<TextureData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'texture' };
      try {
        report(`Loading texture — ${item.name}`, 0.1, 'source_read', diagnostic);
        const url = await loadProjectAssetUrl(item.assetId, traceAsset(assetAlias));
        assertCurrent();
        textureAssetUrls.set(item.id, url);
        textures.push({ id: item.id, name: item.name, dimensions: item.dimensions || { width: 0, height: 0 }, url });
      }
      catch (error) { recordAssetFailure('texture_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded texture — ${item.name}`, diagnostic);
    }
    for (const value of documents('audio')) {
      const item = value as Partial<AudioData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'audio' };
      try {
        report(`Loading audio — ${item.name}`, 0.1, 'source_read', diagnostic);
        const url = await loadProjectAssetUrl(item.assetId, traceAsset(assetAlias));
        assertCurrent();
        audioAssets.push({ id: item.id, name: item.name, type: item.type || 'application/octet-stream', duration: item.duration || 0, url });
      }
      catch (error) { recordAssetFailure('audio_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded audio — ${item.name}`, diagnostic);
    }
    const animationDocuments = documents('animations') as Array<{ assetId?: string; modelId?: string; name?: string }>;
    for (const value of documents('models')) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: item.category === 'Animation' ? 'animation' : 'model' };
      let activePhase: string = 'source_read';
      let loadedModel: LoadedModelData | null = null;
      try {
        report(`Downloading model — ${item.name}`, 0.05, activePhase, diagnostic);
        const sourceFile = await loadProjectAssetFile(item.assetId, item.name, traceAsset(assetAlias));
        assertCurrent();
        diagnostic = assetDiagnosticAttributes(sourceFile, item.category === 'Animation' ? 'animation' : 'model', assetAlias);
        const loaded = await loadFBXFile(sourceFile, {
          normalize: item.category !== 'Animation',
          manualId: item.id,
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.8 + 0.1, phase, diagnostic);
          },
        });
        loadedModel = loaded;
        assertCurrent();
        loaded.category = item.category || 'Prop';
        loaded.isPlacedInScene = Boolean(item.isPlacedInScene);
        loaded.textureOverrides = item.textureOverrides;
        for (const [materialName, textureId] of Object.entries(item.textureOverrides || {}) as Array<[string, string]>) {
          const textureUrl = textureAssetUrls.get(textureId);
          if (!textureUrl) continue;
          const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          let attached = false;
          try {
            assertCurrent();
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.flipY = true;
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
            const animationFile = await loadProjectAssetFile(animation.assetId, animationName, traceAsset(animationAlias));
            assertCurrent();
            animationDiagnostic = assetDiagnosticAttributes(animationFile, 'animation', animationAlias);
            let animationModel: LoadedModelData | null = null;
            try {
              animationModel = await loadFBXFile(animationFile, {
                normalize: false,
                signal,
                diagnostics: traceAsset(animationAlias),
                onProgress: (progress, phase) => {
                  animationPhase = phase;
                  report(`${importPhaseLabel(phase)} — ${animationName}`, progress * 0.85 + 0.1, phase, animationDiagnostic);
                },
              });
              assertCurrent();
              animationPhase = 'animation_binding';
              report(`Binding animation — ${animationName}`, 0.96, animationPhase, animationDiagnostic);
              const prepared = prepareAnimationClips(loaded.object, animationModel.object, animationModel.animations);
              animationDiagnostic = { ...animationDiagnostic, bindingMode: prepared.mode, clipCount: prepared.clips.length };
              loaded.animations.push(...prepared.clips);
            } finally {
              if (animationModel) disposeModel(animationModel);
            }
          } catch (error) { recordAssetFailure('animation_hydration_failed', error, animationPhase, animationDiagnostic); }
          complete(`Loaded animation — ${animation.name || 'animation.fbx'}`, animationDiagnostic);
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
    for (const value of documents('attachments')) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'attachment' };
      let activePhase: string = 'source_read';
      let loadedAttachment: LoadedModelData | null = null;
      try {
        report(`Downloading attachment — ${item.name}`, 0.05, activePhase, diagnostic);
        const sourceFile = await loadProjectAssetFile(item.assetId, item.name, traceAsset(assetAlias));
        assertCurrent();
        diagnostic = assetDiagnosticAttributes(sourceFile, 'attachment', assetAlias);
        const loaded = await loadFBXFile(sourceFile, {
          normalize: false,
          manualId: item.id,
          signal,
          diagnostics: traceAsset(assetAlias),
          onProgress: (progress, phase) => {
            activePhase = phase;
            report(`${importPhaseLabel(phase)} — ${item.name}`, progress * 0.85 + 0.1, phase, diagnostic);
          },
        });
        loadedAttachment = loaded;
        assertCurrent();
        attachments.push({ id: item.id, name: item.name, url: loaded.url, object: loaded.object, parentModelId: item.parentModelId || '', boneName: item.boneName || 'Hips', position: item.position || [0, 0, 0], rotation: item.rotation || [0, 0, 0], scale: item.scale || [1, 1, 1] });
      } catch (error) {
        if (loadedAttachment) {
          try { disposeModel(loadedAttachment); } catch { /* best effort */ }
        }
        recordAssetFailure('attachment_hydration_failed', error, activePhase, diagnostic);
      }
      complete(`Loaded attachment — ${item.name}`, diagnostic);
    }
    assertCurrent();
    if (assetFailureCount > 0) {
      throw new Error(`Project hydration failed for ${assetFailureCount} asset${assetFailureCount === 1 ? '' : 's'}`);
    }
  } catch (error) {
    releaseLoadedAssets(models, attachments, ownedUrls);
    throw error;
  }

  const settingsDocument = documents('metadata').find((doc) => doc?.id === GAME_SETTINGS_DOCUMENT_ID);
  const hudDocument = documents('hud').find((doc) => doc?.id === HUD_DOCUMENT_ID);
  onProgress?.(1, 'Project assets ready');
  return {
    content: {
      models,
      blueprints: documents('blueprints') as Blueprint[],
      attachments,
      sockets: documents('sockets') as SocketData[],
      textures,
      audioAssets,
    },
    levels: documents('levels') as LevelData[],
    objects: documents('objects') as LevelObject[],
    hud: (hudDocument as HUDDocumentData | undefined) ?? null,
    settings: normalizeGameSettings(settingsDocument?.settings),
  };
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
