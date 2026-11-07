/**
 * WHAT A PHYSICAL SURFACE ADDS
 *
 * As far as one layer of surface can carry it, for every kind that draws one: lit.ts from a physical material's numbers
 * and maps, materialWgsl.ts from what a material graph works out.
 * - a coat: a shinier surface, more so at grazing angles, with the light the coat keeps taken from what is under it;
 * - sheen: a soft brightening toward the edges, with the base dimmed by what the sheen takes;
 * - transmission: a blended material gets more see-through; a solid one, which has nothing behind it in the surface
 *   buffer to show, is stippled away by what lets light through, and the temporal resolve smooths that into glass.
 * Index of refraction, specular tint, thin film and anisotropy change the lobe itself, which the surface buffer does
 * not hold.
 *
 * It reads `surfaceStipple` (world.ts STIPPLE_WGSL), which the kind declares beside it.
 */

export const PHYSICAL_LAYERS_WGSL = /* wgsl */ `
struct PhysicalLayers {
  coat: f32,
  coatRoughness: f32,
  // The sheen's colour, times how much of it there is.
  sheen: vec3f,
  sheenRoughness: f32,
  transmission: f32,
}

fn applyPhysicalLayers(in: SurfaceIn, plain: SurfaceOut, layers: PhysicalLayers, blended: bool) -> SurfaceOut {
  var out = plain;
  let facing = clamp(dot(out.normal, in.viewDirection), 0.0, 1.0);
  let edge = pow(1.0 - facing, 5.0);
  let reflected = 0.04 + 0.96 * edge;

  out.roughness = mix(out.roughness, layers.coatRoughness, layers.coat * mix(0.5, 1.0, edge));
  out.albedo *= 1.0 - layers.coat * reflected;

  let sheen = layers.sheen;
  let rim = pow(1.0 - facing, mix(5.0, 2.0, layers.sheenRoughness));
  out.albedo = out.albedo * (1.0 - 0.157 * max(max(sheen.r, sheen.g), sheen.b)) + sheen * rim * (1.0 - out.metalness);

  let transmission = layers.transmission;
  if (transmission > 0.0) {
    let seen = mix(1.0, max(reflected, 0.12), transmission);
    out.albedo *= 1.0 - transmission * 0.85;
    out.opacity *= seen;
    if (!blended && view.kind == 0u) {
      out.alphaTest = max(out.alphaTest, surfaceStipple(in));
    }
    out.keepsReflections = blended;
  }
  return out;
}
`;
