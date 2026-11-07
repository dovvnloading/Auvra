import React, { useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { isGpuRenderer } from "../frame";
import { GPU_SCREEN_DEFAULTS, ScreenLightingPasses, type GpuScreenSettings } from "./screenPasses";

/**
 * SCREEN LIGHTING ON THE GPU RENDERER
 *
 * Occlusion, contact shadows, bounced light and reflections for a canvas drawn with WebGPU, registered while mounted.
 * It draws nothing itself and does nothing on a WebGL canvas. Settings left out take GPU_SCREEN_DEFAULTS; a level's
 * post-process stack comes through screenSettingsFromStack. One per canvas: the passes publish under fixed names.
 */

export type GpuScreenLightingProps = Partial<GpuScreenSettings>;

export const GpuScreenLighting: React.FC<GpuScreenLightingProps> = ({
  bounce = GPU_SCREEN_DEFAULTS.bounce,
  bounceRadius = GPU_SCREEN_DEFAULTS.bounceRadius,
  reflections = GPU_SCREEN_DEFAULTS.reflections,
  reflectionDistance = GPU_SCREEN_DEFAULTS.reflectionDistance,
  aoIntensity = GPU_SCREEN_DEFAULTS.aoIntensity,
  aoRadius = GPU_SCREEN_DEFAULTS.aoRadius,
  contactShadowLength = GPU_SCREEN_DEFAULTS.contactShadowLength,
  view = GPU_SCREEN_DEFAULTS.view,
}) => {
  const gl: unknown = useThree((state) => state.gl);
  // The passes keep this object and read it each frame, so new settings need no new passes and lose no history.
  const settings = useMemo<GpuScreenSettings>(() => ({ ...GPU_SCREEN_DEFAULTS }), []);

  useLayoutEffect(() => {
    settings.bounce = bounce;
    settings.bounceRadius = bounceRadius;
    settings.reflections = reflections;
    settings.reflectionDistance = reflectionDistance;
    settings.aoIntensity = aoIntensity;
    settings.aoRadius = aoRadius;
    settings.contactShadowLength = contactShadowLength;
    settings.view = view;
  }, [settings, bounce, bounceRadius, reflections, reflectionDistance, aoIntensity, aoRadius, contactShadowLength, view]);

  useLayoutEffect(() => {
    if (!isGpuRenderer(gl)) return undefined;
    const owned = new ScreenLightingPasses(settings);
    for (const pass of owned.passes) gl.addPass(pass);
    return () => {
      for (const pass of owned.passes) gl.removePass(pass);
      owned.dispose();
    };
  }, [gl, settings]);

  return null;
};
