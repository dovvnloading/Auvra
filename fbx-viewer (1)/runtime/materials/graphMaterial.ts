import * as THREE from 'three';
import {
    MAX_RAMP_STOPS,
    STATIC_PARAM_KINDS,
    compileMaterialGraph,
    getMaterialNodeDefinition,
    materialGraphSettings,
    normalizeMaterialGraph,
    readParam,
    textureSlot,
    type CompiledMaterialGraph,
    type MaterialBuiltin,
    type MaterialGraph,
    type MaterialGraphSettings,
    type MaterialRamp,
    type MaterialUniformSpec,
    type TextureSlot,
} from './materialGraph';
import { helperSource } from './materialGlsl';

/**
 * Standard materials shaded by a material graph (runtime/materials/materialGraph.ts). The graph's
 * GLSL replaces the material's own reads of its colour, opacity, roughness, metalness, normal,
 * emissive and occlusion, offsets its vertices, and cuts its shadow; everything else (lights,
 * shadows, fog, environment reflections, skinning, instancing) is three's. The Material Output's
 * settings choose the blend mode (opaque, masked, translucent, additive), alpha clip, two-sided
 * and unlit shading. A graph binds to a material in place, so every mesh sharing it (each placed
 * copy of a model) follows. Its constants and textures are uniforms: editing them updates the
 * material as it is, and only a change to the graph's wiring or settings rebuilds its shader.
 *
 * Shadows: a material whose shadow the graph shapes (masked, or offset vertices) is given an
 * alpha test and a map, which makes three give it a depth material of its own; just before each
 * shadow draw (Mesh.onBeforeShadow) that depth material is taught the graph's vertex offset and cut-out.
 */

/** Seconds of play, read by every graph material's Time node; whoever renders advances it. */
export const MATERIAL_TIME = { value: 0 };

/**
 * The texture a node names, read as colour ('map'), data or a normal map (textureSlot), or null
 * while it is missing or loading.
 */
export type MaterialTextureLookup = (textureId: string, slot?: TextureSlot) => THREE.Texture | null;

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
const LIT_OUTPUT = 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;';
/** The alpha test a material whose shadow the graph shapes is given when it would otherwise have none. */
const SHADOW_ALPHA_TEST = 1e-4;

const GLSL_TYPES: Record<string, string> = { float: 'float', color: 'vec3', vec2: 'vec2', vec3: 'vec3', texture: 'sampler2D', ramp: 'vec4' };

const declare = (spec: MaterialUniformSpec): string =>
    spec.kind === 'ramp' ? `uniform vec4 ${spec.name}[${MAX_RAMP_STOPS}];` : `uniform ${GLSL_TYPES[spec.kind]} ${spec.name};`;

const replaceOnce = (source: string, find: string, replacement: string): string => {
    if (!source.includes(find)) throw new Error(`The material shader has no "${find}" to replace.`);
    return source.replace(find, replacement);
};

type StandardMaterial = THREE.MeshStandardMaterial;

/** What the material had before a graph shaded it, given back when it is unbound. */
interface OwnState {
    transparent: boolean;
    depthWrite: boolean;
    blending: THREE.Blending;
    side: THREE.Side;
    alphaTest: number;
    map: THREE.Texture | null;
    normalMap: THREE.Texture | null;
    onBeforeCompile: StandardMaterial['onBeforeCompile'];
    customProgramCacheKey: StandardMaterial['customProgramCacheKey'];
    hadUv: boolean;
}

/**
 * Node previews (the material editor): instead of shading a surface, each tile of a grid shows one
 * node's value, unlit and in sRGB, `tile` pixels square and `columns` to a row.
 */
export interface MaterialPreviewOptions {
    nodeIds: readonly string[];
    tile: number;
    columns: number;
}

interface GraphBinding {
    graph: MaterialGraph;
    preview: MaterialPreviewOptions | null;
    settings: MaterialGraphSettings;
    fragment: CompiledMaterialGraph;
    /** The vertex offset, when the graph wires one. */
    vertex: CompiledMaterialGraph | null;
    /** A masked material's cut-out, for its shadow. */
    shadow: CompiledMaterialGraph | null;
    /** Every stage's uniforms by name. */
    specs: Map<string, MaterialUniformSpec>;
    key: string;
    uniforms: Record<string, THREE.IUniform>;
    textures: MaterialTextureLookup;
    own: OwnState;
}

const bindings = new WeakMap<THREE.Material, GraphBinding>();

/** True for the materials a graph can shade: standard and physical. */
export const canBindMaterialGraph = (material: THREE.Material): material is StandardMaterial =>
    (material as StandardMaterial).isMeshStandardMaterial === true;

/** The graph a material is shaded by, if any. */
export const boundMaterialGraph = (material: THREE.Material): MaterialGraph | null => bindings.get(material)?.graph ?? null;

/** True when the graph shading `material` reads the time, so it changes from frame to frame. */
export const materialGraphAnimated = (material: THREE.Material): boolean => {
    const binding = bindings.get(material);
    return !!binding && [binding.fragment, binding.vertex, binding.shadow].some(stage => stage?.builtins.has('time'));
};

/** Whether the graph shapes the material's shadow (a cut-out, or offset vertices). */
const shapesShadow = (binding: Pick<GraphBinding, 'settings' | 'vertex'>): boolean => binding.settings.blendMode === 'masked' || binding.vertex !== null;

const PREVIEW_SETTINGS: MaterialGraphSettings = { blendMode: 'opaque', alphaClip: 0.5, twoSided: false, unlit: true };

const compileStages = (graph: MaterialGraph, preview: MaterialPreviewOptions | null): Omit<GraphBinding, 'uniforms' | 'textures' | 'own'> => {
    if (preview) {
        const fragment = compileMaterialGraph(graph, { stage: 'fragment', previews: preview.nodeIds });
        const specs = new Map(fragment.uniforms.map(spec => [spec.name, spec]));
        return { graph, preview, settings: PREVIEW_SETTINGS, fragment, vertex: null, shadow: null, specs, key: `preview#${preview.columns}#${fragment.key}` };
    }
    const settings = materialGraphSettings(graph);
    const fragment = compileMaterialGraph(graph, { stage: 'fragment' });
    const vertex = fragment.connected.has('worldPositionOffset') ? compileMaterialGraph(graph, { stage: 'vertex' }) : null;
    const shadow = settings.blendMode === 'masked' ? compileMaterialGraph(graph, { stage: 'shadow' }) : null;
    const specs = new Map<string, MaterialUniformSpec>();
    for (const stage of [fragment, vertex, shadow]) for (const spec of stage?.uniforms ?? []) specs.set(spec.name, spec);
    const key = [fragment.key, vertex?.key ?? '-', shadow?.key ?? '-', settings.blendMode, settings.unlit, settings.twoSided].join('#');
    return { graph, preview: null, settings, fragment, vertex, shadow, specs, key };
};

/** Sets each uniform the graph needs from its node's param (adding the ones it lacks). */
const syncUniforms = (binding: GraphBinding): void => {
    const nodes = new Map(binding.graph.nodes.map(node => [node.id, node]));
    for (const spec of binding.specs.values()) {
        const node = nodes.get(spec.nodeId)!;
        const param = getMaterialNodeDefinition(node.type)!.params.find(candidate => candidate.key === spec.param)!;
        if (STATIC_PARAM_KINDS.has(param.kind)) continue;
        const value = readParam(param, node.params[spec.param]);
        const uniform = binding.uniforms[spec.name] ?? (binding.uniforms[spec.name] = { value: null });
        if (spec.kind === 'texture') {
            const slot = textureSlot(node);
            const texture = typeof value === 'string' && value ? binding.textures(value, slot) : null;
            uniform.value = texture ?? (slot === 'normal' ? FLAT_NORMAL : WHITE);
        } else if (spec.kind === 'float') {
            uniform.value = value as number;
        } else if (spec.kind === 'color') {
            const [r, g, b] = value as number[];
            // Colours are picked in sRGB; the shader works in linear light.
            uniform.value = (uniform.value instanceof THREE.Color ? uniform.value : new THREE.Color()).setRGB(r, g, b, THREE.SRGBColorSpace);
        } else if (spec.kind === 'vec2') {
            const [x, y] = value as number[];
            uniform.value = (uniform.value instanceof THREE.Vector2 ? uniform.value : new THREE.Vector2()).set(x, y);
        } else if (spec.kind === 'ramp') {
            const stops = (value as MaterialRamp).stops;
            const array: THREE.Vector4[] = Array.isArray(uniform.value) && uniform.value.length === MAX_RAMP_STOPS
                ? uniform.value
                : Array.from({ length: MAX_RAMP_STOPS }, () => new THREE.Vector4());
            const color = new THREE.Color();
            array.forEach((entry, index) => {
                const stop = stops[Math.min(index, stops.length - 1)];
                color.setRGB(stop.color[0], stop.color[1], stop.color[2], THREE.SRGBColorSpace);
                // Entries past the last stop repeat it beyond 1, so the search always ends on it.
                entry.set(color.r, color.g, color.b, index < stops.length ? stop.position : 2 + index);
            });
            uniform.value = array;
        } else {
            const [x, y, z] = value as number[];
            uniform.value = (uniform.value instanceof THREE.Vector3 ? uniform.value : new THREE.Vector3()).set(x, y, z);
        }
    }
};

/** Blending, sides, transparency, the alpha test and the normal map stand-in follow the graph. */
const applyFlags = (material: StandardMaterial, binding: GraphBinding): void => {
    const { blendMode, alphaClip, twoSided } = binding.settings;
    const transparent = blendMode === 'translucent' || blendMode === 'additive';
    const shadowShaped = shapesShadow(binding);
    material.transparent = transparent;
    material.depthWrite = !transparent;
    material.blending = blendMode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.side = twoSided ? THREE.DoubleSide : binding.own.side;
    material.alphaTest = blendMode === 'masked' ? Math.max(alphaClip, SHADOW_ALPHA_TEST) : shadowShaped ? SHADOW_ALPHA_TEST : binding.own.alphaTest;
    // A map (any) and an alpha test give the material a shadow depth material of its own.
    material.map = shadowShaped ? binding.own.map ?? WHITE : binding.own.map;
    material.normalMap = binding.fragment.connected.has('normal') ? FLAT_NORMAL : null;
};

/** GLSL every stage of a shader shares: time, the stage's uniforms, helpers and nodes' own functions. */
const preamble = (stages: Array<CompiledMaterialGraph | null>): string => {
    const specs = new Map<string, MaterialUniformSpec>();
    const helpers = new Set<string>();
    const globals: string[] = [];
    for (const stage of stages) {
        if (!stage) continue;
        for (const spec of stage.uniforms) specs.set(spec.name, spec);
        for (const helper of stage.helpers) helpers.add(helper);
        globals.push(...stage.globals);
    }
    return ['uniform float uMaterialTime;', ...[...specs.values()].map(declare), helperSource(helpers), ...globals].join('\n');
};

const varyingsFor = (builtins: ReadonlySet<MaterialBuiltin>): string[] => [
    'varying vec3 vMgWorldPosition;',
    ...(builtins.has('localPosition') ? ['varying vec3 vMgLocalPosition;'] : []),
    ...(builtins.has('objectPosition') ? ['varying vec3 vMgObjectPosition;'] : []),
    ...(builtins.has('localNormal') ? ['varying vec3 vMgLocalNormal;'] : []),
];

const VERTEX_COLOR_ATTRIBUTE = `
vec3 mgVertexColorAttribute() {
#if defined( USE_COLOR_ALPHA )
    return color.rgb;
#elif defined( USE_COLOR )
    return color;
#else
    return vec3(1.0);
#endif
}`;

/**
 * The vertex shader's part: the builtins a vertex offset reads, the offset (applied in object space,
 * so the projection, shadows and the world position all follow it), and the varyings the pixels read.
 */
const vertexBlock = (vertex: CompiledMaterialGraph | null, fragmentBuiltins: ReadonlySet<MaterialBuiltin>): string => `
{
    vec3 mgVertexLocal = transformed;
    mat4 mgModel = modelMatrix;
    #ifdef USE_BATCHING
        mgModel = mgModel * batchingMatrix;
    #endif
    #ifdef USE_INSTANCING
        mgModel = mgModel * instanceMatrix;
    #endif
    vec3 mgVertexWorld = (mgModel * vec4(transformed, 1.0)).xyz;
    vec3 mgVertexOrigin = (mgModel * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 mgVertexWorldNormal = normalize(mat3(mgModel) * MG_OBJECT_NORMAL);
    ${fragmentBuiltins.has('localPosition') ? 'vMgLocalPosition = transformed;' : ''}
    ${fragmentBuiltins.has('localNormal') ? 'vMgLocalNormal = MG_OBJECT_NORMAL;' : ''}
    ${fragmentBuiltins.has('objectPosition') ? 'vMgObjectPosition = mgVertexOrigin;' : ''}
    ${vertex ? `${vertex.statements.join('\n    ')}\n    transformed += inverse(mat3(mgModel)) * (${vertex.outputs.worldPositionOffset});` : ''}
    vMgWorldPosition = (mgModel * vec4(transformed, 1.0)).xyz;
}
#include <project_vertex>`;

const FRAGMENT_FUNCTIONS = `
vec3 mgViewNormal() {
#ifdef FLAT_SHADED
    vec3 n = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
#else
    vec3 n = normalize(vNormal);
    #ifdef DOUBLE_SIDED
        n *= gl_FrontFacing ? 1.0 : -1.0;
    #endif
#endif
    return n;
}
vec3 mgWorldNormal() {
    return normalize((vec4(mgViewNormal(), 0.0) * viewMatrix).xyz);
}
vec3 mgVertexColor() {
#if defined( USE_COLOR_ALPHA )
    return vColor.rgb;
#elif defined( USE_COLOR )
    return vColor;
#else
    return vec3(1.0);
#endif
}`;

const bindUniforms = (binding: GraphBinding, shader: THREE.WebGLProgramParametersWithUniforms, stages: Array<CompiledMaterialGraph | null>): void => {
    shader.uniforms.uMaterialTime = MATERIAL_TIME;
    for (const stage of stages) for (const spec of stage?.uniforms ?? []) shader.uniforms[spec.name] = binding.uniforms[spec.name];
};

/** GLSL picking the value of the preview tile the pixel is in. */
const previewSelection = (preview: MaterialPreviewOptions, previews: readonly string[]): string => [
    `int mgTile = int(gl_FragCoord.x / ${preview.tile.toFixed(1)}) + int(gl_FragCoord.y / ${preview.tile.toFixed(1)}) * ${preview.columns};`,
    'vec3 mgPreview = vec3(0.0);',
    ...previews.map((expression, index) => `${index ? 'else ' : ''}if (mgTile == ${index}) mgPreview = ${expression};`),
].join('\n');

const patchShader = (binding: GraphBinding, shader: THREE.WebGLProgramParametersWithUniforms): void => {
    const { fragment, vertex, settings, preview } = binding;
    const { statements, outputs, connected } = fragment;
    bindUniforms(binding, shader, [fragment, vertex]);
    const fragmentBuiltins = fragment.builtins;

    shader.vertexShader = replaceOnce(shader.vertexShader, 'void main() {',
        `${varyingsFor(fragmentBuiltins).join('\n')}\n#define MG_OBJECT_NORMAL objectNormal\n${VERTEX_COLOR_ATTRIBUTE}\n${preamble([vertex])}\nvoid main() {`);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <project_vertex>', vertexBlock(vertex, fragmentBuiltins));

    let source = shader.fragmentShader;
    source = replaceOnce(source, 'void main() {', `${varyingsFor(fragmentBuiltins).join('\n')}\n${FRAGMENT_FUNCTIONS}\n${preamble([fragment])}\nvoid main() {`);
    // The whole graph runs where the standard material would read its colour map.
    source = replaceOnce(source, '#include <map_fragment>', preview
        ? `${statements.join('\n')}\n${previewSelection(preview, fragment.previews)}\ndiffuseColor.rgb = mgPreview;`
        : `${statements.join('\n')}\ndiffuseColor.rgb = ${outputs.baseColor};`);
    source = replaceOnce(source, '#include <alphamap_fragment>', settings.blendMode === 'opaque' ? 'diffuseColor.a = 1.0;' : `diffuseColor.a = ${outputs.opacity};`);
    source = replaceOnce(source, '#include <roughnessmap_fragment>', `float roughnessFactor = ${outputs.roughness};`);
    source = replaceOnce(source, '#include <metalnessmap_fragment>', `float metalnessFactor = ${outputs.metalness};`);
    if (connected.has('normal')) {
        source = replaceOnce(source, '#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(NORMAL_READ, `vec3 mapN = ${outputs.normal};`));
    }
    source = replaceOnce(source, '#include <emissivemap_fragment>', preview ? 'totalEmissiveRadiance = vec3(0.0);' : `totalEmissiveRadiance = ${outputs.emissive};`);
    if (connected.has('occlusion')) {
        source = replaceOnce(source, '#include <aomap_fragment>', `{
    float ambientOcclusion = ${outputs.occlusion};
    reflectedLight.indirectDiffuse *= ambientOcclusion;
    #if defined( USE_ENVMAP ) && defined( STANDARD )
        float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
    #endif
}`);
    }
    if (settings.unlit) source = replaceOnce(source, LIT_OUTPUT, 'vec3 outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;');
    // Previews draw into a linear render target, but are read back as the image they show.
    if (preview) source = replaceOnce(source, '#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( clamp( gl_FragColor, 0.0, 1.0 ) );');
    shader.fragmentShader = source;
};

/** Teaches a shadow depth (or distance) material the graph's vertex offset and cut-out. */
const patchShadowShader = (binding: GraphBinding, shader: THREE.WebGLProgramParametersWithUniforms): void => {
    const { vertex, shadow } = binding;
    bindUniforms(binding, shader, [vertex, shadow]);
    const builtins = shadow?.builtins ?? new Set<MaterialBuiltin>();
    shader.vertexShader = replaceOnce(shader.vertexShader, 'void main() {',
        `${varyingsFor(builtins).join('\n')}\n#define MG_OBJECT_NORMAL normal\n${VERTEX_COLOR_ATTRIBUTE}\n${preamble([vertex])}\nvoid main() {`);
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <project_vertex>', vertexBlock(vertex, builtins));
    let source = shader.fragmentShader;
    source = replaceOnce(source, 'void main() {', `${varyingsFor(builtins).join('\n')}\n${preamble([shadow])}\nvoid main() {`);
    source = replaceOnce(source, '#include <map_fragment>', shadow ? `${shadow.statements.join('\n')}\ndiffuseColor.a = ${shadow.outputs.opacity};` : '');
    shader.fragmentShader = source;
};

/** The graph each shadow depth material was last taught, so it is rebuilt only when that changes. */
const shadowKeys = new WeakMap<THREE.Material, string>();

/**
 * Called before a mesh draws into a shadow map with `depthMaterial` (three's depth material of the
 * mesh's material): teaches it the graph when the graph shapes the shadow, and gives it back its
 * own shading once the material no longer has such a graph.
 */
const prepareShadow = (material: THREE.Material, depthMaterial: THREE.Material): void => {
    if (depthMaterial === material) return;
    const binding = bindings.get(material);
    if (!binding || !shapesShadow(binding)) {
        if (!shadowKeys.has(depthMaterial)) return;
        shadowKeys.delete(depthMaterial);
        const { USE_UV: _uv, ...defines } = depthMaterial.defines ?? {};
        depthMaterial.defines = defines;
        depthMaterial.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
        depthMaterial.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
        depthMaterial.needsUpdate = true;
        return;
    }
    const kind = (depthMaterial as THREE.MeshDistanceMaterial).isMeshDistanceMaterial ? 'distance' : 'depth';
    const key = `${binding.key}:${kind}`;
    if (shadowKeys.get(depthMaterial) === key) return;
    shadowKeys.set(depthMaterial, key);
    depthMaterial.defines = { ...(depthMaterial.defines ?? {}), USE_UV: '' };
    depthMaterial.onBeforeCompile = (shader) => patchShadowShader(binding, shader);
    depthMaterial.customProgramCacheKey = () => `graph-shadow:${key}`;
    depthMaterial.needsUpdate = true;
};

THREE.Mesh.prototype.onBeforeShadow = function onBeforeShadow(this: THREE.Mesh, ...args: Parameters<THREE.Mesh['onBeforeShadow']>) {
    const depthMaterial = args[5];
    // three passes the geometry group being drawn (null for a single material); the types call it a Group.
    const group = args[6] as unknown as { materialIndex: number } | null;
    const material = Array.isArray(this.material) ? (group ? this.material[group.materialIndex] : undefined) : this.material;
    if (material) prepareShadow(material, depthMaterial);
};

/**
 * Shades `material` by `graph`: in place when the material already follows a graph and only its
 * constants or textures changed, by rebuilding the shader when its wiring or settings did.
 */
export const bindMaterialGraph = (
    material: StandardMaterial,
    graph: unknown,
    textures: MaterialTextureLookup = () => null,
    preview: MaterialPreviewOptions | null = null,
): void => {
    const stages = compileStages(normalizeMaterialGraph(graph), preview);
    const existing = bindings.get(material);
    if (existing) {
        const rebuild = stages.key !== existing.key;
        const before = [material.transparent, material.side, material.blending, material.alphaTest, material.map, material.normalMap];
        Object.assign(existing, stages);
        existing.textures = textures;
        syncUniforms(existing);
        applyFlags(material, existing);
        const after = [material.transparent, material.side, material.blending, material.alphaTest, material.map, material.normalMap];
        if (rebuild || before.some((value, index) => value !== after[index])) material.needsUpdate = true;
        return;
    }
    const binding: GraphBinding = {
        ...stages,
        uniforms: {},
        textures,
        own: {
            transparent: material.transparent,
            depthWrite: material.depthWrite,
            blending: material.blending,
            side: material.side,
            alphaTest: material.alphaTest,
            map: material.map,
            normalMap: material.normalMap,
            onBeforeCompile: material.onBeforeCompile,
            customProgramCacheKey: material.customProgramCacheKey,
            hadUv: 'USE_UV' in (material.defines ?? {}),
        },
    };
    bindings.set(material, binding);
    syncUniforms(binding);
    applyFlags(material, binding);
    material.defines = { ...(material.defines ?? {}), USE_UV: '' };
    material.onBeforeCompile = (shader) => patchShader(binding, shader);
    material.customProgramCacheKey = () => `graph:${binding.key}`;
    material.needsUpdate = true;
};

/** Gives `material` back its own shading: its maps, blending, sides and transparency as they were. */
export const unbindMaterialGraph = (material: StandardMaterial): void => {
    const binding = bindings.get(material);
    if (!binding) return;
    bindings.delete(material);
    const { own } = binding;
    material.onBeforeCompile = own.onBeforeCompile;
    material.customProgramCacheKey = own.customProgramCacheKey;
    if (!own.hadUv && material.defines) {
        const { USE_UV: _uv, ...rest } = material.defines;
        material.defines = rest;
    }
    material.transparent = own.transparent;
    material.depthWrite = own.depthWrite;
    material.blending = own.blending;
    material.side = own.side;
    material.alphaTest = own.alphaTest;
    material.map = own.map;
    material.normalMap = own.normalMap;
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
