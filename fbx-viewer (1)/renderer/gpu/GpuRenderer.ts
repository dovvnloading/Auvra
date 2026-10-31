/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { createBuiltinPasses, type BuiltinPasses } from "./builtinPasses";
import type { GpuCore } from "./device";
import { FrameTimings } from "./frameTimings";
import { STAGE_ORDER, TARGET_FORMATS, type GpuFrame, type GpuPass, type GpuRendererApi, type GpuStage, type GpuTarget, type GpuTargets, type GpuViewSpec } from "./frame";
import { GeometryPool } from "./geometryPool";
import { GpuScene } from "./gpuScene";
import { MaterialPool } from "./materialPool";
import { VIEW_BYTES } from "./shaders";
import { registerEffectSurfaces } from "./effects/surfaceKinds";
import { installSurfaces } from "./surfaces/index";
import { TexturePool } from "./texturePool";

/**
 * THE RENDERER
 *
 * Draws a three.js scene with WebGPU. It answers to what @react-three/fiber and level code ask of a renderer, keeps
 * the scene's tables up to date on the graphics card and runs the frame's stages (frame.ts). All the drawing itself
 * is in passes; what lives here is the frame around them: targets, views and the bind groups they share.
 */

const MAX_VIEWS = 256;
const TARGETS_KEPT_FRAMES = 240;
const VISIBILITY_ALL = 7; // vertex | fragment | compute

interface SharedPools {
  geometries: GeometryPool;
  textures: TexturePool;
  materials: MaterialPool;
}

const pools = new WeakMap<GPUDevice, SharedPools>();

const poolsFor = (core: GpuCore): SharedPools => {
  let shared = pools.get(core.device);
  if (!shared) {
    const textures = new TexturePool(core.device, core.features);
    shared = { geometries: new GeometryPool(core.device), textures, materials: new MaterialPool(core.device, textures) };
    pools.set(core.device, shared);
  }
  return shared;
};

const _reverse = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.5, 0.5, 0, 0, 0, 1);
const _projection = new THREE.Matrix4();
const _unjittered = new THREE.Matrix4();
const _viewProjection = new THREE.Matrix4();
const _unjitteredViewProjection = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _frustumMatrix = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _eye = new THREE.Vector3();

export class GpuRenderer implements GpuRendererApi {
  readonly isGpuRenderer = true as const;
  readonly domElement: HTMLCanvasElement;
  readonly core: GpuCore;
  readonly geometries: GeometryPool;
  readonly materials: MaterialPool;
  readonly textures: TexturePool;
  readonly settings = new Map<string, unknown>();

  // What three.js-facing code reads and sets.
  readonly shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false, type: THREE.PCFSoftShadowMap as THREE.ShadowMapType };
  readonly info = {
    autoReset: true,
    render: { frame: 0, calls: 0, triangles: 0, points: 0, lines: 0 },
    memory: { geometries: 0, textures: 0 },
    programs: [] as unknown[],
    reset() { /* counts are made by the passes */ },
  };
  readonly capabilities = { isWebGL2: false, maxTextureSize: 8192, getMaxAnisotropy: () => 16, logarithmicDepthBuffer: false, precision: "highp" };
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  sortObjects = true;
  toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  toneMappingExposure = 1;
  outputColorSpace: THREE.ColorSpace = THREE.SRGBColorSpace;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private clearAlpha = 1;

  private readonly context: GPUCanvasContext;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private readonly viewport = new THREE.Vector4(0, 0, 1, 1);
  private readonly scissor = new THREE.Vector4(0, 0, 1, 1);
  private scissorTest = false;
  private renderTarget: THREE.WebGLRenderTarget | null = null;

  private readonly passes = new Map<GpuStage, GpuPass[]>();
  private readonly failedPasses = new Set<string>();
  private readonly builtin: BuiltinPasses;
  private readonly viewBuffer: GPUBuffer;
  private viewCursor = 0;
  private readonly viewData = new Float32Array(VIEW_BYTES / 4);
  private readonly viewWords = new Uint32Array(this.viewData.buffer);
  private readonly cameraLayout: GPUBindGroupLayout;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly cameraBindGroup: GPUBindGroup;
  private sceneBindGroup: GPUBindGroup | null = null;
  private sceneBindKey = "";
  private readonly gpuScenes = new WeakMap<THREE.Scene, GpuScene>();
  /** Targets by size: four editor views can be four sizes in one frame. */
  private readonly targetSets = new Map<string, { targets: GpuTargets; lastUsed: number }>();
  private lastCanvasTexture: GPUTexture | null = null;
  private readonly previousViewProjections = new WeakMap<THREE.Camera, THREE.Matrix4>();
  private readonly products = new Map<string, unknown>();
  private readonly startTime = performance.now();
  private lastTime = performance.now();
  private disposed = false;
  /** How long each stage takes: read by the profiler overlay. */
  readonly timings: FrameTimings;

  constructor(canvas: HTMLCanvasElement, core: GpuCore) {
    this.domElement = canvas;
    this.core = core;
    const shared = poolsFor(core);
    this.geometries = shared.geometries;
    this.materials = shared.materials;
    this.textures = shared.textures;
    const { device } = core;
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("The canvas has no webgpu context");
    this.context = context;
    context.configure({ device, format: core.presentFormat, alphaMode: "opaque" });
    this.viewBuffer = device.createBuffer({ label: "gpu views", size: MAX_VIEWS * VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cameraLayout = device.createBindGroupLayout({
      label: "gpu camera",
      entries: [{ binding: 0, visibility: VISIBILITY_ALL, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: VIEW_BYTES } }],
    });
    this.sceneLayout = device.createBindGroupLayout({
      label: "gpu scene",
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: VISIBILITY_ALL, buffer: { type: "read-only-storage" as const } })),
    });
    this.cameraBindGroup = device.createBindGroup({
      label: "gpu camera",
      layout: this.cameraLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewBuffer, offset: 0, size: VIEW_BYTES } }],
    });
    this.timings = new FrameTimings(device, core.features.timestamps);
    this.builtin = createBuiltinPasses(core);
    for (const pass of this.builtin.passes) this.addPass(pass);
    installSurfaces(this);
    registerEffectSurfaces();
  }

  addPass(pass: GpuPass): void {
    let list = this.passes.get(pass.stage);
    if (!list) {
      list = [];
      this.passes.set(pass.stage, list);
    }
    list.push(pass);
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  removePass(pass: GpuPass): void {
    const list = this.passes.get(pass.stage);
    if (!list) return;
    const at = list.indexOf(pass);
    if (at >= 0) list.splice(at, 1);
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
    this.setSize(this.width, this.height, false);
  }

  getPixelRatio(): number {
    return this.pixelRatio;
  }

  setSize(width: number, height: number, updateStyle = true): void {
    this.width = width;
    this.height = height;
    const canvas = this.domElement;
    canvas.width = Math.max(1, Math.floor(width * this.pixelRatio));
    canvas.height = Math.max(1, Math.floor(height * this.pixelRatio));
    if (updateStyle) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.viewport.set(0, 0, width, height);
    this.scissor.set(0, 0, width, height);
  }

  getSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(this.width, this.height);
  }

  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(this.domElement.width, this.domElement.height);
  }

  setViewport(x: number | THREE.Vector4, y?: number, width?: number, height?: number): void {
    if (typeof x === "number") this.viewport.set(x, y ?? 0, width ?? this.width, height ?? this.height);
    else this.viewport.copy(x);
  }

  getViewport(target: THREE.Vector4): THREE.Vector4 {
    return target.copy(this.viewport);
  }

  setScissor(x: number | THREE.Vector4, y?: number, width?: number, height?: number): void {
    if (typeof x === "number") this.scissor.set(x, y ?? 0, width ?? this.width, height ?? this.height);
    else this.scissor.copy(x);
  }

  getScissor(target: THREE.Vector4): THREE.Vector4 {
    return target.copy(this.scissor);
  }

  setScissorTest(enabled: boolean): void {
    this.scissorTest = enabled;
  }

  getScissorTest(): boolean {
    return this.scissorTest;
  }

  setClearColor(color: THREE.ColorRepresentation, alpha = 1): void {
    this.clearColor.set(color);
    this.clearAlpha = alpha;
  }

  getClearColor(target: THREE.Color): THREE.Color {
    return target.copy(this.clearColor);
  }

  getClearAlpha(): number {
    return this.clearAlpha;
  }

  clear(): void { /* every frame starts cleared */ }
  clearDepth(): void { /* every frame starts cleared */ }

  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.renderTarget = target;
  }

  getRenderTarget(): THREE.WebGLRenderTarget | null {
    return this.renderTarget;
  }

  getContext(): GPUCanvasContext {
    return this.context;
  }

  compile(): void { /* pipelines are made as they are first drawn */ }

  compileAsync(): Promise<void> {
    return Promise.resolve();
  }

  readRenderTargetPixels(): void { /* no WebGL targets exist here */ }

  forceContextLoss(): void {
    this.core.device.destroy();
  }

  dispose(): void {
    this.disposed = true;
    for (const list of this.passes.values()) for (const pass of list) pass.dispose?.();
    this.passes.clear();
    this.destroyTargets();
    this.viewBuffer.destroy();
    this.timings.destroy();
    this.context.unconfigure();
  }

  private makeTarget(label: string, width: number, height: number, format: GPUTextureFormat, extraUsage = 0): GpuTarget {
    const texture = this.core.device.createTexture({
      label,
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | extraUsage,
    });
    return { texture, view: texture.createView() };
  }

  private destroyTargets(): void {
    for (const key of [...this.targetSets.keys()]) this.destroyTargetSet(key);
  }

  private destroyTargetSet(key: string): void {
    const set = this.targetSets.get(key);
    if (!set) return;
    const { targets } = set;
    for (const target of [targets.albedo, targets.normal, targets.emissive, targets.motion, targets.depth, targets.hdr]) target.texture.destroy();
    this.targetSets.delete(key);
  }

  private ensureTargets(width: number, height: number, frame: number): GpuTargets {
    const key = `${width}x${height}`;
    const existing = this.targetSets.get(key);
    if (existing) {
      existing.lastUsed = frame;
      return existing.targets;
    }
    // A size unused for a while is a window that was resized; its memory goes back.
    for (const [other, set] of this.targetSets) if (frame - set.lastUsed > TARGETS_KEPT_FRAMES) this.destroyTargetSet(other);
    const targets: GpuTargets = {
      width,
      height,
      albedo: this.makeTarget("gpu albedo", width, height, TARGET_FORMATS.albedo),
      normal: this.makeTarget("gpu normal", width, height, TARGET_FORMATS.normal),
      emissive: this.makeTarget("gpu emissive", width, height, TARGET_FORMATS.emissive),
      motion: this.makeTarget("gpu motion", width, height, TARGET_FORMATS.motion),
      depth: this.makeTarget("gpu depth", width, height, TARGET_FORMATS.depth),
      hdr: this.makeTarget("gpu hdr", width, height, TARGET_FORMATS.hdr, GPUTextureUsage.STORAGE_BINDING),
    };
    this.targetSets.set(key, { targets, lastUsed: frame });
    return targets;
  }

  /** The rectangle the current view draws to, in device pixels with y down, kept on the canvas. */
  private canvasRect(): { x: number; y: number; width: number; height: number } {
    const canvas = this.domElement;
    const rect = this.scissorTest ? this.scissor : this.viewport;
    const ratio = this.pixelRatio;
    const left = Math.max(0, Math.floor(rect.x * ratio));
    const width = Math.max(1, Math.min(canvas.width - left, Math.floor(rect.z * ratio)));
    const height = Math.max(1, Math.min(canvas.height, Math.floor(rect.w * ratio)));
    // three.js measures y from the bottom of the canvas.
    const top = Math.max(0, canvas.height - Math.floor(rect.y * ratio) - height);
    return { x: left, y: top, width, height };
  }

  /** Fills one view's uniform slice and returns its dynamic offset. Depth is reversed here, for everything. */
  private writeViewSlice(spec: GpuViewSpec & { previous?: THREE.Matrix4 | null; jitter?: readonly [number, number]; time?: number; pixelsPerUnit?: number; near?: number; far?: number }): number {
    const offset = this.viewCursor;
    if (offset >= MAX_VIEWS * VIEW_BYTES) throw new RangeError("Too many views in one frame");
    this.viewCursor += VIEW_BYTES;
    const data = this.viewData;
    const words = this.viewWords;
    data.fill(0);

    _unjittered.multiplyMatrices(_reverse, spec.projection);
    _projection.copy(_unjittered);
    const jitter = spec.jitter ?? [0, 0];
    if (jitter[0] || jitter[1]) {
      // A shift of the picture in clip space, whatever the projection: to x and y in proportion to w.
      const e = _projection.elements;
      const dx = (jitter[0] * 2) / spec.width;
      const dy = (jitter[1] * 2) / spec.height;
      for (let column = 0; column < 4; column++) {
        e[column * 4] += dx * e[column * 4 + 3];
        e[column * 4 + 1] += dy * e[column * 4 + 3];
      }
    }
    _viewProjection.multiplyMatrices(_projection, spec.matrixWorldInverse);
    _unjitteredViewProjection.multiplyMatrices(_unjittered, spec.matrixWorldInverse);
    data.set(_viewProjection.elements, 0);
    data.set(_unjitteredViewProjection.elements, 16);
    data.set((spec.previous ?? _unjitteredViewProjection).elements, 32);
    data.set(spec.matrixWorldInverse.elements, 48);
    data.set(_projection.elements, 64);
    data.set(_inverse.copy(_viewProjection).invert().elements, 80);
    data.set(_inverse.copy(_projection).invert().elements, 96);
    data[112] = spec.eye.x;
    data[113] = spec.eye.y;
    data[114] = spec.eye.z;
    data[115] = 1;
    // Planes as three.js finds them, normals pointing inward: its frustum reads the -1 to 1 range.
    _frustumMatrix.multiplyMatrices(spec.projection, spec.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_frustumMatrix);
    _frustum.planes.forEach((plane, index) => {
      data[116 + index * 4] = plane.normal.x;
      data[117 + index * 4] = plane.normal.y;
      data[118 + index * 4] = plane.normal.z;
      data[119 + index * 4] = plane.constant;
    });
    data[140] = spec.width;
    data[141] = spec.height;
    data[142] = 1 / spec.width;
    data[143] = 1 / spec.height;
    data[144] = jitter[0] / spec.width;
    data[145] = jitter[1] / spec.height;
    data[148] = spec.time ?? 0;
    data[149] = spec.pixelsPerUnit ?? 0;
    data[150] = spec.near ?? 0;
    data[151] = spec.far ?? 0;
    const lodEye = spec.lodEye ?? spec.eye;
    data[152] = lodEye.x;
    data[153] = lodEye.y;
    data[154] = lodEye.z;
    words[156] = (spec.layers ?? 0xffffffff) >>> 0;
    words[157] = spec.kind ?? 0;
    words[158] = 6;
    words[159] = spec.orthographic ? 1 : 0;
    this.core.device.queue.writeBuffer(this.viewBuffer, offset, data);
    return offset;
  }

  private bindScene(gpuScene: GpuScene): GPUBindGroup {
    const key = `${gpuScene.instanceBuffer.generation}/${this.geometries.vertices.generation}/${this.geometries.previousPositions.generation}/${gpuScene.instanceBuffer.buffer.label}`;
    if (this.sceneBindGroup && this.sceneBindKey === key && this.boundScene === gpuScene) return this.sceneBindGroup;
    this.boundScene = gpuScene;
    this.sceneBindKey = key;
    this.sceneBindGroup = this.core.device.createBindGroup({
      label: "gpu scene",
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: gpuScene.instanceBuffer.buffer } },
        { binding: 1, resource: { buffer: this.geometries.vertices.buffer } },
        { binding: 2, resource: { buffer: this.geometries.previousPositions.buffer } },
      ],
    });
    return this.sceneBindGroup;
  }

  private boundScene: GpuScene | null = null;

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    if (this.renderTarget) return; // Nothing drawn here goes to a WebGL target; what asks for one has its own path.
    const canvas = this.domElement;
    if (!canvas.width || !canvas.height) return;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (!camera.parent && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    const { core } = this;
    const { device } = core;

    const frameNumber = ++this.info.render.frame;
    let gpuScene = this.gpuScenes.get(scene);
    if (!gpuScene) {
      gpuScene = new GpuScene(device, this.geometries, this.materials);
      this.gpuScenes.set(scene, gpuScene);
    }
    gpuScene.extract(scene, frameNumber);
    this.reportUnsupported();

    const scale = this.settings.get("temporal.renderScale");
    const renderScale = typeof scale === "number" && scale > 0 ? Math.min(scale, 1) : 1;
    const viewport = this.canvasRect();
    const targets = this.ensureTargets(Math.max(1, Math.round(viewport.width * renderScale)), Math.max(1, Math.round(viewport.height * renderScale)), frameNumber);

    const now = performance.now();
    const time = (now - this.startTime) / 1000;
    const delta = Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.viewCursor = 0;

    const perspective = camera as THREE.PerspectiveCamera;
    camera.getWorldPosition(_eye);
    const previous = this.previousViewProjections.get(camera) ?? null;
    const jitterOf = this.settings.get("temporal.jitter") as ((frame: number) => readonly [number, number]) | undefined;
    const jitter = jitterOf ? jitterOf(frameNumber) : ([0, 0] as const);
    const mainViewOffset = this.writeViewSlice({
      projection: camera.projectionMatrix,
      matrixWorldInverse: camera.matrixWorldInverse,
      eye: _eye,
      width: targets.width,
      height: targets.height,
      layers: camera.layers.mask,
      kind: 0,
      orthographic: !perspective.isPerspectiveCamera,
      previous,
      jitter,
      time,
      pixelsPerUnit: perspective.isPerspectiveCamera ? targets.height / (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / perspective.zoom) : 0,
      near: perspective.near,
      far: perspective.far,
    });
    let stored = previous;
    if (!stored) {
      stored = new THREE.Matrix4();
      this.previousViewProjections.set(camera, stored);
    }
    _unjittered.multiplyMatrices(_reverse, camera.projectionMatrix);
    stored.multiplyMatrices(_unjittered, camera.matrixWorldInverse);

    const encoder = device.createCommandEncoder({ label: "gpu frame" });
    const canvasTexture = this.context.getCurrentTexture();
    const canvasLoadOp: GPULoadOp = canvasTexture === this.lastCanvasTexture ? "load" : "clear";
    this.lastCanvasTexture = canvasTexture;
    const lodEye = _eye.clone();
    const frame: GpuFrame = {
      core,
      device,
      encoder,
      scene,
      camera,
      gpuScene,
      geometries: this.geometries,
      materials: this.materials,
      textures: this.textures,
      targets,
      canvasView: canvasTexture.createView(),
      viewport,
      canvasLoadOp,
      presentFormat: core.presentFormat,
      frameNumber,
      time,
      delta,
      viewBuffer: this.viewBuffer,
      mainViewOffset,
      writeView: (spec) => this.writeViewSlice({ lodEye, ...spec, time, pixelsPerUnit: frame.products.get("mainPixelsPerUnit") as number | undefined }),
      cameraLayout: this.cameraLayout,
      cameraBindGroup: this.cameraBindGroup,
      sceneLayout: this.sceneLayout,
      sceneBindGroup: this.bindScene(gpuScene),
      drawer: this.builtin.drawer,
      products: this.products,
    };
    frame.products.set("mainPixelsPerUnit", perspective.isPerspectiveCamera ? targets.height / (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / perspective.zoom) : 0);
    this.settings.set("toneMappingExposure", this.toneMappingExposure);
    this.settings.set("toneMapping", this.toneMapping);
    frame.products.set("renderer", this);

    this.timings.begin(encoder);
    for (const stage of STAGE_ORDER) {
      if (stage === "overlay") {
        this.runPass(this.builtin.present, frame);
        this.timings.end(encoder, "present");
      }
      const list = this.passes.get(stage);
      if (list) for (const pass of list) this.runPass(pass, frame);
      this.timings.end(encoder, stage);
    }
    const readback = this.timings.finish(encoder);
    device.queue.submit([encoder.finish()]);
    this.timings.collect(readback);
  }

  /** Names each material nothing can draw yet, once: it is absent from the picture, and this is why. */
  private reportUnsupported(): void {
    for (const name of this.materials.unsupported) {
      if (this.reported.has(name)) continue;
      this.reported.add(name);
      console.warn(`[gpu] no surface draws ${name} yet`);
    }
  }

  private readonly reported = new Set<string>();

  /** A pass that throws stops running that frame's work only, and is named once. */
  private runPass(pass: GpuPass, frame: GpuFrame): void {
    try {
      pass.execute(frame);
    } catch (error) {
      if (!this.failedPasses.has(pass.id)) {
        this.failedPasses.add(pass.id);
        console.error(`[gpu] pass ${pass.id} failed`, error);
      }
    }
  }
}
