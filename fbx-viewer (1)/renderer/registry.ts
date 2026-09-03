/**
 * Process-wide renderer ownership and observability.
 *
 * Render surfaces are registered by stable id.  This is intentionally a small
 * coordinator rather than a renderer factory: backend creation stays inside
 * the surface or capture adapter and cannot leak into the public contract.
 */

export type RendererSurfaceRole = "presentation" | "capture" | "reference" | (string & {});
export type RendererLifecycle = "created" | "ready" | "lost" | "restoring" | "failed" | "disposed";
/** Capability-tier names intentionally mirror the renderer capability report. */
export type RendererCapabilityTier = "compatibility" | "portable-modern" | "native-advanced" | "research" | "unavailable";

export interface RendererCapabilities {
  webgl2: boolean;
  webgpu: boolean;
  timerQuery: boolean;
  maxTextureSize?: number;
  maxSamples?: number;
  renderer?: string;
}

export interface RendererMetrics {
  frames: number;
  lastFrameMs: number | null;
  averageFrameMs: number | null;
  fps: number | null;
  gpuFrameMs: number | null;
  drawCalls: number | null;
  triangles: number | null;
  memory: { geometries: number; textures: number; programs: number };
}

export interface RendererSurfaceSnapshot {
  contractVersion: "auvra.renderer/1";
  id: string;
  role: RendererSurfaceRole;
  lifecycle: RendererLifecycle;
  generation: number;
  selectedBackend: "webgl2" | "webgpu" | "unknown";
  tier: RendererCapabilityTier;
  fallbackReason: string | null;
  recoveryCount: number;
  capabilities: RendererCapabilities;
  metrics: RendererMetrics;
}

export interface RendererSurfaceRegistration {
  id: string;
  role: RendererSurfaceRole;
  canvas: HTMLCanvasElement;
  capabilities?: Partial<RendererCapabilities>;
  selectedBackend?: RendererSurfaceSnapshot["selectedBackend"];
  tier?: RendererSurfaceSnapshot["tier"];
  fallbackReason?: string | null;
  onContextLoss?: (event: Event) => void;
  onContextRestore?: (event: Event) => void;
}

type Listener = (snapshot: RendererSurfaceSnapshot) => void;

const DEFAULT_CAPABILITIES: RendererCapabilities = {
  webgl2: false,
  webgpu: false,
  timerQuery: false,
};

const emptyMetrics = (): RendererMetrics => ({
  frames: 0,
  lastFrameMs: null,
  averageFrameMs: null,
  fps: null,
  gpuFrameMs: null,
  drawCalls: null,
  triangles: null,
  memory: { geometries: 0, textures: 0, programs: 0 },
});

function detectCapabilities(canvas: HTMLCanvasElement): RendererCapabilities {
  const result: RendererCapabilities = { ...DEFAULT_CAPABILITIES };
  try {
    const webgl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    result.webgl2 = Boolean(webgl2);
    if (webgl2) {
      result.maxTextureSize = webgl2.getParameter(webgl2.MAX_TEXTURE_SIZE) as number;
      result.maxSamples = webgl2.getParameter(webgl2.MAX_SAMPLES) as number;
      result.renderer = (webgl2.getParameter(webgl2.RENDERER) as string | null) ?? undefined;
      result.timerQuery = Boolean(
        webgl2.getExtension("EXT_disjoint_timer_query_webgl2"),
      );
    }
  } catch {
    // Capability discovery is best effort; a failed probe is reported as false.
  }
  return result;
}

function copySnapshot(value: RendererSurfaceSnapshot): RendererSurfaceSnapshot {
  return {
    ...value,
    capabilities: { ...value.capabilities },
    metrics: { ...value.metrics, memory: { ...value.metrics.memory } },
  };
}

export class RendererRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererRegistryError";
  }
}

class RendererCoordinator {
  private readonly surfaces = new Map<string, RendererSurfaceSnapshot>();
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly listeners = new Set<Listener>();
  private readonly generations = new Map<string, number>();
  private readonly recoveryCounts = new Map<string, number>();
  private readonly recoveryAttempts = new Map<string, number>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerSurface(registration: RendererSurfaceRegistration): RendererSurfaceSnapshot {
    const id = registration.id.trim();
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      throw new RendererRegistryError("Renderer surface id must be a stable safe identifier");
    }
    if (this.surfaces.has(id)) {
      const message = `Renderer surface is already registered: ${id}`;
      throw new RendererRegistryError(message);
    }
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const snapshot: RendererSurfaceSnapshot = {
      contractVersion: "auvra.renderer/1",
      id,
      role: registration.role,
      lifecycle: "created",
      generation,
      selectedBackend: registration.selectedBackend ?? "webgl2",
      tier: registration.tier ?? "compatibility",
      fallbackReason: registration.fallbackReason ?? null,
      recoveryCount: this.recoveryCounts.get(id) ?? 0,
      capabilities: { ...detectCapabilities(registration.canvas), ...registration.capabilities },
      metrics: emptyMetrics(),
    };
    this.surfaces.set(id, snapshot);
    this.canvases.set(id, registration.canvas);
    this.emit(snapshot);
    return copySnapshot(snapshot);
  }

  unregisterSurface(id: string): void {
    const current = this.surfaces.get(id);
    if (!current) return;
    current.lifecycle = "disposed";
    this.emit(current);
    this.surfaces.delete(id);
    this.canvases.delete(id);
    this.resetRecoveryState(id);
  }

  setLifecycle(id: string, lifecycle: RendererLifecycle): void {
    const surface = this.requireSurface(id);
    surface.lifecycle = lifecycle;
    if (lifecycle === "restoring") {
      surface.generation += 1;
      const recoveryCount = (this.recoveryCounts.get(id) ?? 0) + 1;
      this.recoveryCounts.set(id, recoveryCount);
      surface.recoveryCount = recoveryCount;
    }
    this.emit(surface);
  }

  markContextLost(id: string): void { this.setLifecycle(id, "lost"); }
  markContextRestoring(id: string): void { this.setLifecycle(id, "restoring"); }
  markFailed(id: string): void { this.setLifecycle(id, "failed"); }
  beginRecovery(id: string, maxAttempts = 2): boolean {
    const attempts = (this.recoveryAttempts.get(id) ?? 0) + 1;
    this.recoveryAttempts.set(id, attempts);
    return attempts <= maxAttempts;
  }
  markContextRestored(id: string, capabilities?: Partial<RendererCapabilities>): void {
    const surface = this.requireSurface(id);
    surface.lifecycle = "ready";
    surface.capabilities = { ...surface.capabilities, ...capabilities };
    // Recovery limits apply to one consecutive failure streak.  A successful
    // restore gives the surface a fresh budget for a later, unrelated loss.
    this.resetRecoveryState(id);
    surface.recoveryCount = 0;
    this.emit(surface);
  }

  markReady(id: string): void { this.setLifecycle(id, "ready"); }

  recordFrame(id: string, durationMs: number, rendererInfo?: { calls?: number; triangles?: number; geometries?: number; textures?: number; programs?: number; gpuFrameMs?: number | null }): void {
    const surface = this.requireSurface(id);
    const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const metrics = surface.metrics;
    metrics.frames += 1;
    metrics.lastFrameMs = duration;
    metrics.averageFrameMs = metrics.averageFrameMs === null ? duration : metrics.averageFrameMs * 0.9 + duration * 0.1;
    metrics.fps = metrics.averageFrameMs > 0 ? 1000 / metrics.averageFrameMs : null;
    if (rendererInfo?.gpuFrameMs !== undefined) metrics.gpuFrameMs = rendererInfo.gpuFrameMs;
    if (rendererInfo) {
      metrics.drawCalls = rendererInfo.calls ?? metrics.drawCalls;
      metrics.triangles = rendererInfo.triangles ?? metrics.triangles;
      metrics.memory = {
        geometries: rendererInfo.geometries ?? metrics.memory.geometries,
        textures: rendererInfo.textures ?? metrics.memory.textures,
        programs: rendererInfo.programs ?? metrics.memory.programs,
      };
    }
    this.emit(surface);
  }

  updateMemory(id: string, memory: Partial<RendererMetrics["memory"]>): void {
    const surface = this.requireSurface(id);
    surface.metrics.memory = { ...surface.metrics.memory, ...memory };
    this.emit(surface);
  }

  getSnapshot(id?: string): RendererSurfaceSnapshot | RendererSurfaceSnapshot[] {
    if (id) return copySnapshot(this.requireSurface(id));
    return [...this.surfaces.values()].map(copySnapshot);
  }

  getCanvas(id: string): HTMLCanvasElement | undefined { return this.canvases.get(id); }

  simulateContextLoss(id: string): boolean {
    const canvas = this.canvases.get(id);
    if (!canvas) return false;
    let context: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try {
      context = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      const loss = context?.getExtension("WEBGL_lose_context") as { loseContext: () => void; restoreContext: () => void } | null;
      if (loss) {
        loss.loseContext();
        // Give the browser time to deliver and process webglcontextlost before
        // requesting restoration; a zero-delay restore can collapse the
        // observable lost state in some WebView implementations.
        setTimeout(() => loss.restoreContext(), 100);
        return true;
      }
    } catch {
      // Fall through to the deterministic synthetic event when the browser
      // does not expose WEBGL_lose_context.
    }
    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);
    return true;
  }

  private requireSurface(id: string): RendererSurfaceSnapshot {
    const surface = this.surfaces.get(id);
    if (!surface) throw new RendererRegistryError(`Unknown renderer surface: ${id}`);
    return surface;
  }

  private resetRecoveryState(id: string): void {
    this.recoveryCounts.delete(id);
    this.recoveryAttempts.delete(id);
  }

  private emit(snapshot: RendererSurfaceSnapshot): void {
    const copy = copySnapshot(snapshot);
    this.listeners.forEach((listener) => listener(copy));
  }
}

/** The one process-wide renderer coordinator. */
export const rendererCoordinator = new RendererCoordinator();

export type { RendererCoordinator };
