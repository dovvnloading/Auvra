import type { GpuCore } from "./device";
import type { GpuPass, GpuViewDrawer } from "./frame";
import { DeferredLightingPass } from "./passes/deferredLighting";
import { ForwardPass, OverlayPass } from "./passes/forward";
import { LightClusterPass } from "./passes/lightClusters";
import { ShadowPass } from "./passes/shadows";
import { SkinningPass } from "./passes/skinning";
import { SurfacePass } from "./passes/surfaces";
import { PresentPass } from "./post/present";

/**
 * THE PASSES EVERY FRAME RUNS
 *
 * Skinning, shadows, culling and the surface buffer, light clusters, lighting, forward drawing and presenting.
 * Level components add the rest (sky, post stack, GI) when a level has them.
 */

export interface BuiltinPasses {
  passes: GpuPass[];
  drawer: GpuViewDrawer | null;
  present: GpuPass;
}

export const createBuiltinPasses = (core: GpuCore): BuiltinPasses => {
  const surfaces = new SurfacePass(core);
  return {
    passes: [
      new SkinningPass(core),
      new ShadowPass(core),
      surfaces,
      new LightClusterPass(core),
      new DeferredLightingPass(core),
      new ForwardPass(core),
      new OverlayPass(core),
    ],
    drawer: surfaces,
    present: new PresentPass(core),
  };
};
