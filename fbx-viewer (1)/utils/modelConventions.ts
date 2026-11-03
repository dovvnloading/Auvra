import * as THREE from 'three';

/**
 * What artists say in a model file through names, as art tools and engines have long agreed:
 *
 * - `UCX_`, `UBX_`, `USP_` and `UCP_` meshes (hull, box, sphere, capsule) are collision shapes: taken
 *   out of what is drawn, and kept as hulls for physics to use.
 * - `SOCKET_` nodes are places to attach things: taken out and offered as sockets of the model.
 * - `Name_LOD1` and so on, or the children of an LOD group, are simpler versions of a mesh. Only the
 *   first is kept, as otherwise all would be drawn at once and the engine makes simpler levels itself.
 *
 * Meshes hidden in the art tool are left out too, unless that would leave nothing to draw.
 */

/** On a model's root: its collision shapes, as `AuthoredHull[]`. A plain array, as model copies copy it. */
export const AUTHORED_COLLISION_KEY = 'authoredCollision';
/** On a model's root: its sockets, as `AuthoredSocket[]`. */
export const AUTHORED_SOCKETS_KEY = 'authoredSockets';

export interface AuthoredHull {
  /** Corners, xyz after xyz, in the space of the model's root. */
  points: number[];
}

export interface AuthoredSocket {
  /** Its name without the `SOCKET_` before it. */
  name: string;
  /** The bone it hangs from, or empty for the model itself. */
  boneName: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface ModelConventions {
  hulls: number;
  sockets: number;
  /** Simpler versions of meshes left out. */
  detailLevelsLeftOut: number;
  /** Meshes hidden in the file left out. */
  hiddenLeftOut: number;
}

const COLLISION_NAME = /^(UCX|UBX|USP|UCP)_/i;
const SOCKET_NAME = /^SOCKET_/i;
const LEVEL_NAME = /^(.+)_LOD(\d+)$/i;

const isBone = (node: THREE.Object3D): boolean => (node as THREE.Bone).isBone === true || node.userData?.bone === true;

/** Whether anything under `node`, or itself, is a bone, which must stay wherever it is. */
const holdsBone = (node: THREE.Object3D): boolean => {
  let found = false;
  node.traverse((child) => { if (isBone(child)) found = true; });
  return found;
};

const disposeUnder = (node: THREE.Object3D): void => {
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry?.dispose();
  });
};

/** The corners of the meshes under `node`, in the space `toRoot` takes them to. */
const cornersUnder = (node: THREE.Object3D, toRoot: THREE.Matrix4): number[] => {
  const points: number[] = [];
  const corner = new THREE.Vector3();
  const relative = new THREE.Matrix4();
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const position = mesh.isMesh ? mesh.geometry?.getAttribute('position') : null;
    if (!position) return;
    relative.multiplyMatrices(toRoot, mesh.matrixWorld);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      corner.fromBufferAttribute(position, vertex).applyMatrix4(relative);
      points.push(corner.x, corner.y, corner.z);
    }
  });
  return points;
};

/** Reads and takes out of `root` what its names say, leaving what they say on the root for those who need it. */
export const takeModelConventions = (root: THREE.Object3D): ModelConventions => {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const hulls: AuthoredHull[] = [];
  const sockets: AuthoredSocket[] = [];
  const out: THREE.Object3D[] = [];
  const hidden: THREE.Object3D[] = [];
  let detailLevelsLeftOut = 0;
  // The versions of each mesh found by name: only one with a level above it says it is a chain.
  const levels = new Map<string, { level: number; node: THREE.Object3D }[]>();

  const visit = (node: THREE.Object3D): void => {
    for (const child of [...node.children]) {
      if (COLLISION_NAME.test(child.name) && !holdsBone(child)) {
        const points = cornersUnder(child, toRoot);
        if (points.length >= 12) hulls.push({ points });
        out.push(child);
        continue;
      }
      if (SOCKET_NAME.test(child.name) && !holdsBone(child)) {
        // In the space of the bone above it, or of the model if none.
        let above: THREE.Object3D = root;
        for (let up = child.parent; up && up !== root; up = up.parent) {
          if (isBone(up)) {
            above = up;
            break;
          }
        }
        const local = new THREE.Matrix4().copy(above.matrixWorld).invert().multiply(child.matrixWorld);
        const position = new THREE.Vector3();
        const turn = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        local.decompose(position, turn, scale);
        const euler = new THREE.Euler().setFromQuaternion(turn);
        sockets.push({
          name: child.name.replace(SOCKET_NAME, ''),
          boneName: above === root ? '' : above.name,
          position: position.toArray(),
          rotation: [euler.x, euler.y, euler.z],
          scale: scale.toArray(),
        });
        out.push(child);
        continue;
      }
      if (child.userData?.lodGroup && child.children.length > 1) {
        // An LOD group's first child is its finest level.
        for (const level of child.children.slice(1)) {
          if (holdsBone(level)) continue;
          out.push(level);
          detailLevelsLeftOut += 1;
        }
        visit(child.children[0]);
        continue;
      }
      if (child.userData?.hidden === true && !holdsBone(child)) {
        hidden.push(child);
        continue;
      }
      const named = child.name.match(LEVEL_NAME);
      if (named && !holdsBone(child)) {
        const stem = `${named[1]}`.toLowerCase();
        levels.set(stem, [...(levels.get(stem) ?? []), { level: Number(named[2]), node: child }]);
      }
      visit(child);
    }
  };
  visit(root);

  for (const versions of levels.values()) {
    if (versions.length < 2) continue;
    const finest = versions.reduce((best, version) => (version.level < best.level ? version : best));
    for (const version of versions) {
      if (version === finest) continue;
      out.push(version.node);
      detailLevelsLeftOut += 1;
    }
  }

  for (const node of out) {
    node.removeFromParent();
    disposeUnder(node);
  }
  // A file whose every mesh is marked hidden means something else by it, so they stay.
  let meshesLeft = 0;
  root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshesLeft += 1; });
  let hiddenMeshes = 0;
  for (const node of hidden) node.traverse((child) => { if ((child as THREE.Mesh).isMesh) hiddenMeshes += 1; });
  const hiddenLeftOut = meshesLeft > hiddenMeshes ? hidden.length : 0;
  if (hiddenLeftOut) {
    for (const node of hidden) {
      node.removeFromParent();
      disposeUnder(node);
    }
  }
  if (hulls.length) root.userData[AUTHORED_COLLISION_KEY] = hulls;
  if (sockets.length) root.userData[AUTHORED_SOCKETS_KEY] = sockets;
  return { hulls: hulls.length, sockets: sockets.length, detailLevelsLeftOut, hiddenLeftOut };
};

/** The collision shapes a model's file holds, each as its corners in the space of `host`. */
export const authoredHullsUnder = (
  host: THREE.Object3D,
  skip: (node: THREE.Object3D) => boolean,
): Float32Array[] => {
  const hulls: Float32Array[] = [];
  const toHost = new THREE.Matrix4().copy(host.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const visit = (node: THREE.Object3D): void => {
    for (const child of node.children) {
      if (skip(child)) continue;
      const shapes = child.userData?.[AUTHORED_COLLISION_KEY] as AuthoredHull[] | undefined;
      if (Array.isArray(shapes)) {
        relative.multiplyMatrices(toHost, child.matrixWorld);
        for (const { points } of shapes) {
          const hull = new Float32Array(points.length);
          for (let at = 0; at + 2 < points.length; at += 3) {
            corner.set(points[at], points[at + 1], points[at + 2]).applyMatrix4(relative).toArray(hull, at);
          }
          hulls.push(hull);
        }
      }
      visit(child);
    }
  };
  visit(host);
  return hulls;
};
