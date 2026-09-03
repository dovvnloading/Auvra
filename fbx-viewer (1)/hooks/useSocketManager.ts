import { useState, useCallback, useRef, useEffect } from 'react';
import { SocketData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, type EditorSessionLease } from '../utils/editorSession';

export const useSocketManager = () => {
  const [sockets, setSockets] = useState<SocketData[]>([]);
  
  // Refs for debouncing DB updates
  const pendingUpdatesRef = useRef<Map<string, { updates: Partial<SocketData>; lease: EditorSessionLease; previous: SocketData }>>(new Map());
  const saveTimeoutRef = useRef<any>(null);
  const commitInFlightRef = useRef<Promise<void> | null>(null);

  const commitUpdates = useCallback((): Promise<void> => {
      if (commitInFlightRef.current) return commitInFlightRef.current;
      const run = async () => {
          const batch = new Map<string, { updates: Partial<SocketData>; lease: EditorSessionLease; previous: SocketData }>(pendingUpdatesRef.current);
          for (const [id, pending] of batch.entries()) {
              if (!editorSession.isSameSession(pending.lease)) {
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
                  continue;
              }
              try {
                  await dbOperations.updateSocket(id, pending.updates, pending.lease);
                  if (pendingUpdatesRef.current.get(id) === pending) pendingUpdatesRef.current.delete(id);
              } catch (error) {
                  if (pendingUpdatesRef.current.get(id) === pending) {
                      pendingUpdatesRef.current.delete(id);
                      setSockets(current => current.map((socket) => socket.id === id ? pending.previous : socket));
                  }
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

    try {
        await dbOperations.addSocket(newSocket, lease);
        if (!editorSession.isSameSession(lease)) return;
        setSockets(prev => [...prev, newSocket]);
    } catch(e) {
        frontendDiagnostics.failure('socket_add_failed', e);
    }
  }, []);

  const updateSocket = useCallback((id: string, updates: Partial<SocketData>) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      const previous = sockets.find((socket) => socket.id === id);
      if (!previous) return;
      setSockets(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

      // Queue DB update
      const existing = pendingUpdatesRef.current.get(id);
      pendingUpdatesRef.current.set(id, {
        updates: { ...(existing?.updates || {}), ...updates },
        lease,
        previous: existing?.previous || previous,
      });

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
  }, [commitUpdates, sockets]);

  const removeSocket = useCallback(async (id: string) => {
      projectService.assertWritable();
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      if (pendingUpdatesRef.current.has(id)) {
          pendingUpdatesRef.current.delete(id);
      }
      try {
          await dbOperations.deleteSocket(id, lease);
          if (!editorSession.isSameSession(lease)) return;
          setSockets(prev => prev.filter(s => s.id !== id));
      } catch(e) { frontendDiagnostics.failure('socket_delete_failed', e); }
  }, []);

  const removeSocketsByParentId = useCallback(async (parentId: string, persist = true) => {
      const toRemove = sockets.filter(s => s.parentModelId === parentId);
      if (!persist) {
          setSockets(prev => prev.filter(s => s.parentModelId !== parentId));
          return;
      }
      const lease = editorSession.requireWritable(editorSession.captureReady(), projectService.getStatus());
      try {
          await Promise.all(toRemove.map((socket) => dbOperations.deleteSocket(socket.id, lease)));
          if (!editorSession.isSameSession(lease)) return;
          setSockets(prev => prev.filter(s => s.parentModelId !== parentId));
      } catch (error) {
      frontendDiagnostics.failure('socket_cleanup_failed', error);
      }
  }, [sockets]);

  const removeTextureReference = useCallback((textureId: string) => {
      for (const [id, pending] of pendingUpdatesRef.current.entries()) {
          if (pending.updates.flashConfig?.textureId !== textureId) continue;
          const { flashConfig: _removed, ...updates } = pending.updates;
          const { flashConfig: _previous, ...previous } = pending.previous;
          if (Object.keys(updates).length === 0) {
              pendingUpdatesRef.current.delete(id);
          } else {
              pendingUpdatesRef.current.set(id, { ...pending, updates, previous });
          }
      }
      setSockets(previous => previous.map(socket => {
          if (socket.flashConfig?.textureId !== textureId) return socket;
          const { flashConfig: _removed, ...withoutTextureReference } = socket;
          return withoutTextureReference;
      }));
  }, []);

  return frontendDiagnostics.traceActions('socket_manager', {
      sockets,
      setSockets, // Exposed for persistence loading
      addSocket,
      updateSocket,
      removeSocket,
      removeSocketsByParentId,
      removeTextureReference,
  });
};
