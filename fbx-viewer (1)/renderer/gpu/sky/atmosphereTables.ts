/// <reference types="@webgpu/types" />
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";
import { GROUND_RADIUS, MIE_HEIGHT, OZONE_CENTRE, OZONE_HALF_WIDTH, RAYLEIGH_HEIGHT, TOP_RADIUS } from "../../../runtime/sky/atmosphere";
import type { GpuTarget } from "../frame";

/**
 * THE ATMOSPHERE'S TABLES
 *
 * The air's light is precomputed into small tables, each resting on the last, so drawing the sky costs one lookup
 * however thick the air: how much light gets through the air from any height at any angle (transmittance), the light
 * scattered many times over (multiple scattering, solved for all orders at once), and the sky as seen from the camera's
 * height in every direction (sky view). The first two change only with the atmosphere's settings; the last whenever the
 * sun or moon moves.
 *
 * Distances are kilometres, and light is per unit of sunlight above the air, as in runtime/sky/atmosphere.ts.
 */

const TRANSMITTANCE_SIZE: readonly [number, number] = [256, 64];
const MULTISCATTER_SIZE = 32;
const SKY_VIEW_SIZE: readonly [number, number] = [256, 128];
const AIR_WORDS = 32;

const TABLES_WGSL = /* wgsl */ `
const SKY_PI = 3.14159265358979;

struct Air {
  rayleigh: vec3f,
  mieG: f32,
  mieScatter: vec3f,
  groundRadius: f32,
  mieAbsorb: vec3f,
  topRadius: f32,
  ozone: vec3f,
  viewRadius: f32,
  groundAlbedo: vec3f,
  moonLight: f32,
  sun: vec3f,
  moon: vec3f,
  glow: vec3f,
}

@group(0) @binding(0) var<uniform> air: Air;
@group(0) @binding(1) var tableOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var transmittanceTable: texture_2d<f32>;
@group(0) @binding(3) var multiScatterTable: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;

fn raySphere(origin: vec3f, direction: vec3f, radius: f32) -> f32 {
  let b = dot(origin, direction);
  let c = dot(origin, origin) - radius * radius;
  let d = b * b - c;
  if (d < 0.0) { return -1.0; }
  let root = sqrt(d);
  let near = -b - root;
  if (near > 0.0) { return near; }
  let far = -b + root;
  return select(-1.0, far, far > 0.0);
}

struct AirAt {
  rayleigh: vec3f,
  mie: vec3f,
  extinction: vec3f,
}

fn airAt(height: f32) -> AirAt {
  let airDensity = exp(-height / ${RAYLEIGH_HEIGHT.toFixed(1)});
  let hazeDensity = exp(-height / ${MIE_HEIGHT.toFixed(1)});
  let ozoneDensity = max(0.0, 1.0 - abs(height - ${OZONE_CENTRE.toFixed(1)}) / ${OZONE_HALF_WIDTH.toFixed(1)});
  var at: AirAt;
  at.rayleigh = air.rayleigh * airDensity;
  at.mie = air.mieScatter * hazeDensity;
  at.extinction = at.rayleigh + at.mie + air.mieAbsorb * hazeDensity + air.ozone * ozoneDensity;
  return at;
}

fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * SKY_PI) * (1.0 + c * c); }

fn miePhase(c: f32, g: f32) -> f32 {
  let k = 1.0 + g * g - 2.0 * g * c;
  return 3.0 / (8.0 * SKY_PI) * (1.0 - g * g) * (1.0 + c * c) / ((2.0 + g * g) * pow(max(k, 1e-4), 1.5));
}

// The transmittance table's coordinates: spread so the horizon, where it changes fastest, gets the most texels.
fn transmittanceUv(r: f32, mu: f32) -> vec2f {
  let top = air.topRadius;
  let ground = air.groundRadius;
  let h = sqrt(top * top - ground * ground);
  let rho = sqrt(max(0.0, r * r - ground * ground));
  let discriminant = r * r * (mu * mu - 1.0) + top * top;
  let d = max(0.0, -r * mu + sqrt(max(0.0, discriminant)));
  let dMin = top - r;
  let dMax = rho + h;
  return vec2f((d - dMin) / max(dMax - dMin, 1e-5), rho / h);
}

fn transmittanceAt(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transmittanceTable, linearClamp, transmittanceUv(r, mu), 0.0).rgb;
}

// Light reaching a point from a body at cosine mu from straight up: fades as the body sinks past the point's horizon.
fn aboveHorizon(r: f32, mu: f32) -> f32 {
  let s = air.groundRadius / r;
  let horizon = -sqrt(max(0.0, 1.0 - s * s));
  return smoothstep(horizon - 0.008, horizon + 0.008, mu);
}

fn multiScatterAt(radius: f32, mu: f32) -> vec3f {
  let uv = vec2f(mu * 0.5 + 0.5, (radius - air.groundRadius) / (air.topRadius - air.groundRadius));
  return textureSampleLevel(multiScatterTable, linearClamp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
}

@compute @workgroup_size(8, 8) fn transmittanceMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(tableOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let top = air.topRadius;
  let ground = air.groundRadius;
  let h = sqrt(top * top - ground * ground);
  let rho = h * uv.y;
  let r = sqrt(rho * rho + ground * ground);
  let dMin = top - r;
  let dMax = rho + h;
  let d = dMin + uv.x * (dMax - dMin);
  let mu = select(clamp((h * h - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0), 1.0, d <= 0.0);
  let origin = vec3f(0.0, r, 0.0);
  let direction = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  let toGround = raySphere(origin, direction, ground);
  let rayLength = select(raySphere(origin, direction, top), toGround, toGround > 0.0);
  var depth = vec3f(0.0);
  let stepSize = rayLength / 40.0;
  for (var i = 0; i < 40; i++) {
    let point = origin + direction * ((f32(i) + 0.5) * stepSize);
    depth += airAt(max(0.0, sqrt(dot(point, point)) - ground)).extinction * stepSize;
  }
  textureStore(tableOut, id.xy, vec4f(exp(-depth), 1.0));
}

// For each height and sun angle: what an isotropic shell of scattered light adds up to over every order of scattering.
// Light that has scattered twice looks much the same as light that has scattered once more, so the orders form a
// geometric series with one transfer ratio, summed in closed form.
const SPHERE_SAMPLES = 64;
const MARCH_STEPS = 20;
@compute @workgroup_size(8, 8) fn multiScatterMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(tableOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let cosSun = uv.x * 2.0 - 1.0;
  let ground = air.groundRadius;
  let top = air.topRadius;
  let r = ground + 0.001 + uv.y * (top - ground - 0.002);
  let origin = vec3f(0.0, r, 0.0);
  let sun = vec3f(sqrt(max(0.0, 1.0 - cosSun * cosSun)), cosSun, 0.0);
  var secondOrder = vec3f(0.0);
  var transfer = vec3f(0.0);
  for (var s = 0; s < SPHERE_SAMPLES; s++) {
    // Evenly over the sphere (a Fibonacci spiral).
    let index = f32(s) + 0.5;
    let z = 1.0 - 2.0 * index / f32(SPHERE_SAMPLES);
    let phi = SKY_PI * (3.0 - sqrt(5.0)) * index;
    let across = sqrt(max(0.0, 1.0 - z * z));
    let direction = vec3f(across * cos(phi), z, across * sin(phi));
    let toGround = raySphere(origin, direction, ground);
    let toTop = raySphere(origin, direction, top);
    let rayLength = select(toTop, toGround, toGround > 0.0);
    if (rayLength <= 0.0) { continue; }
    let stepSize = rayLength / f32(MARCH_STEPS);
    var throughput = vec3f(1.0);
    for (var i = 0; i < MARCH_STEPS; i++) {
      let point = origin + direction * ((f32(i) + 0.5) * stepSize);
      let radius = sqrt(dot(point, point));
      let at = airAt(max(0.0, radius - ground));
      let scattering = at.rayleigh + at.mie;
      let stepThrough = exp(-at.extinction * stepSize);
      let mu = dot(point, sun) / radius;
      let sunlight = transmittanceAt(radius, mu) * aboveHorizon(radius, mu);
      let source = scattering * sunlight / (4.0 * SKY_PI);
      let safeExtinction = max(at.extinction, vec3f(1e-6));
      secondOrder += throughput * (source - source * stepThrough) / safeExtinction;
      transfer += throughput * (scattering - scattering * stepThrough) / safeExtinction;
      throughput *= stepThrough;
    }
    if (toGround > 0.0) {
      let point = origin + direction * toGround;
      let up = normalize(point);
      let mu = dot(up, sun);
      let sunlight = transmittanceAt(ground + 0.001, mu);
      secondOrder += throughput * sunlight * max(mu, 0.0) * air.groundAlbedo / SKY_PI;
    }
  }
  // Each sample stands for 4 pi / N of the sphere and scattering back into a point is isotropic (1 / 4 pi): they cancel.
  secondOrder /= f32(SPHERE_SAMPLES);
  transfer /= f32(SPHERE_SAMPLES);
  let allOrders = secondOrder / max(vec3f(1.0) - transfer, vec3f(1e-4));
  textureStore(tableOut, id.xy, vec4f(allOrders, 1.0));
}

// The sky seen from the camera's height: every direction, with texels crowding toward the horizon.
const VIEW_STEPS = 32;
@compute @workgroup_size(8, 8) fn skyViewMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(tableOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let offset = uv.y - 0.5;
  let latitude = sign(offset) * (2.0 * abs(offset)) * (2.0 * abs(offset)) * SKY_PI * 0.5;
  let longitude = (uv.x - 0.5) * 2.0 * SKY_PI;
  let direction = vec3f(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
  let origin = vec3f(0.0, air.viewRadius, 0.0);
  let toGround = raySphere(origin, direction, air.groundRadius);
  let toTop = raySphere(origin, direction, air.topRadius);
  let rayLength = select(toTop, toGround, toGround > 0.0);
  var light = vec3f(0.0);
  var throughput = vec3f(1.0);
  if (rayLength > 0.0) {
    let cosSun = dot(direction, air.sun);
    let cosMoon = dot(direction, air.moon);
    let airSun = rayleighPhase(cosSun);
    let hazeSun = miePhase(cosSun, air.mieG);
    let airMoon = rayleighPhase(cosMoon);
    let hazeMoon = miePhase(cosMoon, air.mieG);
    var previous = 0.0;
    for (var i = 0; i < VIEW_STEPS; i++) {
      let f = (f32(i) + 1.0) / f32(VIEW_STEPS);
      let t = rayLength * f * f;
      let dt = t - previous;
      let point = origin + direction * (previous + dt * 0.5);
      previous = t;
      let radius = sqrt(dot(point, point));
      let at = airAt(max(0.0, radius - air.groundRadius));
      let muSun = dot(point, air.sun) / radius;
      let sunlight = transmittanceAt(radius, muSun) * aboveHorizon(radius, muSun);
      let scattered = at.rayleigh + at.mie;
      var source = (at.rayleigh * airSun + at.mie * hazeSun) * sunlight + scattered * multiScatterAt(radius, muSun);
      if (air.moonLight > 0.0) {
        let muMoon = dot(point, air.moon) / radius;
        let moonlight = transmittanceAt(radius, muMoon) * aboveHorizon(radius, muMoon);
        source += air.moonLight * ((at.rayleigh * airMoon + at.mie * hazeMoon) * moonlight + scattered * multiScatterAt(radius, muMoon));
      }
      let stepThrough = exp(-at.extinction * dt);
      light += throughput * (source - source * stepThrough) / max(at.extinction, vec3f(1e-6));
      throughput *= stepThrough;
    }
    if (toGround > 0.0) {
      let up = normalize(origin + direction * toGround);
      let mu = dot(up, air.sun);
      let sunlight = transmittanceAt(air.groundRadius + 0.001, mu);
      // Sunlit, and lit by the sky above it.
      let fill = multiScatterAt(air.groundRadius + 0.001, mu);
      light += throughput * air.groundAlbedo * (sunlight * max(mu, 0.0) / SKY_PI + fill * 0.5);
    }
  }
  // The night air's own faint glow, strongest low down where the eye looks through the most of it.
  let altitude = max(direction.y, 0.0);
  light += air.glow * (0.45 + 0.55 * (1.0 - altitude) * (1.0 - altitude)) * select(1.0, 0.35, direction.y < 0.0);
  textureStore(tableOut, id.xy, vec4f(light, 1.0));
}
`;

const groupsFor = (size: number, group: number): number => Math.ceil(size / group);

const makeTable = (device: GPUDevice, label: string, width: number, height: number): GpuTarget => {
  const texture = device.createTexture({
    label,
    size: [width, height],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  return { texture, view: texture.createView() };
};

/** The three tables, and when each is made again. */
export class AtmosphereTables {
  readonly transmittance: GpuTarget;
  readonly multiScatter: GpuTarget;
  readonly skyView: GpuTarget;
  /** Clamped on both axes. */
  readonly clampSampler: GPUSampler;
  /** Round the compass it joins up. */
  readonly skyViewSampler: GPUSampler;
  /** The camera's distance from the planet's centre, km. */
  viewRadius = GROUND_RADIUS + 0.002;

  private readonly queue: GPUQueue;
  private readonly airBuffer: GPUBuffer;
  private readonly airData = new Float32Array(AIR_WORDS);
  private readonly transmittancePipeline: GPUComputePipeline;
  private readonly multiScatterPipeline: GPUComputePipeline;
  private readonly skyViewPipeline: GPUComputePipeline;
  private readonly transmittanceGroup: GPUBindGroup;
  private readonly multiScatterGroup: GPUBindGroup;
  private readonly skyViewGroup: GPUBindGroup;
  private atmosphereKey = "";
  private skyKey = "";

  constructor(device: GPUDevice) {
    this.transmittance = makeTable(device, "sky transmittance", TRANSMITTANCE_SIZE[0], TRANSMITTANCE_SIZE[1]);
    this.multiScatter = makeTable(device, "sky multiple scattering", MULTISCATTER_SIZE, MULTISCATTER_SIZE);
    this.skyView = makeTable(device, "sky view", SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1]);
    this.clampSampler = device.createSampler({ label: "sky clamped", magFilter: "linear", minFilter: "linear" });
    this.skyViewSampler = device.createSampler({ label: "sky view", magFilter: "linear", minFilter: "linear", addressModeU: "repeat" });
    this.airBuffer = device.createBuffer({ label: "sky air", size: AIR_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: "sky tables", code: TABLES_WGSL });
    const pipeline = (entryPoint: string) => device.createComputePipeline({ label: `sky ${entryPoint}`, layout: "auto", compute: { module, entryPoint } });
    this.transmittancePipeline = pipeline("transmittanceMain");
    this.multiScatterPipeline = pipeline("multiScatterMain");
    this.skyViewPipeline = pipeline("skyViewMain");
    this.transmittanceGroup = device.createBindGroup({
      label: "sky transmittance",
      layout: this.transmittancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.airBuffer } },
        { binding: 1, resource: this.transmittance.view },
      ],
    });
    this.multiScatterGroup = device.createBindGroup({
      label: "sky multiple scattering",
      layout: this.multiScatterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.airBuffer } },
        { binding: 1, resource: this.multiScatter.view },
        { binding: 2, resource: this.transmittance.view },
        { binding: 4, resource: this.clampSampler },
      ],
    });
    this.skyViewGroup = device.createBindGroup({
      label: "sky view",
      layout: this.skyViewPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.airBuffer } },
        { binding: 1, resource: this.skyView.view },
        { binding: 2, resource: this.transmittance.view },
        { binding: 3, resource: this.multiScatter.view },
        { binding: 4, resource: this.clampSampler },
      ],
    });
    this.queue = device.queue;
  }

  private writeAir(frame: SkyFrame): void {
    const co = frame.coefficients;
    const data = this.airData;
    data.set(co.rayleigh, 0);
    data[3] = co.mieG;
    data.set(co.mieScatter, 4);
    data[7] = GROUND_RADIUS;
    data.set(co.mieAbsorb, 8);
    data[11] = TOP_RADIUS;
    data.set(co.ozone, 12);
    data[15] = this.viewRadius;
    data.set(co.ground, 16);
    data[19] = frame.moonLight;
    data[20] = frame.sun.x;
    data[21] = frame.sun.y;
    data[22] = frame.sun.z;
    data[24] = frame.moon.x;
    data[25] = frame.moon.y;
    data[26] = frame.moon.z;
    data.set(frame.glow, 28);
    this.queue.writeBuffer(this.airBuffer, 0, data);
  }

  /** Makes again what `frame` has changed. Call once a frame, before anything reads them. */
  update(encoder: GPUCommandEncoder, frame: SkyFrame): void {
    const key = JSON.stringify(frame.coefficients);
    const airChanged = key !== this.atmosphereKey;
    if (airChanged) {
      this.atmosphereKey = key;
      this.skyKey = "";
    }
    const radius = GROUND_RADIUS + Math.min(Math.max(frame.viewHeight, 0.002), TOP_RADIUS - GROUND_RADIUS - 0.01);
    const skyKey = [
      frame.sun.x, frame.sun.y, frame.sun.z, frame.moon.x, frame.moon.y, frame.moon.z,
      frame.moonLight, frame.glow[0], frame.glow[1], frame.glow[2], Math.round(radius * 2000),
    ].map((value) => value.toFixed(4)).join();
    const skyChanged = skyKey !== this.skyKey;
    if (!airChanged && !skyChanged) return;
    this.skyKey = skyKey;
    this.viewRadius = radius;
    this.writeAir(frame);

    const pass = encoder.beginComputePass({ label: "sky tables" });
    if (airChanged) {
      pass.setPipeline(this.transmittancePipeline);
      pass.setBindGroup(0, this.transmittanceGroup);
      pass.dispatchWorkgroups(groupsFor(TRANSMITTANCE_SIZE[0], 8), groupsFor(TRANSMITTANCE_SIZE[1], 8));
      pass.setPipeline(this.multiScatterPipeline);
      pass.setBindGroup(0, this.multiScatterGroup);
      pass.dispatchWorkgroups(groupsFor(MULTISCATTER_SIZE, 8), groupsFor(MULTISCATTER_SIZE, 8));
    }
    pass.setPipeline(this.skyViewPipeline);
    pass.setBindGroup(0, this.skyViewGroup);
    pass.dispatchWorkgroups(groupsFor(SKY_VIEW_SIZE[0], 8), groupsFor(SKY_VIEW_SIZE[1], 8));
    pass.end();
  }

  dispose(): void {
    this.transmittance.texture.destroy();
    this.multiScatter.texture.destroy();
    this.skyView.texture.destroy();
    this.airBuffer.destroy();
  }
}
