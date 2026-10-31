import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type CanvasProps } from "@react-three/fiber";
import * as THREE from "three";
import { rendererCoordinator, type RendererSurfaceRole } from "./registry";
import type { GpuUnavailableReason } from "./gpu/device";
import { isGpuRenderer } from "./gpu/frame";
import type { GpuRenderer } from "./gpu/GpuRenderer";
import { frontendDiagnostics } from "../diagnostics/runtime";
import { MaterialClock } from "../runtime/materials/MaterialClock";
// Every scene draws with its baked light, or none (installs the shader hook on import).
import "../runtime/lighting/bakedLighting";

type AuvraCanvasGlOptions = Partial<THREE.WebGLRendererParameters> & Partial<Pick<THREE.WebGLRenderer, "outputColorSpace" | "toneMapping" | "toneMappingExposure">>;

export type RequestedRendererBackend = "auto" | "native" | "webgpu" | "webgl2";

/** What a project's Renderer setting can ask for (quality.renderer). */
export type RendererSetting = Exclude<RequestedRendererBackend, "native">;

export interface AuvraCanvasProps extends Omit<CanvasProps, "onCreated" | "gl"> {
  surfaceId: string;
  role?: RendererSurfaceRole;
  recoveryTimeoutMs?: number;
  gl?: AuvraCanvasGlOptions;
  /** Reported fallback reason supplied by a wrapper whose own backend could not present this surface. */
  fallbackReason?: string | null;
  /** The project's Renderer setting; `?renderer=` on the page wins over it. Without either a surface draws with WebGPU where the machine has it. */
  backend?: RendererSetting;
}

/** The `?renderer=` the page names, if it names one. */
const readPageRendererRequest = (): RequestedRendererBackend | null => {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("renderer");
  return value === "native" || value === "webgpu" || value === "webgl2" || value === "auto" ? value : null;
};

/** Reads the `?renderer=` backend request; host-owned backends are resolved by wrappers, never here. */
export function readRequestedRendererBackend(): RequestedRendererBackend {
  return readPageRendererRequest() ?? "auto";
}

/** The surfaces that can draw with WebGPU: previews and captures stay on WebGL2. */
const GPU_ROLES: ReadonlySet<string> = new Set(["runtime", "editor"]);
/** How many times a surface takes a new device after a failure before it settles on WebGL2 (as with a lost context). */
const MAX_DEVICE_LOSSES = 2;
const DEVICES_KEEP_FAILING = "The graphics device was lost repeatedly; using the WebGL2 renderer";

const GPU_UNAVAILABLE: Record<GpuUnavailableReason, string> = {
  "no-webgpu": "This browser has no WebGPU; using the WebGL2 renderer",
  "no-adapter": "No graphics adapter here offers WebGPU; using the WebGL2 renderer",
  "software-adapter": "The only WebGPU adapter here runs on the processor; using the WebGL2 renderer",
  "device-failed": "The graphics adapter refused a WebGPU device; using the WebGL2 renderer",
};

/** What trying for WebGPU came to: the renderer to make, or why there is none. */
type GpuAttempt =
  | { createRenderer: (canvas: HTMLCanvasElement | OffscreenCanvas) => GpuRenderer; failure?: undefined }
  | { createRenderer?: undefined; failure: { code: string; reason: string } };

/** Asks for the page's device and loads the renderer, neither of which a surface on WebGL2 ever pays for. */
const attemptGpu = async (): Promise<GpuAttempt> => {
  try {
    const { acquireGpuCore } = await import("./gpu/device");
    const { core, reason } = await acquireGpuCore();
    if (!core) {
      const why = reason ?? "no-webgpu";
      return { failure: { code: why.replace("-", "_"), reason: GPU_UNAVAILABLE[why] } };
    }
    const { GpuRenderer: Renderer } = await import("./gpu/GpuRenderer");
    return { createRenderer: (canvas) => new Renderer(canvas as HTMLCanvasElement, core) };
  } catch {
    // Fails only if the code cannot be fetched or the card turns it down outright; either way WebGL2 can still draw.
    return { failure: { code: "renderer_load_failed", reason: "The WebGPU renderer could not be loaded; using the WebGL2 renderer" } };
  }
};

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
  onDeviceLost: (reason: string | undefined) => void;
  onGpuGiveUp: (reason: string) => void;
}> = ({ surfaceId, role, requestedBackend, fallbackReasonOverride, recoveryTimeoutMs, remount, onDeviceLost, onGpuGiveUp }) => {
  const { gl } = useThree();
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const renderer = gl as THREE.WebGLRenderer;
    const canvas = renderer.domElement;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    const gpu = isGpuRenderer(gl) ? gl : null;
    const fallbackReason = fallbackReasonOverride ?? (requestedBackend === "webgpu" && !gpu ? "WebGPU is experimental and unqualified for presentation; using the measured WebGL2 compatibility backend" : null);
    rendererCoordinator.registerSurface({
      id: surfaceId,
      role,
      canvas,
      selectedBackend: gpu ? "webgpu" : "webgl2",
      tier: gpu ? "portable-modern" : "compatibility",
      capabilities: gpu ? { webgpu: true, timerQuery: gpu.core.features.timestamps, maxTextureSize: gpu.core.device.limits.maxTextureDimension2D } : undefined,
      fallbackReason,
    });
    rendererCoordinator.markReady(surfaceId);
    // A device never comes back the way a context can: the surface remounts at once and asks for a new one.
    let mounted = true;
    void gpu?.core.lost.then((info) => {
      if (!mounted) return;
      rendererCoordinator.markContextLost(surfaceId);
      rendererCoordinator.markContextRestoring(surfaceId);
      onDeviceLost(info.reason);
    });
    if (gpu) gpu.onGiveUp = onGpuGiveUp;
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
      mounted = false;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
      rendererCoordinator.unregisterSurface(surfaceId);
    };
  }, [fallbackReasonOverride, gl, onDeviceLost, onGpuGiveUp, recoveryTimeoutMs, remount, requestedBackend, role, surfaceId]);
  return <RendererMetricsReporter surfaceId={surfaceId} />;
};

/** Host-free presentation canvas with one centrally owned context policy. */
export const AuvraCanvas: React.FC<AuvraCanvasProps> = ({
  surfaceId,
  role = "presentation",
  recoveryTimeoutMs = 2000,
  gl: providedGl,
  fallbackReason = null,
  backend,
  children,
  ...props
}) => {
  const [generation, setGeneration] = useState(0);

  const pageRequest = useMemo(readPageRendererRequest, []);
  const requestedBackend = pageRequest ?? backend ?? "auto";

  const gl = useMemo(() => ({
    antialias: true,
    ...(providedGl ?? {}),
    preserveDrawingBuffer: false,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
  }), [providedGl]);

  const remount = useCallback(() => setGeneration((value) => value + 1), []);

  // A canvas only ever has one kind of context, so the choice is made before there is a canvas to draw on.
  const [gpuGivenUp, setGpuGivenUp] = useState(false);
  const wantsGpu = !gpuGivenUp && GPU_ROLES.has(role) && (requestedBackend === "webgpu" || requestedBackend === "auto");
  const [gpuResult, setGpuResult] = useState<{ generation: number; attempt: GpuAttempt } | null>(null);
  useEffect(() => {
    if (!wantsGpu) {
      setGpuResult(null);
      return undefined;
    }
    let live = true;
    void attemptGpu().then((attempt) => { if (live) setGpuResult({ generation, attempt }); });
    return () => { live = false; };
  }, [generation, wantsGpu]);
  const attempt = wantsGpu && gpuResult?.generation === generation ? gpuResult.attempt : null;

  // Asking for WebGPU and not getting it is worth saying; `auto` only ever meant the best there is.
  const failure = attempt?.failure ?? null;
  useEffect(() => {
    if (!failure || requestedBackend !== "webgpu") return;
    frontendDiagnostics.record("renderer", "renderer.backend_failed", {
      backend: "webgpu",
      fallback: true,
      code: failure.code,
      errorType: "WebGpuUnavailable",
      surfaceRole: role,
    }, {}, true);
  }, [failure, requestedBackend, role]);

  // A device destroyed on purpose says nothing about the graphics card; one that fails over and over does.
  const deviceLosses = useRef(0);
  const onDeviceLost = useCallback((reason: string | undefined) => {
    if (reason !== "destroyed") deviceLosses.current += 1;
    if (deviceLosses.current > MAX_DEVICE_LOSSES) setGpuGivenUp(true);
    remount();
  }, [remount]);

  // Frames that keep failing are a card this renderer cannot draw on, and a black picture helps nobody: WebGL2 takes over.
  const [gaveUpBecause, setGaveUpBecause] = useState<string | null>(null);
  const onGpuGiveUp = useCallback((reason: string) => {
    frontendDiagnostics.record("renderer", "renderer.backend_failed", {
      backend: "webgpu",
      fallback: true,
      code: "frames_failing",
      errorType: "WebGpuFramesFailing",
      surfaceRole: role,
    }, {}, true);
    setGaveUpBecause(reason);
    setGpuGivenUp(true);
    remount();
  }, [remount, role]);

  if (wantsGpu && !attempt) return null;

  const webBackend = requestedBackend === "native" ? "auto" : requestedBackend;
  const gpuFallback = gpuGivenUp ? gaveUpBecause ?? DEVICES_KEEP_FAILING : requestedBackend === "webgpu" ? failure?.reason ?? null : null;
  const reportedFallback = fallbackReason ?? gpuFallback ?? (requestedBackend === "native"
    ? "This surface is not owned by the separate native viewport; using the web compatibility renderer"
    : null);
  const createRenderer = attempt?.createRenderer;
  return <Canvas key={`${surfaceId}:${generation}${createRenderer ? ":gpu" : ""}`} {...props} gl={createRenderer ?? gl}><RendererLifecycleBridge surfaceId={surfaceId} role={role} requestedBackend={webBackend} fallbackReasonOverride={reportedFallback} recoveryTimeoutMs={recoveryTimeoutMs} remount={remount} onDeviceLost={onDeviceLost} onGpuGiveUp={onGpuGiveUp} /><MaterialClock />{children}</Canvas>;
};

export default AuvraCanvas;
