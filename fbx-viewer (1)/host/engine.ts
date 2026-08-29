import { getHostTransport } from "./bootstrap";
import type { Event, Response } from "./generated/protocolV1";
import { frontendDiagnostics, type DiagnosticContext } from '../diagnostics/runtime';

export interface NativeEngineStatus {
  protocol: "auvra.native/1";
  status: "starting" | "ready" | "degraded" | "stopped" | "failed";
  worldRevision: number;
  tick?: number;
  projectId?: string | null;
  projectRevision?: number;
  worldHash?: string;
  replayHash?: string;
  extractionHash?: string;
  viewport: "closed" | "opening" | "open" | "recovering";
  backend?: string;
  adapter?: string;
  fallbackReason?: string | null;
  featureCapabilities?: Array<{
    feature: "pbr_metallic_roughness" | "skeletal_animation" | "frustum_culling" | "deterministic_lod" | "instance_batching" | "directional_lights" | "point_lights" | "spot_lights" | "shadow_maps" | "image_based_lighting" | "entity_picking" | "editor_gizmos" | "hdr_intermediate" | "aces_tone_mapping" | "msaa_or_fxaa" | "post_processing_chain";
    supported: boolean;
    fallbackReason: string | null;
  }>;
  dockSupport?: "unsupported" | "same-build";
  dockActive?: boolean;
  dockReason?: string | null;
  metrics?: {
    startupMs: number;
    frameCpuMs: number | null;
    gpuFrameMs: number | null;
    memoryBytes: number;
    recoveryCount: number;
  };
}

type HostLike = {
  session?: string | null;
  currentRevision?: number;
  ready?: () => Promise<unknown>;
  request: (request: unknown) => Promise<Response>;
  subscribe: (listener: (event: Event) => void) => () => void;
};

const STOPPED: NativeEngineStatus = {
  protocol: "auvra.native/1",
  status: "stopped",
  worldRevision: 0,
  viewport: "closed",
};
const QUIET_ENGINE_METHODS = new Set(['engine.getStatus', 'engine.getSnapshot', 'engine.getMetrics']);

/** UI-side client for the host-owned, long-lived native engine process. */
export class NativeEngineService {
  private host: HostLike | null = null;
  private session: string | null = null;
  private wireRevision = 0;
  private counter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private value: NativeEngineStatus = { ...STOPPED };
  private readonly listeners = new Set<(status: NativeEngineStatus) => void>();
  private unsubscribeHost: (() => void) | null = null;

  getStatus(): NativeEngineStatus {
    return {
      ...this.value,
      metrics: this.value.metrics ? { ...this.value.metrics } : undefined,
      featureCapabilities: this.value.featureCapabilities?.map((capability) => ({ ...capability })),
    };
  }

  subscribe(listener: (status: NativeEngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<NativeEngineStatus> { return this.call("engine.getStatus", {}); }
  getSnapshot(): Promise<NativeEngineStatus & { entities?: unknown[] }> { return this.call("engine.getSnapshot", {}); }
  applyChanges(expectedRevision: number, entities: Array<{ id: string; position: [number, number, number]; color: [number, number, number, number] }>): Promise<NativeEngineStatus> {
    return this.call("engine.applyChanges", { expectedRevision, entities });
  }
  openViewport(width = 1280, height = 720): Promise<NativeEngineStatus> { return this.call("engine.openViewport", { width, height, title: "Auvra Native Viewport" }); }
  closeViewport(): Promise<NativeEngineStatus> { return this.call("engine.closeViewport", {}); }
  renderReference(width = 256, height = 256): Promise<NativeEngineStatus & { referenceScene?: "basic"; referenceVersion?: 1; signature?: string; width?: number; height?: number }> {
    return this.call("engine.renderReference", { sceneId: "basic", width, height });
  }
  getMetrics(): Promise<NativeEngineStatus> { return this.call("engine.getMetrics", {}); }
  recover(): Promise<NativeEngineStatus> { return this.call("engine.recover", {}); }

  private call<T extends NativeEngineStatus>(method: string, payload: Record<string, unknown>): Promise<T> {
    const span = frontendDiagnostics.startSpan('engine', method, {
      category: 'service', detailedOnly: QUIET_ENGINE_METHODS.has(method),
    });
    span.phase('queued', { method });
    const run = () => {
      span.phase('executing', { method });
      return this.performCall<T>(method, payload, span.context);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    void result.then(
      () => span.finish('success', 'engine_status'),
      (error) => { span.fail(error, 'engine_operation_failed'); span.finish('failure'); },
    );
    return result;
  }

  private async performCall<T extends NativeEngineStatus>(method: string, payload: Record<string, unknown>, diagnostics: DiagnosticContext): Promise<T> {
    await this.ensureSession();
    if (!this.session) throw new Error("The native engine host is not ready");
    const requestNumber = ++this.counter;
    const traceId = diagnostics.traceId ?? '';
    const response = await frontendDiagnostics.withContext(diagnostics, () => this.getHost().request({
      protocol: "auvra.host/1", type: "request",
      id: traceId ? `${traceId}.req-${requestNumber}` : `engine-${requestNumber}`,
      session: this.session, revision: this.wireRevision, method, payload,
    }));
    if (typeof response.revision === "number") this.wireRevision = response.revision;
    if (response.ok !== true) {
      const error = 'error' in response ? response.error : undefined;
      throw new Error(error?.message || error?.code || 'Native engine request failed');
    }
    const result = response.result as unknown as T;
    this.update(result);
    return result;
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    const host = this.getHost();
    if (host.ready) {
      const envelope = await host.ready() as { session?: string; revision?: number };
      this.session = envelope.session ?? null;
      this.wireRevision = envelope.revision ?? this.wireRevision;
    } else {
      this.session = host.session ?? null;
      this.wireRevision = host.currentRevision ?? this.wireRevision;
    }
  }

  private getHost(): HostLike {
    if (!this.host) {
      this.host = getHostTransport() as unknown as HostLike;
      this.unsubscribeHost = this.host.subscribe((event) => this.handleEvent(event));
    }
    return this.host;
  }

  private handleEvent(event: Event): void {
    if (typeof event.revision === "number") this.wireRevision = event.revision;
    if (event.event === "host.session") this.session = event.session;
    if (event.event.startsWith("engine.")) this.update(event.payload as unknown as Partial<NativeEngineStatus>);
  }

  private update(value: Partial<NativeEngineStatus>): void {
    if (!value || typeof value !== "object") return;
    this.value = { ...this.value, ...value, protocol: "auvra.native/1" };
    const snapshot = this.getStatus();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

frontendDiagnostics.instrumentClass(NativeEngineService, 'engine_service');
export const nativeEngine = new NativeEngineService();
