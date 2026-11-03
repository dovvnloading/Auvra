import { fbxTakeOrder, inTakeOrder } from './clipOrder';

/**
 * The native half of the model importer: ufbx compiled to WebAssembly (vendor/fbxImporter). It reads
 * an FBX or OBJ file and hands back a glTF document without materials, its binary data, and the
 * file's materials and textures as the file describes them. See ./importedModel.ts for the rest.
 */

/** What the file holds, for the import dialog and the import report. */
export interface ModelFileReport {
  format: 'fbx' | 'obj' | 'gltf';
  version: number;
  ascii: boolean;
  creator: string;
  application: string;
  upAxis: string;
  frontAxis: string;
  /** Metres per unit the file says it is authored in; 0 or less when it does not say. */
  metresPerUnit: number;
  framesPerSecond: number;
  meshes: number;
  triangles: number;
  vertices: number;
  skinnedMeshes: number;
  blendShapes: number;
  meshesWithPolygons: number;
  meshesWithoutUvs: number;
  meshesWithoutNormals: number;
  /** The model's bounds at its default pose, in file units; absent with no geometry. */
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  /** The same, leaving out `looseMeshes`. */
  boundsWithoutLooseMin?: [number, number, number];
  boundsWithoutLooseMax?: [number, number, number];
  /** Meshes in a rigged file that the skeleton does not move (Meshy's rigged characters come with a stray sphere). */
  looseMeshes: { name: string; triangles: number }[];
  bones: number;
  boneNames: string[];
  collisionMeshes: number;
  sockets: number;
  lodGroups: number;
  cameras: number;
  lights: number;
  materials: number;
  /** What the import built; zero when only inspecting. */
  outputVertices: number;
  outputTriangles: number;
  tangentsGenerated: number;
  tangentsFromFile: number;
  partsWithoutTangents: number;
  maxInfluences: number;
  verticesOverInfluenceLimit: number;
  verticesWithoutWeights: number;
  clips: ModelFileClip[];
  warnings: string[];
  /** The image files its materials read, and which of them the file holds itself. */
  images?: { file: string; embedded: boolean }[];
}

export interface ModelFileClip {
  name: string;
  duration: number;
  start: number;
  layers: number;
  tracks?: number;
  keys?: number;
}

export interface SourceMaterial {
  name: string;
  shader: number;
  baseColor: number[] | null;
  baseFactor: number | null;
  baseTexture?: number;
  roughness: number | null;
  roughnessTexture?: number;
  glossiness: number | null;
  glossinessTexture?: number;
  metalness: number | null;
  metalnessTexture?: number;
  normalTexture?: number;
  bumpTexture?: number;
  occlusionTexture?: number;
  emission: number[] | null;
  emissionFactor: number | null;
  emissionTexture?: number;
  opacity: number | null;
  opacityTexture?: number;
  /** The FBX "Opacity" property; negative when the file has none. */
  opacityProperty: number;
  unlit: boolean;
  doubleSided: boolean;
}

export interface SourceTexture {
  name: string;
  /** The image file the texture names, relative to the model where it can be. */
  file: string;
  absoluteFile: string;
  /** Where its embedded bytes are in the importer's memory, and how many; size 0 when not embedded. */
  pointer: number;
  size: number;
  uvSet: string;
  wrapU: number;
  wrapV: number;
  uvOffset?: [number, number];
  uvScale?: [number, number];
}

export interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
  targets?: Record<string, number>[];
}

/** The parts of a glTF document the native importer writes; the rest are added by ./importedModel.ts. */
export interface NativeDocument {
  scene: number;
  scenes: { nodes: number[]; extras?: Record<string, unknown> }[];
  nodes: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[]; extras?: Record<string, unknown> }[];
  skins?: unknown[];
  animations?: { name?: string; channels: unknown[]; samplers: unknown[] }[];
  accessors: unknown[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[];
}

export interface NativeImportResult {
  report: ModelFileReport;
  materials: SourceMaterial[];
  textures: SourceTexture[];
  /** The UV sets of each glTF mesh, by name, for a material to say which one a texture reads. */
  meshUvSets: string[][];
  document: NativeDocument;
}

export interface NativeImportOptions {
  /** Only describe the file: nothing is built, which is much quicker. */
  inspect?: boolean;
  /** The file is a Wavefront OBJ rather than an FBX. */
  obj?: boolean;
  animation?: boolean;
  morphTargets?: boolean;
  tangents?: boolean;
  /** Ignore the file's normals and work them out with `smoothingAngle`. */
  recomputeNormals?: boolean;
  skin?: boolean;
  /** False for an animation-only import: nodes and clips only. */
  meshes?: boolean;
  /** False to leave out meshes outside the skeleton of a rigged file. */
  looseMeshes?: boolean;
  /** Takes to leave out, by their names in the file. */
  excludedClips?: readonly string[];
  /** Keys per second animation is resampled at where it must be; defaults to the file's rate, at least 30. */
  sampleRate?: number;
  /** Largest change a dropped key may make to a track's value; 0 keeps every key. */
  keyThreshold?: number;
  /** Where faces meet at more than this angle in degrees the edge is hard, when normals are worked out. */
  smoothingAngle?: number;
}

/** Tracks at this error hold no visible difference on any skeleton seen (under 0.01 degrees, 0.0001 units). */
export const DEFAULT_KEY_THRESHOLD = 1e-5;

const FLAG_INSPECT = 1;
const FLAG_NO_ANIMATION = 2;
const FLAG_NO_MORPHS = 4;
const FLAG_NO_TANGENTS = 8;
const FLAG_OBJ = 16;
const FLAG_RECOMPUTE_NORMALS = 32;
const FLAG_NO_SKIN = 64;
const FLAG_NO_MESHES = 128;
const FLAG_NO_LOOSE_MESHES = 512;

/**
 * Gives a take the file leaves unnamed a name of its own: takes are ticked, left out and cut by name,
 * and an empty one can be none of those. Named in order, so it is the same one each time the file is read.
 */
const nameUnnamedTakes = (takes: { name?: string }[]): void => {
  const used = new Set(takes.map((take) => take.name));
  let number = 0;
  for (const take of takes) {
    if (take.name) continue;
    do number += 1; while (used.has(`Take ${number}`));
    take.name = `Take ${number}`;
  }
};

interface ImporterExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  fbx_malloc: (size: number) => number;
  fbx_close: () => void;
  fbx_import: (data: number, size: number, name: number, nameLength: number, flags: number, sampleRate: number, keyThreshold: number, smoothingAngle: number) => number;
  fbx_error_pointer: () => number;
  fbx_error_length: () => number;
  fbx_json_pointer: () => number;
  fbx_json_length: () => number;
  fbx_binary_pointer: () => number;
  fbx_binary_length: () => number;
}

/** An import's results, valid until `close`: the bytes are read from the importer's memory. */
export interface NativeImport extends NativeImportResult {
  binary: () => Uint8Array;
  /** A texture's embedded bytes, or null when the file only names it. */
  textureBytes: (index: number) => Uint8Array | null;
  close: () => void;
}

/** Instantiates the importer. Each instance holds one import, and is dropped with its memory after it. */
export const instantiateImporter = async (module: WebAssembly.Module): Promise<ImporterExports> => {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as ImporterExports;
  exports._initialize?.();
  return exports;
};

const toFlags = (options: NativeImportOptions): number =>
  (options.inspect ? FLAG_INSPECT : 0)
  | (options.obj ? FLAG_OBJ : 0)
  | (options.animation === false ? FLAG_NO_ANIMATION : 0)
  | (options.morphTargets === false ? FLAG_NO_MORPHS : 0)
  | (options.tangents === false ? FLAG_NO_TANGENTS : 0)
  | (options.recomputeNormals ? FLAG_RECOMPUTE_NORMALS : 0)
  | (options.skin === false ? FLAG_NO_SKIN : 0)
  | (options.meshes === false ? FLAG_NO_MESHES : 0)
  | (options.looseMeshes === false ? FLAG_NO_LOOSE_MESHES : 0);

/** Reads `source` into the importer. Running out of memory traps, which surfaces as a clear error. */
export const runNativeImport = (importer: ImporterExports, source: ArrayBuffer | Uint8Array, fileName: string, options: NativeImportOptions = {}): NativeImport => {
  const memory = (): ArrayBuffer => importer.memory.buffer;
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  try {
    const nameBytes = new TextEncoder().encode(fileName);
    const namePointer = importer.fbx_malloc(nameBytes.length + 1);
    new Uint8Array(memory(), namePointer, nameBytes.length).set(nameBytes);
    const dataPointer = importer.fbx_malloc(bytes.length);
    if (!dataPointer) throw new RangeError('out of memory');
    new Uint8Array(memory(), dataPointer, bytes.length).set(bytes);
    const ok = importer.fbx_import(
      dataPointer, bytes.length, namePointer, nameBytes.length, toFlags(options),
      options.sampleRate ?? 0, options.keyThreshold ?? DEFAULT_KEY_THRESHOLD, options.smoothingAngle ?? 0,
    );
    if (!ok) {
      const reason = new TextDecoder().decode(new Uint8Array(memory(), importer.fbx_error_pointer(), importer.fbx_error_length()));
      throw new Error(`The file could not be read: ${reason || 'it is not a valid model file'}.`);
    }
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
      throw new Error('This model is too large to import: the importer ran out of memory.');
    }
    throw error;
  }
  const text = new TextDecoder().decode(new Uint8Array(memory(), importer.fbx_json_pointer(), importer.fbx_json_length()));
  const result = JSON.parse(text) as NativeImportResult;
  if (!options.obj && result.report.clips.length > 1) {
    const order = fbxTakeOrder(bytes);
    result.report.clips = inTakeOrder(result.report.clips, order);
    if (result.document.animations) result.document.animations = inTakeOrder(result.document.animations, order);
  }
  nameUnnamedTakes(result.report.clips);
  if (result.document.animations) nameUnnamedTakes(result.document.animations);
  // The report keeps every take, so the dialog can offer them again.
  if (options.excludedClips?.length && result.document.animations) {
    const excluded = new Set(options.excludedClips);
    result.document.animations = result.document.animations.filter((clip) => !excluded.has(clip.name ?? ''));
    if (!result.document.animations.length) delete result.document.animations;
  }
  return {
    ...result,
    binary: () => new Uint8Array(memory(), importer.fbx_binary_pointer(), importer.fbx_binary_length()),
    textureBytes: (index) => {
      const texture = result.textures[index];
      return texture && texture.size > 0 ? new Uint8Array(memory(), texture.pointer, texture.size) : null;
    },
    close: () => importer.fbx_close(),
  };
};
