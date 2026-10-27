import * as THREE from 'three';
import { MAX_TERRAIN_LAYERS, TERRAIN_SPLAT_CHANNELS } from './terrainSplatCodec';

/**
 * Terrain material that blends up to four tiled texture layers by a splat map.
 * It is a MeshStandardMaterial with a patched diffuse stage, so lighting,
 * shadows and fog behave exactly like the flat fallback material.
 */
export const TERRAIN_FLAT_COLOR = '#555555';
const TERRAIN_FLAT_SRGB_BYTE = 0x55;
const PROGRAM_KEY = 'auvra-terrain-layers-v1';

export interface TerrainLayerUniforms {
  terrainSplat: THREE.IUniform<THREE.Texture>;
  terrainSplatSize: THREE.IUniform<THREE.Vector2>;
  terrainLayer0: THREE.IUniform<THREE.Texture>;
  terrainLayer1: THREE.IUniform<THREE.Texture>;
  terrainLayer2: THREE.IUniform<THREE.Texture>;
  terrainLayer3: THREE.IUniform<THREE.Texture>;
  terrainLayerTiling: THREE.IUniform<THREE.Vector4>;
  terrainLayerMask: THREE.IUniform<THREE.Vector4>;
  terrainUvAspect: THREE.IUniform<THREE.Vector2>;
}

export type TerrainLayerMaterial = THREE.MeshStandardMaterial & { userData: { terrainUniforms: TerrainLayerUniforms } };

export interface TerrainLayerBinding {
  /** One entry per layer (at most four); null renders the layer flat grey. */
  textures: readonly (THREE.Texture | null)[];
  tilings: readonly number[];
  /** Terrain depth / width, so tiles stay square in world space. */
  aspect: number;
}

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
}

const VERTEX_DECLARATIONS = /* glsl */`
uniform vec2 terrainSplatSize;
varying vec2 vTerrainUv;
varying vec2 vTerrainSplatUv;`;

// Splat texel (column, row) holds the weights of the vertex of the same grid
// position. PlaneGeometry's row 0 is at uv.y = 1 and DataTexture row 0 at v = 0.
const VERTEX_UV = /* glsl */`
vTerrainUv = uv;
vTerrainSplatUv = vec2(
    ( uv.x * ( terrainSplatSize.x - 1.0 ) + 0.5 ) / terrainSplatSize.x,
    ( ( 1.0 - uv.y ) * ( terrainSplatSize.y - 1.0 ) + 0.5 ) / terrainSplatSize.y );`;

const FRAGMENT_DECLARATIONS = /* glsl */`
uniform sampler2D terrainSplat;
uniform sampler2D terrainLayer0;
uniform sampler2D terrainLayer1;
uniform sampler2D terrainLayer2;
uniform sampler2D terrainLayer3;
uniform vec4 terrainLayerTiling;
uniform vec4 terrainLayerMask;
uniform vec2 terrainUvAspect;
varying vec2 vTerrainUv;
varying vec2 vTerrainSplatUv;`;

// Channels of layers that do not exist are masked out and the remaining
// weights renormalised; a sample with no weight left shows layer 0.
const FRAGMENT_BLEND = /* glsl */`
{
    vec4 terrainWeights = texture2D( terrainSplat, vTerrainSplatUv ) * terrainLayerMask;
    float terrainWeightSum = dot( terrainWeights, vec4( 1.0 ) );
    terrainWeights = terrainWeightSum > 0.0001 ? terrainWeights / terrainWeightSum : vec4( 1.0, 0.0, 0.0, 0.0 );
    vec2 terrainBaseUv = vTerrainUv * terrainUvAspect;
    vec3 terrainColor = texture2D( terrainLayer0, terrainBaseUv * terrainLayerTiling.x ).rgb * terrainWeights.x;
    terrainColor += texture2D( terrainLayer1, terrainBaseUv * terrainLayerTiling.y ).rgb * terrainWeights.y;
    terrainColor += texture2D( terrainLayer2, terrainBaseUv * terrainLayerTiling.z ).rgb * terrainWeights.z;
    terrainColor += texture2D( terrainLayer3, terrainBaseUv * terrainLayerTiling.w ).rgb * terrainWeights.w;
    diffuseColor.rgb *= terrainColor;
}`;

const injectAfter = (source: string, marker: string, code: string): string => {
  if (!source.includes(marker)) throw new Error(`Terrain layer shader is missing ${marker}`);
  return source.replace(marker, `${marker}\n${code}`);
};

/** Patch a MeshStandardMaterial program (the shader handed to onBeforeCompile). */
export function patchTerrainLayerShader(shader: ShaderSource, uniforms: TerrainLayerUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = injectAfter(shader.vertexShader, '#include <common>', VERTEX_DECLARATIONS);
  shader.vertexShader = injectAfter(shader.vertexShader, '#include <uv_vertex>', VERTEX_UV);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <map_fragment>', FRAGMENT_BLEND);
}

let neutralLayerTexture: THREE.DataTexture | null = null;

/** 1x1 texture of the flat terrain colour, bound to empty and loading layers. Shared; never disposed. */
export function getNeutralLayerTexture(): THREE.DataTexture {
  if (!neutralLayerTexture) {
    const texture = new THREE.DataTexture(new Uint8Array([
      TERRAIN_FLAT_SRGB_BYTE, TERRAIN_FLAT_SRGB_BYTE, TERRAIN_FLAT_SRGB_BYTE, 255,
    ]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    neutralLayerTexture = texture;
  }
  return neutralLayerTexture;
}

/** The splat map texture: linear RGBA8 weights, one texel per height sample. */
export function createTerrainSplatTexture(weights: Uint8Array, columns: number, rows: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(weights, columns, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Configure a loaded layer texture (an sRGB colour image) for tiling. */
export function prepareTerrainLayerTexture(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.max(texture.anisotropy, 8);
  texture.needsUpdate = true;
  return texture;
}

export function createTerrainLayerMaterial(splat: THREE.DataTexture): TerrainLayerMaterial {
  const neutral = getNeutralLayerTexture();
  const image = splat.image as { width: number; height: number };
  const uniforms: TerrainLayerUniforms = {
    terrainSplat: { value: splat },
    terrainSplatSize: { value: new THREE.Vector2(image.width, image.height) },
    terrainLayer0: { value: neutral },
    terrainLayer1: { value: neutral },
    terrainLayer2: { value: neutral },
    terrainLayer3: { value: neutral },
    terrainLayerTiling: { value: new THREE.Vector4(1, 1, 1, 1) },
    terrainLayerMask: { value: new THREE.Vector4(1, 0, 0, 0) },
    terrainUvAspect: { value: new THREE.Vector2(1, 1) },
  };
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  }) as TerrainLayerMaterial;
  material.name = 'TerrainLayerMaterial';
  material.userData.terrainUniforms = uniforms;
  material.onBeforeCompile = (shader) => patchTerrainLayerShader(shader, uniforms);
  material.customProgramCacheKey = () => PROGRAM_KEY;
  return material;
}

const GROUND_PROGRAM_KEY = 'auvra-terrain-ground-v1';

/**
 * The look of terrain with no texture layers: grass on gentle ground, worn earth on slopes and
 * rock on steep faces, varied by a soft world-space noise so large areas are not one flat colour.
 * Like the layer material it patches MeshStandardMaterial, so lighting, shadows and fog are unchanged.
 */
export function createTerrainGroundMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  material.name = 'TerrainGroundMaterial';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;\nvarying vec3 vGroundNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n'
        + 'vGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        + 'vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGroundWorld;
varying vec3 vGroundNormal;
float groundHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float groundNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x),
             mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float variation = groundNoise(vGroundWorld.xz * 0.08) * 0.65 + groundNoise(vGroundWorld.xz * 0.45) * 0.35;
  float slope = 1.0 - clamp(abs(normalize(vGroundNormal).y), 0.0, 1.0);
  // Linear-light colours: two greens, a dry earth and a grey stone.
  vec3 grass = mix(vec3(0.045, 0.095, 0.022), vec3(0.085, 0.13, 0.035), variation);
  vec3 earth = mix(vec3(0.11, 0.075, 0.042), vec3(0.15, 0.11, 0.065), variation);
  vec3 rock = mix(vec3(0.16, 0.15, 0.14), vec3(0.22, 0.21, 0.19), variation);
  vec3 ground = mix(grass, earth, smoothstep(0.16, 0.32, slope + (variation - 0.5) * 0.12));
  ground = mix(ground, rock, smoothstep(0.42, 0.62, slope));
  diffuseColor.rgb *= ground;
}`);
  };
  material.customProgramCacheKey = () => GROUND_PROGRAM_KEY;
  return material;
}

/** Bind the layers' textures and tiling; the program is shared by every layer count. */
export function bindTerrainLayers(material: TerrainLayerMaterial, binding: TerrainLayerBinding): void {
  const uniforms = material.userData.terrainUniforms;
  const neutral = getNeutralLayerTexture();
  const count = Math.min(MAX_TERRAIN_LAYERS, binding.textures.length);
  const slots = [uniforms.terrainLayer0, uniforms.terrainLayer1, uniforms.terrainLayer2, uniforms.terrainLayer3];
  const tiling = [1, 1, 1, 1];
  const mask = [0, 0, 0, 0];
  for (let index = 0; index < TERRAIN_SPLAT_CHANNELS; index++) {
    const active = index < count;
    slots[index].value = (active && binding.textures[index]) || neutral;
    const repeat = binding.tilings[index];
    tiling[index] = active && Number.isFinite(repeat) && repeat > 0 ? repeat : 1;
    mask[index] = active ? 1 : 0;
  }
  // Layer 0 is always present while this material is in use.
  mask[0] = 1;
  uniforms.terrainLayerTiling.value.set(tiling[0], tiling[1], tiling[2], tiling[3]);
  uniforms.terrainLayerMask.value.set(mask[0], mask[1], mask[2], mask[3]);
  const aspect = Number.isFinite(binding.aspect) && binding.aspect > 0 ? binding.aspect : 1;
  uniforms.terrainUvAspect.value.set(1, aspect);
}

/** Point the material at a new splat texture (after a resolution change). */
export function setTerrainSplatTexture(material: TerrainLayerMaterial, splat: THREE.DataTexture): void {
  const uniforms = material.userData.terrainUniforms;
  const image = splat.image as { width: number; height: number };
  uniforms.terrainSplat.value = splat;
  uniforms.terrainSplatSize.value.set(image.width, image.height);
}
