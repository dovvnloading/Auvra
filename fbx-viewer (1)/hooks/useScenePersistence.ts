
import { useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AttachmentData, Blueprint, SocketData, TextureData, LevelObject, LevelData, AudioData } from '../types';
import { dbOperations } from '../utils/db';
import { importPhaseLabel, loadFBXFile } from '../utils/modelLoader';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { prepareAnimationClips } from '../utils/animationBinding';
import { projectService, ProjectSnapshot } from '../utils/projectService';
import { useOperationActions } from '../context/OperationContext';
import { editorSession, type EditorSessionTransition } from '../utils/editorSession';
import {
  assetDiagnosticAttributes,
  diagnosticErrorType,
  frontendDiagnostics,
  type DiagnosticAttributes,
  type DiagnosticContext,
} from '../diagnostics/runtime';

export interface ScenePersistenceProps {
  setModels: (models: LoadedModelData[]) => void;
  setAttachments: (attachments: AttachmentData[]) => void;
  setSockets: (sockets: SocketData[]) => void;
  setBlueprints?: (blueprints: Blueprint[]) => void;
  setTextures?: (textures: TextureData[]) => void;
  setAudioAssets?: (audios: AudioData[]) => void; // Added
  setLevelObjects?: (objects: LevelObject[]) => void;
  setSelectedModelId: (id: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  defaultBlueprints?: Blueprint[];
  hydrateProjectState?: (levels: LevelData[], objects: LevelObject[], currentLevelId?: string | null) => void;
  hydrateGraphs?: (graphs: Record<string, import('../types').AnimationGraphData>) => void;
  getCurrentLevelId?: () => string | null;
  commitHydration: (state: DetachedHydration) => void;
}

interface SnapshotHydrationTargets {
  setModels: (value: LoadedModelData[]) => void;
  setAttachments: (value: AttachmentData[]) => void;
  setSockets: (value: SocketData[]) => void;
  setBlueprints?: (value: Blueprint[]) => void;
  setTextures?: (value: TextureData[]) => void;
  setAudioAssets?: (value: AudioData[]) => void;
  setLevelObjects?: (value: LevelObject[]) => void;
  setSelectedModelId: (value: string | null) => void;
  hydrateProjectState?: (levels: LevelData[], objects: LevelObject[], currentLevelId?: string | null) => void;
  hydrateGraphs?: (graphs: Record<string, import('../types').AnimationGraphData>) => void;
  trackTexture?: (texture: THREE.Texture) => void;
  releaseTexture?: (texture: THREE.Texture) => void;
  trackUrl?: (url: string) => void;
}

/** A hydration result is deliberately detached from React.  The setters in
 * SnapshotHydrationTargets point at this object while work is in flight and
 * are only replaced with the real React setters after the identity check. */
export interface DetachedHydration {
  models: LoadedModelData[];
  attachments: AttachmentData[];
  sockets: SocketData[];
  blueprints: Blueprint[];
  textures: TextureData[];
  audioAssets: AudioData[];
  levelObjects: LevelObject[];
  levels: LevelData[];
  currentLevelId: string | null;
  graphs: Record<string, import('../types').AnimationGraphData>;
  selectedModelId: string | null;
  standaloneTextures: Set<THREE.Texture>;
  ownedUrls: Set<string>;
}

const createDetachedHydration = (defaultBlueprints?: Blueprint[]): DetachedHydration => ({
  models: [], attachments: [], sockets: [],
  blueprints: defaultBlueprints ? [...defaultBlueprints] : [],
  textures: [], audioAssets: [], levelObjects: [], levels: [],
  currentLevelId: null, graphs: {}, selectedModelId: null,
  standaloneTextures: new Set(),
  ownedUrls: new Set(),
});

const detachedTargets = (state: DetachedHydration): SnapshotHydrationTargets => ({
  setModels: (value) => { state.models = value; },
  setAttachments: (value) => { state.attachments = value; },
  setSockets: (value) => { state.sockets = value; },
  setBlueprints: (value) => { state.blueprints = value; },
  setTextures: (value) => { state.textures = value; },
  setAudioAssets: (value) => { state.audioAssets = value; },
  setLevelObjects: (value) => { state.levelObjects = value; },
  setSelectedModelId: (value) => { state.selectedModelId = value; },
  hydrateProjectState: (levels, objects, currentLevelId) => {
    state.levels = levels;
    state.levelObjects = objects;
    state.currentLevelId = currentLevelId || levels[0]?.id || null;
  },
  hydrateGraphs: (value) => { state.graphs = value; },
  trackTexture: (value) => { state.standaloneTextures.add(value); },
  releaseTexture: (value) => { state.standaloneTextures.delete(value); },
  trackUrl: (value) => { state.ownedUrls.add(value); },
});

const disposeDetachedHydration = (state: DetachedHydration): void => {
  const urls = new Set<string>(state.ownedUrls);
  for (const model of state.models) {
    try { disposeModel(model); } catch { /* disposal is best effort during cancellation */ }
  }
  for (const attachment of state.attachments) {
    try { disposeObject(attachment.object); } catch { /* best effort */ }
    if (attachment.url) urls.add(attachment.url);
  }
  for (const url of urls) {
    try { URL.revokeObjectURL(url); } catch { /* best effort */ }
  }
  for (const texture of state.standaloneTextures) {
    try { texture.dispose(); } catch { /* best effort */ }
  }
  state.standaloneTextures.clear();
};

const disposeStandaloneTextures = (state: DetachedHydration): void => {
  for (const texture of state.standaloneTextures) {
    try { texture.dispose(); } catch { /* best effort before publication */ }
  }
  state.standaloneTextures.clear();
};

const publishDetachedHydration = (
  state: DetachedHydration,
  targets: ScenePersistenceProps,
): void => {
  // Keep this as one synchronous publication boundary. React batches these
  // setters, so consumers never observe a model list from one project with a
  // level/object list from another project.
  disposeStandaloneTextures(state);
  targets.commitHydration(state);
};

type HydrationProgress = (
  progress: number,
  detail: string,
  phase?: string,
  diagnostic?: DiagnosticAttributes,
) => void;

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Project loading was cancelled.', 'AbortError');
};

/** Hydrate authored domains from a bounded native snapshot. Binary assets are
 * resolved only through opaque host tickets and never embedded in JSON. */
async function hydrateSnapshot(
  snapshot: ProjectSnapshot,
  targets: SnapshotHydrationTargets,
  onProgress: HydrationProgress,
  signal?: AbortSignal,
  diagnostics?: DiagnosticContext,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const assertCurrent = () => {
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  };
  assertCurrent();
  const source = snapshot.domains && typeof snapshot.domains === 'object'
    ? snapshot.domains
    : snapshot as Record<string, unknown>;
  const domainDocuments = (key: string): unknown[] => {
    const value = source[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray((value as { documents?: unknown[] }).documents)) {
      return (value as { documents: unknown[] }).documents;
    }
    return [];
  };
  const hasDomain = ['metadata', 'worlds', 'scenes', 'levels', 'objects', 'environment', 'models', 'animations', 'attachments', 'sockets', 'textures', 'audio', 'materials', 'blueprints', 'graphs', 'hud']
    .some((key) => domainDocuments(key).length > 0);
  const isNativePage = Array.isArray((snapshot as Record<string, unknown>).documents);
  const pageDocuments = Array.isArray((snapshot as Record<string, unknown>).documents)
    ? (snapshot as Record<string, unknown>).documents as unknown[] : [];
  if (!hasDomain && !isNativePage) return false;
  if (isNativePage) {
    targets.setModels([]);
    targets.setAttachments([]);
    targets.setSockets([]);
    targets.setBlueprints?.([]);
    targets.setTextures?.([]);
    targets.setAudioAssets?.([]);
    targets.setLevelObjects?.([]);
  }
  if (isNativePage && !hasDomain && pageDocuments.length === 0) {
    targets.setBlueprints?.([]);
    targets.setTextures?.([]);
    targets.setAudioAssets?.([]);
    targets.setLevelObjects?.([]);
    targets.hydrateProjectState?.([], [], null);
    targets.hydrateGraphs?.({});
    targets.setSelectedModelId(null);
    return true;
  }
  const records = Array.isArray((snapshot as Record<string, unknown>).documents)
    ? ((snapshot as Record<string, unknown>).documents as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
  const docsByDomain: Record<string, unknown[]> = {};
  for (const item of records) {
    const domain = typeof item.domain === 'string' ? item.domain : '';
    const document = item.document && typeof item.document === 'object' ? item.document : item;
    if (domain) (docsByDomain[domain] ||= []).push(document);
  }
  const documents = (key: string): unknown[] => domainDocuments(key).length ? domainDocuments(key) : docsByDomain[key] || [];
  const assetWork = Math.max(1,
    documents('textures').length + documents('audio').length + documents('models').length
    + documents('animations').length + documents('attachments').length,
  );
  let completedWork = 0;
  const report = (detail: string, fraction = 0, phase?: string, diagnostic?: DiagnosticAttributes) => {
    assertCurrent();
    onProgress(Math.min(0.99, (completedWork + fraction) / assetWork), detail, phase, diagnostic);
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
  const textureAssetUrls = new Map<string, string>();
  if (targets.setBlueprints) targets.setBlueprints(documents('blueprints') as Blueprint[]);
  if (targets.setTextures) {
    const textures: TextureData[] = [];
    for (const value of documents('textures')) {
      const item = value as Partial<TextureData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'texture' };
      try {
        report(`Loading texture — ${item.name}`, 0.1, 'source_read', diagnostic);
        const url = await loadProjectAssetUrl(item.assetId, signal, traceAsset(assetAlias), isCurrent, targets.trackUrl);
        assertCurrent();
        textureAssetUrls.set(item.id, url);
        textures.push({ id: item.id, name: item.name, dimensions: item.dimensions || { width: 0, height: 0 }, url });
      }
      catch (error) { recordAssetFailure('texture_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded texture — ${item.name}`, diagnostic);
    }
    targets.setTextures(textures);
  }
  if (targets.setAudioAssets) {
    const audios: AudioData[] = [];
    for (const value of documents('audio')) {
      const item = value as Partial<AudioData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      const diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'audio' };
      try {
        report(`Loading audio — ${item.name}`, 0.1, 'source_read', diagnostic);
        const url = await loadProjectAssetUrl(item.assetId, signal, traceAsset(assetAlias), isCurrent, targets.trackUrl);
        assertCurrent();
        audios.push({ id: item.id, name: item.name, type: item.type || 'application/octet-stream', duration: item.duration || 0, url });
      }
      catch (error) { recordAssetFailure('audio_hydration_failed', error, 'source_read', diagnostic); }
      complete(`Loaded audio — ${item.name}`, diagnostic);
    }
    targets.setAudioAssets(audios);
  }
  if (targets.setModels) {
    const models: LoadedModelData[] = [];
    // Register the live staging container before the first await so models
    // completed earlier in the loop remain reachable by stale-run cleanup.
    targets.setModels(models);
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
        const sourceFile = await loadProjectAssetFile(item.assetId, item.name, signal, traceAsset(assetAlias), isCurrent);
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
          targets.trackTexture?.(texture);
          assertCurrent();
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = true;
          let attached = false;
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
          if (attached) targets.releaseTexture?.(texture);
        }
        if (loaded.category === 'Animation') stripGeometry(loaded.object);
        if (!item.thumbnail && loaded.category !== 'Animation') {
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
            const animationFile = await loadProjectAssetFile(animation.assetId, animationName, signal, traceAsset(animationAlias), isCurrent);
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
    targets.setModels(models);
  }
  if (targets.setAttachments) {
    const attachments: AttachmentData[] = [];
    // As with models, keep all earlier completed attachments owned by the
    // detached result while later attachment work is still pending.
    targets.setAttachments(attachments);
    for (const value of documents('attachments')) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      const assetAlias = frontendDiagnostics.nextAssetAlias();
      let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'attachment' };
      let activePhase: string = 'source_read';
      let loadedAttachment: LoadedModelData | null = null;
      try {
        report(`Downloading attachment — ${item.name}`, 0.05, activePhase, diagnostic);
        const sourceFile = await loadProjectAssetFile(item.assetId, item.name, signal, traceAsset(assetAlias), isCurrent);
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
    targets.setAttachments(attachments);
  }
  if (targets.setSockets) targets.setSockets(documents('sockets') as SocketData[]);
  const levels = documents('levels') as LevelData[];
  const objects = documents('objects') as LevelObject[];
  if (targets.setLevelObjects) targets.setLevelObjects(objects);
  targets.hydrateProjectState?.(levels, objects, levels[0]?.id || null);
  const graphDocs = documents('graphs');
  if (targets.hydrateGraphs) {
    const graphs: Record<string, import('../types').AnimationGraphData> = {};
    graphDocs.forEach((doc) => { const value = doc as { modelId?: string; id?: string; graph?: import('../types').AnimationGraphData }; const key = value.modelId || value.id; if (key) graphs[key] = value.graph || value as unknown as import('../types').AnimationGraphData; });
  targets.hydrateGraphs(graphs);
  }
  assertCurrent();
  if (assetFailureCount > 0) {
    throw new Error(`Project hydration failed for ${assetFailureCount} asset${assetFailureCount === 1 ? '' : 's'}`);
  }
  targets.setSelectedModelId(null);
  onProgress(1, 'Project assets ready');
  return true;
}

async function loadProjectAssetFile(
  assetId: string,
  name: string,
  signal?: AbortSignal,
  diagnostics?: DiagnosticContext,
  isCurrent?: () => boolean,
): Promise<File> {
  throwIfAborted(signal);
  const url = await projectService.resolveAsset(assetId, diagnostics);
  throwIfAborted(signal);
  if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  const response = await fetch(url, { method: 'GET', signal });
  if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
  const blob = await response.blob();
  throwIfAborted(signal);
  if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  return new File([blob], name, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
}

async function loadProjectAssetUrl(
  assetId: string,
  signal?: AbortSignal,
  diagnostics?: DiagnosticContext,
  isCurrent?: () => boolean,
  trackUrl?: (url: string) => void,
): Promise<string> {
  const file = await loadProjectAssetFile(assetId, assetId, signal, diagnostics, isCurrent);
  throwIfAborted(signal);
  if (isCurrent && !isCurrent()) throw new DOMException('Project loading was superseded.', 'AbortError');
  const url = URL.createObjectURL(file);
  trackUrl?.(url);
  return url;
}

export const useScenePersistence = ({
  setModels,
  setAttachments,
  setSockets,
  setBlueprints,
  setTextures,
  setAudioAssets,
  setLevelObjects,
  setSelectedModelId,
  setIsLoading,
  defaultBlueprints,
  hydrateProjectState,
  hydrateGraphs,
  getCurrentLevelId,
  commitHydration,
}: ScenePersistenceProps) => {

  const { startOperation } = useOperationActions();

  const restoreSession = useCallback(async (
    onProgress?: HydrationProgress,
    signal?: AbortSignal,
    diagnostics?: DiagnosticContext,
    transition?: EditorSessionTransition,
  ) => {
      const expectedStatus = projectService.getStatus();
      const expectedProjectId = expectedStatus.projectId;
      const expectedRevision = expectedStatus.revision;
      const hydrationController = new AbortController();
      const abortFromCaller = () => hydrationController.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (signal?.aborted) hydrationController.abort();
      const unsubscribeSession = editorSession.subscribe(() => {
        if (transition && !editorSession.isTransitionCurrent(transition)) hydrationController.abort();
      });
      const unsubscribeProject = projectService.subscribe((status) => {
        if (status.projectId !== expectedProjectId || status.revision !== expectedRevision) hydrationController.abort();
      });
      const hydrationSignal = hydrationController.signal;
      const ownedOperation = onProgress ? null : startOperation({
        kind: 'project.hydrate',
        phase: 'project_snapshot',
        label: 'Loading project assets',
        detail: 'Reading project snapshot',
        progress: 0,
        cancellable: false,
      });
      const activeDiagnostics = diagnostics || (ownedOperation ? {
        operationId: ownedOperation.id,
        traceId: ownedOperation.traceId,
        spanId: ownedOperation.spanId,
      } : undefined);
      const report: HydrationProgress = onProgress || ((progress, detail, phase, diagnostic) => ownedOperation?.update({
        progress,
        detail,
        ...(phase ? { phase } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      }));
      let outcome: 'success' | 'failure' = 'success';
      let failure: unknown;
      let published = false;
      const detached = createDetachedHydration(defaultBlueprints);
      let assetFailureCount = 0;
      const assertCurrent = () => {
        throwIfAborted(hydrationSignal);
        const currentStatus = projectService.getStatus();
        if (currentStatus.projectId !== expectedProjectId || currentStatus.revision !== expectedRevision) {
          throw new DOMException('Project loading was superseded.', 'AbortError');
        }
        if (transition && !editorSession.isTransitionCurrent(transition)) {
          throw new DOMException('Project loading was superseded.', 'AbortError');
        }
      };
      setIsLoading(true);
      try {
        assertCurrent();
        report(0.01, 'Reading project snapshot', 'project_snapshot');
        // Project data is host-owned. A snapshot is intentionally attempted
        // before the legacy browser store; the latter is read-only and exists
        // only to keep older workspaces recoverable during migration.
        try {
          const nativeProject = expectedProjectId;
          const snapshot = nativeProject ? await projectService.getSnapshotAll(undefined, activeDiagnostics) : null;
          assertCurrent();
          if (nativeProject && projectService.getStatus().projectId !== nativeProject) {
            throw new DOMException('Native project was replaced during hydration.', 'AbortError');
          }
          if (nativeProject && snapshot && (
            snapshot.projectId !== nativeProject || snapshot.revision !== expectedRevision
          )) {
            throw new Error('Native project snapshot identity did not match the requested project revision.');
          }
          if (nativeProject && snapshot) {
            const hydrated = await hydrateSnapshot(
              snapshot, detachedTargets(detached), report, hydrationSignal, activeDiagnostics,
              transition ? () => editorSession.isTransitionCurrent(transition) : undefined,
            );
            assertCurrent();
            if (!hydrated) throw new Error('Native project snapshot did not contain a valid domain payload');
            publishDetachedHydration(detached, {
              setModels, setAttachments, setSockets, setBlueprints, setTextures,
              setAudioAssets, setLevelObjects, setSelectedModelId, setIsLoading,
              defaultBlueprints, hydrateProjectState, hydrateGraphs, commitHydration,
            });
            published = true;
            return;
          }
        } catch (error) {
          // A cancelled/superseded native read must never fall through to the
          // legacy store: doing so could publish a replacement into a closed
          // or newer project.
          if (hydrationSignal.aborted || (transition && !editorSession.isTransitionCurrent(transition))) throw error;
          if (projectService.getStatus().projectId) throw error;
          frontendDiagnostics.record('frontend', 'frontend.warning', {
            code: 'native_snapshot_unavailable', errorType: diagnosticErrorType(error),
          }, activeDiagnostics);
        }
        const [dbModels, dbAttachments, dbSockets, dbBlueprints, dbTextures, dbAudios] = await Promise.all([
          dbOperations.getAllModels(),
          dbOperations.getAllAttachments(),
          dbOperations.getAllSockets(),
          dbOperations.getAllBlueprints(),
          dbOperations.getAllTextures(),
          dbOperations.getAllAudio()
        ]);
        assertCurrent();
        report(0.08, 'Reading legacy project assets', 'source_read');

        // 1. Restore Blueprints
        if (setBlueprints) {
            let finalBlueprints = dbBlueprints;
            if (dbBlueprints.length === 0 && defaultBlueprints && defaultBlueprints.length > 0) {
                finalBlueprints = defaultBlueprints;
            } 
                detached.blueprints = finalBlueprints;
        }

        // 2. Restore Textures
        if (setTextures && dbTextures) {
            const loadedTextures: TextureData[] = [];
            for (const dbT of dbTextures) {
                const url = URL.createObjectURL(dbT.file);
                detached.ownedUrls.add(url);
                loadedTextures.push({
                    id: dbT.id,
                    name: dbT.name,
                    url,
                    dimensions: dbT.dimensions
                });
            }
            detached.textures = loadedTextures;
        }

        // 3. Restore Audio
        if (setAudioAssets && dbAudios) {
            const loadedAudio: AudioData[] = [];
            for (const dbA of dbAudios) {
                const url = URL.createObjectURL(dbA.file);
                detached.ownedUrls.add(url);
                loadedAudio.push({
                    id: dbA.id,
                    name: dbA.name,
                    url,
                    type: dbA.type,
                    duration: dbA.duration
                });
            }
            detached.audioAssets = loadedAudio;
        }

        // 4. Restore Models
        const loadedModels: LoadedModelData[] = [];
        detached.models = loadedModels;
        for (const [modelIndex, dbM] of dbModels.entries()) {
          const assetAlias = frontendDiagnostics.nextAssetAlias();
          let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: dbM.category === 'Animation' ? 'animation' : 'model' };
          let activePhase: string = 'source_read';
          let loadedModel: LoadedModelData | null = null;
          try {
            const file = new File([dbM.file], dbM.name, { type: 'application/octet-stream' });
            diagnostic = assetDiagnosticAttributes(file, dbM.category === 'Animation' ? 'animation' : 'model', assetAlias);
            const assetTrace = activeDiagnostics?.operationId && activeDiagnostics.traceId
              ? { operationId: activeDiagnostics.operationId, traceId: activeDiagnostics.traceId, assetAlias }
              : undefined;
            const loaded = await loadFBXFile(file, {
              normalize: dbM.category !== 'Animation',
              manualId: dbM.id,
              signal: hydrationSignal,
              diagnostics: assetTrace,
              onProgress: (progress, phase) => {
                activePhase = phase;
                report(
                  0.1 + ((modelIndex + progress) / Math.max(1, dbModels.length + dbAttachments.length)) * 0.75,
                  `${importPhaseLabel(phase)} — ${dbM.name}`,
                  phase,
                  diagnostic,
                );
              },
            });
            loadedModel = loaded;
            assertCurrent();
            loaded.category = dbM.category || 'Prop';
            if (loaded.category === 'Animation') stripGeometry(loaded.object);
            loaded.thumbnail = dbM.thumbnail;
            loaded.isPlacedInScene = dbM.isPlacedInScene;
            loaded.textureOverrides = dbM.textureOverrides;
            
            if (loaded.textureOverrides && Object.keys(loaded.textureOverrides).length > 0 && loaded.object) {
                const loader = new THREE.TextureLoader();
                for (const [matName, base64] of Object.entries(loaded.textureOverrides)) {
                    const tex = await loader.loadAsync(base64);
                    // Track immediately: an identity assertion can fail
                    // before this texture is attached to the model.
                    detached.standaloneTextures.add(tex);
                    assertCurrent();
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.flipY = true;
                    let attached = false;
                    loaded.object.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const mesh = child as THREE.Mesh;
                            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                            materials.forEach((m: any) => {
                                if (m.name === matName) {
                                    attached = true;
                                    if (m.map) m.map.dispose();
                                    m.map = tex;
                                    m.transparent = true;
                                    m.alphaTest = 0.5;
                                    m.side = THREE.DoubleSide;
                                    m.needsUpdate = true;
                                }
                            });
                        }
                    });
                    if (attached) detached.standaloneTextures.delete(tex);
                }
            }

            if (!loaded.thumbnail && loaded.object && loaded.category !== 'Animation') {
                activePhase = 'thumbnail_generation';
                report(0.84, `Generating thumbnail — ${dbM.name}`, activePhase, diagnostic);
                loaded.thumbnail = generateThumbnail(loaded.object);
            }

            if (dbM.animationFiles && dbM.animationFiles.length > 0) {
              const animClips = [];
              for (const animFile of dbM.animationFiles) {
                 const animationAlias = frontendDiagnostics.nextAssetAlias();
                 const aFile = new File([animFile.file], animFile.name, { type: 'application/octet-stream' });
                 const animationDiagnostic = assetDiagnosticAttributes(aFile, 'animation', animationAlias);
                 const animationTrace = activeDiagnostics?.operationId && activeDiagnostics.traceId
                   ? { operationId: activeDiagnostics.operationId, traceId: activeDiagnostics.traceId, assetAlias: animationAlias }
                   : undefined;
                  let tempLoaded: LoadedModelData | null = null;
                  try {
                     tempLoaded = await loadFBXFile(aFile, {
                       normalize: false,
                       signal: hydrationSignal,
                       diagnostics: animationTrace,
                       onProgress: (progress, phase) => report(
                         0.1 + ((modelIndex + progress) / Math.max(1, dbModels.length + dbAttachments.length)) * 0.75,
                         `${importPhaseLabel(phase)} — ${animFile.name}`,
                         phase,
                         animationDiagnostic,
                       ),
                     });
                     assertCurrent();
                     report(0.86, `Binding animation — ${animFile.name}`, 'animation_binding', animationDiagnostic);
                    const prepared = prepareAnimationClips(loaded.object, tempLoaded.object, tempLoaded.animations);
                    animClips.push(...prepared.clips);
                    report(0.88, `Bound animation — ${animFile.name}`, 'animation_binding', {
                      ...animationDiagnostic, bindingMode: prepared.mode, clipCount: prepared.clips.length,
                    });
                  } finally {
                     if (tempLoaded) disposeModel(tempLoaded);
                  }
              }
              loaded.animations = [...loaded.animations, ...animClips];
            }
            loadedModels.push(loaded);
            report(
              0.1 + ((modelIndex + 1) / Math.max(1, dbModels.length + dbAttachments.length)) * 0.75,
              `Loaded model — ${dbM.name}`,
              'library_publication',
              diagnostic,
            );
            await new Promise(r => setTimeout(r, 50));
            assertCurrent();
          } catch (e) {
            if (loadedModel) {
              const publishedIndex = loadedModels.indexOf(loadedModel);
              if (publishedIndex >= 0) loadedModels.splice(publishedIndex, 1);
              try { disposeModel(loadedModel); } catch { /* best effort */ }
            }
            frontendDiagnostics.record('frontend', 'frontend.failure', {
              ...diagnostic, phase: activePhase, code: 'legacy_model_hydration_failed', errorType: diagnosticErrorType(e),
            }, activeDiagnostics, true);
            assetFailureCount += 1;
          }
        }
        // 5. Restore Attachments
        const loadedAttachments: AttachmentData[] = [];
        detached.attachments = loadedAttachments;
        for (const [attachmentIndex, dbA] of dbAttachments.entries()) {
            const assetAlias = frontendDiagnostics.nextAssetAlias();
            let diagnostic: DiagnosticAttributes = { assetAlias, assetKind: 'attachment' };
            let activePhase: string = 'source_read';
            let loadedAttachment: LoadedModelData | null = null;
            try {
                const file = new File([dbA.file], dbA.name, { type: 'application/octet-stream' });
                diagnostic = assetDiagnosticAttributes(file, 'attachment', assetAlias);
                const assetTrace = activeDiagnostics?.operationId && activeDiagnostics.traceId
                  ? { operationId: activeDiagnostics.operationId, traceId: activeDiagnostics.traceId, assetAlias }
                  : undefined;
                const loaded = await loadFBXFile(file, {
                  normalize: false,
                  manualId: dbA.id,
                  signal: hydrationSignal,
                  diagnostics: assetTrace,
                  onProgress: (progress, phase) => {
                    activePhase = phase;
                    report(
                      0.1 + ((dbModels.length + attachmentIndex + progress) / Math.max(1, dbModels.length + dbAttachments.length)) * 0.75,
                      `${importPhaseLabel(phase)} — ${dbA.name}`,
                      phase,
                      diagnostic,
                    );
                  },
                });
                loadedAttachment = loaded;
                assertCurrent();
                loadedAttachments.push({
                    id: dbA.id,
                    name: dbA.name,
                    url: loaded.url,
                    object: loaded.object,
                    parentModelId: dbA.parentModelId,
                    boneName: dbA.boneName,
                    position: dbA.position,
                    rotation: dbA.rotation,
                    scale: dbA.scale
                });
                report(
                  0.1 + ((dbModels.length + attachmentIndex + 1) / Math.max(1, dbModels.length + dbAttachments.length)) * 0.75,
                  `Loaded attachment — ${dbA.name}`,
                  'library_publication',
                  diagnostic,
                );
            } catch (e) {
                if (loadedAttachment) {
                  try { disposeModel(loadedAttachment); } catch { /* best effort */ }
                }
                frontendDiagnostics.record('frontend', 'frontend.failure', {
                  ...diagnostic, phase: activePhase, code: 'legacy_attachment_hydration_failed', errorType: diagnosticErrorType(e),
                }, activeDiagnostics, true);
                assetFailureCount += 1;
            }
        }
        // 6. Restore Sockets
        detached.sockets = dbSockets;

        // 7. Level Objects (Legacy Migration Handling)
        const levels = await dbOperations.getAllLevels();
        assertCurrent();
        detached.levels = levels;
        if (levels.length === 0) {
             const defaultLevel = { id: 'default_level', name: 'Main Level', createdAt: Date.now() };
             // Do not write defaults to the legacy database. The native host
             // creates the initial level in the canonical project repository.
             
             // Migrate orphans
             const allObjects = await dbOperations.getAllLevelObjects();
             assertCurrent();
             let migratedCount = 0;
             for (const obj of allObjects) {
                 if (!obj.levelId) {
                     obj.levelId = defaultLevel.id;
                     // Legacy objects remain untouched; normalization is part
                     // of host-side migration, not browser persistence.
                     migratedCount++;
                 }
             }
             if (migratedCount > 0) frontendDiagnostics.record('frontend', 'frontend.warning', {
               code: 'legacy_objects_normalized', count: migratedCount,
             }, activeDiagnostics);
        }

        // Selection
        const placedModels = loadedModels.filter(m => m.isPlacedInScene);
        if (placedModels.length > 0 && !dbBlueprints.length) {
            detached.selectedModelId = placedModels[0].id;
        }
        report(1, 'Project assets ready', 'library_publication');
        assertCurrent();
        if (assetFailureCount > 0) {
          throw new Error(`Project hydration failed for ${assetFailureCount} asset${assetFailureCount === 1 ? '' : 's'}`);
        }
        publishDetachedHydration(detached, {
          setModels, setAttachments, setSockets, setBlueprints, setTextures,
          setAudioAssets, setLevelObjects, setSelectedModelId, setIsLoading,
          defaultBlueprints, hydrateProjectState, hydrateGraphs, commitHydration,
        });
        published = true;

      } catch (err) {
        outcome = 'failure';
        failure = err;
        frontendDiagnostics.record('frontend', 'frontend.failure', {
          phase: 'project_hydration', code: 'project_hydration_failed', errorType: diagnosticErrorType(err),
        }, activeDiagnostics, true);
        if (projectService.getStatus().projectId) throw err;
      } finally {
        if (!published) disposeDetachedHydration(detached);
        ownedOperation?.finish(outcome, failure);
        // StrictMode cleanup/setup and replacement transitions may leave an
        // older run in finally after a newer run has started. That run must
        // not clear the newer run's loading indicator.
        unsubscribeSession();
        unsubscribeProject();
        signal?.removeEventListener('abort', abortFromCaller);
        if (!hydrationSignal.aborted && (!transition || editorSession.isTransitionCurrent(transition))) {
          setIsLoading(false);
        }
      }
  }, [setModels, setAttachments, setSockets, setBlueprints, setTextures, setAudioAssets, setLevelObjects, setSelectedModelId, setIsLoading, defaultBlueprints, hydrateProjectState, hydrateGraphs, getCurrentLevelId, commitHydration, startOperation]);
  
  useEffect(() => {
    const controller = new AbortController();
    // Enter the barrier before even the asynchronous status refresh. This
    // makes initial setup/cleanup/setup indistinguishable from replacement.
    const transition = editorSession.beginTransition();
    void projectService.refreshStatus().then(() => {
      if (controller.signal.aborted || !editorSession.isTransitionCurrent(transition)) {
        throw new DOMException('Initial project restore was superseded.', 'AbortError');
      }
      return restoreSession(undefined, controller.signal, undefined, transition);
    }).then(() => {
      if (!transition) return;
      if (!editorSession.isTransitionCurrent(transition)) throw new DOMException('Initial project restore was superseded.', 'AbortError');
      const status = projectService.getStatus();
      if (status.projectId) {
        if (!editorSession.complete(transition, status.projectId, getCurrentLevelId?.() || null, status.revision)) {
          throw new DOMException('Initial project restore was superseded.', 'AbortError');
        }
      } else if (!editorSession.close(transition)) {
        throw new DOMException('Initial project restore was superseded.', 'AbortError');
      }
    }).catch((error) => {
      if (controller.signal.aborted || (transition && !editorSession.isTransitionCurrent(transition))) return;
      if (transition) editorSession.fail(transition);
      frontendDiagnostics.failure('initial_project_restore_failed', error);
    });
    return () => {
      controller.abort();
      if (transition && editorSession.isTransitionCurrent(transition)) editorSession.fail(transition);
    };
    // Project replacement is hydrated explicitly by useProjectManager. This
    // effect owns initial mount only; restoreSession is diagnostically wrapped
    // and therefore does not have stable function identity across renders.
  }, []);

  return frontendDiagnostics.traceActions('scene_persistence', { restoreSession });
};
