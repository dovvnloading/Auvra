
import { useState, useCallback } from 'react';
import { TextureData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { assetDiagnosticAttributes, frontendDiagnostics } from '../diagnostics/runtime';

export const useTextureManager = (setIsLoading: (loading: boolean) => void) => {
  const [textures, setTextures] = useState<TextureData[]>([]);
  const { addNotification } = useNotification();
  const { startOperation } = useOperationActions();

  const addTexture = useCallback(async (file: File): Promise<string | null> => {
    projectService.assertWritable();
    const assetAlias = frontendDiagnostics.nextAssetAlias();
    const diagnostic = assetDiagnosticAttributes(file, 'texture', assetAlias);
    const operation = startOperation({
      kind: 'asset.texture.import',
      phase: 'source_read',
      label: `Importing ${file.name}`,
      detail: 'Reading image metadata',
      progress: 0,
      cancellable: true,
      diagnostic,
    });
    let url: string | null = null;
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
        url = URL.createObjectURL(file);
        
        // Read dimensions
        const img = new Image();
        img.src = url;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            operation.signal.removeEventListener('abort', abort);
            img.onload = null;
            img.onerror = null;
          };
          const abort = () => {
            cleanup();
            img.src = '';
            reject(new DOMException('Texture import was cancelled.', 'AbortError'));
          };
          operation.signal.addEventListener('abort', abort, { once: true });
          img.onload = () => { cleanup(); resolve(); };
          img.onerror = () => { cleanup(); reject(new Error('Texture metadata could not be read.')); };
        });
        const dimensions = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };

        const newTexture: TextureData = {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            dimensions
        };

        operation.update({ phase: 'project_upload', progress: 0.2, detail: 'Saving texture source', diagnostic });
        await dbOperations.addTexture({
            id: newTexture.id,
            name: newTexture.name,
            file: file,
            dimensions: newTexture.dimensions,
        }, {
            signal: operation.signal,
            diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
            onPhase: (phase) => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving texture source' : 'Finalizing project record', diagnostic }),
            onProgress: (progress) => {
              if (progress >= 1) operation.lockCancellation();
              operation.update({ progress: 0.2 + progress * 0.76, detail: progress >= 1 ? 'Finalizing project record' : 'Saving texture source' });
            },
        });

        if (operation.signal.aborted) throw new DOMException('Texture import was cancelled.', 'AbortError');
        operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing texture', diagnostic });
        setTextures(prev => [...prev, newTexture]);
        url = null;
        addNotification({ message: `Texture "${newTexture.name}" saved to library.`, type: 'success' });
        return newTexture.id;

    } catch (e) {
        outcome = isAbortError(e) ? 'cancelled' : 'failure';
        failure = e;
        if (url) URL.revokeObjectURL(url);
        addNotification({
          message: isAbortError(e) ? `Cancelled import of "${file.name}".` : 'Failed to save texture to the project.',
          type: isAbortError(e) ? 'info' : 'error',
        });
        return null;
    } finally {
        operation.finish(outcome, failure);
        setIsLoading(false);
    }
  }, [setIsLoading, addNotification, startOperation]);

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
          frontendDiagnostics.failure('texture_library_save_failed', e);
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
          frontendDiagnostics.failure('texture_remove_failed', e);
          addNotification({ message: "Failed to delete texture.", type: 'error' });
      }
  }, [addNotification]);

  return frontendDiagnostics.traceActions('texture_manager', {
      textures,
      setTextures, // Exposed for persistence loading
      addTexture,
      saveTextureToLibrary,
      removeTexture
  });
};
