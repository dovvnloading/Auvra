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
 * A standard material shaded by a material graph (runtime/materials/materialGraph.ts). The graph's
 * GLSL replaces the standard material's own reads of its colour, opacity, roughness, metalness,
 * normal, emissive and occlusion; everything else (lights, shadows, fog, environment reflections,
 * skinning, instancing) is three's. The graph's constants and textures are uniforms, so editing them
 * updates the material in place; only a change to the graph's wiring rebuilds its shader.
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

export class GraphMaterial extends THREE.MeshStandardMaterial {
    readonly isGraphMaterial = true;
    private graph: MaterialGraph;
    private compiled: CompiledMaterialGraph;
    private readonly graphUniforms: Record<string, THREE.IUniform> = {};
    private textures: MaterialTextureLookup;

    constructor(graph: unknown, textures: MaterialTextureLookup = () => null) {
        super();
        this.textures = textures;
        this.graph = normalizeMaterialGraph(graph);
        this.compiled = compileMaterialGraph(this.graph);
        this.defines = { ...this.defines, USE_UV: '' };
        this.syncUniforms();
        this.applyFlags();
        this.onBeforeCompile = (shader) => this.patchShader(shader);
    }

    customProgramCacheKey(): string {
        return `graph:${this.compiled.key}`;
    }

    /** The graph it shades by (normalised). */
    getGraph(): MaterialGraph {
        return this.graph;
    }

    /**
     * Shades by `graph` from now on: in place when only its constants or textures changed, by
     * rebuilding the shader when its wiring did.
     */
    setGraph(graph: unknown, textures: MaterialTextureLookup = this.textures): void {
        this.textures = textures;
        this.graph = normalizeMaterialGraph(graph);
        const compiled = compileMaterialGraph(this.graph);
        const rebuild = compiled.key !== this.compiled.key;
        this.compiled = compiled;
        this.syncUniforms();
        if (this.applyFlags() || rebuild) this.needsUpdate = true;
    }

    /** Sets each uniform the graph needs from its node's param (adding the ones it lacks). */
    private syncUniforms(): void {
        const nodes = new Map(this.graph.nodes.map(node => [node.id, node]));
        for (const spec of this.compiled.uniforms) {
            const node = nodes.get(spec.nodeId)!;
            const param = getMaterialNodeDefinition(node.type)!.params.find(candidate => candidate.key === spec.param)!;
            const value = readParam(param, node.params[spec.param]);
            const uniform = this.graphUniforms[spec.name] ?? (this.graphUniforms[spec.name] = { value: null });
            if (spec.kind === 'texture') {
                const texture = typeof value === 'string' && value ? this.textures(value) : null;
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
    }

    /** Transparency and the normal map stand-in follow the graph; true when that changes the shader. */
    private applyFlags(): boolean {
        const output = this.graph.nodes.find(node => node.type === 'output')!;
        const opacity = typeof output.params.opacity === 'number' ? output.params.opacity : 1;
        const transparent = this.compiled.connected.has('opacity') || opacity < 1;
        const normalMap = this.compiled.connected.has('normal') ? FLAT_NORMAL : null;
        const changed = transparent !== this.transparent || normalMap !== this.normalMap;
        this.transparent = transparent;
        this.depthWrite = !transparent;
        this.normalMap = normalMap;
        return changed;
    }

    private patchShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
        const { statements, outputs, connected, uniforms } = this.compiled;
        shader.uniforms.uMaterialTime = MATERIAL_TIME;
        for (const spec of uniforms) shader.uniforms[spec.name] = this.graphUniforms[spec.name];
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
    }
}

export const isGraphMaterial = (material: THREE.Material): material is GraphMaterial =>
    (material as Partial<GraphMaterial>).isGraphMaterial === true;
