
import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { LevelObject, LoadedModelData, LevelObjectType, LevelData, LevelBlueprintData, TerrainData, TerrainHeightfieldReference, TerrainSplatmapReference } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, selectObjectsForLevel, type EditorSessionLease } from '../utils/editorSession';
import { subscribeDomainCascade, type DomainCascadeEvent } from '../utils/domainCascade';
import { resolveTerrainHeightfield } from '../utils/terrainHeightfieldEditor';
import { isTerrainHeightfieldPending, TerrainHeightfieldEncodingError } from '../utils/terrainHeightfieldCodec';
import { resolveTerrainHolemap, resolveTerrainSplatmap } from '../components/Environment/Terrain/terrainSplatEditor';
import { foliageAfterTerrainEdit, isFoliageTypePending, resolveFoliageInstances, type FoliageGroundTerrain, type FoliageInstanceReference, type FoliageType } from '../runtime/foliage';
import { isEditLayerPending, resolveEditLayer } from '../components/Environment/Terrain/terrainEditLayers';
import { isTerrainHolesPending, isTerrainSplat2Pending, isTerrainSplatPending, terrainLayersReferenceTexture, withoutTerrainLayerModel, withoutTerrainLayerTexture } from '../components/Environment/Terrain/terrainSplatCodec';
import { collectSubtree, sortByHierarchy } from '../utils/sceneGraph';
import type { LevelBakedLighting } from '../runtime/lighting/bakedLighting';

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

/** A debounced partial edit of one level object, fenced to the session it was made in. */
interface PendingLevelEdit {
    updates: Partial<LevelObject>;
    lease: EditorSessionLease;
}

/** Ids of the objects matching `isRoot` and all of their descendants. */
const withDescendants = (objects: readonly LevelObject[], isRoot: (object: LevelObject) => boolean): Set<string> => {
    const ids = new Set<string>();
    // Parents come first, so a descendant always sees its removed ancestor.
    for (const object of sortByHierarchy(objects)) {
        if (isRoot(object) || (object.parentId && ids.has(object.parentId))) ids.add(object.id);
    }
    return ids;
};

/** Terrain fields that can hold millions of numbers. They are replaced whole, never changed in place, so history can share them. */
const SHARED_TERRAIN_FIELDS = ['heights', 'splat', 'splat2', 'holes'] as const;

/** A copy of the level's objects for the undo history, sharing the terrains' largest arrays. */
const snapshotLevelObjects = (objects: readonly LevelObject[]): LevelObject[] => objects.map((object) => {
    if (object.foliageData) {
        // A type's instances are replaced whole too.
        return {
            ...(JSON.parse(JSON.stringify({ ...object, foliageData: undefined })) as LevelObject),
            foliageData: {
                types: object.foliageData.types.map((type) => {
                    const { instances, ...rest } = type;
                    const copy = JSON.parse(JSON.stringify(rest)) as FoliageType;
                    return instances ? { ...copy, instances } : copy;
                }),
            },
        };
    }
    const terrain = object.terrainData;
    if (!terrain) return JSON.parse(JSON.stringify(object)) as LevelObject;
    const light: Record<string, unknown> = { ...terrain };
    for (const field of SHARED_TERRAIN_FIELDS) delete light[field];
    // Edit layers hold as many numbers again.
    delete light.editLayers;
    const copy = JSON.parse(JSON.stringify({ ...object, terrainData: light })) as LevelObject;
    if (terrain.editLayers) copy.terrainData!.editLayers = terrain.editLayers.map(layer => ({ ...layer }));
    for (const field of SHARED_TERRAIN_FIELDS) {
        const value = terrain[field];
        if (value) (copy.terrainData as unknown as Record<string, unknown>)[field] = value;
    }
    return copy;
});

const sameNumbers = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return false;
    }
    return true;
};

const sameFoliageObject = (a: LevelObject, b: LevelObject): boolean => {
    const left = a.foliageData?.types ?? [];
    const right = b.foliageData?.types ?? [];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index].instances !== right[index].instances) return false;
    }
    const replacer = (key: string, value: unknown) => (key === 'instances' ? undefined : value);
    return JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
};

/** Whether two versions of a terrain say the same, without writing its millions of numbers out as text. */
const sameTerrainObject = (a: LevelObject, b: LevelObject): boolean => {
    for (const field of SHARED_TERRAIN_FIELDS) {
        if (!a.terrainData || !b.terrainData) return false;
        if (!sameNumbers(a.terrainData[field], b.terrainData[field])) return false;
    }
    const leftLayers = a.terrainData?.editLayers ?? [];
    const rightLayers = b.terrainData?.editLayers ?? [];
    if (leftLayers.length !== rightLayers.length) return false;
    for (let index = 0; index < leftLayers.length; index++) {
        if (!sameNumbers(leftLayers[index].deltas, rightLayers[index].deltas)) return false;
    }
    const replacer = (key: string, value: unknown) => ((SHARED_TERRAIN_FIELDS as readonly string[]).includes(key) || key === 'deltas' ? undefined : value);
    return JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
};

/** The first of Terrain, Terrain 2, Terrain 3... no terrain in the level is called. */
const nextTerrainName = (objects: readonly LevelObject[]): string => {
    const taken = new Set(objects.filter((object) => object.type === 'terrain').map((object) => object.name));
    if (!taken.has('Terrain')) return 'Terrain';
    let number = 2;
    while (taken.has(`Terrain ${number}`)) number++;
    return `Terrain ${number}`;
};

/** A deleted model removes its objects together with their descendants, as the host does. */
const modelCascadeIds = (objects: readonly LevelObject[], modelId: string): Set<string> =>
    withDescendants(objects, (object) => object.modelId === modelId);

/** True when the terrain samples the texture, as its texture or in one of its paint layers. */
const terrainReferencesTexture = (terrain: TerrainData | undefined, textureId: string): boolean =>
    terrain?.textureId === textureId || terrainLayersReferenceTexture(terrain, textureId);

/** The terrain without a deleted texture; its layers keep their slots so the splat channels still line up. */
const withoutTerrainTexture = (terrain: TerrainData, textureId: string): TerrainData => {
    const { textureId: _removed, ...withoutTexture } = terrain;
    return withoutTerrainLayerTexture(terrain.textureId === textureId ? withoutTexture : terrain, textureId);
};

const applyDomainCascade = (objects: LevelObject[], event: DomainCascadeEvent): LevelObject[] => {
    if (event.kind === 'model') {
        const removed = modelCascadeIds(objects, event.id);
        const kept = removed.size === 0 ? objects : objects.filter((object) => !removed.has(object.id));
        // A model goes from what grows it and paints it as well.
        return kept.map((object) => {
            if (object.terrainData) {
                const terrainData = withoutTerrainLayerModel(object.terrainData, event.id);
                return terrainData === object.terrainData ? object : { ...object, terrainData };
            }
            if (object.foliageData?.types.some(type => type.modelId === event.id)) {
                return { ...object, foliageData: { types: object.foliageData.types.filter(type => type.modelId !== event.id) } };
            }
            return object;
        });
    }
    return objects.map((object) => {
        if (event.kind === 'texture' && object.terrainData && terrainReferencesTexture(object.terrainData, event.id)) {
            return { ...object, terrainData: withoutTerrainTexture(object.terrainData, event.id) };
        }
        if (event.kind === 'audio' && object.audioConfig?.audioId === event.id) {
            const { audioConfig: _removed, ...withoutAudioReference } = object;
            return withoutAudioReference;
        }
        return object;
    });
};

/** Remove a deleted asset reference from a not-yet-persisted partial edit. */
const withoutDomainReference = (updates: Partial<LevelObject>, event: DomainCascadeEvent): Partial<LevelObject> => {
    if (event.kind === 'texture' && updates.terrainData && terrainReferencesTexture(updates.terrainData, event.id)) {
        return { ...updates, terrainData: withoutTerrainTexture(updates.terrainData, event.id) };
    }
    if (event.kind === 'audio' && updates.audioConfig?.audioId === event.id) {
        const { audioConfig: _removed, ...withoutAudioReference } = updates;
        return withoutAudioReference;
    }
    return updates;
};

const diffLevelObjects = (currentState: LevelObject[], nextState: LevelObject[]) => {
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
            // A level object is an authored document. Compare the complete
            // document so name/type/audio/spawn/terrain/sky and every
            // transform component survive undo/redo round trips.
            const changed = oldItem.foliageData || item.foliageData
                ? !sameFoliageObject(oldItem, item)
                : oldItem.terrainData && item.terrainData
                    ? !sameTerrainObject(oldItem, item)
                    : JSON.stringify(oldItem) !== JSON.stringify(item);
            if (changed) {
                toUpdate.push(item);
            }
        }
    }
    // The project rejects an object whose parent is missing: parents are
    // written before their children and deleted after them.
    if (toAdd.length > 1) {
        const added = new Set(toAdd.map((object) => object.id));
        toAdd.splice(0, toAdd.length, ...sortByHierarchy(nextState).filter((object) => added.has(object.id)));
    }
    if (toDelete.length > 1) {
        const deleted = new Set(toDelete);
        toDelete.splice(0, toDelete.length, ...sortByHierarchy(currentState)
            .filter((object) => deleted.has(object.id)).map((object) => object.id).reverse());
    }
    return { toDelete, toAdd, toUpdate };
};

const changedLevelObjectIds = (currentState: LevelObject[], nextState: LevelObject[]): string[] => {
    const { toDelete, toAdd, toUpdate } = diffLevelObjects(currentState, nextState);
    return [...toDelete, ...toAdd.map((object) => object.id), ...toUpdate.map((object) => object.id)];
};

const describeError = (error: unknown): string => error instanceof Error && error.message ? error.message : 'unknown error';

// Host error codes for a level edit that writing it again cannot fix: the
// document failed validation (a schema error is reported as internal_error),
// it no longer exists, or the project is read-only. Conflicts, an unavailable
// host and transport failures stay retryable.
const REJECTED_EDIT_CODES = new Set(['invalid_request', 'invalid_project', 'internal_error', 'read_only']);

const isRejectedLevelEdit = (error: unknown): boolean => error instanceof TerrainHeightfieldEncodingError
    || (error instanceof Error && REJECTED_EDIT_CODES.has(String((error as { code?: unknown }).code)));

const syncStateToDB = async (
    currentState: LevelObject[],
    nextState: LevelObject[],
    lease?: EditorSessionLease,
    allowRollback = true,
) => {
    if (lease && !editorSession.isCurrent(lease)) return false;
    let activeLease = lease;
    const { toDelete, toAdd, toUpdate } = diffLevelObjects(currentState, nextState);

    try {
        // Adds and updates first, deletes last: every intermediate project
        // state then only names parents that still exist.
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
        for (const id of toDelete) {
            if (activeLease && !editorSession.isCurrent(activeLease)) return false;
            await dbOperations.deleteLevelObject(id, activeLease);
            if (lease && !editorSession.isSameSession(lease)) return false;
            activeLease = editorSession.captureReady() || undefined;
        }
        return true;
    } catch (error) {
        if (allowRollback) {
            const rollbackLease = editorSession.captureReady();
            if (rollbackLease && (!lease || editorSession.isSameSession(lease))) {
                try {
                    const restored = await syncStateToDB(nextState, currentState, rollbackLease, false);
                    if (!restored) frontendDiagnostics.failure('level_history_rollback_rejected', error);
                } catch (rollbackError) {
                    frontendDiagnostics.failure('level_history_rollback_failed', rollbackError);
                }
            }
        }
        throw error;
    }
};

export const useLevelManager = (models: LoadedModelData[]) => {
  const session = editorSession;
  const sessionSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [workingState, setWorkingState] = useState<LevelWorkingState>(EMPTY_WORKING_STATE);
  const { levels, currentLevelId, levelObjects, activeLevelBlueprint } = workingState;
  const levelObjectsRef = useRef(levelObjects);
  levelObjectsRef.current = levelObjects;
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const currentLevelIdRef = useRef<string | null>(null);
  const getCurrentLevelId = useCallback(() => currentLevelIdRef.current, []);

  const replaceWorkingState = useCallback((next: LevelWorkingState) => {
      currentLevelIdRef.current = next.currentLevelId;
      setWorkingState(next);
  }, []);

  const { addNotification } = useNotification();

  // Debounced partial edits (gizmo, inspector, sculpt). An edit stays in
  // pendingUpdatesRef until it is written; while a write is running it is
  // tracked in inFlightUpdatesRef so undo/redo, deletes and asset cascades
  // can supersede it and a failed write is not re-queued over newer data.
  const pendingUpdatesRef = useRef<Map<string, PendingLevelEdit>>(new Map());
  const inFlightUpdatesRef = useRef<Map<string, PendingLevelEdit>>(new Map());
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const clearSaveTimeout = () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
  };

  /** Take pending and in-flight edits for objects whose whole document is about to be rewritten or removed. */
  const supersedePendingEdits = useCallback((ids: Iterable<string>) => {
      const superseded = new Map<string, PendingLevelEdit>();
      for (const id of ids) {
          const pending = pendingUpdatesRef.current.get(id);
          if (pending) superseded.set(id, pending);
          pendingUpdatesRef.current.delete(id);
          inFlightUpdatesRef.current.delete(id);
      }
      return superseded;
  }, []);

  /** Put superseded edits back after the operation that took them failed; newer edits win. */
  const restorePendingEdits = useCallback((superseded: Map<string, PendingLevelEdit>) => {
      for (const [id, edit] of superseded) {
          if (!session.isSameSession(edit.lease)) continue;
          const newer = pendingUpdatesRef.current.get(id);
          pendingUpdatesRef.current.set(id, newer ? { updates: { ...edit.updates, ...newer.updates }, lease: newer.lease } : edit);
      }
  }, [session]);

  // History State
  const history = useRef<{ past: LevelObject[][], future: LevelObject[][] }>({ past: [], future: [] });
  const historyFailuresRef = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryState = () => {
      setCanUndo(history.current.past.length > 0);
      setCanRedo(history.current.future.length > 0);
  };

  const snapshotHistory = useCallback(() => {
      session.requireCurrent(session.captureReady());
      const snapshot = snapshotLevelObjects(levelObjects);
      history.current.past.push(snapshot);
      if (history.current.past.length > 50) history.current.past.shift();
      history.current.future = []; 
      updateHistoryState();
  }, [levelObjects, session]);

  /**
   * Steps through the history. The screen answers at once and the host catches
   * up behind it, in order with every other write, so holding Ctrl+Z walks back
   * without waiting for the disk. A step the host refuses puts back what it took.
   */
  const stepHistory = useCallback(async (direction: 'Undo' | 'Redo') => {
      const lease = session.requireCurrent(session.captureReady());
      const { past, future } = history.current;
      const [from, to] = direction === 'Undo' ? [past, future] : [future, past];
      const wanted = from[from.length - 1];
      if (!wanted) return;
      const shown = levelObjectsRef.current;
      const stacks = { past: [...past], future: [...future] };
      const failures = historyFailuresRef.current;
      // Rewritten documents supersede pending partial edits of the same objects.
      const superseded = supersedePendingEdits(changedLevelObjectIds(shown, wanted));
      from.pop();
      to.push(snapshotLevelObjects(shown));
      levelObjectsRef.current = wanted;
      setWorkingState(prev => ({ ...prev, levelObjects: wanted }));
      updateHistoryState();
      addNotification({ message: direction, type: 'info', duration: 800 });

      const write = flushChainRef.current.then(async () => {
          // An earlier step failed, and this one started from what it wrote.
          if (historyFailuresRef.current !== failures) {
              restorePendingEdits(superseded);
              return;
          }
          // The write itself uses the newest revision of that same session.
          const current = session.isSameSession(lease) ? session.captureReady() : null;
          if (!current) return;
          try {
              if (await syncStateToDB(shown, wanted, current)) return;
          } catch (error) {
              frontendDiagnostics.failure(direction === 'Undo' ? 'level_undo_failed' : 'level_redo_failed', error);
              addNotification({ message: `${direction} failed; no history was consumed.`, type: 'error' });
          }
          if (!session.isSameSession(lease)) return;
          historyFailuresRef.current += 1;
          history.current = stacks;
          restorePendingEdits(superseded);
          // What the host still has goes back on screen, under edits made since.
          const restored = shown.map((object) => {
              const edit = pendingUpdatesRef.current.get(object.id);
              return edit ? { ...object, ...edit.updates } : object;
          });
          levelObjectsRef.current = restored;
          setWorkingState(prev => ({ ...prev, levelObjects: restored }));
          updateHistoryState();
      });
      flushChainRef.current = write.catch(() => undefined);
      await write;
  }, [addNotification, restorePendingEdits, session, supersedePendingEdits]);

  const undo = useCallback(() => stepHistory('Undo'), [stepHistory]);
  const redo = useCallback(() => stepHistory('Redo'), [stepHistory]);

  useEffect(() => {
      history.current = { past: [], future: [] };
      updateHistoryState();
  }, [currentLevelId]);

  useEffect(() => subscribeDomainCascade((event) => {
      const status = projectService.getStatus();
      if (session.getSnapshot().phase !== 'ready' || status.projectId !== event.projectId) return;
      const currentObjects = workingState.levelObjects;
      const affectedIds = event.kind === 'model'
          ? modelCascadeIds(currentObjects, event.id)
          : new Set(currentObjects
              .filter((object) => event.kind === 'texture'
                  ? terrainReferencesTexture(object.terrainData, event.id)
                  : object.audioConfig?.audioId === event.id)
              .map((object) => object.id));
      if (affectedIds.size === 0) return;
      // The host already rewrote the stored documents. Unwritten edits of the
      // affected objects are re-queued without the deleted reference (or
      // dropped with a removed model's objects) so they cannot resurrect it.
      for (const id of affectedIds) {
          const inFlight = inFlightUpdatesRef.current.get(id);
          const pending = pendingUpdatesRef.current.get(id);
          supersedePendingEdits([id]);
          const edit = pending ?? inFlight;
          if (event.kind === 'model' || !edit) continue;
          const updates = withoutDomainReference({ ...(inFlight?.updates || {}), ...(pending?.updates || {}) }, event);
          if (Object.keys(updates).length > 0) pendingUpdatesRef.current.set(id, { updates, lease: edit.lease });
      }
      if (pendingUpdatesRef.current.size === 0) clearSaveTimeout();
      setWorkingState((current) => {
          const nextObjects = applyDomainCascade(current.levelObjects, event);
          return nextObjects.length === current.levelObjects.length
              && nextObjects.every((object, index) => object === current.levelObjects[index])
              ? current
              : { ...current, levelObjects: nextObjects };
      });
  }), [session, supersedePendingEdits, workingState.levelObjects]);

  /**
   * Put the object of an edit the project rejected back to its stored
   * document, keeping edits made since. Returns false when the stored state
   * cannot be read, so the caller keeps the edit pending instead.
   */
  const revertRejectedEdit = useCallback(async (id: string, edit: PendingLevelEdit, error: unknown): Promise<boolean> => {
      let stored: LevelObject | undefined;
      try {
          stored = (await dbOperations.getAllNativeLevelObjects()).find((object) => object.id === id);
      } catch (readError) {
          frontendDiagnostics.failure('level_edit_revert_failed', readError);
          return false;
      }
      // Undo/redo, a delete or an asset cascade rewrote the object meanwhile,
      // or the session ended; either way there is nothing left to revert.
      if (inFlightUpdatesRef.current.get(id) !== edit || !session.isSameSession(edit.lease)) return true;
      const name = levelObjectsRef.current.find((object) => object.id === id)?.name || stored?.name || id;
      const newer = pendingUpdatesRef.current.get(id);
      // Later partial edits of an object the project no longer has would be rejected too.
      if (!stored) pendingUpdatesRef.current.delete(id);
      const reverted = stored && newer ? { ...stored, ...newer.updates } : stored;
      setWorkingState((current) => ({
          ...current,
          levelObjects: current.levelObjects.flatMap((object) => object.id !== id ? [object] : reverted ? [reverted] : []),
      }));
      frontendDiagnostics.failure('level_edit_rejected', error);
      const fields = Object.keys(edit.updates).join(', ');
      addNotification({
          message: `The edit to "${name}"${fields ? ` (${fields})` : ''} cannot be saved (${describeError(error)}) and has been ${stored ? 'reverted' : 'discarded because the object no longer exists'}.`,
          type: 'error',
      });
      return true;
  }, [addNotification, session]);

  /** Write every pending edit of the current session; failed writes stay pending. */
  const writePendingEdits = useCallback(async () => {
      const failures: unknown[] = [];
      let fenced = 0;
      while (pendingUpdatesRef.current.size > 0 && failures.length === 0) {
          const batch = [...pendingUpdatesRef.current.entries()];
          pendingUpdatesRef.current.clear();
          for (const [id, edit] of batch) inFlightUpdatesRef.current.set(id, edit);
          for (const [id, edit] of batch) {
              // Superseded by undo/redo, a delete or an asset cascade.
              if (inFlightUpdatesRef.current.get(id) !== edit) continue;
              // Never write an edit into a different project, level or session;
              // the write itself uses the newest revision of that same session.
              const lease = session.isSameSession(edit.lease) ? session.captureReady() : null;
              if (!lease) {
                  inFlightUpdatesRef.current.delete(id);
                  fenced++;
                  continue;
              }
              try {
                  await dbOperations.updateLevelObject(id, edit.updates, lease);
              } catch (error) {
                  // Retrying a rejected edit cannot succeed and would block every
                  // later save, so its object is reverted (a superseding rewrite
                  // already replaced it). Other failures are retried.
                  const current = inFlightUpdatesRef.current.get(id) === edit;
                  if (isRejectedLevelEdit(error) && (!current || await revertRejectedEdit(id, edit, error))) continue;
                  failures.push(error);
                  // Keep the edit (it is still shown) retryable instead of
                  // reverting it; edits made meanwhile are newer and win.
                  if (inFlightUpdatesRef.current.get(id) === edit) restorePendingEdits(new Map([[id, edit]]));
              } finally {
                  if (inFlightUpdatesRef.current.get(id) === edit) inFlightUpdatesRef.current.delete(id);
              }
          }
      }
      return { failures, fenced };
  }, [restorePendingEdits, revertRejectedEdit, session]);

  /**
   * Persist all pending level edits and wait for them. Project operations,
   * level switches and unmount call this before the session ends; a failure
   * is reported, keeps the edits pending and rejects so callers can stop.
   */
  const flushPendingLevelEdits = useCallback(async ({ notify = true }: { notify?: boolean } = {}): Promise<void> => {
      clearSaveTimeout();
      // Serialize flushes so a save never overtakes a debounced write in progress.
      const result = flushChainRef.current.then(() => writePendingEdits());
      flushChainRef.current = result.catch(() => undefined);
      const { failures, fenced } = await result;
      if (fenced > 0) {
          frontendDiagnostics.warning('level_pending_edits_fenced', fenced);
          addNotification({ message: `${fenced} level edit${fenced === 1 ? ' was' : 's were'} discarded because the editor session changed.`, type: 'error' });
      }
      if (failures.length === 0) return;
      frontendDiagnostics.failure('level_batch_persist_failed', failures[0]);
      const error = new Error(`Level edits could not be saved: ${describeError(failures[0])}. They are kept and will be retried on the next edit or save.`);
      if (notify) addNotification({ message: error.message, type: 'error' });
      throw error;
  }, [addNotification, writePendingEdits]);

  const flushPendingLevelEditsRef = useRef(flushPendingLevelEdits);
  flushPendingLevelEditsRef.current = flushPendingLevelEdits;

  const scheduleFlush = useCallback(() => {
      clearSaveTimeout();
      saveTimeoutRef.current = setTimeout(() => {
          saveTimeoutRef.current = null;
          // The flush reports its own failure and keeps the edits pending.
          void flushPendingLevelEditsRef.current().catch(() => undefined);
      }, 1500);
  }, []);

  useEffect(() => session.subscribe(() => {
      if (session.getSnapshot().phase !== 'transitioning') return;
      clearSaveTimeout();
      // Project operations and level switches flush before they begin a
      // transition. Anything still pending belongs to a session that was
      // replaced underneath the editor and can no longer be written.
      const discarded = pendingUpdatesRef.current.size;
      pendingUpdatesRef.current.clear();
      if (discarded > 0) {
          frontendDiagnostics.warning('level_pending_edits_discarded', discarded);
          addNotification({ message: `${discarded} unsaved level edit${discarded === 1 ? ' was' : 's were'} discarded because the project session changed.`, type: 'error' });
      }
  }), [addNotification, session]);

  useEffect(() => () => {
      // Cleanup cannot await: start writing what is still pending. The writes
      // stay ordered in the project mutation queue.
      void flushPendingLevelEditsRef.current().catch(() => undefined);
  }, []);

  // Terrain heights live in heightfield assets. Resolve them into the
  // in-memory objects once a level is published so rendering, sculpting and
  // play-mode height sampling keep reading terrainData.heights.
  const failedHeightfieldsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, TerrainHeightfieldReference>();
      for (const object of levelObjects) {
          const reference = object.terrainData?.heightfield;
          if (reference && isTerrainHeightfieldPending(object.terrainData) && !failedHeightfieldsRef.current.has(reference.assetId)) {
              references.set(reference.assetId, reference);
          }
      }
      if (references.size === 0) return;
      let active = true;
      for (const reference of references.values()) {
          resolveTerrainHeightfield(reference).then((heights) => {
              if (!active) return;
              const resolves = (object: LevelObject): boolean => {
                  const terrain = object.terrainData;
                  return Boolean(terrain?.heightfield && isTerrainHeightfieldPending(terrain)
                      && terrain.heightfield.assetId === reference.assetId
                      && terrain.heightfield.columns === reference.columns
                      && terrain.heightfield.rows === reference.rows);
              };
              // Snapshots taken while the heights were loading get them too: the
              // host discards a heightfield once a commit replaces it, so undo
              // must be able to upload the heights again.
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => {
                      if (resolves(object)) snapshot[index] = { ...object, terrainData: { ...object.terrainData!, heights: heights.slice() } };
                  });
              }
              setWorkingState((current) => {
                  let changed = false;
                  const nextObjects = current.levelObjects.map((object) => {
                      if (!resolves(object)) return object;
                      changed = true;
                      return { ...object, terrainData: { ...object.terrainData!, heights } };
                  });
                  return changed ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedHeightfieldsRef.current.add(reference.assetId);
              frontendDiagnostics.failure('terrain_heightfield_resolve_failed', error);
              addNotification({ message: `Terrain heights could not be loaded (${describeError(error)}); sculpting is disabled for that terrain.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

  // Terrain paint weights live in splat map assets and are resolved the same
  // way into terrainData.splat, history snapshots included: like heightfields,
  // the host discards a splat map once a commit replaces it.
  const failedSplatmapsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, TerrainSplatmapReference>();
      for (const object of levelObjects) {
          const reference = object.terrainData?.splatmap;
          if (reference && isTerrainSplatPending(object.terrainData) && !failedSplatmapsRef.current.has(reference.assetId)) {
              references.set(reference.assetId, reference);
          }
      }
      if (references.size === 0) return;
      let active = true;
      for (const reference of references.values()) {
          resolveTerrainSplatmap(reference).then((splat) => {
              if (!active) return;
              const resolves = (object: LevelObject): boolean => {
                  const terrain = object.terrainData;
                  return Boolean(terrain?.splatmap && isTerrainSplatPending(terrain)
                      && terrain.splatmap.assetId === reference.assetId
                      && terrain.splatmap.columns === reference.columns
                      && terrain.splatmap.rows === reference.rows);
              };
              // Snapshots taken while the weights were loading get them too,
              // so undo and redo can upload the weights again.
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => {
                      if (resolves(object)) snapshot[index] = { ...object, terrainData: { ...object.terrainData!, splat: splat.slice() } };
                  });
              }
              setWorkingState((current) => {
                  let changed = false;
                  const nextObjects = current.levelObjects.map((object) => {
                      if (!resolves(object)) return object;
                      changed = true;
                      return { ...object, terrainData: { ...object.terrainData!, splat } };
                  });
                  return changed ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedSplatmapsRef.current.add(reference.assetId);
              frontendDiagnostics.failure('terrain_splatmap_resolve_failed', error);
              addNotification({ message: `Terrain paint could not be loaded (${describeError(error)}); painting is disabled for that terrain.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

  // A terrain's edit layers are resolved the same way, each into its own deltas.
  const failedEditLayersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, TerrainHeightfieldReference>();
      for (const object of levelObjects) {
          for (const layer of object.terrainData?.editLayers ?? []) {
              if (layer.heightfield && isEditLayerPending(layer) && !failedEditLayersRef.current.has(layer.heightfield.assetId)) {
                  references.set(layer.heightfield.assetId, layer.heightfield);
              }
          }
      }
      if (references.size === 0) return;
      let active = true;
      const resolveIn = (object: LevelObject, assetId: string, deltas: number[]): LevelObject => {
          const layers = object.terrainData?.editLayers;
          if (!layers?.some(layer => layer.heightfield?.assetId === assetId && isEditLayerPending(layer))) return object;
          return { ...object, terrainData: { ...object.terrainData!, editLayers: layers.map(layer => (layer.heightfield?.assetId === assetId && isEditLayerPending(layer) ? { ...layer, deltas } : layer)) } };
      };
      for (const reference of references.values()) {
          resolveEditLayer(reference, async (assetId) => {
              const response = await fetch(await projectService.resolveAsset(assetId), { method: 'GET' });
              if (!response.ok) throw new Error(`Terrain layer download failed (${response.status})`);
              return response.arrayBuffer();
          }).then((deltas) => {
              if (!active) return;
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => { snapshot[index] = resolveIn(object, reference.assetId, deltas); });
              }
              setWorkingState((current) => {
                  const nextObjects = current.levelObjects.map(object => resolveIn(object, reference.assetId, deltas));
                  return nextObjects.some((object, index) => object !== current.levelObjects[index]) ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedEditLayersRef.current.add(reference.assetId);
              frontendDiagnostics.failure('terrain_edit_layer_resolve_failed', error);
              addNotification({ message: `A terrain layer could not be loaded (${describeError(error)}); it cannot be edited.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

  // A foliage set's instances are resolved the same way, type by type, into foliageData.
  const failedFoliageRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, FoliageInstanceReference>();
      for (const object of levelObjects) {
          for (const type of object.foliageData?.types ?? []) {
              if (type.instancemap && isFoliageTypePending(type) && !failedFoliageRef.current.has(type.instancemap.assetId)) {
                  references.set(type.instancemap.assetId, type.instancemap);
              }
          }
      }
      if (references.size === 0) return;
      let active = true;
      const resolveIn = (object: LevelObject, assetId: string, instances: Float32Array): LevelObject => {
          const types = object.foliageData?.types;
          if (!types?.some(type => type.instancemap?.assetId === assetId && isFoliageTypePending(type))) return object;
          return { ...object, foliageData: { types: types.map(type => (type.instancemap?.assetId === assetId && isFoliageTypePending(type) ? { ...type, instances } : type)) } };
      };
      for (const reference of references.values()) {
          resolveFoliageInstances(reference, async (assetId) => {
              const response = await fetch(await projectService.resolveAsset(assetId), { method: 'GET' });
              if (!response.ok) throw new Error(`Foliage download failed (${response.status})`);
              return response.arrayBuffer();
          }).then((instances) => {
              if (!active) return;
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => { snapshot[index] = resolveIn(object, reference.assetId, instances); });
              }
              setWorkingState((current) => {
                  const nextObjects = current.levelObjects.map(object => resolveIn(object, reference.assetId, instances));
                  return nextObjects.some((object, index) => object !== current.levelObjects[index]) ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedFoliageRef.current.add(reference.assetId);
              frontendDiagnostics.failure('foliage_instances_resolve_failed', error);
              addNotification({ message: `Foliage could not be loaded (${describeError(error)}); it will not be drawn.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

  // The weights of layers 5 to 8 are resolved the same way into terrainData.splat2.
  const failedSplatmaps2Ref = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, TerrainSplatmapReference>();
      for (const object of levelObjects) {
          const reference = object.terrainData?.splatmap2;
          if (reference && isTerrainSplat2Pending(object.terrainData) && !failedSplatmaps2Ref.current.has(reference.assetId)) {
              references.set(reference.assetId, reference);
          }
      }
      if (references.size === 0) return;
      let active = true;
      for (const reference of references.values()) {
          resolveTerrainSplatmap(reference).then((splat2) => {
              if (!active) return;
              const resolves = (object: LevelObject): boolean => Boolean(
                  object.terrainData?.splatmap2?.assetId === reference.assetId && isTerrainSplat2Pending(object.terrainData),
              );
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => {
                      if (resolves(object)) snapshot[index] = { ...object, terrainData: { ...object.terrainData!, splat2 } };
                  });
              }
              setWorkingState((current) => {
                  let changed = false;
                  const nextObjects = current.levelObjects.map((object) => {
                      if (!resolves(object)) return object;
                      changed = true;
                      return { ...object, terrainData: { ...object.terrainData!, splat2 } };
                  });
                  return changed ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedSplatmaps2Ref.current.add(reference.assetId);
              frontendDiagnostics.failure('terrain_splatmap_resolve_failed', error);
              addNotification({ message: `Terrain paint could not be loaded (${describeError(error)}); painting is disabled for that terrain.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

  // Terrain holes are resolved the same way into terrainData.holes.
  const failedHolemapsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      const references = new Map<string, TerrainSplatmapReference>();
      for (const object of levelObjects) {
          const reference = object.terrainData?.holemap;
          if (reference && isTerrainHolesPending(object.terrainData) && !failedHolemapsRef.current.has(reference.assetId)) {
              references.set(reference.assetId, reference);
          }
      }
      if (references.size === 0) return;
      let active = true;
      for (const reference of references.values()) {
          resolveTerrainHolemap(reference).then((holes) => {
              if (!active) return;
              const resolves = (object: LevelObject): boolean => Boolean(
                  object.terrainData?.holemap?.assetId === reference.assetId && isTerrainHolesPending(object.terrainData),
              );
              for (const snapshot of [...history.current.past, ...history.current.future]) {
                  snapshot.forEach((object, index) => {
                      if (resolves(object)) snapshot[index] = { ...object, terrainData: { ...object.terrainData!, holes } };
                  });
              }
              setWorkingState((current) => {
                  let changed = false;
                  const nextObjects = current.levelObjects.map((object) => {
                      if (!resolves(object)) return object;
                      changed = true;
                      return { ...object, terrainData: { ...object.terrainData!, holes } };
                  });
                  return changed ? { ...current, levelObjects: nextObjects } : current;
              });
          }, (error) => {
              if (!active) return;
              failedHolemapsRef.current.add(reference.assetId);
              frontendDiagnostics.failure('terrain_holes_resolve_failed', error);
              addNotification({ message: `Terrain holes could not be loaded (${describeError(error)}); the ground shows solid there.`, type: 'error' });
          });
      }
      return () => { active = false; };
  }, [addNotification, levelObjects]);

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
      const lease = session.requireCurrent(session.captureReady());
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
      session.requireCurrent(session.captureReady());
      if (id === currentLevelIdRef.current) return;
      if (!levels.some((level) => level.id === id)) throw new Error('Cannot load an unknown level.');
      // The current level's pending edits belong to its session: persist them
      // before the switch ends it. A failed flush has been reported and keeps
      // this level open so the edits stay retryable.
      try {
          await flushPendingLevelEdits();
      } catch {
          return;
      }
      const lease = session.requireCurrent(session.captureReady());
      if (id === currentLevelIdRef.current) return;
      const authoritative = projectService.getStatus();
      if (!authoritative.projectId) throw new Error('Cannot load a level without an open native project.');
      session.requireWritable(lease, authoritative);
      const transition = session.beginTransition();
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
  }, [levels, addNotification, flushPendingLevelEdits, replaceWorkingState, session]);

  const deleteLevel = useCallback(async (id: string) => {
      const lease = session.requireCurrent(session.captureReady());
      projectService.assertWritable();
      // Deleting the current level deletes its objects; their pending edits go with them.
      const superseded = id === currentLevelId
          ? supersedePendingEdits([...pendingUpdatesRef.current.keys(), ...inFlightUpdatesRef.current.keys()])
          : new Map<string, PendingLevelEdit>();
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
          restorePendingEdits(superseded);
          frontendDiagnostics.failure('level_delete_failed', e);
          addNotification({ message: "Failed to delete level.", type: 'error' });
      }
  }, [currentLevelId, levels, loadLevel, initLevels, addNotification, restorePendingEdits, session, supersedePendingEdits]);

  const addLevelObject = useCallback(async (
      modelId: string, 
      position: [number, number, number], 
      rotation: [number, number, number], 
      scale: [number, number, number],
      type: LevelObjectType = 'prop',
      extraData?: any
  ): Promise<string | undefined> => {
    const lease = session.requireCurrent(session.captureReady());
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
              type === 'player_start' ? 'Player Start' :
              type === 'terrain' ? nextTerrainName(levelObjects) :
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

  /**
   * Insert complete documents (ids, parentId, components and configs kept)
   * into the current level as one undo step, parents before children. A
   * parent that is neither in the batch nor in the level, or that would close
   * a cycle, makes the object a root. Resolves to the inserted ids in write
   * order; rejects (after notifying) when the documents cannot be saved, in
   * which case the ones already written are removed again.
   */
  const addLevelObjects = useCallback(async (objects: LevelObject[]): Promise<string[]> => {
      const lease = session.requireCurrent(session.captureReady());
      const activeLevelId = currentLevelIdRef.current;
      if (!activeLevelId || lease.levelId !== activeLevelId || objects.length === 0) return [];
      projectService.assertWritable();
      const existing = new Set(levelObjects.map((object) => object.id));
      const incoming = new Set<string>();
      for (const object of objects) {
          // An upsert under a used id would overwrite that object.
          if (!object.id || existing.has(object.id) || incoming.has(object.id)) {
              throw new Error(`Cannot add "${object.name || object.id}": its id is already used in this level.`);
          }
          if (object.modelId && !models.some((model) => model.id === object.modelId)) {
              throw new Error(`Cannot add "${object.name || object.id}": its model is not in the library.`);
          }
          incoming.add(object.id);
      }
      const placed = new Set(existing);
      const documents = sortByHierarchy(objects).map((object): LevelObject => {
          const document: LevelObject = { ...object, levelId: activeLevelId };
          if (document.parentId && !placed.has(document.parentId)) document.parentId = null;
          placed.add(document.id);
          return document;
      });
      snapshotHistory();
      try {
          if (!await syncStateToDB([], documents, lease) || !session.isSameSession(lease)) return [];
      } catch (error) {
          frontendDiagnostics.failure('level_objects_add_failed', error);
          addNotification({
              message: `${documents.length === 1 ? 'The object' : `${documents.length} objects`} could not be added (${describeError(error)}).`,
              type: 'error',
          });
          throw error;
      }
      setWorkingState(prev => ({ ...prev, levelObjects: [...prev.levelObjects, ...documents] }));
      return documents.map((object) => object.id);
  }, [addNotification, levelObjects, models, snapshotHistory, session]);

  /**
   * Delete the objects and all of their descendants as one undo step. The
   * project rejects an object whose parent is missing, so children are
   * deleted before their parents and no child is ever left orphaned.
   */
  const removeLevelObjects = useCallback(async (rootIds: string[]) => {
      const lease = session.requireCurrent(session.captureReady());
      projectService.assertWritable();
      const doomed = new Set<string>();
      for (const id of rootIds) {
          for (const object of collectSubtree(levelObjects, id)) doomed.add(object.id);
      }
      if (doomed.size === 0) return;
      const ids = sortByHierarchy(levelObjects.filter((object) => doomed.has(object.id)))
          .map((object) => object.id)
          .reverse();
      snapshotHistory();
      // A partial edit written after the delete would recreate a broken document.
      const superseded = supersedePendingEdits(ids);
      const deleted = new Set<string>();
      try {
          let activeLease: EditorSessionLease = lease;
          for (const id of ids) {
              session.requireCurrent(activeLease);
              await dbOperations.deleteLevelObject(id, activeLease);
              deleted.add(id);
              if (!session.isSameSession(lease)) return;
              activeLease = session.captureReady()!;
          }
      } catch(e) {
          restorePendingEdits(new Map([...superseded].filter(([id]) => !deleted.has(id))));
          frontendDiagnostics.failure('level_object_batch_delete_failed', e);
          addNotification({ message: `Delete failed (${describeError(e)}); ${ids.length - deleted.size} of ${ids.length} objects were kept.`, type: 'error' });
      }
      // Objects already deleted (children first) are gone even when a later delete failed.
      if (deleted.size === 0 || !session.isSameSession(lease)) return;
      setWorkingState(prev => ({ ...prev, levelObjects: prev.levelObjects.filter(o => !deleted.has(o.id)) }));
  }, [addNotification, levelObjects, restorePendingEdits, snapshotHistory, session, supersedePendingEdits]);

  /** Delete one object together with its descendants. */
  const removeLevelObject = useCallback((id: string) => removeLevelObjects([id]), [removeLevelObjects]);

  const updateLevelObject = useCallback((id: string, updates: Partial<LevelObject>) => {
      const lease = session.requireCurrent(session.captureReady());
      projectService.assertWritable();
      const previous = levelObjects.find((object) => object.id === id);
      if (!previous) return;
      // A stroke sculpted over a terrain whose heightfield is still loading
      // would replace the stored heights with a flat placeholder.
      if (updates.terrainData?.heights?.length && isTerrainHeightfieldPending(previous.terrainData)) {
          addNotification({ message: 'Terrain heights are still loading; the sculpt was not applied.', type: 'error' });
          return;
      }
      // Likewise a paint stroke over a splat map that is still loading would
      // replace the stored weights with unpainted ones.
      if (updates.terrainData?.splat?.length && isTerrainSplatPending(previous.terrainData)) {
          addNotification({ message: 'Terrain paint is still loading; the stroke was not applied.', type: 'error' });
          return;
      }
      // Whatever changed the heights, what stands on the ground moves with it, in the same undo step.
      const nextTerrain = updates.terrainData;
      const foliageSet = nextTerrain?.heights && previous.terrainData && nextTerrain.heights !== previous.terrainData.heights
          ? levelObjects.find((object) => object.type === 'foliage_set')
          : undefined;
      const ground = (data: TerrainData): FoliageGroundTerrain => ({
          position: previous.position, scale: previous.scale, width: data.width, depth: data.depth, resolution: Math.floor(data.resolution), heights: data.heights,
      });
      // Two terrains in one stroke arrive one after the other: the second builds on the first.
      const foliageNow = foliageSet && (pendingUpdatesRef.current.get(foliageSet.id)?.updates.foliageData ?? foliageSet.foliageData);
      const followed = foliageSet && foliageNow && nextTerrain ? foliageAfterTerrainEdit(foliageNow.types, ground(previous.terrainData!), ground(nextTerrain)) : null;
      setWorkingState(prev => ({
          ...prev,
          levelObjects: prev.levelObjects.map(o => {
              if (o.id === id) return { ...o, ...updates };
              return followed && o.id === foliageSet?.id ? { ...o, foliageData: { types: followed } } : o;
          }),
      }));
      const existing = pendingUpdatesRef.current.get(id);
      pendingUpdatesRef.current.set(id, {
          updates: { ...(existing?.updates || {}), ...updates },
          lease,
      });
      if (followed && foliageSet) {
          const existingSet = pendingUpdatesRef.current.get(foliageSet.id);
          pendingUpdatesRef.current.set(foliageSet.id, { updates: { ...(existingSet?.updates || {}), foliageData: { types: followed } }, lease });
      }
      scheduleFlush();
  }, [addNotification, levelObjects, scheduleFlush, session]);

  // Blueprint edits arrive per keystroke. One write runs at a time and edits made meanwhile are
  // folded into the next one, which takes its lease when it starts: a lease captured before the
  // previous write landed names a stale project revision, so that write was refused and its
  // rollback dropped the newest characters.
  const blueprintWrites = useRef<{
      running: boolean;
      queued: { lease: EditorSessionLease; level: LevelData; blueprint: LevelBlueprintData } | null;
      /** What the project holds, restored when the newest edit cannot be saved. */
      saved: LevelBlueprintData | null;
  }>({ running: false, queued: null, saved: null });

  const drainBlueprintWrites = useCallback(async () => {
      const writes = blueprintWrites.current;
      if (writes.running) return;
      writes.running = true;
      try {
          while (writes.queued) {
              const { lease: origin, level, blueprint } = writes.queued;
              writes.queued = null;
              // An edit belongs to the session it was made in; only the revision may have moved since.
              if (!session.isSameSession(origin)) continue;
              const lease = session.captureReady() ?? origin;
              try {
                  const latest = levelsRef.current.find(item => item.id === level.id) ?? level;
                  await dbOperations.addLevel({ ...latest, blueprint }, lease);
                  writes.saved = blueprint;
              } catch (error) {
                  // A newer edit is written next and carries this one's changes.
                  if (writes.queued) continue;
                  const saved = writes.saved;
                  setWorkingState(current => current.activeLevelBlueprint === blueprint && saved
                      ? {
                          ...current,
                          activeLevelBlueprint: saved,
                          levels: current.levels.map(item => item.id === level.id ? { ...item, blueprint: saved } : item),
                      }
                      : current);
                  frontendDiagnostics.failure('level_blueprint_persist_failed', error);
              }
          }
      } finally {
          writes.running = false;
      }
  }, [session]);

  const updateLevelBlueprint = useCallback((data: Partial<LevelBlueprintData>) => {
      const lease = session.requireCurrent(session.captureReady());
      projectService.assertWritable();
      const next = { ...activeLevelBlueprint, ...data };
      const writes = blueprintWrites.current;
      if (!writes.running && !writes.queued) writes.saved = activeLevelBlueprint;
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
              writes.queued = { lease, level: lvl, blueprint: next };
              void drainBlueprintWrites();
          }
      }
  }, [activeLevelBlueprint, currentLevelId, drainBlueprintWrites, levels, session]);

  /** Stores a level's baked lighting (its settings and, once baked, the volume); null clears it. Rejects when it cannot be saved. */
  const updateLevelBakedLighting = useCallback(async (levelId: string, bakedLighting: LevelBakedLighting | null): Promise<void> => {
      const lease = session.requireCurrent(session.captureReady());
      projectService.assertWritable();
      const level = levelsRef.current.find(item => item.id === levelId);
      if (!level) throw new Error('The level is no longer open.');
      const { bakedLighting: _previous, ...rest } = level;
      const next: LevelData = bakedLighting ? { ...rest, bakedLighting } : rest;
      await dbOperations.addLevel(next, lease);
      session.requireSameSession(lease);
      setWorkingState(prev => ({
          ...prev,
          levels: prev.levels.map(item => {
              if (item.id !== levelId) return item;
              const { bakedLighting: _old, ...others } = item;
              return bakedLighting ? { ...others, bakedLighting } : others;
          }),
      }));
  }, [session]);

  const hydrateProjectState = useCallback((nextLevels: LevelData[], nextObjects: LevelObject[], nextCurrentLevelId?: string | null) => {
      const selected = nextCurrentLevelId || nextLevels[0]?.id || null;
      const level = nextLevels.find((item) => item.id === selected);
      replaceWorkingState({
          levels: nextLevels,
          currentLevelId: selected,
          levelObjects: selected ? selectObjectsForLevel(nextObjects, selected) : [],
          activeLevelBlueprint: level?.blueprint || EMPTY_BLUEPRINT,
      });
      failedHeightfieldsRef.current.clear();
      failedSplatmapsRef.current.clear();
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
      addLevelObjects,
      removeLevelObject,
      removeLevelObjects,
      updateLevelObject,
      flushPendingLevelEdits,
      activeLevelBlueprint,
      updateLevelBlueprint,
      updateLevelBakedLighting,
      hydrateProjectState,
      undo,
      redo,
      canUndo,
      canRedo,
      snapshotHistory,
      getCurrentLevelId,
  });
};
