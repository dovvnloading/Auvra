import { nativeEngine } from "../host/engine";
import { REFERENCE_BASELINE } from "./referenceScenes";

const FEATURES = [
  "pbr_metallic_roughness", "skeletal_animation", "frustum_culling", "deterministic_lod",
  "instance_batching", "directional_lights", "point_lights", "spot_lights", "shadow_maps",
  "image_based_lighting", "entity_picking", "editor_gizmos", "hdr_intermediate",
  "aces_tone_mapping", "msaa_or_fxaa", "post_processing_chain",
] as const;
const SIGNATURE = /^[0-9a-f]{16,64}$/;
const WARMUP_FRAMES = 5;
const MEASURED_FRAMES = 20;
const SOFTWARE_WARMUP_FRAMES = 3;
const SOFTWARE_MEASURED_FRAMES = 9;

function percentile95(samples: number[]): number | null {
  if (!samples.length) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  // Interpolate the rank instead of selecting the nearest sample.  With the
  // old nine-sample nearest-rank calculation, p95 was always the maximum, so
  // one transient scheduler/GPU spike could fail an otherwise healthy gate.
  const rank = 0.95 * (ordered.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return ordered[lower];
  const fraction = rank - lower;
  return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction;
}

export interface NativeReferenceResult {
  sceneId: "basic";
  referenceVersion: 1;
  qualified: boolean;
  signature: string | null;
  width: number;
  height: number;
  /** Hardware budgets are not comparable with CPU software-rasterizer timing. */
  performanceProfile: "hardware" | "software-adapter" | "unavailable";
  reason: string | null;
}

/**
 * Runs the same versioned basic-scene contract used by the browser reference
 * suite through the host-owned native renderer. Qualification is fail-closed:
 * the renderer must report the complete production feature table and a
 * bounded render; hardware adapters must also stay inside the shared
 * performance budget, while software adapters publish an explicit profile.
 */
export async function runNativeReferenceGate(width = 256, height = 256): Promise<NativeReferenceResult> {
  let result: Awaited<ReturnType<typeof nativeEngine.renderReference>> | undefined;
  let performanceProfile: NativeReferenceResult["performanceProfile"] = "unavailable";
  const cpuSamples: number[] = [];
  const gpuSamples: number[] = [];
  const signatures = new Set<string>();
  try {
    // The first render response carries the host's authoritative adapter type.
    // Use it to keep software-rasterizer lanes bounded without an extra IPC
    // round trip, while hardware lanes retain the larger robust sample.
    let warmupFrames = WARMUP_FRAMES;
    let measuredFrames = MEASURED_FRAMES;
    for (let frame = 0; ; frame += 1) {
      result = await nativeEngine.renderReference(width, height);
      if (frame === 0) {
        const softwareAdapter = result.deviceType === "Cpu";
        performanceProfile = softwareAdapter ? "software-adapter" : "hardware";
        warmupFrames = softwareAdapter ? SOFTWARE_WARMUP_FRAMES : WARMUP_FRAMES;
        measuredFrames = softwareAdapter ? SOFTWARE_MEASURED_FRAMES : MEASURED_FRAMES;
      }
      if (frame < warmupFrames) continue;
      if (result.metrics?.frameCpuMs !== null && result.metrics?.frameCpuMs !== undefined) cpuSamples.push(result.metrics.frameCpuMs);
      if (result.metrics?.gpuFrameMs !== null && result.metrics?.gpuFrameMs !== undefined) gpuSamples.push(result.metrics.gpuFrameMs);
      if (result.signature) signatures.add(result.signature);
      if (frame + 1 >= warmupFrames + measuredFrames) break;
    }
  } catch (error) {
    return {
      sceneId: "basic", referenceVersion: 1, qualified: false, signature: null,
      width, height, performanceProfile: "unavailable",
      reason: error instanceof Error ? error.message : "native renderer is unavailable",
    };
  }
  if (!result) throw new Error("native reference measurement produced no result");
  const metrics = result.metrics;
  performanceProfile = result.deviceType === "Cpu" ? "software-adapter" : performanceProfile;
  const cpuP95Ms = percentile95(cpuSamples);
  const gpuP95Ms = percentile95(gpuSamples);
  const capabilities = result.featureCapabilities ?? [];
  const reasons: string[] = [];
  if (result.referenceScene !== "basic" || result.referenceVersion !== 1) reasons.push("native reference contract mismatch");
  if (result.width !== width || result.height !== height) reasons.push("native reference dimensions mismatch");
  if (!result.signature || !SIGNATURE.test(result.signature)) reasons.push("native reference signature is invalid");
  if (signatures.size !== 1) reasons.push("native reference signature is not deterministic");
  if (capabilities.length !== FEATURES.length || capabilities.some((entry, index) => entry.feature !== FEATURES[index] || !entry.supported)) reasons.push("portable production feature baseline is incomplete");
  if (!metrics) reasons.push("native renderer metrics are unavailable");
  if (cpuP95Ms === null) reasons.push("native CPU frame measurements are unavailable");
  if (performanceProfile === "hardware" && cpuP95Ms !== null && cpuP95Ms > REFERENCE_BASELINE.maxCpuP95Ms) reasons.push("native CPU frame budget exceeded");
  if (performanceProfile === "hardware" && gpuP95Ms !== null && gpuP95Ms > REFERENCE_BASELINE.maxGpuFrameMs) reasons.push("native GPU frame budget exceeded");
  if (metrics && metrics.memoryBytes > REFERENCE_BASELINE.maxMemoryBytes) reasons.push("native memory budget exceeded");
  return {
    sceneId: "basic",
    referenceVersion: 1,
    qualified: reasons.length === 0,
    signature: result.signature ?? null,
    width,
    height,
    performanceProfile,
    reason: reasons.length ? reasons.join("; ") : null,
  };
}
