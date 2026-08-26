
import { useState, useCallback, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { AttachmentData, LoadedModelData } from '../types';
import { loadFBXFile } from '../utils/modelLoader';
import { disposeObject } from '../utils/processing/ModelLifecycle';
import { dbOperations } from '../utils/db';

export const useAttachmentManager = (
  models: LoadedModelData[],
  setIsLoading: (loading: boolean) => void
) => {
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  
  // Refs for debouncing DB updates
  const pendingUpdatesRef = useRef<Map<string, any>>(new Map());
  const saveTimeoutRef = useRef<any>(null);

  // Helper to commit updates to DB
  const commitUpdates = useCallback(async () => {
      if (pendingUpdatesRef.current.size === 0) return;
      const batch = new Map<string, any>(pendingUpdatesRef.current);
      pendingUpdatesRef.current.clear();
      
      try {
          await Promise.all(Array.from(batch.entries()).map(([id, updates]) => 
               dbOperations.updateAttachment(id, updates)
          ));
      } catch (e) {
          console.error("Error saving batched updates", e);
      }
  }, []);

  // Flush updates on unmount
  useEffect(() => {
    return () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            commitUpdates();
        }
    };
  }, [commitUpdates]);

  const addAttachment = useCallback(async (file: File, parentModelId: string) => {
    setIsLoading(true);
    try {
        const loaded = await loadFBXFile(file, { normalize: false });
        
        const newAttachment: AttachmentData = {
            id: loaded.id,
            name: loaded.name,
            url: loaded.url,
            object: loaded.object,
            parentModelId,
            boneName: 'Hips', // Default
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1]
        };

        await dbOperations.addAttachment({
            id: newAttachment.id,
            name: newAttachment.name,
            file: file,
            parentModelId: newAttachment.parentModelId,
            boneName: newAttachment.boneName,
            position: newAttachment.position,
            rotation: newAttachment.rotation,
            scale: newAttachment.scale
        });
        
        setAttachments(prev => [...prev, newAttachment]);

    } catch (error) {
        console.error("Failed to load attachment:", error);
        alert("Error loading attachment.");
    } finally {
        setIsLoading(false);
    }
  }, [setIsLoading]);

  const addAttachmentFromLibrary = useCallback(async (sourceModelId: string, parentModelId: string) => {
    setIsLoading(true);
    try {
        const sourceModel = models.find(m => m.id === sourceModelId);
        if (!sourceModel) throw new Error("Source model not found");

        const response = await fetch(sourceModel.url);
        const blob = await response.blob();
        const file = new File([blob], sourceModel.name, { type: 'application/octet-stream' });
        
        await addAttachment(file, parentModelId);
    } catch (e) {
        console.error("Failed to add attachment from library", e);
        alert("Failed to add attachment from library.");
    } finally {
        setIsLoading(false);
    }
  }, [models, addAttachment, setIsLoading]);

  const updateAttachment = useCallback((id: string, updates: Partial<AttachmentData>) => {
      // 1. Update React State Immediately
      setAttachments(prev => prev.map(att => 
        att.id === id ? { ...att, ...updates } : att
      ));

      // 2. Queue DB Update (Debounced)
      const dbFields: any = {};
      if (updates.boneName !== undefined) dbFields.boneName = updates.boneName;
      if (updates.position !== undefined) dbFields.position = updates.position;
      if (updates.rotation !== undefined) dbFields.rotation = updates.rotation;
      if (updates.scale !== undefined) dbFields.scale = updates.scale;
      
      if (Object.keys(dbFields).length > 0) {
          const existing = pendingUpdatesRef.current.get(id) || {};
          pendingUpdatesRef.current.set(id, { ...existing, ...dbFields });

          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
      }
  }, [commitUpdates]);

  const removeAttachment = useCallback(async (id: string) => {
      if (pendingUpdatesRef.current.has(id)) {
          pendingUpdatesRef.current.delete(id);
      }
      
      try {
          await dbOperations.deleteAttachment(id);
          setAttachments(prev => {
              const toRemove = prev.find(a => a.id === id);
              if (toRemove) {
                  if (toRemove.url) URL.revokeObjectURL(toRemove.url);
                  disposeObject(toRemove.object);
              }
              return prev.filter(a => a.id !== id);
          });
      } catch (e) {
          console.error("Failed to remove attachment from DB", e);
      }
  }, []);

  // Utility to remove attachments when a parent model is deleted
  const removeAttachmentsByParentId = useCallback((parentId: string) => {
    setAttachments(prev => {
        const toRemove = prev.filter(a => a.parentModelId === parentId);
        toRemove.forEach(a => {
            if (a.url) URL.revokeObjectURL(a.url);
            disposeObject(a.object);
        });
        return prev.filter(a => a.parentModelId !== parentId);
    });
  }, []);

  return {
    attachments,
    setAttachments,
    addAttachment,
    addAttachmentFromLibrary,
    updateAttachment,
    removeAttachment,
    removeAttachmentsByParentId
  };
};
