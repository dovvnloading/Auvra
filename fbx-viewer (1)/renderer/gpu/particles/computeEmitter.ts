/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { EmissionClock, MESH_SIDE, sampleSurface } from "../../../runtime/gpuParticles";
import { BAKE_SAMPLES, bakeCurve, bakeGradient, linearColor, type ParticleEffect, type ParticleShapeKind } from "../../../runtime/particleEffect";
import { MODE_DEFINE } from "../../../runtime/particleRenderer";
import { MAX_PARTICLE_STEP, type MeshSurface } from "../../../runtime/particleSimulation";
import type { GpuFrame } from "../frame";
import type { LightingProduct } from "../lightingWgsl";
import type { ParticlePipelines } from "./particlePipelines";
import {
  ARGS,
  ARGS_WORDS,
  COUNTER_BYTES,
  CURVE_BYTES,
  CURVE_ROWS,
  EVENT_BYTES,
  EVENT_HEADER_BYTES,
  EVENT_TRIGGER,
  LINK_BYTES,
  MAX_REQUESTS,
  NO_LINK,
  PARAMS_BYTES,
  PARAMS_WORDS,
  PARTICLE_BYTES,
  PARTICLE_FLAG,
  REQUEST_BYTES,
  REQUEST_WORDS,
  SORT_BLOCK,
  SORT_DIGITS,
  WORKGROUP,
} from "./particleWgsl";
import type { GpuHeightGrid, GpuVectorField } from "./vectorField";

/**
 * ONE EMITTER ON THE GRAPHICS CARD
 *
 * Its particles, its lists and everything that makes them move, as the same effect settings the CPU and the fragment-pass
 * forms take. The CPU keeps only the emission clock, and hands the compute passes how many to make and where. Reading how
 * many are alive takes a copy that comes back a few frames later, so `count` is that number plus what has been asked for
 * since: never short of the truth while anything is alive, which is what the light on an effect and "is it done" rest on.
 */

/** What the compute form adds to an effect's settings. Every field is optional and off, or sensibly chosen, when absent. */
export interface ComputeParticleSettings {
  /** Lit by the scene's lights: one result per particle for sprites and ribbons, per pixel for mesh particles. */
  lit?: boolean;
  /** Metres over which a particle fades where it meets the scene; 0 is none. By default half the effect's largest size. */
  softDistance?: number;
  /** World collision against the depth buffer; on unless turned off. It sees only what is on screen. */
  depthCollision?: boolean;
  /** How far behind a surface in the depth buffer still counts as hitting it, metres. */
  collisionThickness?: number;
  /** World-space curl noise: m/s² of push, the size of its swirls in metres, and how fast it drifts. */
  curl?: { strength: number; scale?: number; speed?: number };
  /** A vector field: a push of `strength` m/s² per unit of the field, or with `tightness` a steer toward its velocity. */
  field?: { field: GpuVectorField; strength: number; tightness?: number };
  /** Draws this model per particle instead of a sprite. */
  mesh?: THREE.BufferGeometry | null;
}

export interface ComputeSubEmitter {
  /** "trail" raises an event every `spacing` seconds of a particle's life, joining up a ribbon on the target. */
  trigger: "death" | "collision" | "trail";
  target: ComputeEmitter;
  count: number;
  inheritVelocity: number;
  /** The share of events that go through, 0-1; all of them by default. */
  chance?: number;
  /** Only within this many metres of the camera, across the ground; anywhere by default. */
  range?: number;
  /** Metres above where the event was. */
  lift?: number;
  spacing?: number;
}

/** What an emitter asks of what owns it: the shared pipelines and stand-ins for what is not bound. */
export interface EmitterHome {
  readonly device: GPUDevice;
  readonly pipelines: ParticlePipelines;
  readonly noField: GPUTextureView;
  readonly noGrid: GPUTextureView;
  readonly fieldSampler: GPUSampler;
  readonly noStorage: GPUBuffer;
  readonly noEvents: GPUBuffer;
  /** Counts up each frame any emitter steps: an event is only read the step after it was raised. */
  readonly stepTick: number;
  forget(emitter: ComputeEmitter): void;
}

interface Burst {
  count: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  a0: number; a1: number; a2: number;
  b0: number; b1: number; b2: number;
  size0: number; size1: number;
}

const SHAPE_NUMBER: Record<ParticleShapeKind, number> = { point: 0, sphere: 1, hemisphere: 2, cone: 3, box: 4, circle: 5, edge: 6, mesh: 7 };
const FRAME_NUMBER = { life: 0, fps: 1, random: 2 } as const;
const MESH_POINTS = MESH_SIDE * MESH_SIDE;
const BASE_SPAWN_BYTES = MAX_REQUESTS * REQUEST_BYTES;
const PREWARM_STEPS = 30;
const READ_EVERY_FRAMES = 6;
/** Bursts waiting for room: past this the oldest go, which means something is emitting far faster than it can draw. */
const MAX_QUEUED_BURSTS = 4096;
const MIN_EVENTS = 256;
const MAX_EVENTS = 32768;
const MIN_CHAINS = 64;
const MAX_CHAINS = 65536;

const IDENTITY = new THREE.Matrix4();
let nextEmitterId = 1;

/** A sub-emitter wired from one emitter's events into another's spawning. */
class ParticleLink {
  readonly uniform: GPUBuffer;
  private bindGroup: GPUBindGroup | null = null;
  private boundEvents: GPUBuffer | null = null;

  constructor(readonly source: ComputeEmitter, readonly target: ComputeEmitter, readonly settings: ComputeSubEmitter, device: GPUDevice, salt: number) {
    this.uniform = device.createBuffer({ label: "gpu particle link", size: LINK_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = new ArrayBuffer(LINK_BYTES);
    const words = new Uint32Array(data);
    const floats = new Float32Array(data);
    words[0] = EVENT_TRIGGER[settings.trigger];
    words[1] = Math.max(0, Math.round(settings.count));
    floats[2] = settings.inheritVelocity;
    floats[3] = settings.chance ?? 1;
    floats[4] = settings.range ? settings.range * settings.range : 0;
    floats[5] = settings.lift ?? 0;
    words[6] = salt;
    device.queue.writeBuffer(this.uniform, 0, data);
  }

  group(device: GPUDevice, pipelines: ParticlePipelines, events: GPUBuffer): GPUBindGroup {
    if (this.bindGroup && this.boundEvents === events) return this.bindGroup;
    this.boundEvents = events;
    this.bindGroup = device.createBindGroup({
      label: "gpu particle link",
      layout: pipelines.linkLayout,
      entries: [
        { binding: 0, resource: { buffer: events } },
        { binding: 1, resource: { buffer: this.uniform } },
      ],
    });
    return this.bindGroup;
  }

  destroy(): void {
    this.uniform.destroy();
  }
}

export class ComputeEmitter {
  readonly id = nextEmitterId++;
  readonly capacity: number;
  /** When set, it draws only while this is in the frame's scene and visible, as a mesh in its place would. */
  host: THREE.Object3D | null = null;
  settings: ComputeParticleSettings = {};

  private readonly device: GPUDevice;
  private readonly emission = new EmissionClock();
  private effect: ParticleEffect | null = null;

  private readonly params: GPUBuffer;
  private readonly curves: GPUBuffer;
  private readonly particles: GPUBuffer;
  private readonly counters: GPUBuffer;
  private readonly dead: GPUBuffer;
  private readonly aliveLists: readonly [GPUBuffer, GPUBuffer];
  private readonly args: GPUBuffer;
  private spawnData: GPUBuffer;
  private chains: GPUBuffer | null = null;
  private chainCount = 0;
  private events: GPUBuffer | null = null;
  private light: GPUBuffer | null = null;
  private keys: [GPUBuffer, GPUBuffer] | null = null;
  private histogram: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;

  /** Which of the two alive lists is current. */
  private parity = 0;
  private emitterGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private spawnGroup: GPUBindGroup | null = null;
  private simulateGroup: GPUBindGroup | null = null;
  private simulateKey: unknown[] = [];
  private argsGroup: GPUBindGroup | null = null;
  private sortGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private keyGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  private lightListGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private lightOutGroup: GPUBindGroup | null = null;
  private drawGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private drawKey: unknown[] = [];

  private readonly paramWords = new Uint32Array(PARAMS_WORDS);
  private readonly paramFloats = new Float32Array(this.paramWords.buffer);
  private readonly requestWords = new Uint32Array(MAX_REQUESTS * REQUEST_WORDS);
  private readonly requestFloats = new Float32Array(this.requestWords.buffer);
  private readonly curveData = new Float32Array(CURVE_ROWS * 4);
  private curvesDirty = true;
  private readonly colorA = new Float32Array(3);
  private readonly colorB = new Float32Array(3);
  private sprite: THREE.Texture | null = null;
  private grid: [number, number] = [1, 1];
  private meshCount = 0;
  private heightGrid: GpuHeightGrid | null = null;
  private gridOriginX = 0;
  private gridOriginZ = 0;
  private gridCellSize = 1;
  private wrapHalf = 0;
  private readonly wrapCentre = new THREE.Vector3();
  private meshArgs = { indexCount: -1, firstIndex: -1, baseVertex: -1 };

  private readonly matrix = new THREE.Matrix4();
  private readonly previous = new THREE.Matrix4();
  private hasPrevious = false;
  private readonly emitterVelocity = new THREE.Vector3();
  private ground: number | null = null;
  private pendingStep = 0;
  private stepAsked = false;
  private elapsed = 0;
  private serial = 0;
  private bursts: Burst[] = [];
  private needsClear = true;
  private warm = false;

  private spawnTotal = 0;
  /** Whether this frame's compute includes a step for this emitter. */
  private stepping = false;
  private eventsTick = -1;

  private readonly outgoing: ParticleLink[] = [];
  private readonly incoming: ParticleLink[] = [];
  private linkKey = "";
  private linkSalt = 1;
  private trailEvery = 0;
  private wantsDeath = false;
  private wantsCollision = false;

  private lastRead = 0;
  private inFlight = 0;
  private sinceCopy = 0;
  private readState: "idle" | "copied" | "mapping" = "idle";
  private framesSinceRead = 0;
  private disposed = false;

  constructor(private readonly home: EmitterHome, capacity: number) {
    const { device } = home;
    this.device = device;
    const limit = Math.floor(device.limits.maxStorageBufferBindingSize / PARTICLE_BYTES);
    this.capacity = Math.max(1, Math.min(limit, Math.floor(capacity)));
    const storage = (label: string, size: number, usage = 0) => device.createBuffer({ label: `gpu particles ${label}`, size, usage: GPUBufferUsage.STORAGE | usage });
    this.params = device.createBuffer({ label: "gpu particles params", size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.curves = device.createBuffer({ label: "gpu particles curves", size: CURVE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.particles = storage("records", this.capacity * PARTICLE_BYTES);
    this.counters = storage("counters", COUNTER_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.dead = storage("free list", this.capacity * 4, GPUBufferUsage.COPY_DST);
    this.aliveLists = [storage("alive", this.capacity * 4), storage("alive", this.capacity * 4)];
    this.args = storage("arguments", ARGS_WORDS * 4, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.spawnData = this.makeSpawnData(0);
  }

  private makeSpawnData(meshPoints: number): GPUBuffer {
    return this.device.createBuffer({
      label: "gpu particles requests",
      // One point past the requests at least: the shader's list of them cannot be empty.
      size: BASE_SPAWN_BYTES + Math.max(1, meshPoints * 2) * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  // --- What an effect's owner calls ---------------------------------------------------------------------------------

  /** Takes an effect's emission, shape, forces and life curves. It reads most numbers live, so what changes between steps counts. */
  setEffect(effect: ParticleEffect): void {
    this.effect = effect;
    linearColor(effect.startColor[0], this.colorA);
    linearColor(effect.startColor[1], this.colorB);
    this.curveData.set(bakeGradient(effect.colorOverLife), 0);
    const size = bakeCurve(effect.sizeOverLife);
    const speed = bakeCurve(effect.speedOverLife);
    for (let sample = 0; sample < BAKE_SAMPLES; sample++) {
      this.curveData[(BAKE_SAMPLES + sample) * 4] = size[sample];
      this.curveData[(BAKE_SAMPLES + sample) * 4 + 1] = speed[sample];
    }
    this.curvesDirty = true;
    if (effect.render.mode === "ribbon") this.ensureChains();
  }

  /** Takes an effect's look: its sprite texture and flipbook grid. Mode and blending are read from the effect. */
  setLook(effect: ParticleEffect, texture: THREE.Texture, grid: [number, number]): void {
    if (this.effect !== effect) this.setEffect(effect);
    this.sprite = texture;
    this.grid = grid;
    if (effect.render.mode === "ribbon") this.ensureChains();
  }

  /** The model's surface for the mesh shape, in the emitter's space; null leaves the shape's cone. */
  setMeshSurface(surface: MeshSurface | null): void {
    if (!surface || surface.indices.length < 3) {
      this.meshCount = 0;
      return;
    }
    const { points, normals } = sampleSurface(surface, MESH_POINTS);
    const data = new Float32Array(MESH_POINTS * 8);
    for (let point = 0; point < MESH_POINTS; point++) {
      data.set(points.subarray(point * 4, point * 4 + 4), point * 8);
      data.set(normals.subarray(point * 4, point * 4 + 4), point * 8 + 4);
    }
    if (this.spawnData.size < BASE_SPAWN_BYTES + data.byteLength) {
      this.spawnData.destroy();
      this.spawnData = this.makeSpawnData(MESH_POINTS);
      this.spawnGroup = null;
    }
    this.device.queue.writeBuffer(this.spawnData, BASE_SPAWN_BYTES, data);
    this.meshCount = MESH_POINTS;
  }

  /** Where falling particles stop: a grid of heights with its corner and cell size. Null: none. */
  setHeightGrid(grid: GpuHeightGrid | null, originX = 0, originZ = 0, cellSize = 1): void {
    this.heightGrid = grid;
    this.gridOriginX = originX;
    this.gridOriginZ = originZ;
    this.gridCellSize = cellSize;
  }

  /** Keeps particles in a box `half` metres either way of a moving centre, wrapping those that drift out; 0 is off. */
  setWrap(centre: THREE.Vector3, half: number): void {
    this.wrapCentre.copy(centre);
    this.wrapHalf = half;
  }

  /** Replaces what this emitter sets off. A list the same as the last one costs nothing. */
  setSubEmitters(list: readonly ComputeSubEmitter[]): void {
    const key = list.map((sub) => `${sub.trigger}/${sub.target.id}/${sub.count}/${sub.inheritVelocity}/${sub.chance ?? 1}/${sub.range ?? 0}/${sub.lift ?? 0}/${sub.spacing ?? 0}`).join("|");
    if (key === this.linkKey) return;
    this.linkKey = key;
    for (const link of this.outgoing.splice(0)) {
      const at = link.target.incoming.indexOf(link);
      if (at >= 0) link.target.incoming.splice(at, 1);
      link.destroy();
    }
    this.wantsDeath = false;
    this.wantsCollision = false;
    this.trailEvery = 0;
    for (const sub of list) {
      const link = new ParticleLink(this, sub.target, sub, this.device, this.linkSalt++);
      this.outgoing.push(link);
      sub.target.incoming.push(link);

      if (sub.trigger === "death") this.wantsDeath = true;
      if (sub.trigger === "collision") this.wantsCollision = true;
      if (sub.trigger === "trail") this.trailEvery = Math.max(0.005, sub.spacing ?? 0.05);
    }
    if (list.length) this.ensureEvents();
  }

  get isEmitting(): boolean {
    return this.emission.emitting && !this.emission.finished;
  }

  /** Particles alive, as far as the last reading says, with what has been asked for since. */
  get count(): number {
    return Math.min(this.capacity, this.lastRead + this.inFlight + this.sinceCopy);
  }

  /** Done: it emits no more and every particle it made has lived out its life. */
  get isDone(): boolean {
    return !this.isEmitting && this.bursts.length === 0 && this.quiet;
  }

  /** Nothing alive and nothing on its way, as last read. */
  private get quiet(): boolean {
    return this.lastRead === 0 && this.inFlight === 0 && this.sinceCopy === 0 && this.readState === "idle";
  }

  play(): void {
    this.emission.play();
  }

  stop(clear = false): void {
    this.emission.stop();
    if (clear) {
      this.needsClear = true;
      this.bursts.length = 0;
    }
  }

  /** Runs one looping cycle at once on the next step, as if it had been going a while. */
  prewarm(): void {
    this.warm = true;
  }

  /** Spawns `count` from the shape placed at a world point, with `velocity` (world, m/s) added. */
  emitAt(count: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    if (count <= 0 || !this.effect) return;
    if (this.bursts.length >= MAX_QUEUED_BURSTS) this.bursts.shift();
    const { size } = this.effect;
    this.bursts.push({
      count: Math.min(this.capacity, Math.round(count)),
      x, y, z, vx, vy, vz,
      a0: this.colorA[0], a1: this.colorA[1], a2: this.colorA[2],
      b0: this.colorB[0], b1: this.colorB[1], b2: this.colorB[2],
      size0: size[0], size1: size[1],
    });
  }

  /** Asks for a step of `dt` seconds (clamped to MAX_PARTICLE_STEP) with the emitter at `matrix`, for the next frame drawn. */
  step(dt: number, matrix: THREE.Matrix4 | null, ground: number | null = null): void {
    const clamped = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.pendingStep = Math.min(MAX_PARTICLE_STEP, this.pendingStep + clamped);
    this.stepAsked = true;
    this.matrix.copy(matrix ?? IDENTITY);
    this.ground = ground;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setSubEmitters([]);
    for (const link of this.incoming.splice(0)) link.source.dropLinkTo(this);
    this.home.forget(this);
    for (const buffer of [this.params, this.curves, this.particles, this.counters, this.dead, ...this.aliveLists, this.args, this.spawnData, this.chains, this.events, this.light, this.histogram, this.staging, ...(this.keys ?? [])]) {
      buffer?.destroy();
    }
  }

  private dropLinkTo(target: ComputeEmitter): void {
    const remaining = this.outgoing.filter((link) => link.target !== target);
    this.setSubEmitters(remaining.map((link) => link.settings));
  }

  // --- What the compute passes call ----------------------------------------------------------------------------------

  get ribbon(): boolean {
    return this.effect?.render.mode === "ribbon" && !this.settings.mesh;
  }

  get additive(): boolean {
    return this.effect?.render.blending === "additive";
  }

  /** Whether drawing it blends back to front: what asks to be, and models, which have no other way to hide their back. */
  get sorted(): boolean {
    const effect = this.effect;
    if (!effect || this.ribbon || effect.render.blending !== "alpha") return false;
    return effect.render.sort || !!this.settings.mesh;
  }

  /** Whether anything could be on screen. */
  get drawable(): boolean {
    return !!this.effect && !this.quiet;
  }

  get wantsLight(): boolean {
    return !!this.settings.lit;
  }

  /** Readies this frame's step, if one was asked for. Says whether the compute passes have anything to do for it. */
  beginFrame(frame: GpuFrame, depthUsable: boolean, lightingReady: boolean, sceneDepth: GPUBindGroup, runAlone: (run: (pass: GPUComputePassEncoder) => void) => void): boolean {
    this.pollReadback();
    if (this.needsClear) this.clear();
    if (this.curvesDirty) {
      this.curvesDirty = false;
      this.device.queue.writeBuffer(this.curves, 0, this.curveData);
    }
    this.stepping = false;
    if (!this.effect || !this.stepAsked) return false;
    this.stepAsked = false;
    this.updateMeshArgs(frame);

    if (this.warm) {
      this.warm = false;
      for (let step = 0; step < PREWARM_STEPS; step++) {
        // Nothing has been drawn for it to collide with, and each step needs its numbers on the queue before it runs.
        this.buildStep(this.effect.duration / PREWARM_STEPS, frame, false, lightingReady);
        runAlone((pass) => {
          this.encodeSpawn(pass, frame, false);
          this.encodeSimulate(pass, frame, sceneDepth);
        });
      }
      this.eventsTick = -1;
    }

    const step = this.pendingStep;
    this.pendingStep = 0;
    this.buildStep(step, frame, depthUsable, lightingReady);
    const eventsComing = this.incoming.some((link) => !link.source.quiet);
    this.stepping = this.spawnTotal > 0 || eventsComing || !this.quiet;
    return this.stepping;
  }

  private ensureChains(): void {
    if (this.chains) return;
    const count = Math.max(MIN_CHAINS, Math.min(MAX_CHAINS, this.capacity));
    this.chainCount = count;
    this.chains = this.device.createBuffer({ label: "gpu particles chains", size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.chains, 0, new Uint32Array(count).fill(NO_LINK));
    this.spawnGroup = null;
  }

  private ensureEvents(): void {
    if (this.events) return;
    const capacity = Math.max(MIN_EVENTS, Math.min(MAX_EVENTS, this.capacity));
    this.events = this.device.createBuffer({ label: "gpu particles events", size: EVENT_HEADER_BYTES + capacity * EVENT_BYTES, usage: GPUBufferUsage.STORAGE });
    this.simulateGroup = null;
    this.argsGroup = null;
  }

  /** The events other emitters read: an empty list until this emitter has anyone to tell. */
  private get eventList(): GPUBuffer {
    return this.events ?? this.home.noEvents;
  }

  private clear(): void {
    this.needsClear = false;
    const { queue } = this.device;
    const free = new Uint32Array(this.capacity);
    for (let index = 0; index < this.capacity; index++) free[index] = this.capacity - 1 - index;
    queue.writeBuffer(this.dead, 0, free);
    const counters = new Int32Array(COUNTER_BYTES / 4);
    counters[2] = this.capacity;
    queue.writeBuffer(this.counters, 0, counters);
    const args = new Uint32Array(ARGS_WORDS);
    args[ARGS.simulate + 1] = args[ARGS.simulate + 2] = 1;
    args[ARGS.events + 1] = args[ARGS.events + 2] = 1;
    args[ARGS.sortBlocks + 1] = args[ARGS.sortBlocks + 2] = 1;
    args[ARGS.eachParticle + 1] = args[ARGS.eachParticle + 2] = 1;
    args[ARGS.quad] = 6;
    queue.writeBuffer(this.args, 0, args);
    this.meshArgs = { indexCount: -1, firstIndex: -1, baseVertex: -1 };
    if (this.chains) queue.writeBuffer(this.chains, 0, new Uint32Array(this.chainCount).fill(NO_LINK));
    this.lastRead = 0;
    this.inFlight = 0;
    this.sinceCopy = 0;
  }

  private updateMeshArgs(frame: GpuFrame): void {
    const { mesh } = this.settings;
    if (!mesh) return;
    const entry = frame.geometries.acquire(mesh);
    if (!entry) return;
    const { indexCount, indexBase, vertexBase } = entry;
    const known = this.meshArgs;
    if (known.indexCount === indexCount && known.firstIndex === indexBase && known.baseVertex === vertexBase) return;
    this.meshArgs = { indexCount, firstIndex: indexBase, baseVertex: vertexBase };
    const { queue } = this.device;
    queue.writeBuffer(this.args, ARGS.mesh * 4, new Uint32Array([indexCount]));
    // The instance count between them is the compute pass's to write.
    queue.writeBuffer(this.args, (ARGS.mesh + 2) * 4, new Int32Array([indexBase, vertexBase]));
  }

  private writeRequest(index: number, first: number, count: number, kind: number, linksBack: number, closesChain: number, burst: Burst | null): void {
    const words = this.requestWords;
    const floats = this.requestFloats;
    const at = index * REQUEST_WORDS;
    if (burst) {
      floats[at] = burst.x;
      floats[at + 1] = burst.y;
      floats[at + 2] = burst.z;
      floats[at + 4] = burst.vx;
      floats[at + 5] = burst.vy;
      floats[at + 6] = burst.vz;
      floats[at + 8] = burst.a0;
      floats[at + 9] = burst.a1;
      floats[at + 10] = burst.a2;
      floats[at + 12] = burst.b0;
      floats[at + 13] = burst.b1;
      floats[at + 14] = burst.b2;
      floats[at + 16] = burst.size0;
      floats[at + 17] = burst.size1;
    } else {
      floats.fill(0, at, at + REQUEST_WORDS);
      floats.set(this.colorA, at + 8);
      floats.set(this.colorB, at + 12);
      floats[at + 16] = this.effect!.size[0];
      floats[at + 17] = this.effect!.size[1];
    }
    words[at + 3] = first;
    words[at + 7] = count;
    words[at + 11] = kind;
    words[at + 15] = 0;
    words[at + 18] = linksBack;
    words[at + 19] = closesChain;
  }

  /** The emission clock moved on, this step's requests written and its numbers on the queue. */
  private buildStep(step: number, frame: GpuFrame, depthUsable: boolean, lightingReady: boolean): void {
    const effect = this.effect!;
    const e = this.matrix.elements;
    let moved = 0;
    if (this.hasPrevious && step > 0) {
      const p = this.previous.elements;
      const dx = e[12] - p[12];
      const dy = e[13] - p[13];
      const dz = e[14] - p[14];
      this.emitterVelocity.set(dx / step, dy / step, dz / step);
      moved = Math.hypot(dx, dy, dz);
    }
    const counts = this.emission.advance(effect, step, moved);
    let trail = counts.trail;
    let cycle = counts.cycle;
    if (trail + cycle > this.capacity) {
      // More than it can hold this step: each gives way in proportion.
      const keep = this.capacity / (trail + cycle);
      trail = Math.floor(trail * keep);
      cycle = Math.floor(cycle * keep);
    }

    let requests = 0;
    let total = 0;
    if (trail > 0) {
      this.writeRequest(requests++, total, trail, 0, 0, cycle > 0 ? 0 : 1, null);
      total += trail;
    }
    if (cycle > 0) {
      this.writeRequest(requests++, total, cycle, 1, trail > 0 ? 1 : 0, 1, null);
      total += cycle;
    }
    let taken = 0;
    while (taken < this.bursts.length && requests < MAX_REQUESTS && total < this.capacity) {
      const burst = this.bursts[taken];
      const count = Math.min(burst.count, this.capacity - total);
      this.writeRequest(requests++, total, count, 2, 2, 0, burst);
      total += count;
      if (count < burst.count) {
        burst.count -= count;
        break;
      }
      taken++;
    }
    if (taken) this.bursts.splice(0, taken);
    this.spawnTotal = total;
    this.sinceCopy += total;
    if (requests) this.device.queue.writeBuffer(this.spawnData, 0, this.requestWords, 0, requests * REQUEST_WORDS);

    this.writeParams(step, frame, depthUsable, lightingReady, requests);
    this.elapsed += step;
    this.previous.copy(this.matrix);
    this.hasPrevious = true;
  }

  private writeParams(step: number, frame: GpuFrame, depthUsable: boolean, lightingReady: boolean, requests: number): void {
    const effect = this.effect!;
    const { render, shape } = effect;
    const { settings } = this;
    const f = this.paramFloats;
    const u = this.paramWords;
    const local = effect.space === "local";
    const e = this.matrix.elements;

    f.set(e, 0);
    f.set(this.hasPrevious ? this.previous.elements : e, 16);
    // Gravity and wind act along world axes; a local-space emitter feels them turned into its frame.
    const ax = effect.wind[0];
    const ay = effect.wind[1] - effect.gravity;
    const az = effect.wind[2];
    if (local) {
      f[32] = e[0] * ax + e[1] * ay + e[2] * az;
      f[33] = e[4] * ax + e[5] * ay + e[6] * az;
      f[34] = e[8] * ax + e[9] * ay + e[10] * az;
    } else {
      f[32] = ax;
      f[33] = ay;
      f[34] = az;
    }
    f[35] = step;
    f[36] = this.emitterVelocity.x;
    f[37] = this.emitterVelocity.y;
    f[38] = this.emitterVelocity.z;
    f[39] = this.elapsed;
    f[40] = local ? 0 : e[12];
    f[41] = local ? 0 : e[13];
    f[42] = local ? 0 : e[14];
    f[43] = effect.orbit;
    const axisLength = Math.hypot(shape.axis[0], shape.axis[1], shape.axis[2]);
    f[44] = axisLength > 1e-4 ? shape.axis[0] / axisLength : 0;
    f[45] = axisLength > 1e-4 ? shape.axis[1] / axisLength : 1;
    f[46] = axisLength > 1e-4 ? shape.axis[2] / axisLength : 0;
    f[47] = shape.radius;
    f[48] = shape.size[0];
    f[49] = shape.size[1];
    f[50] = shape.size[2];
    f[51] = (shape.angle * Math.PI) / 180;
    f.set(this.colorA, 52);
    f[55] = shape.volume;
    f.set(this.colorB, 56);
    f[59] = shape.randomDirection;
    f[60] = effect.lifetime[0];
    f[61] = effect.lifetime[1];
    f[62] = effect.speed[0];
    f[63] = effect.speed[1];
    f[64] = effect.size[0];
    f[65] = effect.size[1];
    f[66] = (effect.rotation[0] * Math.PI) / 180;
    f[67] = (effect.rotation[1] * Math.PI) / 180;
    f[68] = (effect.spin[0] * Math.PI) / 180;
    f[69] = (effect.spin[1] * Math.PI) / 180;
    f[70] = effect.inheritVelocity;
    f[71] = effect.drag;
    f[72] = effect.turbulence;
    f[73] = effect.turbulenceScale;
    f[74] = settings.curl?.strength ?? 0;
    f[75] = settings.curl?.scale ?? 2;
    f[76] = settings.curl?.speed ?? 0.2;
    const { field } = settings;
    f[77] = field?.strength ?? 0;
    f[78] = field?.tightness ?? 0;
    f[79] = settings.collisionThickness ?? 0.5;
    f[80] = field ? field.field.min[0] : 0;
    f[81] = field ? field.field.min[1] : 0;
    f[82] = field ? field.field.min[2] : 0;
    f[83] = effect.collision.bounce;
    f[84] = field ? 1 / Math.max(field.field.max[0] - field.field.min[0], 1e-5) : 0;
    f[85] = field ? 1 / Math.max(field.field.max[1] - field.field.min[1], 1e-5) : 0;
    f[86] = field ? 1 / Math.max(field.field.max[2] - field.field.min[2], 1e-5) : 0;
    f[87] = effect.collision.friction;
    f[88] = this.wrapCentre.x;
    f[89] = this.wrapCentre.y;
    f[90] = this.wrapCentre.z;
    f[91] = this.wrapHalf;
    f[92] = this.gridOriginX;
    f[93] = this.gridOriginZ;
    f[94] = 1 / this.gridCellSize;
    f[95] = this.ground ?? 0;
    f[96] = this.grid[0];
    f[97] = this.grid[1];
    f[98] = render.fps;
    f[99] = render.stretch;
    f[100] = render.emissive;
    f[101] = settings.softDistance ?? Math.max(0.02, Math.min(1, effect.size[1] * 0.5));

    const fog = frame.scene.fog as (THREE.Fog & THREE.FogExp2) | null;
    u[117] = 0;
    if (fog) {
      u[117] = fog.isFogExp2 ? 2 : 1;
      f[102] = fog.near ?? 0;
      f[103] = fog.far ?? 0;
      f[104] = fog.color.r;
      f[105] = fog.color.g;
      f[106] = fog.color.b;
      f[107] = fog.density ?? 0;
    }

    let flags = 0;
    if (local) flags |= PARTICLE_FLAG.local;
    if (effect.collision.mode === "world" && !local) {
      if (settings.depthCollision !== false && depthUsable) flags |= PARTICLE_FLAG.depthCollision;
      if (this.heightGrid) flags |= PARTICLE_FLAG.heightGrid;
      else if (this.ground !== null) flags |= PARTICLE_FLAG.groundPlane;
    }
    if (effect.collision.kill) flags |= PARTICLE_FLAG.killOnHit;
    if (this.wantsDeath) flags |= PARTICLE_FLAG.wantsDeath;
    if (this.wantsCollision) flags |= PARTICLE_FLAG.wantsCollision;
    if (this.ribbon) flags |= PARTICLE_FLAG.ribbon;
    if (field) flags |= PARTICLE_FLAG.field;
    if (settings.curl && settings.curl.strength > 0) flags |= PARTICLE_FLAG.curl;
    if (this.wrapHalf > 0) flags |= PARTICLE_FLAG.wrap;
    if (settings.lit && lightingReady) flags |= PARTICLE_FLAG.lit;

    f[108] = this.trailEvery;
    u[109] = this.spawnTotal;
    u[110] = requests;
    this.serial = (this.serial + 1) % 1000003;
    u[111] = this.serial;
    u[112] = SHAPE_NUMBER[shape.kind];
    u[113] = flags;
    u[114] = this.meshCount;
    u[115] = render.mode === "ribbon" ? 0 : MODE_DEFINE[render.mode];
    u[116] = FRAME_NUMBER[render.frameMode];
    u[118] = this.heightGrid ? this.heightGrid.cells : 0;
    this.device.queue.writeBuffer(this.params, 0, this.paramWords);
  }

  private emitterGroup(): GPUBindGroup {
    const made = this.emitterGroups[this.parity];
    if (made) return made;
    const aliveIn = this.aliveLists[this.parity];
    const aliveOut = this.aliveLists[1 - this.parity];
    const group = this.device.createBindGroup({
      label: "gpu particles emitter",
      layout: this.home.pipelines.emitterLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.curves } },
        { binding: 2, resource: { buffer: this.particles } },
        { binding: 3, resource: { buffer: this.counters } },
        { binding: 4, resource: { buffer: this.dead } },
        { binding: 5, resource: { buffer: aliveIn } },
        { binding: 6, resource: { buffer: aliveOut } },
      ],
    });
    this.emitterGroups[this.parity] = group;
    return group;
  }

  private spawnGroupOf(): GPUBindGroup {
    if (this.spawnGroup) return this.spawnGroup;
    this.spawnGroup = this.device.createBindGroup({
      label: "gpu particles spawn",
      layout: this.home.pipelines.spawnLayout,
      entries: [
        { binding: 0, resource: { buffer: this.spawnData } },
        { binding: 1, resource: { buffer: this.chains ?? this.home.noStorage } },
      ],
    });
    return this.spawnGroup;
  }

  /** Both steps of the frame in which this emitter has any: what the CPU asked for, then what others set off. */
  encodeSpawn(pass: GPUComputePassEncoder, frame: GpuFrame, withEvents: boolean): void {
    const { pipelines } = this.home;
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, this.emitterGroup());
    pass.setBindGroup(2, this.spawnGroupOf());
    if (this.spawnTotal > 0) {
      pass.setPipeline(pipelines.spawn);
      pass.dispatchWorkgroups(Math.ceil(this.spawnTotal / WORKGROUP));
      pass.setPipeline(pipelines.spawnEnd);
      pass.dispatchWorkgroups(1);
    }
    if (!withEvents) return;
    for (const link of this.incoming) {
      const { source } = link;
      if (source.eventsTick !== this.home.stepTick - 1 || !source.events) continue;
      pass.setPipeline(pipelines.spawnEvents);
      pass.setBindGroup(3, link.group(this.device, pipelines, source.events));
      pass.dispatchWorkgroupsIndirect(source.args, ARGS.events * 4);
      // Nothing here says how many came of it, so the next reading is what tells.
      this.sinceCopy += 1;
    }
  }

  private simulateGroupOf(): GPUBindGroup {
    const { field } = this.settings;
    const fieldView = field?.field.view ?? this.home.noField;
    const gridView = this.heightGrid?.view ?? this.home.noGrid;
    const events = this.eventList;
    if (this.simulateGroup && this.simulateKey[0] === fieldView && this.simulateKey[1] === gridView && this.simulateKey[2] === events) return this.simulateGroup;
    this.simulateKey = [fieldView, gridView, events];
    this.simulateGroup = this.device.createBindGroup({
      label: "gpu particles simulate",
      layout: this.home.pipelines.simulateLayout,
      entries: [
        { binding: 0, resource: { buffer: events } },
        { binding: 1, resource: fieldView },
        { binding: 2, resource: this.home.fieldSampler },
        { binding: 3, resource: gridView },
      ],
    });
    return this.simulateGroup;
  }

  private argsGroupOf(): GPUBindGroup {
    if (this.argsGroup) return this.argsGroup;
    this.argsGroup = this.device.createBindGroup({
      label: "gpu particles arguments",
      layout: this.home.pipelines.argsLayout,
      entries: [{ binding: 0, resource: { buffer: this.args } }],
    });
    return this.argsGroup;
  }

  /** The step itself, between working out how many to run and what came of it. */
  encodeSimulate(pass: GPUComputePassEncoder, frame: GpuFrame, sceneDepth: GPUBindGroup): void {
    const { pipelines } = this.home;
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, this.emitterGroup());
    pass.setBindGroup(2, this.simulateGroupOf());
    pass.setBindGroup(3, this.argsGroupOf());
    pass.setPipeline(pipelines.beginStep);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(pipelines.simulate);
    pass.setBindGroup(3, sceneDepth);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS.simulate * 4);
    pass.setPipeline(pipelines.endStep);
    pass.setBindGroup(3, this.argsGroupOf());
    pass.dispatchWorkgroups(1);
    this.parity = 1 - this.parity;
    this.eventsTick = this.home.stepTick;
  }

  private ensureSort(): void {
    if (this.keys) return;
    const { device } = this;
    const makeKeys = () => device.createBuffer({ label: "gpu particles sort keys", size: this.capacity * 8, usage: GPUBufferUsage.STORAGE });
    this.keys = [makeKeys(), makeKeys()];
    const blocks = Math.ceil(this.capacity / SORT_BLOCK);
    this.histogram = device.createBuffer({ label: "gpu particles sort counts", size: blocks * SORT_DIGITS * 4, usage: GPUBufferUsage.STORAGE });
    const groupOf = (keysIn: GPUBuffer, keysOut: GPUBuffer) => device.createBindGroup({
      label: "gpu particles sort keys",
      layout: this.home.pipelines.keysLayout,
      entries: [
        { binding: 0, resource: { buffer: keysIn } },
        { binding: 1, resource: { buffer: keysOut } },
        { binding: 2, resource: { buffer: this.histogram! } },
      ],
    });
    this.keyGroups = [groupOf(this.keys[0], this.keys[1]), groupOf(this.keys[1], this.keys[0])];
  }

  /** Two radix rounds over the current alive list, leaving it back to front for this frame's camera. */
  encodeSort(pass: GPUComputePassEncoder, frame: GpuFrame): void {
    if (!this.sorted) return;
    this.ensureSort();
    const { pipelines } = this.home;
    let sortGroup = this.sortGroups[this.parity];
    if (!sortGroup) {
      sortGroup = this.device.createBindGroup({
        label: "gpu particles sort",
        layout: pipelines.sortLayout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.particles } },
          { binding: 2, resource: { buffer: this.aliveLists[this.parity] } },
          { binding: 3, resource: { buffer: this.counters, offset: 0, size: 4 } },
        ],
      });
      this.sortGroups[this.parity] = sortGroup;
    }
    const [first, second] = this.keyGroups!;
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, sortGroup);
    // Keys go into the first buffer, round one moves them to the second, round two moves them back.
    pass.setBindGroup(2, second);
    pass.setPipeline(pipelines.makeKeys);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS.eachParticle * 4);
    for (let round = 0; round < 2; round++) {
      pass.setBindGroup(2, round === 0 ? first : second);
      pass.setPipeline(pipelines.countDigits[round]);
      pass.dispatchWorkgroupsIndirect(this.args, ARGS.sortBlocks * 4);
      pass.setPipeline(pipelines.digitOffsets);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(pipelines.scatter[round]);
      pass.dispatchWorkgroupsIndirect(this.args, ARGS.sortBlocks * 4);
    }
    pass.setBindGroup(2, first);
    pass.setPipeline(pipelines.writeBack);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS.eachParticle * 4);
  }

  /** Every so often, a copy of how many are alive to read back once this frame has gone to the graphics card. */
  encodeReadback(encoder: GPUCommandEncoder): void {
    if (!this.stepping || this.readState !== "idle") return;
    if (++this.framesSinceRead < READ_EVERY_FRAMES) return;
    this.framesSinceRead = 0;
    if (!this.staging) this.staging = this.device.createBuffer({ label: "gpu particles alive count", size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(this.counters, 0, this.staging, 0, 4);
    this.readState = "copied";
    this.inFlight = this.sinceCopy;
    this.sinceCopy = 0;
  }

  private pollReadback(): void {
    if (this.readState !== "copied" || !this.staging) return;
    const { staging } = this;
    this.readState = "mapping";
    staging.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      this.lastRead = new Uint32Array(staging.getMappedRange())[0];
      staging.unmap();
      this.inFlight = 0;
      this.readState = "idle";
    }).catch(() => {
      this.inFlight = 0;
      this.readState = "idle";
    });
  }

  /** Whether this emitter should draw in this frame: its place in the scene graph, as a mesh's would. */
  shownIn(frame: GpuFrame): boolean {
    if (!this.host) return true;
    let object: THREE.Object3D | null = this.host;
    let top: THREE.Object3D = this.host;
    while (object) {
      if (!object.visible) return false;
      top = object;
      object = object.parent;
    }
    return top === frame.scene;
  }

  /** How far the emitter is from the eye, which is how different emitters are put in order. */
  distanceTo(eye: THREE.Vector3): number {
    const e = this.matrix.elements;
    return Math.hypot(e[12] - eye.x, e[13] - eye.y, e[14] - eye.z);
  }

  /** One lighting result per particle: for sprites and ribbons, which have no surface of their own to light per pixel. */
  encodeLight(pass: GPUComputePassEncoder, frame: GpuFrame, lighting: LightingProduct): void {
    if (!this.wantsLight || this.settings.mesh || !this.effect) return;
    const { pipelines } = this.home;
    if (!this.light) {
      this.light = this.device.createBuffer({ label: "gpu particles light", size: this.capacity * 16, usage: GPUBufferUsage.STORAGE });
      this.lightOutGroup = null;
      this.drawKey = [];
    }
    let list = this.lightListGroups[this.parity];
    if (!list) {
      list = this.device.createBindGroup({
        label: "gpu particles light list",
        layout: pipelines.lightListLayout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.aliveLists[this.parity] } },
          { binding: 2, resource: { buffer: this.counters, offset: 0, size: 4 } },
        ],
      });
      this.lightListGroups[this.parity] = list;
    }
    if (!this.lightOutGroup) {
      this.lightOutGroup = this.device.createBindGroup({
        label: "gpu particles light out",
        layout: pipelines.lightOutLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particles } },
          { binding: 1, resource: { buffer: this.light } },
        ],
      });
    }
    pass.setPipeline(pipelines.lightPipeline(lighting));
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, list);
    pass.setBindGroup(2, this.lightOutGroup);
    pass.setBindGroup(3, lighting.bindGroup);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS.eachParticle * 4);
  }

  private drawGroupOf(frame: GpuFrame): GPUBindGroup {
    const spriteEntry = frame.textures.acquire(this.sprite) ?? frame.textures.white;
    const depth = frame.targets.depth.view;
    const light = this.light ?? this.home.noStorage;
    const key = this.drawKey;
    if (key[0] !== spriteEntry.view || key[1] !== spriteEntry.sampler || key[2] !== depth || key[3] !== light) {
      this.drawKey = [spriteEntry.view, spriteEntry.sampler, depth, light];
      this.drawGroups = [null, null];
    }
    const made = this.drawGroups[this.parity];
    if (made) return made;
    const group = this.device.createBindGroup({
      label: "gpu particles draw",
      layout: this.home.pipelines.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.curves } },
        { binding: 2, resource: { buffer: this.particles } },
        { binding: 3, resource: { buffer: this.aliveLists[this.parity] } },
        { binding: 4, resource: spriteEntry.view },
        { binding: 5, resource: spriteEntry.sampler },
        { binding: 6, resource: depth },
        { binding: 7, resource: { buffer: light } },
      ],
    });
    this.drawGroups[this.parity] = group;
    return group;
  }

  /** The one indirect draw. Groups 0 and 1 are bound by the caller. */
  encodeDraw(pass: GPURenderPassEncoder, frame: GpuFrame, lighting: LightingProduct | null): void {
    const { pipelines } = this.home;
    const { mesh, lit } = this.settings;
    const group = this.drawGroupOf(frame);
    if (mesh) {
      if (this.meshArgs.indexCount <= 0) return;
      const useLight = !!lit && !!lighting;
      pass.setPipeline(useLight ? pipelines.litMeshPipeline(this.additive, lighting!) : pipelines.drawPipeline("mesh", this.additive));
      pass.setBindGroup(2, group);
      if (useLight) pass.setBindGroup(3, lighting!.bindGroup);
      pass.setIndexBuffer(frame.geometries.indices.buffer, "uint32");
      pass.drawIndexedIndirect(this.args, ARGS.mesh * 4);
      return;
    }
    pass.setPipeline(pipelines.drawPipeline(this.ribbon ? "ribbon" : "quad", this.additive));
    pass.setBindGroup(2, group);
    pass.drawIndirect(this.args, ARGS.quad * 4);
  }
}
