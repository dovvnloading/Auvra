/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { registerSurfaceKind } from "../materialPool";
import { STANDARD_SURFACE, type SurfaceKind } from "../surfaces";
import { swayOfMaterial, type WindSway } from "../../../runtime/weatherSurfaces";
import { windUniforms } from "../../../runtime/wind";

/**
 * THE MATERIALS THAT NEED ONLY A SURFACE
 *
 * Custom materials that stay in the scene as they are and are drawn by the ordinary passes once the renderer knows what
 * their pixels look like. Their components change nothing: the kind is chosen by what the material is, and reads the
 * same uniforms the component already sets every frame.
 *
 *   The muzzle flash's soft glow (components/Scene/SocketController.tsx).
 *   The editor's grid (drei's Grid).
 *   Foliage swaying in the wind (runtime/weatherSurfaces.ts): the standard surface, with its vertices moved.
 */

/** Words of the standard surface's uniforms, where the wind's follow on (the pool's slice has room for 96). */
const STANDARD_WORDS = 84;

const uniformBinding: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }];

/** The kinds below with one uniform slice and no textures. */
const uniformsOnly = (): Pick<SurfaceKind, "layoutEntries" | "textures" | "bindGroupEntries"> => ({
  layoutEntries: () => uniformBinding,
  textures: () => [],
  bindGroupEntries: (input) => [{ binding: 0, resource: input.uniform }],
});

const uniformsOf = (material: THREE.Material): Record<string, THREE.IUniform> | undefined => (material as THREE.ShaderMaterial).uniforms;

// --- THE MUZZLE FLASH ---

const SOFT_FLASH_WGSL = /* wgsl */ `
struct SoftFlash { color: vec4f }
@group(2) @binding(0) var<uniform> flash: SoftFlash;

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  // Opaque where the sphere faces the eye and gone at its edge, with a hot core: gas rather than a solid.
  let facing = max(dot(normalize(in.normal), in.viewDirection), 0.0);
  let alpha = pow(facing, 2.5);
  out.albedo = flash.color.rgb * (1.0 + alpha * 0.5);
  out.opacity = alpha * flash.color.a;
  out.unlit = true;
  return out;
}
`;

export const SOFT_FLASH_SURFACE: SurfaceKind = {
  id: "soft-flash",
  wgsl: SOFT_FLASH_WGSL,
  ...uniformsOnly(),
  pack(material, floats) {
    const uniforms = uniformsOf(material);
    const color = uniforms?.uColor?.value as THREE.Color | undefined;
    floats[0] = color?.r ?? 1;
    floats[1] = color?.g ?? 1;
    floats[2] = color?.b ?? 1;
    floats[3] = (uniforms?.uOpacity?.value as number | undefined) ?? 1;
  },
};

/** The socket's flash material: a shader material that adds light, with exactly these two uniforms. */
export const isSoftFlashMaterial = (material: THREE.Material): boolean => {
  const uniforms = uniformsOf(material);
  return !!(material as THREE.ShaderMaterial).isShaderMaterial && material.blending === THREE.AdditiveBlending
    && !!uniforms?.uColor && !!uniforms.uOpacity && Object.keys(uniforms).length === 2;
};

// --- THE EDITOR'S GRID ---

const GRID_WGSL = /* wgsl */ `
struct GridLook {
  cellColor: vec4f,
  sectionColor: vec4f,
  // Where the fade is measured from.
  fadeFrom: vec4f,
  // Cell size, section size, cell thickness, section thickness.
  sizes: vec4f,
  // Fade distance, fade strength, how far the plane was spread out, unused.
  fade: vec4f,
}
@group(2) @binding(0) var<uniform> grid: GridLook;

// The plane stands in x and y; the grid lies in x and z, spread to the fade's distance when it is infinite.
fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  return local.xzy * grid.fade.z;
}

fn gridLine(at: vec2f, size: f32, thickness: f32) -> f32 {
  let r = at / size;
  let lines = abs(fract(r - vec2f(0.5)) - vec2f(0.5)) / fwidth(r);
  let line = min(lines.x, lines.y) + 1.0 - thickness;
  return 1.0 - min(line, 1.0);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  // The plane's uv is where on it this is, which holds however the plane is turned.
  let at = (in.uv0 - vec2f(0.5)) * grid.fade.z;
  let cell = gridLine(at, grid.sizes.x, grid.sizes.z);
  let section = gridLine(at, grid.sizes.y, grid.sizes.w);
  let distanceFrom = distance(grid.fadeFrom.xyz, in.worldPosition);
  let fade = 1.0 - min(distanceFrom / grid.fade.x, 1.0);
  let alpha = (cell + section) * pow(fade, grid.fade.y);
  out.albedo = mix(grid.cellColor.rgb, grid.sectionColor.rgb, min(1.0, grid.sizes.w * section));
  out.opacity = mix(0.75 * alpha, alpha, section);
  out.alphaTest = 1e-4;
  out.unlit = true;
  return out;
}
`;

export const GRID_SURFACE: SurfaceKind = {
  id: "editor-grid",
  wgsl: GRID_WGSL,
  displaces: true,
  ...uniformsOnly(),
  pack(material, floats) {
    const uniforms = uniformsOf(material) ?? {};
    const value = <T>(name: string, fallback: T): T => (uniforms[name]?.value as T | undefined) ?? fallback;
    const cell = value<THREE.Color | null>("cellColor", null);
    const section = value<THREE.Color | null>("sectionColor", null);
    floats[0] = cell?.r ?? 0;
    floats[1] = cell?.g ?? 0;
    floats[2] = cell?.b ?? 0;
    floats[4] = section?.r ?? 0;
    floats[5] = section?.g ?? 0.5;
    floats[6] = section?.b ?? 1;
    const from = value<THREE.Vector3 | null>("worldCamProjPosition", null);
    const fadeFrom = value("fadeFrom", 1);
    floats[8] = (from?.x ?? 0) * fadeFrom;
    floats[9] = (from?.y ?? 0) * fadeFrom;
    floats[10] = (from?.z ?? 0) * fadeFrom;
    floats[12] = value("cellSize", 0.5);
    floats[13] = value("sectionSize", 1);
    floats[14] = value("cellThickness", 0.5);
    floats[15] = value("sectionThickness", 1);
    const fadeDistance = value("fadeDistance", 100);
    floats[16] = Math.max(fadeDistance, 1e-3);
    floats[17] = value("fadeStrength", 1);
    floats[18] = value("infiniteGrid", false) ? 1 + fadeDistance : 1;
  },
};

/** drei's grid material: it has a type of its own, so it is known by its uniforms. */
export const isGridMaterial = (material: THREE.Material): boolean => {
  const uniforms = uniformsOf(material);
  return !!uniforms?.cellSize && !!uniforms.sectionSize && !!uniforms.fadeDistance && !!uniforms.worldCamProjPosition;
};

// --- FOLIAGE IN THE WIND ---

const WIND_WGSL = /* wgsl */ `
// From the world's axes into the instance's own: its matrix's inverse, by cofactors.
fn windToLocal(instance: Instance, offset: vec3f) -> vec3f {
  let a = vec3f(instance.world0.x, instance.world1.x, instance.world2.x);
  let b = vec3f(instance.world0.y, instance.world1.y, instance.world2.y);
  let c = vec3f(instance.world0.z, instance.world1.z, instance.world2.z);
  let bc = cross(b, c);
  let scale = dot(a, bc);
  if (abs(scale) < 1e-12) { return vec3f(0.0); }
  return vec3f(dot(bc, offset), dot(cross(c, a), offset), dot(cross(a, b), offset)) / scale;
}

// Bends from the base, more toward the top, and leaves flutter across the wind.
fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  let sway = material.windSway.x;
  if (sway <= 0.0) { return local; }
  let flutter = material.windSway.y;
  let bottom = material.windSway.z;
  let height = material.windSway.w;
  let t = material.windBlow.x;
  let direction = material.windBlow.yz;
  let strength = material.windBlow.w;
  let up = clamp((local.y - bottom) / max(height, 1e-4), 0.0, 1.3);
  let origin = vec3f(instance.world0.w, instance.world1.w, instance.world2.w);
  let tall = height * length(vec3f(instance.world0.y, instance.world1.y, instance.world2.y));
  let phase = dot(origin.xz, vec2f(0.37, 0.61));
  let lean = strength * (0.55 + 0.25 * sin(t * 1.1 + phase) + 0.12 * sin(t * 2.7 + phase * 1.9));
  let bend = up * up * sway * 0.012 * lean * tall;
  var offset = vec3f(direction.x, -0.15 * abs(bend) / max(tall, 1e-3), direction.y) * bend;
  let flick = sin(t * 7.0 + phase * 5.0 + dot(local, vec3f(3.1, 2.3, 2.9)));
  offset += vec3f(-direction.y, 0.4, direction.x) * flick * flutter * min(strength, 20.0) * 0.0025 * up * min(tall, 6.0);
  return local + windToLocal(instance, offset);
}
`;

const STANDARD_STRUCT_END = "transforms: array<vec4f, 16>,";

export const WIND_SURFACE: SurfaceKind = {
  ...STANDARD_SURFACE,
  id: "standard-wind",
  displaces: true,
  wgsl: `${STANDARD_SURFACE.wgsl.replace(STANDARD_STRUCT_END, `${STANDARD_STRUCT_END}\n  windSway: vec4f,\n  windBlow: vec4f,`)}${WIND_WGSL}`,
  pack(material, floats, words, maps) {
    STANDARD_SURFACE.pack(material, floats, words, maps);
    const sway = (material.userData.windSway as WindSway | null | undefined) ?? swayOfMaterial(material.name);
    const shape = material.userData.windShape as { bottom: number; height: number } | undefined;
    const direction = windUniforms.uWindDirection.value;
    floats[STANDARD_WORDS] = sway?.sway ?? 0;
    floats[STANDARD_WORDS + 1] = sway?.flutter ?? 0;
    floats[STANDARD_WORDS + 2] = shape?.bottom ?? 0;
    floats[STANDARD_WORDS + 3] = Math.max(1e-3, shape?.height ?? 1);
    floats[STANDARD_WORDS + 4] = windUniforms.uWindTime.value;
    floats[STANDARD_WORDS + 5] = direction[0];
    floats[STANDARD_WORDS + 6] = direction[1];
    floats[STANDARD_WORDS + 7] = windUniforms.uWindStrength.value;
  },
};

/**
 * Whether a material sways: said so by a Wind Sway component, or named like a leaf. A kind is chosen once, the first
 * time a material is drawn, so the name is what catches a material before the sky has scanned the scene; the sway it
 * reads every frame can still be nothing.
 */
export const isSwayingMaterial = (material: THREE.Material): boolean => {
  if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return false;
  if (material.userData.weatherSurface || material.userData.noWeather) return false;
  const sway = material.userData.windSway as WindSway | null | undefined;
  if (sway !== undefined) return !!sway && sway.sway > 0;
  return !!swayOfMaterial(material.name);
};

// --- REGISTERING ---

let registered = false;

/** Tells the material pool about the kinds above; once however often it is called. */
export const registerEffectSurfaces = (): void => {
  if (registered) return;
  registered = true;
  registerSurfaceKind(isSwayingMaterial, WIND_SURFACE);
  registerSurfaceKind(isGridMaterial, GRID_SURFACE);
  registerSurfaceKind(isSoftFlashMaterial, SOFT_FLASH_SURFACE);
};
