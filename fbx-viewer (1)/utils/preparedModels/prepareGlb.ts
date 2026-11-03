import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { decodeDataUri, parseGltfJson, readGlb, readGlbBinary, writeGlb } from '../gltfContainer';
import { meshLodChain, meshLodReady, MIN_LOD_TRIANGLES } from '../meshLod';
import type { BlockFormat } from '../textureCompression/bcEncoder';
import type { CompressedLevelMessage, TextureKind } from '../textureCompression/textureEncoding';
import { MESH_LOD_EXTENSION, PREPARED_EXTENSION, PREPARED_MODEL_VERSION, TEXTURE_BC_EXTENSION, type PreparedKind, type PreparedMetadata } from './format';

/**
 * Turns a GLB (or a self-contained .gltf) into a prepared model (see ./format.ts) by editing its
 * JSON and rebuilding its binary chunk: what it does not need to change stays as the source has it,
 * extensions included. Runs in a worker; the image work is handed in, as a worker's to do.
 */

export interface PrepareOptions extends Omit<PreparedMetadata, 'version'> {
  kind: PreparedKind;
  textureCompression: boolean;
  meshLod: boolean;
}

/** Compresses an embedded image, or returns null to leave its texture as it is. */
export type CompressImage = (bytes: Uint8Array, mimeType: string, kind: TextureKind) => Promise<{ format: BlockFormat; levels: CompressedLevelMessage[] } | null>;

/** A model this version does not prepare; the game loads its source, and that is not a failure. */
export class UnpreparableModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpreparableModelError';
  }
}

interface View { bytes: Uint8Array; byteStride?: number; target?: number }
interface TextureInfo { index: number }
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extensions?: Record<string, unknown>;
}
interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: { indices: { bufferView: number }; values: { bufferView: number } };
}
interface Texture { source?: number; name?: string; sampler?: number; extensions?: Record<string, unknown> }
interface Image { uri?: string; bufferView?: number; mimeType?: string; name?: string }
interface Material {
  pbrMetallicRoughness?: { baseColorTexture?: TextureInfo; metallicRoughnessTexture?: TextureInfo };
  normalTexture?: TextureInfo;
  occlusionTexture?: TextureInfo;
  emissiveTexture?: TextureInfo;
  extensions?: Record<string, unknown>;
}
interface Document {
  asset?: { version?: string };
  buffers?: { uri?: string; byteLength?: number }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
  accessors?: Accessor[];
  images?: Image[];
  textures?: Texture[];
  samplers?: unknown[];
  materials?: Material[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: { mesh?: number; skin?: number; weights?: number[]; extensions?: unknown }[];
  skins?: { inverseBindMatrices?: number }[];
  animations?: { channels: { target: { path: string } }[]; samplers: { input: number; output: number }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

const COMPRESSED_GEOMETRY_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
/** Extensions of a texture that hold an image of their own, each read in place of its `source`. */
const IMAGE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'];
const COMPONENT_ARRAYS: Record<number, { new (buffer: ArrayBuffer): THREE.TypedArray; BYTES_PER_ELEMENT: number }> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const ITEM_SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const TRIANGLES = 4;
const ELEMENT_ARRAY_BUFFER = 34963;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

/** The document's buffer views as bytes, with images and buffers held as data: URIs among them. */
const readContainer = (source: ArrayBuffer, format: 'glb' | 'gltf'): { json: Document; views: View[] } => {
  let json: Document;
  let binary: Uint8Array | null = null;
  if (format === 'glb') {
    const glb = readGlb(source);
    json = glb.json as Document;
    binary = readGlbBinary(source, glb.jsonEnd);
  } else {
    json = parseGltfJson(new TextDecoder().decode(source)) as Document;
  }
  const used = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
  if (used.some((name) => COMPRESSED_GEOMETRY_EXTENSIONS.includes(name))) throw new UnpreparableModelError('Its geometry is compressed.');
  const buffers = (json.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) {
      if (index === 0 && binary) return binary;
      throw new UnpreparableModelError('It has a buffer with no data.');
    }
    if (!/^data:/i.test(buffer.uri)) throw new UnpreparableModelError('It refers to files outside itself.');
    return decodeDataUri(buffer.uri).bytes;
  });
  const views: View[] = (json.bufferViews ?? []).map((view) => {
    const start = view.byteOffset ?? 0;
    return { bytes: buffers[view.buffer ?? 0].subarray(start, start + view.byteLength), byteStride: view.byteStride, target: view.target };
  });
  for (const image of json.images ?? []) {
    if (image.uri === undefined) continue;
    if (!/^data:/i.test(image.uri)) throw new UnpreparableModelError('It refers to files outside itself.');
    const { bytes, mimeType } = decodeDataUri(image.uri);
    image.mimeType ??= mimeType;
    image.bufferView = views.push({ bytes }) - 1;
    delete image.uri;
  }
  return { json, views };
};

const addIndexAccessor = (json: Document, views: View[], indices: Uint16Array | Uint32Array): number => {
  const accessors = json.accessors ??= [];
  const bytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  views.push({ bytes, target: ELEMENT_ARRAY_BUFFER });
  accessors.push({
    bufferView: views.length - 1,
    componentType: indices instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
    count: indices.length,
    type: 'SCALAR',
  });
  return accessors.length - 1;
};

/** One accessor's elements, packed and aligned, as an attribute; null for what cannot be read directly. */
const readAccessor = (json: Document, views: View[], index: number, cache: Map<number, THREE.BufferAttribute | null>): THREE.BufferAttribute | null => {
  if (cache.has(index)) return cache.get(index) ?? null;
  const accessor = json.accessors?.[index];
  let attribute: THREE.BufferAttribute | null = null;
  const TypedArray = accessor && COMPONENT_ARRAYS[accessor.componentType];
  const itemSize = accessor && ITEM_SIZES[accessor.type];
  if (accessor && TypedArray && itemSize && accessor.bufferView !== undefined && !accessor.sparse) {
    const view = views[accessor.bufferView];
    const itemBytes = TypedArray.BYTES_PER_ELEMENT * itemSize;
    const stride = view.byteStride || itemBytes;
    const start = accessor.byteOffset ?? 0;
    const packed = new Uint8Array(accessor.count * itemBytes);
    if (stride === itemBytes) packed.set(view.bytes.subarray(start, start + packed.length));
    else for (let item = 0; item < accessor.count; item++) packed.set(view.bytes.subarray(start + item * stride, start + item * stride + itemBytes), item * itemBytes);
    attribute = new THREE.BufferAttribute(new TypedArray(packed.buffer), itemSize, accessor.normalized === true);
  }
  cache.set(index, attribute);
  return attribute;
};

/**
 * Builds each primitive's detail levels. A primitive not yet indexed (only a source GLB can have
 * one: FBX and OBJ are welded before they get here) keeps building them when it is first drawn.
 */
const addDetailLevels = async (json: Document, views: View[]): Promise<void> => {
  await meshLodReady;
  if (!MeshoptSimplifier.supported) return;
  const accessors = new Map<number, THREE.BufferAttribute | null>();
  const chains = new Map<string, { indices: number; error: number }[] | null>();
  const chainOf = (primitive: Primitive): { indices: number; error: number }[] | null => {
    const position = readAccessor(json, views, primitive.attributes.POSITION, accessors);
    const index = readAccessor(json, views, primitive.indices as number, accessors);
    if (!position || !index || index.count / 3 < MIN_LOD_TRIANGLES) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setIndex(index);
    const uv = primitive.attributes.TEXCOORD_0 === undefined ? null : readAccessor(json, views, primitive.attributes.TEXCOORD_0, accessors);
    const normal = primitive.attributes.NORMAL === undefined ? null : readAccessor(json, views, primitive.attributes.NORMAL, accessors);
    if (uv) geometry.setAttribute('uv', uv);
    if (normal) geometry.setAttribute('normal', normal);
    return meshLodChain(geometry).slice(1).map((level) => ({
      indices: addIndexAccessor(json, views, level.geometry.index!.array as Uint16Array | Uint32Array),
      error: level.error,
    }));
  };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices === undefined || primitive.attributes.POSITION === undefined || (primitive.mode ?? TRIANGLES) !== TRIANGLES) continue;
      const key = JSON.stringify([primitive.attributes, primitive.indices]);
      let chain = chains.get(key);
      if (chain === undefined) {
        chain = chainOf(primitive);
        chains.set(key, chain);
      }
      if (chain) primitive.extensions = { ...primitive.extensions, [MESH_LOD_EXTENSION]: { levels: chain } };
    }
  }
};

/** Every index under a `{ index }` in `value`: the textures a material's extensions use. */
const collectTextureIndices = (value: unknown, found: Set<number>): void => {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.index === 'number') found.add(record.index);
  Object.values(record).forEach((child) => collectTextureIndices(child, found));
};

/**
 * Swaps the textures of the compressed slots for their BC mip chains, by the rules loading uses. A
 * texture another slot of its material reads as well stays an image: a shader reading it there
 * expects all its channels, and it is compressed at load as it is today, if it can be.
 */
const compressSlotTextures = async (json: Document, views: View[], compress: CompressImage): Promise<void> => {
  const kinds = new Map<number, TextureKind>();
  const otherUses = new Set<number>();
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness;
    const slots: [TextureInfo | undefined, TextureKind][] = [
      [pbr?.baseColorTexture, 'colour'], [material.emissiveTexture, 'colour'], [material.occlusionTexture, 'data'],
      [pbr?.metallicRoughnessTexture, 'data'], [material.normalTexture, 'normal'],
    ];
    for (const [info, kind] of slots) if (info && !kinds.has(info.index)) kinds.set(info.index, kind);
    collectTextureIndices(material.extensions, otherUses);
  }
  const results = new Map<string, Awaited<ReturnType<CompressImage>>>();
  for (const [index, kind] of kinds) {
    const texture = json.textures?.[index];
    if (!texture || texture.source === undefined || texture.extensions || otherUses.has(index)) continue;
    const image = json.images?.[texture.source];
    if (image?.bufferView === undefined) continue;
    const key = `${texture.source}:${kind}`;
    if (!results.has(key)) {
      // An image that cannot be read here is left for loading to deal with.
      results.set(key, await compress(views[image.bufferView].bytes, image.mimeType ?? 'image/png', kind).catch(() => null));
    }
    const result = results.get(key);
    if (!result) continue;
    const levels = result.levels.map(({ data, width, height }) => ({ bufferView: views.push({ bytes: new Uint8Array(data) }) - 1, width, height }));
    texture.extensions = { [TEXTURE_BC_EXTENSION]: { format: result.format, levels } };
    texture.name ??= image.name;
    delete texture.source;
  }
};

/** Keeps the images some texture still reads. */
const dropUnreadImages = (json: Document): void => {
  if (!json.images) return;
  const images = json.images;
  const kept: Image[] = [];
  const remap = new Map<number, number>();
  const keep = (holder: { source?: number } | undefined): void => {
    if (holder?.source === undefined) return;
    let next = remap.get(holder.source);
    if (next === undefined) {
      next = kept.push(images[holder.source]) - 1;
      remap.set(holder.source, next);
    }
    holder.source = next;
  };
  for (const texture of json.textures ?? []) {
    keep(texture);
    for (const name of IMAGE_EXTENSIONS) keep(texture.extensions?.[name] as { source?: number } | undefined);
  }
  if (kept.length) json.images = kept;
  else delete json.images;
};

/** Leaves only what clips need: every node, as skins say which are bones, and the clips. */
const keepClipsOnly = (json: Document): void => {
  // A clip that moves blend shapes needs the meshes it moves.
  if (json.animations?.some((animation) => animation.channels.some((channel) => channel.target.path === 'weights'))) return;
  for (const node of json.nodes ?? []) {
    delete node.mesh;
    delete node.skin;
    delete node.weights;
    delete node.extensions;
  }
  delete json.meshes;
  delete json.materials;
  delete json.textures;
  delete json.images;
  delete json.samplers;
  const accessors = json.accessors ?? [];
  const kept: Accessor[] = [];
  const remap = new Map<number, number>();
  const keep = (index: number): number => {
    let next = remap.get(index);
    if (next === undefined) {
      next = kept.push(accessors[index]) - 1;
      remap.set(index, next);
    }
    return next;
  };
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = keep(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers) {
      sampler.input = keep(sampler.input);
      sampler.output = keep(sampler.output);
    }
  }
  json.accessors = kept;
};

/** Lays the views something still refers to out in one binary chunk, each on a four-byte boundary. */
const packViews = (json: Document, views: View[]): Uint8Array | null => {
  const kept: View[] = [];
  const remap = new Map<number, number>();
  const keep = (index: number): number => {
    let next = remap.get(index);
    if (next === undefined) {
      next = kept.push(views[index]) - 1;
      remap.set(index, next);
    }
    return next;
  };
  for (const accessor of json.accessors ?? []) {
    if (accessor.bufferView !== undefined) accessor.bufferView = keep(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = keep(accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = keep(accessor.sparse.values.bufferView);
    }
  }
  for (const image of json.images ?? []) if (image.bufferView !== undefined) image.bufferView = keep(image.bufferView);
  for (const texture of json.textures ?? []) {
    const bc = texture.extensions?.[TEXTURE_BC_EXTENSION] as { levels: { bufferView: number }[] } | undefined;
    if (bc) for (const level of bc.levels) level.bufferView = keep(level.bufferView);
  }
  let length = 0;
  const offsets = kept.map((view) => {
    const offset = (length + 3) & ~3;
    length = offset + view.bytes.byteLength;
    return offset;
  });
  json.bufferViews = kept.map((view, index) => ({
    buffer: 0,
    byteOffset: offsets[index],
    byteLength: view.bytes.byteLength,
    ...(view.byteStride ? { byteStride: view.byteStride } : {}),
    ...(view.target ? { target: view.target } : {}),
  }));
  if (!kept.length) {
    delete json.bufferViews;
    delete json.buffers;
    return null;
  }
  const binary = new Uint8Array(length);
  kept.forEach((view, index) => binary.set(view.bytes, offsets[index]));
  json.buffers = [{ byteLength: length }];
  return binary;
};

export const prepareGlb = async (source: ArrayBuffer, format: 'glb' | 'gltf', options: PrepareOptions, compress: CompressImage): Promise<ArrayBuffer> => {
  const { json, views } = readContainer(source, format);
  if (options.kind === 'animation') {
    keepClipsOnly(json);
  } else {
    if (options.meshLod) await addDetailLevels(json, views);
    if (options.textureCompression) await compressSlotTextures(json, views, compress);
    dropUnreadImages(json);
  }
  const metadata: PreparedMetadata = {
    version: PREPARED_MODEL_VERSION,
    sourceFormat: options.sourceFormat,
    metresPerUnit: options.metresPerUnit,
    missingTextures: options.missingTextures,
    ...(options.report ? { report: options.report } : {}),
  };
  json.extensions = { ...json.extensions, [PREPARED_EXTENSION]: metadata };
  const used = new Set(json.extensionsUsed ?? []);
  used.add(PREPARED_EXTENSION);
  if (json.textures?.some((texture) => texture.extensions?.[TEXTURE_BC_EXTENSION])) used.add(TEXTURE_BC_EXTENSION);
  if (json.meshes?.some((mesh) => mesh.primitives.some((primitive) => primitive.extensions?.[MESH_LOD_EXTENSION]))) used.add(MESH_LOD_EXTENSION);
  json.extensionsUsed = [...used];
  const binary = packViews(json, views);
  return writeGlb(json, binary);
};
