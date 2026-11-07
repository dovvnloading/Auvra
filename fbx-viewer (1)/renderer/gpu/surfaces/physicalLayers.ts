/**
 * WHAT A PHYSICAL SURFACE ADDS
 *
 * As far as one layer of surface can carry it, for every kind that draws one: lit.ts from a physical material's numbers
 * and maps, materialWgsl.ts from what a material graph works out.
 * - a coat: a shinier surface, more so at grazing angles, with the light the coat keeps taken from what is under it;
 * - sheen: a soft brightening toward the edges, with the base dimmed by what the sheen takes;
 * - transmission: a blended material gets more see-through; a solid one, which has nothing behind it in the surface
 *   buffer to show, is stippled away by what lets light through, and the temporal resolve smooths that into glass.
 * Index of refraction, specular tint and thin film change the lobe itself, which the surface buffer does not hold:
 * PHYSICAL_LOBE_WGSL below draws them as far as it can. Anisotropy is not drawn.
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

/**
 * What a physical surface does to the reflection itself, as far as the surface buffer can carry it. The lighting
 * reflects 4% straight on off whatever is not metal, so a surface that should reflect more (a higher index of
 * refraction, a stronger or tinted specular, a thin film) is drawn as partly metal: just so much that its reflection
 * reaches what it should while the light it scatters stays its own colour. A thin film's interference colours the
 * reflection by angle and thickness (a film of index 1.3), on metal as on anything else. A surface reflecting less than
 * 4% keeps the lighting's 4%.
 */
export const PHYSICAL_LOBE_WGSL = /* wgsl */ `
struct PhysicalLobe {
  // Reflectance straight on of what is not metal: ((ior - 1) / (ior + 1))^2, times the specular colour and strength.
  specular: vec3f,
  thinFilm: f32,
  // Nanometres.
  thinFilmThickness: f32,
}

fn thinFilmColour(facing: f32, thickness: f32) -> vec3f {
  let cosFilm = sqrt(max(1.0 - (1.0 - facing * facing) / 1.69, 0.0));
  let shift = 2.0 * 1.3 * thickness * cosFilm;
  return 0.5 + 0.5 * cos(6.2831853 * shift / vec3f(650.0, 532.0, 450.0));
}

fn applyPhysicalLobe(in: SurfaceIn, plain: SurfaceOut, lobe: PhysicalLobe) -> SurfaceOut {
  var out = plain;
  let facing = clamp(dot(out.normal, in.viewDirection), 0.0, 1.0);
  var reflectance = max(lobe.specular, vec3f(0.0));
  var tint = vec3f(1.0);
  if (lobe.thinFilm > 0.0 && lobe.thinFilmThickness > 0.0) {
    // The film's colours average a half: twice them keeps the reflection as bright, and a film reflects more.
    tint = mix(vec3f(1.0), thinFilmColour(facing, lobe.thinFilmThickness) * 2.0, clamp(lobe.thinFilm, 0.0, 1.0));
    reflectance = max(reflectance, vec3f(0.04)) * (1.0 + clamp(lobe.thinFilm, 0.0, 1.0));
    out.albedo = mix(out.albedo, out.albedo * tint, out.metalness);
  }
  let wanted = dot(reflectance, vec3f(0.2126, 0.7152, 0.0722));
  let dielectric = 1.0 - out.metalness;
  if (wanted > 0.04 && dielectric > 0.0) {
    // A metal share m keeps the scattered light d (as albedo (1 - m)) while 0.04 (1 - m) + albedo m reaches what is
    // wanted: 0.04 m^2 + (d + wanted - 0.08) m + 0.04 - wanted = 0.
    let d = clamp(dot(out.albedo, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    let b = d + wanted - 0.08;
    let m = clamp((sqrt(max(b * b - 0.16 * (0.04 - wanted), 0.0)) - b) / 0.08, 0.0, 0.95) * dielectric;
    out.albedo = min(out.albedo / (1.0 - m) * mix(vec3f(1.0), tint, min(m * 4.0, 1.0)), vec3f(1.0));
    out.metalness = out.metalness + m;
  }
  return out;
}
`;
