/**
 * BAKED LIGHT
 *
 * The level's irradiance volume (runtime/lighting/bakedLighting.ts), read where each pixel of a lit surface is. The
 * eight probes around the point count by how near they are and by whether they lie in front of the surface, so light
 * does not leak through walls. Where a surface has it, the volume stands in for the unbaked sky fill; past the outer
 * probes the fill takes over again, and across that edge pixels choose one or the other by a stipple the temporal
 * resolve smooths, as a surface says only whether it has baked light and not how much of it.
 */

export const BAKED_VOLUME_WGSL = /* wgsl */ `
fn bakedVolumeWeight(position: vec3f) -> f32 {
  let first = surfaceWorld.probeOrigin.xyz;
  let outside = max(first - position, position - (first + surfaceWorld.probeExtent.xyz));
  return 1.0 - smoothstep(0.0, surfaceWorld.coverOrigin.z, max(max(outside.x, outside.y), outside.z));
}
fn bakedVolumeIrradiance(position: vec3f, normal: vec3f) -> vec3f {
  let first = surfaceWorld.probeOrigin.xyz;
  let extent = surfaceWorld.probeExtent.xyz;
  let counts = surfaceWorld.probeCounts.xyz;
  let last = counts - vec3f(1.0);
  let spacing = extent / max(last, vec3f(1.0));
  let cell = clamp((position + normal * surfaceWorld.probeCounts.w - first) / max(extent, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)) * last;
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
    let toProbe = first + probe * spacing - position;
    let facing = dot(toProbe, normal) / max(length(toProbe), 1e-4);
    let weight = near.x * near.y * near.z * max(smoothstep(-0.2, 0.3, facing), 0.001);
    let at = (u32(probe.x) + u32(counts.x) * (u32(probe.y) + u32(counts.y) * u32(probe.z))) * 3u;
    a += surfaceProbes[at] * weight;
    b += surfaceProbes[at + 1u] * weight;
    c += surfaceProbes[at + 2u] * weight;
    total += weight;
  }
  a /= total;
  b /= total;
  c /= total;
  // three's order of the coefficients: constant, then y, z, x.
  let irradiance = a.rgb * 0.886227 + 1.023328 * (vec3f(a.a, b.rg) * normal.y + vec3f(b.ba, c.r) * normal.z + c.gba * normal.x);
  return max(irradiance, vec3f(0.0)) * surfaceWorld.probeOrigin.w;
}
fn applyBakedVolume(in: SurfaceIn, finished: SurfaceOut) -> SurfaceOut {
  var out = finished;
  if (surfaceWorld.probeExtent.w < 0.5 || out.unlit || view.kind != 0u) { return out; }
  if (bakedVolumeWeight(in.worldPosition) > surfaceStipple(in)) {
    out.bakedLight += bakedVolumeIrradiance(in.worldPosition, out.normal);
    out.hasBakedLight = true;
  }
  return out;
}
`;
