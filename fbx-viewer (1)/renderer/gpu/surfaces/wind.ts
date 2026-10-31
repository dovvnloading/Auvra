/**
 * FOLIAGE IN THE WIND
 *
 * Leaves, grass and the like bend from the base, more toward the top, gusting with the wind and fluttering across it:
 * the same motion runtime/weatherSurfaces.ts patches into a lit material, worked out in the world and brought back into
 * the instance's own space. `sway` is how far it bends, `flutter` how much its leaves flutter, `bottom` and `height`
 * where its plant stands in the geometry's space.
 */

export const WIND_WGSL = /* wgsl */ `
fn windOffset(local: vec3f, instance: Instance, sway: f32, flutter: f32, bottom: f32, height: f32) -> vec3f {
  let time = surfaceWorld.wind.x;
  let direction = surfaceWorld.wind.yz;
  let strength = surfaceWorld.wind.w;
  // Bends from the base, more toward the top (the square of the height up the plant).
  let up = clamp((local.y - bottom) / max(height, 1e-4), 0.0, 1.3);
  let scale = length(vec3f(instance.world0.y, instance.world1.y, instance.world2.y));
  let tall = height * scale;
  let phase = dot(vec2f(instance.world0.w, instance.world2.w), vec2f(0.37, 0.61));
  // A lean with the wind that swells and eases, and a sway about it.
  let lean = strength * (0.55 + 0.25 * sin(time * 1.1 + phase) + 0.12 * sin(time * 2.7 + phase * 1.9));
  let bend = up * up * sway * 0.012 * lean * tall;
  var offset = vec3f(direction.x, -0.15 * abs(bend) / max(tall, 1e-3), direction.y) * bend;
  // Leaves flutter across the wind, quickly and each a little differently.
  let flick = sin(time * 7.0 + phase * 5.0 + dot(local, vec3f(3.1, 2.3, 2.9)));
  offset += vec3f(-direction.y, 0.4, direction.x) * flick * flutter * min(strength, 20.0) * 0.0025 * up * min(tall, 6.0);
  return offset;
}
`;
