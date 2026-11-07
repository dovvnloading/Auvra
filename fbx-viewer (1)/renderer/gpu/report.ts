import { frontendDiagnostics } from "../../diagnostics/runtime";

/**
 * WHAT THE RENDERER HAS TO SAY
 *
 * A pipeline that would not compile, a material nothing can draw, a pass that failed: the frame goes on without it, so
 * each is written down here and counted in the diagnostics rather than stopping anything.
 */

const MAX_REPORTS = 200;

/** The latest reports, newest last. */
export const gpuReports: string[] = [];
(globalThis as { auvraGpuReports?: string[] }).auvraGpuReports = gpuReports;

const describe = (part: unknown): string => {
  if (part instanceof Error) return part.message;
  return typeof part === "string" ? part : String(part);
};

export const reportGpu = (...parts: unknown[]): void => {
  const report = parts.map(describe).join(" ");
  // One broken pipeline says the same thing every frame: the first of a kind is the one worth keeping.
  if (gpuReports.includes(report)) return;
  gpuReports.push(report);
  if (gpuReports.length > MAX_REPORTS) gpuReports.shift();
  frontendDiagnostics.warning("gpu_renderer_report");
};
