import { COVER_CELLS } from "../../../runtime/weatherCover";

/**
 * WEATHER ON SURFACES
 *
 * Rain darkens what it falls on and makes it shine, pooling into puddles on flat ground; snow settles on what faces up,
 * patchily while it is thin; under cover surfaces stay dry. The same look runtime/weatherSurfaces.ts patches into a lit
 * material, as a step a kind runs on its finished surface. Which materials take it is theirs to say, by the same test.
 */

export const WEATHER_WGSL = /* wgsl */ `
fn weatherHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn weatherNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(weatherHash(i), weatherHash(i + vec2f(1.0, 0.0)), u.x),
             mix(weatherHash(i + vec2f(0.0, 1.0)), weatherHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn weatherOpenAt(cell: vec2i, y: f32) -> f32 {
  if (any(cell < vec2i(0)) || any(cell >= vec2i(${COVER_CELLS}))) { return 1.0; }
  let top = textureLoad(surfaceCover, cell, 0).r;
  return smoothstep(top - 0.6, top - 0.2, y);
}
// How open to the sky a point is: 1 out in the weather, 0 under a roof, blended between cells.
fn weatherOpen(position: vec3f) -> f32 {
  if (surfaceWorld.weather.z < 0.5) { return 1.0; }
  let g = (position.xz - surfaceWorld.coverOrigin.xy) / surfaceWorld.weather.w - vec2f(0.5);
  let c = vec2i(floor(g));
  let f = fract(g);
  return mix(
    mix(weatherOpenAt(c, position.y), weatherOpenAt(c + vec2i(1, 0), position.y), f.x),
    mix(weatherOpenAt(c + vec2i(0, 1), position.y), weatherOpenAt(c + vec2i(1, 1), position.y), f.x),
    f.y);
}
fn applyWeather(in: SurfaceIn, dry: SurfaceOut) -> SurfaceOut {
  var out = dry;
  let wetness = surfaceWorld.weather.x;
  let snow = surfaceWorld.weather.y;
  if (wetness + snow <= 0.001 || view.kind != 0u) { return out; }
  let facing = out.normal.y;
  let sky = weatherOpen(in.worldPosition);
  let patches = weatherNoise(in.worldPosition.xz * 0.6) * 0.65 + weatherNoise(in.worldPosition.xz * 2.3) * 0.35;
  // Snow on what faces up, thin and patchy at first.
  let settled = sky * smoothstep(0.0, 0.25, snow * 1.25 - (1.0 - facing) * 0.9 - patches * 0.35);
  // Wet: darker and glossier, vertical faces less, flat ground pooling into puddles.
  let wet = wetness * sky * (1.0 - settled) * (0.6 + 0.4 * clamp(facing, 0.0, 1.0));
  let puddle = wet * smoothstep(0.5, 0.68, patches + wetness * 0.12) * pow(clamp(facing, 0.0, 1.0), 6.0);
  out.albedo *= 1.0 - 0.42 * wet - 0.2 * puddle;
  out.roughness = mix(out.roughness, min(out.roughness, 0.22), wet);
  out.roughness = mix(out.roughness, 0.03, puddle);
  out.albedo = mix(out.albedo, vec3f(0.86, 0.89, 0.93), settled);
  out.roughness = mix(out.roughness, 0.75, settled);
  out.metalness = mix(out.metalness, 0.0, settled);
  return out;
}
`;
