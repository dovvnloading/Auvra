import * as THREE from 'three';
import { forgetMeshLodChain } from '../meshLod';
import { decodeSkinPaint, NO_PAINTED_BONE, type SkinPaint, type SkinPaintReference } from './skinPaintFile';
import { VertexPlaces } from './vertexPlaces';

/**
 * A model's skinned meshes as one skin, however its file divided them: each has its own geometry space
 * and its own list of bones, and can be given a bone it did not have.
 */

/** A geometry of the model, and the mesh that wears it. */
export interface SkinPart {
  mesh: THREE.SkinnedMesh;
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  /** Corners as the geometry holds them, three per vertex. */
  local: Float32Array;
  /** Where each vertex stands with the skeleton at rest, in the space all the parts share, three per vertex. */
  rest: Float32Array;
  /** From the geometry to that shared space. */
  toRest: THREE.Matrix4;
  /** Each vertex's bones, as positions on this mesh's skeleton, four per vertex. */
  joints: Uint16Array | Uint32Array;
  /** Their shares, four per vertex. */
  shares: Float32Array;
  slots: Map<THREE.Object3D, number>;
}

export interface ModelSkin {
  root: THREE.Object3D;
  parts: SkinPart[];
  /** Vertices closer than this, at rest, are one point of the surface. */
  tolerance: number;
  /** From the shared space to each bone's own, with the skeleton at rest. */
  frames: Map<THREE.Object3D, THREE.Matrix4>;
}

/** Of the model's size: a tenth of a millimetre on a person. */
const WELD_SHARE = 1 / 16384;

const skinAttributes = (geometry: THREE.BufferGeometry): { joints: THREE.BufferAttribute; shares: THREE.BufferAttribute } => ({
  joints: geometry.getAttribute('skinIndex') as THREE.BufferAttribute,
  shares: geometry.getAttribute('skinWeight') as THREE.BufferAttribute,
});

/**
 * Gives a geometry's skin arrays of its own, if they are not: an attribute sharing a buffer with others
 * cannot be written alone, and shares rounded to bytes would not add up to one once changed.
 */
const makeSkinWritable = (geometry: THREE.BufferGeometry): void => {
  const { joints, shares } = skinAttributes(geometry);
  const isShared = (attribute: THREE.BufferAttribute): boolean => Boolean((attribute as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
  const jointsFit = !isShared(joints) && (joints.array instanceof Uint16Array || joints.array instanceof Uint32Array);
  const sharesFit = !isShared(shares) && shares.array instanceof Float32Array && !shares.normalized;
  if (jointsFit && sharesFit) return;
  // What the graphics card holds goes first, while the geometry still names what is leaving.
  geometry.dispose();
  const copied = (attribute: THREE.BufferAttribute, into: Uint16Array | Float32Array): Uint16Array | Float32Array => {
    for (let vertex = 0; vertex < attribute.count; vertex += 1) {
      for (let slot = 0; slot < 4; slot += 1) into[vertex * 4 + slot] = attribute.getComponent(vertex, slot);
    }
    return into;
  };
  if (!jointsFit) geometry.setAttribute('skinIndex', new THREE.BufferAttribute(copied(joints, new Uint16Array(joints.count * 4)), 4));
  if (!sharesFit) geometry.setAttribute('skinWeight', new THREE.BufferAttribute(copied(shares, new Float32Array(shares.count * 4)), 4));
  forgetMeshLodChain(geometry);
};

const invertible = (matrix: THREE.Matrix4): boolean => Math.abs(matrix.determinant()) > 1e-12;

/** Reads a model's skinned meshes. Meshes wearing one geometry count once. */
export const readModelSkin = (root: THREE.Object3D): ModelSkin => {
  root.updateWorldMatrix(true, true);
  const meshes: THREE.SkinnedMesh[] = [];
  const wornBy = new Map<THREE.BufferGeometry, THREE.SkinnedMesh>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.geometry.getAttribute('skinIndex') || !mesh.geometry.getAttribute('skinWeight')) return;
    const other = wornBy.get(mesh.geometry);
    if (other?.skeleton === mesh.skeleton) return;
    // On another skeleton the same numbers can come to mean other bones, so it cannot share what is written.
    if (other) mesh.geometry = mesh.geometry.clone();
    wornBy.set(mesh.geometry, mesh);
    meshes.push(mesh);
  });

  const parts: SkinPart[] = meshes.map((mesh) => {
    const { geometry } = mesh;
    makeSkinWritable(geometry);
    const { joints, shares } = skinAttributes(geometry);
    const position = geometry.getAttribute('position');
    const local = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      local[vertex * 3] = position.getX(vertex);
      local[vertex * 3 + 1] = position.getY(vertex);
      local[vertex * 3 + 2] = position.getZ(vertex);
    }
    return {
      mesh,
      geometry,
      vertexCount: position.count,
      local,
      rest: local,
      toRest: new THREE.Matrix4(),
      joints: joints.array as Uint16Array | Uint32Array,
      shares: shares.array as Float32Array,
      slots: new Map(mesh.skeleton.bones.map((bone, slot) => [bone as THREE.Object3D, slot])),
    };
  });

  // The space they share is the largest mesh's. The others find their way to it through a bone they have in common.
  const frames = new Map<THREE.Object3D, THREE.Matrix4>();
  const settle = (part: SkinPart, toRest: THREE.Matrix4): void => {
    part.toRest.copy(toRest);
    const fromRest = toRest.clone().invert();
    part.mesh.skeleton.bones.forEach((bone, slot) => {
      if (!frames.has(bone)) frames.set(bone, part.mesh.skeleton.boneInverses[slot].clone().multiply(part.mesh.bindMatrix).multiply(fromRest));
    });
  };
  const waiting = [...parts].sort((a, b) => b.vertexCount - a.vertexCount);
  while (waiting.length) {
    let found = -1;
    let toRest: THREE.Matrix4 | null = null;
    for (let at = 0; at < waiting.length && !toRest; at += 1) {
      const { mesh } = waiting[at];
      const slot = mesh.skeleton.bones.findIndex((bone) => {
        const frame = frames.get(bone);
        return frame && invertible(frame);
      });
      if (slot >= 0) {
        found = at;
        toRest = frames.get(mesh.skeleton.bones[slot])!.clone().invert().multiply(mesh.skeleton.boneInverses[slot]).multiply(mesh.bindMatrix);
      }
    }
    // One with no bone in common: a mesh's own bind space is where its file placed it.
    if (!toRest) {
      found = 0;
      toRest = waiting[0].mesh.bindMatrix.clone();
    }
    settle(waiting[found], toRest);
    waiting.splice(found, 1);
  }

  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const part of parts) {
    const rest = new Float32Array(part.local.length);
    for (let vertex = 0; vertex < part.vertexCount; vertex += 1) {
      point.fromArray(part.local, vertex * 3).applyMatrix4(part.toRest).toArray(rest, vertex * 3);
      bounds.expandByPoint(point);
    }
    part.rest = rest;
  }
  const size = bounds.isEmpty() ? 0 : bounds.getSize(point).toArray().reduce((longest, side) => Math.max(longest, side), 0);
  return { root, parts, tolerance: Math.max(size * WELD_SHARE, 1e-9), frames };
};

/** A bone's frame. One no mesh is bound to takes its place from the nearest that is above it, as they stand now. */
const frameOf = (skin: ModelSkin, bone: THREE.Object3D): THREE.Matrix4 => {
  const known = skin.frames.get(bone);
  if (known) return known;
  let from: THREE.Object3D | null = bone.parent;
  while (from && !skin.frames.has(from)) from = from.parent;
  from ??= skin.frames.keys().next().value ?? null;
  bone.updateWorldMatrix(true, false);
  const frame = bone.matrixWorld.clone().invert();
  if (from) {
    from.updateWorldMatrix(true, false);
    frame.multiply(from.matrixWorld).multiply(skin.frames.get(from)!);
  }
  skin.frames.set(bone, frame);
  return frame;
};

/** Where a bone is on a part's skeleton. A bone it does not have is added, and leaves the mesh where it stood. */
export const boneSlot = (skin: ModelSkin, part: SkinPart, bone: THREE.Object3D): number => {
  const known = part.slots.get(bone);
  if (known !== undefined) return known;
  const { skeleton, bindMatrix } = part.mesh;
  let slot = skeleton.bones.indexOf(bone as THREE.Bone);
  if (slot < 0) {
    slot = skeleton.bones.length;
    skeleton.bones.push(bone as THREE.Bone);
    skeleton.boneInverses.push(frameOf(skin, bone).clone().multiply(part.toRest).multiply(bindMatrix.clone().invert()));
    // Its matrices and their texture were made for one bone fewer.
    skeleton.init();
    skeleton.dispose();
  }
  part.slots.set(bone, slot);
  return slot;
};

export const markSkinChanged = (part: SkinPart): void => {
  const { joints, shares } = skinAttributes(part.geometry);
  joints.needsUpdate = true;
  shares.needsUpdate = true;
  // A detail level made from a geometry with no index holds its own copy.
  if (!part.geometry.index) forgetMeshLodChain(part.geometry);
};

/** What a geometry's file said, kept by the editor so painting can be taken back. */
export interface FileWeights {
  joints: Uint16Array | Uint32Array;
  shares: Float32Array;
  /** Vertices paint had changed when the model was read. */
  painted: Uint8Array;
}

const fileWeights = new WeakMap<THREE.BufferGeometry, FileWeights>();

/** A part's file weights. Read as they are now if nothing has been painted on it yet. */
export const fileWeightsOf = (part: SkinPart): FileWeights => {
  let found = fileWeights.get(part.geometry);
  if (!found) {
    found = { joints: part.joints.slice(), shares: part.shares.slice(), painted: new Uint8Array(part.vertexCount) };
    fileWeights.set(part.geometry, found);
  }
  return found;
};

/**
 * Puts painted weights on a model: on every vertex standing where one was painted, with the shares of
 * the bones the model still has. Returns how many of the places painted were found.
 */
export const applySkinPaint = (root: THREE.Object3D, paint: SkinPaint, options: { keepFileWeights?: boolean } = {}): number => {
  const skin = readModelSkin(root);
  const count = paint.places.length / 3;
  const places = new VertexPlaces(skin.tolerance);
  for (let place = 0; place < count; place += 1) places.add(paint.places[place * 3], paint.places[place * 3 + 1], paint.places[place * 3 + 2]);
  const named = new Map<string, THREE.Object3D>();
  root.traverse((node) => { if (node.name && !named.has(node.name)) named.set(node.name, node); });
  const bones = paint.boneNames.map((name) => named.get(name) ?? null);
  const found = new Uint8Array(count);
  for (const part of skin.parts) {
    const painted = options.keepFileWeights ? fileWeightsOf(part).painted : null;
    let changed = false;
    for (let vertex = 0; vertex < part.vertexCount; vertex += 1) {
      const place = places.find(part.rest[vertex * 3], part.rest[vertex * 3 + 1], part.rest[vertex * 3 + 2]);
      if (place < 0) continue;
      let total = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        const bone = paint.bones[place * 4 + slot];
        if (bone !== NO_PAINTED_BONE && bones[bone]) total += paint.shares[place * 4 + slot];
      }
      if (!(total > 0)) continue;
      for (let slot = 0; slot < 4; slot += 1) {
        const bone = paint.bones[place * 4 + slot];
        const object = bone !== NO_PAINTED_BONE ? bones[bone] : null;
        part.joints[vertex * 4 + slot] = object ? boneSlot(skin, part, object) : 0;
        part.shares[vertex * 4 + slot] = object ? paint.shares[place * 4 + slot] / total : 0;
      }
      if (painted) painted[vertex] = 1;
      found[place] = 1;
      changed = true;
    }
    if (changed) markSkinChanged(part);
  }
  return found.reduce((sum, one) => sum + one, 0);
};

/** Reads a model's painted weights and puts them on it. Returns the places painted and how many were found. */
export const loadSkinPaint = async (
  root: THREE.Object3D,
  reference: SkinPaintReference,
  readBytes: (assetId: string) => Promise<ArrayBuffer>,
  options: { keepFileWeights?: boolean } = {},
): Promise<{ painted: number; found: number }> => {
  const paint = decodeSkinPaint(await readBytes(reference.assetId));
  return { painted: paint.places.length / 3, found: applySkinPaint(root, paint, options) };
};
