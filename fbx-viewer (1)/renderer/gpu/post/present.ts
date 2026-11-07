/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import { FULLSCREEN_WGSL } from "../shaders";
import { LOOK_SIZE, LookTextures } from "./looks";
import { BindCache, type ResolvedImage } from "./postImages";
import type { GpuDisplaySettings } from "./postSettings";

/**
 * PUTTING THE PICTURE ON THE CANVAS
 *
 * One full-screen draw from the post stack's "resolved" picture, or the HDR target when no stack is running, onto the
 * view's rectangle of the canvas. On the way: three's tone curve with the renderer's exposure, then what the WebGL
 * stack does on display values, in its order (saturation, brightness and contrast, look, vignette, colour fringes,
 * grain), and last the linear to sRGB encoding, since the canvas format does not do it.
 *
 * Reads the renderer's settings "toneMapping" (a three.js constant), "toneMappingExposure" and, while a post stack is
 * running, "post.display" (GpuDisplaySettings).
 */

const PRESENT_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
struct Present {
  exposure: f32,
  curve: u32,
  saturation: f32,
  brightness: f32,
  contrast: f32,
  lookStrength: f32,
  vignetteOffset: f32,
  vignetteDarkness: f32,
  vignette: f32,
  grain: f32,
  time: f32,
  // 1: the vignette darkens the light before tone mapping, as the default stack has it. 0: the display values after it.
  vignetteFirst: f32,
  fringe: vec2f,
}

@group(0) @binding(0) var<uniform> p: Present;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var look: texture_3d<f32>;

const LOOK_SCALE = ${(LOOK_SIZE - 1) / LOOK_SIZE};
const LOOK_OFFSET = ${1 / (2 * LOOK_SIZE)};
const FRINGE_START = 0.25;
const PI = 3.141592653589793;

// ---- Three's tone curves.

fn reinhard(input: vec3f) -> vec3f {
  let color = input * p.exposure;
  return saturate(color / (vec3f(1.0) + color));
}

fn cineon(input: vec3f) -> vec3f {
  let color = max(vec3f(0.0), input * p.exposure - vec3f(0.004));
  return pow((color * (6.2 * color + vec3f(0.5))) / (color * (6.2 * color + vec3f(1.7)) + vec3f(0.06)), vec3f(2.2));
}

fn rrtAndOdtFit(v: vec3f) -> vec3f {
  let a = v * (v + vec3f(0.0245786)) - vec3f(0.000090537);
  let b = v * (0.983729 * v + vec3f(0.4329510)) + vec3f(0.238081);
  return a / b;
}

const ACES_INPUT = mat3x3f(
  vec3f(0.59719, 0.07600, 0.02840),
  vec3f(0.35458, 0.90834, 0.13383),
  vec3f(0.04823, 0.01566, 0.83777)
);

const ACES_OUTPUT = mat3x3f(
  vec3f(1.60475, -0.10208, -0.00327),
  vec3f(-0.53108, 1.10813, -0.07276),
  vec3f(-0.07367, -0.00605, 1.07602)
);

fn acesFilmic(input: vec3f) -> vec3f {
  var color = input * (p.exposure / 0.6);
  color = ACES_INPUT * color;
  color = rrtAndOdtFit(color);
  color = ACES_OUTPUT * color;
  return saturate(color);
}

const LINEAR_REC2020_TO_LINEAR_SRGB = mat3x3f(
  vec3f(1.6605, -0.1246, -0.0182),
  vec3f(-0.5876, 1.1329, -0.1006),
  vec3f(-0.0728, -0.0083, 1.1187)
);

const LINEAR_SRGB_TO_LINEAR_REC2020 = mat3x3f(
  vec3f(0.6274, 0.0691, 0.0164),
  vec3f(0.3293, 0.9195, 0.0880),
  vec3f(0.0433, 0.0113, 0.8956)
);

fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - vec3f(0.00232);
}

const AGX_INSET = mat3x3f(
  vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859)
);

const AGX_OUTSET = mat3x3f(
  vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
);

const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

fn agx(input: vec3f) -> vec3f {
  var color = input * p.exposure;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AGX_INSET * color;
  color = max(color, vec3f(1e-10));
  color = log2(color);
  color = (color - vec3f(AGX_MIN_EV)) / (AGX_MAX_EV - AGX_MIN_EV);
  color = saturate(color);
  color = agxContrast(color);
  color = AGX_OUTSET * color;
  color = pow(max(vec3f(0.0), color), vec3f(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return saturate(color);
}

fn neutral(input: vec3f) -> vec3f {
  const START_COMPRESSION = 0.8 - 0.04;
  const DESATURATION = 0.15;
  var color = input * p.exposure;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color -= vec3f(offset);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < START_COMPRESSION) { return color; }
  let d = 1.0 - START_COMPRESSION;
  let newPeak = 1.0 - d * d / (peak + d - START_COMPRESSION);
  color *= newPeak / peak;
  let g = 1.0 - 1.0 / (DESATURATION * (peak - newPeak) + 1.0);
  return mix(color, vec3f(newPeak), g);
}

fn toneMap(color: vec3f) -> vec3f {
  switch (p.curve) {
    case 1u: { return acesFilmic(color); }
    case 2u: { return agx(color); }
    case 3u: { return reinhard(color); }
    case 4u: { return neutral(color); }
    case 5u: { return saturate(p.exposure * color); }
    case 6u: { return cineon(color); }
    default: { return color; }
  }
}

// ---- Display values.

fn encodeSrgb(c: vec3f) -> vec3f {
  let high = pow(max(c, vec3f(0.0)), vec3f(0.41666)) * 1.055 - vec3f(0.055);
  return select(high, c * 12.92, c <= vec3f(0.0031308));
}

fn decodeSrgb(c: vec3f) -> vec3f {
  let high = pow(max(c, vec3f(0.0)) * 0.9478672986 + vec3f(0.0521327014), vec3f(2.4));
  return select(high, c * 0.0773993808, c <= vec3f(0.04045));
}

fn saturated(input: vec3f) -> vec3f {
  let average = (input.r + input.g + input.b) / 3.0;
  let difference = vec3f(average) - input;
  var c = input;
  if (p.saturation > 0.0) {
    c += difference * (1.0 - 1.0 / (1.001 - p.saturation));
  } else {
    c += difference * -p.saturation;
  }
  return min(c, vec3f(1.0));
}

// A falling curve the built-in smoothstep is not defined for: its low edge lies above its high one.
fn vignetted(input: vec3f, uv: vec2f) -> vec3f {
  let d = distance(uv, vec2f(0.5)) * (p.vignetteDarkness + p.vignetteOffset);
  let low = 0.8;
  let high = p.vignetteOffset * 0.799;
  let t = clamp((d - low) / (high - low), 0.0, 1.0);
  return input * (t * t * (3.0 - 2.0 * t));
}

// The tone-mapped, graded picture at a place, in linear display values.
fn pictureAt(uv: vec2f) -> vec3f {
  var scene = max(textureSampleLevel(source, linearClamp, uv, 0.0).rgb, vec3f(0.0));
  if (p.vignette > 0.5 && p.vignetteFirst > 0.5) { scene = vignetted(scene, uv); }
  var c = toneMap(scene);
  if (p.saturation != 0.0) { c = saturated(c); }
  // Brightness, contrast and looks work on encoded values.
  let graded = p.brightness != 0.0 || p.contrast != 0.0;
  if (graded || p.lookStrength > 0.0) {
    c = encodeSrgb(c);
    if (graded) {
      c += vec3f(p.brightness - 0.5);
      if (p.contrast > 0.0) {
        c /= vec3f(max(1.0 - p.contrast, 1e-4));
      } else {
        c *= vec3f(1.0 + p.contrast);
      }
      c += vec3f(0.5);
    }
    if (p.lookStrength > 0.0) {
      c = mix(c, textureSampleLevel(look, linearClamp, c * LOOK_SCALE + vec3f(LOOK_OFFSET), 0.0).rgb, p.lookStrength);
    }
    c = decodeSrgb(c);
  }
  if (p.vignette > 0.5 && p.vignetteFirst < 0.5) { c = vignetted(c, uv); }
  return c;
}

fn rand(uv: vec2f) -> f32 {
  let dt = dot(uv, vec2f(12.9898, 78.233));
  let sn = dt - PI * floor(dt / PI);
  return fract(sin(sn) * 43758.5453);
}

fn softLight(x: vec3f, y: vec3f, opacity: f32) -> vec3f {
  let y2 = 2.0 * y;
  let w = step(vec3f(0.5), y);
  let z = mix(
    x - (vec3f(1.0) - y2) * x * (vec3f(1.0) - x),
    mix(
      x + (y2 - vec3f(1.0)) * (sqrt(max(x, vec3f(0.0))) - x),
      x + (y2 - vec3f(1.0)) * x * ((16.0 * x - vec3f(12.0)) * x + vec3f(3.0)),
      w * (vec3f(1.0) - step(vec3f(0.25), x))
    ),
    w
  );
  return mix(x, z, opacity);
}

@fragment
fn presentFragment(in: FullscreenOut) -> @location(0) vec4f {
  let uv = in.uv;
  var c: vec3f;
  // Colour fringes, growing from the middle of the view outward.
  let reach = max(distance(uv, vec2f(0.5)) * 2.0 - FRINGE_START, 0.0);
  if (reach > 0.0 && any(p.fringe != vec2f(0.0))) {
    let shift = p.fringe * reach;
    c = vec3f(pictureAt(uv + shift).r, pictureAt(uv).g, pictureAt(uv - shift).b);
  } else {
    c = pictureAt(uv);
  }
  if (p.grain > 0.0) {
    let noise = rand(uv * (1.0 + p.time));
    c = softLight(c, min(c * noise, vec3f(1.0)), p.grain);
  }
  return vec4f(encodeSrgb(c), 1.0);
}
`;

const PRESENT_BYTES = 64;
const CHROMATIC_ABERRATION_SHIFT = 0.004;
const GRAIN_OPACITY = 0.6;

const CURVES = new Map<unknown, number>([
  [THREE.NoToneMapping, 0],
  [THREE.ACESFilmicToneMapping, 1],
  [THREE.AgXToneMapping, 2],
  [THREE.ReinhardToneMapping, 3],
  [THREE.NeutralToneMapping, 4],
  [THREE.LinearToneMapping, 5],
  [THREE.CineonToneMapping, 6],
]);
const ACES_CURVE = 1;

export class PresentPass implements GpuPass {
  readonly id = "present";
  readonly stage = "post" as const;
  readonly order = Number.MAX_SAFE_INTEGER;

  private readonly device: GPUDevice;
  private readonly binds: BindCache;
  private readonly looks: LookTextures;
  private readonly uniformData = new Float32Array(PRESENT_BYTES / 4);
  private readonly uniformWords = new Uint32Array(this.uniformData.buffer);
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private module: GPUShaderModule | null = null;
  private uniforms: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  constructor(core: GpuCore) {
    this.device = core.device;
    this.binds = new BindCache(core.device);
    this.looks = new LookTextures(core.device);
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.pipelines.get(format);
    if (pipeline) return pipeline;
    if (!this.module) this.module = this.device.createShaderModule({ label: "gpu present", code: PRESENT_WGSL });
    pipeline = this.device.createRenderPipeline({
      label: "gpu present",
      layout: "auto",
      vertex: { module: this.module, entryPoint: "fullscreenVertex" },
      fragment: { module: this.module, entryPoint: "presentFragment", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.pipelines.set(format, pipeline);
    return pipeline;
  }

  private writeUniforms(frame: GpuFrame, settings: Map<string, unknown> | undefined, display: GpuDisplaySettings | undefined): void {
    const data = this.uniformData;
    const exposure = settings?.get("toneMappingExposure");
    data[0] = typeof exposure === "number" && Number.isFinite(exposure) ? exposure : 1;
    this.uniformWords[1] = CURVES.get(settings?.get("toneMapping")) ?? ACES_CURVE;
    data[2] = display?.saturation ?? 0;
    data[3] = display?.brightness ?? 0;
    data[4] = display?.contrast ?? 0;
    data[5] = display?.lookStrength ?? 0;
    data[6] = display?.vignetteOffset ?? 0;
    data[7] = display?.vignetteDarkness ?? 0;
    data[8] = display?.vignette ? 1 : 0;
    data[9] = (display?.filmGrain ?? 0) * GRAIN_OPACITY;
    data[10] = frame.time;
    data[11] = display?.vignetteFirst ? 1 : 0;
    // Red and blue pull apart along a slant, its height in proportion to the view's shape; y runs down the texture.
    const shift = (display?.chromaticAberration ?? 0) * CHROMATIC_ABERRATION_SHIFT;
    data[12] = shift;
    data[13] = -shift * (frame.viewport.width / Math.max(1, frame.viewport.height));
    if (!this.uniforms) {
      this.uniforms = this.device.createBuffer({ label: "gpu present", size: PRESENT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.uniforms, 0, data);
  }

  execute(frame: GpuFrame): void {
    const renderer = frame.products.get("renderer") as { settings?: Map<string, unknown> } | undefined;
    const settings = renderer?.settings;
    const display = settings?.get("post.display") as GpuDisplaySettings | undefined;
    this.writeUniforms(frame, settings, display);

    // Products outlive a frame: this one counts only if the stack ran for this view.
    const resolved = frame.products.get("resolved") as ResolvedImage | undefined;
    const source = resolved && resolved.frameNumber === frame.frameNumber ? resolved.view : frame.targets.hdr.view;
    if (!this.sampler) this.sampler = this.device.createSampler({ label: "gpu present", minFilter: "linear", magFilter: "linear" });
    const pipeline = this.pipelineFor(frame.presentFormat);
    const look = this.looks.viewOf(display?.look ?? "none");
    const group = this.binds.group(pipeline, [this.uniforms!, source, this.sampler, look]);

    const pass = frame.encoder.beginRenderPass({
      label: "gpu present",
      colorAttachments: [{
        view: frame.canvasView,
        loadOp: frame.canvasLoadOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: "store",
      }],
    });
    const { x, y, width, height } = frame.viewport;
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setScissorRect(x, y, width, height);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    this.uniforms?.destroy();
    this.uniforms = null;
    this.looks.dispose();
    this.binds.clear();
  }
}
