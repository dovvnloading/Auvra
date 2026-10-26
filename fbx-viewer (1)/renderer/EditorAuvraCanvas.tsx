import React, { useCallback, useEffect, useMemo, useState } from "react";
import { nativeEngine, type NativeEngineStatus } from "../host/engine";
import { frontendDiagnostics } from "../diagnostics/runtime";
import { AuvraCanvas, readRequestedRendererBackend, type AuvraCanvasProps } from "./AuvraCanvas";

/** Surfaces the separately owned native viewport may present in place of the web canvas. */
const NATIVE_ELIGIBLE_SURFACES = new Set(["editor-scene-viewer"]);

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
    <div data-auvra-native-surface={surfaceId} data-auvra-native-dock-active={status.dockActive === true ? "true" : "false"} className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-200">
      <div className="max-w-md rounded border border-zinc-700 bg-zinc-900 p-5 text-sm shadow-xl">
        <div className="font-semibold">Native viewport: {status.viewport}</div>
        <div className="mt-1 text-zinc-400">{status.backend ?? "Starting renderer"}{status.adapter ? ` · ${status.adapter}` : ""}</div>
        <div className="mt-2 text-xs text-zinc-500">
          World revision {status.worldRevision}, tick {status.tick ?? 0}. {status.dockActive
            ? "The native viewport is attached to this desktop frame."
            : "The scene is rendered in the separately owned native window."}
        </div>
        {!status.dockActive && status.dockReason ? <div className="mt-1 text-xs text-zinc-600">{status.dockReason}</div> : null}
      </div>
    </div>
  );
};

/** Editor-only canvas: adds the host-owned native viewport (`?renderer=native`) in front of AuvraCanvas. */
export const EditorAuvraCanvas: React.FC<AuvraCanvasProps> = ({ fallbackReason, ...props }) => {
  const { surfaceId, role = "presentation" } = props;
  const [nativeFailure, setNativeFailure] = useState<string | null>(null);
  const requestedBackend = useMemo(readRequestedRendererBackend, []);

  const failNative = useCallback((message: string) => {
    frontendDiagnostics.record("renderer", "renderer.backend_failed", {
      backend: "native",
      fallback: true,
      code: "native_viewport_start_failed",
      errorType: "NativeViewportError",
      surfaceRole: role,
    }, {}, true);
    setNativeFailure(message);
  }, [role]);

  const nativeEligible = NATIVE_ELIGIBLE_SURFACES.has(surfaceId);
  if (requestedBackend === "native" && nativeEligible && !nativeFailure) {
    return <NativeViewportBridge surfaceId={surfaceId} onFailure={failNative} />;
  }
  return <AuvraCanvas {...props} fallbackReason={fallbackReason ?? nativeFailure} />;
};

export default EditorAuvraCanvas;
