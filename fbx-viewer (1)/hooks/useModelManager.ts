
import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AssetCategory } from '../types';
import { importPhaseLabel, loadFBXFile } from '../utils/modelLoader';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { prepareAnimationClips } from '../utils/animationBinding';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { useNotification } from '../context/NotificationContext';
import { assetDiagnosticAttributes, frontendDiagnostics } from '../diagnostics/runtime';

export const useModelManager = (
  setIsLoading: (loading: boolean) => void,
  onModelRemoved: (id: string) => void
) => {
  const [models, setModels] = useState<LoadedModelData[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const { startOperation } = useOperationActions();
  const { addNotification } = useNotification();

  const addModel = useCallback(async (file: File, category: AssetCategory) => {
    projectService.assertWritable();
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
        diagnostics: { operationId: operation.id, traceId: operation.traceId, assetAlias },
        onProgress: (progress, phase) => operation.update({
          phase, progress: progress * 0.68, detail: importPhaseLabel(phase), diagnostic,
        }),
      });
      newModel.category = category;
      newModel.thumbnail = undefined;
      newModel.isPlacedInScene = false;

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
      await dbOperations.addModel({
        id: newModel.id,
        name: newModel.name,
        file,
        animationFiles: [],
        category: newModel.category,
        thumbnail: newModel.thumbnail,
        isPlacedInScene: false,
        textureOverrides: {},
      }, {
        signal: operation.signal,
        diagnostics: { operationId: operation.id, traceId: operation.traceId, assetAlias },
        onPhase: (phase) => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving source asset' : 'Finalizing project record', diagnostic }),
        onProgress: (progress) => {
          if (progress >= 1) operation.lockCancellation();
          operation.update({ progress: 0.72 + progress * 0.24, detail: progress >= 1 ? 'Finalizing project record' : 'Saving source asset' });
        },
      });

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

  const placeInScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: true } : m));
      setSelectedModelId(id);
      try {
          await dbOperations.updateModelPlacement(id, true);
      } catch(e) { frontendDiagnostics.failure('model_placement_update_failed', e); }
  }, []);

  const removeFromScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: false } : m));
      if (selectedModelId === id) setSelectedModelId(null);
      try {
          await dbOperations.updateModelPlacement(id, false);
      } catch(e) { frontendDiagnostics.failure('model_placement_remove_failed', e); }
  }, [selectedModelId]);

  const removeModel = useCallback(async (id: string) => {
    projectService.assertWritable();
    try {
        await dbOperations.deleteModel(id);
        
        setModels(prev => {
          const modelToRemove = prev.find(m => m.id === id);
          if (modelToRemove) {
              disposeModel(modelToRemove);
          }
          return prev.filter(m => m.id !== id);
        });
        
        // Callback to cleanup attachments in the other hook
        onModelRemoved(id);

        if (selectedModelId === id) {
          setSelectedModelId(null);
        }
    } catch (e) {
        frontendDiagnostics.failure('model_delete_failed', e);
    }
  }, [selectedModelId, onModelRemoved]);

  const addAnimations = useCallback(async (files: File[], modelId: string) => {
    projectService.assertWritable();
    const aliases = files.map(() => frontendDiagnostics.nextAssetAlias());
    const initialDiagnostic = files[0]
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
          diagnostics: { operationId: operation.id, traceId: operation.traceId, assetAlias },
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
        diagnostics: { operationId: operation.id, traceId: operation.traceId, assetAlias: aliases[0] },
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
        
        const newModelData = await loadFBXFile(file, { normalize: true, manualId: modelId });
        
        newModelData.category = model.category;
        newModelData.animations = model.animations;
        newModelData.isPlacedInScene = model.isPlacedInScene;
        newModelData.textureOverrides = {}; // Clear overrides

        // Clear DB overrides
        await dbOperations.updateModelTextureOverrides(modelId, {});

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

  return {
    models,
    setModels,
    selectedModelId,
    setSelectedModelId, // Exposed for useScenePersistence
    selectModel: setSelectedModelId, // Alias
    addModel,
    removeModel,
    placeInScene,
    removeFromScene,
    addAnimations,
    retextureModel,
    previewTexture,
    resetModelTexture
  };
};
