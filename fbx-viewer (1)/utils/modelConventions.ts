import * as THREE from 'three';

/**
 * What artists say in a model file through names, as art tools and engines have long agreed:
 *
 * - `UCX_`, `UBX_`, `USP_` and `UCP_` meshes (hull, box, sphere, capsule) are collision shapes: taken
 *   out of what is drawn, and kept as hulls for physics to use.
 * - `SOCKET_` nodes are places to attach things: taken out and offered as sockets of the model.
 * - `Name_LOD1` and so on beside `Name` or `Name_LOD0`, or the children of an LOD group, are simpler
 *   versions of a mesh. Only the finest is kept, as otherwise all would be drawn at once and the
 *   engine makes simpler levels itself.
 *
 * Meshes hidden in the art tool are left out too. Neither they nor collision shapes are left out
 * when that would leave nothing to draw: such a file means something else by the name.
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
  /** In degrees, as sockets keep it. */
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

/** What a model's names say, with the model still as it was. */
export interface ModelConventionReading {
  hulls: AuthoredHull[];
  sockets: AuthoredSocket[];
  /** Nodes that go altogether: sockets, simpler levels and hidden meshes. */
  leftOut: THREE.Object3D[];
  /** Collision shapes, gone from what is drawn. None when they are all a file has to draw. */
  shapes: THREE.Object3D[];
  detailLevelsLeftOut: number;
  hiddenLeftOut: number;
}

const COLLISION_NAME = /^(UCX|UBX|USP|UCP)_/;
const SOCKET_NAME = /^SOCKET_/;
/** `Name_LOD1`, or `Name_LOD1.001` for another copy of it as Blender numbers them. */
const LEVEL_NAME = /^(.+)_LOD(\d+)(\.\d+)?$/i;

/** The name the file gives a node: loaders tidy `name` for animation paths and number repeats. */
export const fileName = (node: THREE.Object3D): string => (node.userData?.name as string | undefined) ?? node.name;

const isBone = (node: THREE.Object3D): boolean => (node as THREE.Bone).isBone === true || node.userData?.bone === true;

/** Whether anything under `node`, or itself, is a bone, which must stay wherever it is. */
const holdsBone = (node: THREE.Object3D): boolean => {
  let found = false;
  node.traverse((child) => { if (isBone(child)) found = true; });
  return found;
};

const meshesUnder = (nodes: readonly THREE.Object3D[]): Set<THREE.Object3D> => {
  const meshes = new Set<THREE.Object3D>();
  for (const node of nodes) node.traverse((child) => { if ((child as THREE.Mesh).isMesh) meshes.add(child); });
  return meshes;
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

/** Reads what `root`'s names say. `animations` are its clips: a socket follows a node they move, as it does a bone. */
export const readModelConventions = (root: THREE.Object3D, animations: readonly THREE.AnimationClip[] = []): ModelConventionReading => {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const hulls: AuthoredHull[] = [];
  const sockets: AuthoredSocket[] = [];
  const out: THREE.Object3D[] = [];
  const shapes: THREE.Object3D[] = [];
  const hidden: THREE.Object3D[] = [];
  const animated = new Set<string>();
  for (const clip of animations) for (const track of clip.tracks) animated.add(THREE.PropertyBinding.parseTrackName(track.name).nodeName);
  let detailLevelsLeftOut = 0;
  // The versions of each mesh found by name, side by side in one parent: a level alone says nothing.
  const levels = new Map<string, { parent: THREE.Object3D; plainName: string; versions: { level: number; node: THREE.Object3D }[] }>();

  const visit = (node: THREE.Object3D): void => {
    for (const child of [...node.children]) {
      const name = fileName(child);
      if (COLLISION_NAME.test(name) && !holdsBone(child)) {
        const points = cornersUnder(child, toRoot);
        if (points.length >= 12) hulls.push({ points });
        shapes.push(child);
        continue;
      }
      if (SOCKET_NAME.test(name) && !holdsBone(child)) {
        // In the space of the bone (or moving node) above it, or of the model if none.
        let above: THREE.Object3D = root;
        for (let up = child.parent; up && up !== root; up = up.parent) {
          if (isBone(up) || animated.has(up.name)) {
            above = up;
            break;
          }
        }
        const local = new THREE.Matrix4().copy(above.matrixWorld).invert().multiply(child.matrixWorld);
        const position = new THREE.Vector3();
        const turn = new THREE.Quaternion();
        local.decompose(position, turn, new THREE.Vector3());
        const euler = new THREE.Euler().setFromQuaternion(turn);
        sockets.push({
          name: name.replace(SOCKET_NAME, ''),
          boneName: above === root ? '' : above.name,
          position: position.toArray(),
          rotation: [THREE.MathUtils.radToDeg(euler.x), THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.z)],
          // A socket is a place and a direction. What a file scales it by (Blender's unit, a mirror) is no size of its own.
          scale: [1, 1, 1],
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
        // Artists often keep collision shapes and sockets in a hidden group: those still count.
        visit(child);
        hidden.push(child);
        continue;
      }
      const named = name.match(LEVEL_NAME);
      if (named && !holdsBone(child)) {
        const plainName = `${named[1]}${named[3] ?? ''}`.toLowerCase();
        const key = `${node.uuid}/${plainName}`;
        const chain = levels.get(key) ?? { parent: node, plainName, versions: [] };
        chain.versions.push({ level: Number(named[2]), node: child });
        levels.set(key, chain);
      }
      visit(child);
    }
  };
  visit(root);

  for (const { parent, plainName, versions } of levels.values()) {
    // A mesh with the plain name beside them is the finest, as many files name it.
    const plain = parent.children.some((sibling) => fileName(sibling).toLowerCase() === plainName && meshesUnder([sibling]).size > 0);
    if (!plain && versions.length < 2) continue;
    const finest = plain ? null : versions.reduce((best, version) => (version.level < best.level ? version : best));
    for (const version of versions) {
      if (version === finest) continue;
      out.push(version.node);
      detailLevelsLeftOut += 1;
    }
  }

  // A file made of nothing else means something else by the name, so what it holds stays drawn.
  const goneMeshes = meshesUnder(out);
  const shapeMeshes = meshesUnder(shapes);
  const hiddenMeshes = meshesUnder(hidden);
  const drawn = [...meshesUnder([root])].filter((mesh) => !goneMeshes.has(mesh) && !shapeMeshes.has(mesh));
  const hiddenLeftOut = drawn.some((mesh) => !hiddenMeshes.has(mesh)) ? hidden.length : 0;
  return {
    hulls,
    sockets,
    leftOut: hiddenLeftOut ? [...out, ...hidden] : out,
    shapes: drawn.length ? shapes : [],
    detailLevelsLeftOut,
    hiddenLeftOut,
  };
};

/** Reads and takes out of `root` what its names say, leaving what they say on the root for those who need it. */
export const takeModelConventions = (root: THREE.Object3D, animations: readonly THREE.AnimationClip[] = []): ModelConventions => {
  const { hulls, sockets, leftOut, shapes, detailLevelsLeftOut, hiddenLeftOut } = readModelConventions(root, animations);
  for (const node of [...leftOut, ...shapes]) {
    node.removeFromParent();
    disposeUnder(node);
  }
  if (hulls.length) root.userData[AUTHORED_COLLISION_KEY] = hulls;
  if (sockets.length) root.userData[AUTHORED_SOCKETS_KEY] = sockets;
  return { hulls: hulls.length, sockets: sockets.length, detailLevelsLeftOut, hiddenLeftOut };
};

/** The collision shapes a model's file holds, on `host` or under it, each as its corners in the space of `host`, or the one `toSpace` takes them to. */
export const authoredHullsUnder = (
  host: THREE.Object3D,
  skip: (node: THREE.Object3D) => boolean,
  toSpace?: THREE.Matrix4,
): Float32Array[] => {
  const hulls: Float32Array[] = [];
  const toHost = toSpace ?? new THREE.Matrix4().copy(host.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const visit = (node: THREE.Object3D): void => {
    const shapes = node.userData?.[AUTHORED_COLLISION_KEY] as AuthoredHull[] | undefined;
    if (Array.isArray(shapes)) {
      relative.multiplyMatrices(toHost, node.matrixWorld);
      for (const { points } of shapes) {
        const hull = new Float32Array(points.length);
        for (let at = 0; at + 2 < points.length; at += 3) {
          corner.set(points[at], points[at + 1], points[at + 2]).applyMatrix4(relative).toArray(hull, at);
        }
        hulls.push(hull);
      }
    }
    for (const child of node.children) if (!skip(child)) visit(child);
  };
  visit(host);
  return hulls;
};
