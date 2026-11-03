import * as THREE from 'three';
import type { RigJoint } from './bodySkeleton';
import type { PartWeights, SkinnedPart } from './skinWeights';

/**
 * Writes a model and a skeleton fitted to it as one rigged GLB. The source's materials and images are
 * kept byte for byte. Its geometry is written out afresh, baked into the model's space, as a skinned
 * mesh takes its place from its bones and not from the nodes above it. The model's units stay as they
 * were, and with them the root's scale and all that is placed against it: sockets and attachments.
 */

interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  weights?: number[];
  extras?: unknown;
  extensions?: Record<string, unknown>;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extras?: unknown;
  extensions?: Record<string, unknown>;
}

interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
  weights?: number[];
  extras?: unknown;
  extensions?: Record<string, unknown>;
}

interface GltfImage { bufferView?: number; uri?: string; mimeType?: string; name?: string }
interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number; name?: string }

export interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[]; extras?: unknown; name?: string }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  images?: GltfImage[];
  bufferViews?: GltfBufferView[];
  accessors?: unknown[];
  buffers?: { byteLength: number; uri?: string }[];
  skins?: unknown[];
  animations?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  asset?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Extensions for the geometry and animation this writes afresh without them. */
const REWRITTEN_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_mesh_gpu_instancing']);

/** glTF's names for the attributes three.js loads. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  uv: 'TEXCOORD_0',
  uv1: 'TEXCOORD_1',
  uv2: 'TEXCOORD_2',
  uv3: 'TEXCOORD_3',
  color: 'COLOR_0',
};

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const ACCESSOR_TYPE: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4' };

/** A primitive of the source loaded and baked into the model's space. */
export interface RigPrimitive extends SkinnedPart {
  /** The node of the source holding it, and its mesh and primitive there. */
  node: number;
  mesh: number;
  primitive: number;
  /** The geometry as loaded, for its other attributes. */
  geometry: THREE.BufferGeometry;
  /** From the geometry's own space to the model's. */
  matrix: THREE.Matrix4;
}

/** A collision shape of the source, which goes along unskinned, for the model to keep it. */
export interface RigShape {
  name: string;
  positions: Float32Array;
  indices: Uint32Array | null;
}

export interface RigSource {
  json: GltfJson;
  /** The bytes of a buffer view of the source. */
  viewBytes: (view: number) => Uint8Array;
  /** Metres per unit of the model's space. */
  metresPerUnit: number;
}

/** All the triangles of `primitives` as a flat list of corners, for measuring the body. */
export const trianglesOf = (primitives: readonly SkinnedPart[]): Float32Array => {
  let corners = 0;
  for (const part of primitives) corners += part.indices ? part.indices.length : part.positions.length / 3;
  const soup = new Float32Array(corners * 3);
  let at = 0;
  for (const part of primitives) {
    const count = part.indices ? part.indices.length : part.positions.length / 3;
    for (let corner = 0; corner < count; corner += 1) {
      const vertex = part.indices ? part.indices[corner] : corner;
      soup[at] = part.positions[vertex * 3];
      soup[at + 1] = part.positions[vertex * 3 + 1];
      soup[at + 2] = part.positions[vertex * 3 + 2];
      at += 3;
    }
  }
  return soup;
};

/** Reads a mesh's geometry into the model's space. */
export const bakedPositions = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): Float32Array => {
  const attribute = geometry.getAttribute('position');
  const out = new Float32Array(attribute.count * 3);
  const point = new THREE.Vector3();
  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    point.fromBufferAttribute(attribute, vertex).applyMatrix4(matrix);
    out[vertex * 3] = point.x;
    out[vertex * 3 + 1] = point.y;
    out[vertex * 3 + 2] = point.z;
  }
  return out;
};

/** Collects everything binary the document will hold. */
class BinaryChunk {
  private parts: Uint8Array[] = [];
  private length = 0;
  readonly views: GltfBufferView[] = [];
  readonly accessors: unknown[] = [];

  view(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return this.views.length - 1;
  }

  accessor(array: Float32Array | Uint16Array | Uint32Array, componentType: number, size: number, target?: number, extra: Record<string, unknown> = {}): number {
    const view = this.view(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), target);
    this.accessors.push({ bufferView: view, componentType, count: array.length / size, type: ACCESSOR_TYPE[size], ...extra });
    return this.accessors.length - 1;
  }

  bytes(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

/** Corners of a three.js attribute as floats, however they are stored. */
const floatsOf = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array => {
  const out = new Float32Array(attribute.count * attribute.itemSize);
  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    for (let component = 0; component < attribute.itemSize; component += 1) {
      out[vertex * attribute.itemSize + component] = attribute.getComponent(vertex, component);
    }
  }
  return out;
};

const boundsOf = (positions: Float32Array): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (positions[i + axis] < min[axis]) min[axis] = positions[i + axis];
      if (positions[i + axis] > max[axis]) max[axis] = positions[i + axis];
    }
  }
  return { min, max };
};

/** Makes a GLB from its document and binary chunk. */
const packGlb = (json: GltfJson, binary: Uint8Array): ArrayBuffer => {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (text.byteLength + 3) & ~3;
  const binaryLength = binary.byteLength;
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(text, 20);
  output.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binaryLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  output.set(binary, 28 + jsonLength);
  return output.buffer;
};

/**
 * The GLB of `source` with its geometry skinned to `joints`. `primitives` and `weights` are in step.
 * Everything but the geometry and animation of the source stays as it was.
 */
export const buildRiggedGlb = (
  source: RigSource,
  primitives: readonly RigPrimitive[],
  joints: readonly RigJoint[],
  weights: readonly PartWeights[],
  shapes: readonly RigShape[] = [],
): ArrayBuffer => {
  const json: GltfJson = structuredClone(source.json);
  const chunk = new BinaryChunk();

  // Images stay byte for byte.
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = chunk.view(source.viewBytes(image.bufferView));
  }

  // Each node with a mesh becomes a node at the top of the scene with a mesh of its own.
  const meshes: GltfMesh[] = [];
  const nodes = json.nodes ?? [];
  const meshNodes = new Map<number, number>();
  const skinnedNodes: GltfNode[] = [];
  primitives.forEach((part, partIndex) => {
    const sourceMesh = source.json.meshes![part.mesh];
    const sourcePrimitive = sourceMesh.primitives[part.primitive];
    let meshIndex = meshNodes.get(part.node);
    if (meshIndex === undefined) {
      meshIndex = meshes.length;
      meshNodes.set(part.node, meshIndex);
      meshes.push({
        ...(sourceMesh.name ? { name: sourceMesh.name } : {}),
        primitives: [],
        ...(sourceMesh.weights ? { weights: sourceMesh.weights } : {}),
        ...(sourceMesh.extras ? { extras: sourceMesh.extras } : {}),
      });
      const sourceNode = nodes[part.node];
      // What is skinned is drawn, whatever the file said of its node.
      const { hidden: _hidden, lodGroup: _lodGroup, ...extras } = (sourceNode.extras ?? {}) as Record<string, unknown>;
      skinnedNodes.push({
        ...(sourceNode.name ? { name: sourceNode.name } : {}),
        mesh: meshIndex,
        ...(sourceNode.weights ? { weights: sourceNode.weights } : {}),
        ...(Object.keys(extras).length ? { extras } : {}),
      });
    }

    const matrix = part.matrix;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const linear = new THREE.Matrix3().setFromMatrix4(matrix);
    const mirrored = matrix.determinant() < 0;
    const geometry = part.geometry;
    const attributes: Record<string, number> = {};

    const positions = bakedPositions(geometry, matrix);
    attributes.POSITION = chunk.accessor(positions, FLOAT, 3, ARRAY_BUFFER, boundsOf(positions));
    const normal = geometry.getAttribute('normal');
    if (normal) {
      const values = floatsOf(normal);
      const direction = new THREE.Vector3();
      for (let i = 0; i < values.length; i += 3) {
        direction.fromArray(values, i).applyMatrix3(normalMatrix).normalize().toArray(values, i);
      }
      attributes.NORMAL = chunk.accessor(values, FLOAT, 3, ARRAY_BUFFER);
    }
    const tangent = geometry.getAttribute('tangent');
    if (tangent) {
      const values = floatsOf(tangent);
      const direction = new THREE.Vector3();
      for (let i = 0; i < values.length; i += 4) {
        direction.fromArray(values, i).applyMatrix3(linear).normalize().toArray(values, i);
        if (mirrored) values[i + 3] = -values[i + 3];
      }
      attributes.TANGENT = chunk.accessor(values, FLOAT, 4, ARRAY_BUFFER);
    }
    for (const [name, glTFName] of Object.entries(ATTRIBUTE_NAMES)) {
      const attribute = geometry.getAttribute(name);
      if (attribute) attributes[glTFName] = chunk.accessor(floatsOf(attribute), FLOAT, attribute.itemSize, ARRAY_BUFFER);
    }
    attributes.JOINTS_0 = chunk.accessor(weights[partIndex].joints.slice(), UNSIGNED_SHORT, 4, ARRAY_BUFFER);
    attributes.WEIGHTS_0 = chunk.accessor(weights[partIndex].weights.slice(), FLOAT, 4, ARRAY_BUFFER);

    const primitive: GltfPrimitive = {
      attributes,
      ...(sourcePrimitive.material !== undefined ? { material: sourcePrimitive.material } : {}),
      ...(sourcePrimitive.extras ? { extras: sourcePrimitive.extras } : {}),
    };
    const kept = Object.fromEntries(Object.entries(sourcePrimitive.extensions ?? {}).filter(([name]) => !REWRITTEN_EXTENSIONS.has(name)));
    if (Object.keys(kept).length) primitive.extensions = kept;
    const index = geometry.index;
    if (index) {
      const corners = new Uint32Array(index.count);
      for (let corner = 0; corner < index.count; corner += 1) corners[corner] = index.getX(corner);
      // A mirroring turn flips which way triangles wind.
      if (mirrored) {
        for (let corner = 0; corner + 2 < corners.length; corner += 3) {
          const b = corners[corner + 1];
          corners[corner + 1] = corners[corner + 2];
          corners[corner + 2] = b;
        }
      }
      primitive.indices = chunk.accessor(corners, UNSIGNED_INT, 1, ELEMENT_ARRAY_BUFFER);
    } else if (mirrored) {
      // Without an index the only way to flip winding is to write one.
      const count = positions.length / 3;
      const corners = new Uint32Array(count);
      for (let corner = 0; corner + 2 < count; corner += 3) {
        corners[corner] = corner;
        corners[corner + 1] = corner + 2;
        corners[corner + 2] = corner + 1;
      }
      primitive.indices = chunk.accessor(corners, UNSIGNED_INT, 1, ELEMENT_ARRAY_BUFFER);
    }
    // Blend shapes are offsets: they turn and scale with the mesh, but do not move with it.
    const morphPositions = geometry.morphAttributes.position;
    const morphNormals = geometry.morphAttributes.normal;
    if (morphPositions?.length) {
      const direction = new THREE.Vector3();
      // Unlike a normal, these are not made unit length after: the normal matrix's inverse scale comes off here.
      const normalScale = Math.cbrt(Math.abs(matrix.determinant()));
      primitive.targets = morphPositions.map((attribute, target) => {
        const values = floatsOf(attribute);
        for (let i = 0; i < values.length; i += 3) direction.fromArray(values, i).applyMatrix3(linear).toArray(values, i);
        const out: Record<string, number> = { POSITION: chunk.accessor(values, FLOAT, 3, ARRAY_BUFFER, boundsOf(values)) };
        const normals = morphNormals?.[target];
        if (normals) {
          const normalValues = floatsOf(normals);
          for (let i = 0; i < normalValues.length; i += 3) direction.fromArray(normalValues, i).applyMatrix3(normalMatrix).multiplyScalar(normalScale).toArray(normalValues, i);
          out.NORMAL = chunk.accessor(normalValues, FLOAT, 3, ARRAY_BUFFER);
        }
        return out;
      });
    }
    meshes[meshIndex].primitives.push(primitive);
  });

  const shapeNodes: GltfNode[] = shapes.map((shape) => {
    const primitive: GltfPrimitive = { attributes: { POSITION: chunk.accessor(shape.positions, FLOAT, 3, ARRAY_BUFFER, boundsOf(shape.positions)) } };
    if (shape.indices) primitive.indices = chunk.accessor(shape.indices, UNSIGNED_INT, 1, ELEMENT_ARRAY_BUFFER);
    return { name: shape.name, mesh: meshes.push({ primitives: [primitive] }) - 1 };
  });

  // The source's nodes stay as empty places, and the skinned ones go on top. An empty keeps no name
  // its mesh has taken with it, as loaders number a name used twice.
  for (const node of nodes) {
    if (node.mesh !== undefined) delete node.name;
    delete node.mesh;
    delete node.skin;
    delete node.weights;
    if (node.extensions) {
      delete node.extensions.EXT_mesh_gpu_instancing;
      if (!Object.keys(node.extensions).length) delete node.extensions;
    }
    if (node.extras && typeof node.extras === 'object') {
      const { hidden: _hidden, lodGroup: _lodGroup, ...extras } = node.extras as Record<string, unknown>;
      if (Object.keys(extras).length) node.extras = extras; else delete node.extras;
    }
  }
  const scene = (json.scenes ??= [{}])[json.scene ?? 0] ?? (json.scenes[0] ??= {});
  if (source.metresPerUnit !== 1) scene.extras = { ...(scene.extras as object | undefined), sourceMetresPerUnit: source.metresPerUnit };
  const sceneNodes = (scene.nodes ??= []);
  const skinnedStart = nodes.length;
  nodes.push(...skinnedNodes, ...shapeNodes);
  sceneNodes.push(...skinnedNodes.map((_, at) => skinnedStart + at), ...shapeNodes.map((_, at) => skinnedStart + skinnedNodes.length + at));

  // The joints, each placed against its parent.
  const jointStart = nodes.length;
  const worldTurns = joints.map((joint) => new THREE.Quaternion(...joint.rotation));
  const worldPlaces = joints.map((joint) => new THREE.Vector3(...joint.position));
  joints.forEach((joint, index) => {
    const node: GltfNode = { name: joint.name };
    if (joint.parent >= 0) {
      const parentTurn = worldTurns[joint.parent].clone().invert();
      node.translation = worldPlaces[index].clone().sub(worldPlaces[joint.parent]).applyQuaternion(parentTurn).toArray();
      const local = parentTurn.multiply(worldTurns[index]);
      node.rotation = [local.x, local.y, local.z, local.w];
    } else {
      node.translation = worldPlaces[index].toArray();
      node.rotation = [worldTurns[index].x, worldTurns[index].y, worldTurns[index].z, worldTurns[index].w];
    }
    nodes.push(node);
  });
  joints.forEach((joint, index) => {
    if (joint.parent >= 0) (nodes[jointStart + joint.parent].children ??= []).push(jointStart + index);
    else sceneNodes.push(jointStart + index);
  });
  const inverseBinds = new Float32Array(joints.length * 16);
  const bind = new THREE.Matrix4();
  const scaleOne = new THREE.Vector3(1, 1, 1);
  joints.forEach((_, index) => {
    bind.compose(worldPlaces[index], worldTurns[index], scaleOne).invert();
    bind.toArray(inverseBinds, index * 16);
  });
  const hips = joints.findIndex((joint) => joint.parent < 0);
  json.skins = [{
    name: 'Armature',
    joints: joints.map((_, index) => jointStart + index),
    inverseBindMatrices: chunk.accessor(inverseBinds, FLOAT, 16),
    skeleton: jointStart + Math.max(0, hips),
  }];
  for (const node of skinnedNodes) node.skin = 0;

  json.nodes = nodes;
  json.meshes = meshes;
  json.accessors = chunk.accessors;
  json.bufferViews = chunk.views;
  delete json.animations;
  const used = (json.extensionsUsed ?? []).filter((name) => !REWRITTEN_EXTENSIONS.has(name));
  if (used.length) json.extensionsUsed = used; else delete json.extensionsUsed;
  const required = (json.extensionsRequired ?? []).filter((name) => !REWRITTEN_EXTENSIONS.has(name));
  if (required.length) json.extensionsRequired = required; else delete json.extensionsRequired;
  const binary = chunk.bytes();
  json.buffers = [{ byteLength: binary.byteLength }];
  return packGlb(json, binary);
};
