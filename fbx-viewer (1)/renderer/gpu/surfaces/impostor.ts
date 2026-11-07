/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { textureBindEntries, textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { INSTANCE_INVERSE_WGSL } from "./world";

/**
 * IMPOSTORS
 *
 * A far copy of a scattered model (runtime/proceduralScatter.ts): one quad turned about the vertical toward the camera,
 * standing where the model stands and showing a picture of it. The picture holds its light already, and dims with the
 * day. While there is no picture, nothing is drawn.
 */

const IMPOSTOR_WGSL = /* wgsl */ `
struct ImpostorMaterial {
  // Left, bottom, width and height of the picture around the model's origin.
  rect: vec4f,
  mapSize: vec2f,
  light: f32,
  hasPicture: f32,
}
@group(2) @binding(0) var<uniform> material: ImpostorMaterial;
@group(2) @binding(1) var mapTexture: texture_2d<f32>;
@group(2) @binding(2) var mapSampler: sampler;
${INSTANCE_INVERSE_WGSL}

fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  let origin = vec3f(instance.world0.w, instance.world1.w, instance.world2.w);
  let scale = length(vec3f(instance.world0.x, instance.world1.x, instance.world2.x));
  // Toward the camera that chooses detail, so a shadow view stands them as the main view sees them.
  let toCamera = view.lodEye.xyz - origin;
  let right = normalize(vec3f(toCamera.z, 0.0, -toCamera.x) + vec3f(1e-5, 0.0, 0.0));
  let rect = material.rect;
  let placed = origin + right * (rect.x + local.x * rect.z) * scale + vec3f(0.0, (rect.y + local.y * rect.w) * scale, 0.0);
  return instanceLocalPoint(instance, placed);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  let texel = textureSample(mapTexture, mapSampler, in.uv0);
  // Smaller mip levels average thin leaves' alpha away; raising it with the level keeps far copies full.
  let dx = dpdx(in.uv0 * material.mapSize);
  let dy = dpdy(in.uv0 * material.mapSize);
  let level = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  out.opacity = texel.a * (1.0 + 0.25 * level) * material.hasPicture;
  out.alphaTest = 0.5;
  // The picture was drawn over clear black, which the mip levels average in: divided out, edges keep their colour.
  out.albedo = texel.rgb / max(texel.a, 1e-3) * material.light;
  out.unlit = true;
  return out;
}
`;

const uniformsOf = (material: THREE.Material) => (material as THREE.ShaderMaterial).uniforms;

export const isImpostorMaterial = (material: THREE.Material): boolean =>
  (material as THREE.ShaderMaterial).isShaderMaterial === true && !!uniformsOf(material)?.impostorRect;

export const IMPOSTOR_SURFACE: SurfaceKind = {
  id: "impostor",
  wgsl: IMPOSTOR_WGSL,
  displaces: true,
  layoutEntries: () => textureLayoutEntries(1),
  textures: (material) => [uniformsOf(material).map.value as THREE.Texture | null],
  bindGroupEntries: (input) => textureBindEntries(input, [input.pool.black]),
  pack(material, floats, _words, maps) {
    const uniforms = uniformsOf(material);
    (uniforms.impostorRect.value as THREE.Vector4).toArray(floats, 0);
    (uniforms.mapSize.value as THREE.Vector2).toArray(floats, 4);
    floats[6] = uniforms.light.value as number;
    floats[7] = maps[0] ? 1 : 0;
  },
};
