/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { GrowableBuffer, RangeAllocator } from "../buffers";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import { VERTEX_WGSL } from "../geometryPool";
import type { PosedMesh } from "../gpuScene";

/**
 * THE SKINNING PASS
 *
 * Poses every skinned or morphing mesh on the graphics card, before anything is drawn. A posed mesh has its own run of
 * the vertex table (GpuScene makes it); a compute job per mesh reads the vertices it was made from, applies its morph
 * targets and then its bones just as three's skinning chunks do, and writes the result to that run in the same layout,
 * so that everything drawn after this sees an ordinary mesh. What the run held a moment ago is kept as last frame's
 * positions, for motion.
 *
 * Skeletons shared by several meshes are updated and sent once. A mesh whose bones and morph weights have stopped
 * changing is posed once more, so that its previous positions catch up, and then left alone until they change.
 */

const JOB_BYTES = 176;
const WORKGROUP = 64;
const BONE_BYTES = 64;
const BONE_WORDS = BONE_BYTES / 4;
const INITIAL_BONES = 1024;
const INITIAL_MORPH_WEIGHTS = 256;
const MORPH_WEIGHT_WORDS = 2;
/** Frames a skeleton may go unused before its place in the bone table is given back. */
const FORGET_SKELETON_AFTER = 300;
const SWEEP_EVERY = 64;

// Where things lie in a job, past the two matrices.
const AT_BIND_MATRICES = 32;
const AT_SOURCE_BASE = 32;
const AT_POSED_BASE = 33;
const AT_PREVIOUS_BASE = 34;
const AT_VERTEX_COUNT = 35;
const AT_SKIN_BASE = 36;
const AT_BONE_BASE = 37;
const AT_MORPH_BASE = 38;
const AT_WEIGHT_FIRST = 39;
const AT_WEIGHT_COUNT = 40;
const AT_FLAGS = 41;

const JOB_SKINNED = 1;
const JOB_FIRST = 2;

const SKINNING_WGSL = /* wgsl */ `
${VERTEX_WGSL}
struct Job {
  bindMatrix: mat4x4f,
  bindMatrixInverse: mat4x4f,
  sourceBase: u32,
  posedBase: u32,
  previousBase: u32,
  vertexCount: u32,
  skinBase: u32,
  boneBase: u32,
  morphBase: u32,
  weightFirst: u32,
  weightCount: u32,
  flags: u32,
}
struct MorphWeight { morphTarget: u32, weight: f32 }

const JOB_SKINNED = ${JOB_SKINNED}u;
const JOB_FIRST = ${JOB_FIRST}u;

@group(0) @binding(0) var<uniform> job: Job;
@group(1) @binding(0) var<storage, read_write> vertices: array<Vertex>;
@group(1) @binding(1) var<storage, read_write> previousPositions: array<f32>;
@group(1) @binding(2) var<storage, read> skins: array<SkinVertex>;
@group(1) @binding(3) var<storage, read> morphs: array<MorphVertex>;
@group(1) @binding(4) var<storage, read> bones: array<mat4x4f>;
@group(1) @binding(5) var<storage, read> morphWeights: array<MorphWeight>;

fn unpackDirection(word: u32) -> vec3f {
  let e = unpack2x16snorm(word);
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}

// What the pool does on the CPU; its length does not matter, so there is no need to make it one first.
fn packDirection(n: vec3f) -> u32 {
  var e = n.xy / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-12);
  if (n.z < 0.0) {
    e = (vec2f(1.0) - abs(e.yx)) * select(vec2f(-1.0), vec2f(1.0), e >= vec2f(0.0));
  }
  return pack2x16snorm(e);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= job.vertexCount) { return; }
  let source = vertices[job.sourceBase + index];
  var position = vec3f(source.px, source.py, source.pz);
  var normal = unpackDirection(source.normal);
  let hasTangent = source.tangent != 0u;
  var tangent = vec3f(0.0);
  if (hasTangent) { tangent = unpackDirection(source.tangent & 0xfffefffeu); }

  // Morphs come first, in the mesh's own shape, and three leaves the tangent out of them.
  for (var at = 0u; at < job.weightCount; at++) {
    let morph = morphWeights[job.weightFirst + at];
    let delta = morphs[job.morphBase + morph.morphTarget * job.vertexCount + index];
    position += vec3f(delta.px, delta.py, delta.pz) * morph.weight;
    normal += vec3f(delta.nx, delta.ny, delta.nz) * morph.weight;
  }

  if ((job.flags & JOB_SKINNED) != 0u) {
    let skin = skins[job.skinBase + index];
    let weights = unpack4x8unorm(skin.weights);
    let blended = bones[job.boneBase + (skin.joints0 & 0xffffu)] * weights.x
      + bones[job.boneBase + (skin.joints0 >> 16u)] * weights.y
      + bones[job.boneBase + (skin.joints1 & 0xffffu)] * weights.z
      + bones[job.boneBase + (skin.joints1 >> 16u)] * weights.w;
    let skinMatrix = job.bindMatrixInverse * blended * job.bindMatrix;
    position = (skinMatrix * vec4f(position, 1.0)).xyz;
    normal = (skinMatrix * vec4f(normal, 0.0)).xyz;
    tangent = (skinMatrix * vec4f(tangent, 0.0)).xyz;
  }

  let posedAt = job.posedBase + index;
  var before = position;
  if ((job.flags & JOB_FIRST) == 0u) {
    let current = vertices[posedAt];
    before = vec3f(current.px, current.py, current.pz);
  }
  let previousAt = (job.previousBase + index) * 3u;
  previousPositions[previousAt] = before.x;
  previousPositions[previousAt + 1u] = before.y;
  previousPositions[previousAt + 2u] = before.z;

  var posed = source;
  posed.px = position.x;
  posed.py = position.y;
  posed.pz = position.z;
  posed.normal = packDirection(normal);
  if (hasTangent) {
    // As the pool packs it: the sign kept in one bit, and another saying there is a tangent at all.
    posed.tangent = (packDirection(tangent) & 0xfffeffffu) | (source.tangent & 0x10000u) | 1u;
  }
  vertices[posedAt] = posed;
}
`;

interface SkeletonSlot {
  /** First bone in the bone table. */
  base: number;
  count: number;
  updatedFrame: number;
  changedFrame: number;
  lastSeen: number;
  /** What was last sent. */
  matrices: Float32Array;
}

/** What a posed mesh was last posed with, to tell whether it needs it again. */
interface PoseMemory {
  bind: Float32Array;
  weights: Uint32Array;
  weightWords: number;
  sourceVersion: number;
  /** Its previous positions have caught up with its current ones. */
  settled: boolean;
}

const _dynamicOffset = new Uint32Array(1);

export class SkinningPass implements GpuPass {
  readonly id = "skinning";
  readonly stage = "prepare" as const;
  /** Ahead of anything else in the stage, which may want to read the posed vertices. */
  readonly order = -100;
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly jobLayout: GPUBindGroupLayout;
  private readonly tableLayout: GPUBindGroupLayout;
  private readonly jobStride: number;
  private readonly jobs: GrowableBuffer;
  private readonly bones: GrowableBuffer;
  private readonly weights: GrowableBuffer;
  private readonly boneRanges = new RangeAllocator();
  private readonly skeletons = new Map<THREE.Skeleton, SkeletonSlot>();
  private readonly memories = new WeakMap<PosedMesh, PoseMemory>();
  private jobFloats: Float32Array;
  private jobWords: Uint32Array;
  private weightFloats: Float32Array;
  private weightWords: Uint32Array;
  private jobGroup: GPUBindGroup | null = null;
  private jobGroupGeneration = -1;
  private tableGroup: GPUBindGroup | null = null;
  private tableGeneration = -1;
  private tablePool: unknown = null;

  constructor(core: GpuCore) {
    const { device } = core;
    this.device = device;
    const visibility = GPUShaderStage.COMPUTE;
    this.jobLayout = device.createBindGroupLayout({
      label: "gpu skinning job",
      entries: [{ binding: 0, visibility, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: JOB_BYTES } }],
    });
    this.tableLayout = device.createBindGroupLayout({
      label: "gpu skinning tables",
      entries: [
        { binding: 0, visibility, buffer: { type: "storage" } },
        { binding: 1, visibility, buffer: { type: "storage" } },
        { binding: 2, visibility, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility, buffer: { type: "read-only-storage" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "gpu skinning",
      layout: device.createPipelineLayout({ label: "gpu skinning", bindGroupLayouts: [this.jobLayout, this.tableLayout] }),
      compute: { module: device.createShaderModule({ label: "gpu skinning", code: SKINNING_WGSL }), entryPoint: "main" },
    });
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    this.jobStride = Math.ceil(JOB_BYTES / alignment) * alignment;
    this.jobs = new GrowableBuffer(device, "gpu skinning jobs", GPUBufferUsage.UNIFORM, this.jobStride * 16);
    this.bones = new GrowableBuffer(device, "gpu bones", GPUBufferUsage.STORAGE, INITIAL_BONES * BONE_BYTES);
    this.weights = new GrowableBuffer(device, "gpu morph weights", GPUBufferUsage.STORAGE, INITIAL_MORPH_WEIGHTS * MORPH_WEIGHT_WORDS * 4);
    this.jobFloats = new Float32Array((this.jobStride / 4) * 16);
    this.jobWords = new Uint32Array(this.jobFloats.buffer);
    this.weightFloats = new Float32Array(INITIAL_MORPH_WEIGHTS * MORPH_WEIGHT_WORDS);
    this.weightWords = new Uint32Array(this.weightFloats.buffer);
  }

  execute(frame: GpuFrame): void {
    const { frameNumber } = frame;
    const list = frame.gpuScene.posed;
    if (frameNumber % SWEEP_EVERY === 0) this.sweep(frameNumber);
    if (!list.length) return;
    this.makeRoom(list);

    const strideWords = this.jobStride / 4;
    let jobs = 0;
    let weightWords = 0;
    for (let index = 0; index < list.length; index++) {
      const used = this.writeJob(list[index], jobs * strideWords, weightWords, frameNumber);
      if (used < 0) continue;
      jobs++;
      weightWords += used;
    }
    if (!jobs) return;
    this.jobs.ensure(jobs * this.jobStride);
    this.jobs.write(0, this.jobFloats, 0, jobs * this.jobStride);
    if (weightWords) {
      this.weights.ensure(weightWords * 4);
      this.weights.write(0, this.weightFloats, 0, weightWords * 4);
    }

    const pass = frame.encoder.beginComputePass({ label: "gpu skinning" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.tables(frame));
    const jobGroup = this.jobBindGroup();
    for (let job = 0; job < jobs; job++) {
      _dynamicOffset[0] = job * this.jobStride;
      pass.setBindGroup(0, jobGroup, _dynamicOffset, 0, 1);
      pass.dispatchWorkgroups(Math.ceil(this.jobWords[job * strideWords + AT_VERTEX_COUNT] / WORKGROUP));
    }
    pass.end();
  }

  dispose(): void {
    this.jobs.destroy();
    this.bones.destroy();
    this.weights.destroy();
  }

  /** Room in the CPU copies for every mesh running this frame, so that nothing below has to look. */
  private makeRoom(list: PosedMesh[]): void {
    const jobWords = list.length * (this.jobStride / 4);
    if (this.jobFloats.length < jobWords) {
      this.jobFloats = new Float32Array(jobWords * 2);
      this.jobWords = new Uint32Array(this.jobFloats.buffer);
    }
    let weightWords = 0;
    for (let index = 0; index < list.length; index++) weightWords += list[index].source.morphTargets * MORPH_WEIGHT_WORDS;
    if (this.weightFloats.length < weightWords) {
      this.weightFloats = new Float32Array(weightWords * 2);
      this.weightWords = new Uint32Array(this.weightFloats.buffer);
    }
  }

  /** The skeleton brought up to date and sent, once a frame however many meshes share it. */
  private skeletonSlot(skeleton: THREE.Skeleton, frameNumber: number): SkeletonSlot {
    let slot = this.skeletons.get(skeleton);
    const count = skeleton.bones.length;
    if (slot && slot.count !== count) {
      this.boneRanges.release(slot.base, slot.count);
      slot = undefined;
    }
    if (!slot) {
      const base = this.boneRanges.allocate(count);
      this.bones.ensure((base + count) * BONE_BYTES);
      slot = { base, count, updatedFrame: -1, changedFrame: -1, lastSeen: frameNumber, matrices: new Float32Array(count * BONE_WORDS) };
      this.skeletons.set(skeleton, slot);
      // Its place may hold another skeleton's old bones, so what was sent is taken to be different.
      slot.matrices.fill(NaN);
    }
    slot.lastSeen = frameNumber;
    if (slot.updatedFrame === frameNumber) return slot;
    slot.updatedFrame = frameNumber;
    skeleton.update();
    const { boneMatrices } = skeleton;
    if (!boneMatrices) return slot;
    const { matrices } = slot;
    let changed = false;
    for (let word = 0; word < matrices.length; word++) {
      if (matrices[word] !== boneMatrices[word]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      // The bone texture's array, once one has been made, is padded; only the bones themselves go up.
      matrices.set(boneMatrices.subarray(0, matrices.length));
      this.bones.write(slot.base * BONE_BYTES, matrices);
      slot.changedFrame = frameNumber;
    }
    return slot;
  }

  /**
   * Writes a mesh's job at word `at` and its morph weights from `weightAt`. Returns how many weight words it used, or
   * -1 when the mesh already stands as asked and needs no job. The job's room is reused by the next then.
   */
  private writeJob(posed: PosedMesh, at: number, weightAt: number, frameNumber: number): number {
    const { mesh, source } = posed;
    const floats = this.jobFloats;
    const words = this.jobWords;
    let memory = this.memories.get(posed);
    if (!memory) {
      memory = { bind: new Float32Array(AT_BIND_MATRICES), weights: new Uint32Array(source.morphTargets * MORPH_WEIGHT_WORDS), weightWords: 0, sourceVersion: -1, settled: false };
      this.memories.set(posed, memory);
    }
    let changed = source.version !== memory.sourceVersion;
    memory.sourceVersion = source.version;

    const skinned = mesh as THREE.SkinnedMesh;
    let flags = 0;
    let boneBase = 0;
    if (skinned.isSkinnedMesh && skinned.skeleton && source.skinCount > 0) {
      const slot = this.skeletonSlot(skinned.skeleton, frameNumber);
      boneBase = slot.base;
      flags |= JOB_SKINNED;
      if (slot.changedFrame === frameNumber) changed = true;
      floats.set(skinned.bindMatrix.elements, at);
      floats.set(skinned.bindMatrixInverse.elements, at + 16);
    } else {
      floats.fill(0, at, at + AT_BIND_MATRICES);
    }
    for (let word = 0; word < AT_BIND_MATRICES; word++) {
      if (floats[at + word] !== memory.bind[word]) {
        changed = true;
        memory.bind.set(floats.subarray(at, at + AT_BIND_MATRICES));
        break;
      }
    }

    // Only the targets in use go to the card: a face of fifty targets usually has a few of them on.
    const influences = mesh.morphTargetInfluences;
    let used = 0;
    if (influences) {
      const targets = Math.min(influences.length, source.morphTargets);
      for (let target = 0; target < targets; target++) {
        const weight = influences[target];
        if (weight === 0) continue;
        this.weightWords[weightAt + used] = target;
        this.weightFloats[weightAt + used + 1] = weight;
        used += MORPH_WEIGHT_WORDS;
      }
    }
    if (memory.weights.length < used) memory.weights = new Uint32Array(source.morphTargets * MORPH_WEIGHT_WORDS);
    let weightsDiffer = used !== memory.weightWords;
    for (let word = 0; word < used && !weightsDiffer; word++) {
      if (this.weightWords[weightAt + word] !== memory.weights[word]) weightsDiffer = true;
    }
    if (weightsDiffer) {
      changed = true;
      memory.weights.set(this.weightWords.subarray(weightAt, weightAt + used));
      memory.weightWords = used;
    }

    const { fresh } = posed;
    if (!changed && !fresh && memory.settled) return -1;
    // A fresh mesh's previous positions are its current ones; one that did not change has just caught up.
    memory.settled = fresh || !changed;
    posed.fresh = false;
    if (fresh) flags |= JOB_FIRST;

    words[at + AT_SOURCE_BASE] = source.vertexBase;
    words[at + AT_POSED_BASE] = posed.vertexBase;
    words[at + AT_PREVIOUS_BASE] = posed.previousBase;
    words[at + AT_VERTEX_COUNT] = posed.vertexCount;
    words[at + AT_SKIN_BASE] = source.skinBase;
    words[at + AT_BONE_BASE] = boneBase;
    words[at + AT_MORPH_BASE] = source.morphBase;
    words[at + AT_WEIGHT_FIRST] = weightAt / MORPH_WEIGHT_WORDS;
    words[at + AT_WEIGHT_COUNT] = used / MORPH_WEIGHT_WORDS;
    words[at + AT_FLAGS] = flags;
    return used;
  }

  private jobBindGroup(): GPUBindGroup {
    if (!this.jobGroup || this.jobGroupGeneration !== this.jobs.generation) {
      this.jobGroupGeneration = this.jobs.generation;
      this.jobGroup = this.device.createBindGroup({
        label: "gpu skinning job",
        layout: this.jobLayout,
        entries: [{ binding: 0, resource: { buffer: this.jobs.buffer, offset: 0, size: JOB_BYTES } }],
      });
    }
    return this.jobGroup;
  }

  private tables(frame: GpuFrame): GPUBindGroup {
    const { geometries } = frame;
    const generation = geometries.generation + this.bones.generation + this.weights.generation;
    if (!this.tableGroup || this.tableGeneration !== generation || this.tablePool !== geometries) {
      this.tableGeneration = generation;
      this.tablePool = geometries;
      this.tableGroup = this.device.createBindGroup({
        label: "gpu skinning tables",
        layout: this.tableLayout,
        entries: [
          { binding: 0, resource: { buffer: geometries.vertices.buffer } },
          { binding: 1, resource: { buffer: geometries.previousPositions.buffer } },
          { binding: 2, resource: { buffer: geometries.skins.buffer } },
          { binding: 3, resource: { buffer: geometries.morphs.buffer } },
          { binding: 4, resource: { buffer: this.bones.buffer } },
          { binding: 5, resource: { buffer: this.weights.buffer } },
        ],
      });
    }
    return this.tableGroup;
  }

  private sweep(frameNumber: number): void {
    for (const [skeleton, slot] of this.skeletons) {
      if (frameNumber - slot.lastSeen <= FORGET_SKELETON_AFTER) continue;
      this.boneRanges.release(slot.base, slot.count);
      this.skeletons.delete(skeleton);
    }
  }
}
