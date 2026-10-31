/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { GpuRendererApi } from "../frame";
import { registerSurfaceKind, type MaterialEntry, type MaterialPool } from "../materialPool";
import type { SurfaceKind } from "../surfaces";
import { graphSurfaceFor, setGraphDevice } from "./graph";
import { IMPOSTOR_SURFACE, isImpostorMaterial } from "./impostor";
import { LIT_SURFACES, isLitMaterial, litSurfaceFor, setPicturesPerShader } from "./lit";
import { TERRAIN_GROUND_SURFACE, TERRAIN_LAYERS_SURFACE, terrainSurfaceFor } from "./terrain";
import { WATER_SURFACE, isWaterMaterial } from "./water";
import { createSurfaceWorldPass, ensureSurfaceWorld } from "./world";

/**
 * THE LEVEL'S SURFACE KINDS
 *
 * Which kind draws which material, and the registering of them all. A material's kind can change under it, as it can on
 * the WebGL path: a graph is bound or rewired, the weather patch reaches it, a Wind Sway comes and goes, a physical number
 * rises from zero. So each material's kind is looked at whenever it is acquired, and moved over when it differs.
 */

/** The kind a material should be drawn by now; null for materials none of these take. */
export const surfaceKindFor = (material: THREE.Material): SurfaceKind | null => {
  if (isImpostorMaterial(material)) return IMPOSTOR_SURFACE;
  if (!isLitMaterial(material)) return null;
  return graphSurfaceFor(material) ?? terrainSurfaceFor(material) ?? (isWaterMaterial(material) ? WATER_SURFACE : litSurfaceFor(material));
};

let registered = false;

const registerSurfaceKinds = (): void => {
  if (registered) return;
  registered = true;
  for (const kind of [...LIT_SURFACES, TERRAIN_LAYERS_SURFACE, TERRAIN_GROUND_SURFACE, WATER_SURFACE, IMPOSTOR_SURFACE]) {
    registerSurfaceKind((material) => surfaceKindFor(material) === kind, kind);
  }
};

const followed = new WeakSet<MaterialPool>();

/** Has a pool look at each material's kind as it is acquired. */
const followKinds = (pool: MaterialPool): void => {
  if (followed.has(pool)) return;
  followed.add(pool);
  const acquire = pool.acquire.bind(pool);
  pool.acquire = (material: THREE.Material, frame: number): MaterialEntry | null => {
    // Asked first: this is what makes a new graph's kind known to the pool.
    const wanted = surfaceKindFor(material);
    const entry = acquire(material, frame);
    if (!entry || !wanted || entry.kind === wanted) return entry;
    entry.kind = wanted;
    entry.bindGroup = null as unknown as GPUBindGroup;
    entry.textures = [];
    entry.textureRevisions = [];
    entry.packedFrame = -1;
    return acquire(material, frame);
  };
};

/** Everything surfaces need of a renderer. Call it once, as the renderer is made, before anything is drawn. */
export const installSurfaces = (renderer: GpuRendererApi): void => {
  registerSurfaceKinds();
  setPicturesPerShader(renderer.core.device.limits.maxSampledTexturesPerShaderStage);
  setGraphDevice(renderer.core.device);
  ensureSurfaceWorld(renderer.core.device, renderer.textures);
  followKinds(renderer.materials);
  renderer.addPass(createSurfaceWorldPass());
};

export { GlslError, GlslTranslator } from "./glslToWgsl";
export { compileGraphWgsl } from "./materialWgsl";
export { graphSurfaceFor } from "./graph";
export { IMPOSTOR_SURFACE } from "./impostor";
export { LIT_PHYSICAL_SURFACE, LIT_PHYSICAL_WIND_SURFACE, LIT_SURFACE, LIT_WIND_SURFACE } from "./lit";
export { TERRAIN_GROUND_SURFACE, TERRAIN_LAYERS_SURFACE } from "./terrain";
export { WATER_SURFACE } from "./water";
