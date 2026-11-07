import React, { useEffect, useRef } from "react";
import type * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { staticLightingObjectIds } from "../../../runtime/lighting/bakedLighting";
import { lightBakeJobs, type LightBakeJob } from "../../../runtime/lighting/lightBakeJobs";
import type { GpuFrame, GpuPass, GpuRendererApi } from "../frame";
import type { SkyEnvironmentProduct } from "../sky/skySettings";
import { acquireGiScreen } from "./giScreen";
import { GpuLightBaker } from "./lightBaker";

/**
 * BAKED LIGHTING ON THE WEBGPU RENDERER
 *
 * The level's baked volume is set as ever (setSceneLightVolume): these components are what reads it on this renderer,
 * and what bakes it. Both mount beside what the WebGL renderer uses, in its place.
 */

/** Reads the scene's baked volume into the lit picture, while mounted. */
export const GpuLightVolumeBinding: React.FC = () => {
  const renderer = useThree((state) => state.gl) as unknown as GpuRendererApi;
  useEffect(() => acquireGiScreen(renderer), [renderer]);
  return null;
};

/** Milliseconds of the graphics card's time given to a bake each go. */
const BAKE_BUDGET_MS = 20;

/** Bakes the light a panel asks for (lightBakeJobs) in this view's scene, a few probes a frame. */
export const GpuLightBakeRunner: React.FC = () => {
  const renderer = useThree((state) => state.gl) as unknown as GpuRendererApi;
  const scene = useThree((state) => state.scene) as THREE.Scene;
  const invalidate = useThree((state) => state.invalidate);
  const active = useRef<{ job: LightBakeJob; baker: GpuLightBaker } | null>(null);
  const environment = useRef<SkyEnvironmentProduct | undefined>(undefined);

  // A new bake wakes a canvas that only draws on demand.
  useEffect(() => lightBakeJobs.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => () => {
    const current = active.current;
    active.current = null;
    if (!current) return;
    current.baker.dispose();
    lightBakeJobs.fail(current.job, new Error("The level view closed before the bake finished."));
  }, []);

  // What the sky publishes comes only by way of a frame.
  useEffect(() => {
    const pass: GpuPass = {
      id: "gi-bake-environment",
      stage: "afterSurfaces",
      execute: (frame: GpuFrame) => {
        environment.current = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
      },
    };
    renderer.addPass(pass);
    return () => renderer.removePass(pass);
  }, [renderer]);

  useFrame(() => {
    const job = lightBakeJobs.current();
    let current = active.current;
    if (current && current.job !== job) {
      // Cancelled.
      current.baker.dispose();
      active.current = current = null;
    }
    if (!job) return;
    try {
      if (!current) {
        // Several views of one level each run a runner; the first to see the bake takes it.
        if (job.started) return;
        const { levelObjects, settings } = job.request;
        current = active.current = {
          job,
          baker: new GpuLightBaker(renderer.core, renderer.textures, scene, { staticIds: staticLightingObjectIds(levelObjects), spacing: settings.spacing, bounces: settings.bounces }),
        };
        job.started = true;
      }
      current.baker.setEnvironment(environment.current);
      if (current.baker.step(BAKE_BUDGET_MS)) {
        const result = current.baker.result();
        current.baker.dispose();
        active.current = null;
        lightBakeJobs.finish(job, result);
      } else {
        lightBakeJobs.report(job, current.baker.progress);
        invalidate();
      }
    } catch (error) {
      current?.baker.dispose();
      active.current = null;
      lightBakeJobs.fail(job, error);
    }
  });
  return null;
};
