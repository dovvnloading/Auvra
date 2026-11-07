/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { GrowableBuffer } from "../buffers";
import type { SkyEnvironmentProduct } from "../sky/skySettings";

/**
 * WHAT EVERY LIGHT-GATHERING SHADER SHARES
 *
 * One bind group: the numbers (where the probes are, the sky's fill, the suns), the probe atlas, the environment, and a
 * single table of local lights. There is no limit on those lights but memory, because a ray never looks at all of them:
 * the table holds a grid of cells around the camera, each listing the lights that reach it, and what a ray meets is lit
 * from its cell's list.
 *
 * The table is four-word rows:
 *   lights   four rows each: position and range; colour and the cone's inner cosine; aim and outer cosine; decay
 *   grid     per cell the first index and how many, two cells a row
 *   indices  which lights each cell lists, four a row
 * It is one buffer rather than three because a shader tracing rays already has the scene's five tables to bind.
 */

export const GI_DIRECTIONAL_LIGHTS = 8;
const LIGHT_ROWS = 4;
const ROW_WORDS = 4;
/** Cells along each axis of the grid of lights. */
export const LIGHT_CELLS: readonly [number, number, number] = [32, 16, 32];
/** A cell's list longer than this is sampled: a ray looks at a run of this many from a random place in it. */
export const LIGHT_TRIES = 32;
/** Below this much irradiance a light that never quite reaches zero counts as out of reach. */
const REACH_CUTOFF = 0.01;

const SHARED_WORDS = 152;
const DIRECTIONAL_WORDS = 8;
/** How wide the sun looks, as the sine of its angle: rays aim anywhere on it, which softens the shadows they find. */
const SUN_RADIUS = 0.02;

export const giSharedWgsl = (group: number): string => /* wgsl */ `
const GI_PI = 3.141592653589793;
const GI_RECIPROCAL_PI = 0.3183098861837907;
const GI_LIGHT_TRIES = ${LIGHT_TRIES}u;
const GI_LIGHT_ROWS = ${LIGHT_ROWS}u;
struct GiDirectional { way: vec4f, color: vec4f }
struct GiShared {
  // xyz: each cascade's lowest probe, in the world; w: the distance between its probes.
  grids: array<vec4f, 4>,
  ambient: vec4f,
  hemiSky: vec4f,
  hemiGround: vec4f,
  // Nine rgb spherical harmonic coefficients of the environment's radiance.
  environmentSH: array<vec4f, 9>,
  // Intensity of gathered light, how much carries on after its first bounce, the environment's top mip, noise step.
  settings: vec4f,
  // Suns; 8 always, a loop bound the shader compiler cannot see, as on Windows it would otherwise copy out the loop's
  // body for each pass round it and take several times as long; local lights; the frame number.
  counts: vec4u,
  // 1 with probes to read; 1 with an environment to read.
  has: vec4u,
  // xyz: the grid of lights' lowest corner; w: its cell's size.
  lightOrigin: vec4f,
  // xyz: cells along each axis; w: the row the grid starts at.
  lightCells: vec4u,
  // x: the row the lists of indices start at.
  lightIndexRow: vec4u,
  directional: array<GiDirectional, ${GI_DIRECTIONAL_LIGHTS}>,
}
@group(${group}) @binding(0) var<uniform> giShared: GiShared;
@group(${group}) @binding(1) var giAtlas: texture_2d<f32>;
@group(${group}) @binding(2) var giLinear: sampler;
@group(${group}) @binding(3) var giEnvironment: texture_cube<f32>;
@group(${group}) @binding(4) var<storage, read> giLightTable: array<vec4u>;

// The environment's light at a roughness, as a mirror shows it.
fn giEnvironmentRadiance(direction: vec3f, roughness: f32) -> vec3f {
  if (giShared.has.y == 0u) { return vec3f(0.0); }
  return textureSampleLevel(giEnvironment, giLinear, direction, roughness * giShared.settings.z).rgb;
}

// The ambient and hemisphere lights as radiance from a direction, in the renderer's own terms.
fn giFillRadiance(direction: vec3f) -> vec3f {
  let weight = clamp(0.5 + 0.75 * direction.y, 0.0, 1.0);
  return (giShared.ambient.rgb + mix(giShared.hemiGround.rgb, giShared.hemiSky.rgb, weight)) * GI_RECIPROCAL_PI;
}

// The sky from a direction, blurred as far as it goes: what a ray that escaped brings back.
fn giSky(direction: vec3f) -> vec3f {
  return giFillRadiance(direction) + giEnvironmentRadiance(direction, 1.0);
}

// The irradiance a surface would have with nothing in its way, as the lighting pass works it out.
fn giOpenIrradiance(n: vec3f) -> vec3f {
  var result = giShared.environmentSH[0].rgb * 0.886227;
  result += giShared.environmentSH[1].rgb * 2.0 * 0.511664 * n.y;
  result += giShared.environmentSH[2].rgb * 2.0 * 0.511664 * n.z;
  result += giShared.environmentSH[3].rgb * 2.0 * 0.511664 * n.x;
  result += giShared.environmentSH[4].rgb * 2.0 * 0.429043 * n.x * n.y;
  result += giShared.environmentSH[5].rgb * 2.0 * 0.429043 * n.y * n.z;
  result += giShared.environmentSH[6].rgb * (0.743125 * n.z * n.z - 0.247708);
  result += giShared.environmentSH[7].rgb * 2.0 * 0.429043 * n.x * n.z;
  result += giShared.environmentSH[8].rgb * 0.429043 * (n.x * n.x - n.y * n.y);
  let hemi = mix(giShared.hemiGround.rgb, giShared.hemiSky.rgb, 0.5 * n.y + 0.5);
  return giShared.ambient.rgb + hemi + result;
}
`;

/** Lights a point the way the probes' rays and reflections do. Needs giSharedWgsl and raySceneWgsl. */
export const GI_DIRECT_WGSL = /* wgsl */ `
var<private> giRng: u32;

fn giRandom() -> f32 {
  giRng = giRng * 747796405u + 2891336453u;
  var word = ((giRng >> ((giRng >> 28u) + 4u)) ^ giRng) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word) / 4294967296.0;
}

// The sun and moon, each through a shadow ray aimed somewhere on its disc.
fn giDirectional(point: vec3f, normal: vec3f) -> vec3f {
  var light = vec3f(0.0);
  for (var index = 0u; index < giShared.counts.x; index++) {
    let way = giShared.directional[index].way;
    let facing = dot(normal, way.xyz);
    if (facing <= 0.0) { continue; }
    let side = normalize(select(cross(way.xyz, vec3f(1.0, 0.0, 0.0)), cross(way.xyz, vec3f(0.0, 1.0, 0.0)), abs(way.y) < 0.99));
    let other = cross(way.xyz, side);
    let angle = 6.2831853 * giRandom();
    let radius = sqrt(giRandom()) * way.w;
    let aim = normalize(way.xyz + (side * cos(angle) + other * sin(angle)) * radius);
    var blocked: RtHit;
    if (!rtTrace(point + normal * 0.02, aim, 1e5, true, &blocked)) {
      light += giShared.directional[index].color.rgb * facing;
    }
  }
  return light;
}

fn giLightRow(row: u32) -> vec4f {
  return bitcast<vec4f>(giLightTable[row]);
}

// The lights that may reach a point, as the first index and how many. Outside the grid, the nearest cell's.
fn giCellLights(point: vec3f) -> vec2u {
  let dims = vec3i(giShared.lightCells.xyz);
  let at = clamp(vec3i(floor((point - giShared.lightOrigin.xyz) / giShared.lightOrigin.w)), vec3i(0), dims - vec3i(1));
  let cell = u32(at.x + dims.x * (at.z + dims.z * at.y));
  let row = giLightTable[giShared.lightCells.w + cell / 2u];
  return select(row.xy, row.zw, (cell & 1u) == 1u);
}

// One lamp chosen in proportion to what it would give here, through one shadow ray: however many there are, this costs
// a loop over a few and one ray, and what the others would have added is what the average comes to over the frames.
fn giLocal(point: vec3f, normal: vec3f) -> vec3f {
  if (giShared.counts.z == 0u) { return vec3f(0.0); }
  let cell = giCellLights(point);
  if (cell.y == 0u) { return vec3f(0.0); }
  let tries = min(cell.y, GI_LIGHT_TRIES);
  var start = 0u;
  if (cell.y > tries) { start = min(u32(giRandom() * f32(cell.y)), cell.y - 1u); }
  var total = 0.0;
  var chosenWeight = 0.0;
  var chosenGap = 0.0;
  var chosenWay = vec3f(0.0);
  var chosenLight = vec3f(0.0);
  for (var offset = 0u; offset < tries; offset++) {
    let slot = cell.x + (start + offset) % cell.y;
    let index = giLightTable[giShared.lightIndexRow.x + slot / 4u][slot % 4u];
    let first = index * GI_LIGHT_ROWS;
    let place = giLightRow(first);
    let toLight = place.xyz - point;
    let gap = length(toLight);
    if (place.w > 0.0 && gap >= place.w) { continue; }
    let way = toLight / max(gap, 1e-4);
    let facing = dot(normal, way);
    if (facing <= 0.0) { continue; }
    var falloff = 1.0 / max(pow(gap, giLightRow(first + 3u).x), 0.01);
    if (place.w > 0.0) {
      let ratio = gap / place.w;
      let squared = ratio * ratio;
      let edge = saturate(1.0 - squared * squared);
      falloff *= edge * edge;
    }
    let tint = giLightRow(first + 1u);
    let cone = giLightRow(first + 2u);
    if (cone.w > -1.5) {
      let t = saturate((dot(way, cone.xyz) - cone.w) / max(tint.w - cone.w, 1e-5));
      falloff *= t * t * (3.0 - 2.0 * t);
    }
    let light = tint.rgb * falloff * facing;
    let weight = dot(light, vec3f(0.2126, 0.7152, 0.0722));
    if (weight <= 0.0) { continue; }
    total += weight;
    if (giRandom() * total < weight) {
      chosenWeight = weight;
      chosenGap = gap;
      chosenWay = way;
      chosenLight = light;
    }
  }
  // The random number can round up to exactly 1, and then none was chosen.
  if (total <= 0.0 || chosenWeight <= 0.0) { return vec3f(0.0); }
  var blocked: RtHit;
  if (rtTrace(point + normal * 0.02, chosenWay, chosenGap - 0.04, true, &blocked)) { return vec3f(0.0); }
  // Only some of a long list were looked at, and they stand for all of it.
  return chosenLight * (total / chosenWeight) * (f32(cell.y) / f32(tries));
}
`;

export interface GiLightingInput {
  directional: readonly THREE.DirectionalLight[];
  local: readonly (THREE.PointLight | THREE.SpotLight)[];
  ambient: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  environment: SkyEnvironmentProduct | undefined;
  /** Each cascade's lowest probe and spacing; empty with no probes to read. */
  grids: readonly (readonly [number, number, number, number])[];
  intensity: number;
  bounce: number;
  frame: number;
  /** What the grid of lights centres on, and the size of its cells. */
  centre: THREE.Vector3;
  cellSize: number;
  /** Lights outside these layers do not count. */
  layers?: THREE.Layers;
}

const positionOf = (object: THREE.Object3D): ArrayLike<number> => object.matrixWorld.elements;

export class GiLighting {
  readonly layout: GPUBindGroupLayout;
  readonly uniform: GPUBuffer;
  readonly table: GrowableBuffer;
  readonly sampler: GPUSampler;
  private readonly floats = new Float32Array(SHARED_WORDS);
  private readonly words = new Uint32Array(this.floats.buffer);
  private readonly noEnvironmentTexture: GPUTexture;
  private readonly noEnvironment: GPUTextureView;
  private tableData = new ArrayBuffer(ROW_WORDS * 4 * 256);
  private rows = new Float32Array(0);
  private lastRows = new Float32Array(0);
  private lastOrigin = [NaN, NaN, NaN, NaN];
  private lastCount = -1;
  private bound: { group: GPUBindGroup; atlas: GPUTextureView; environment: GPUTextureView; generation: number } | null = null;

  constructor(private readonly device: GPUDevice) {
    const visibility = GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
    this.layout = device.createBindGroupLayout({
      label: "gi shared",
      entries: [
        { binding: 0, visibility, buffer: { type: "uniform", minBindingSize: SHARED_WORDS * 4 } },
        { binding: 1, visibility, texture: { sampleType: "float" } },
        { binding: 2, visibility, sampler: { type: "filtering" } },
        { binding: 3, visibility, texture: { sampleType: "float", viewDimension: "cube" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.uniform = device.createBuffer({ label: "gi shared", size: SHARED_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.table = new GrowableBuffer(device, "gi light table", GPUBufferUsage.STORAGE, this.tableData.byteLength);
    this.sampler = device.createSampler({ label: "gi linear", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this.noEnvironmentTexture = device.createTexture({ label: "gi no environment", size: [1, 1, 6], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.noEnvironment = this.noEnvironmentTexture.createView({ dimension: "cube" });
  }

  /** The environment's view, or a black stand-in. */
  environmentView(environment: SkyEnvironmentProduct | undefined): GPUTextureView {
    return environment?.specular ?? this.noEnvironment;
  }

  /** Writes the numbers and, when the lights or the grid have changed, the table. */
  update(input: GiLightingInput): void {
    const { floats, words } = this;
    input.grids.forEach((grid, index) => floats.set(grid, index * 4));
    floats[16] = input.ambient.r;
    floats[17] = input.ambient.g;
    floats[18] = input.ambient.b;
    floats[20] = input.hemiSky.r;
    floats[21] = input.hemiSky.g;
    floats[22] = input.hemiSky.b;
    floats[24] = input.hemiGround.r;
    floats[25] = input.hemiGround.g;
    floats[26] = input.hemiGround.b;
    const { environment } = input;
    for (let coefficient = 0; coefficient < 9; coefficient++) {
      const at = 28 + coefficient * 4;
      floats[at] = environment ? environment.diffuseSH[coefficient * 3] : 0;
      floats[at + 1] = environment ? environment.diffuseSH[coefficient * 3 + 1] : 0;
      floats[at + 2] = environment ? environment.diffuseSH[coefficient * 3 + 2] : 0;
    }
    floats[64] = input.intensity;
    floats[65] = input.bounce;
    floats[66] = environment ? environment.specularMips - 1 : 0;
    floats[67] = input.frame % 64;

    const suns = input.directional
      // Shadow-only cascades are black: they add nothing.
      .filter((light) => light.color.r + light.color.g + light.color.b > 0 && (!input.layers || light.layers.test(input.layers)))
      .sort((a, b) => (b.color.r + b.color.g + b.color.b) * b.intensity - (a.color.r + a.color.g + a.color.b) * a.intensity)
      .slice(0, GI_DIRECTIONAL_LIGHTS);
    words[68] = suns.length;
    words[69] = 8;
    words[71] = input.frame >>> 0;
    words[72] = input.grids.length ? 1 : 0;
    words[73] = environment ? 1 : 0;
    suns.forEach((light, index) => {
      const at = 88 + index * DIRECTIONAL_WORDS;
      const position = positionOf(light);
      const aim = positionOf(light.target);
      const dx = position[12] - aim[12];
      const dy = position[13] - aim[13];
      const dz = position[14] - aim[14];
      const size = Math.hypot(dx, dy, dz) || 1;
      floats[at] = dx / size;
      floats[at + 1] = dy / size;
      floats[at + 2] = dz / size;
      floats[at + 3] = SUN_RADIUS;
      floats[at + 4] = light.color.r * light.intensity;
      floats[at + 5] = light.color.g * light.intensity;
      floats[at + 6] = light.color.b * light.intensity;
    });
    this.writeLights(input);
    this.device.queue.writeBuffer(this.uniform, 0, floats);
  }

  private writeLights(input: GiLightingInput): void {
    const { floats, words } = this;
    const local = input.layers ? input.local.filter((light) => light.layers.test(input.layers as THREE.Layers)) : input.local;
    const count = local.length;
    const cell = input.cellSize;
    const [cellsX, cellsY, cellsZ] = LIGHT_CELLS;
    const originX = (Math.floor(input.centre.x / cell) - cellsX / 2) * cell;
    const originY = (Math.floor(input.centre.y / cell) - cellsY / 2) * cell;
    const originZ = (Math.floor(input.centre.z / cell) - cellsZ / 2) * cell;
    floats[76] = originX;
    floats[77] = originY;
    floats[78] = originZ;
    floats[79] = cell;
    words[80] = cellsX;
    words[81] = cellsY;
    words[82] = cellsZ;
    words[70] = count;

    if (this.rows.length !== count * LIGHT_ROWS * ROW_WORDS) this.rows = new Float32Array(count * LIGHT_ROWS * ROW_WORDS);
    const { rows } = this;
    rows.fill(0);
    for (let index = 0; index < count; index++) {
      const light = local[index];
      const at = index * LIGHT_ROWS * ROW_WORDS;
      const position = positionOf(light);
      const spot = light as THREE.SpotLight;
      rows[at] = position[12];
      rows[at + 1] = position[13];
      rows[at + 2] = position[14];
      rows[at + 3] = light.distance;
      rows[at + 4] = light.color.r * light.intensity;
      rows[at + 5] = light.color.g * light.intensity;
      rows[at + 6] = light.color.b * light.intensity;
      rows[at + 12] = light.decay;
      if (spot.isSpotLight) {
        const aim = positionOf(spot.target);
        const dx = position[12] - aim[12];
        const dy = position[13] - aim[13];
        const dz = position[14] - aim[14];
        const size = Math.hypot(dx, dy, dz) || 1;
        rows[at + 7] = Math.cos(spot.angle * (1 - spot.penumbra));
        rows[at + 8] = dx / size;
        rows[at + 9] = dy / size;
        rows[at + 10] = dz / size;
        rows[at + 11] = Math.cos(spot.angle);
      } else {
        // No cone.
        rows[at + 11] = -2;
      }
    }
    // Unmoved lights and an unmoved grid: what is on the graphics card is still right.
    const origin = [originX, originY, originZ, cell];
    let same = count === this.lastCount && rows.length === this.lastRows.length && origin.every((value, index) => value === this.lastOrigin[index]);
    for (let at = 0; same && at < rows.length; at++) same = rows[at] === this.lastRows[at];
    if (same) return;
    if (this.lastRows.length !== rows.length) this.lastRows = new Float32Array(rows.length);
    this.lastRows.set(rows);
    this.lastOrigin = origin;
    this.lastCount = count;
    words[83] = 0;
    words[84] = 0;
    if (!count) return;

    const cells = cellsX * cellsY * cellsZ;
    const counts = new Uint32Array(cells);
    const spans = new Int32Array(count * 6);
    let listed = 0;
    const toCell = (value: number, low: number, size: number): number => Math.max(0, Math.min(size - 1, Math.floor((value - low) / cell)));
    for (let index = 0; index < count; index++) {
      const light = local[index];
      const at = index * LIGHT_ROWS * ROW_WORDS;
      const brightest = Math.max(rows[at + 4], rows[at + 5], rows[at + 6]);
      if (brightest <= 0) {
        spans.fill(0, index * 6, index * 6 + 6);
        spans[index * 6 + 3] = -1;
        continue;
      }
      const fades = light.decay > 0 ? Math.pow(brightest / REACH_CUTOFF, 1 / light.decay) : Infinity;
      const reach = light.distance > 0 ? Math.min(light.distance, fades) : fades;
      const lowX = toCell(rows[at] - reach, originX, cellsX), highX = toCell(rows[at] + reach, originX, cellsX);
      const lowY = toCell(rows[at + 1] - reach, originY, cellsY), highY = toCell(rows[at + 1] + reach, originY, cellsY);
      const lowZ = toCell(rows[at + 2] - reach, originZ, cellsZ), highZ = toCell(rows[at + 2] + reach, originZ, cellsZ);
      spans[index * 6] = lowX;
      spans[index * 6 + 1] = lowY;
      spans[index * 6 + 2] = lowZ;
      spans[index * 6 + 3] = highX;
      spans[index * 6 + 4] = highY;
      spans[index * 6 + 5] = highZ;
      for (let y = lowY; y <= highY; y++) {
        for (let z = lowZ; z <= highZ; z++) {
          for (let x = lowX; x <= highX; x++) {
            counts[x + cellsX * (z + cellsZ * y)]++;
            listed++;
          }
        }
      }
    }
    const gridRow = count * LIGHT_ROWS;
    const gridRows = Math.ceil(cells / 2);
    const indexRow = gridRow + gridRows;
    const indexRows = Math.ceil(listed / 4);
    const bytes = Math.max(1, indexRow + indexRows) * ROW_WORDS * 4;
    if (this.tableData.byteLength < bytes) this.tableData = new ArrayBuffer(Math.ceil(bytes * 1.5));
    const tableFloats = new Float32Array(this.tableData);
    const tableWords = new Uint32Array(this.tableData);
    tableFloats.set(rows, 0);
    const firsts = new Uint32Array(cells);
    let running = 0;
    for (let at = 0; at < cells; at++) {
      firsts[at] = running;
      tableWords[gridRow * ROW_WORDS + at * 2] = running;
      tableWords[gridRow * ROW_WORDS + at * 2 + 1] = counts[at];
      running += counts[at];
    }
    const indexWord = indexRow * ROW_WORDS;
    for (let index = 0; index < count; index++) {
      if (spans[index * 6 + 3] < 0) continue;
      for (let y = spans[index * 6 + 1]; y <= spans[index * 6 + 4]; y++) {
        for (let z = spans[index * 6 + 2]; z <= spans[index * 6 + 5]; z++) {
          for (let x = spans[index * 6]; x <= spans[index * 6 + 3]; x++) {
            const at = x + cellsX * (z + cellsZ * y);
            tableWords[indexWord + firsts[at]++] = index;
          }
        }
      }
    }
    this.table.ensure(bytes);
    this.table.write(0, tableWords, 0, bytes);
    words[83] = gridRow;
    words[84] = indexRow;
  }

  bindGroup(atlas: GPUTextureView, environment: GPUTextureView): GPUBindGroup {
    const { bound } = this;
    if (bound && bound.atlas === atlas && bound.environment === environment && bound.generation === this.table.generation) return bound.group;
    const group = this.device.createBindGroup({
      label: "gi shared",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: atlas },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: environment },
        { binding: 4, resource: { buffer: this.table.buffer } },
      ],
    });
    this.bound = { group, atlas, environment, generation: this.table.generation };
    return group;
  }

  destroy(): void {
    this.uniform.destroy();
    this.table.destroy();
    this.noEnvironmentTexture.destroy();
  }
}
