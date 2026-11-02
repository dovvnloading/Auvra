import * as THREE from 'three';
import { MAX_TERRAIN_LAYERS } from './terrainSplatCodec';
import { patchTerrainBrushOverlay } from './terrainBrushOverlay';

/**
 * Terrain material that blends up to eight texture layers by two splat maps. Each layer has its colour,
 * normal, roughness and height, held in two texture arrays so eight layers cost two samplers. It is a
 * MeshStandardMaterial with patched diffuse, roughness and normal stages, so lighting, shadows, fog and
 * weather behave exactly like every other surface.
 */
export const TERRAIN_FLAT_COLOR = '#555555';
const PROGRAM_KEY = 'auvra-terrain-layers-v2';

/** How one layer is drawn. */
export interface TerrainLayerLook {
  /** World metres one tile of its textures covers. */
  tileSize: number;
  /** Degrees its textures are turned by. */
  rotation?: number;
  /** Colour its albedo is multiplied by. */
  tint?: string;
  /** 0-1: the roughness map's multiplier, or its roughness without one. */
  roughness?: number;
  normalStrength?: number;
  /** 0 blends by weight alone; above it, the taller layer's height map shows through first. */
  heightContrast?: number;
  /** Also project its textures from the sides on steep ground, so they do not stretch down cliffs. */
  cliffProjection?: boolean;
  /** 0-1: broad, soft changes of colour that hide the repeat of the texture. */
  variation?: number;
}

export interface TerrainLayerUniforms {
  terrainSplat: THREE.IUniform<THREE.Texture>;
  terrainSplat2: THREE.IUniform<THREE.Texture>;
  terrainSplatSize: THREE.IUniform<THREE.Vector2>;
  terrainAlbedoArray: THREE.IUniform<THREE.Texture>;
  terrainDetailArray: THREE.IUniform<THREE.Texture>;
  terrainLayerCount: THREE.IUniform<number>;
  /** 1 / tile size, cos and sin of its turn, height contrast. */
  terrainLayerUv: THREE.IUniform<THREE.Vector4[]>;
  /** Tint, normal strength. */
  terrainLayerLook: THREE.IUniform<THREE.Vector4[]>;
  /** Roughness, cliff projection (0 or 1), variation. */
  terrainLayerSurface: THREE.IUniform<THREE.Vector4[]>;
  terrainHeightBlend: THREE.IUniform<number>;
  terrainPlaneSize: THREE.IUniform<THREE.Vector2>;
}

export type TerrainLayerMaterial = THREE.MeshStandardMaterial & { userData: { terrainUniforms: TerrainLayerUniforms } };

export interface TerrainLayerBinding {
  albedo: THREE.Texture;
  detail: THREE.Texture;
  layers: readonly TerrainLayerLook[];
  /** Plane size in its local units: width and depth. */
  width: number;
  depth: number;
  /** One colour per layer, for what bounced light takes from the terrain. */
  rayMaps?: readonly THREE.Texture[];
}

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
}

const VERTEX_DECLARATIONS = /* glsl */`
uniform vec2 terrainSplatSize;
uniform vec2 terrainPlaneSize;
varying vec2 vTerrainMetres;
varying float vTerrainHeightMetres;
varying vec2 vTerrainSplatUv;
varying vec3 vTerrainLocalNormal;
varying vec3 vTerrainAxisX;
varying vec3 vTerrainAxisY;
varying vec3 vTerrainAxisZ;`;

// Splat texel (column, row) holds the weights of the vertex of the same grid
// position. PlaneGeometry's row 0 is at uv.y = 1 and DataTexture row 0 at v = 0.
const VERTEX_BODY = /* glsl */`
vTerrainMetres = uv * terrainPlaneSize * vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
vTerrainHeightMetres = position.z * length( modelMatrix[ 2 ].xyz );
vTerrainLocalNormal = normal;
vTerrainAxisX = normalMatrix * vec3( 1.0, 0.0, 0.0 );
vTerrainAxisY = normalMatrix * vec3( 0.0, 1.0, 0.0 );
vTerrainAxisZ = normalMatrix * vec3( 0.0, 0.0, 1.0 );
vTerrainSplatUv = vec2(
    ( uv.x * ( terrainSplatSize.x - 1.0 ) + 0.5 ) / terrainSplatSize.x,
    ( ( 1.0 - uv.y ) * ( terrainSplatSize.y - 1.0 ) + 0.5 ) / terrainSplatSize.y );`;

const FRAGMENT_DECLARATIONS = /* glsl */`
precision highp sampler2DArray;
uniform sampler2D terrainSplat;
uniform sampler2D terrainSplat2;
uniform sampler2DArray terrainAlbedoArray;
uniform sampler2DArray terrainDetailArray;
uniform int terrainLayerCount;
uniform vec4 terrainLayerUv[ ${MAX_TERRAIN_LAYERS} ];
uniform vec4 terrainLayerLook[ ${MAX_TERRAIN_LAYERS} ];
uniform vec4 terrainLayerSurface[ ${MAX_TERRAIN_LAYERS} ];
uniform float terrainHeightBlend;
varying vec2 vTerrainMetres;
varying float vTerrainHeightMetres;
varying vec2 vTerrainSplatUv;
varying vec3 vTerrainLocalNormal;
varying vec3 vTerrainAxisX;
varying vec3 vTerrainAxisY;
varying vec3 vTerrainAxisZ;
vec3 terrainBlendedNormal;
float terrainBlendedRoughness;

float terrainHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float terrainNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( terrainHash( i ), terrainHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( terrainHash( i + vec2( 0.0, 1.0 ) ), terrainHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

// Lookups in a loop need their gradients given: the rates of change are worked out once, up front.
void terrainSampleLayer( int layer, vec2 at, vec2 dx, vec2 dy, out vec4 albedo, out vec3 tangentNormal, out float roughness ) {
    vec4 uvSettings = terrainLayerUv[ layer ];
    mat2 turn = mat2( uvSettings.y, uvSettings.z, -uvSettings.z, uvSettings.y );
    vec2 uv = turn * at * uvSettings.x;
    vec2 gradX = turn * dx * uvSettings.x;
    vec2 gradY = turn * dy * uvSettings.x;
    albedo = textureGrad( terrainAlbedoArray, vec3( uv, float( layer ) ), gradX, gradY );
    vec4 detail = textureGrad( terrainDetailArray, vec3( uv, float( layer ) ), gradX, gradY );
    vec2 slope = ( detail.rg * 2.0 - 1.0 ) * terrainLayerLook[ layer ].a;
    slope = slope * turn;
    tangentNormal = vec3( slope, sqrt( max( 0.0, 1.0 - min( 1.0, dot( slope, slope ) ) ) ) );
    roughness = detail.b;
}`;

// Layers that do not exist carry no weight; a sample with no weight left shows layer 0. A layer with
// almost no weight is skipped: most of the ground shows two or three layers, and each costs lookups.
const FRAGMENT_BLEND = /* glsl */`
{
    vec4 weightsA = texture2D( terrainSplat, vTerrainSplatUv );
    vec4 weightsB = texture2D( terrainSplat2, vTerrainSplatUv );
    float weights[ ${MAX_TERRAIN_LAYERS} ];
    weights[ 0 ] = weightsA.r; weights[ 1 ] = weightsA.g; weights[ 2 ] = weightsA.b; weights[ 3 ] = weightsA.a;
    weights[ 4 ] = weightsB.r; weights[ 5 ] = weightsB.g; weights[ 6 ] = weightsB.b; weights[ 7 ] = weightsB.a;
    float weightSum = 0.0;
    for ( int layer = 0; layer < terrainLayerCount; layer ++ ) weightSum += weights[ layer ];
    if ( weightSum < 0.0001 ) { weights[ 0 ] = 1.0; weightSum = 1.0; }

    vec3 localNormal = normalize( vTerrainLocalNormal );
    vec3 sideWeights = pow( abs( localNormal ), vec3( 6.0 ) );
    sideWeights /= max( sideWeights.x + sideWeights.y + sideWeights.z, 1e-4 );
    vec2 dx = dFdx( vTerrainMetres );
    vec2 dy = dFdy( vTerrainMetres );
    float dxHeight = dFdx( vTerrainHeightMetres );
    float dyHeight = dFdy( vTerrainHeightMetres );

    vec3 colours[ ${MAX_TERRAIN_LAYERS} ];
    vec3 normals[ ${MAX_TERRAIN_LAYERS} ];
    float roughnesses[ ${MAX_TERRAIN_LAYERS} ];
    float heights[ ${MAX_TERRAIN_LAYERS} ];
    for ( int layer = 0; layer < terrainLayerCount; layer ++ ) {
        float share = weights[ layer ] / weightSum;
        weights[ layer ] = share;
        if ( share < 0.004 ) continue;
        vec4 albedo;
        vec3 tangentNormal;
        float roughness;
        terrainSampleLayer( layer, vTerrainMetres, dx, dy, albedo, tangentNormal, roughness );
        vec3 blendedNormal = vec3( tangentNormal.xy + localNormal.xy, abs( tangentNormal.z ) * localNormal.z );
        if ( terrainLayerSurface[ layer ].y > 0.5 && sideWeights.z < 0.98 ) {
            // Steep ground also takes the texture from the sides; normals blended as Golus's whiteout.
            vec4 albedoX, albedoY;
            vec3 normalX, normalY;
            float roughnessX, roughnessY;
            terrainSampleLayer( layer, vec2( vTerrainHeightMetres, vTerrainMetres.y ), vec2( dxHeight, dx.y ), vec2( dyHeight, dy.y ), albedoX, normalX, roughnessX );
            terrainSampleLayer( layer, vec2( vTerrainMetres.x, vTerrainHeightMetres ), vec2( dx.x, dxHeight ), vec2( dy.x, dyHeight ), albedoY, normalY, roughnessY );
            albedo = albedo * sideWeights.z + albedoX * sideWeights.x + albedoY * sideWeights.y;
            roughness = roughness * sideWeights.z + roughnessX * sideWeights.x + roughnessY * sideWeights.y;
            vec3 tx = vec3( normalX.xy + localNormal.zy, abs( normalX.z ) * localNormal.x );
            vec3 ty = vec3( normalY.xy + localNormal.xz, abs( normalY.z ) * localNormal.y );
            blendedNormal = tx.zyx * sideWeights.x + ty.xzy * sideWeights.y + blendedNormal * sideWeights.z;
        }
        vec3 colour = albedo.rgb * terrainLayerLook[ layer ].rgb;
        float variation = terrainLayerSurface[ layer ].z;
        if ( variation > 0.0 ) {
            float broad = terrainNoise( vTerrainMetres * 0.021 ) * 0.6 + terrainNoise( vTerrainMetres * 0.097 ) * 0.4;
            colour *= 1.0 + ( broad - 0.5 ) * 0.9 * variation;
        }
        colours[ layer ] = colour;
        normals[ layer ] = blendedNormal;
        roughnesses[ layer ] = roughness * terrainLayerSurface[ layer ].x;
        heights[ layer ] = albedo.a;
    }

    if ( terrainHeightBlend > 0.5 ) {
        // The taller layer shows first where layers meet, so gravel sits between the cobbles.
        float tallest = -1000.0;
        for ( int layer = 0; layer < terrainLayerCount; layer ++ ) {
            if ( weights[ layer ] < 0.004 ) continue;
            float value = weights[ layer ] + ( heights[ layer ] - 0.5 ) * terrainLayerUv[ layer ].w;
            heights[ layer ] = value;
            tallest = max( tallest, value );
        }
        float sharpened = 0.0;
        for ( int layer = 0; layer < terrainLayerCount; layer ++ ) {
            if ( weights[ layer ] < 0.004 ) continue;
            weights[ layer ] = max( heights[ layer ] - ( tallest - 0.2 ), 0.0 );
            sharpened += weights[ layer ];
        }
        for ( int layer = 0; layer < terrainLayerCount; layer ++ ) weights[ layer ] /= max( sharpened, 1e-4 );
    }

    vec3 terrainColor = vec3( 0.0 );
    vec3 normalSum = vec3( 0.0 );
    float roughnessSum = 0.0;
    float counted = 0.0;
    for ( int layer = 0; layer < terrainLayerCount; layer ++ ) {
        float share = weights[ layer ];
        if ( share < 0.004 ) continue;
        terrainColor += colours[ layer ] * share;
        normalSum += normals[ layer ] * share;
        roughnessSum += roughnesses[ layer ] * share;
        counted += share;
    }
    diffuseColor.rgb *= terrainColor / max( counted, 1e-4 );
    terrainBlendedNormal = normalize( normalSum );
    terrainBlendedRoughness = roughnessSum / max( counted, 1e-4 );
}`;

const FRAGMENT_ROUGHNESS = /* glsl */`
roughnessFactor = terrainBlendedRoughness;`;

const FRAGMENT_NORMAL = /* glsl */`
normal = normalize( mat3( vTerrainAxisX, vTerrainAxisY, vTerrainAxisZ ) * terrainBlendedNormal );`;

const injectAfter = (source: string, marker: string, code: string): string => {
  if (!source.includes(marker)) throw new Error(`Terrain layer shader is missing ${marker}`);
  return source.replace(marker, `${marker}\n${code}`);
};

/** Patch a MeshStandardMaterial program (the shader handed to onBeforeCompile). */
export function patchTerrainLayerShader(shader: ShaderSource, uniforms: TerrainLayerUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = injectAfter(shader.vertexShader, '#include <common>', VERTEX_DECLARATIONS);
  shader.vertexShader = injectAfter(shader.vertexShader, '#include <uv_vertex>', VERTEX_BODY);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <map_fragment>', FRAGMENT_BLEND);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS);
  shader.fragmentShader = injectAfter(shader.fragmentShader, '#include <normal_fragment_maps>', FRAGMENT_NORMAL);
}

const singlePixelArray = (bytes: readonly number[], colorSpace: THREE.ColorSpace): THREE.DataArrayTexture => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(bytes), 1, 1, 1);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
};

let neutralAlbedoArray: THREE.DataArrayTexture | null = null;
let neutralDetailArray: THREE.DataArrayTexture | null = null;
let emptySplat: THREE.DataTexture | null = null;
let neutralLayerTexture: THREE.DataTexture | null = null;

/** A one-layer array of flat grey at middling height, bound while a terrain's real ones build. Shared; never disposed. */
export const getNeutralAlbedoArray = (): THREE.DataArrayTexture => {
  neutralAlbedoArray ??= singlePixelArray([0x55, 0x55, 0x55, 128], THREE.SRGBColorSpace);
  return neutralAlbedoArray;
};

/** A one-layer array of a flat normal and full roughness. Shared; never disposed. */
export const getNeutralDetailArray = (): THREE.DataArrayTexture => {
  neutralDetailArray ??= singlePixelArray([128, 128, 255, 255], THREE.NoColorSpace);
  return neutralDetailArray;
};

/** No weight at all, for a terrain with four layers or fewer. Shared; never disposed. */
export const getEmptySplat = (): THREE.DataTexture => {
  if (!emptySplat) {
    emptySplat = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    emptySplat.needsUpdate = true;
  }
  return emptySplat;
};

/** 1x1 texture of the flat terrain colour: what bounced light takes from an empty layer. Shared; never disposed. */
export function getNeutralLayerTexture(): THREE.DataTexture {
  if (!neutralLayerTexture) {
    const texture = new THREE.DataTexture(new Uint8Array([0x55, 0x55, 0x55, 255]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    neutralLayerTexture = texture;
  }
  return neutralLayerTexture;
}

/** A splat map texture: linear RGBA8 weights, one texel per height sample. */
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

export function createTerrainLayerMaterial(splat: THREE.DataTexture): TerrainLayerMaterial {
  const image = splat.image as { width: number; height: number };
  const vectors = () => Array.from({ length: MAX_TERRAIN_LAYERS }, () => new THREE.Vector4());
  const uniforms: TerrainLayerUniforms = {
    terrainSplat: { value: splat },
    terrainSplat2: { value: getEmptySplat() },
    terrainSplatSize: { value: new THREE.Vector2(image.width, image.height) },
    terrainAlbedoArray: { value: getNeutralAlbedoArray() },
    terrainDetailArray: { value: getNeutralDetailArray() },
    terrainLayerCount: { value: 1 },
    terrainLayerUv: { value: vectors() },
    terrainLayerLook: { value: vectors() },
    terrainLayerSurface: { value: vectors() },
    terrainHeightBlend: { value: 0 },
    terrainPlaneSize: { value: new THREE.Vector2(1, 1) },
  };
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    metalness: 0,
    // One side: drawn double-sided, the skirts hiding level-of-detail seams were lit from behind, as black cracks.
    side: THREE.FrontSide,
    shadowSide: THREE.DoubleSide,
  }) as TerrainLayerMaterial;
  material.name = 'TerrainLayerMaterial';
  // Rain wets it and snow settles on it (runtime/weatherSurfaces.ts).
  material.userData.weatherSurface = true;
  material.userData.raySolid = true;
  material.userData.terrainUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    patchTerrainLayerShader(shader, uniforms);
    patchTerrainBrushOverlay(shader);
  };
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
    side: THREE.FrontSide,
    shadowSide: THREE.DoubleSide,
  });
  material.name = 'TerrainGroundMaterial';
  // Rain wets it and snow settles on it (runtime/weatherSurfaces.ts).
  material.userData.weatherSurface = true;
  // What bounced light takes from it: its colours are worked out in the shader, mostly grass.
  material.userData.rayAlbedo = new THREE.Color(0.068, 0.112, 0.03);
  material.userData.raySolid = true;
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
    patchTerrainBrushOverlay(shader);
  };
  material.customProgramCacheKey = () => GROUND_PROGRAM_KEY;
  return material;
}

const _colour = new THREE.Color();

/** Bind the layers' textures and settings; the program is shared by every layer count. */
export function bindTerrainLayers(material: TerrainLayerMaterial, binding: TerrainLayerBinding): void {
  const uniforms = material.userData.terrainUniforms;
  const count = Math.max(1, Math.min(MAX_TERRAIN_LAYERS, binding.layers.length));
  uniforms.terrainAlbedoArray.value = binding.albedo;
  uniforms.terrainDetailArray.value = binding.detail;
  uniforms.terrainLayerCount.value = count;
  let heightBlend = 0;
  for (let index = 0; index < MAX_TERRAIN_LAYERS; index++) {
    const look = binding.layers[index];
    const tile = look && Number.isFinite(look.tileSize) && look.tileSize > 0 ? look.tileSize : 1;
    const turn = ((look?.rotation ?? 0) * Math.PI) / 180;
    const contrast = look?.heightContrast ?? 0;
    if (index < count && contrast > 0) heightBlend = 1;
    uniforms.terrainLayerUv.value[index].set(1 / tile, Math.cos(turn), Math.sin(turn), contrast);
    _colour.set(look?.tint ?? '#ffffff');
    uniforms.terrainLayerLook.value[index].set(_colour.r, _colour.g, _colour.b, look?.normalStrength ?? 1);
    uniforms.terrainLayerSurface.value[index].set(look?.roughness ?? 0.9, look?.cliffProjection ? 1 : 0, look?.variation ?? 0, 0);
  }
  uniforms.terrainHeightBlend.value = heightBlend;
  uniforms.terrainPlaneSize.value.set(binding.width, binding.depth);
  // What bounced light takes from it: the layers averaged, not knowing how much of each is painted.
  material.userData.rayAlbedoMaps = binding.rayMaps?.length ? [...binding.rayMaps] : [getNeutralLayerTexture()];
}

/** Point the material at new splat textures (after a resolution change, or a fifth layer). */
export function setTerrainSplatTextures(material: TerrainLayerMaterial, splat: THREE.DataTexture, splat2: THREE.DataTexture | null): void {
  const uniforms = material.userData.terrainUniforms;
  const image = splat.image as { width: number; height: number };
  uniforms.terrainSplat.value = splat;
  uniforms.terrainSplat2.value = splat2 ?? getEmptySplat();
  uniforms.terrainSplatSize.value.set(image.width, image.height);
}
