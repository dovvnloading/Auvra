import { useCallback, useEffect, useRef, useState } from 'react';
import type { LevelObject, PrefabData } from '../types';
import { useScene } from '../context/SceneContext';
import { useNotification } from '../context/NotificationContext';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { editorSession } from '../utils/editorSession';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { createPrefabFromSubtree, findNonPrefabObject, instantiatePrefab, pickPrefabRoot } from '../utils/prefabs';
import { findInstanceRoot, instanceMembers, instanceRoots, prefabFromInstance, syncInstance, type InstanceSync } from '../utils/prefabSync';
import { collectSubtree, sortByHierarchy } from '../utils/sceneGraph';

const describeError = (error: unknown): string => error instanceof Error && error.message ? error.message : 'unknown error';

/** Fields the level add API cannot take; written once the new object is in level state. */
const instanceFields = (object: LevelObject, parentId: string | null): Partial<LevelObject> => {
  const fields: Partial<LevelObject> = { name: object.name, parentId };
  if (object.prefabId) fields.prefabId = object.prefabId;
  if (object.prefabObjectId) fields.prefabObjectId = object.prefabObjectId;
  if (object.components?.length) fields.components = object.components;
  if (object.spawnConfig) fields.spawnConfig = object.spawnConfig;
  if (object.audioConfig) fields.audioConfig = object.audioConfig;
  return fields;
};

/** Merges the edits of several instance syncs; removals children first, additions parents first. */
const mergeSyncs = (objects: readonly LevelObject[], syncs: InstanceSync[]): InstanceSync => {
  const removals: string[] = [];
  const seen = new Set<string>();
  for (const sync of syncs) {
    for (const id of sync.removals) {
      // A removed member takes whatever sits under it (including objects added by hand).
      for (const object of collectSubtree(objects, id).reverse()) {
        if (!seen.has(object.id)) { seen.add(object.id); removals.push(object.id); }
      }
    }
  }
  return {
    updates: syncs.flatMap(sync => sync.updates),
    additions: sortByHierarchy(syncs.flatMap(sync => sync.additions)),
    removals,
  };
};

const instanceCount = (count: number): string => (count ? `; ${count} other instance${count === 1 ? '' : 's'} updated` : '');

/**
 * Project prefabs: list, create from the World Editor selection, delete, place
 * linked instances into the current level, and keep every instance in step with
 * its prefab (apply an instance's changes to the prefab, revert, unlink).
 */
export const usePrefabs = () => {
  const { models, levelObjects, currentLevelId, addLevelObject, addLevelObjects, updateLevelObject, removeLevelObjects, snapshotHistory } = useScene();
  const { addNotification } = useNotification();
  const [prefabs, setPrefabs] = useState<PrefabData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlacing, setIsPlacing] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(projectService.getStatus().projectId);
  const loadToken = useRef(0);
  const placingRef = useRef(false);
  // New object id -> parent link, name, components, ... still to write.
  const pendingFields = useRef(new Map<string, Partial<LevelObject>>());
  const [pendingVersion, setPendingVersion] = useState(0);

  useEffect(() => projectService.subscribe((status) => setProjectId(status.projectId)), []);

  const refresh = useCallback(async () => {
    const token = ++loadToken.current;
    setIsLoading(true);
    try {
      const loaded = await dbOperations.getAllPrefabs();
      if (token !== loadToken.current) return;
      setPrefabs([...loaded].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      if (token !== loadToken.current) return;
      setPrefabs([]);
      frontendDiagnostics.failure('prefab_list_failed', error);
    } finally {
      if (token === loadToken.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    pendingFields.current.clear();
    void refresh();
  }, [projectId, refresh]);

  // addLevelObject generates ids and only takes a transform, so the parent
  // link (and name, components, prefab id) is applied once each placed object
  // is in level state, where updateLevelObject can see it.
  useEffect(() => {
    const pending = pendingFields.current;
    if (pending.size === 0) return;
    for (const object of levelObjects) {
      const fields = pending.get(object.id);
      if (!fields) continue;
      pending.delete(object.id);
      try {
        updateLevelObject(object.id, fields);
      } catch (error) {
        frontendDiagnostics.failure('prefab_instance_link_failed', error);
      }
    }
  }, [levelObjects, pendingVersion, updateLevelObject]);

  const createFromSelection = useCallback(async (
    selectedIds: string[],
    primaryId?: string | null,
    name?: string,
  ): Promise<PrefabData | null> => {
    const { rootId, omitted } = pickPrefabRoot(levelObjects, selectedIds, primaryId);
    if (!rootId) {
      addNotification({ message: 'Select an object to make a prefab from.', type: 'info' });
      return null;
    }
    const blocked = findNonPrefabObject(levelObjects, rootId);
    if (blocked) {
      addNotification({ message: `"${blocked.name}" cannot be part of a prefab (terrain, sky and player start are level objects).`, type: 'error' });
      return null;
    }
    const root = levelObjects.find((object) => object.id === rootId)!;
    const prefab = createPrefabFromSubtree(levelObjects, rootId, name ?? root.name);
    try {
      await dbOperations.upsertPrefab(prefab);
      // The selection becomes the prefab's first instance: its prefab object ids are its own ids.
      snapshotHistory();
      for (const object of prefab.objects) updateLevelObject(object.id, { prefabId: prefab.id, prefabObjectId: object.id });
      setPrefabs((previous) => [...previous.filter((item) => item.id !== prefab.id), prefab]
        .sort((a, b) => a.name.localeCompare(b.name)));
      addNotification({
        message: omitted > 0
          ? `Prefab "${prefab.name}" created from "${root.name}"; ${omitted} other selected object(s) were left out (parent them under it to include them).`
          : `Prefab "${prefab.name}" created (${prefab.objects.length} object${prefab.objects.length === 1 ? '' : 's'}).`,
        type: 'success',
      });
      return prefab;
    } catch (error) {
      frontendDiagnostics.failure('prefab_create_failed', error);
      addNotification({ message: `Could not save prefab: ${describeError(error)}`, type: 'error' });
      return null;
    }
  }, [addNotification, levelObjects, snapshotHistory, updateLevelObject]);

  /** Applies merged instance edits to the current level: additions, then updates, then removals. */
  const applyToLevel = useCallback(async (sync: InstanceSync) => {
    if (sync.additions.length) await addLevelObjects(sync.additions);
    for (const { id, changes } of sync.updates) updateLevelObject(id, changes);
    if (sync.removals.length) await removeLevelObjects(sync.removals);
  }, [addLevelObjects, removeLevelObjects, updateLevelObject]);

  /** The edits for instances of `next` stored in other levels, as full documents and removals. */
  const planOtherLevels = useCallback(async (previous: PrefabData, next: PrefabData) => {
    const others = (await dbOperations.getAllNativeLevelObjects()).filter((object) => object.levelId !== currentLevelId);
    const roots = instanceRoots(others, next);
    const merged = mergeSyncs(others, roots.map((root) => syncInstance(others, root, previous, next)));
    const byId = new Map(others.map((object) => [object.id, object]));
    const upserts = new Map<string, LevelObject>();
    for (const { id, changes } of merged.updates) {
      const base = upserts.get(id) ?? byId.get(id);
      if (base) upserts.set(id, { ...base, ...changes });
    }
    for (const addition of merged.additions) upserts.set(addition.id, addition);
    const removed = new Set(merged.removals);
    return {
      upserts: sortByHierarchy([...upserts.values()].filter((object) => !removed.has(object.id))),
      removals: merged.removals,
      instances: roots.length,
    };
  }, [currentLevelId]);

  /** The prefab and instance root of a selected instance object, or null with a notice. */
  const resolveInstance = useCallback((objectId: string) => {
    const object = levelObjects.find((item) => item.id === objectId);
    const prefab = object?.prefabId ? prefabs.find((item) => item.id === object.prefabId) : undefined;
    const root = object && prefab ? findInstanceRoot(levelObjects, object, prefab) : null;
    if (!prefab || !root) {
      addNotification({ message: 'This object is not part of a prefab instance.', type: 'info' });
      return null;
    }
    return { prefab, root };
  }, [addNotification, levelObjects, prefabs]);

  /**
   * Saves the instance holding `objectId` as the new version of its prefab, then brings every other
   * instance, in this level and in all others, up to date. Their overrides are kept.
   */
  const applyInstanceToPrefab = useCallback(async (objectId: string): Promise<boolean> => {
    const resolved = resolveInstance(objectId);
    if (!resolved) return false;
    const { prefab: previous, root } = resolved;
    const { prefab: next, adopted } = prefabFromInstance(levelObjects, root, previous);
    try {
      const others = await planOtherLevels(previous, next);
      await dbOperations.updatePrefabAndInstances(next, others.upserts, others.removals, editorSession.captureReady() ?? undefined);
      setPrefabs((list) => list.map((item) => (item.id === next.id ? next : item)));
      snapshotHistory();
      for (const [id, prefabObjectId] of adopted) updateLevelObject(id, { prefabId: next.id, prefabObjectId });
      const here = instanceRoots(levelObjects, next).filter((other) => other.id !== root.id);
      await applyToLevel(mergeSyncs(levelObjects, here.map((other) => syncInstance(levelObjects, other, previous, next))));
      addNotification({ message: `Prefab "${next.name}" updated${instanceCount(here.length + others.instances)}.`, type: 'success' });
      return true;
    } catch (error) {
      frontendDiagnostics.failure('prefab_apply_failed', error);
      addNotification({ message: `Could not update the prefab: ${describeError(error)}`, type: 'error' });
      return false;
    }
  }, [addNotification, applyToLevel, levelObjects, planOtherLevels, resolveInstance, snapshotHistory, updateLevelObject]);

  /** Puts the instance holding `objectId` back to its prefab, dropping its overrides (the root keeps its placement). */
  const revertInstance = useCallback(async (objectId: string): Promise<boolean> => {
    const resolved = resolveInstance(objectId);
    if (!resolved) return false;
    try {
      snapshotHistory();
      await applyToLevel(mergeSyncs(levelObjects, [syncInstance(levelObjects, resolved.root, null, resolved.prefab, { revert: true })]));
      return true;
    } catch (error) {
      frontendDiagnostics.failure('prefab_revert_failed', error);
      addNotification({ message: `Could not revert the instance: ${describeError(error)}`, type: 'error' });
      return false;
    }
  }, [addNotification, applyToLevel, levelObjects, resolveInstance, snapshotHistory]);

  /** Turns the instance holding `objectId` into plain objects that prefab changes no longer reach. */
  const unlinkInstance = useCallback((objectId: string): boolean => {
    const resolved = resolveInstance(objectId);
    if (!resolved) return false;
    snapshotHistory();
    for (const member of instanceMembers(levelObjects, resolved.root)) {
      updateLevelObject(member.id, { prefabId: undefined, prefabObjectId: undefined });
    }
    return true;
  }, [levelObjects, resolveInstance, snapshotHistory, updateLevelObject]);

  const deletePrefab = useCallback(async (id: string): Promise<boolean> => {
    try {
      await dbOperations.deletePrefab(id);
    } catch (error) {
      frontendDiagnostics.failure('prefab_delete_failed', error);
      addNotification({ message: `Could not delete prefab: ${describeError(error)}`, type: 'error' });
      return false;
    }
    setPrefabs((previous) => previous.filter((item) => item.id !== id));
    // The host cleared prefabId on stored instances; mirror that in the
    // current level so a later full write does not restore a dangling id.
    for (const object of levelObjects) {
      if (object.prefabId !== id) continue;
      try {
        updateLevelObject(object.id, { prefabId: undefined, prefabObjectId: undefined });
      } catch (error) {
        frontendDiagnostics.failure('prefab_instance_unlink_failed', error);
      }
    }
    for (const fields of pendingFields.current.values()) {
      if (fields.prefabId === id) {
        delete fields.prefabId;
        delete fields.prefabObjectId;
      }
    }
    return true;
  }, [addNotification, levelObjects, updateLevelObject]);

  /** Place a copy of `prefabId` in the current level; resolves to the new root's id. */
  const placePrefab = useCallback(async (prefabId: string, position: [number, number, number] = [0, 0, 0]): Promise<string | null> => {
    const prefab = prefabs.find((item) => item.id === prefabId);
    if (!prefab || placingRef.current) return null;
    if (!currentLevelId || !editorSession.captureReady()) {
      addNotification({ message: 'Open a level before placing a prefab.', type: 'info' });
      return null;
    }
    const objects = instantiatePrefab(prefab, currentLevelId, position);
    const missing = objects.filter((object) => (object.type === 'prop' || object.type === 'foliage')
      && !models.some((model) => model.id === object.modelId));
    if (missing.length > 0) {
      addNotification({ message: `Prefab "${prefab.name}" uses ${missing.length} object(s) whose model is no longer in the project.`, type: 'error' });
      return null;
    }

    placingRef.current = true;
    setIsPlacing(true);
    // Instance id (from instantiatePrefab) -> id the level add API assigned.
    const placed = new Map<string, string>();
    try {
      // Parents come first, so every parent id is already mapped.
      for (const object of objects) {
        const levelId = await addLevelObject(object.modelId, object.position, object.rotation, object.scale, object.type);
        if (!levelId) throw new Error(`"${object.name}" could not be added to the level`);
        placed.set(object.id, levelId);
        pendingFields.current.set(levelId, instanceFields(object, object.parentId ? placed.get(object.parentId) ?? null : null));
      }
      setPendingVersion((version) => version + 1);
      return placed.get(objects[0].id) ?? null;
    } catch (error) {
      const added = [...placed.values()];
      for (const id of added) pendingFields.current.delete(id);
      if (added.length > 0) {
        try {
          removeLevelObjects(added);
        } catch (cleanupError) {
          frontendDiagnostics.failure('prefab_place_cleanup_failed', cleanupError);
        }
      }
      frontendDiagnostics.failure('prefab_place_failed', error);
      addNotification({ message: `Could not place prefab: ${describeError(error)}`, type: 'error' });
      return null;
    } finally {
      placingRef.current = false;
      setIsPlacing(false);
    }
  }, [addLevelObject, addNotification, currentLevelId, models, prefabs, removeLevelObjects]);

  return {
    prefabs,
    isLoading,
    isPlacing,
    refresh,
    createFromSelection,
    deletePrefab,
    placePrefab,
    applyInstanceToPrefab,
    revertInstance,
    unlinkInstance,
  };
};
