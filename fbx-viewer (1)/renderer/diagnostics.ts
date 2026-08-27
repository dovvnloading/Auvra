import { rendererCoordinator, type RendererSurfaceSnapshot } from "./registry";
import { runReferenceSuite, type ReferenceBackendRequest, type ReferenceSuiteResult } from "./referenceScenes";
import { runNativeReferenceGate, type NativeReferenceResult } from "./nativeReference";

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
  const unsubscribe = rendererCoordinator.subscribe((snapshot) => {
    if (lastLifecycle.get(snapshot.id) === snapshot.lifecycle) return;
    lastLifecycle.set(snapshot.id, snapshot.lifecycle);
    window.dispatchEvent(new CustomEvent("auvra:renderer-lifecycle", { detail: snapshot }));
  });
  return () => {
    unsubscribe();
    lastLifecycle.clear();
    if (window.__AUVRA_RENDERER__ === api) {
      if (previous) window.__AUVRA_RENDERER__ = previous;
      else delete window.__AUVRA_RENDERER__;
    }
  };
}
