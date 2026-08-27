
import { useState, useCallback } from 'react';
import { TextureData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';

export const useTextureManager = (setIsLoading: (loading: boolean) => void) => {
  const [textures, setTextures] = useState<TextureData[]>([]);
  const { addNotification } = useNotification();

  const addTexture = useCallback(async (file: File): Promise<string | null> => {
    projectService.assertWritable();
    setIsLoading(true);
    try {
        const url = URL.createObjectURL(file);
        
        // Read dimensions
        const img = new Image();
        img.src = url;
        await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
        const dimensions = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };

        const newTexture: TextureData = {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            dimensions
        };

        // 1. Optimistic Update (Immediate UI feedback)
        setTextures(prev => [...prev, newTexture]);

        // 2. Persist to DB
        await dbOperations.addTexture({
            id: newTexture.id,
            name: newTexture.name,
            file: file,
            dimensions: newTexture.dimensions
        });

        addNotification({ message: `Texture "${newTexture.name}" saved to library.`, type: 'success' });
        return newTexture.id;

    } catch (e) {
        console.error("Failed to add texture", e);
        addNotification({ message: "Failed to save texture to database.", type: 'error' });
        return null;
    } finally {
        setIsLoading(false);
    }
  }, [setIsLoading, addNotification]);

  const saveTextureToLibrary = useCallback(async (base64: string, name: string): Promise<string | null> => {
      projectService.assertWritable();
      setIsLoading(true);
      try {
          // Convert Base64 to Blob
          const res = await fetch(base64);
          const blob = await res.blob();
          const file = new File([blob], `${name}.png`, { type: 'image/png' });
          
          return await addTexture(file);
      } catch (e) {
          console.error("Failed to save texture to library", e);
          addNotification({ message: "Failed to process texture data.", type: 'error' });
          return null;
      } finally {
          setIsLoading(false);
      }
  }, [addTexture, setIsLoading, addNotification]);

  const removeTexture = useCallback(async (id: string) => {
    projectService.assertWritable();
      try {
          await dbOperations.deleteTexture(id);
          setTextures(prev => {
              const toRemove = prev.find(t => t.id === id);
              if (toRemove && toRemove.url) URL.revokeObjectURL(toRemove.url);
              return prev.filter(t => t.id !== id);
          });
          addNotification({ message: "Texture deleted.", type: 'info' });
      } catch (e) {
          console.error("Failed to delete texture", e);
          addNotification({ message: "Failed to delete texture.", type: 'error' });
      }
  }, [addNotification]);

  return {
      textures,
      setTextures, // Exposed for persistence loading
      addTexture,
      saveTextureToLibrary,
      removeTexture
  };
};
