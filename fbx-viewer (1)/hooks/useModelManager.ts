
import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AssetCategory } from '../types';
import { loadFBXFile } from '../utils/modelLoader';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { dbOperations } from '../utils/db';

export const useModelManager = (
  setIsLoading: (loading: boolean) => void,
  onModelRemoved: (id: string) => void
) => {
  const [models, setModels] = useState<LoadedModelData[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  const addModel = useCallback(async (file: File, category: AssetCategory) => {
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
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: true } : m));
      setSelectedModelId(id);
      try {
          await dbOperations.updateModelPlacement(id, true);
      } catch(e) { console.error(e); }
  }, []);

  const removeFromScene = useCallback(async (id: string) => {
      setModels(prev => prev.map(m => m.id === id ? { ...m, isPlacedInScene: false } : m));
      if (selectedModelId === id) setSelectedModelId(null);
      try {
          await dbOperations.updateModelPlacement(id, false);
      } catch(e) { console.error(e); }
  }, [selectedModelId]);

  const removeModel = useCallback(async (id: string) => {
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

  const retextureModel = useCallback((modelId: string, textureUrl: string, targetTextureUuid?: string) => {
    const loader = new THREE.TextureLoader();
    loader.load(textureUrl, (newTexture) => {
      newTexture.colorSpace = THREE.SRGBColorSpace;
      newTexture.flipY = true; 
      
      setModels(prev => prev.map(model => {
        if (model.id === modelId) {
          
          let targetMapUUID: string | null = targetTextureUuid || null;

          // If no specific target UUID is provided, try to guess the primary texture (legacy behavior)
          if (!targetMapUUID) {
              model.object.traverse((child) => {
                 if (targetMapUUID) return;
                 if ((child as THREE.Mesh).isMesh) {
                     const mat = (child as THREE.Mesh).material;
                     if (Array.isArray(mat)) {
                         for (const m of mat) if ((m as any).map) { targetMapUUID = (m as any).map.uuid; break; }
                     } else {
                         if ((mat as any).map) targetMapUUID = (mat as any).map.uuid;
                     }
                 }
              });
          }

          // Capture overrides to persist
          const newOverrides: Record<string, string> = { ...(model.textureOverrides || {}) };
          let hasUpdates = false;

          // Apply to matching materials
          model.object.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              const material = mesh.material;
              
              const applyToMaterial = (m: any) => {
                  if (m.isMeshStandardMaterial || m.isMeshPhongMaterial) {
                      // Logic: 
                      // 1. If target provided, match strictly.
                      // 2. If target NOT provided but map exists on material, match heuristic primary found above.
                      // 3. If target NOT provided and NO map on material, apply broadly (fresh paint).
                      
                      const matchesTarget = targetMapUUID && m.map && m.map.uuid === targetMapUUID;
                      const isUntextured = !targetMapUUID && !m.map;
                      
                      if (matchesTarget || isUntextured) {
                          // Dispose old if exists
                          if (m.map) m.map.dispose();
                          m.map = newTexture;
                          
                          // FORCE TRANSPARENCY SETTINGS for masks to function correctly
                          m.transparent = true;
                          m.alphaTest = 0.5; 
                          m.side = THREE.DoubleSide;
                          
                          m.needsUpdate = true;

                          // Persist based on Material Name
                          if (m.name) {
                              newOverrides[m.name] = textureUrl;
                              hasUpdates = true;
                          }
                      }
                  }
              };

              if (Array.isArray(material)) {
                material.forEach(applyToMaterial);
              } else {
                applyToMaterial(material);
              }
            }
          });
          
          if (hasUpdates) {
              // Persist to DB asynchronously
              dbOperations.updateModelTextureOverrides(modelId, newOverrides).catch(e => 
                  console.error("Failed to persist texture override:", e)
              );
              // Update React state
              return { ...model, textureOverrides: newOverrides };
          }

          // Return a shallow copy to trigger React updates (activeModel change detection)
          return { ...model };
        }
        return model;
      }));
    });
  }, []);

  const resetModelTexture = useCallback(async (modelId: string) => {
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
    resetModelTexture
  };
};
