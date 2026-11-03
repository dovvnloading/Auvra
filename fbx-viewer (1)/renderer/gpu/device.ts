/// <reference types="@webgpu/types" />
import { reportGpu } from "./report";

/**
 * THE GPU DEVICE
 *
 * One WebGPU device for the whole page, asked for once and shared by every surface that draws with it.
 * Everything the renderer needs of the graphics card beyond the WebGPU baseline is asked for here and
 * written down in `features`, so the passes read one place rather than each probing for itself.
 *
 * A surface closing leaves the device alone: what was uploaded stays there for the next surface, which is what moving
 * between editor tabs asks for. Only when none has been back for a while is the device let go, and its memory with it.
 */

/** Features taken when the adapter has them; none of them is required to draw. */
const OPTIONAL_FEATURES: readonly GPUFeatureName[] = [
  "timestamp-query",
  "texture-compression-bc",
  "texture-compression-etc2",
  "texture-compression-astc",
  "float32-filterable",
  "float32-blendable",
  "rg11b10ufloat-renderable",
  "depth-clip-control",
  "subgroups",
];

export interface GpuFeatures {
  timestamps: boolean;
  bc: boolean;
  etc2: boolean;
  astc: boolean;
  float32Filterable: boolean;
  float32Blendable: boolean;
  depthClipControl: boolean;
  subgroups: boolean;
}

export interface GpuCore {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly features: GpuFeatures;
  /** The format canvases present in. */
  readonly presentFormat: GPUTextureFormat;
  /** Resolves when the device is gone; a surface remounts and asks again. */
  readonly lost: Promise<GPUDeviceLostInfo>;
}

export type GpuUnavailableReason = "no-webgpu" | "no-adapter" | "software-adapter" | "device-failed";

export interface GpuCoreResult {
  core: GpuCore | null;
  reason: GpuUnavailableReason | null;
}

const requestLimits = (adapter: GPUAdapter): Record<string, number> => {
  const { limits } = adapter;
  return {
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage,
    maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
    maxSamplersPerShaderStage: limits.maxSamplersPerShaderStage,
    maxColorAttachmentBytesPerSample: limits.maxColorAttachmentBytesPerSample,
    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxTextureArrayLayers: limits.maxTextureArrayLayers,
    maxDynamicUniformBuffersPerPipelineLayout: limits.maxDynamicUniformBuffersPerPipelineLayout,
    maxDynamicStorageBuffersPerPipelineLayout: limits.maxDynamicStorageBuffersPerPipelineLayout,
  };
};

/** How long the device outlives the last surface drawing with it. */
const LET_GO_AFTER_MS = 30_000;

let pending: Promise<GpuCoreResult> | null = null;
let surfaces = 0;
let letGo: ReturnType<typeof setTimeout> | null = null;
let softwareAccepted = false;

/**
 * Lets this page draw on a graphics card emulated on the processor. Only the rendering pictures ask: their machines have
 * no other, and a picture drawn slowly is still the picture.
 */
export const acceptSoftwareAdapter = (): void => {
  softwareAccepted = true;
};

const stayAwake = (): void => {
  if (letGo) clearTimeout(letGo);
  letGo = null;
};

const requestCore = async (): Promise<GpuCoreResult> => {
  const gpu = typeof navigator === "undefined" ? undefined : navigator.gpu;
  if (!gpu) return { core: null, reason: "no-webgpu" };
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  if (!adapter) return { core: null, reason: "no-adapter" };
  // A graphics card emulated on the processor: everything this renderer does there is many times slower than WebGL2's path.
  if (adapter.info?.isFallbackAdapter && !softwareAccepted) return { core: null, reason: "software-adapter" };
  const requiredFeatures = OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits: requestLimits(adapter) }).catch(() => null);
  if (!device) return { core: null, reason: "device-failed" };
  const has = (feature: GPUFeatureName) => device.features.has(feature);
  const lost = device.lost.then((info) => {
    // The next surface to ask gets a new device.
    pending = null;
    return info;
  });
  device.addEventListener("uncapturederror", (event) => {
    reportGpu("[gpu]", (event as GPUUncapturedErrorEvent).error.message);
  });
  return {
    reason: null,
    core: {
      adapter,
      device,
      lost,
      presentFormat: gpu.getPreferredCanvasFormat(),
      features: {
        timestamps: has("timestamp-query"),
        bc: has("texture-compression-bc"),
        etc2: has("texture-compression-etc2"),
        astc: has("texture-compression-astc"),
        float32Filterable: has("float32-filterable"),
        float32Blendable: has("float32-blendable"),
        depthClipControl: has("depth-clip-control"),
        subgroups: has("subgroups"),
      },
    },
  };
};

/** The page's device, asked for the first time it is wanted. */
export const acquireGpuCore = (): Promise<GpuCoreResult> => {
  stayAwake();
  if (!pending) pending = requestCore();
  return pending;
};

/** Says a surface is drawing with the device, for as long as it takes to call what this returns. */
export const holdGpuCore = (core: GpuCore): (() => void) => {
  stayAwake();
  surfaces++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    surfaces--;
    if (surfaces > 0) return;
    stayAwake();
    letGo = setTimeout(() => {
      letGo = null;
      pending = null;
      core.device.destroy();
    }, LET_GO_AFTER_MS);
  };
};
