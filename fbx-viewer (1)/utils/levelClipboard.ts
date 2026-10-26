import type { LevelObject, LevelObjectType } from '../types';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { collectSubtree, getWorldMatrix, sortByHierarchy, toLocalTransform, type LocalTransform } from './sceneGraph';

/**
 * Copy, paste and duplicate of World Editor objects as whole subtrees.
 *
 * A copy is a detached snapshot (original ids and parent links, plus each
 * object's world transform). Pasting gives every object a fresh id, remaps
 * links inside the copied set, keeps a link to a parent that exists in the
 * target level, and otherwise places the object in world space.
 */

/** A level holds at most one of each of these, so they are never copied. */
const SINGLETON_TYPES: ReadonlySet<LevelObjectType> = new Set<LevelObjectType>(['terrain', 'sky_sphere', 'player_start']);

const CLIPBOARD_FORMAT = 'auvra.level-objects/1';
const STORAGE_KEY = 'auvra.levelClipboard';

export type ClipboardObject = Omit<LevelObject, 'levelId'>;

export interface LevelClipboardPayload {
  format: typeof CLIPBOARD_FORMAT;
  /** Copied objects, parents before children, with their original ids and parent links. */
  objects: ClipboardObject[];
  /** World transform of every copied object, used where its parent is not available. */
  world: Record<string, LocalTransform>;
}

export interface PasteOptions {
  /** Level the copies are created in. */
  levelId: string;
  /** Objects already in that level; a copied link to one of them is kept. */
  levelObjects: readonly LevelObject[];
  /** Added to the (local) position of every pasted root. */
  offset?: [number, number, number];
  /** False leaves an object out (e.g. a prop whose model is missing); its children are pasted in world space. */
  canPlace?: (object: ClipboardObject) => boolean;
  createId?: () => string;
}

export interface PastedObjects {
  /** New objects for the level, parents before children. */
  objects: LevelObject[];
  /** Ids of the pasted objects whose parent was not pasted with them. */
  rootIds: string[];
}

const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Snapshot of `ids` and all their descendants (singletons excluded), or null when nothing is copyable. */
export const copyLevelObjects = (objects: readonly LevelObject[], ids: readonly string[]): LevelClipboardPayload | null => {
  const picked = new Map<string, LevelObject>();
  for (const id of ids) {
    for (const object of collectSubtree(objects, id)) {
      if (!SINGLETON_TYPES.has(object.type)) picked.set(object.id, object);
    }
  }
  if (picked.size === 0) return null;

  const world: Record<string, LocalTransform> = {};
  const copies = sortByHierarchy([...picked.values()]).map((object) => {
    world[object.id] = toLocalTransform(objects, object.id, getWorldMatrix(objects, object.id), null);
    const copy: Partial<LevelObject> = { ...object };
    delete copy.levelId;
    return copy as ClipboardObject;
  });
  return cloneJson({ format: CLIPBOARD_FORMAT, objects: copies, world });
};

/** Fresh-id copies of the clipboard objects for `options.levelId`. */
export const pasteLevelObjects = (payload: LevelClipboardPayload, options: PasteOptions): PastedObjects => {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const [dx, dy, dz] = options.offset ?? [0, 0, 0];
  const inLevel = new Set(options.levelObjects.map((object) => object.id));
  const copied = new Set(payload.objects.map((object) => object.id));
  const placeable = payload.objects.filter((object) => options.canPlace?.(object) ?? true);
  const idMap = new Map(placeable.map((object) => [object.id, createId()] as const));

  const objects: LevelObject[] = [];
  const rootIds: string[] = [];
  for (const source of placeable) {
    const copy: LevelObject = { ...cloneJson(source), id: idMap.get(source.id)!, levelId: options.levelId };
    const parentId = source.parentId ?? null;
    if (parentId && idMap.has(parentId)) {
      copy.parentId = idMap.get(parentId)!;
    } else {
      if (parentId && (copied.has(parentId) || !inLevel.has(parentId))) {
        // The parent was left out or is not in this level: keep the object where it was in the world.
        Object.assign(copy, cloneJson(payload.world[source.id] ?? {}));
        delete copy.parentId;
      }
      copy.position = [copy.position[0] + dx, copy.position[1] + dy, copy.position[2] + dz];
      rootIds.push(copy.id);
    }
    if (copy.components) copy.components = copy.components.map((component) => ({ ...component, id: createId() }));
    objects.push(copy);
  }
  return { objects, rootIds };
};

const isVector3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/** The payload in `raw` (a JSON string or parsed value), or null when it is not a level clipboard. */
export const parseLevelClipboard = (raw: unknown): LevelClipboardPayload | null => {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  const payload = value as Partial<LevelClipboardPayload> | null;
  if (!payload || payload.format !== CLIPBOARD_FORMAT || !Array.isArray(payload.objects)) return null;
  if (!payload.world || typeof payload.world !== 'object') return null;
  const valid = payload.objects.every((object) => !!object && typeof object.id === 'string' && typeof object.type === 'string'
    && typeof object.modelId === 'string' && isVector3(object.position) && isVector3(object.rotation) && isVector3(object.scale));
  return valid && payload.objects.length > 0 ? payload as LevelClipboardPayload : null;
};

let memoryClipboard: LevelClipboardPayload | null = null;

/** Store a copy in memory and, when it fits, in localStorage so it survives a reload. */
export const writeLevelClipboard = (payload: LevelClipboardPayload): void => {
  memoryClipboard = payload;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    frontendDiagnostics.failure('level_clipboard_store_failed', error);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  }
};

/** The last copy from this session, else the one left in localStorage. */
export const readLevelClipboard = (): LevelClipboardPayload | null => {
  if (memoryClipboard) return memoryClipboard;
  try {
    return parseLevelClipboard(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
};

/** Test hook: forget the in-memory copy. */
export const resetLevelClipboardMemory = (): void => { memoryClipboard = null; };
