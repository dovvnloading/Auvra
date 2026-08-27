
import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AssetCategory } from '../types';
import { loadFBXFile } from '../utils/modelLoader';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';

export const useModelManager = (
  setIsLoading: (loading: boolean) => void,
  onModelRemoved: (id: string) => void
) => {
  const [models, setModels] = useState<LoadedModelData[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  const addModel = useCallback(async (file: File, category: AssetCategory) => {
    projectService.assertWritable();
    // Prevent duplicate imports
    if (models.some(m => m.name === file.name)) {
        alert(`A model named "${file.name}" is already loaded in the library.`);
        return;
    }

    setIsLoading(true);
    try {
      // For Animation category, we don't normalize to avoid bounding box issues with bones-only
      const newModel = await loadFBXFile(file, { normalize: category !== 'Animation' });
      newModel.category = category;
      newModel.thumbnail = undefined;
      // Default to FALSE: Not in scene, just in library
      newModel.isPlacedInScene = false;
      
      if (category === 'Animation') {
          stripGeometry(newModel.object);
      } else if (newModel.object) {
          // Generate thumbnail for non-animation assets immediately
          newModel.thumbnail = generateThumbnail(newModel.object);
      }
      
      // Safety check for duplicate IDs
      setModels(prev => {
          if (prev.some(m => m.id === newModel.id)) {
              console.warn("Attempted to add duplicate model ID:", newModel.id);
              return prev;
          }
          return [...prev, newModel];
      });

      await dbOperations.addModel({
          id: newModel.id,
          name: newModel.name,
          file: file,
          animationFiles: [],
          category: newModel.category,
          thumbnail: newModel.thumbnail,
          isPlacedInScene: false,
          textureOverrides: {} 
      });

      // Do NOT automatically select/place in scene upon import.
      
    } catch (error) {
      console.error("Failed to load FBX:", error);
      alert(`Error loading ${file.name}. Check console.`);
    } finally {
      setIsLoading(false);
    }
  }, [models, setIsLoading]);

  const placeInScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: true } : m));
      setSelectedModelId(id);
      try {
          await dbOperations.updateModelPlacement(id, true);
      } catch(e) { console.error(e); }
  }, []);

  const removeFromScene = useCallback(async (id: string) => {
      projectService.assertWritable();
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: false } : m));
      if (selectedModelId === id) setSelectedModelId(null);
      try {
          await dbOperations.updateModelPlacement(id, false);
      } catch(e) { console.error(e); }
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
        console.error("Failed to delete model from DB", e);
    }
  }, [selectedModelId, onModelRemoved]);

  const addAnimations = useCallback(async (files: File[], modelId: string) => {
    projectService.assertWritable();
    setIsLoading(true);
    try {
      const allNewClips: THREE.AnimationClip[] = [];

      for (const file of files) {
        const loaded = await loadFBXFile(file, { normalize: false });
        
        if (loaded.animations.length > 0) {
            // Use names as cleaned by loadFBXFile
            const clips = loaded.animations.map(clip => clip.clone());
            allNewClips.push(...clips);
        }
        
        disposeModel(loaded);
      }

      if (allNewClips.length === 0) {
        alert("No valid animations found in the selected files.");
        return;
      }

      setModels(prev => prev.map(model => {
        if (model.id === modelId) {
          return {
            ...model,
            animations: [...model.animations, ...allNewClips]
          };
        }
        return model;
      }));
      
      await dbOperations.addAnimations(modelId, files);

    } catch (error) {
      console.error("Failed to load animations:", error);
      alert("Error loading animation files.");
    } finally {
      setIsLoading(false);
    }
  }, [setIsLoading]);

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
      console.error('Failed to persist texture override:', error);
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
        console.error("Failed to reset model texture", e);
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
