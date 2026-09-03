import { useState, useCallback, useRef, useEffect } from 'react';
import { SocketData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, type EditorSessionLease } from '../utils/editorSession';

export const useSocketManager = () => {
  const [sockets, setSockets] = useState<SocketData[]>([]);
  
  // Refs for debouncing DB updates
  const pendingUpdatesRef = useRef<Map<string, { updates: Partial<SocketData>; lease: EditorSessionLease }>>(new Map());
  const saveTimeoutRef = useRef<any>(null);
  const commitInFlightRef = useRef<Promise<void> | null>(null);

  const commitUpdates = useCallback((): Promise<void> => {
      if (commitInFlightRef.current) return commitInFlightRef.current;
      const run = async () => {
          const batch = new Map<string, { updates: Partial<SocketData>; lease: EditorSessionLease }>(pendingUpdatesRef.current);
          for (const [id, pending] of batch.entries()) {
              if (!editorSession.isSameSession(pending.lease)) {
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
                  continue;
              }
              try {
                  await dbOperations.updateSocket(id, pending.updates, pending.lease);
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
              } catch (error) {
                  // Preserve the failed entry for a later retry while its
                  // exact project session is still valid.
                  frontendDiagnostics.failure('socket_batch_persist_failed', error);
              }
          }
      };
      const promise = run().finally(() => { commitInFlightRef.current = null; });
      commitInFlightRef.current = promise;
      return promise;
  }, []);

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

  useEffect(() => editorSession.subscribe(() => {
      if (editorSession.getSnapshot().phase !== 'ready') {
          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
          pendingUpdatesRef.current.clear();
      }
  }), []);

  const addSocket = useCallback(async (parentModelId: string, name: string) => {
    projectService.assertWritable();
    const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
    const newSocket: SocketData = {
        id: crypto.randomUUID(),
        name: name,
        parentModelId,
        boneName: '', // Default to root or user must select
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
    };

    setSockets(prev => [...prev, newSocket]);
    
    try {
        await dbOperations.addSocket(newSocket, lease);
        if (!editorSession.isSameSession(lease)) return;
    } catch(e) {
        frontendDiagnostics.failure('socket_add_failed', e);
    }
  }, []);

  const updateSocket = useCallback((id: string, updates: Partial<SocketData>) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      setSockets(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

      // Queue DB update
      const existing = pendingUpdatesRef.current.get(id);
      pendingUpdatesRef.current.set(id, {
        updates: { ...(existing?.updates || {}), ...updates },
        lease,
      });

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
  }, [commitUpdates]);

  const removeSocket = useCallback(async (id: string) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      if (pendingUpdatesRef.current.has(id)) {
          pendingUpdatesRef.current.delete(id);
      }
      setSockets(prev => prev.filter(s => s.id !== id));
      
      try {
          await dbOperations.deleteSocket(id, lease);
          if (!editorSession.isSameSession(lease)) return;
      } catch(e) { frontendDiagnostics.failure('socket_delete_failed', e); }
  }, []);

  const removeSocketsByParentId = useCallback((parentId: string, persist = true) => {
      const lease = persist
          ? editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus())
          : undefined;
      setSockets(prev => {
          const toRemove = prev.filter(s => s.parentModelId === parentId);
          if (persist) toRemove.forEach(s => dbOperations.deleteSocket(s.id, lease).catch((error) => frontendDiagnostics.failure('socket_cleanup_failed', error)));
          return prev.filter(s => s.parentModelId !== parentId);
      });
  }, []);

  return frontendDiagnostics.traceActions('socket_manager', {
      sockets,
      setSockets, // Exposed for persistence loading
      addSocket,
      updateSocket,
      removeSocket,
      removeSocketsByParentId
  });
};
