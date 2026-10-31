/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { GrowableBuffer, RangeAllocator } from "./buffers";
import { reportGpu } from "./report";
import { STANDARD_SURFACE, type SurfaceKind } from "./surfaces";
import type { TextureEntry, TexturePool } from "./texturePool";

/**
 * THE MATERIAL POOL
 *
 * Each three.js material becomes a slice of one uniform buffer and a bind group over its textures. What draws
 * it is its surface kind: a piece of WGSL (surfaces.ts) saying what a pixel of that material looks like, compiled
 * into every pass that draws surfaces. Materials change their numbers freely, so a material's slice is packed again
 * every frame it is used and only sent when it differs.
 */

/** What a material asks of the fixed-function state, which is what splits one kind into several pipelines. */
export interface MaterialState {
  masked: boolean;
  transparent: boolean;
  cull: GPUCullMode;
  depthTest: boolean;
  depthWrite: boolean;
  blend: GPUBlendState | null;
  toneMapped: boolean;
  wireframe: boolean;
  /** A depth offset, in the units the pipeline takes. */
  depthBias: number;
  depthBiasSlope: number;
}

export interface MaterialEntry {
  material: THREE.Material;
  kind: SurfaceKind;
  state: MaterialState;
  /** Key of `state`, part of the pipeline's. */
  stateKey: string;
  bindGroup: GPUBindGroup;
  slot: number;
  /** Goes up when the bind group changes: draws recorded with the old one are recorded again. */
  revision: number;
  textures: (TextureEntry | null)[];
  textureRevisions: number[];
  bufferGeneration: number;
  packedFrame: number;
}

/** The uniform slice of one material, far enough apart for any device's offset alignment. */
const SLICE_BYTES = 768;
const SLICE_WORDS = SLICE_BYTES / 4;
const PACK_WORDS = 96;
const INITIAL_SLICES = 512;

const blendFactor = (factor: number, fallback: GPUBlendFactor): GPUBlendFactor => {
  switch (factor) {
    case THREE.ZeroFactor: return "zero";
    case THREE.OneFactor: return "one";
    case THREE.SrcColorFactor: return "src";
    case THREE.OneMinusSrcColorFactor: return "one-minus-src";
    case THREE.SrcAlphaFactor: return "src-alpha";
    case THREE.OneMinusSrcAlphaFactor: return "one-minus-src-alpha";
    case THREE.DstAlphaFactor: return "dst-alpha";
    case THREE.OneMinusDstAlphaFactor: return "one-minus-dst-alpha";
    case THREE.DstColorFactor: return "dst";
    case THREE.OneMinusDstColorFactor: return "one-minus-dst";
    case THREE.SrcAlphaSaturateFactor: return "src-alpha-saturated";
    default: return fallback;
  }
};

const blendOperation = (equation: number): GPUBlendOperation => {
  switch (equation) {
    case THREE.SubtractEquation: return "subtract";
    case THREE.ReverseSubtractEquation: return "reverse-subtract";
    case THREE.MinEquation: return "min";
    case THREE.MaxEquation: return "max";
    default: return "add";
  }
};

const blendOf = (material: THREE.Material): GPUBlendState | null => {
  const add = (src: GPUBlendFactor, dst: GPUBlendFactor, alphaSrc: GPUBlendFactor = src, alphaDst: GPUBlendFactor = dst): GPUBlendState => ({
    color: { srcFactor: src, dstFactor: dst, operation: "add" },
    alpha: { srcFactor: alphaSrc, dstFactor: alphaDst, operation: "add" },
  });
  switch (material.blending) {
    case THREE.NoBlending: return null;
    case THREE.AdditiveBlending: return material.premultipliedAlpha ? add("one", "one") : add("src-alpha", "one", "one", "one");
    case THREE.SubtractiveBlending: return add("zero", "one-minus-src", "zero", "one-minus-src-alpha");
    case THREE.MultiplyBlending: return add("zero", "src", "zero", "src-alpha");
    case THREE.CustomBlending:
      return {
        color: { srcFactor: blendFactor(material.blendSrc, "src-alpha"), dstFactor: blendFactor(material.blendDst, "one-minus-src-alpha"), operation: blendOperation(material.blendEquation) },
        alpha: {
          srcFactor: blendFactor(material.blendSrcAlpha ?? material.blendSrc, "one"),
          dstFactor: blendFactor(material.blendDstAlpha ?? material.blendDst, "one-minus-src-alpha"),
          operation: blendOperation(material.blendEquationAlpha ?? material.blendEquation),
        },
      };
    default:
      return material.premultipliedAlpha ? add("one", "one-minus-src-alpha") : add("src-alpha", "one-minus-src-alpha", "one", "one-minus-src-alpha");
  }
};

const stateOf = (material: THREE.Material): MaterialState => {
  const standard = material as THREE.MeshStandardMaterial;
  const cull: GPUCullMode = material.side === THREE.DoubleSide ? "none" : material.side === THREE.BackSide ? "front" : "back";
  return {
    masked: material.alphaTest > 0 || !!material.alphaHash || !!material.alphaToCoverage,
    transparent: material.transparent,
    cull,
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    blend: material.transparent ? blendOf(material) : null,
    toneMapped: material.toneMapped,
    wireframe: !!standard.wireframe,
    depthBias: material.polygonOffset ? material.polygonOffsetUnits : 0,
    depthBiasSlope: material.polygonOffset ? material.polygonOffsetFactor : 0,
  };
};

const stateKeyOf = (state: MaterialState): string => {
  const blend = state.blend ? `${state.blend.color.srcFactor},${state.blend.color.dstFactor},${state.blend.color.operation},${state.blend.alpha.srcFactor},${state.blend.alpha.dstFactor},${state.blend.alpha.operation}` : "-";
  return `${state.masked ? 1 : 0}${state.transparent ? 1 : 0}${state.depthTest ? 1 : 0}${state.depthWrite ? 1 : 0}${state.toneMapped ? 1 : 0}${state.wireframe ? 1 : 0}|${state.cull}|${blend}|${state.depthBias}|${state.depthBiasSlope}`;
};

const _pack = new Float32Array(SLICE_WORDS);
const _packWords = new Uint32Array(_pack.buffer);

/** A surface kind is chosen by these tests, the most recently registered first; the standard surface takes the rest. */
const kinds: { test: (material: THREE.Material) => boolean; kind: SurfaceKind }[] = [];

export const registerSurfaceKind = (test: (material: THREE.Material) => boolean, kind: SurfaceKind): void => {
  kinds.unshift({ test, kind });
};

const kindOf = (material: THREE.Material): SurfaceKind | null => {
  for (const entry of kinds) if (entry.test(material)) return entry.kind;
  const shader = material as THREE.ShaderMaterial;
  if (shader.isShaderMaterial || (shader as unknown as THREE.RawShaderMaterial).isRawShaderMaterial) return null;
  return STANDARD_SURFACE;
};

export class MaterialPool {
  readonly buffer: GrowableBuffer;
  private readonly slices = new RangeAllocator();
  private readonly entries = new WeakMap<THREE.Material, MaterialEntry>();
  private readonly layouts = new Map<string, GPUBindGroupLayout>();
  /** Materials no surface kind takes, each reported once. */
  readonly unsupported = new Set<string>();
  /** Each material's last packed words, compared so that a slice is only sent when it changed. */
  private readonly lastPacks = new Map<number, Float32Array>();
  /**
   * Revisions count up across the pool. A material disposed while still drawn comes back as a new entry, and the new
   * entry's revision must differ from the old one's for anything recorded over the old bind group to be recorded again.
   */
  private nextRevision = 1;

  constructor(private readonly device: GPUDevice, private readonly textures: TexturePool) {
    this.buffer = new GrowableBuffer(device, "gpu materials", GPUBufferUsage.UNIFORM, INITIAL_SLICES * SLICE_BYTES);
  }

  layoutFor(kind: SurfaceKind): GPUBindGroupLayout {
    let layout = this.layouts.get(kind.id);
    if (!layout) {
      layout = this.device.createBindGroupLayout({ label: `gpu material ${kind.id}`, entries: kind.layoutEntries() });
      this.layouts.set(kind.id, layout);
    }
    return layout;
  }

  /** The material as drawn, or null if nothing can draw it yet (it is named in `unsupported`). */
  acquire(material: THREE.Material, frame: number): MaterialEntry | null {
    let entry = this.entries.get(material) ?? null;
    if (!entry) {
      const kind = kindOf(material);
      if (!kind) {
        // Wide lines have a pass of their own (effects/fatLines.ts), which finds them in the scene.
        if (material.type !== "LineMaterial") this.unsupported.add(material.name ? `${material.type}: ${material.name}` : material.type);
        return null;
      }
      entry = this.create(material, kind);
      this.entries.set(material, entry);
      material.addEventListener("dispose", this.onDispose);
    }
    if (entry.packedFrame !== frame) {
      // A kind reads what the material holds, which can be anything: one that cannot make sense of it is that material's trouble.
      try {
        this.refresh(entry, frame);
      } catch (error) {
        reportGpu(`[gpu] material "${material.name || material.type}" could not be prepared:`, error);
        if (!entry.bindGroup) return null;
      }
    }
    return entry;
  }

  private readonly onDispose = (event: { target?: unknown }): void => {
    this.release(event.target as THREE.Material);
  };

  private create(material: THREE.Material, kind: SurfaceKind): MaterialEntry {
    const slot = this.slices.allocate(1);
    this.buffer.ensure((slot + 1) * SLICE_BYTES);
    const state = stateOf(material);
    const entry: MaterialEntry = {
      material,
      kind,
      state,
      stateKey: stateKeyOf(state),
      slot,
      revision: this.nextRevision++,
      textures: [],
      textureRevisions: [],
      bufferGeneration: -1,
      packedFrame: -1,
      bindGroup: null as unknown as GPUBindGroup,
    };
    return entry;
  }

  private refresh(entry: MaterialEntry, frame: number): void {
    entry.packedFrame = frame;
    const { material, kind } = entry;
    const state = stateOf(material);
    const stateKey = stateKeyOf(state);
    if (stateKey !== entry.stateKey) {
      entry.state = state;
      entry.stateKey = stateKey;
      entry.revision = this.nextRevision++;
    }

    const maps = kind.textures(material).map((texture) => this.textures.acquire(texture));
    let rebind = !entry.bindGroup || entry.bufferGeneration !== this.buffer.generation;
    for (let index = 0; index < maps.length; index++) {
      if (entry.textures[index] !== maps[index] || entry.textureRevisions[index] !== (maps[index]?.revision ?? 0)) rebind = true;
    }
    if (rebind) {
      entry.textures = maps;
      entry.textureRevisions = maps.map((map) => map?.revision ?? 0);
      entry.bufferGeneration = this.buffer.generation;
      entry.bindGroup = this.device.createBindGroup({
        label: `gpu material ${material.name || material.type}`,
        layout: this.layoutFor(kind),
        entries: kind.bindGroupEntries({
          uniform: { buffer: this.buffer.buffer, offset: entry.slot * SLICE_BYTES, size: PACK_WORDS * 4 },
          maps,
          pool: this.textures,
          material,
        }),
      });
      entry.revision = this.nextRevision++;
      this.lastPacks.delete(entry.slot);
    }

    _pack.fill(0);
    kind.pack(material, _pack, _packWords, maps);
    let last = this.lastPacks.get(entry.slot);
    let same = !!last;
    if (last) {
      for (let word = 0; word < PACK_WORDS; word++) {
        if (last[word] !== _pack[word] && !(Number.isNaN(last[word]) && Number.isNaN(_pack[word]))) {
          same = false;
          break;
        }
      }
    } else {
      last = new Float32Array(PACK_WORDS);
      this.lastPacks.set(entry.slot, last);
    }
    if (!same) {
      last.set(_pack.subarray(0, PACK_WORDS));
      this.buffer.write(entry.slot * SLICE_BYTES, _pack, 0, PACK_WORDS * 4);
    }
  }

  private release(material: THREE.Material): void {
    material.removeEventListener("dispose", this.onDispose);
    const entry = this.entries.get(material);
    if (!entry) return;
    this.entries.delete(material);
    this.lastPacks.delete(entry.slot);
    this.slices.release(entry.slot, 1);
  }
}
