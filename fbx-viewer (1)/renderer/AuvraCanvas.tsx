import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type CanvasProps } from "@react-three/fiber";
import * as THREE from "three";
import { nativeEngine, type NativeEngineStatus } from "../host/engine";
import { rendererCoordinator, type RendererSurfaceRole } from "./registry";

type AuvraCanvasGlOptions = Partial<THREE.WebGLRendererParameters> & Partial<Pick<THREE.WebGLRenderer, "outputColorSpace" | "toneMapping" | "toneMappingExposure">>;

export interface AuvraCanvasProps extends Omit<CanvasProps, "onCreated" | "gl"> {
  surfaceId: string;
  role?: RendererSurfaceRole;
  recoveryTimeoutMs?: number;
  gl?: AuvraCanvasGlOptions;
}

const RendererMetricsReporter: React.FC<{ surfaceId: string }> = ({ surfaceId }) => {
  const { gl } = useThree();
  useFrame((_state, delta) => {
    const info = (gl as THREE.WebGLRenderer).info;
    rendererCoordinator.recordFrame(surfaceId, delta * 1000, {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    });
  });
  return null;
};

const RendererLifecycleBridge: React.FC<{
  surfaceId: string;
  role: RendererSurfaceRole;
  requestedBackend: "auto" | "webgpu" | "webgl2";
  fallbackReasonOverride?: string | null;
  recoveryTimeoutMs: number;
  remount: () => void;
}> = ({ surfaceId, role, requestedBackend, fallbackReasonOverride, recoveryTimeoutMs, remount }) => {
  const { gl } = useThree();
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const renderer = gl as THREE.WebGLRenderer;
    const canvas = renderer.domElement;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    const fallbackReason = fallbackReasonOverride ?? (requestedBackend === "webgpu" ? "WebGPU is experimental and unqualified for presentation; using the measured WebGL2 compatibility backend" : null);
    rendererCoordinator.registerSurface({ id: surfaceId, role, canvas, selectedBackend: "webgl2", tier: "compatibility", fallbackReason });
    rendererCoordinator.markReady(surfaceId);
    const onLost = (event: Event) => {
      event.preventDefault();
      rendererCoordinator.markContextLost(surfaceId);
      if (!rendererCoordinator.beginRecovery(surfaceId, 2)) {
        rendererCoordinator.markFailed(surfaceId);
        return;
      }
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
      Promise.resolve().then(() => {
        try {
          const snapshot = rendererCoordinator.getSnapshot(surfaceId);
          if (Array.isArray(snapshot) || snapshot.lifecycle !== "lost") return;
          rendererCoordinator.markContextRestoring(surfaceId);
        } catch { return; }
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = null;
          try { rendererCoordinator.markFailed(surfaceId); } catch { return; }
          rendererCoordinator.unregisterSurface(surfaceId);
          remount();
        }, Math.max(250, recoveryTimeoutMs));
      });
    };
    const onRestored = () => {
      if (recoveryTimer.current) {
        clearTimeout(recoveryTimer.current);
        recoveryTimer.current = null;
      }
      try { rendererCoordinator.markContextRestored(surfaceId); } catch { return; }
      remount();
    };
    canvas.addEventListener("webglcontextlost", onLost, { passive: false });
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
      rendererCoordinator.unregisterSurface(surfaceId);
    };
  }, [fallbackReasonOverride, gl, recoveryTimeoutMs, remount, requestedBackend, role, surfaceId]);
  return <RendererMetricsReporter surfaceId={surfaceId} />;
};

const NativeViewportBridge: React.FC<{ surfaceId: string; onFailure: (message: string) => void }> = ({ surfaceId, onFailure }) => {
  const [status, setStatus] = useState<NativeEngineStatus>(() => nativeEngine.getStatus());
  useEffect(() => {
    const unsubscribe = nativeEngine.subscribe(setStatus);
    void nativeEngine.openViewport().then(setStatus).catch((error: unknown) => {
      onFailure(error instanceof Error ? error.message : "Native viewport startup failed");
    });
    // The Python host owns the native process and viewport across document
    // reloads. A React unmount therefore must not destroy either resource.
    return unsubscribe;
  }, [onFailure]);
  return (
    <div data-auvra-native-surface={surfaceId} className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-200">
      <div className="max-w-md rounded border border-zinc-700 bg-zinc-900 p-5 text-sm shadow-xl">
        <div className="font-semibold">Native viewport: {status.viewport}</div>
        <div className="mt-1 text-zinc-400">{status.backend ?? "Starting renderer"}{status.adapter ? ` · ${status.adapter}` : ""}</div>
        <div className="mt-2 text-xs text-zinc-500">World revision {status.worldRevision}. The scene is rendered in the separately owned native window.</div>
      </div>
    </div>
  );
};

/** Presentation canvas with one centrally owned context policy. */
export const AuvraCanvas: React.FC<AuvraCanvasProps> = ({
  surfaceId,
  role = "presentation",
  recoveryTimeoutMs = 2000,
  gl: providedGl,
  children,
  ...props
}) => {
  const [generation, setGeneration] = useState(0);
  const [nativeFailure, setNativeFailure] = useState<string | null>(null);

  const requestedBackend = useMemo(() => {
    if (typeof window === "undefined") return "auto";
    const value = new URLSearchParams(window.location.search).get("renderer");
    return value === "native" || value === "webgpu" || value === "webgl2" || value === "auto" ? value : "auto";
  }, []);

  const gl = useMemo(() => ({
    antialias: true,
    ...(providedGl ?? {}),
    preserveDrawingBuffer: false,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
  }), [providedGl]);

  const remount = useCallback(() => setGeneration((value) => value + 1), []);
  const failNative = useCallback((message: string) => setNativeFailure(message), []);
  const nativeEligible = surfaceId === "editor-scene-viewer";
  if (requestedBackend === "native" && nativeEligible && !nativeFailure) {
    return <NativeViewportBridge surfaceId={surfaceId} onFailure={failNative} />;
  }
  const webBackend = requestedBackend === "native" ? "auto" : requestedBackend;
  const nativeFallback = requestedBackend === "native"
    ? nativeFailure ?? "This surface is not owned by the separate native viewport; using the web compatibility renderer"
    : null;
  return <Canvas key={`${surfaceId}:${generation}`} {...props} gl={gl}><RendererLifecycleBridge surfaceId={surfaceId} role={role} requestedBackend={webBackend} fallbackReasonOverride={nativeFallback} recoveryTimeoutMs={recoveryTimeoutMs} remount={remount} />{children}</Canvas>;
};

export default AuvraCanvas;
