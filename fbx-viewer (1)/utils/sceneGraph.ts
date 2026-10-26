import * as THREE from 'three';
import type { LevelObject } from '../types';

/**
 * Pure helpers for the level object transform hierarchy.
 *
 * LevelObject.position/rotation/scale are local to `parentId`. Rotation is a
 * Three.js Euler in radians with the default 'XYZ' order, matching how
 * EnvironmentScene and LevelObjectRenderer apply it. A parent id that does not
 * resolve to an object in the list (or that points at the object itself)
 * makes that object a root, so stale links never hide or detach geometry.
 */
export type LocalTransform = Pick<LevelObject, 'position' | 'rotation' | 'scale'>;

const EULER_ORDER: THREE.EulerOrder = 'XYZ';

type ObjectIndex = Map<string, LevelObject>;

const indexObjects = (objects: readonly LevelObject[]): ObjectIndex => {
  const index: ObjectIndex = new Map();
  for (const object of objects) index.set(object.id, object);
  return index;
};

/** Parent id that actually resolves in this list, or null when the object is a root. */
const resolveParentId = (index: ObjectIndex, object: LevelObject): string | null => {
  const parentId = object.parentId;
  if (!parentId || parentId === object.id || !index.has(parentId)) return null;
  return parentId;
};

const composeLocalMatrix = (object: LevelObject, target = new THREE.Matrix4()): THREE.Matrix4 => {
  const [px, py, pz] = object.position;
  const [rx, ry, rz] = object.rotation;
  const [sx, sy, sz] = object.scale;
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, EULER_ORDER));
  return target.compose(new THREE.Vector3(px, py, pz), quaternion, new THREE.Vector3(sx, sy, sz));
};

const worldMatrixFromIndex = (index: ObjectIndex, id: string | null): THREE.Matrix4 => {
  const world = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const visited = new Set<string>();
  let current = id ? index.get(id) : undefined;
  // Walk up the chain: world = root.local * ... * parent.local * object.local.
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    world.premultiply(composeLocalMatrix(current, local));
    const parentId = resolveParentId(index, current);
    current = parentId ? index.get(parentId) : undefined;
  }
  return world;
};

const toTuple = (value: { x: number; y: number; z: number }): [number, number, number] => [value.x, value.y, value.z];

/** Direct children of `parentId`; `null` returns the roots (including orphans of missing parents). */
export const getChildren = (objects: readonly LevelObject[], parentId: string | null): LevelObject[] => {
  const index = indexObjects(objects);
  return objects.filter((object) => resolveParentId(index, object) === parentId);
};

/** World matrix of `id` (identity when the object is not in the list). */
export const getWorldMatrix = (objects: readonly LevelObject[], id: string): THREE.Matrix4 =>
  worldMatrixFromIndex(indexObjects(objects), id);

/**
 * Local transform that places object `id` at `worldMatrix` once it is parented
 * to `parentId` (`null` or a missing parent means world space).
 */
export const toLocalTransform = (
  objects: readonly LevelObject[],
  id: string,
  worldMatrix: THREE.Matrix4,
  parentId: string | null,
): LocalTransform => {
  const index = indexObjects(objects);
  const effectiveParentId = parentId && parentId !== id && index.has(parentId) ? parentId : null;
  const parentInverse = worldMatrixFromIndex(index, effectiveParentId).invert();
  const local = parentInverse.multiply(worldMatrix);

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  local.decompose(position, quaternion, scale);
  const rotation = new THREE.Euler().setFromQuaternion(quaternion, EULER_ORDER);

  return {
    position: toTuple(position),
    rotation: [rotation.x, rotation.y, rotation.z],
    scale: toTuple(scale),
  };
};

/** True when parenting `childId` to `newParentId` would make it its own ancestor. */
export const wouldCreateCycle = (
  objects: readonly LevelObject[],
  childId: string,
  newParentId: string | null,
): boolean => {
  if (!newParentId) return false;
  if (newParentId === childId) return true;
  const index = indexObjects(objects);
  const visited = new Set<string>();
  let current = index.get(newParentId);
  while (current && !visited.has(current.id)) {
    if (current.id === childId) return true;
    visited.add(current.id);
    const parentId = resolveParentId(index, current);
    current = parentId ? index.get(parentId) : undefined;
  }
  return false;
};

/**
 * Copy of `childId` reparented to `newParentId` with its local transform
 * rewritten so its world transform is unchanged. A missing parent unparents
 * the object; a reparent that would create a cycle returns it unchanged.
 */
export const reparentPreservingWorld = (
  objects: readonly LevelObject[],
  childId: string,
  newParentId: string | null,
): LevelObject => {
  const index = indexObjects(objects);
  const child = index.get(childId);
  if (!child) throw new Error(`Scene graph: object "${childId}" was not found.`);
  if (wouldCreateCycle(objects, childId, newParentId)) return child;

  const parentId = newParentId && index.has(newParentId) ? newParentId : null;
  const world = worldMatrixFromIndex(index, childId);
  return {
    ...child,
    ...toLocalTransform(objects, childId, world, parentId),
    parentId,
  };
};

const buildChildMap = (objects: readonly LevelObject[], index: ObjectIndex): Map<string | null, LevelObject[]> => {
  const children = new Map<string | null, LevelObject[]>();
  for (const object of objects) {
    const parentId = resolveParentId(index, object);
    const siblings = children.get(parentId);
    if (siblings) siblings.push(object);
    else children.set(parentId, [object]);
  }
  return children;
};

const appendPreorder = (
  start: LevelObject,
  children: Map<string | null, LevelObject[]>,
  visited: Set<string>,
  out: LevelObject[],
) => {
  const stack: LevelObject[] = [start];
  while (stack.length > 0) {
    const object = stack.pop()!;
    if (visited.has(object.id)) continue;
    visited.add(object.id);
    out.push(object);
    const kids = children.get(object.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
};

/** `rootId` and all of its descendants in depth-first order, root first ([] when missing). */
export const collectSubtree = (objects: readonly LevelObject[], rootId: string): LevelObject[] => {
  const index = indexObjects(objects);
  const root = index.get(rootId);
  if (!root) return [];
  const out: LevelObject[] = [];
  appendPreorder(root, buildChildMap(objects, index), new Set(), out);
  return out;
};

/**
 * Every object exactly once, parents before children (depth-first, siblings
 * in list order). Members of a corrupt parent cycle are appended last.
 */
export const sortByHierarchy = (objects: readonly LevelObject[]): LevelObject[] => {
  const index = indexObjects(objects);
  const children = buildChildMap(objects, index);
  const visited = new Set<string>();
  const out: LevelObject[] = [];
  for (const root of children.get(null) ?? []) appendPreorder(root, children, visited, out);
  for (const object of objects) appendPreorder(object, children, visited, out);
  return out;
};
