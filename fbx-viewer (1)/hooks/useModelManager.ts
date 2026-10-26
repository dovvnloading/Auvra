
import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AssetCategory, AssetInfoUpdate, ModelImportSettings } from '../types';
import { importPhaseLabel, loadFBXFile } from '../utils/modelLoader';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { applyModelImportSettings, resolveImportSettings, stripGeometry } from '../utils/processing/ModelTransforms';
import { prepareAnimationClips } from '../utils/animationBinding';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { dbOperations, normalizeAssetInfoUpdate, withoutMaterialOverrideTexture } from '../utils/db';
import { projectService } from '../utils/projectService';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { useNotification } from '../context/NotificationContext';
import { assetDiagnosticAttributes, frontendDiagnostics, type DiagnosticAttributes } from '../diagnostics/runtime';
import {
  applyMaterialOverrides,
  collectOverrideTextures,
  normalizeMaterialOverrides,
  overrideTextureCacheKey,
  type MaterialOverrides,
} from '../utils/materialOverrides';

const MODEL_MIME_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', fbx: 'model/fbx',
};

const extensionOf = (name: string): string => /\.[^./\\]+$/.exec(name)?.[0] ?? '';

/** The source file as uploaded: named `name` and typed by its extension so the host records the format. */
const modelSourceFile = (file: Blob, name: string): File => {
  const mime = MODEL_MIME_TYPES[extensionOf(name).slice(1).toLowerCase()] || file.type || 'application/octet-stream';
  return file instanceof File && file.name === name && file.type === mime ? file : new File([file], name, { type: mime });
};

/** A reimported model keeps its library name; only the extension follows the new source format. */
const reimportedModelName = (current: string, source: string): string => {
  const next = extensionOf(source);
  const previous = extensionOf(current);
  if (!next || next.toLowerCase() === previous.toLowerCase()) return current;
  return `${previous ? current.slice(0, -previous.length) : current}${next}`;
};

const nativeDocuments = (snapshot: Awaited<ReturnType<typeof projectService.getSnapshotAll>>, domain: string): Array<Record<string, any>> => {
  const raw = snapshot?.domains?.[domain];
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { documents?: unknown[] }).documents)
      ? (raw as { documents: unknown[] }).documents : [];
  return values.filter((value): value is Record<string, any> => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'));
};

/** Move material-override textures from a replaced model onto same-named materials of its replacement. */
const adoptOverrideTextures = (from: THREE.Object3D, to: THREE.Object3D, materialNames: string[]): void => {
  if (!materialNames.length) return;
  const names = new Set(materialNames);
  const eachMaterial = (root: THREE.Object3D, visit: (material: any) => void) => root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const material = (child as THREE.Mesh).material;
    for (const candidate of (Array.isArray(material) ? material : [material]) as any[]) {
      if (candidate && names.has(candidate.name)) visit(candidate);
    }
  });
  const textures = new Map<string, THREE.Texture>();
  eachMaterial(from, (material) => { if (material.map && !textures.has(material.name)) textures.set(material.name, material.map); });
  const adopted = new Set<THREE.Texture>();
  eachMaterial(to, (material) => {
    const texture = textures.get(material.name);
    if (!texture) return;
    if (material.map && material.map !== texture) material.map.dispose();
    material.map = texture;
    material.transparent = true;
    material.alphaTest = 0.5;
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    adopted.add(texture);
  });
  // Adopted textures now belong to the replacement and must survive disposal of the old model.
  eachMaterial(from, (material) => { if (adopted.has(material.map)) material.map = null; });
};

/**
 * Restore `root`'s materials to their imported values and hand back the
 * textures its material overrides had bound (keyed `${slot}:${textureId}`),
 * so disposing `root` afterwards leaves them alone.
 */
const detachMaterialOverrides = (root: THREE.Object3D): Map<string, THREE.Texture> => {
  const textures = collectOverrideTextures(root);
  applyMaterialOverrides(root, {});
  return textures;
};

/**
 * Apply `overrides` to `root`, binding textures from `textures` (from
 * `detachMaterialOverrides` or the object itself). Textures left unbound are
 * disposed: bound ones are owned by the materials, like any imported map.
 */
const attachMaterialOverrides = (root: THREE.Object3D, overrides: MaterialOverrides, textures: Map<string, THREE.Texture>): void => {
  const { boundTextureKeys } = applyMaterialOverrides(root, overrides, (textureId, slot) => textures.get(overrideTextureCacheKey(textureId, slot)));
  for (const [key, texture] of textures) {
    if (!boundTextureKeys.has(key)) texture.dispose();
  }
};

export const useModelManager = (
  setIsLoading: (loading: boolean) => void,
  onModelRemoved: (id: string) => void,
  selectedModelId: string | null,
  selectModel: (id: string | null) => void,
  clearSelectedModel: (id: string) => void,
) => {
  const [models, setModels] = useState<LoadedModelData[]>([]);
  const { startOperation } = useOperationActions();
  const { addNotification } = useNotification();

  /** Import a model. With `requestedSettings` the import settings are applied and stored on the model document. */
  const importModel = useCallback(async (file: File, category: AssetCategory, requestedSettings?: ModelImportSettings) => {
    projectService.assertWritable();
    const importSettings = requestedSettings && category !== 'Animation' ? resolveImportSettings(requestedSettings) : undefined;
    // Prevent duplicate imports
    if (models.some(m => m.name === file.name)) {
        alert(`A model named "${file.name}" is already loaded in the library.`);
        return;
    }
    const assetAlias = frontendDiagnostics.nextAssetAlias();
    const diagnostic = assetDiagnosticAttributes(file, category === 'Animation' ? 'animation' : 'model', assetAlias);
    const operation = startOperation({
      kind: category === 'Animation' ? 'asset.animation.import' : 'asset.model.import',
      phase: 'source_read',
      label: `Importing ${file.name}`,
      detail: 'Reading FBX source',
      progress: 0,
      cancellable: true,
      diagnostic,
    });
    let newModel: LoadedModelData | null = null;
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
      newModel = await loadFBXFile(file, {
        normalize: category !== 'Animation',
        signal: operation.signal,
        diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
        onProgress: (progress, phase) => operation.update({
          phase, progress: progress * 0.68, detail: importPhaseLabel(phase), diagnostic,
        }),
      });
      newModel.category = category;
      newModel.thumbnail = undefined;
      newModel.isPlacedInScene = false;
      if (importSettings) applyModelImportSettings(newModel, importSettings);

      if (category === 'Animation') {
        stripGeometry(newModel.object);
      } else if (newModel.object) {
        let itemCount = 0;
        newModel.object.traverse(() => { itemCount += 1; });
        operation.update({ phase: 'thumbnail_generation', progress: 0.7, detail: 'Generating thumbnail', diagnostic: {
          ...diagnostic, itemCount, clipCount: newModel.animations.length,
        } });
        newModel.thumbnail = generateThumbnail(newModel.object);
      }

      operation.update({ phase: 'project_upload', progress: 0.72, detail: 'Saving source asset', diagnostic });
      const transfer = {
        signal: operation.signal,
        diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
        onPhase: (phase: 'project_upload' | 'project_record_commit') => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving source asset' : 'Finalizing project record', diagnostic }),
        onProgress: (progress: number) => {
          if (progress >= 1) operation.lockCancellation();
          operation.update({ progress: 0.72 + progress * 0.24, detail: progress >= 1 ? 'Finalizing project record' : 'Saving source asset' });
        },
      };
      if (importSettings) {
        const assetId = await projectService.uploadAsset(modelSourceFile(file, newModel.name), transfer);
        if (operation.signal.aborted) throw new DOMException('Asset import was cancelled.', 'AbortError');
        transfer.onPhase('project_record_commit');
        await projectService.applyChanges([{ domain: 'models', operation: 'upsert', id: newModel.id, value: {
          id: newModel.id, name: newModel.name, assetId, category: newModel.category, isPlacedInScene: false, importSettings,
        } }], transfer.diagnostics);
      } else {
        await dbOperations.addModel({
          id: newModel.id,
          name: newModel.name,
          file,
          animationFiles: [],
          category: newModel.category,
          thumbnail: newModel.thumbnail,
          isPlacedInScene: false,
          textureOverrides: {},
        }, transfer);
      }

      if (operation.signal.aborted) throw new DOMException('Asset import was cancelled.', 'AbortError');
      operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing to library', diagnostic });
      const completedModel = newModel;
      setModels((previous) => {
        if (previous.some((model) => model.id === completedModel.id)) {
          frontendDiagnostics.warning('duplicate_model_publication');
          disposeModel(completedModel);
          return previous;
        }
        return [...previous, completedModel];
      });
      newModel = null;
      addNotification({ message: `Imported "${file.name}".`, type: 'success' });
    } catch (error) {
      outcome = isAbortError(error) ? 'cancelled' : 'failure';
      failure = error;
      if (newModel) disposeModel(newModel);
      addNotification({
        message: isAbortError(error) ? `Cancelled import of "${file.name}".` : `Failed to import "${file.name}".`,
        type: isAbortError(error) ? 'info' : 'error',
      });
    } finally {
      operation.finish(outcome, failure);
      setIsLoading(false);
    }
  }, [models, setIsLoading, startOperation, addNotification]);

  const addModel = useCallback((file: File, category: AssetCategory) => importModel(file, category), [importModel]);

  /** Import with explicit options (normalize toggle, target size); the settings are stored on the model document. */
  const importModelWithOptions = useCallback(
    (file: File, settings: ModelImportSettings, category: AssetCategory = 'Prop') => importModel(file, category, settings),
    [importModel],
  );

  /**
   * Replace a model's source file in place. The model keeps its id, name, category,
   * placement, overrides and import settings, so placed objects and blueprints that
   * reference it keep working; clips from its animation documents are rebound to the
   * new skeleton. Nothing is committed unless the new source loads and binds.
   */
  const reimportModel = useCallback(async (modelId: string, file: File) => {
    projectService.assertWritable();
    const existing = models.find((model) => model.id === modelId);
    if (!existing) {
      addNotification({ message: 'The model to reimport is no longer loaded.', type: 'error' });
      return;
    }
    const name = reimportedModelName(existing.name, file.name);
    if (models.some((model) => model.id !== modelId && model.name === name)) {
      alert(`A model named "${name}" is already loaded in the library.`);
      return;
    }
    const category = existing.category;
    const source = modelSourceFile(file, name);
    const assetAlias = frontendDiagnostics.nextAssetAlias();
    const diagnostic = assetDiagnosticAttributes(source, category === 'Animation' ? 'animation' : 'model', assetAlias);
    const operation = startOperation({
      kind: 'asset.model.reimport',
      phase: 'source_read',
      label: `Reimporting ${existing.name}`,
      detail: 'Reading source',
      progress: 0,
      cancellable: true,
      diagnostic,
    });
    const trace = { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias };
    const throwIfCancelled = () => {
      if (operation.signal.aborted) throw new DOMException('Asset reimport was cancelled.', 'AbortError');
    };
    let replacement: LoadedModelData | null = null;
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
      replacement = await loadFBXFile(source, {
        normalize: category !== 'Animation',
        manualId: modelId,
        signal: operation.signal,
        diagnostics: trace,
        onProgress: (progress, phase) => operation.update({
          phase, progress: progress * 0.55, detail: importPhaseLabel(phase), diagnostic,
        }),
      });
      replacement.category = category;
      replacement.isPlacedInScene = existing.isPlacedInScene;
      replacement.textureOverrides = existing.textureOverrides;
      replacement.materialOverrides = existing.materialOverrides;
      replacement.folder = existing.folder;
      const importSettings = category === 'Animation' ? undefined : applyModelImportSettings(replacement, existing.importSettings);
      if (category === 'Animation') {
        stripGeometry(replacement.object);
      } else {
        operation.update({ phase: 'thumbnail_generation', progress: 0.56, detail: 'Generating thumbnail', diagnostic });
        replacement.thumbnail = generateThumbnail(replacement.object);
      }

      const animationDocuments = nativeDocuments(await projectService.getSnapshotAll('animations', trace), 'animations')
        .filter((animation) => animation.modelId === modelId && typeof animation.assetId === 'string');
      for (const [index, animation] of animationDocuments.entries()) {
        throwIfCancelled();
        const animationName = typeof animation.name === 'string' && animation.name ? animation.name : 'animation.fbx';
        operation.update({
          phase: 'animation_binding',
          progress: 0.58 + (index / animationDocuments.length) * 0.12,
          detail: `Binding animation — ${animationName}`,
          diagnostic,
        });
        const response = await fetch(await projectService.resolveAsset(animation.assetId, trace), { method: 'GET', signal: operation.signal });
        if (!response.ok) throw new Error(`Animation download failed (${response.status})`);
        const animationFile = new File([await response.blob()], animationName, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
        const animationModel = await loadFBXFile(animationFile, { normalize: false, signal: operation.signal, diagnostics: trace });
        try {
          const prepared = prepareAnimationClips(replacement.object, animationModel.object, animationModel.animations);
          replacement.animations.push(...prepared.clips);
        } finally {
          disposeModel(animationModel);
        }
      }

      throwIfCancelled();
      operation.update({ phase: 'project_upload', progress: 0.72, detail: 'Saving source asset', diagnostic });
      const assetId = await projectService.uploadAsset(source, {
        signal: operation.signal,
        diagnostics: trace,
        onProgress: (progress) => {
          if (progress >= 1) operation.lockCancellation();
          operation.update({ progress: 0.72 + progress * 0.2, detail: progress >= 1 ? 'Finalizing project record' : 'Saving source asset' });
        },
      });
      throwIfCancelled();
      operation.update({ phase: 'project_record_commit', progress: 0.94, detail: 'Finalizing project record', diagnostic });
      const stored = nativeDocuments(await projectService.getSnapshotAll('models', trace), 'models').find((model) => model.id === modelId);
      const document: Record<string, unknown> = {
        ...(stored ?? { category, isPlacedInScene: existing.isPlacedInScene }),
        id: modelId,
        name,
        assetId,
      };
      if (importSettings) document.importSettings = importSettings;
      await projectService.applyChanges([{ domain: 'models', operation: 'upsert', id: modelId, value: document }], trace);

      operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing to library', diagnostic });
      // Material overrides sit on top of the texture overrides, so they come off
      // the old object first and go onto the replacement last.
      const materialOverrideTextures = detachMaterialOverrides(existing.object);
      adoptOverrideTextures(existing.object, replacement.object, Object.keys(existing.textureOverrides || {}));
      attachMaterialOverrides(replacement.object, normalizeMaterialOverrides(existing.materialOverrides), materialOverrideTextures);
      const published = replacement;
      replacement = null;
      setModels((previous) => previous.map((model) => (model.id === modelId ? published : model)));
      disposeModel(existing);
      addNotification({ message: `Reimported "${existing.name}".`, type: 'success' });
    } catch (error) {
      outcome = isAbortError(error) ? 'cancelled' : 'failure';
      failure = error;
      if (replacement) disposeModel(replacement);
      addNotification({
        message: isAbortError(error)
          ? `Cancelled reimport of "${existing.name}".`
          : `Failed to reimport "${existing.name}"${error instanceof Error && error.message ? `: ${error.message}` : '.'}`,
        type: isAbortError(error) ? 'info' : 'error',
      });
    } finally {
      operation.finish(outcome, failure);
      setIsLoading(false);
    }
  }, [models, setIsLoading, startOperation, addNotification]);

  const placeInScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      try {
          await dbOperations.updateModelPlacement(id, true);
          setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: true } : m));
          selectModel(id);
      } catch(e) { frontendDiagnostics.failure('model_placement_update_failed', e); }
  }, [selectModel]);

  const removeFromScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      try {
          await dbOperations.updateModelPlacement(id, false);
          setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: false } : m));
          clearSelectedModel(id);
      } catch(e) { frontendDiagnostics.failure('model_placement_remove_failed', e); }
  }, [clearSelectedModel]);

  /** Rename and/or move a model (folder '' is the library root); rejects when the change cannot be saved. */
  const updateModel = useCallback(async (id: string, updates: AssetInfoUpdate): Promise<void> => {
    projectService.assertWritable();
    const info = normalizeAssetInfoUpdate(updates);
    if (info.name === undefined && info.folder === undefined) return;
    if (!models.some((model) => model.id === id)) throw new Error('The model is no longer loaded.');
    // Imports and reimports keep model names unique across the library.
    if (info.name !== undefined && models.some((model) => model.id !== id && model.name === info.name)) {
      throw new Error(`A model named "${info.name}" is already in the library.`);
    }
    try {
      await dbOperations.updateModelInfo(id, info);
    } catch (error) {
      frontendDiagnostics.failure('model_info_update_failed', error);
      throw error;
    }
    setModels((previous) => previous.map((model) => (model.id === id ? { ...model, ...info } : model)));
  }, [models]);

  const removeModel = useCallback(async (id: string) => {
    projectService.assertWritable();
    try {
        await dbOperations.deleteModel(id);
        const modelToRemove = models.find((model) => model.id === id);
        if (modelToRemove) disposeModel(modelToRemove);
        setModels(prev => prev.filter(m => m.id !== id));
        
        // Callback to cleanup attachments in the other hook
        onModelRemoved(id);

        clearSelectedModel(id);
    } catch (e) {
        frontendDiagnostics.failure('model_delete_failed', e);
    }
  }, [clearSelectedModel, models, onModelRemoved]);

  /** Persist a model's material overrides, then apply them to its loaded object; rejects when they cannot be saved. */
  const updateModelMaterialOverrides = useCallback(async (modelId: string, overrides: MaterialOverrides): Promise<void> => {
    projectService.assertWritable();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error('The model is no longer loaded.');
    const next = normalizeMaterialOverrides(overrides);
    try {
      await dbOperations.updateModelMaterialOverrides(modelId, next);
    } catch (error) {
      frontendDiagnostics.failure('material_override_update_failed', error);
      throw error;
    }
    // The textures are normally already bound by the material editor's live preview.
    attachMaterialOverrides(model.object, next, collectOverrideTextures(model.object));
    setModels((previous) => previous.map((candidate) => (candidate.id === modelId ? { ...candidate, materialOverrides: next } : candidate)));
  }, [models]);

  const removeTextureReference = useCallback((textureId: string) => {
    setModels((previous) => previous.map((model) => {
      const overrides = model.textureOverrides;
      const nextOverrides = overrides && Object.fromEntries(
        Object.entries(overrides).filter(([, referencedTextureId]) => referencedTextureId !== textureId),
      );
      const texturesChanged = Boolean(overrides && nextOverrides && Object.keys(nextOverrides).length !== Object.keys(overrides).length);
      const materialOverrides = model.materialOverrides && withoutMaterialOverrideTexture(model.materialOverrides, textureId);
      const materialsChanged = materialOverrides !== model.materialOverrides;
      if (!texturesChanged && !materialsChanged) return model;
      // Unbind (and release) the deleted texture; applying is idempotent.
      if (materialsChanged && materialOverrides) attachMaterialOverrides(model.object, materialOverrides, collectOverrideTextures(model.object));
      return {
        ...model,
        ...(texturesChanged ? { textureOverrides: nextOverrides } : {}),
        ...(materialsChanged ? { materialOverrides } : {}),
      };
    }));
  }, []);

  const addAnimations = useCallback(async (files: File[], modelId: string) => {
    projectService.assertWritable();
    const aliases = files.map(() => frontendDiagnostics.nextAssetAlias());
    const initialDiagnostic: DiagnosticAttributes = files[0]
      ? { ...assetDiagnosticAttributes(files[0], 'animation', aliases[0]), itemCount: files.length }
      : { assetAlias: frontendDiagnostics.nextAssetAlias(), assetKind: 'animation', itemCount: 0 };
    const operation = startOperation({
      kind: 'asset.animation.import',
      phase: 'source_read',
      label: files.length === 1 ? `Importing ${files[0].name}` : `Importing ${files.length} animation files`,
      detail: 'Preparing animation sources',
      progress: 0,
      cancellable: true,
      diagnostic: initialDiagnostic,
    });
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
      const targetModel = models.find((model) => model.id === modelId);
      if (!targetModel) throw new Error('The target model is no longer loaded.');
      const allNewClips: THREE.AnimationClip[] = [];

      for (const [index, file] of files.entries()) {
        const assetAlias = aliases[index];
        const diagnostic = assetDiagnosticAttributes(file, 'animation', assetAlias);
        const loaded = await loadFBXFile(file, {
          normalize: false,
          signal: operation.signal,
          diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
          onProgress: (progress, phase) => operation.update({
            phase,
            progress: ((index + progress) / Math.max(1, files.length)) * 0.7,
            detail: `${importPhaseLabel(phase)} — ${file.name}`,
            diagnostic,
          }),
        });
        try {
          operation.update({ phase: 'animation_binding', detail: `Binding animation — ${file.name}`, diagnostic });
          const prepared = prepareAnimationClips(targetModel.object, loaded.object, loaded.animations);
          allNewClips.push(...prepared.clips);
          operation.update({ phase: 'animation_binding', diagnostic: {
            ...diagnostic, bindingMode: prepared.mode, clipCount: prepared.clips.length,
          } });
        } finally {
          disposeModel(loaded);
        }
      }

      if (allNewClips.length === 0) {
        throw new Error('No valid animations were found in the selected files.');
      }

      operation.update({ phase: 'project_upload', progress: 0.72, detail: 'Saving animation sources', diagnostic: initialDiagnostic });
      await dbOperations.addAnimations(modelId, files, {
        signal: operation.signal,
        diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias: aliases[0] },
        onPhase: (phase) => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving animation sources' : 'Finalizing project records', diagnostic: initialDiagnostic }),
        onProgress: (progress) => {
          if (progress >= 1) operation.lockCancellation();
          operation.update({ progress: 0.72 + progress * 0.25, detail: progress >= 1 ? 'Finalizing project records' : 'Saving animation sources' });
        },
      });
      if (operation.signal.aborted) throw new DOMException('Animation import was cancelled.', 'AbortError');
      operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing animations', diagnostic: {
        ...initialDiagnostic, clipCount: allNewClips.length,
      } });
      setModels(prev => prev.map(model => {
        if (model.id === modelId) {
          return {
            ...model,
            animations: [...model.animations, ...allNewClips]
          };
        }
        return model;
      }));
      addNotification({ message: `Imported ${allNewClips.length} animation clip${allNewClips.length === 1 ? '' : 's'}.`, type: 'success' });

    } catch (error) {
      outcome = isAbortError(error) ? 'cancelled' : 'failure';
      failure = error;
      addNotification({
        message: isAbortError(error)
          ? 'Animation import cancelled.'
          : error instanceof Error ? error.message : 'Error loading animation files.',
        type: isAbortError(error) ? 'info' : 'error',
      });
    } finally {
      operation.finish(outcome, failure);
      setIsLoading(false);
    }
  }, [models, setIsLoading, startOperation, addNotification]);

  const retextureModel = useCallback(async (modelId: string, textureUrl: string, targetTextureUuid?: string) => {
    projectService.assertWritable();
    try {
      const sourceResponse = await fetch(textureUrl);
      if (!sourceResponse.ok) throw new Error(`Texture fetch failed (${sourceResponse.status})`);
      const blob = await sourceResponse.blob();
      const mime = blob.type || 'image/png';
      const extension = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const file = new File([blob], `material-override.${extension}`, { type: mime });
      const newTexture = await new THREE.TextureLoader().loadAsync(textureUrl);
      newTexture.colorSpace = THREE.SRGBColorSpace;
      newTexture.flipY = true;
      const model = models.find((candidate) => candidate.id === modelId);
      if (!model) throw new Error('Model not found');
      let targetMapUUID: string | null = targetTextureUuid || null;

      if (!targetMapUUID) {
        model.object.traverse((child) => {
          if (targetMapUUID || !(child as THREE.Mesh).isMesh) return;
          const material = (child as THREE.Mesh).material;
          const materials = Array.isArray(material) ? material : [material];
          for (const candidate of materials) {
            if ((candidate as any).map) { targetMapUUID = (candidate as any).map.uuid; break; }
          }
        });
      }

      const materialNames = new Set<string>();
      model.object.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const material = (child as THREE.Mesh).material;
        const materials = Array.isArray(material) ? material : [material];
        for (const candidate of materials as any[]) {
          const matchesTarget = targetMapUUID && candidate.map?.uuid === targetMapUUID;
          const isUntextured = !targetMapUUID && !candidate.map;
          if ((matchesTarget || isUntextured) && candidate.name) materialNames.add(candidate.name);
        }
      });
      if (!materialNames.size) return;

      const textureId = await dbOperations.addModelTextureOverride(
        modelId,
        [...materialNames],
        file,
        { width: newTexture.image?.width || 0, height: newTexture.image?.height || 0 },
      );
      const newOverrides = { ...(model.textureOverrides || {}) };
      for (const materialName of materialNames) newOverrides[materialName] = textureId;
      model.object.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const material = (child as THREE.Mesh).material;
        const materials = Array.isArray(material) ? material : [material];
        for (const candidate of materials as any[]) {
          if (!materialNames.has(candidate.name)) continue;
          if (candidate.map) candidate.map.dispose();
          candidate.map = newTexture;
          candidate.transparent = true;
          candidate.alphaTest = 0.5;
          candidate.side = THREE.DoubleSide;
          candidate.needsUpdate = true;
        }
      });
      setModels((previous) => previous.map((candidate) => candidate.id === modelId
        ? { ...candidate, textureOverrides: newOverrides }
        : candidate));
    } catch (error) {
      frontendDiagnostics.failure('texture_override_persist_failed', error);
      alert('Failed to apply texture override.');
    }
  }, [models]);

  /** Apply an ephemeral material preview. It intentionally never touches the project host or DB. */
  const previewTexture = useCallback(async (modelId: string, textureUrl: string, targetTextureUuid?: string) => {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model || !textureUrl) throw new Error('Model or preview texture not found');
    const newTexture = await new THREE.TextureLoader().loadAsync(textureUrl);
    newTexture.colorSpace = THREE.SRGBColorSpace;
    newTexture.flipY = true;
    let targetMapUUID: string | null = targetTextureUuid || null;
    if (!targetMapUUID) model.object.traverse((child) => {
      if (targetMapUUID || !(child as THREE.Mesh).isMesh) return;
      const material = (child as THREE.Mesh).material;
      for (const candidate of (Array.isArray(material) ? material : [material]) as any[]) {
        if (candidate.map) { targetMapUUID = candidate.map.uuid; break; }
      }
    });
    model.object.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const material = (child as THREE.Mesh).material;
      for (const candidate of (Array.isArray(material) ? material : [material]) as any[]) {
        if (targetMapUUID && candidate.map?.uuid !== targetMapUUID) continue;
        if (!targetMapUUID && candidate.map) continue;
        if (candidate.map) candidate.map.dispose();
        candidate.map = newTexture; candidate.transparent = true; candidate.alphaTest = 0.5;
        candidate.side = THREE.DoubleSide; candidate.needsUpdate = true;
      }
    });
  }, [models]);

  const resetModelTexture = useCallback(async (modelId: string) => {
    projectService.assertWritable();
    setIsLoading(true);
    try {
        const model = models.find(m => m.id === modelId);
        if (!model) throw new Error("Model not found");

        const response = await fetch(model.url);
        const blob = await response.blob();
        const file = new File([blob], model.name, { type: 'application/octet-stream' });
        
        const newModelData = await loadFBXFile(file, { normalize: model.category !== 'Animation', manualId: modelId });
        
        newModelData.category = model.category;
        newModelData.folder = model.folder;
        applyModelImportSettings(newModelData, model.importSettings);
        newModelData.animations = model.animations;
        newModelData.isPlacedInScene = model.isPlacedInScene;
        newModelData.textureOverrides = {}; // Clear overrides
        newModelData.materialOverrides = model.materialOverrides; // Kept: edited in the Materials panel

        // Clear DB overrides
        await dbOperations.updateModelTextureOverrides(modelId, {});
        attachMaterialOverrides(newModelData.object, normalizeMaterialOverrides(model.materialOverrides), detachMaterialOverrides(model.object));

        setModels(prev => prev.map(m => {
            if (m.id === modelId) {
                disposeObject(m.object); 
                return newModelData;
            }
            return m;
        }));

    } catch (e) {
        frontendDiagnostics.failure('texture_reset_failed', e);
        alert("Failed to reset texture.");
    } finally {
        setIsLoading(false);
    }
  }, [models, setIsLoading]);

  return frontendDiagnostics.traceActions('model_manager', {
    models,
    setModels,
    selectedModelId,
    setSelectedModelId: selectModel, // Exposed for useScenePersistence
    selectModel,
    addModel,
    importModelWithOptions,
    reimportModel,
    updateModel,
    removeModel,
    removeTextureReference,
    updateModelMaterialOverrides,
    placeInScene,
    removeFromScene,
    addAnimations,
    retextureModel,
    previewTexture,
    resetModelTexture
  });
};
