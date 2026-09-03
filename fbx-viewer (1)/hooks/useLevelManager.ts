
import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { LevelObject, LoadedModelData, LevelObjectType, LevelData, LevelBlueprintData, TerrainData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, selectObjectsForLevel, type EditorSessionLease } from '../utils/editorSession';
import { subscribeDomainCascade, type DomainCascadeEvent } from '../utils/domainCascade';

const DEFAULT_LEVEL_ID = 'default_level';
const EMPTY_BLUEPRINT: LevelBlueprintData = { nodes: [], connections: [], variables: [] };

/** The World Editor's visible level data is one transaction-shaped value. */
interface LevelWorkingState {
    levels: LevelData[];
    currentLevelId: string | null;
    levelObjects: LevelObject[];
    activeLevelBlueprint: LevelBlueprintData;
}

const EMPTY_WORKING_STATE: LevelWorkingState = {
    levels: [],
    currentLevelId: null,
    levelObjects: [],
    activeLevelBlueprint: EMPTY_BLUEPRINT,
};

const applyDomainCascade = (objects: LevelObject[], event: DomainCascadeEvent): LevelObject[] => {
    if (event.kind === 'model') {
        return objects.filter((object) => object.modelId !== event.id);
    }
    return objects.map((object) => {
        if (event.kind === 'texture' && object.terrainData?.textureId === event.id) {
            const { textureId: _removed, ...terrainData } = object.terrainData;
            return { ...object, terrainData };
        }
        if (event.kind === 'audio' && object.audioConfig?.audioId === event.id) {
            const { audioConfig: _removed, ...withoutAudioReference } = object;
            return withoutAudioReference;
        }
        return object;
    });
};

const syncStateToDB = async (currentState: LevelObject[], nextState: LevelObject[], lease?: EditorSessionLease) => {
    if (lease && !editorSession.isCurrent(lease)) return false;
    let activeLease = lease;
    const currentMap = new Map(currentState.map(o => [o.id, o]));
    const nextMap = new Map(nextState.map(o => [o.id, o]));

    const toDelete: string[] = [];
    const toAdd: LevelObject[] = [];
    const toUpdate: LevelObject[] = [];

    for (const item of currentState) {
        if (!nextMap.has(item.id)) toDelete.push(item.id);
    }

    for (const item of nextState) {
        if (!currentMap.has(item.id)) {
            toAdd.push(item);
        } else {
            const oldItem = currentMap.get(item.id)!;
            // Enhanced diff check to include terrain and sky data
            if (
                oldItem.position[0] !== item.position[0] || 
                oldItem.position[2] !== item.position[2] ||
                oldItem.rotation[1] !== item.rotation[1] ||
                oldItem.scale[0] !== item.scale[0] ||
                (item.type === 'terrain' && JSON.stringify(oldItem.terrainData) !== JSON.stringify(item.terrainData)) ||
                (item.type === 'sky_sphere' && JSON.stringify(oldItem.skyConfig) !== JSON.stringify(item.skyConfig))
            ) {
                toUpdate.push(item);
            }
        }
    }

    for (const id of toDelete) {
        if (activeLease && !editorSession.isCurrent(activeLease)) return false;
        await dbOperations.deleteLevelObject(id, activeLease);
        if (lease && !editorSession.isSameSession(lease)) return false;
        activeLease = editorSession.captureReady() || undefined;
    }
    for (const object of toAdd) {
        if (activeLease && !editorSession.isCurrent(activeLease)) return false;
        await dbOperations.addLevelObject(object, activeLease);
        if (lease && !editorSession.isSameSession(lease)) return false;
        activeLease = editorSession.captureReady() || undefined;
    }
    for (const object of toUpdate) {
        if (activeLease && !editorSession.isCurrent(activeLease)) return false;
        await dbOperations.updateLevelObject(object.id, object, activeLease);
        if (lease && !editorSession.isSameSession(lease)) return false;
        activeLease = editorSession.captureReady() || undefined;
    }
    return true;
};

export const useLevelManager = (models: LoadedModelData[]) => {
  const session = editorSession;
  const sessionSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [workingState, setWorkingState] = useState<LevelWorkingState>(EMPTY_WORKING_STATE);
  const { levels, currentLevelId, levelObjects, activeLevelBlueprint } = workingState;
  const currentLevelIdRef = useRef<string | null>(null);
  const getCurrentLevelId = useCallback(() => currentLevelIdRef.current, []);

  const replaceWorkingState = useCallback((next: LevelWorkingState) => {
      currentLevelIdRef.current = next.currentLevelId;
      setWorkingState(next);
  }, []);

  const { addNotification } = useNotification();

  // History State
  const history = useRef<{ past: LevelObject[][], future: LevelObject[][] }>({ past: [], future: [] });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryState = () => {
      setCanUndo(history.current.past.length > 0);
      setCanRedo(history.current.future.length > 0);
  };

  const snapshotHistory = useCallback(() => {
      session.requireCurrent(session.captureReady());
      const snapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.past.push(snapshot);
      if (history.current.past.length > 50) history.current.past.shift();
      history.current.future = []; 
      updateHistoryState();
  }, [levelObjects, session]);

  const undo = useCallback(async () => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      if (history.current.past.length === 0) return;
      const currentSnapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.future.push(currentSnapshot);
      const previousState = history.current.past.pop();
      if (previousState) {
          if (!await syncStateToDB(levelObjects, previousState, lease) || !session.isSameSession(lease)) return;
          setWorkingState(prev => ({ ...prev, levelObjects: previousState }));
          addNotification({ message: "Undo", type: 'info', duration: 800 });
      }
      updateHistoryState();
  }, [levelObjects, addNotification, session]);

  const redo = useCallback(async () => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      if (history.current.future.length === 0) return;
      const currentSnapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.past.push(currentSnapshot);
      const nextState = history.current.future.pop();
      if (nextState) {
          if (!await syncStateToDB(levelObjects, nextState, lease) || !session.isSameSession(lease)) return;
          setWorkingState(prev => ({ ...prev, levelObjects: nextState }));
          addNotification({ message: "Redo", type: 'info', duration: 800 });
      }
      updateHistoryState();
  }, [levelObjects, addNotification, session]);

  useEffect(() => {
      history.current = { past: [], future: [] };
      updateHistoryState();
  }, [currentLevelId]);

  const pendingUpdatesRef = useRef<Map<string, { updates: Partial<LevelObject>; lease: EditorSessionLease; previous: LevelObject }>>(new Map());
  const invalidatedIdsRef = useRef<Set<string>>(new Set());
  const saveTimeoutRef = useRef<any>(null);

  useEffect(() => subscribeDomainCascade((event) => {
      const status = projectService.getStatus();
      if (session.getSnapshot().phase !== 'ready' || status.projectId !== event.projectId) return;
      const currentObjects = workingState.levelObjects;
      const affectedIds = new Set(currentObjects
          .filter((object) => event.kind === 'model'
              ? object.modelId === event.id
              : event.kind === 'texture'
                  ? object.terrainData?.textureId === event.id
                  : object.audioConfig?.audioId === event.id)
          .map((object) => object.id));
      if (affectedIds.size === 0) return;
      for (const id of affectedIds) {
          invalidatedIdsRef.current.add(id);
          pendingUpdatesRef.current.delete(id);
      }
      if (pendingUpdatesRef.current.size === 0 && saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
      }
      setWorkingState((current) => {
          const nextObjects = applyDomainCascade(current.levelObjects, event);
          return nextObjects.length === current.levelObjects.length
              && nextObjects.every((object, index) => object === current.levelObjects[index])
              ? current
              : { ...current, levelObjects: nextObjects };
      });
  }), [session, workingState.levelObjects]);

  const commitUpdates = useCallback(async () => {
      if (pendingUpdatesRef.current.size === 0) return;
      const batch = new Map<string, { updates: Partial<LevelObject>; lease: EditorSessionLease; previous: LevelObject }>(pendingUpdatesRef.current);
      pendingUpdatesRef.current.clear();
      for (const [id, pending] of batch.entries()) {
          if (invalidatedIdsRef.current.has(id)) {
              invalidatedIdsRef.current.delete(id);
              continue;
          }
          if (!session.isCurrent(pending.lease)) continue;
          try {
              await dbOperations.updateLevelObject(id, pending.updates, pending.lease);
              if (!session.isSameSession(pending.lease)) continue;
          } catch (error) {
              if (!pendingUpdatesRef.current.has(id)) {
                  setWorkingState(current => current.levelObjects.some((object) => object.id === id && object === pending.previous)
                      ? current
                      : { ...current, levelObjects: current.levelObjects.map((object) => object.id === id ? pending.previous : object) });
              }
              frontendDiagnostics.failure('level_batch_persist_failed', error);
          }
      }
  }, [session]);

  useEffect(() => session.subscribe(() => {
      if (session.getSnapshot().phase === 'transitioning') {
          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
          pendingUpdatesRef.current.clear();
      }
  }), [session]);

  useEffect(() => {
    return () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }
        pendingUpdatesRef.current.clear();
    };
  }, []);

  const initLevels = useCallback(async (signal?: AbortSignal) => {
      const initialSession = session.getSnapshot();
      if (projectService.getStatus().projectId || initialSession.phase !== 'closed') return;
      const isCurrentLegacySession = () => !signal?.aborted
          && !projectService.getStatus().projectId
          && session.getSnapshot().phase === 'closed'
          && session.getSnapshot().generation === initialSession.generation;
      try {
          const storedLevels = await dbOperations.getAllLevels();
          if (!isCurrentLegacySession()) return;
          if (storedLevels.length === 0) {
              const defaultLevel: LevelData = {
                  id: DEFAULT_LEVEL_ID,
                  name: 'Main Level',
                  createdAt: Date.now(),
                  blueprint: { nodes: [], connections: [], variables: [] }
              };
              await dbOperations.addLevel(defaultLevel);
              if (!isCurrentLegacySession()) return;
              replaceWorkingState({
                  levels: [defaultLevel],
                  currentLevelId: defaultLevel.id,
                  levelObjects: [],
                  activeLevelBlueprint: defaultLevel.blueprint || EMPTY_BLUEPRINT,
              });
          } else {
              if (!currentLevelId) {
                  const firstLevel = storedLevels[0];
                  replaceWorkingState({
                      levels: storedLevels,
                      currentLevelId: firstLevel.id,
                      levelObjects: [],
                      activeLevelBlueprint: firstLevel.blueprint || EMPTY_BLUEPRINT,
                  });
              }
          }
      } catch (e) {
          if (isCurrentLegacySession()) frontendDiagnostics.failure('level_initialize_failed', e);
      }
  }, [currentLevelId, replaceWorkingState, session]);

  useEffect(() => {
      if (!currentLevelId || sessionSnapshot.phase !== 'closed') return;
      if (!projectService.getStatus().projectId) {
      const controller = new AbortController();
      const generation = sessionSnapshot.generation;
      void dbOperations.getLevelObjects(currentLevelId).then(objects => {
          const currentSession = session.getSnapshot();
          if (controller.signal.aborted
              || projectService.getStatus().projectId
              || currentSession.phase !== 'closed'
              || currentSession.generation !== generation
              || currentLevelIdRef.current !== currentLevelId) return;
          setWorkingState(prev => prev.currentLevelId === currentLevelId
              ? { ...prev, levelObjects: selectObjectsForLevel(objects, currentLevelId) }
              : prev);
      }).catch((error) => {
          if (!controller.signal.aborted) frontendDiagnostics.failure('level_initialize_persist_failed', error);
      });
      return () => controller.abort();
      }
  }, [currentLevelId, session, sessionSnapshot.generation, sessionSnapshot.phase]);

  const createLevel = useCallback(async (name: string) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      const newLevel: LevelData = {
          id: crypto.randomUUID(),
          name: name || 'New Level',
          createdAt: Date.now(),
          blueprint: { nodes: [], connections: [], variables: [] }
      };
      
      try {
          await dbOperations.addLevel(newLevel, lease);
          session.requireSameSession(lease);
          setWorkingState(prev => ({ ...prev, levels: [...prev.levels, newLevel] }));
          addNotification({ message: `Level "${name}" created.`, type: 'success' });
      } catch (e) {
          frontendDiagnostics.failure('level_create_failed', e);
          addNotification({ message: "Failed to create level.", type: 'error' });
      }
  }, [addNotification, session]);

  const loadLevel = useCallback(async (id: string) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      if (id === currentLevelIdRef.current) return;
      if (!levels.some((level) => level.id === id)) throw new Error('Cannot load an unknown level.');
      const authoritative = projectService.getStatus();
      if (!authoritative.projectId) throw new Error('Cannot load a level without an open native project.');
      session.requireWritable(lease, authoritative);
      const transition = session.beginTransition();
      if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
          pendingUpdatesRef.current.clear();
      }
      try {
          // Native project data is authoritative for an open project. Capture
          // its identity before the asynchronous read and prove it again
          // before publishing anything from the replacement level.
          const allObjects = await dbOperations.getAllNativeLevelObjects();
          if (!session.isTransitionCurrent(transition)) return;
          const afterRead = projectService.getStatus();
          if (afterRead.projectId !== authoritative.projectId
              || afterRead.revision !== authoritative.revision) {
              throw new Error('Level transition was superseded by a project revision change.');
          }
          if (!session.isTransitionCurrent(transition)) return;
          const targetLevel = levels.find((level) => level.id === id);
          if (!targetLevel) throw new Error('Cannot load an unknown level.');
          const targetObjects = selectObjectsForLevel(allObjects, id);
          const nextState: LevelWorkingState = {
              levels,
              currentLevelId: id,
              levelObjects: targetObjects,
              activeLevelBlueprint: targetLevel.blueprint || EMPTY_BLUEPRINT,
          };
          // One React update publishes the ID, complete object set, and
          // blueprint together. The session is only made ready afterwards.
          replaceWorkingState(nextState);
          if (!session.complete(transition, authoritative.projectId, id, authoritative.revision)) {
              throw new Error('Level transition was superseded.');
          }
          addNotification({ message: "Level loaded.", type: 'info' });
      } catch (error) {
          session.fail(transition);
          throw error;
      }
  }, [levels, addNotification, replaceWorkingState, session]);

  const deleteLevel = useCallback(async (id: string) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      try {
          await dbOperations.deleteLevel(id, lease);
          session.requireSameSession(lease);
          setWorkingState(prev => ({ ...prev, levels: prev.levels.filter(l => l.id !== id) }));
          if (id === currentLevelId) {
              const remaining = levels.filter(l => l.id !== id);
              if (remaining.length > 0) {
                  void loadLevel(remaining[0].id);
              } else {
                  initLevels(); 
              }
          }
          addNotification({ message: "Level deleted.", type: 'info' });
      } catch (e) {
          frontendDiagnostics.failure('level_delete_failed', e);
          addNotification({ message: "Failed to delete level.", type: 'error' });
      }
  }, [currentLevelId, levels, loadLevel, initLevels, addNotification, session]);

  const addLevelObject = useCallback(async (
      modelId: string, 
      position: [number, number, number], 
      rotation: [number, number, number], 
      scale: [number, number, number],
      type: LevelObjectType = 'prop',
      extraData?: any
  ): Promise<string | undefined> => {
    const lease = session.captureReady();
    session.requireCurrent(lease);
    const activeLevelId = currentLevelIdRef.current;
    if (!activeLevelId || lease.levelId !== activeLevelId) return undefined;
    snapshotHistory();
    
    // Validate model if type is prop/foliage
    if ((type === 'prop' || type === 'foliage') && !modelId) return undefined;
    
    const model = models.find(m => m.id === modelId);
    // Spawners/Terrain/Audio/Sky don't need a model
    if ((type === 'prop' || type === 'foliage') && !model) return undefined;

    const newObj: LevelObject = {
        id: crypto.randomUUID(),
        levelId: activeLevelId,
        modelId,
        name: type === 'spawn_point' ? 'Enemy Spawner' : 
              type === 'audio_emitter' ? 'Audio Emitter' :
              type === 'sky_sphere' ? 'Sky Atmosphere' :
              type === 'terrain' ? `Terrain_${Math.floor(Math.random()*100)}` :
              (type === 'foliage' ? `${model?.name}_Foliage` : `${model?.name}_Prop`),
        position,
        rotation,
        scale,
        type,
        // Configs
        spawnConfig: type === 'spawn_point' ? { blueprintId: '', interval: 5, maxSpawns: 0, team: 'Enemy' } : undefined,
        terrainData: type === 'terrain' ? extraData : undefined,
        skyConfig: type === 'sky_sphere' ? extraData : undefined // Crucial fix: Assign sky config
    };

    projectService.assertWritable();
    try {
        await dbOperations.addLevelObject(newObj, lease);
        if (!session.isSameSession(lease)) return undefined;
          setWorkingState(prev => ({ ...prev, levelObjects: [...prev.levelObjects, newObj] }));
        return newObj.id;
    } catch(e) { 
        frontendDiagnostics.failure('level_object_add_failed', e);
        return undefined;
    }
  }, [models, currentLevelId, snapshotHistory, session]);

  const removeLevelObject = useCallback(async (id: string) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      snapshotHistory();
      try {
          await dbOperations.deleteLevelObject(id, lease);
          if (!session.isSameSession(lease)) return;
          setWorkingState(prev => ({ ...prev, levelObjects: prev.levelObjects.filter(o => o.id !== id) }));
      } catch(e) { frontendDiagnostics.failure('level_object_delete_failed', e); }
  }, [snapshotHistory, session]);

  const removeLevelObjects = useCallback(async (ids: string[]) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      if (ids.length === 0) return;
      snapshotHistory();
      try {
          let activeLease: EditorSessionLease = lease;
          for (const id of ids) {
              session.requireCurrent(activeLease);
              await dbOperations.deleteLevelObject(id, activeLease);
              if (!session.isSameSession(lease)) return;
              activeLease = session.captureReady()!;
          }
          if (!session.isSameSession(lease)) return;
          setWorkingState(prev => ({ ...prev, levelObjects: prev.levelObjects.filter(o => !ids.includes(o.id)) }));
      } catch(e) { frontendDiagnostics.failure('level_object_batch_delete_failed', e); }
  }, [snapshotHistory, session]);

  const updateLevelObject = useCallback((id: string, updates: Partial<LevelObject>) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      const previous = levelObjects.find((object) => object.id === id);
      if (!previous) return;
      setWorkingState(prev => ({
          ...prev,
          levelObjects: prev.levelObjects.map(o => o.id === id ? { ...o, ...updates } : o),
      }));
      const existing = pendingUpdatesRef.current.get(id);
      pendingUpdatesRef.current.set(id, {
          updates: { ...(existing?.updates || {}), ...updates },
          lease,
          previous: existing?.previous || previous,
      });
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
  }, [commitUpdates, levelObjects, session]);

  const updateLevelBlueprint = useCallback((data: Partial<LevelBlueprintData>) => {
      const lease = session.captureReady();
      session.requireCurrent(lease);
      projectService.assertWritable();
      const next = { ...activeLevelBlueprint, ...data };
      const previous = activeLevelBlueprint;
      setWorkingState(prev => ({
          ...prev,
          activeLevelBlueprint: next,
          levels: prev.levels.map(level => level.id === currentLevelId
              ? { ...level, blueprint: next }
              : level),
      }));
      if (currentLevelId) {
          const lvl = levels.find(l => l.id === currentLevelId);
          if (lvl) {
              dbOperations.addLevel({ ...lvl, blueprint: next }, lease).catch((error) => {
                  setWorkingState(current => current.activeLevelBlueprint === next
                      ? {
                          ...current,
                          activeLevelBlueprint: previous,
                          levels: current.levels.map(level => level.id === currentLevelId
                              ? { ...level, blueprint: previous }
                              : level),
                      }
                      : current);
                  frontendDiagnostics.failure('level_blueprint_persist_failed', error);
              });
          }
      }
  }, [activeLevelBlueprint, currentLevelId, levels, session]);

  const hydrateProjectState = useCallback((nextLevels: LevelData[], nextObjects: LevelObject[], nextCurrentLevelId?: string | null) => {
      const selected = nextCurrentLevelId || nextLevels[0]?.id || null;
      const level = nextLevels.find((item) => item.id === selected);
      replaceWorkingState({
          levels: nextLevels,
          currentLevelId: selected,
          levelObjects: selected ? selectObjectsForLevel(nextObjects, selected) : [],
          activeLevelBlueprint: level?.blueprint || EMPTY_BLUEPRINT,
      });
      history.current = { past: [], future: [] };
      updateHistoryState();
  }, [replaceWorkingState]);

  useEffect(() => {
      const controller = new AbortController();
      void initLevels(controller.signal);
      return () => controller.abort();
  }, [initLevels]);

  return frontendDiagnostics.traceActions('level_manager', {
      levels,
      currentLevelId,
      createLevel,
      loadLevel,
      deleteLevel,
      levelObjects,
      addLevelObject,
      removeLevelObject,
      removeLevelObjects,
      updateLevelObject,
      activeLevelBlueprint,
      updateLevelBlueprint,
      hydrateProjectState,
      undo,
      redo,
      canUndo,
      canRedo,
      snapshotHistory,
      getCurrentLevelId,
  });
};
