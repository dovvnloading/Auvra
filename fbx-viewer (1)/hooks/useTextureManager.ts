
import { useState, useCallback } from 'react';
import { AssetInfoUpdate, TextureData } from '../types';
import { dbOperations, normalizeAssetInfoUpdate } from '../utils/db';
import { projectService } from '../utils/projectService';
import { materialLibrary } from '../runtime/materials/materialLibrary';
import { useNotification } from '../context/NotificationContext';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { assetDiagnosticAttributes, frontendDiagnostics } from '../diagnostics/runtime';
import { importFailureMessage } from '../utils/modelLoader';
import { browserReadsWholly, pictureToRgba8, pngDepthOf, sniffPictureFormat } from '../texturing/textureDecode';
import { decodePictureOffPage } from '../texturing/texturePipeline';
import { encodePng } from '../texturing/png';
import { setTextureSettings, settingsFromName, type TextureSettings } from '../texturing/textureSettings';

/**
 * A deep picture (16-bit, floating point, TIFF, TGA, PSD) read whole off the page: its size, what the file
 * was, and an 8-bit preview for the places that show a picture. Null for what the browser reads whole.
 */
const readDeepPicture = async (file: File): Promise<{ dimensions: { width: number; height: number }; settings: TextureSettings; preview: Blob } | null> => {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const format = sniffPictureFormat(head, file.name);
  if (!format) throw new Error('This file is not a picture that can be imported as a texture.');
  if (browserReadsWholly(format, pngDepthOf(head))) return null;
  const picture = await decodePictureOffPage(new Uint8Array(await file.arrayBuffer()), file.name);
  const preview = await encodePng(pictureToRgba8(picture), picture.width, picture.height, 4);
  return {
    dimensions: { width: picture.width, height: picture.height },
    settings: { ...settingsFromName(file.name), source: { format, depth: picture.depth, channels: picture.channels, ...(picture.hdr ? { hdr: true } : {}) } },
    preview,
  };
};

/** A PNG cut short still shows, with the rest of it blank, so the browser cannot be asked. Its last chunk says it is all there. */
const isCutShortPng = async (file: File): Promise<boolean> => {
  if (file.type !== 'image/png') return false;
  const tail = new Uint8Array(await file.slice(-1024).arrayBuffer());
  return !String.fromCharCode(...tail).includes('IEND');
};

export const useTextureManager = (setIsLoading: (loading: boolean) => void) => {
  const [textures, setTextures] = useState<TextureData[]>([]);
  const { addNotification } = useNotification();
  const { startOperation } = useOperationActions();

  const addTexture = useCallback(async (file: File): Promise<string | null> => {
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
        projectService.assertWritable();
        await projectService.assertStorable(file);
        if (await isCutShortPng(file)) throw new Error('The image could not be read. It may be damaged or cut short.');
        // A deep picture keeps its depth: decoded off the page, shown through an 8-bit preview.
        const deep = await readDeepPicture(file);
        if (deep) {
          url = URL.createObjectURL(deep.preview);
          const sourceUrl = URL.createObjectURL(file);
          const deepTexture: TextureData = { id: crypto.randomUUID(), name: file.name, url, dimensions: deep.dimensions, settings: deep.settings, sourceUrl };
          operation.update({ phase: 'project_upload', progress: 0.2, detail: 'Saving texture source', diagnostic });
          await dbOperations.addTexture({ id: deepTexture.id, name: deepTexture.name, file, dimensions: deep.dimensions, settings: deep.settings, preview: deep.preview }, {
            signal: operation.signal,
            diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
            onProgress: (progress) => operation.update({ progress: 0.2 + progress * 0.76, detail: 'Saving texture source' }),
          });
          if (operation.signal.aborted) throw new DOMException('Texture import was cancelled.', 'AbortError');
          setTextureSettings(deepTexture.id, deep.settings);
          // Material assets draw with the file itself, before the project is opened again.
          materialLibrary.addTextureUrl(deepTexture.id, sourceUrl);
          setTextures(prev => [...prev, deepTexture]);
          url = null;
          addNotification({ message: `Texture "${deepTexture.name}" saved to library at ${deep.settings.source?.depth ?? 8} bits a channel.`, type: 'success' });
          return deepTexture.id;
        }
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
          img.onerror = () => { cleanup(); reject(new Error('The image could not be read. It may be damaged, or not an image at all.')); };
        });
        const dimensions = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };

        // What its name says it is (a normal map, data): Texture Settings can change it.
        const named = settingsFromName(file.name);
        const newTexture: TextureData = {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            dimensions,
            ...(named ? { settings: named } : {}),
        };

        operation.update({ phase: 'project_upload', progress: 0.2, detail: 'Saving texture source', diagnostic });
        await dbOperations.addTexture({
            id: newTexture.id,
            name: newTexture.name,
            file: file,
            dimensions: newTexture.dimensions,
            ...(named ? { settings: named } : {}),
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
        // Material assets can draw with it before the project is opened again.
        if (named) setTextureSettings(newTexture.id, named);
        materialLibrary.addTextureUrl(newTexture.id, newTexture.url);
        url = null;
        addNotification({ message: `Texture "${newTexture.name}" saved to library.`, type: 'success' });
        return newTexture.id;

    } catch (e) {
        outcome = isAbortError(e) ? 'cancelled' : 'failure';
        failure = e;
        if (url) URL.revokeObjectURL(url);
        addNotification({
          message: isAbortError(e) ? `Cancelled import of "${file.name}".` : importFailureMessage(`Failed to import "${file.name}"`, e),
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

  const removeTexture = useCallback(async (id: string): Promise<boolean> => {
    projectService.assertWritable();
      try {
          await dbOperations.deleteTexture(id);
          setTextures(prev => {
              const toRemove = prev.find(t => t.id === id);
              if (toRemove && toRemove.url) URL.revokeObjectURL(toRemove.url);
              return prev.filter(t => t.id !== id);
          });
          addNotification({ message: "Texture deleted.", type: 'info' });
          return true;
      } catch (e) {
          frontendDiagnostics.failure('texture_remove_failed', e);
          addNotification({ message: "Failed to delete texture.", type: 'error' });
          return false;
      }
  }, [addNotification]);

  /** Rename and/or move a texture (folder '' is the library root); rejects when the change cannot be saved. */
  const updateTexture = useCallback(async (id: string, updates: AssetInfoUpdate): Promise<void> => {
      projectService.assertWritable();
      const info = normalizeAssetInfoUpdate(updates);
      if (info.name === undefined && info.folder === undefined) return;
      try {
          await dbOperations.updateTextureInfo(id, info);
      } catch (e) {
          frontendDiagnostics.failure('texture_info_update_failed', e);
          throw e;
      }
      setTextures(prev => prev.map(t => (t.id === id ? { ...t, ...info } : t)));
  }, []);

  /** A texture the host has just kept in the project: into the library and material graphs without reopening it. */
  const adoptHostTexture = useCallback(async (id: string, name: string, assetId: string, dimensions: { width: number; height: number }) => {
    const response = await fetch(await projectService.resolveAsset(assetId));
    if (!response.ok) throw new Error('The kept texture could not be read.');
    const url = URL.createObjectURL(await response.blob());
    materialLibrary.addTextureUrl(id, url);
    setTextures((previous) => (previous.some((texture) => texture.id === id) ? previous : [...previous, { id, name, url, dimensions }]));
  }, []);

  return frontendDiagnostics.traceActions('texture_manager', {
      textures,
      setTextures, // Exposed for persistence loading
      addTexture,
      adoptHostTexture,
      saveTextureToLibrary,
      removeTexture,
      updateTexture
  });
};
