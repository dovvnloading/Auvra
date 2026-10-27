import type { LevelComponent, LevelObject, PrefabData } from '../types';
import { collectSubtree, sortByHierarchy } from './sceneGraph';
import type { PrefabObject } from './prefabs';

/**
 * LIVE PREFABS
 *
 * Every object placed from a prefab carries the prefab's id (prefabId) and the id of the prefab object
 * it was made from (prefabObjectId). The object whose prefabObjectId is the prefab's root heads one
 * instance; the instance's members are the objects under it with the same prefabId.
 *
 * When a prefab changes, each instance is brought up to date with a three-way merge against the
 * prefab's previous version: a property the instance still has at the previous prefab's value takes
 * the new value; one the instance changed (an override) is kept. The instance root keeps its own
 * placement (position, rotation, scale, parent). Prefab objects that were added appear in every
 * instance, removed ones disappear; objects a user added under an instance (no prefabObjectId) stay.
 */

/** Object fields a prefab change carries over; everything else (ids, level, parent links) is the instance's own. */
export const SYNCED_FIELDS = ['name', 'type', 'modelId', 'position', 'rotation', 'scale', 'components', 'spawnConfig', 'audioConfig', 'skyConfig'] as const;
type SyncedField = typeof SYNCED_FIELDS[number];

/** The root's placement in its level is never taken from the prefab. */
const ROOT_PLACEMENT: ReadonlySet<SyncedField> = new Set(['position', 'rotation', 'scale']);

const newId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

/** Components compared without their ids, which every instance gets fresh. */
const comparable = (field: SyncedField, value: unknown): string => {
  if (field === 'components') {
    const components = (value as LevelComponent[] | undefined) ?? [];
    return JSON.stringify(components.map(({ id: _id, ...rest }) => rest));
  }
  return JSON.stringify(value ?? null);
};

const sameValue = (field: SyncedField, a: unknown, b: unknown): boolean => comparable(field, a) === comparable(field, b);

/** New component list from the prefab, reusing the instance's component ids where the same type sits at the same index. */
const syncComponents = (current: LevelComponent[] | undefined, next: LevelComponent[] | undefined): LevelComponent[] =>
  (next ?? []).map((component, index) => {
    const existing = current?.[index];
    return { ...clone(component), id: existing && existing.type === component.type ? existing.id : newId() };
  });

/** Objects heading an instance of `prefabId` (all of them when omitted). */
export const instanceRoots = (objects: readonly LevelObject[], prefab: Pick<PrefabData, 'id' | 'rootId'>): LevelObject[] =>
  objects.filter(object => object.prefabId === prefab.id && object.prefabObjectId === prefab.rootId);

/** The instance headed by `root`: root first, then the members under it, parents before children. */
export const instanceMembers = (objects: readonly LevelObject[], root: LevelObject): LevelObject[] =>
  collectSubtree(objects, root.id).filter(object => object.id === root.id || (object.prefabId === root.prefabId && !!object.prefabObjectId));

/** The root of the instance `object` belongs to, or null when it is not part of one. */
export const findInstanceRoot = (objects: readonly LevelObject[], object: LevelObject, prefab: Pick<PrefabData, 'id' | 'rootId'>): LevelObject | null => {
  if (object.prefabId !== prefab.id || !object.prefabObjectId) return null;
  const index = new Map(objects.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (let current: LevelObject | undefined = object; current && !seen.has(current.id); current = current.parentId ? index.get(current.parentId) : undefined) {
    seen.add(current.id);
    if (current.prefabId === prefab.id && current.prefabObjectId === prefab.rootId) return current;
  }
  return null;
};

export interface InstanceSync {
  /** Changed fields per existing instance object. */
  updates: { id: string; changes: Partial<LevelObject> }[];
  /** New objects for prefab objects the instance lacks, parents before children. */
  additions: LevelObject[];
  /** Ids of members whose prefab object is gone (children before parents is the caller's job). */
  removals: string[];
}

export interface SyncOptions {
  /** Revert: take every prefab value, dropping overrides (the root still keeps its placement). */
  revert?: boolean;
}

/**
 * The edits that bring the instance headed by `root` from `previous` (the prefab it was last in step
 * with; null when unknown, which treats every difference as an override) to `next`.
 */
export const syncInstance = (
  objects: readonly LevelObject[],
  root: LevelObject,
  previous: PrefabData | null,
  next: PrefabData,
  options: SyncOptions = {},
): InstanceSync => {
  const members = instanceMembers(objects, root);
  const byPrefabObject = new Map(members.filter(member => member.prefabObjectId).map(member => [member.prefabObjectId as string, member]));
  const oldObjects = new Map((previous?.objects ?? []).map(object => [object.id, object]));
  const nextIds = new Set(next.objects.map(object => object.id));
  const result: InstanceSync = { updates: [], additions: [], removals: [] };

  // Instance object id for each prefab object id, filled in as additions are planned.
  const instanceId = new Map<string, string>([...byPrefabObject].map(([prefabObjectId, member]) => [prefabObjectId, member.id]));
  const ordered = orderPrefabObjects(next);

  for (const prefabObject of ordered) {
    const isRoot = prefabObject.id === next.rootId;
    const member = isRoot ? root : byPrefabObject.get(prefabObject.id);
    const parentId = isRoot ? root.parentId ?? null : instanceId.get(prefabObject.parentId ?? '') ?? root.id;

    if (!member) {
      const id = newId();
      instanceId.set(prefabObject.id, id);
      const { id: _id, ...document } = clone(prefabObject);
      result.additions.push({
        ...document,
        id,
        levelId: root.levelId,
        parentId,
        prefabId: next.id,
        prefabObjectId: prefabObject.id,
        ...(prefabObject.components ? { components: syncComponents(undefined, prefabObject.components) } : {}),
      } as LevelObject);
      continue;
    }

    const changes: Partial<LevelObject> = {};
    const old = oldObjects.get(prefabObject.id);
    for (const field of SYNCED_FIELDS) {
      if (isRoot && ROOT_PLACEMENT.has(field)) continue;
      const wanted = prefabObject[field as keyof PrefabObject];
      if (sameValue(field, member[field], wanted)) continue;
      const overridden = !options.revert && (!old || !sameValue(field, member[field], old[field as keyof PrefabObject]));
      if (overridden) continue;
      (changes as Record<string, unknown>)[field] = field === 'components'
        ? syncComponents(member.components, wanted as LevelComponent[] | undefined)
        : clone(wanted);
    }
    if (!isRoot && (member.parentId ?? null) !== parentId) changes.parentId = parentId;
    if (Object.keys(changes).length) result.updates.push({ id: member.id, changes });
  }

  for (const member of members) {
    if (member.id !== root.id && member.prefabObjectId && !nextIds.has(member.prefabObjectId)) result.removals.push(member.id);
  }
  return result;
};

/** The prefab's objects with the root first and every parent before its children; strays hang off the root. */
const orderPrefabObjects = (prefab: PrefabData): PrefabObject[] => {
  const ids = new Set(prefab.objects.map(object => object.id));
  const asLevel = prefab.objects.map(object => ({
    ...object,
    levelId: '',
    parentId: object.id === prefab.rootId ? null : object.parentId && ids.has(object.parentId) ? object.parentId : prefab.rootId,
  })) as LevelObject[];
  const reachable = collectSubtree(asLevel, prefab.rootId);
  const reached = new Set(reachable.map(object => object.id));
  const strays = asLevel.filter(object => !reached.has(object.id)).map(object => ({ ...object, parentId: prefab.rootId }));
  const byId = new Map(prefab.objects.map(object => [object.id, object]));
  return sortByHierarchy([...reachable, ...strays]).map(object => byId.get(object.id) ?? object);
};

/**
 * The prefab rebuilt from one instance ("Apply to prefab"): the instance's members become the prefab's
 * objects under their prefab object ids, objects a user added under the instance join it under new
 * ids, and the root is stored at the origin with no parent, keeping its rotation and scale. Returns
 * the prefab and the prefab object id now given to each added level object.
 */
export const prefabFromInstance = (
  objects: readonly LevelObject[],
  root: LevelObject,
  prefab: PrefabData,
): { prefab: PrefabData; adopted: Map<string, string> } => {
  const subtree = collectSubtree(objects, root.id).filter(object => !object.prefabId || object.prefabId === prefab.id);
  const adopted = new Map<string, string>();
  const prefabIdOf = new Map<string, string>();
  for (const object of subtree) {
    const prefabObjectId = object.id === root.id ? prefab.rootId : object.prefabObjectId ?? newId();
    if (!object.prefabObjectId && object.id !== root.id) adopted.set(object.id, prefabObjectId);
    prefabIdOf.set(object.id, prefabObjectId);
  }
  const prefabObjects = subtree.map((object): PrefabObject => {
    const { levelId: _levelId, prefabId: _prefabId, prefabObjectId: _prefabObjectId, ...document } = clone(object);
    const isRoot = object.id === root.id;
    return {
      ...document,
      id: prefabIdOf.get(object.id)!,
      parentId: isRoot ? null : prefabIdOf.get(object.parentId ?? '') ?? prefab.rootId,
      ...(isRoot ? { position: [0, 0, 0] as [number, number, number] } : {}),
    };
  });
  return { prefab: { ...prefab, objects: prefabObjects }, adopted };
};

/** The synced fields where `member` differs from its prefab object (the root's placement does not count). */
export const overriddenFields = (member: LevelObject, prefab: PrefabData): SyncedField[] => {
  const prefabObject = prefab.objects.find(object => object.id === member.prefabObjectId);
  if (!prefabObject) return [];
  const isRoot = prefabObject.id === prefab.rootId;
  return SYNCED_FIELDS.filter(field => !(isRoot && ROOT_PLACEMENT.has(field))
    && !sameValue(field, member[field], prefabObject[field as keyof PrefabObject]));
};
