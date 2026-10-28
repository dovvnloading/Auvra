import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type CanvasProps } from "@react-three/fiber";
import * as THREE from "three";
import { rendererCoordinator, type RendererSurfaceRole } from "./registry";
import { MaterialClock } from "../runtime/materials/MaterialClock";

type AuvraCanvasGlOptions = Partial<THREE.WebGLRendererParameters> & Partial<Pick<THREE.WebGLRenderer, "outputColorSpace" | "toneMapping" | "toneMappingExposure">>;

export type RequestedRendererBackend = "auto" | "native" | "webgpu" | "webgl2";

export interface AuvraCanvasProps extends Omit<CanvasProps, "onCreated" | "gl"> {
  surfaceId: string;
  role?: RendererSurfaceRole;
  recoveryTimeoutMs?: number;
  gl?: AuvraCanvasGlOptions;
  /** Reported fallback reason supplied by a wrapper whose own backend could not present this surface. */
  fallbackReason?: string | null;
}

/** Reads the `?renderer=` backend request; host-owned backends are resolved by wrappers, never here. */
export function readRequestedRendererBackend(): RequestedRendererBackend {
  if (typeof window === "undefined") return "auto";
  const value = new URLSearchParams(window.location.search).get("renderer");
  return value === "native" || value === "webgpu" || value === "webgl2" || value === "auto" ? value : "auto";
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

/** Host-free presentation canvas with one centrally owned context policy. */
export const AuvraCanvas: React.FC<AuvraCanvasProps> = ({
  surfaceId,
  role = "presentation",
  recoveryTimeoutMs = 2000,
  gl: providedGl,
  fallbackReason = null,
  children,
  ...props
}) => {
  const [generation, setGeneration] = useState(0);

  const requestedBackend = useMemo(readRequestedRendererBackend, []);

  const gl = useMemo(() => ({
    antialias: true,
    ...(providedGl ?? {}),
    preserveDrawingBuffer: false,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
  }), [providedGl]);

  const remount = useCallback(() => setGeneration((value) => value + 1), []);
  const webBackend = requestedBackend === "native" ? "auto" : requestedBackend;
  const nativeFallback = fallbackReason ?? (requestedBackend === "native"
    ? "This surface is not owned by the separate native viewport; using the web compatibility renderer"
    : null);
  return <Canvas key={`${surfaceId}:${generation}`} {...props} gl={gl}><RendererLifecycleBridge surfaceId={surfaceId} role={role} requestedBackend={webBackend} fallbackReasonOverride={nativeFallback} recoveryTimeoutMs={recoveryTimeoutMs} remount={remount} /><MaterialClock />{children}</Canvas>;
};

export default AuvraCanvas;
