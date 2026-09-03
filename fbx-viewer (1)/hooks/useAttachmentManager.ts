
import { useState, useCallback, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { AttachmentData, LoadedModelData } from '../types';
import { importPhaseLabel, loadFBXFile } from '../utils/modelLoader';
import { disposeObject } from '../utils/processing/ModelLifecycle';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { isAbortError, useOperationActions } from '../context/OperationContext';
import { useNotification } from '../context/NotificationContext';
import { assetDiagnosticAttributes, frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, type EditorSessionLease } from '../utils/editorSession';

export const useAttachmentManager = (
  models: LoadedModelData[],
  setIsLoading: (loading: boolean) => void
) => {
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const { startOperation } = useOperationActions();
  const { addNotification } = useNotification();
  
  // Refs for debouncing DB updates
  const pendingUpdatesRef = useRef<Map<string, { updates: Partial<AttachmentData>; lease: EditorSessionLease }>>(new Map());
  const saveTimeoutRef = useRef<any>(null);
  const commitInFlightRef = useRef<Promise<void> | null>(null);

  // Helper to commit updates to DB
  const commitUpdates = useCallback((): Promise<void> => {
      if (commitInFlightRef.current) return commitInFlightRef.current;
      const run = async () => {
          const batch = new Map<string, { updates: Partial<AttachmentData>; lease: EditorSessionLease }>(pendingUpdatesRef.current);
          for (const [id, pending] of batch.entries()) {
              // A transition invalidates the lease. Discarding stale work is
              // safer than allowing a timer from project A to write project B.
              if (!editorSession.isSameSession(pending.lease)) {
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
                  continue;
              }
              try {
                  await dbOperations.updateAttachment(id, pending.updates, pending.lease);
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
              } catch (error) {
                  // Keep the exact failed entry for a later retry while its
                  // project session remains valid; never lose a user edit
                  // merely because a sequential flush failed.
                  frontendDiagnostics.failure('attachment_batch_save_failed', error);
              }
          }
      };
      const promise = run().finally(() => { commitInFlightRef.current = null; });
      commitInFlightRef.current = promise;
      return promise;
  }, []);

  // Flush updates on unmount
  useEffect(() => {
    return () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
            void commitUpdates();
        }
        pendingUpdatesRef.current.clear();
    };
  }, [commitUpdates]);

  // Project transitions invalidate every delayed attachment write before the
  // replacement project can become ready.
  useEffect(() => editorSession.subscribe(() => {
      if (editorSession.getSnapshot().phase !== 'ready') {
          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
          pendingUpdatesRef.current.clear();
      }
  }), []);

  const addAttachment = useCallback(async (file: File, parentModelId: string) => {
    projectService.assertWritable();
    const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
    const assetAlias = frontendDiagnostics.nextAssetAlias();
    const diagnostic = assetDiagnosticAttributes(file, 'attachment', assetAlias);
    const operation = startOperation({
      kind: 'asset.attachment.import',
      phase: 'source_read',
      label: `Importing ${file.name}`,
      detail: 'Reading attachment source',
      progress: 0,
      cancellable: true,
      diagnostic,
    });
    let loaded: LoadedModelData | null = null;
    let outcome: 'success' | 'failure' | 'cancelled' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
        loaded = await loadFBXFile(file, {
          normalize: false,
          signal: operation.signal,
          diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
          onProgress: (progress, phase) => operation.update({
            phase, progress: progress * 0.7, detail: importPhaseLabel(phase), diagnostic,
          }),
        });
        
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

        operation.update({ phase: 'project_upload', progress: 0.72, detail: 'Saving attachment source', diagnostic });
        await dbOperations.addAttachment({
            id: newAttachment.id,
            name: newAttachment.name,
            file: file,
            parentModelId: newAttachment.parentModelId,
            boneName: newAttachment.boneName,
            position: newAttachment.position,
            rotation: newAttachment.rotation,
            scale: newAttachment.scale,
        }, {
            signal: operation.signal,
            diagnostics: { operationId: operation.id, traceId: operation.traceId, spanId: operation.spanId, assetAlias },
            onPhase: (phase) => operation.update({ phase, detail: phase === 'project_upload' ? 'Saving attachment source' : 'Finalizing project record', diagnostic }),
            onProgress: (progress) => {
              if (progress >= 1) operation.lockCancellation();
              operation.update({ progress: 0.72 + progress * 0.25, detail: progress >= 1 ? 'Finalizing project record' : 'Saving attachment source' });
            },
        }, lease);
        if (operation.signal.aborted) throw new DOMException('Attachment import was cancelled.', 'AbortError');
        if (!editorSession.isSameSession(lease)) throw new DOMException('Attachment import was superseded.', 'AbortError');
        operation.update({ phase: 'library_publication', progress: 0.98, detail: 'Publishing attachment', diagnostic });
        setAttachments(prev => [...prev, newAttachment]);
        loaded = null;
        addNotification({ message: `Imported attachment "${file.name}".`, type: 'success' });

    } catch (error) {
        outcome = isAbortError(error) ? 'cancelled' : 'failure';
        failure = error;
        if (loaded) {
          URL.revokeObjectURL(loaded.url);
          disposeObject(loaded.object);
        }
        addNotification({
          message: isAbortError(error) ? `Cancelled import of "${file.name}".` : `Failed to import attachment "${file.name}".`,
          type: isAbortError(error) ? 'info' : 'error',
        });
    } finally {
        operation.finish(outcome, failure);
        setIsLoading(false);
    }
  }, [setIsLoading, startOperation, addNotification]);

  const addAttachmentFromLibrary = useCallback(async (sourceModelId: string, parentModelId: string) => {
    projectService.assertWritable();
    setIsLoading(true);
    try {
        const sourceModel = models.find(m => m.id === sourceModelId);
        if (!sourceModel) throw new Error("Source model not found");

        const response = await fetch(sourceModel.url);
        const blob = await response.blob();
        const file = new File([blob], sourceModel.name, { type: 'application/octet-stream' });
        
        await addAttachment(file, parentModelId);
    } catch (e) {
        frontendDiagnostics.failure('attachment_library_add_failed', e);
        alert("Failed to add attachment from library.");
    } finally {
        setIsLoading(false);
    }
  }, [models, addAttachment, setIsLoading]);

  const updateAttachment = useCallback((id: string, updates: Partial<AttachmentData>) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
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
          const existing = pendingUpdatesRef.current.get(id);
          pendingUpdatesRef.current.set(id, {
            updates: { ...(existing?.updates || {}), ...dbFields },
            lease,
          });

          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
      }
  }, [commitUpdates]);

  const removeAttachment = useCallback(async (id: string) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      if (pendingUpdatesRef.current.has(id)) {
          pendingUpdatesRef.current.delete(id);
      }
      
      try {
          await dbOperations.deleteAttachment(id, lease);
          if (!editorSession.isSameSession(lease)) return;
          setAttachments(prev => {
              const toRemove = prev.find(a => a.id === id);
              if (toRemove) {
                  if (toRemove.url) URL.revokeObjectURL(toRemove.url);
                  disposeObject(toRemove.object);
              }
              return prev.filter(a => a.id !== id);
          });
      } catch (e) {
          frontendDiagnostics.failure('attachment_remove_failed', e);
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

  return frontendDiagnostics.traceActions('attachment_manager', {
    attachments,
    setAttachments,
    addAttachment,
    addAttachmentFromLibrary,
    updateAttachment,
    removeAttachment,
    removeAttachmentsByParentId
  });
};
