import { writeOpacity } from '../processing/opacityMaps';
import { browserImageType, encodePng, imageHasAlpha, normalsFromHeight, packMetalRough, resizedTo, sniffImageKind, type ImageKind, type Pixels } from './imagePixels';
import type { GltfPrimitive, ModelFileReport, NativeImport, SourceMaterial, SourceTexture } from './nativeImporter';

/**
 * Finishes an imported model: turns the materials the file describes into glTF materials, and writes
 * the document and its data as one GLB for the renderer thread to load. Images the file embeds go in
 * byte for byte; only what glTF keeps differently (roughness and metalness in one image, opacity in
 * the base colour's alpha) is decoded and put together here.
 */

/** Decodes an image the browser can read. Only called for images that need their pixels changed. */
export type DecodeImage = (bytes: Uint8Array, mimeType: string) => Promise<Pixels>;
/** Decodes an image the browser cannot read (TGA, TIFF) to pixels; null when it cannot be read. */
export type DecodeLegacyImage = (bytes: Uint8Array, kind: ImageKind) => Pixels | null;

export interface ImportedGlb {
  glb: ArrayBuffer;
  /** Image files the source names but does not contain, or in a format that cannot be read. */
  missingTextures: string[];
  report: ModelFileReport;
}

// ufbx's shader types. Lambert, Phong and unknown shaders are the legacy FBX material.
const SHADER_UNKNOWN = 0;
const SHADER_FBX_LAMBERT = 1;
const SHADER_FBX_PHONG = 2;
const SHADER_BLENDER_PHONG = 11;
const SHADER_WAVEFRONT_MTL = 12;
const WRAP_CLAMP = 1;

const LEGACY_SHADERS: ReadonlySet<number> = new Set([SHADER_UNKNOWN, SHADER_FBX_LAMBERT, SHADER_FBX_PHONG, SHADER_WAVEFRONT_MTL]);

const GL_REPEAT = 10497;
const GL_CLAMP_TO_EDGE = 33071;

/** Roughness when a legacy material says nothing about its shine: matte, not mirror-like. */
const DEFAULT_ROUGHNESS = 0.8;

const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/**
 * A material's colour in the linear space glTF wants. Legacy materials pick their colours by eye, in
 * sRGB; a PBR shader's, Blender's among them, are linear already.
 */
const materialColour = (values: readonly number[], shader: number): number[] => {
  const linear = LEGACY_SHADERS.has(shader);
  return values.slice(0, 3).map((value) => (linear ? srgbToLinear(value) : value));
};

const fnv1a = (bytes: Uint8Array): number => {
  let hash = 0x811c9dc5;
  // A sample is enough to tell images apart: equal hashes are confirmed byte by byte.
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return hash >>> 0;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;

interface StoredImage {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

interface TextureInfo {
  index: number;
  texCoord?: number;
  extensions?: Record<string, unknown>;
}

class ImageTable {
  readonly images: StoredImage[] = [];
  readonly textures: { source: number; sampler: number; name?: string }[] = [];
  readonly samplers: { wrapS: number; wrapT: number }[] = [];
  readonly missing = new Set<string>();
  private readonly byHash = new Map<string, number[]>();
  private readonly textureKeys = new Map<string, number>();
  private readonly pixelCache = new Map<number, Promise<Pixels | null>>();

  constructor(
    private readonly native: NativeImport,
    private readonly decode: DecodeImage,
    private readonly decodeLegacy: DecodeLegacyImage,
    private readonly externalImages: ReadonlyMap<string, Uint8Array>,
  ) {}

  source(index: number): SourceTexture | undefined {
    return this.native.textures[index];
  }

  /** A texture's encoded bytes: embedded in the file, or supplied beside it. */
  private encoded(index: number): { bytes: Uint8Array; kind: ImageKind } | null {
    const texture = this.source(index);
    if (!texture) return null;
    const bytes = this.native.textureBytes(index) ?? this.externalImages.get(baseName(texture.file).toLowerCase());
    if (!bytes) {
      if (texture.file || texture.absoluteFile) this.missing.add(baseName(texture.file || texture.absoluteFile));
      return null;
    }
    return { bytes, kind: sniffImageKind(bytes, texture.file) };
  }

  /** The image a texture reads, ready for the document; its pixels are only read if it is in a format the browser cannot read. */
  private storedImage(index: number): number | null {
    const encoded = this.encoded(index);
    const texture = this.source(index);
    if (!encoded || !texture) return null;
    const mimeType = browserImageType(encoded.kind);
    if (mimeType) return this.store(encoded.bytes, mimeType, baseName(texture.file));
    const pixels = this.decodeLegacy(encoded.bytes, encoded.kind);
    if (!pixels) {
      this.missing.add(baseName(texture.file));
      return null;
    }
    return this.store(encodePng(pixels), 'image/png', baseName(texture.file));
  }

  /** The same image embedded twice (one per material, as Blender writes them) is stored once. */
  store(bytes: Uint8Array, mimeType: string, name: string): number {
    const key = `${bytes.length}:${fnv1a(bytes)}`;
    const candidates = this.byHash.get(key) ?? [];
    for (const candidate of candidates) {
      if (sameBytes(this.images[candidate].bytes, bytes)) return candidate;
    }
    const at = this.images.push({ bytes, mimeType, name }) - 1;
    candidates.push(at);
    this.byHash.set(key, candidates);
    return at;
  }

  /** A texture's decoded pixels; one read per texture however many materials use it. */
  pixels(index: number): Promise<Pixels | null> {
    let pending = this.pixelCache.get(index);
    if (!pending) {
      pending = (async () => {
        const encoded = this.encoded(index);
        if (!encoded) return null;
        const mimeType = browserImageType(encoded.kind);
        if (mimeType) {
          try {
            return await this.decode(encoded.bytes, mimeType);
          } catch {
            this.missing.add(baseName(this.source(index)?.file ?? ''));
            return null;
          }
        }
        const pixels = this.decodeLegacy(encoded.bytes, encoded.kind);
        if (!pixels) this.missing.add(baseName(this.source(index)?.file ?? ''));
        return pixels;
      })();
      this.pixelCache.set(index, pending);
    }
    return pending;
  }

  hasAlpha(index: number): boolean {
    const encoded = this.encoded(index);
    return encoded ? imageHasAlpha(encoded.bytes, encoded.kind) : false;
  }

  /** The two textures hold the same image. */
  sameImage(a: number, b: number): boolean {
    if (a === b) return true;
    const first = this.encoded(a);
    const second = this.encoded(b);
    return !!first && !!second && sameBytes(first.bytes, second.bytes);
  }

  private sampler(texture: SourceTexture | undefined): number {
    const wrapS = texture?.wrapU === WRAP_CLAMP ? GL_CLAMP_TO_EDGE : GL_REPEAT;
    const wrapT = texture?.wrapV === WRAP_CLAMP ? GL_CLAMP_TO_EDGE : GL_REPEAT;
    const found = this.samplers.findIndex((candidate) => candidate.wrapS === wrapS && candidate.wrapT === wrapT);
    return found >= 0 ? found : this.samplers.push({ wrapS, wrapT }) - 1;
  }

  /** A glTF texture over image `image`, sampled and placed as source texture `index` asks. */
  textureOver(image: number, index: number): number {
    const key = `${image}:${this.sampler(this.source(index))}`;
    const known = this.textureKeys.get(key);
    if (known !== undefined) return known;
    const at = this.textures.push({ source: image, sampler: this.sampler(this.source(index)), name: this.images[image].name }) - 1;
    this.textureKeys.set(key, at);
    return at;
  }

  /** A glTF texture for source texture `index`, stored as it is; null when it has no image. */
  texture(index: number): number | null {
    const image = this.storedImage(index);
    return image === null ? null : this.textureOver(image, index);
  }
}

interface MaterialContext {
  table: ImageTable;
  /** The UV sets of a mesh using each material, by name. */
  uvSets: Map<number, readonly string[]>;
  usedExtensions: Set<string>;
  notes: Set<string>;
}

/** How a glTF material reads a texture: its UV set and any repeat and offset the file gives it. */
const textureInfo = (context: MaterialContext, materialIndex: number, sourceIndex: number, gltfTexture: number): TextureInfo => {
  const texture = context.table.source(sourceIndex);
  const info: TextureInfo = { index: gltfTexture };
  const set = texture?.uvSet ? context.uvSets.get(materialIndex)?.indexOf(texture.uvSet) ?? -1 : -1;
  if (set > 0) info.texCoord = set;
  if (texture?.uvOffset && texture.uvScale) {
    const [scaleU, scaleV] = texture.uvScale;
    const [offsetU, offsetV] = texture.uvOffset;
    // The file's V grows up from the bottom of the image, glTF's down from the top: v' = 1 - v.
    info.extensions = { KHR_texture_transform: { offset: [offsetU, 1 - scaleV - offsetV], scale: [scaleU, scaleV] } };
    context.usedExtensions.add('KHR_texture_transform');
  }
  return info;
};

/** Writes roughness and metalness: factors, and one packed image when the file has maps for them. */
const writeMetalRough = async (context: MaterialContext, source: SourceMaterial, materialIndex: number, pbr: Record<string, unknown>): Promise<void> => {
  const { table } = context;
  const isLegacy = LEGACY_SHADERS.has(source.shader);
  let roughnessIndex = source.roughnessTexture;
  // A shader in specular-glossiness mode, or a legacy material's shininess map: bright is shiny.
  let invert = false;
  if (source.glossinessTexture !== undefined) {
    roughnessIndex = source.glossinessTexture;
    invert = true;
  } else if (roughnessIndex !== undefined && isLegacy) {
    invert = !/rough/i.test(table.source(roughnessIndex)?.file ?? '');
  }
  const metalnessIndex = source.metalnessTexture;

  // A shader in specular-glossiness mode gives how glossy it is instead.
  const roughness = source.roughness ?? (source.glossiness != null ? 1 - source.glossiness : isLegacy ? DEFAULT_ROUGHNESS : 0.5);
  pbr.roughnessFactor = Math.min(1, Math.max(0, roughness));
  pbr.metallicFactor = Math.min(1, Math.max(0, source.metalness ?? 0));
  if (roughnessIndex === undefined && metalnessIndex === undefined) return;

  // A plain roughness map needs no packing: glTF reads roughness from its green, and a metalness
  // factor of zero leaves its blue unused, so its pixels need not even be read.
  if (roughnessIndex !== undefined && metalnessIndex === undefined && !invert && pbr.metallicFactor === 0) {
    const stored = table.texture(roughnessIndex);
    if (stored !== null) {
      pbr.roughnessFactor = 1;
      pbr.metallicRoughnessTexture = textureInfo(context, materialIndex, roughnessIndex, stored);
    }
    return;
  }

  const [roughnessPixels, metalnessPixels] = await Promise.all([
    roughnessIndex !== undefined ? table.pixels(roughnessIndex) : null,
    metalnessIndex !== undefined ? table.pixels(metalnessIndex) : null,
  ]);
  if (!roughnessPixels && !metalnessPixels) return;
  const packed = packMetalRough({ roughness: roughnessPixels, invertRoughness: invert, metalness: metalnessPixels });
  const image = table.store(encodePng(packed), 'image/png', `${source.name} metal rough`);
  if (roughnessPixels) pbr.roughnessFactor = 1;
  if (metalnessPixels) pbr.metallicFactor = 1;
  const reference = (roughnessIndex ?? metalnessIndex)!;
  pbr.metallicRoughnessTexture = textureInfo(context, materialIndex, reference, table.textureOver(image, reference));
};

/** Writes base colour and how the material is see-through. */
const writeBaseColour = async (context: MaterialContext, source: SourceMaterial, materialIndex: number, material: Record<string, any>, pbr: Record<string, unknown>): Promise<void> => {
  const { table } = context;
  const opacity = Math.min(1, Math.max(0, source.shader !== SHADER_BLENDER_PHONG && source.opacityProperty >= 0 ? source.opacityProperty : source.opacity ?? 1));
  const colourIndex = source.baseTexture;
  const opacityIndex = source.opacityTexture;

  let baseTexture: number | null = null;
  let seeThrough = opacity < 1;
  if (opacityIndex !== undefined) {
    const sameAsColour = colourIndex !== undefined && table.sameImage(colourIndex, opacityIndex) && table.hasAlpha(opacityIndex);
    if (sameAsColour) {
      baseTexture = table.texture(colourIndex!);
      seeThrough = baseTexture !== null || seeThrough;
    } else {
      // glTF keeps opacity in the base colour's alpha, so the mask goes into a copy of the colour map.
      const mask = await table.pixels(opacityIndex);
      const colour = colourIndex !== undefined ? await table.pixels(colourIndex) : null;
      if (mask) {
        const width = colour?.width ?? mask.width;
        const height = colour?.height ?? mask.height;
        const data = new Uint8ClampedArray(width * height * 4);
        if (colour) data.set(colour.data);
        else data.fill(255);
        const fitted = resizedTo(mask, width, height);
        writeOpacity(data, fitted.data instanceof Uint8ClampedArray ? fitted.data : new Uint8ClampedArray(fitted.data.buffer, fitted.data.byteOffset, fitted.data.byteLength));
        const reference = colourIndex ?? opacityIndex;
        baseTexture = table.textureOver(table.store(encodePng({ data, width, height }), 'image/png', `${source.name} colour`), reference);
        seeThrough = true;
      }
    }
  }
  if (baseTexture === null && colourIndex !== undefined) baseTexture = table.texture(colourIndex);

  // A colour map replaces the constant colour, which is usually an exporter's default (Blender's 0.8 grey). A mask alone does not.
  const colour = baseTexture !== null && colourIndex !== undefined ? [1, 1, 1] : materialColour((source.baseColor ?? [0.8, 0.8, 0.8]).map((value) => value * (source.baseFactor ?? 1)), source.shader);
  pbr.baseColorFactor = [...colour, opacity];
  if (baseTexture !== null) pbr.baseColorTexture = textureInfo(context, materialIndex, colourIndex ?? opacityIndex!, baseTexture);
  if (seeThrough) material.alphaMode = 'BLEND';
};

const writeEmission = (context: MaterialContext, source: SourceMaterial, materialIndex: number, material: Record<string, any>): void => {
  const { table } = context;
  const factor = source.emissionFactor ?? 1;
  if (factor <= 0) return;
  const texture = source.emissionTexture !== undefined ? table.texture(source.emissionTexture) : null;
  if (texture !== null) {
    material.emissiveTexture = textureInfo(context, materialIndex, source.emissionTexture!, texture);
    material.emissiveFactor = [1, 1, 1];
  } else {
    const colour = source.emission ?? [0, 0, 0];
    // Exporters often write a white emissive colour nobody asked for; only a PBR shader's is meant.
    if (LEGACY_SHADERS.has(source.shader) && colour[0] > 0.9 && colour[1] > 0.9 && colour[2] > 0.9) return;
    material.emissiveFactor = materialColour(colour, source.shader);
  }
  if (factor !== 1) {
    material.extensions = { ...material.extensions, KHR_materials_emissive_strength: { emissiveStrength: factor } };
    context.usedExtensions.add('KHR_materials_emissive_strength');
  }
};

const writeMaterial = async (context: MaterialContext, source: SourceMaterial, materialIndex: number): Promise<Record<string, unknown>> => {
  const { table } = context;
  const pbr: Record<string, unknown> = {};
  // Two-sided: an imported model's faces are often not all wound the way they should be.
  const material: Record<string, any> = { name: source.name, pbrMetallicRoughness: pbr, doubleSided: true };
  await writeBaseColour(context, source, materialIndex, material, pbr);
  await writeMetalRough(context, source, materialIndex, pbr);
  if (source.normalTexture !== undefined) {
    const texture = table.texture(source.normalTexture);
    if (texture !== null) material.normalTexture = textureInfo(context, materialIndex, source.normalTexture, texture);
  } else if (source.bumpTexture !== undefined) {
    const heights = await table.pixels(source.bumpTexture);
    if (heights) {
      const image = table.store(encodePng(normalsFromHeight(heights)), 'image/png', `${source.name} normal`);
      material.normalTexture = textureInfo(context, materialIndex, source.bumpTexture, table.textureOver(image, source.bumpTexture));
    }
  }
  if (source.occlusionTexture !== undefined) {
    const texture = table.texture(source.occlusionTexture);
    if (texture !== null) material.occlusionTexture = textureInfo(context, materialIndex, source.occlusionTexture, texture);
  }
  writeEmission(context, source, materialIndex, material);
  if (source.unlit) {
    material.extensions = { ...material.extensions, KHR_materials_unlit: {} };
    context.usedExtensions.add('KHR_materials_unlit');
  }
  return material;
};

/** Up to a multiple of four, without the bit operators that stop at two gigabytes. */
const align4 = (length: number): number => length + ((4 - (length % 4)) % 4);

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** The document and data as one GLB. */
const writeGlb = (document: unknown, binary: Uint8Array, images: readonly StoredImage[], imageOffsets: readonly number[], binaryLength: number): ArrayBuffer => {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonPadded = align4(json.length);
  const binPadded = align4(binaryLength);
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  output.set(json, 20);
  output.fill(0x20, 20 + json.length, 20 + jsonPadded);
  const binStart = 20 + jsonPadded;
  view.setUint32(binStart, binPadded, true);
  view.setUint32(binStart + 4, CHUNK_BIN, true);
  output.set(binary, binStart + 8);
  images.forEach((image, index) => output.set(image.bytes, binStart + 8 + imageOffsets[index]));
  return output.buffer;
};

const describeMissing = (missing: ReadonlySet<string>): string[] => [...missing].filter(Boolean).sort();

/** The image files a file's materials read, once each, and which of them it holds itself. */
export const describeImages = (native: Pick<NativeImport, 'materials' | 'textures'>): { file: string; embedded: boolean }[] => {
  const slots: (keyof SourceMaterial)[] = ['baseTexture', 'roughnessTexture', 'glossinessTexture', 'metalnessTexture', 'normalTexture', 'bumpTexture', 'occlusionTexture', 'emissionTexture', 'opacityTexture'];
  const images = new Map<string, { file: string; embedded: boolean }>();
  for (const material of native.materials) {
    for (const slot of slots) {
      const texture = native.textures[material[slot] as number];
      if (!texture) continue;
      const file = baseName(texture.file || texture.absoluteFile || texture.name);
      if (!file) continue;
      const known = images.get(file.toLowerCase());
      images.set(file.toLowerCase(), { file, embedded: (known?.embedded ?? false) || texture.size > 0 });
    }
  }
  return [...images.values()];
};

export interface BuildOptions {
  decode: DecodeImage;
  decodeLegacy: DecodeLegacyImage;
  /** Image files found beside the model, by lower-case file name. */
  externalImages?: ReadonlyMap<string, Uint8Array>;
}

/** The finished model. The native import's memory is read from, so close it after this. */
export const buildImportedGlb = async (native: NativeImport, options: BuildOptions): Promise<ImportedGlb> => {
  const { document } = native;
  const table = new ImageTable(native, options.decode, options.decodeLegacy, options.externalImages ?? new Map());
  const usedExtensions = new Set<string>();
  const notes = new Set<string>();

  const uvSets = new Map<number, readonly string[]>();
  document.meshes?.forEach((mesh, meshIndex) => {
    for (const primitive of mesh.primitives) {
      if (primitive.material !== undefined && !uvSets.has(primitive.material)) uvSets.set(primitive.material, native.meshUvSets[meshIndex] ?? []);
    }
  });

  const context: MaterialContext = { table, uvSets, usedExtensions, notes };
  const materials: Record<string, unknown>[] = [];
  // A material no mesh draws (one only a left-out mesh used) keeps its place, without its images.
  for (const [index, source] of native.materials.entries()) {
    materials.push(uvSets.has(index) ? await writeMaterial(context, source, index) : { name: source.name });
  }

  // A primitive the file gives no material is matte grey, not glTF's default metal.
  const untextured = (primitive: GltfPrimitive): boolean => primitive.material === undefined;
  if (document.meshes?.some((mesh) => mesh.primitives.some(untextured))) {
    const fallback = materials.push({
      name: 'Default',
      pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: DEFAULT_ROUGHNESS },
      doubleSided: true,
    }) - 1;
    for (const mesh of document.meshes) for (const primitive of mesh.primitives) if (untextured(primitive)) primitive.material = fallback;
  }

  // Images go in the binary buffer after the geometry and animation.
  const nativeBinary = native.binary();
  const bufferViews = [...document.bufferViews];
  const imageOffsets: number[] = [];
  let binaryLength = nativeBinary.length;
  const images = table.images.map((image) => {
    binaryLength = align4(binaryLength);
    imageOffsets.push(binaryLength);
    const bufferView = bufferViews.push({ buffer: 0, byteOffset: binaryLength, byteLength: image.bytes.length }) - 1;
    binaryLength += image.bytes.length;
    return { bufferView, mimeType: image.mimeType, name: image.name };
  });

  const missingTextures = describeMissing(table.missing);
  const report: ModelFileReport = {
    ...native.report,
    warnings: [
      ...native.report.warnings,
      ...notes,
      ...(missingTextures.length ? [`Not found in the file: ${missingTextures.join(', ')}.`] : []),
    ],
  };

  const [scene, ...otherScenes] = document.scenes;
  const finished = {
    asset: { version: '2.0', generator: 'Auvra model importer' },
    scene: 0,
    scenes: [{
      ...scene,
      // UVs were flipped to start top-left, so override textures load with flipY off (utils/materialOverrides.ts).
      extras: { ...scene.extras, uvOriginTopLeft: true },
    }, ...otherScenes],
    nodes: document.nodes,
    ...(document.meshes ? { meshes: document.meshes } : {}),
    ...(document.skins ? { skins: document.skins } : {}),
    ...(document.animations ? { animations: document.animations } : {}),
    accessors: document.accessors,
    bufferViews,
    buffers: [{ byteLength: align4(binaryLength) }],
    ...(materials.length ? { materials } : {}),
    ...(table.textures.length ? { textures: table.textures, samplers: table.samplers, images } : {}),
    ...(usedExtensions.size ? { extensionsUsed: [...usedExtensions] } : {}),
  };
  return {
    glb: writeGlb(finished, nativeBinary, table.images, imageOffsets, binaryLength),
    missingTextures,
    report,
  };
};
