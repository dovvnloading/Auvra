import * as THREE from "three";
import type { RendererCapabilities } from "./registry";

export type ReferenceBackend = "webgl2" | "webgpu";
export interface ReferenceBudget { maxCpuP95Ms: number; maxGpuFrameMs: number; maxMemoryBytes: number; }
export interface ReferenceMeasurement {
  backend: ReferenceBackend;
  supported: boolean;
  qualified: boolean;
  /** Compatibility alias for consumers that only understand one CPU value. */
  cpuMs: number | null;
  cpuP95Ms: number | null;
  /** GPU elapsed time from EXT_disjoint_timer_query, when available. */
  gpuFrameMs: number | null;
  /** Deprecated alias; null unless an actual GPU timer value exists. */
  pixelMs: number | null;
  memoryBytes: number | null;
  memoryEstimateKind: "heuristic-resource-count" | "unavailable";
  memoryCounts: { geometries: number; textures: number } | null;
  /** Bounded 4x4 RGBA readback signature; informational, never a budget input. */
  pixelSignature: string | null;
  timerQuery: boolean;
  fallback?: ReferenceBackend;
  reason?: string;
}
export interface ReferenceSuiteResult { sceneId: "basic"; requested: ReferenceBackend; selected: ReferenceBackend; fallbackReason?: string; capabilities: RendererCapabilities; pixelSignature: string | null; results: ReferenceMeasurement[]; measurements: ReferenceMeasurement[]; budget: ReferenceBudget; passed: boolean; }

// Immutable acceptance baseline: changing this requires a Stage 5 decision.
export const REFERENCE_BASELINE: Readonly<ReferenceBudget> = Object.freeze({ maxCpuP95Ms: 25, maxGpuFrameMs: 33.4, maxMemoryBytes: 128 * 1024 * 1024 });

export interface ReferenceBackendRequest { preferred?: ReferenceBackend; allowExperimentalWebGPU?: boolean; }

function createBasicScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101318);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(2.5, 2, 4);
  camera.lookAt(0, 0, 0);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x4d9be6, roughness: 0.65, metalness: 0.1 });
  scene.add(new THREE.Mesh(geometry, material));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(2, 3, 4);
  scene.add(light);
  return { scene, camera };
}

function unavailableMeasurement(backend: ReferenceBackend, reason: string, fallback?: ReferenceBackend): ReferenceMeasurement {
  return { backend, supported: false, qualified: false, cpuMs: null, cpuP95Ms: null, gpuFrameMs: null, pixelMs: null, memoryBytes: null, memoryEstimateKind: "unavailable", memoryCounts: null, pixelSignature: null, timerQuery: false, fallback, reason };
}

function percentile95(samples: number[]): number | null {
  if (!samples.length) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
}

function readPixelSignature(context: WebGL2RenderingContext): string | null {
  try {
    const pixels = new Uint8Array(4 * 4 * 4);
    context.readPixels(0, 0, 4, 4, context.RGBA, context.UNSIGNED_BYTE, pixels);
    if (context.getError() !== context.NO_ERROR) return null;
    return Array.from(pixels, (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function selectBackend(request: ReferenceBackendRequest, capabilities: RendererCapabilities): { selected: ReferenceBackend; fallback?: ReferenceBackend; reason?: string } {
  const preferred = request.preferred ?? "webgl2";
  if (preferred === "webgpu") {
    if (request.allowExperimentalWebGPU && capabilities.webgpu) return { selected: "webgpu" };
    return { selected: "webgl2", fallback: "webgl2", reason: "WebGPU is experimental or unavailable; retaining measured WebGL2 compatibility fallback" };
  }
  if (preferred === "webgl2" && capabilities.webgl2) return { selected: "webgl2" };
  return { selected: preferred, reason: "No compatible WebGL context" };
}

function measureWebGL(backend: ReferenceBackend, width: number, height: number): ReferenceMeasurement {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    const { scene, camera } = createBasicScene();
    // Warm up shader compilation and lazy GPU allocations before sampling.
    for (let index = 0; index < 3; index += 1) renderer.render(scene, camera);
    const samples: number[] = [];
    let gpuFrameMs: number | null = null;
    const context = renderer.getContext();
    const webgl2 = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext;
    const timerExtension = webgl2
      ? context.getExtension("EXT_disjoint_timer_query_webgl2") as (WebGL2RenderingContext & { TIME_ELAPSED_EXT?: number }) | null
      : context.getExtension("EXT_disjoint_timer_query") as (WebGLRenderingContext & { TIME_ELAPSED_EXT?: number }) | null;
    for (let index = 0; index < 9; index += 1) {
      const before = performance.now();
      renderer.render(scene, camera);
      samples.push(performance.now() - before);
    }
    if (timerExtension) {
      const elapsed = measureTimerQuery(context, timerExtension, () => renderer!.render(scene, camera));
      gpuFrameMs = elapsed;
    }
    const cpuP95Ms = percentile95(samples);
    const info = renderer.info;
    const memoryBytes = (info.memory.geometries * 64 * 1024) + (info.memory.textures * 256 * 1024);
    const pixelSignature = webgl2 ? readPixelSignature(context) : null;
    scene.traverse((item) => {
      const mesh = item as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(material) ? material : material ? [material] : []).forEach((entry) => entry.dispose());
    });
    const timerQuery = gpuFrameMs !== null;
    const qualified = cpuP95Ms !== null && cpuP95Ms <= REFERENCE_BASELINE.maxCpuP95Ms && (gpuFrameMs === null || gpuFrameMs <= REFERENCE_BASELINE.maxGpuFrameMs) && memoryBytes <= REFERENCE_BASELINE.maxMemoryBytes;
    return { backend, supported: true, qualified, cpuMs: cpuP95Ms, cpuP95Ms, gpuFrameMs, pixelMs: gpuFrameMs, memoryBytes, memoryEstimateKind: "heuristic-resource-count", memoryCounts: { geometries: info.memory.geometries, textures: info.memory.textures }, pixelSignature, timerQuery };
  } catch (error) {
    return unavailableMeasurement(backend, error instanceof Error ? error.message : "WebGL reference failed");
  } finally {
    renderer?.dispose();
  }
}

interface TimerExtension {
  TIME_ELAPSED_EXT?: number;
  createQueryEXT?: () => unknown;
  beginQueryEXT?: (target: number, query: unknown) => void;
  endQueryEXT?: (target: number) => void;
  getQueryObjectEXT?: (query: unknown, parameter: number) => unknown;
  QUERY_RESULT_AVAILABLE_EXT?: number;
  QUERY_RESULT_EXT?: number;
  GPU_DISJOINT_EXT?: number;
}

function measureTimerQuery(context: WebGLRenderingContext | WebGL2RenderingContext, extension: TimerExtension, render: () => void): number | null {
  try {
    const isWebgl2 = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext;
    if (isWebgl2) {
      const gl = context as WebGL2RenderingContext;
      const query = gl.createQuery();
      if (!query) return null;
      gl.beginQuery((extension.TIME_ELAPSED_EXT as number) ?? 0x88bf, query);
      render();
      gl.endQuery((extension.TIME_ELAPSED_EXT as number) ?? 0x88bf);
      gl.finish();
      if (gl.getParameter((extension.GPU_DISJOINT_EXT as number) ?? 0x8fbb)) { gl.deleteQuery(query); return null; }
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      const value = available ? Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1_000_000 : null;
      gl.deleteQuery(query);
      return Number.isFinite(value) ? value : null;
    }
    const ext = extension;
    if (!ext.createQueryEXT || !ext.beginQueryEXT || !ext.endQueryEXT || !ext.getQueryObjectEXT) return null;
    const query = ext.createQueryEXT();
    ext.beginQueryEXT((extension.TIME_ELAPSED_EXT as number) ?? 0x88bf, query);
    render();
    ext.endQueryEXT((extension.TIME_ELAPSED_EXT as number) ?? 0x88bf);
    context.finish();
    if (context.getParameter((extension.GPU_DISJOINT_EXT as number) ?? 0x8fbb)) return null;
    const available = ext.getQueryObjectEXT(query, ext.QUERY_RESULT_AVAILABLE_EXT ?? 0x8867);
    const value = available ? Number(ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT ?? 0x8866)) / 1_000_000 : null;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

interface WebGpuQueueAdapter {
  submit(commands: ReadonlyArray<unknown>): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface WebGpuRenderPassAdapter {
  setPipeline(pipeline: unknown): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface WebGpuCommandEncoderAdapter {
  beginRenderPass(descriptor: unknown): WebGpuRenderPassAdapter;
  finish(): unknown;
}

interface WebGpuDeviceAdapter {
  readonly queue: WebGpuQueueAdapter;
  createShaderModule(descriptor: { code: string }): unknown;
  createRenderPipeline(descriptor: unknown): unknown;
  createCommandEncoder(): WebGpuCommandEncoderAdapter;
  destroy?(): void;
}

interface WebGpuAdapter {
  requestDevice(): Promise<WebGpuDeviceAdapter>;
}

interface WebGpuApi {
  requestAdapter(): Promise<WebGpuAdapter | null>;
  getPreferredCanvasFormat(): string;
}

interface WebGpuCanvasContextAdapter {
  configure(descriptor: { device: WebGpuDeviceAdapter; format: string; alphaMode: "opaque" }): void;
  getCurrentTexture(): { createView(): unknown };
  unconfigure?(): void;
}

const WEBGPU_REFERENCE_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(0.0, 0.65),
    vec2f(-0.65, -0.55),
    vec2f(0.65, -0.55),
  );
  let colors = array<vec3f, 3>(
    vec3f(0.30, 0.61, 0.90),
    vec3f(0.18, 0.32, 0.55),
    vec3f(0.45, 0.74, 1.00),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.color = colors[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

async function measureWebGPU(): Promise<ReferenceMeasurement> {
  const gpu = typeof navigator !== "undefined" ? (navigator as Navigator & { gpu?: WebGpuApi }).gpu : undefined;
  if (!gpu) return unavailableMeasurement("webgpu", "WebGPU is unavailable", "webgl2");
  let device: WebGpuDeviceAdapter | null = null;
  let context: WebGpuCanvasContextAdapter | null = null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter is unavailable");
    device = await adapter.requestDevice();
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    context = canvas.getContext("webgpu") as unknown as WebGpuCanvasContextAdapter | null;
    if (!context) throw new Error("WebGPU canvas context is unavailable");
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const shader = device.createShaderModule({ code: WEBGPU_REFERENCE_SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vertexMain" },
      fragment: { module: shader, entryPoint: "fragmentMain", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const render = () => {
      const encoder = device!.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context!.getCurrentTexture().createView(),
          clearValue: { r: 0.063, g: 0.075, b: 0.094, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device!.queue.submit([encoder.finish()]);
    };
    for (let index = 0; index < 3; index += 1) render();
    await device.queue.onSubmittedWorkDone();
    const samples: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const started = performance.now();
      render();
      samples.push(performance.now() - started);
    }
    await device.queue.onSubmittedWorkDone();
    const cpuMs = percentile95(samples);
    return { backend: "webgpu", supported: true, qualified: false, cpuMs, cpuP95Ms: cpuMs, gpuFrameMs: null, pixelMs: null, memoryBytes: null, memoryEstimateKind: "unavailable", memoryCounts: null, pixelSignature: null, timerQuery: false, fallback: "webgl2", reason: "The native WebGPU reference probe is experimental and does not qualify without pixel and memory measurements" };
  } catch (error) {
    return unavailableMeasurement("webgpu", error instanceof Error ? error.message : "WebGPU reference failed", "webgl2");
  } finally {
    context?.unconfigure?.();
    device?.destroy?.();
  }
}

/** Runs only deterministic WebGL measurements; WebGPU remains opt-in. */
export async function runReferenceSuite(request: ReferenceBackendRequest = {}): Promise<ReferenceSuiteResult> {
  if (typeof document === "undefined") {
    const requested = request.preferred ?? "webgl2";
    const unavailable = unavailableMeasurement(requested, "Reference suite requires a browser document", "webgl2");
    return { sceneId: "basic", requested, selected: requested, capabilities: { webgl2: false, webgpu: false, timerQuery: false }, pixelSignature: null, results: [unavailable], measurements: [unavailable], budget: REFERENCE_BASELINE, passed: false };
  }
  const probe = document.createElement("canvas");
  const webgl2 = Boolean(probe.getContext("webgl2"));
  const webgpu = typeof navigator !== "undefined" && Boolean((navigator as Navigator & { gpu?: WebGpuApi }).gpu);
  const capabilities: RendererCapabilities = { webgl2, webgpu, timerQuery: false };
  const choice = selectBackend(request, capabilities);
  let selected = choice.selected;
  let fallbackReason = choice.reason;
  const measurements: ReferenceMeasurement[] = [];
  if (choice.selected === "webgpu") {
    const webgpuResult = await measureWebGPU();
    measurements.push({ ...webgpuResult, fallback: "webgl2" });
    if (!webgpuResult.qualified) {
      selected = "webgl2";
      fallbackReason = "WebGPU is unqualified for the basic reference scene; using WebGL2 compatibility fallback";
    }
  }
  if (selected === "webgl2") measurements.push(measureWebGL(selected, 256, 256));
  const selectedMeasurement = measurements.find((entry) => entry.backend === selected && entry.supported);
  return { sceneId: "basic", requested: request.preferred ?? "webgl2", selected, fallbackReason, capabilities, pixelSignature: selectedMeasurement?.pixelSignature ?? null, results: measurements, measurements, budget: REFERENCE_BASELINE, passed: Boolean(selectedMeasurement?.qualified), };
}

export const referenceScenes = Object.freeze({ basic: createBasicScene });
export { selectBackend };
