/** Backend-neutral rendering contracts.
 *
 * This module deliberately contains no browser, graphics API, or engine
 * implementation types. Backends translate these immutable descriptions at
 * their boundary.
 */

export type ResourceKind =
  | "buffer"
  | "texture"
  | "sampler"
  | "shader"
  | "pipeline"
  | "pass"
  | "synchronization"
  | "capability-query";

/** An opaque slot/generation token. A released token must never become valid again. */
export type ResourceHandle<K extends ResourceKind = ResourceKind> = string & {
  readonly __auvraResourceKind: K;
  readonly __auvraResourceHandle: unique symbol;
};

const HANDLE_PATTERN = /^(buffer|texture|sampler|shader|pipeline|pass|synchronization|capability-query):([1-9][0-9]*):([1-9][0-9]*)$/;

export function makeResourceHandle<K extends ResourceKind>(kind: K, slot: number, generation: number): ResourceHandle<K> {
  if (!Number.isSafeInteger(slot) || slot < 1 || !Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError("Resource handle slot and generation must be positive safe integers");
  }
  return `${kind}:${slot}:${generation}` as ResourceHandle<K>;
}

export function isResourceHandle(value: unknown, expectedKind?: ResourceKind): value is ResourceHandle {
  if (typeof value !== "string") return false;
  const match = HANDLE_PATTERN.exec(value);
  return Boolean(match && (!expectedKind || match[1] === expectedKind));
}

export interface GenerationalHandlePool<K extends ResourceKind> {
  readonly kind: K;
  allocate(): ResourceHandle<K>;
  release(handle: ResourceHandle<K>): boolean;
  isLive(handle: ResourceHandle<K>): boolean;
}

/** Small deterministic allocator for backend-owned tables. */
export class HandlePool<K extends ResourceKind> implements GenerationalHandlePool<K> {
  readonly kind: K;
  private nextSlot = 1;
  private readonly generations = new Map<number, number>();
  private readonly freeSlots: number[] = [];
  private readonly live = new Set<number>();

  constructor(kind: K) { this.kind = kind; }

  allocate(): ResourceHandle<K> {
    const slot = this.freeSlots.length ? this.freeSlots.shift()! : this.nextSlot++;
    const generation = this.generations.get(slot) ?? 1;
    this.generations.set(slot, generation);
    this.live.add(slot);
    return makeResourceHandle(this.kind, slot, generation);
  }

  release(handle: ResourceHandle<K>): boolean {
    const parsed = parseResourceHandle(handle);
    if (!parsed || parsed.kind !== this.kind || !this.live.has(parsed.slot) || this.currentGeneration(parsed.slot) !== parsed.generation) return false;
    this.live.delete(parsed.slot);
    this.generations.set(parsed.slot, parsed.generation + 1);
    const index = this.freeSlots.findIndex((slot) => slot > parsed.slot);
    if (index < 0) this.freeSlots.push(parsed.slot); else this.freeSlots.splice(index, 0, parsed.slot);
    return true;
  }

  isLive(handle: ResourceHandle<K>): boolean {
    const parsed = parseResourceHandle(handle);
    return Boolean(parsed && parsed.kind === this.kind && this.live.has(parsed.slot) && this.currentGeneration(parsed.slot) === parsed.generation);
  }

  private currentGeneration(slot: number): number { return this.generations.get(slot) ?? 0; }
}

export interface ParsedResourceHandle { readonly kind: ResourceKind; readonly slot: number; readonly generation: number; }
export function parseResourceHandle(handle: ResourceHandle | string): ParsedResourceHandle | null {
  const match = HANDLE_PATTERN.exec(handle);
  return match ? { kind: match[1] as ResourceKind, slot: Number(match[2]), generation: Number(match[3]) } : null;
}

export type BufferUsage = "vertex" | "index" | "uniform" | "storage" | "indirect" | "readback";
export type TextureDimension = "2d" | "2d-array" | "3d" | "cube";
export type TextureFormat = "rgba8-unorm" | "rgba8-srgb" | "rgba16-float" | "rgba32-float" | "r8-unorm" | "depth24-plus" | "depth32-float";
export type ShaderStage = "vertex" | "fragment" | "compute";
export type PrimitiveTopology = "point-list" | "line-list" | "line-strip" | "triangle-list" | "triangle-strip";
export type LoadOperation = "load" | "clear";
export type StoreOperation = "store" | "discard";

export interface BufferDescriptor {
  readonly label?: string;
  readonly size: number;
  readonly usage: ReadonlyArray<BufferUsage>;
  readonly mappedAtCreation?: boolean;
}
export interface TextureDescriptor {
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  readonly depthOrLayers?: number;
  readonly mipLevels?: number;
  readonly samples?: number;
  readonly dimension: TextureDimension;
  readonly format: TextureFormat;
  readonly usage: ReadonlyArray<"sampled" | "storage" | "color-attachment" | "depth-attachment" | "copy-source" | "copy-destination">;
}
export interface SamplerDescriptor {
  readonly label?: string;
  readonly minFilter: "nearest" | "linear";
  readonly magFilter: "nearest" | "linear";
  readonly mipmapFilter: "nearest" | "linear";
  readonly addressModeU: "clamp" | "repeat" | "mirror";
  readonly addressModeV: "clamp" | "repeat" | "mirror";
  readonly addressModeW?: "clamp" | "repeat" | "mirror";
}
export interface ShaderDescriptor {
  readonly label?: string;
  readonly stages: ReadonlyArray<ShaderStage>;
  readonly source: string;
  readonly sourceLanguage: "wgsl" | "glsl-compatibility";
  /** Content hash of the canonical source plus the variant key. */
  readonly contentHash: string;
  readonly bindingManifest: ReadonlyArray<ShaderBinding>;
  readonly vertexLayout: VertexLayout;
  readonly entryPoints: Readonly<Partial<Record<ShaderStage, string>>>;
  readonly variantKey: string;
}

export type ShaderBindingKind = "uniform-buffer" | "storage-buffer" | "sampled-texture" | "storage-texture" | "sampler";
export interface ShaderBinding {
  readonly name: string;
  readonly group: number;
  readonly binding: number;
  readonly kind: ShaderBindingKind;
  readonly visibility: ReadonlyArray<ShaderStage>;
}
export type VertexAttributeFormat = "float32" | "float32x2" | "float32x3" | "float32x4" | "uint32" | "uint32x2" | "uint32x3" | "uint32x4";
export interface VertexAttribute {
  readonly semantic: string;
  readonly location: number;
  readonly format: VertexAttributeFormat;
  readonly offset: number;
}
export interface VertexLayout {
  readonly stride: number;
  readonly stepMode: "vertex" | "instance";
  readonly attributes: ReadonlyArray<VertexAttribute>;
}
export interface PipelineDescriptor {
  readonly label?: string;
  readonly shader: ResourceHandle<"shader">;
  readonly topology: PrimitiveTopology;
  readonly colorFormats: ReadonlyArray<TextureFormat>;
  readonly depthFormat?: TextureFormat;
  readonly sampleCount?: number;
  readonly layoutKey: string;
}
export interface PassDescriptor {
  readonly label: string;
  readonly pipeline?: ResourceHandle<"pipeline">;
  readonly reads: ReadonlyArray<ResourceHandle>;
  readonly writes: ReadonlyArray<ResourceHandle>;
  readonly sideEffects?: boolean;
}
export interface SynchronizationDescriptor {
  readonly label?: string;
  readonly resources: ReadonlyArray<ResourceHandle>;
  readonly from: "none" | "read" | "write" | "readwrite";
  readonly to: "read" | "write" | "readwrite";
}
export interface CapabilityQueryDescriptor {
  readonly label?: string;
  readonly feature: string;
  readonly minimum?: number;
}
