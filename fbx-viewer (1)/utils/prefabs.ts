import * as THREE from 'three';
import type { LevelComponent, LevelObject, LevelObjectType, PrefabData } from '../types';
import { collectSubtree, getWorldMatrix } from './sceneGraph';

/**
 * Pure prefab helpers. A prefab is a copy of one object subtree: the root is
 * stored without a parent at the placement origin (keeping its world rotation
 * and scale), descendants keep their local transforms and parent links.
 * Placing a prefab copies it into a level with fresh ids; every placed object
 * records the prefab and the prefab object it came from, so prefab changes can
 * reach it later (utils/prefabSync.ts).
 */
export type PrefabObject = PrefabData['objects'][number];

/** Level singletons and heightfield-backed terrain are not copied into prefabs. */
export const NON_PREFAB_TYPES: ReadonlySet<LevelObjectType> = new Set<LevelObjectType>(['terrain', 'sky_sphere', 'player_start']);

const newId = (): string => crypto.randomUUID();

/** Detached JSON copy: authored documents never share nested arrays/objects. */
const cloneDocument = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const addVec = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
  [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** First object in the subtree of `rootId` that cannot be stored in a prefab, if any. */
export const findNonPrefabObject = (objects: readonly LevelObject[], rootId: string): LevelObject | undefined =>
  collectSubtree(objects, rootId).find((object) => NON_PREFAB_TYPES.has(object.type));

/** Selected objects with no selected ancestor, in selection order (each one heads a selected subtree). */
export const getSelectionRoots = (objects: readonly LevelObject[], selectedIds: readonly string[]): LevelObject[] => {
  const index = new Map(objects.map((object) => [object.id, object]));
  const selected = new Set(selectedIds.filter((id) => index.has(id)));
  const roots: LevelObject[] = [];
  for (const id of selected) {
    const visited = new Set([id]);
    let parentId = index.get(id)!.parentId;
    let nested = false;
    while (parentId && index.has(parentId) && !visited.has(parentId)) {
      if (selected.has(parentId)) { nested = true; break; }
      visited.add(parentId);
      parentId = index.get(parentId)!.parentId;
    }
    if (!nested) roots.push(index.get(id)!);
  }
  return roots;
};

/**
 * A prefab has one root: the selection root that holds `primaryId` (else the
 * first one). `omitted` counts the other selected subtrees left out.
 */
export const pickPrefabRoot = (
  objects: readonly LevelObject[],
  selectedIds: readonly string[],
  primaryId?: string | null,
): { rootId: string | null; omitted: number } => {
  const roots = getSelectionRoots(objects, selectedIds);
  if (roots.length === 0) return { rootId: null, omitted: 0 };
  const primaryRoot = primaryId
    ? roots.find((root) => collectSubtree(objects, root.id).some((object) => object.id === primaryId))
    : undefined;
  return { rootId: (primaryRoot ?? roots[0]).id, omitted: roots.length - 1 };
};

/** Copy the subtree of `rootId` (root first) into a new prefab document. */
export const createPrefabFromSubtree = (objects: readonly LevelObject[], rootId: string, name: string): PrefabData => {
  const subtree = collectSubtree(objects, rootId);
  if (subtree.length === 0) throw new Error(`Prefab root "${rootId}" was not found.`);

  // The root keeps its world orientation and size even if it was parented.
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  getWorldMatrix(objects, rootId).decompose(position, quaternion, scale);
  const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

  const prefabObjects = subtree.map((object): PrefabObject => {
    const { levelId: _levelId, prefabId: _prefabId, prefabObjectId: _prefabObjectId, ...document } = cloneDocument(object);
    if (object.id !== rootId) return document;
    return {
      ...document,
      parentId: null,
      position: [0, 0, 0],
      rotation: [rotation.x, rotation.y, rotation.z],
      scale: [scale.x, scale.y, scale.z],
    };
  });

  return {
    id: newId(),
    name: name.trim() || subtree[0].name.trim() || 'Prefab',
    rootId,
    objects: prefabObjects,
    createdAt: Date.now(),
  };
};

/**
 * Level objects for one placement of `prefab` at `position`, parents before
 * children (root first). Every object and component gets a fresh id and parent
 * links are remapped; objects whose parent is missing hang off the root.
 */
export const instantiatePrefab = (prefab: PrefabData, levelId: string, position: [number, number, number]): LevelObject[] => {
  if (!prefab.objects.some((object) => object.id === prefab.rootId)) {
    throw new Error(`Prefab "${prefab.name}" has no root object.`);
  }
  const prefabIds = new Set(prefab.objects.map((object) => object.id));
  const normalized: LevelObject[] = prefab.objects.map((object) => {
    const document = { ...cloneDocument(object), levelId } as LevelObject;
    if (object.id === prefab.rootId) return { ...document, parentId: null };
    const parentId = object.parentId && prefabIds.has(object.parentId) ? object.parentId : prefab.rootId;
    return { ...document, parentId };
  });
  // Corrupt documents (parent cycles) would leave objects unreachable from
  // the root; attach those directly to it so every object is placed once.
  const reachable = new Set(collectSubtree(normalized, prefab.rootId).map((object) => object.id));
  const linked = normalized.map((object) => reachable.has(object.id) ? object : { ...object, parentId: prefab.rootId });
  const ordered = collectSubtree(linked, prefab.rootId);

  const ids = new Map(ordered.map((object) => [object.id, newId()]));
  return ordered.map((object): LevelObject => {
    const isRoot = object.id === prefab.rootId;
    const components = object.components?.map((component): LevelComponent => ({ ...component, id: newId() }));
    return {
      ...object,
      id: ids.get(object.id)!,
      levelId,
      parentId: isRoot ? null : ids.get(object.parentId as string)!,
      position: isRoot ? addVec(position, object.position) : object.position,
      prefabId: prefab.id,
      prefabObjectId: object.id,
      ...(components ? { components } : {}),
    };
  });
};
