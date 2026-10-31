/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { hasOwnCompileHook, hookUniforms } from "./materialHooks";
import { STIPPLE_WGSL, surfaceScene, worldBindEntries, worldLayoutEntries, worldWgsl } from "./world";

/**
 * WATER
 *
 * The water of runtime/components/waterComponent.tsx: a grid moved up and down by three travelling waves, with foam on
 * the crests. The waves and their clock are the ones buoyancy reads. A surface is not told where its pixel was before
 * the waves moved it, so the kind keeps the water's world-to-object matrix: in the object's space a wave only moves a
 * point up, and its height and slope follow from where it stands.
 */

const WORLD_BINDING = 1;

const WATER_WGSL = /* wgsl */ `
struct WaterMaterial {
  // Colour and opacity.
  color: vec4f,
  // Roughness, metalness, seconds, foam.
  params: vec4f,
  // The sum of the waves' heights, alpha test.
  params2: vec4f,
  // Height, spatial and time frequency of each wave.
  waves: array<vec4f, 3>,
  // The way each wave travels, in the object's space.
  directions: array<vec4f, 3>,
  worldToObject: array<vec4f, 3>,
}
@group(2) @binding(0) var<uniform> material: WaterMaterial;
${worldWgsl(WORLD_BINDING)}
${STIPPLE_WGSL}
${BAKED_VOLUME_WGSL}

fn waveHeightAt(p: vec2f) -> f32 {
  var height = 0.0;
  for (var i = 0; i < 3; i++) {
    height += material.waves[i].x * sin(material.waves[i].y * dot(material.directions[i].xz, p) - material.waves[i].z * material.params.z);
  }
  return height;
}

fn waveSlopeAt(p: vec2f) -> vec2f {
  var slope = vec2f(0.0);
  for (var i = 0; i < 3; i++) {
    slope += material.waves[i].x * material.waves[i].y * material.directions[i].xz * cos(material.waves[i].y * dot(material.directions[i].xz, p) - material.waves[i].z * material.params.z);
  }
  return slope;
}

fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  return vec3f(local.x, local.y + waveHeightAt(local.xz), local.z);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  let world = vec4f(in.worldPosition, 1.0);
  let at = vec2f(dot(material.worldToObject[0], world), dot(material.worldToObject[2], world));
  let slope = waveSlopeAt(at);
  let objectNormal = normalize(vec3f(-slope.x, 1.0, -slope.y));
  // A normal goes to the world by the inverse transpose, which is this matrix turned on its side.
  let worldNormal = normalize(material.worldToObject[0].xyz * objectNormal.x + material.worldToObject[1].xyz * objectNormal.y + material.worldToObject[2].xyz * objectNormal.z);
  out.normal = select(-worldNormal, worldNormal, in.frontFacing);
  let top = material.params2.x;
  let crest = select(0.0, smoothstep(0.35, 1.0, waveHeightAt(at) / max(top, 1e-5)), top > 0.0);
  let foam = crest * material.params.w;
  out.albedo = mix(material.color.rgb * in.instanceColor.rgb, vec3f(0.92, 0.96, 1.0), foam);
  out.opacity = mix(material.color.a, 1.0, foam);
  out.alphaTest = material.params2.y;
  out.roughness = material.params.x;
  out.metalness = material.params.y;
  return applyBakedVolume(in, out);
}
`;

/** Whether this is the water's material: nothing marks it but the waves its compile hook hands over. */
export const isWaterMaterial = (material: THREE.Material): boolean =>
  hasOwnCompileHook(material) && !!hookUniforms(material).uWaves;

const meshes = new WeakMap<THREE.Material, THREE.Mesh>();
const _worldToObject = new THREE.Matrix4();

/** The mesh the material is on, found the first time and looked at again only if it has changed material. */
const meshOf = (material: THREE.Material): THREE.Mesh | null => {
  const known = meshes.get(material);
  if (known && known.material === material) return known;
  let found: THREE.Mesh | null = null;
  surfaceScene()?.traverse((object) => {
    if (!found && (object as THREE.Mesh).material === material) found = object as THREE.Mesh;
  });
  if (found) meshes.set(material, found);
  return found;
};

export const WATER_SURFACE: SurfaceKind = {
  id: "water",
  wgsl: WATER_WGSL,
  displaces: true,
  layoutEntries: () => [...textureLayoutEntries(0), ...worldLayoutEntries(WORLD_BINDING)],
  textures: () => [],
  bindGroupEntries: (input) => [{ binding: 0, resource: input.uniform }, ...worldBindEntries(input.pool, WORLD_BINDING)],
  pack(material, floats) {
    const m = material as THREE.MeshStandardMaterial;
    const uniforms = hookUniforms(material);
    floats[0] = m.color.r;
    floats[1] = m.color.g;
    floats[2] = m.color.b;
    floats[3] = m.opacity;
    floats[4] = m.roughness;
    floats[5] = m.metalness;
    floats[6] = uniforms.uTime.value;
    floats[7] = uniforms.uFoam.value;
    floats[8] = uniforms.uWaveTop.value;
    floats[9] = m.alphaTest;
    const waves = uniforms.uWaves.value as THREE.Vector4[];
    const directions = uniforms.uWaveDirs.value as THREE.Vector3[];
    for (let index = 0; index < 3; index++) {
      waves[index].toArray(floats, 12 + index * 4);
      directions[index].toArray(floats, 24 + index * 4);
    }
    const mesh = meshOf(material);
    if (mesh) _worldToObject.copy(mesh.matrixWorld).invert();
    else _worldToObject.identity();
    const e = _worldToObject.elements;
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 4; column++) floats[36 + row * 4 + column] = e[column * 4 + row];
    }
  },
};
