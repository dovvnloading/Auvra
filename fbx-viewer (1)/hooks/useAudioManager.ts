
import { useState, useCallback } from 'react';
import { AudioData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { assetDiagnosticAttributes, frontendDiagnostics } from '../diagnostics/runtime';

export const useAudioManager = (setIsLoading: (loading: boolean) => void) => {
  const [audioAssets, setAudioAssets] = useState<AudioData[]>([]);
  const { addNotification } = useNotification();
  const { startOperation } = useOperationActions();

  const addAudio = useCallback(async (file: File): Promise<string | null> => {
    projectService.assertWritable();
    const assetAlias = frontendDiagnostics.nextAssetAlias();
    const diagnostic = assetDiagnosticAttributes(file, 'audio', assetAlias);
    const operation = startOperation({
      kind: 'asset.audio.import',
      phase: 'source_read',
      label: `Importing ${file.name}`,
      detail: 'Reading audio metadata',
      progress: 0,
      cancellable: true,
      diagnostic,
    });
    let url: string | null = null;
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
        // Basic validation
        if (!file.type.startsWith('audio/')) {
            throw new Error("Invalid file type. Please upload an audio file.");
        }

        url = URL.createObjectURL(file);
        
        // Load audio metadata (duration) using a temporary Audio element
        const audioEl = new Audio(url);
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              operation.signal.removeEventListener('abort', abort);
              audioEl.onloadedmetadata = null;
              audioEl.onerror = null;
            };
            const abort = () => {
              cleanup();
              audioEl.pause();
              audioEl.removeAttribute('src');
              audioEl.load();
              reject(new DOMException('Audio import was cancelled.', 'AbortError'));
            };
            operation.signal.addEventListener('abort', abort, { once: true });
            audioEl.onloadedmetadata = () => { cleanup(); resolve(); };
            audioEl.onerror = () => { cleanup(); reject(new Error('Audio metadata could not be read.')); };
        });
        const duration = audioEl.duration;

        const newAudio: AudioData = {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            type: file.type,
            duration
        };

        operation.update({ phase: 'project_upload', progress: 0.2, detail: 'Saving audio source', diagnostic });
        await dbOperations.addAudio({
            id: newAudio.id,
            name: newAudio.name,
            file: file,
            type: newAudio.type,
            duration: newAudio.duration,
        }, {
            signal: operation.signal,
            diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
            onPhase: (phase) => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving audio source' : 'Finalizing project record', diagnostic }),
            onProgress: (progress) => {
              if (progress >= 1) operation.lockCancellation();
              operation.update({ progress: 0.2 + progress * 0.76, detail: progress >= 1 ? 'Finalizing project record' : 'Saving audio source' });
            },
        });

        if (operation.signal.aborted) throw new DOMException('Audio import was cancelled.', 'AbortError');
        operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing audio', diagnostic });
        setAudioAssets(prev => [...prev, newAudio]);
        url = null;
        addNotification({ message: `Audio "${newAudio.name}" imported.`, type: 'success' });
        return newAudio.id;

    } catch (e: any) {
        outcome = isAbortError(e) ? 'cancelled' : 'failure';
        failure = e;
        if (url) URL.revokeObjectURL(url);
        addNotification({
          message: isAbortError(e) ? `Cancelled import of "${file.name}".` : `Failed to import audio: ${e.message}`,
          type: isAbortError(e) ? 'info' : 'error',
        });
        return null;
    } finally {
        operation.finish(outcome, failure);
        setIsLoading(false);
    }
  }, [setIsLoading, addNotification, startOperation]);

  const removeAudio = useCallback(async (id: string): Promise<boolean> => {
    projectService.assertWritable();
      try {
          await dbOperations.deleteAudio(id);
          setAudioAssets(prev => {
              const toRemove = prev.find(a => a.id === id);
              if (toRemove && toRemove.url) URL.revokeObjectURL(toRemove.url);
              return prev.filter(a => a.id !== id);
          });
          addNotification({ message: "Audio deleted.", type: 'info' });
          return true;
      } catch (e) {
          frontendDiagnostics.failure('audio_remove_failed', e);
          addNotification({ message: "Failed to delete audio.", type: 'error' });
          return false;
      }
  }, [addNotification]);

  return frontendDiagnostics.traceActions('audio_manager', {
      audioAssets,
      setAudioAssets, // Exposed for persistence loading
      addAudio,
      removeAudio
  });
};
