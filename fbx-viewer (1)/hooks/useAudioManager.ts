
import { useState, useCallback } from 'react';
import { AudioData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';

export const useAudioManager = (setIsLoading: (loading: boolean) => void) => {
  const [audioAssets, setAudioAssets] = useState<AudioData[]>([]);
  const { addNotification } = useNotification();

  const addAudio = useCallback(async (file: File): Promise<string | null> => {
    projectService.assertWritable();
    setIsLoading(true);
    try {
        // Basic validation
        if (!file.type.startsWith('audio/')) {
            throw new Error("Invalid file type. Please upload an audio file.");
        }

        const url = URL.createObjectURL(file);
        
        // Load audio metadata (duration) using a temporary Audio element
        const audioEl = new Audio(url);
        await new Promise((resolve, reject) => {
            audioEl.onloadedmetadata = resolve;
            audioEl.onerror = reject;
        });
        const duration = audioEl.duration;

        const newAudio: AudioData = {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            type: file.type,
            duration
        };

        // 1. Optimistic Update
        setAudioAssets(prev => [...prev, newAudio]);

        // 2. Persist to DB
        await dbOperations.addAudio({
            id: newAudio.id,
            name: newAudio.name,
            file: file,
            type: newAudio.type,
            duration: newAudio.duration
        });

        addNotification({ message: `Audio "${newAudio.name}" imported.`, type: 'success' });
        return newAudio.id;

    } catch (e: any) {
        console.error("Failed to add audio", e);
        addNotification({ message: `Failed to import audio: ${e.message}`, type: 'error' });
        return null;
    } finally {
        setIsLoading(false);
    }
  }, [setIsLoading, addNotification]);

  const removeAudio = useCallback(async (id: string) => {
    projectService.assertWritable();
      try {
          await dbOperations.deleteAudio(id);
          setAudioAssets(prev => {
              const toRemove = prev.find(a => a.id === id);
              if (toRemove && toRemove.url) URL.revokeObjectURL(toRemove.url);
              return prev.filter(a => a.id !== id);
          });
          addNotification({ message: "Audio deleted.", type: 'info' });
      } catch (e) {
          console.error("Failed to delete audio", e);
          addNotification({ message: "Failed to delete audio.", type: 'error' });
      }
  }, [addNotification]);

  return {
      audioAssets,
      setAudioAssets, // Exposed for persistence loading
      addAudio,
      removeAudio
  };
};
