import { useState, useCallback, useRef, useEffect } from 'react';
import { SocketData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';

export const useSocketManager = () => {
  const [sockets, setSockets] = useState<SocketData[]>([]);
  
  // Refs for debouncing DB updates
  const pendingUpdatesRef = useRef<Map<string, any>>(new Map());
  const saveTimeoutRef = useRef<any>(null);

  const commitUpdates = useCallback(async () => {
      if (pendingUpdatesRef.current.size === 0) return;
      const batch = new Map<string, any>(pendingUpdatesRef.current);
      pendingUpdatesRef.current.clear();
      
      try {
          for (const [id, updates] of batch.entries()) await dbOperations.updateSocket(id, updates);
      } catch (e) {
          console.error("Error saving batched socket updates", e);
      }
  }, []);

  useEffect(() => {
    return () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            commitUpdates();
        }
    };
  }, [commitUpdates]);

  const addSocket = useCallback(async (parentModelId: string, name: string) => {
    projectService.assertWritable();
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
        await dbOperations.addSocket(newSocket);
    } catch(e) {
        console.error("Failed to add socket", e);
    }
  }, []);

  const updateSocket = useCallback((id: string, updates: Partial<SocketData>) => {
      projectService.assertWritable();
      setSockets(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

      // Queue DB update
      const existing = pendingUpdatesRef.current.get(id) || {};
      pendingUpdatesRef.current.set(id, { ...existing, ...updates });

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
  }, [commitUpdates]);

  const removeSocket = useCallback(async (id: string) => {
      projectService.assertWritable();
      if (pendingUpdatesRef.current.has(id)) {
          pendingUpdatesRef.current.delete(id);
      }
      setSockets(prev => prev.filter(s => s.id !== id));
      
      try {
          await dbOperations.deleteSocket(id);
      } catch(e) { console.error(e); }
  }, []);

  const removeSocketsByParentId = useCallback((parentId: string, persist = true) => {
      if (persist) projectService.assertWritable();
      setSockets(prev => {
          const toRemove = prev.filter(s => s.parentModelId === parentId);
          if (persist) toRemove.forEach(s => dbOperations.deleteSocket(s.id).catch(console.error));
          return prev.filter(s => s.parentModelId !== parentId);
      });
  }, []);

  return {
      sockets,
      setSockets, // Exposed for persistence loading
      addSocket,
      updateSocket,
      removeSocket,
      removeSocketsByParentId
  };
};
