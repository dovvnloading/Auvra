import * as THREE from 'three';
import {
    compileMaterialGraph,
    getMaterialNodeDefinition,
    normalizeMaterialGraph,
    readParam,
    type CompiledMaterialGraph,
    type MaterialGraph,
    type MaterialUniformSpec,
} from './materialGraph';

/**
 * Standard materials shaded by a material graph (runtime/materials/materialGraph.ts). The graph's
 * GLSL replaces the material's own reads of its colour, opacity, roughness, metalness, normal,
 * emissive and occlusion; everything else (lights, shadows, fog, environment reflections, skinning,
 * instancing) is three's. A graph binds to a material in place, so every mesh sharing it (each
 * placed copy of a model) follows. Its constants and textures are uniforms: editing them updates
 * the material as it is, and only a change to the graph's wiring rebuilds its shader.
 */

/** Seconds of play, read by every graph material's Time node; whoever renders advances it. */
export const MATERIAL_TIME = { value: 0 };

/** The texture a Texture Sample or Normal Map node names, or null while it is missing or loading. */
export type MaterialTextureLookup = (textureId: string) => THREE.Texture | null;

const solidTexture = (r: number, g: number, b: number): THREE.DataTexture => {
    const texture = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
    texture.needsUpdate = true;
    return texture;
};
// Stand-ins: white for a colour texture not chosen yet, and a flat normal that turns on the tangent
// frame three builds only for a normal map, which the graph's normal then replaces.
const WHITE = solidTexture(255, 255, 255);
const FLAT_NORMAL = solidTexture(128, 128, 255);

const NORMAL_READ = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;';

const HELPERS = `
uniform float uMaterialTime;
varying vec3 vMaterialWorldPosition;
float materialHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float materialNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(materialHash(i), materialHash(i + vec2(1.0, 0.0)), u.x),
               mix(materialHash(i + vec2(0.0, 1.0)), materialHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 materialVertexColor() {
#if defined( USE_COLOR_ALPHA )
    return vColor.rgb;
#elif defined( USE_COLOR )
    return vColor;
#else
    return vec3(1.0);
#endif
}
`;

const WORLD_POSITION_VERTEX = `
{
    vec4 materialWorld = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        materialWorld = batchingMatrix * materialWorld;
    #endif
    #ifdef USE_INSTANCING
        materialWorld = instanceMatrix * materialWorld;
    #endif
    vMaterialWorldPosition = ( modelMatrix * materialWorld ).xyz;
}
`;

const GLSL_TYPES: Record<MaterialUniformSpec['kind'], string> = { float: 'float', color: 'vec3', vec2: 'vec2', vec3: 'vec3', texture: 'sampler2D' };

const replaceOnce = (source: string, find: string, replacement: string): string => {
    if (!source.includes(find)) throw new Error(`The material shader has no "${find}" to replace.`);
    return source.replace(find, replacement);
};

type StandardMaterial = THREE.MeshStandardMaterial;

interface GraphBinding {
    graph: MaterialGraph;
    compiled: CompiledMaterialGraph;
    uniforms: Record<string, THREE.IUniform>;
    textures: MaterialTextureLookup;
    /** The material's own shader hooks, put back when the graph is unbound. */
    onBeforeCompile: StandardMaterial['onBeforeCompile'];
    customProgramCacheKey: StandardMaterial['customProgramCacheKey'];
    hadUv: boolean;
}

const bindings = new WeakMap<THREE.Material, GraphBinding>();

/** True for the materials a graph can shade: standard and physical. */
export const canBindMaterialGraph = (material: THREE.Material): material is StandardMaterial =>
    (material as StandardMaterial).isMeshStandardMaterial === true;

/** The graph a material is shaded by, if any. */
export const boundMaterialGraph = (material: THREE.Material): MaterialGraph | null => bindings.get(material)?.graph ?? null;

/** Sets each uniform the graph needs from its node's param (adding the ones it lacks). */
const syncUniforms = (binding: GraphBinding): void => {
    const nodes = new Map(binding.graph.nodes.map(node => [node.id, node]));
    for (const spec of binding.compiled.uniforms) {
        const node = nodes.get(spec.nodeId)!;
        const param = getMaterialNodeDefinition(node.type)!.params.find(candidate => candidate.key === spec.param)!;
        const value = readParam(param, node.params[spec.param]);
        const uniform = binding.uniforms[spec.name] ?? (binding.uniforms[spec.name] = { value: null });
        if (spec.kind === 'texture') {
            const texture = typeof value === 'string' && value ? binding.textures(value) : null;
            uniform.value = texture ?? (node.type === 'normalMap' ? FLAT_NORMAL : WHITE);
        } else if (spec.kind === 'float') {
            uniform.value = value as number;
        } else if (spec.kind === 'color') {
            const [r, g, b] = value as number[];
            // Colours are picked in sRGB; the shader works in linear light.
            uniform.value = (uniform.value instanceof THREE.Color ? uniform.value : new THREE.Color()).setRGB(r, g, b, THREE.SRGBColorSpace);
        } else if (spec.kind === 'vec2') {
            const [x, y] = value as number[];
            uniform.value = (uniform.value instanceof THREE.Vector2 ? uniform.value : new THREE.Vector2()).set(x, y);
        } else {
            const [x, y, z] = value as number[];
            uniform.value = (uniform.value instanceof THREE.Vector3 ? uniform.value : new THREE.Vector3()).set(x, y, z);
        }
    }
};

/** Transparency and the normal map stand-in follow the graph. */
const applyFlags = (material: StandardMaterial, binding: GraphBinding): void => {
    const output = binding.graph.nodes.find(node => node.type === 'output')!;
    const opacity = typeof output.params.opacity === 'number' ? output.params.opacity : 1;
    const transparent = binding.compiled.connected.has('opacity') || opacity < 1;
    material.transparent = transparent;
    material.depthWrite = !transparent;
    material.normalMap = binding.compiled.connected.has('normal') ? FLAT_NORMAL : null;
};

const patchShader = (binding: GraphBinding, shader: THREE.WebGLProgramParametersWithUniforms): void => {
    const { statements, outputs, connected, uniforms } = binding.compiled;
    shader.uniforms.uMaterialTime = MATERIAL_TIME;
    for (const spec of uniforms) shader.uniforms[spec.name] = binding.uniforms[spec.name];
    const declarations = uniforms.map(spec => `uniform ${GLSL_TYPES[spec.kind]} ${spec.name};`).join('\n');

    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>', `#include <common>\nvarying vec3 vMaterialWorldPosition;`);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <worldpos_vertex>', `#include <worldpos_vertex>\n${WORLD_POSITION_VERTEX}`);

    let fragment = shader.fragmentShader;
    fragment = replaceOnce(fragment, '#include <common>', `#include <common>\n${HELPERS}\n${declarations}`);
    // The whole graph runs where the standard material would read its colour map.
    fragment = replaceOnce(fragment, '#include <map_fragment>', `${statements.join('\n')}\ndiffuseColor.rgb = ${outputs.baseColor};`);
    fragment = replaceOnce(fragment, '#include <alphamap_fragment>', `diffuseColor.a = ${outputs.opacity};`);
    fragment = replaceOnce(fragment, '#include <roughnessmap_fragment>', `float roughnessFactor = ${outputs.roughness};`);
    fragment = replaceOnce(fragment, '#include <metalnessmap_fragment>', `float metalnessFactor = ${outputs.metalness};`);
    if (connected.has('normal')) {
        fragment = replaceOnce(fragment, '#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_READ, `vec3 mapN = ${outputs.normal};`));
    }
    fragment = replaceOnce(fragment, '#include <emissivemap_fragment>', `totalEmissiveRadiance = ${outputs.emissive};`);
    if (connected.has('occlusion')) {
        fragment = replaceOnce(fragment, '#include <aomap_fragment>', `{
    float ambientOcclusion = ${outputs.occlusion};
    reflectedLight.indirectDiffuse *= ambientOcclusion;
    #if defined( USE_ENVMAP ) && defined( STANDARD )
        float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
    #endif
}`);
    }
    shader.fragmentShader = fragment;
};

/**
 * Shades `material` by `graph`: in place when the material already follows a graph and only its
 * constants or textures changed, by rebuilding the shader when its wiring did.
 */
export const bindMaterialGraph = (material: StandardMaterial, graph: unknown, textures: MaterialTextureLookup = () => null): void => {
    const normalized = normalizeMaterialGraph(graph);
    const compiled = compileMaterialGraph(normalized);
    const existing = bindings.get(material);
    if (existing) {
        const rebuild = compiled.key !== existing.compiled.key;
        const wasTransparent = material.transparent;
        const hadNormalMap = material.normalMap;
        existing.graph = normalized;
        existing.compiled = compiled;
        existing.textures = textures;
        syncUniforms(existing);
        applyFlags(material, existing);
        if (rebuild || wasTransparent !== material.transparent || hadNormalMap !== material.normalMap) material.needsUpdate = true;
        return;
    }
    const binding: GraphBinding = {
        graph: normalized,
        compiled,
        uniforms: {},
        textures,
        onBeforeCompile: material.onBeforeCompile,
        customProgramCacheKey: material.customProgramCacheKey,
        hadUv: 'USE_UV' in (material.defines ?? {}),
    };
    bindings.set(material, binding);
    syncUniforms(binding);
    applyFlags(material, binding);
    material.defines = { ...(material.defines ?? {}), USE_UV: '' };
    material.onBeforeCompile = (shader) => patchShader(binding, shader);
    material.customProgramCacheKey = () => `graph:${binding.compiled.key}`;
    material.needsUpdate = true;
};

/** Gives `material` back its own shading (its maps and transparency are the caller's to restore). */
export const unbindMaterialGraph = (material: StandardMaterial): void => {
    const binding = bindings.get(material);
    if (!binding) return;
    bindings.delete(material);
    material.onBeforeCompile = binding.onBeforeCompile;
    material.customProgramCacheKey = binding.customProgramCacheKey;
    if (!binding.hadUv && material.defines) {
        const { USE_UV: _uv, ...rest } = material.defines;
        material.defines = rest;
    }
    if (material.normalMap === FLAT_NORMAL) material.normalMap = null;
    material.needsUpdate = true;
};

/** A new standard material shaded by `graph` (material previews, and meshes that have none of their own). */
export class GraphMaterial extends THREE.MeshStandardMaterial {
    constructor(graph: unknown, textures: MaterialTextureLookup = () => null) {
        super();
        bindMaterialGraph(this, graph, textures);
    }

    /** The graph it shades by (normalised). */
    getGraph(): MaterialGraph {
        return boundMaterialGraph(this)!;
    }

    setGraph(graph: unknown, textures?: MaterialTextureLookup): void {
        bindMaterialGraph(this, graph, textures ?? bindings.get(this)?.textures);
    }
}
