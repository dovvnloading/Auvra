import { rendererCoordinator, type RendererSurfaceSnapshot } from "./registry";
import { runReferenceSuite, type ReferenceBackendRequest, type ReferenceSuiteResult } from "./referenceScenes";
import { runNativeReferenceGate, type NativeReferenceResult } from "./nativeReference";
import { frontendDiagnostics } from "../diagnostics/runtime";

export interface RendererDiagnosticsApi {
  getSnapshot(): { contractVersion: "auvra.renderer/1"; surfaces: RendererSurfaceSnapshot[] };
  runReferenceSuite(request?: "auto" | "webgpu" | "webgl2"): Promise<ReferenceSuiteResult>;
  runNativeReferenceGate(width?: number, height?: number): Promise<NativeReferenceResult>;
  simulateContextLoss(surfaceId: string): boolean;
}

declare global {
  interface Window { __AUVRA_RENDERER__?: RendererDiagnosticsApi; }
}

export function installRendererDiagnostics(): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;
  const previous = window.__AUVRA_RENDERER__;
  const api: RendererDiagnosticsApi = {
    getSnapshot: () => ({ contractVersion: "auvra.renderer/1", surfaces: rendererCoordinator.getSnapshot() as RendererSurfaceSnapshot[] }),
    runReferenceSuite: (request = "auto") => runReferenceSuite(request === "auto" ? {} : { preferred: request, allowExperimentalWebGPU: request === "webgpu" }),
    runNativeReferenceGate,
    simulateContextLoss: (surfaceId) => rendererCoordinator.simulateContextLoss(surfaceId),
  };
  window.__AUVRA_RENDERER__ = api;
  const lastLifecycle = new Map<string, RendererSurfaceSnapshot["lifecycle"]>();
  const backendRecorded = new Set<string>();
  const recoveryStartedAt = new Map<string, number>();
  const degradedAt = new Map<string, number>();
  const unsubscribe = rendererCoordinator.subscribe((snapshot) => {
    if (!backendRecorded.has(snapshot.id)) {
      backendRecorded.add(snapshot.id);
      frontendDiagnostics.record("renderer", "renderer.backend_selected", {
        backend: snapshot.selectedBackend,
        fallback: Boolean(snapshot.fallbackReason),
        ...(snapshot.fallbackReason ? { fallbackReason: "requested_backend_unavailable" } : {}),
        surfaceRole: snapshot.role,
      });
    }
    if (lastLifecycle.get(snapshot.id) === snapshot.lifecycle) return;
    const previousLifecycle = lastLifecycle.get(snapshot.id);
    lastLifecycle.set(snapshot.id, snapshot.lifecycle);
    if (snapshot.lifecycle === "lost") {
      recoveryStartedAt.set(snapshot.id, performance.now());
      frontendDiagnostics.record("renderer", "renderer.context_lost", {
        code: "render_context_lost", surfaceRole: snapshot.role,
      }, {}, true);
    } else if (snapshot.lifecycle === "restoring") {
      frontendDiagnostics.record("renderer", "renderer.recovery_started", {
        code: "render_context_recovery", count: snapshot.recoveryCount, surfaceRole: snapshot.role,
      });
    } else if (snapshot.lifecycle === "ready" && (previousLifecycle === "lost" || previousLifecycle === "restoring")) {
      const started = recoveryStartedAt.get(snapshot.id);
      frontendDiagnostics.record("renderer", "renderer.recovered", {
        durationMs: started === undefined ? 0 : performance.now() - started,
        count: snapshot.recoveryCount,
        surfaceRole: snapshot.role,
      }, {}, true);
      recoveryStartedAt.delete(snapshot.id);
    } else if (snapshot.lifecycle === "failed") {
      frontendDiagnostics.record("renderer", "renderer.recovery_failed", {
        backend: snapshot.selectedBackend,
        code: "render_context_recovery_failed",
        surfaceRole: snapshot.role,
      }, {}, true);
    }
    window.dispatchEvent(new CustomEvent("auvra:renderer-lifecycle", { detail: snapshot }));
  });
  const performanceTimer = window.setInterval(() => {
    const snapshots = rendererCoordinator.getSnapshot();
    const surfaces = Array.isArray(snapshots) ? snapshots : [snapshots];
    for (const snapshot of surfaces) {
      if (snapshot.lifecycle !== "ready" || snapshot.role === "capture") continue;
      const averageFrameMs = snapshot.metrics.averageFrameMs;
      if (averageFrameMs === null) continue;
      const budgetMs = 33.34;
      if (averageFrameMs > budgetMs && !degradedAt.has(snapshot.id)) {
        degradedAt.set(snapshot.id, performance.now());
        frontendDiagnostics.record("renderer", "renderer.performance_degraded", {
          averageFrameMs, budgetMs, count: snapshot.metrics.frames, surfaceRole: snapshot.role,
        });
      } else if (averageFrameMs <= budgetMs && degradedAt.has(snapshot.id)) {
        const started = degradedAt.get(snapshot.id)!;
        degradedAt.delete(snapshot.id);
        frontendDiagnostics.record("renderer", "renderer.performance_recovered", {
          durationMs: performance.now() - started, surfaceRole: snapshot.role,
        });
      }
    }
  }, 10_000);
  return () => {
    unsubscribe();
    window.clearInterval(performanceTimer);
    lastLifecycle.clear();
    backendRecorded.clear();
    recoveryStartedAt.clear();
    degradedAt.clear();
    if (window.__AUVRA_RENDERER__ === api) {
      if (previous) window.__AUVRA_RENDERER__ = previous;
      else delete window.__AUVRA_RENDERER__;
    }
  };
}
