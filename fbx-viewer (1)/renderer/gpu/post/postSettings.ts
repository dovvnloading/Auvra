import type { PostProcessAntialias, PostProcessSettings } from "../../../runtime/components/postProcess";
import type { ColorLook } from "../../../runtime/postEffects";

/**
 * WHAT THE POST STACK IS TOLD
 *
 * A level's Post Process component gives the stack its settings, as it gives them to the WebGL stack. A few numbers
 * were fixed in the WebGL stack rather than being settings, and differ between a component's stack and the runtime's
 * default one; those are `GpuPostTuning`.
 *
 * Renderer settings this stack writes:
 *  - "temporal.renderScale": number, the size the targets are drawn at. 1 with temporal anti-aliasing off.
 *  - "temporal.jitter": (frame) => [x, y], this frame's offset in drawn pixels, y up; absent with temporal off.
 *  - "temporal.mipBias": number, mip levels to shift texture lookups by while drawing the surfaces.
 *  - "post.display": GpuDisplaySettings, what happens after tone mapping, read by the present pass.
 *  - "post.settings": PostProcessSettings, for passes outside this folder that a level's stack turns up and down
 *    (ambient occlusion, bounced light, reflections).
 * It also sets the renderer's own toneMapping and toneMappingExposure, which the renderer hands on as settings.
 */

export interface GpuPostTuning {
  bloomSmoothing: number;
  bloomRadius: number;
  vignetteOffset: number;
  /** The vignette darkens the light before tone mapping rather than the display values after it. */
  vignetteFirst?: boolean;
}

/** A level's Post Process component. */
export const GPU_POST_TUNING: GpuPostTuning = { bloomSmoothing: 0.2, bloomRadius: 0.7, vignetteOffset: 0.35 };

/** The runtime's default stack, standing in when no level component owns the canvas. */
export const GPU_DEFAULT_TUNING: GpuPostTuning = { bloomSmoothing: 0.025, bloomRadius: 0.85, vignetteOffset: 0.1, vignetteFirst: true };

/** The runtime's default stack: bounced light, reflections, haze, shafts, auto exposure, bloom, vignette and ACES. */
export const GPU_DEFAULT_SETTINGS: PostProcessSettings = {
  bloom: true,
  bloomIntensity: 0.6,
  bloomThreshold: 1.2,
  ambientOcclusion: false,
  aoIntensity: 2,
  aoRadius: 1.5,
  toneMapping: "aces",
  exposure: 1,
  vignette: true,
  vignetteDarkness: 1.1,
  depthOfField: false,
  focusDistance: 10,
  bokehScale: 2,
  saturation: 0,
  contrast: 0,
  brightness: 0,
  antialias: "temporal",
  renderScale: 1,
  sharpness: 0.25,
  autoExposure: true,
  exposureCompensation: 0,
  adaptationSpeed: 1,
  lightShafts: true,
  lightShaftsIntensity: 0.35,
  sunHaze: true,
  sunHazeIntensity: 0.5,
  globalIllumination: true,
  giIntensity: 1,
  reflections: true,
  reflectionIntensity: 1,
  motionBlur: false,
  motionBlurStrength: 0.5,
  temperature: 0,
  tint: 0,
  look: "none",
  lookStrength: 1,
  filmGrain: 0,
  chromaticAberration: 0,
};

/** What the compute side of the stack runs from: `antialias` and `renderScale` are after the project's limits. */
export interface GpuPostConfig extends PostProcessSettings, GpuPostTuning {
  antialias: PostProcessAntialias;
  renderScale: number;
}

/** What happens after tone mapping, in the present pass; the renderer's own picture has none of it without a stack. */
export interface GpuDisplaySettings {
  saturation: number;
  brightness: number;
  contrast: number;
  look: ColorLook;
  lookStrength: number;
  vignette: boolean;
  vignetteOffset: number;
  vignetteDarkness: number;
  vignetteFirst: boolean;
  chromaticAberration: number;
  filmGrain: number;
}

export const displaySettingsOf = (config: GpuPostConfig): GpuDisplaySettings => ({
  saturation: config.saturation,
  brightness: config.brightness,
  contrast: config.contrast,
  look: config.look,
  lookStrength: config.look === "none" ? 0 : config.lookStrength,
  vignette: config.vignette,
  vignetteOffset: config.vignetteOffset,
  vignetteDarkness: config.vignetteDarkness,
  vignetteFirst: !!config.vignetteFirst,
  chromaticAberration: config.chromaticAberration,
  filmGrain: config.filmGrain,
});
