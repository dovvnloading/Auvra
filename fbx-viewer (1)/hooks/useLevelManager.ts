
import { useState, useCallback, useRef, useEffect } from 'react';
import { LevelObject, LoadedModelData, LevelObjectType, LevelData, LevelBlueprintData, TerrainData } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';

const DEFAULT_LEVEL_ID = 'default_level';

const syncStateToDB = async (currentState: LevelObject[], nextState: LevelObject[]) => {
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

    for (const id of toDelete) await dbOperations.deleteLevelObject(id);
    for (const object of toAdd) await dbOperations.addLevelObject(object);
    for (const object of toUpdate) await dbOperations.updateLevelObject(object.id, object);
};

export const useLevelManager = (models: LoadedModelData[]) => {
  const [levelObjects, setLevelObjects] = useState<LevelObject[]>([]);
  const [levels, setLevels] = useState<LevelData[]>([]);
  const [currentLevelId, setCurrentLevelId] = useState<string | null>(null);
  
  const [activeLevelBlueprint, setActiveLevelBlueprint] = useState<LevelBlueprintData>({
      nodes: [],
      connections: [],
      variables: []
  });

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
      const snapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.past.push(snapshot);
      if (history.current.past.length > 50) history.current.past.shift();
      history.current.future = []; 
      updateHistoryState();
  }, [levelObjects]);

  const undo = useCallback(async () => {
      if (history.current.past.length === 0) return;
      const currentSnapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.future.push(currentSnapshot);
      const previousState = history.current.past.pop();
      if (previousState) {
          await syncStateToDB(levelObjects, previousState);
          setLevelObjects(previousState);
          addNotification({ message: "Undo", type: 'info', duration: 800 });
      }
      updateHistoryState();
  }, [levelObjects, addNotification]);

  const redo = useCallback(async () => {
      if (history.current.future.length === 0) return;
      const currentSnapshot = JSON.parse(JSON.stringify(levelObjects));
      history.current.past.push(currentSnapshot);
      const nextState = history.current.future.pop();
      if (nextState) {
          await syncStateToDB(levelObjects, nextState);
          setLevelObjects(nextState);
          addNotification({ message: "Redo", type: 'info', duration: 800 });
      }
      updateHistoryState();
  }, [levelObjects, addNotification]);

  useEffect(() => {
      history.current = { past: [], future: [] };
      updateHistoryState();
  }, [currentLevelId]);

  const pendingUpdatesRef = useRef<Map<string, any>>(new Map());
  const saveTimeoutRef = useRef<any>(null);

  const commitUpdates = useCallback(async () => {
      if (pendingUpdatesRef.current.size === 0) return;
      const batch = new Map<string, any>(pendingUpdatesRef.current);
      pendingUpdatesRef.current.clear();
      try {
          for (const [id, updates] of batch.entries()) await dbOperations.updateLevelObject(id, updates);
      } catch (e) {
          console.error("Error saving batched level updates", e);
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

  const initLevels = useCallback(async () => {
      if (projectService.getStatus().projectId) return;
      try {
          const storedLevels = await dbOperations.getAllLevels();
          if (storedLevels.length === 0) {
              const defaultLevel: LevelData = {
                  id: DEFAULT_LEVEL_ID,
                  name: 'Main Level',
                  createdAt: Date.now(),
                  blueprint: { nodes: [], connections: [], variables: [] }
              };
              await dbOperations.addLevel(defaultLevel);
              setLevels([defaultLevel]);
              setCurrentLevelId(defaultLevel.id);
              setActiveLevelBlueprint(defaultLevel.blueprint!);
          } else {
              setLevels(storedLevels);
              if (!currentLevelId) {
                  setCurrentLevelId(storedLevels[0].id);
                  setActiveLevelBlueprint(storedLevels[0].blueprint || { nodes: [], connections: [], variables: [] });
              }
          }
      } catch (e) {
          console.error("Failed to init levels", e);
      }
  }, [currentLevelId]);

  useEffect(() => {
      if (currentLevelId) {
          if (!projectService.getStatus().projectId) {
              dbOperations.getLevelObjects(currentLevelId).then(objects => {
                  setLevelObjects(objects);
              }).catch(console.error);
          }
          
          const lvl = levels.find(l => l.id === currentLevelId);
          if (lvl) {
              setActiveLevelBlueprint(lvl.blueprint || { nodes: [], connections: [], variables: [] });
          }
      }
  }, [currentLevelId, levels]);

  const createLevel = useCallback(async (name: string) => {
      projectService.assertWritable();
      const newLevel: LevelData = {
          id: crypto.randomUUID(),
          name: name || 'New Level',
          createdAt: Date.now(),
          blueprint: { nodes: [], connections: [], variables: [] }
      };
      
      try {
          await dbOperations.addLevel(newLevel);
          setLevels(prev => [...prev, newLevel]);
          addNotification({ message: `Level "${name}" created.`, type: 'success' });
      } catch (e) {
          console.error("Failed to create level", e);
          addNotification({ message: "Failed to create level.", type: 'error' });
      }
  }, [addNotification]);

  const loadLevel = useCallback(async (id: string) => {
      if (id === currentLevelId) return;
      if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          await commitUpdates();
      }
      setCurrentLevelId(id);
      addNotification({ message: "Level loaded.", type: 'info' });
  }, [currentLevelId, commitUpdates, addNotification]);

  const deleteLevel = useCallback(async (id: string) => {
      projectService.assertWritable();
      try {
          await dbOperations.deleteLevel(id);
          setLevels(prev => prev.filter(l => l.id !== id));
          if (id === currentLevelId) {
              const remaining = levels.filter(l => l.id !== id);
              if (remaining.length > 0) {
                  loadLevel(remaining[0].id);
              } else {
                  initLevels(); 
              }
          }
          addNotification({ message: "Level deleted.", type: 'info' });
      } catch (e) {
          console.error("Failed to delete level", e);
          addNotification({ message: "Failed to delete level.", type: 'error' });
      }
  }, [currentLevelId, levels, loadLevel, initLevels, addNotification]);

  const addLevelObject = useCallback(async (
      modelId: string, 
      position: [number, number, number], 
      rotation: [number, number, number], 
      scale: [number, number, number],
      type: LevelObjectType = 'prop',
      extraData?: any
  ): Promise<string | undefined> => {
    if (!currentLevelId) return undefined;
    snapshotHistory();
    
    // Validate model if type is prop/foliage
    if ((type === 'prop' || type === 'foliage') && !modelId) return undefined;
    
    const model = models.find(m => m.id === modelId);
    // Spawners/Terrain/Audio/Sky don't need a model
    if ((type === 'prop' || type === 'foliage') && !model) return undefined;

    const newObj: LevelObject = {
        id: crypto.randomUUID(),
        levelId: currentLevelId,
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
    setLevelObjects(prev => [...prev, newObj]);
    
    try { 
        await dbOperations.addLevelObject(newObj); 
        return newObj.id;
    } catch(e) { 
        console.error(e); 
        return undefined;
    }
  }, [models, currentLevelId, snapshotHistory]);

  const removeLevelObject = useCallback(async (id: string) => {
      projectService.assertWritable();
      snapshotHistory();
      setLevelObjects(prev => prev.filter(o => o.id !== id));
      try { await dbOperations.deleteLevelObject(id); } catch(e) { console.error(e); }
  }, [snapshotHistory]);

  const removeLevelObjects = useCallback(async (ids: string[]) => {
      projectService.assertWritable();
      if (ids.length === 0) return;
      snapshotHistory();
      setLevelObjects(prev => prev.filter(o => !ids.includes(o.id)));
      try { for (const id of ids) await dbOperations.deleteLevelObject(id); } catch(e) { console.error("Batch delete failed", e); }
  }, [snapshotHistory]);

  const updateLevelObject = useCallback((id: string, updates: Partial<LevelObject>) => {
      projectService.assertWritable();
      setLevelObjects(prev => prev.map(o => o.id === id ? { ...o, ...updates } : o));
      const existing = pendingUpdatesRef.current.get(id) || {};
      pendingUpdatesRef.current.set(id, { ...existing, ...updates });
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(commitUpdates, 1500);
  }, [commitUpdates]);

  const updateLevelBlueprint = useCallback((data: Partial<LevelBlueprintData>) => {
      projectService.assertWritable();
      setActiveLevelBlueprint(prev => {
          const next = { ...prev, ...data };
          if (currentLevelId) {
              const lvl = levels.find(l => l.id === currentLevelId);
              if (lvl) {
                  dbOperations.addLevel({ ...lvl, blueprint: next }).catch(console.error);
              }
          }
          return next;
      });
  }, [currentLevelId, levels]);

  const hydrateProjectState = useCallback((nextLevels: LevelData[], nextObjects: LevelObject[], nextCurrentLevelId?: string | null) => {
      const selected = nextCurrentLevelId || nextLevels[0]?.id || null;
      setLevels(nextLevels);
      setCurrentLevelId(selected);
      setLevelObjects(nextObjects.filter((object) => !selected || object.levelId === selected));
      const level = nextLevels.find((item) => item.id === selected);
      setActiveLevelBlueprint(level?.blueprint || { nodes: [], connections: [], variables: [] });
      history.current = { past: [], future: [] };
      updateHistoryState();
  }, []);

  useEffect(() => {
      initLevels();
  }, []);

  return {
      levels,
      currentLevelId,
      createLevel,
      loadLevel,
      deleteLevel,
      levelObjects,
      setLevelObjects,
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
      snapshotHistory
  };
};
