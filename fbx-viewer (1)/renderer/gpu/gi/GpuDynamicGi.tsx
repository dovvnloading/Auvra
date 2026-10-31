import React, { useContext, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ShadowDetailContext } from "../../../runtime/lighting/DistanceShadowLights";
import type { DynamicGiSettings } from "../../../runtime/lighting/dynamicGi/probeGrid";
import type { RayFilter } from "../../../runtime/raytracing/rayScene";
import type { GpuPass, GpuRendererApi } from "../frame";
import { acquireGiScreen } from "./giScreen";
import { createGiPasses, GpuGi, type GiRun } from "./giSystem";

/**
 * THE LEVEL'S DYNAMIC GLOBAL ILLUMINATION ON THE WEBGPU RENDERER
 *
 * Lights the level with light gathered as it plays, from the same settings the WebGL component reads, while it is
 * mounted. Every view of a level on one renderer shares what is gathered: one gathers, and all of them read.
 */

const DISPOSE_AFTER_MS = 1500;

interface GiRunner {
  /** Which frame the page is on, as this view last counted. */
  id: object;
}

interface SharedGi {
  gi: GpuGi;
  run: GiRun;
  passes: GpuPass[];
  runners: GiRunner[];
  releaseScreen: () => void;
}

const shared = new WeakMap<GpuRendererApi, SharedGi>();

/** The system gathering light for a renderer, if any: for checks and for anything that reports on it. */
export const gpuGiFor = (renderer: GpuRendererApi): GpuGi | null => shared.get(renderer)?.gi ?? null;

const acquire = (renderer: GpuRendererApi, settings: DynamicGiSettings, include: RayFilter): SharedGi => {
  const existing = shared.get(renderer);
  if (existing) return existing;
  const { device } = renderer.core;
  const gi = new GpuGi(device);
  const run: GiRun = { settings, include, reflections: false, tick: 0 };
  const passes = createGiPasses(device, gi, run);
  for (const pass of passes) renderer.addPass(pass);
  const entry: SharedGi = { gi, run, passes, runners: [], releaseScreen: acquireGiScreen(renderer) };
  shared.set(renderer, entry);
  return entry;
};

const release = (renderer: GpuRendererApi, entry: SharedGi): void => {
  if (entry.runners.length > 0 || shared.get(renderer) !== entry) return;
  shared.delete(renderer);
  for (const pass of entry.passes) {
    renderer.removePass(pass);
    pass.dispose?.();
  }
  entry.releaseScreen();
  entry.gi.destroy();
};

export const GpuDynamicGi: React.FC<{ settings: DynamicGiSettings; include: RayFilter }> = ({ settings, include }) => {
  const renderer = useThree((state) => state.gl) as unknown as GpuRendererApi;
  // Play falls back on less when it runs slow: as with distance shadows, so with this.
  const detail = useContext(ShadowDetailContext);
  const effective = useMemo<DynamicGiSettings>(() => (detail === "low" ? { ...settings, quality: "low" } : settings), [settings, detail]);
  const runner = useMemo<GiRunner>(() => ({ id: {} }), []);
  const latest = useRef({ effective, include, reflections: false });
  // Only as the level is meant to look: the other views show the light itself, and a slow machine goes without.
  latest.current = { effective, include, reflections: settings.reflections && settings.view === "lit" && detail !== "low" };

  useEffect(() => {
    const entry = acquire(renderer, latest.current.effective, latest.current.include);
    entry.runners.push(runner);
    return () => {
      entry.runners.splice(entry.runners.indexOf(runner), 1);
      // A change of layout unmounts one view and mounts another moments later: the light stays for the new one.
      setTimeout(() => release(renderer, entry), DISPOSE_AFTER_MS);
    };
  }, [renderer, runner]);

  // Ahead of every view's draw.
  useFrame(() => {
    const entry = shared.get(renderer);
    if (!entry || entry.runners[0] !== runner) return;
    entry.run.settings = latest.current.effective;
    entry.run.include = latest.current.include;
    entry.run.reflections = latest.current.reflections;
    entry.run.tick++;
  }, -2);

  return null;
};
