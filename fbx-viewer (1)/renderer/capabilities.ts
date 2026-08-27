import type { CapabilityQueryDescriptor } from "./contracts";

export type CapabilityTier = "compatibility" | "portable-modern" | "native-advanced" | "research";
export type BackendId = "webgpu" | "webgl2";
export type BackendRequest = "auto" | BackendId;

export interface RenderWorkload {
  readonly sceneId?: string;
  readonly requiredFeatures?: ReadonlyArray<string>;
  readonly requiredLimits?: Readonly<CapabilityLimits>;
}

export interface CapabilityLimits {
  readonly maxTextureDimension2D?: number;
  readonly maxUniformBufferSize?: number;
  readonly maxStorageBufferSize?: number;
  readonly maxColorAttachments?: number;
  readonly maxSamples?: number;
}

export interface BackendCapabilities {
  readonly backend: BackendId;
  readonly available: boolean;
  readonly tier: CapabilityTier;
  readonly features: ReadonlyArray<string>;
  readonly limits: Readonly<CapabilityLimits>;
  /** WebGPU is eligible only when this entry explicitly qualifies the workload. */
  readonly qualification?: CapabilityQualification;
  readonly reason?: string;
}

export interface CapabilityQualification {
  readonly qualified: boolean;
  readonly sceneIds?: ReadonlyArray<string>;
  readonly reasons?: ReadonlyArray<string>;
}

export interface CapabilityReport {
  readonly tier: CapabilityTier;
  readonly backends: ReadonlyArray<BackendCapabilities>;
  readonly queries?: ReadonlyArray<CapabilityQueryDescriptor>;
  readonly workload?: RenderWorkload;
}

export interface BackendSelection {
  readonly requested: BackendRequest;
  readonly backend: BackendId | null;
  readonly tier: CapabilityTier | null;
  readonly fallback: boolean;
  readonly fallbackReasons: ReadonlyArray<string>;
  readonly considered: ReadonlyArray<BackendId>;
}

const AUTO_ORDER: readonly BackendId[] = ["webgpu", "webgl2"];
export const WEBGPU_UNQUALIFIED_REASON = "webgpu rejected: capability entry is not qualified for the supplied workload";

function rank(backend: BackendCapabilities): number { return ["compatibility", "portable-modern", "native-advanced", "research"].indexOf(backend.tier); }

function unavailableReason(requested: BackendId, candidate: BackendCapabilities | undefined): string {
  return candidate?.reason ? `${requested} unavailable: ${candidate.reason}` : `${requested} unavailable`;
}

function qualificationReasons(candidate: BackendCapabilities, workload?: RenderWorkload): string[] {
  const qualification = candidate.qualification;
  if (!qualification?.qualified) return [WEBGPU_UNQUALIFIED_REASON, ...(qualification?.reasons ?? [])];
  if (workload?.sceneId && qualification.sceneIds && !qualification.sceneIds.includes(workload.sceneId)) return [`webgpu rejected: scene '${workload.sceneId}' is not qualified`];
  const reasons: string[] = [];
  for (const feature of workload?.requiredFeatures ?? []) if (!candidate.features.includes(feature)) reasons.push(`webgpu rejected: required feature '${feature}' is unavailable`);
  for (const [name, minimum] of Object.entries(workload?.requiredLimits ?? {})) if (typeof minimum === "number" && (candidate.limits[name as keyof CapabilityLimits] ?? 0) < minimum) reasons.push(`webgpu rejected: limit '${name}' is below ${minimum}`);
  return reasons;
}

function isQualified(candidate: BackendCapabilities, workload?: RenderWorkload): boolean {
  return candidate.backend !== "webgpu" || qualificationReasons(candidate, workload).length === 0;
}

/** Selects by a fixed order; capability reports never cause hidden backend changes. */
export function selectBackend(requested: BackendRequest, report: CapabilityReport, workload: RenderWorkload = report.workload ?? {}): BackendSelection {
  const byId = new Map(report.backends.map((entry) => [entry.backend, entry]));
  // WebGL2 is the stable automatic default. WebGPU is opt-in and must be
  // explicitly qualified for the supplied scene/workload.
  const considered = requested === "auto" ? ["webgl2", "webgpu"] as BackendId[] : [requested, ...AUTO_ORDER.filter((backend) => backend !== requested)];
  const reasons: string[] = [];
  for (const backend of considered) {
    const candidate = byId.get(backend);
    if (candidate?.available && (backend !== "webgpu" || isQualified(candidate, workload))) {
      const fallback = backend !== requested && (requested !== "auto" || backend !== "webgl2");
      if (fallback) reasons.unshift(`requested ${requested} was not available`);
      return Object.freeze({ requested, backend, tier: candidate.tier, fallback, fallbackReasons: Object.freeze(reasons), considered: Object.freeze(considered) });
    }
    if (candidate?.available && backend === "webgpu") reasons.push(...qualificationReasons(candidate, workload));
    else reasons.push(unavailableReason(backend, candidate));
  }
  return Object.freeze({ requested, backend: null, tier: null, fallback: false, fallbackReasons: Object.freeze(reasons), considered: Object.freeze(considered) });
}

export const chooseBackend = selectBackend;
export const resolveBackend = selectBackend;

export function highestAvailableTier(report: CapabilityReport): CapabilityTier | null {
  const available = report.backends.filter((backend) => backend.available);
  return available.length ? available.reduce((best, candidate) => rank(candidate) > rank(best) ? candidate : best).tier : null;
}
