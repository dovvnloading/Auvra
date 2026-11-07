import React, { useContext, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import {
  allowedAntialias, PostProcessQualityContext, type PostProcessSettings, type PostProcessToneMapping,
} from "../../../runtime/components/postProcess";
import { clampRenderScale, mipBiasFor } from "../../../runtime/temporal/temporalSettings";
import { isGpuRenderer } from "../frame";
import { GpuPostPass } from "./postStack";
import { displaySettingsOf, GPU_DEFAULT_SETTINGS, GPU_DEFAULT_TUNING, GPU_POST_TUNING, type GpuPostConfig, type GpuPostTuning } from "./postSettings";

/**
 * THE POST STACK UNDER A LEVEL'S CANVAS
 *
 * What the WebGL stack's component is on the new renderer: mounted by whoever owns the canvas's post-process output,
 * and taking the same settings. It registers the stack's pass, keeps it told, and hands the renderer the settings the
 * frame around the pass reads (postSettings.ts lists them). Everything can change in place, so a new setting never
 * loses what the pass has gathered.
 */

/** "None" still scales by exposure and clamps to the display's range, as in the WebGL stack. */
const TONE_MAPPINGS: Record<PostProcessToneMapping, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.LinearToneMapping,
};

const SETTING_NAMES = ["temporal.renderScale", "temporal.jitter", "temporal.mipBias", "post.display", "post.settings"] as const;

export interface GpuPostStackProps {
  settings: PostProcessSettings;
  tuning?: GpuPostTuning;
}

type ToneTarget = Pick<THREE.WebGLRenderer, "toneMapping" | "toneMappingExposure">;

export const GpuPostStack: React.FC<GpuPostStackProps> = ({ settings, tuning = GPU_POST_TUNING }) => {
  const gl: unknown = useThree((state) => state.gl);
  const renderer = isGpuRenderer(gl) ? gl : null;
  const quality = useContext(PostProcessQualityContext);
  const { temporalStacks } = quality;

  const antialias = allowedAntialias(settings.antialias, quality.antialias);
  const temporal = antialias === "temporal";
  const renderScale = temporal ? clampRenderScale(settings.renderScale * quality.renderScale) : 1;

  // The pass holds nothing on the graphics card until it first runs, so making it during render costs nothing.
  const pass = useMemo(() => (renderer ? new GpuPostPass(renderer.core) : null), [renderer]);

  useLayoutEffect(() => {
    if (!renderer || !pass) return undefined;
    renderer.addPass(pass);
    return () => {
      renderer.removePass(pass);
      pass.dispose();
    };
  }, [renderer, pass]);

  useLayoutEffect(() => {
    if (!renderer || !pass) return;
    const config: GpuPostConfig = { ...settings, ...tuning, antialias, renderScale };
    pass.configure(config);
    const named = renderer.settings;
    named.set("temporal.renderScale", renderScale);
    named.set("temporal.mipBias", temporal ? mipBiasFor(renderScale) : 0);
    if (temporal) named.set("temporal.jitter", pass.jitter);
    else named.delete("temporal.jitter");
    named.set("post.display", displaySettingsOf(config));
    named.set("post.settings", settings);
  }, [renderer, pass, settings, tuning, antialias, renderScale, temporal]);

  useLayoutEffect(() => {
    if (!renderer) return undefined;
    const named = renderer.settings;
    return () => {
      for (const name of SETTING_NAMES) named.delete(name);
    };
  }, [renderer]);

  // Counted for what can lower the render scale on a slow frame rate to know it would help.
  useLayoutEffect(() => {
    if (!renderer || !temporal || !temporalStacks) return undefined;
    const stacks = temporalStacks;
    stacks.current += 1;
    return () => {
      stacks.current -= 1;
    };
  }, [renderer, temporal, temporalStacks]);

  // The renderer's curve and exposure are the stack's while it runs, and go back as they were after.
  useLayoutEffect(() => {
    if (!renderer) return undefined;
    const target = renderer as unknown as ToneTarget;
    const { toneMapping, toneMappingExposure } = target;
    return () => {
      target.toneMapping = toneMapping;
      target.toneMappingExposure = toneMappingExposure;
    };
  }, [renderer]);

  // Every frame: the canvas puts its own values back whenever it applies its props again.
  const toneMapping = TONE_MAPPINGS[settings.toneMapping];
  const { exposure } = settings;
  useFrame(() => {
    if (!renderer) return;
    const target = renderer as unknown as ToneTarget;
    target.toneMapping = toneMapping;
    target.toneMappingExposure = exposure;
  });

  return null;
};

/** The runtime's own stack, for when no level component owns the canvas. */
export const GpuDefaultPostStack: React.FC = () => <GpuPostStack settings={GPU_DEFAULT_SETTINGS} tuning={GPU_DEFAULT_TUNING} />;
