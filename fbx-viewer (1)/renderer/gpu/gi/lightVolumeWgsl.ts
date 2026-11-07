/**
 * THE BAKED LIGHT VOLUME IN WGSL
 *
 * A baked volume on the graphics card: products "lightVolume" (lightVolume.ts) holds its probes, three stacked copies of
 * the grid in one 3D texture, four rgb coefficients per probe in three's order, and a small uniform saying where they
 * are. A pass pastes `lightVolumeWgsl(group, binding)` into its shader, binds the two, and reads:
 *
 *   let share = lightVolumeWeight(position);        // 1 inside the volume, fading to 0 just outside
 *   let light = lightVolumeIrradiance(position, normal);
 *
 * The eight probes around the point are each weighted by how near it is and by whether it lies in front of the surface:
 * one behind it, across a wall or floor, counts for next to nothing, so light does not leak through.
 */

/** A probe's weight by the cosine between the surface normal and the way to it: full from here up... */
const FRONT_FACING = 0.3;
/** ...fading to BEHIND_WEIGHT here and below. */
const BEHIND_FACING = -0.2;
const BEHIND_WEIGHT = 0.001;

export const LIGHT_VOLUME_PARAM_BYTES = 48;

export const lightVolumeWgsl = (group: number, binding: number): string => /* wgsl */ `
struct LightVolumeParams {
  origin: vec4f,
  extent: vec4f,
  // intensity, 1 when there is a volume, how far out from the surface to read, how far past the edge it fades
  settings: vec4f,
}
@group(${group}) @binding(${binding}) var lightVolumeProbes: texture_3d<f32>;
@group(${group}) @binding(${binding + 1}) var<uniform> lightVolume: LightVolumeParams;

fn lightVolumeWeight(position: vec3f) -> f32 {
  if (lightVolume.settings.y < 0.5) { return 0.0; }
  let outside = max(lightVolume.origin.xyz - position, position - (lightVolume.origin.xyz + lightVolume.extent.xyz));
  return 1.0 - smoothstep(0.0, lightVolume.settings.w, max(max(outside.x, outside.y), outside.z));
}

fn lightVolumeIrradiance(position: vec3f, normal: vec3f) -> vec3f {
  let stacked = vec3i(textureDimensions(lightVolumeProbes));
  let layers = stacked.z / 3;
  let last = vec3f(f32(stacked.x - 1), f32(stacked.y - 1), f32(layers - 1));
  let spacing = lightVolume.extent.xyz / max(last, vec3f(1.0));
  let cell = clamp((position + normal * lightVolume.settings.z - lightVolume.origin.xyz) / max(lightVolume.extent.xyz, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)) * last;
  let base = min(floor(cell), max(last - vec3f(1.0), vec3f(0.0)));
  let f = cell - base;
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  var c = vec4f(0.0);
  var total = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let corner = vec3f(f32(i & 1u), f32((i >> 1u) & 1u), f32((i >> 2u) & 1u));
    let probe = min(base + corner, last);
    let near = mix(vec3f(1.0) - f, f, corner);
    let toProbe = lightVolume.origin.xyz + probe * spacing - position;
    let facing = dot(toProbe, normal) / max(length(toProbe), 1e-4);
    let weight = near.x * near.y * near.z * max(smoothstep(${BEHIND_FACING.toFixed(2)}, ${FRONT_FACING.toFixed(2)}, facing), ${BEHIND_WEIGHT});
    let texel = vec3i(probe);
    a += textureLoad(lightVolumeProbes, texel, 0) * weight;
    b += textureLoad(lightVolumeProbes, vec3i(texel.xy, texel.z + layers), 0) * weight;
    c += textureLoad(lightVolumeProbes, vec3i(texel.xy, texel.z + layers * 2), 0) * weight;
    total += weight;
  }
  a /= total;
  b /= total;
  c /= total;
  // three's order: constant, then y, z, x.
  let irradiance = a.rgb * 0.886227 + 1.023328 * (vec3f(a.a, b.rg) * normal.y + vec3f(b.ba, c.r) * normal.z + c.gba * normal.x);
  return max(irradiance, vec3f(0.0)) * lightVolume.settings.x;
}
`;
