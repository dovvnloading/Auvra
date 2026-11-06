import * as THREE from 'three';
import {
    MAX_RAMP_STOPS,
    OUTPUT_NODE_TYPE,
    STATIC_PARAM_KINDS,
    compileMaterialGraph,
    getMaterialNodeDefinition,
    materialGraphLook,
    materialGraphSettings,
    materialGraphShape,
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
import { hasShaderStage, setShaderStage, type ShaderStage } from './shaderStages';

/**
 * Standard materials shaded by a material graph (runtime/materials/materialGraph.ts). The graph's
 * GLSL replaces the material's own reads of its colour, opacity, roughness, metalness, normal,
 * emissive and occlusion, offsets its vertices, and cuts its shadow; everything else (lights,
 * shadows, fog, environment reflections, skinning, instancing) is three's. The Material Output's
 * settings choose the blend mode (opaque, masked, translucent, additive), alpha clip, two-sided
 * and unlit shading. A graph binds to a material in place, so every mesh sharing it (each placed
 * copy of a model) follows. Its constants and textures are uniforms: editing them updates the
 * material's uniform values as they are, and only a change to the graph's shape (its nodes' kinds,
 * their settings written into the shader, and its wiring) rebuilds its shader. Graphs of one shape
 * share one compiled shader, however many materials use them.
 *
 * The graph is the first of a material's shader stages (shaderStages.ts): the normal map's rebuild,
 * rain, snow and wind still apply on top of it. Each material keeps one set of uniform objects for
 * as long as it lives, whichever graphs it is bound to, so a program three reuses always reads values
 * that are kept up to date.
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

/** The shaders a graph of one shape compiles to: the same for every graph of that shape, whatever its values. */
interface CompiledStages {
    fragment: CompiledMaterialGraph;
    /** The vertex offset, when the graph wires one. */
    vertex: CompiledMaterialGraph | null;
    /** A masked material's cut-out, for its shadow. */
    shadow: CompiledMaterialGraph | null;
    /** Every stage's uniforms by name. */
    specs: Map<string, MaterialUniformSpec>;
    key: string;
}

interface GraphBinding extends CompiledStages {
    graph: MaterialGraph;
    /** materialGraphShape of the graph, with the previews asked for. */
    shape: string;
    preview: MaterialPreviewOptions | null;
    settings: MaterialGraphSettings;
    /** The material's uniforms (uniformsOf). */
    uniforms: Record<string, THREE.IUniform>;
    textures: MaterialTextureLookup;
    own: OwnState;
}

const bindings = new WeakMap<THREE.Material, GraphBinding>();

/**
 * Each material's graph uniforms by name, for as long as it lives: kept across rebinding, unbinding and
 * binding again, so every program three ever built for it reads objects whose values are current.
 */
const materialUniforms = new WeakMap<THREE.Material, Record<string, THREE.IUniform>>();

const uniformsOf = (material: THREE.Material): Record<string, THREE.IUniform> => {
    let uniforms = materialUniforms.get(material);
    if (!uniforms) materialUniforms.set(material, uniforms = {});
    return uniforms;
};

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

/** True when the graph shading `material` offsets its vertices, so what it draws can lie past the geometry's bounds. */
export const materialGraphOffsetsVertices = (material: THREE.Material): boolean => !!bindings.get(material)?.vertex;

/** Whether the graph shapes the material's shadow (a cut-out, or offset vertices). */
const shapesShadow = (binding: Pick<GraphBinding, 'settings' | 'vertex'>): boolean => binding.settings.blendMode === 'masked' || binding.vertex !== null;

const PREVIEW_SETTINGS: MaterialGraphSettings = { blendMode: 'opaque', alphaClip: 0.5, twoSided: false, unlit: true };

/** The shaders of a (normalised) graph. They depend only on its shape, so graphs of one shape share them. */
const compileStages = (graph: MaterialGraph, preview: MaterialPreviewOptions | null): CompiledStages => {
    if (preview) {
        const fragment = compileMaterialGraph(graph, { stage: 'fragment', previews: preview.nodeIds });
        const specs = new Map(fragment.uniforms.map(spec => [spec.name, spec]));
        return { fragment, vertex: null, shadow: null, specs, key: `preview#${preview.columns}#${preview.tile}#${fragment.key}` };
    }
    // Blend mode, two-sided and unlit are settings written into the shader, so they are part of the shape.
    const settings = materialGraphSettings(graph);
    const fragment = compileMaterialGraph(graph, { stage: 'fragment' });
    const vertex = fragment.connected.has('worldPositionOffset') ? compileMaterialGraph(graph, { stage: 'vertex' }) : null;
    const shadow = settings.blendMode === 'masked' ? compileMaterialGraph(graph, { stage: 'shadow' }) : null;
    const specs = new Map<string, MaterialUniformSpec>();
    for (const stage of [fragment, vertex, shadow]) for (const spec of stage?.uniforms ?? []) specs.set(spec.name, spec);
    const key = [fragment.key, vertex?.key ?? '-', shadow?.key ?? '-', settings.blendMode, settings.unlit, settings.twoSided].join('#');
    return { fragment, vertex, shadow, specs, key };
};

/** Shapes compiled lately, most recent last: many materials using one asset, and an asset edited value by value, compile once. */
const compiledShapes = new Map<string, CompiledStages>();
const COMPILED_SHAPES_KEPT = 64;

const shapeOf = (graph: MaterialGraph, preview: MaterialPreviewOptions | null): string =>
    preview ? `${materialGraphShape(graph)}#preview:${preview.tile}:${preview.columns}:${preview.nodeIds.join(',')}` : materialGraphShape(graph);

const compiledFor = (graph: MaterialGraph, preview: MaterialPreviewOptions | null, shape: string): CompiledStages => {
    let compiled = compiledShapes.get(shape);
    if (compiled) {
        compiledShapes.delete(shape);
    } else {
        compiled = compileStages(graph, preview);
        if (compiledShapes.size >= COMPILED_SHAPES_KEPT) compiledShapes.delete(compiledShapes.keys().next().value!);
    }
    compiledShapes.set(shape, compiled);
    return compiled;
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

/**
 * Hands a program every uniform the material has, not only the ones this shader declares: three may
 * later reuse these uniforms for another program it built for the material (see shaderStages.ts).
 */
const bindUniforms = (binding: GraphBinding, shader: THREE.WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uMaterialTime = MATERIAL_TIME;
    Object.assign(shader.uniforms, binding.uniforms);
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
    bindUniforms(binding, shader);
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
    // A graph reading the vertex colours uses them as it likes: three must not multiply them in again.
    if (fragmentBuiltins.has('vertexColor')) source = replaceOnce(source, '#include <color_fragment>', '');
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
    bindUniforms(binding, shader);
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
    depthMaterial.onBeforeCompile = (shader) => {
        const current = bindings.get(material);
        if (current) patchShadowShader(current, shader);
    };
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

/** What decides whether three must rebuild a material's program, besides its key. */
const programFlags = (material: StandardMaterial): unknown[] =>
    [material.transparent, material.side, material.blending, material.alphaTest, material.map, material.normalMap];

/** The graph stage of a material (shaderStages.ts): the graph's shaders spliced into three's. */
/** The renderer that last compiled each graph-shaded material, for drawing what the graph works out (bounceColour.ts). */
const compilers = new WeakMap<THREE.Material, THREE.WebGLRenderer>();

/** The renderer that last compiled `material`'s graph, if one has. */
export const graphRenderer = (material: THREE.Material): THREE.WebGLRenderer | null => compilers.get(material) ?? null;

const graphStage = (material: StandardMaterial): ShaderStage => ({
    patch: (shader, renderer) => {
        const binding = bindings.get(material);
        if (!binding) return;
        if (renderer && !binding.preview) compilers.set(material, renderer);
        patchShader(binding, shader);
    },
    key: () => `graph:${bindings.get(material)?.key ?? '-'}`,
    uniforms: () => uniformsOf(material),
});

/**
 * Shades `material` by `graph`. A graph of the shape the material already follows only changes values:
 * its uniforms are updated as they are, with nothing compiled. A new shape takes the shaders compiled
 * for it (once for every material of that shape), and three rebuilds the material's program.
 */
export const bindMaterialGraph = (
    material: StandardMaterial,
    graph: unknown,
    textures: MaterialTextureLookup = () => null,
    preview: MaterialPreviewOptions | null = null,
): void => {
    const normalised = normalizeMaterialGraph(graph);
    const shape = shapeOf(normalised, preview);
    const settings = preview ? PREVIEW_SETTINGS : materialGraphSettings(normalised);
    const existing = bindings.get(material);
    if (existing) {
        // Something gave the material a compile hook of its own since: the graph goes back on after it.
        if (!hasShaderStage(material, 'graph')) setShaderStage(material, 'graph', graphStage(material));
        const compiled = existing.shape === shape ? existing : compiledFor(normalised, preview, shape);
        const rebuild = compiled.key !== existing.key;
        const before = programFlags(material);
        existing.fragment = compiled.fragment;
        existing.vertex = compiled.vertex;
        existing.shadow = compiled.shadow;
        existing.specs = compiled.specs;
        existing.key = compiled.key;
        existing.graph = normalised;
        existing.shape = shape;
        existing.preview = preview;
        existing.settings = settings;
        existing.textures = textures;
        syncUniforms(existing);
        applyFlags(material, existing);
        const after = programFlags(material);
        if (rebuild || before.some((value, index) => value !== after[index])) material.needsUpdate = true;
        return;
    }
    const binding: GraphBinding = {
        ...compiledFor(normalised, preview, shape),
        graph: normalised,
        shape,
        preview,
        settings,
        uniforms: uniformsOf(material),
        textures,
        own: {
            transparent: material.transparent,
            depthWrite: material.depthWrite,
            blending: material.blending,
            side: material.side,
            alphaTest: material.alphaTest,
            map: material.map,
            normalMap: material.normalMap,
            hadUv: 'USE_UV' in (material.defines ?? {}),
        },
    };
    bindings.set(material, binding);
    syncUniforms(binding);
    applyFlags(material, binding);
    material.defines = { ...(material.defines ?? {}), USE_UV: '' };
    setShaderStage(material, 'graph', graphStage(material));
};

/** The material's own colour and normal maps, as they are while no graph is bound (painting starts from them). */
export const ownMaps = (material: StandardMaterial): { map: THREE.Texture | null; normalMap: THREE.Texture | null } => {
    const binding = bindings.get(material);
    return binding ? { map: binding.own.map, normalMap: binding.own.normalMap } : { map: material.map, normalMap: material.normalMap };
};

/** Gives `material` back its own shading: its maps, blending, sides and transparency as they were. */
export const unbindMaterialGraph = (material: StandardMaterial): void => {
    const binding = bindings.get(material);
    if (!binding) return;
    bindings.delete(material);
    const { own } = binding;
    setShaderStage(material, 'graph', null);
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

/** What a graph may read that differs from one place on a surface to another of the same place on its map. */
const PLACE_BUILTINS: readonly MaterialBuiltin[] = ['worldPosition', 'localPosition', 'objectPosition', 'worldNormal', 'localNormal', 'viewDirection', 'cameraDistance'];

/** What a material's graph gives its surface where nothing is wired to an input, in linear light, and which are wired. */
export interface GraphSurface {
    wired: ReadonlySet<string>;
    /** Whether it goes by where a surface stands or faces, so that two surfaces at one place on a map can look different. */
    readsPlace: boolean;
    baseColor: [number, number, number];
    emissive: [number, number, number];
    roughness: number;
    metalness: number;
    /** 1 for a material the graph does not draw through. */
    opacity: number;
    /** Whether the graph draws it without lighting. */
    unlit?: boolean;
}

/** The surface of a material a graph shades, or null for one it does not. */
export const graphSurface = (material: THREE.Material): GraphSurface | null => {
    const binding = bindings.get(material);
    if (!binding) return null;
    const output = binding.graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    const definition = getMaterialNodeDefinition(OUTPUT_NODE_TYPE)!;
    const read = (key: string) => readParam(definition.params.find(param => param.key === key)!, output?.params[key]);
    const colour = (key: string): [number, number, number] => {
        const [r, g, b] = read(key) as number[];
        // Colours are picked in sRGB.
        const linear = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
        return [linear.r, linear.g, linear.b];
    };
    return {
        wired: binding.fragment.connected,
        readsPlace: PLACE_BUILTINS.some(builtin => binding.fragment.builtins.has(builtin)),
        baseColor: colour('baseColor'),
        emissive: colour('emissive'),
        roughness: read('roughness') as number,
        metalness: read('metalness') as number,
        opacity: binding.settings.blendMode === 'opaque' ? 1 : read('opacity') as number,
        unlit: binding.settings.unlit,
    };
};

/**
 * How a graph-shaded material's base colour is made, for what needs its average (bounced light):
 * - a constant (nothing wired, or a Color or Number node), in linear light;
 * - a texture's picture, times a constant tint (a Texture Sample or Triplanar Sample, perhaps through a
 *   Multiply with a constant); the texture null while it is still loading;
 * - worked out by the graph some other way: `look` changes whenever what it works out may have.
 */
export type GraphColourSource =
    | { kind: 'constant'; colour: [number, number, number] }
    | { kind: 'texture'; texture: THREE.Texture | null; tint: [number, number, number] }
    | { kind: 'worked'; look: string };

type ColourEstimate = { colour: [number, number, number]; texture?: THREE.Texture | null };

const srgbToLinear = (rgb: readonly number[]): [number, number, number] => {
    const colour = new THREE.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? rgb[0] ?? 0, rgb[2] ?? rgb[0] ?? 0, THREE.SRGBColorSpace);
    return [colour.r, colour.g, colour.b];
};

/** The base colour a simple chain of nodes gives, or null for anything the graph must work out. */
const estimateColour = (binding: GraphBinding, nodeId: string, depth: number): ColourEstimate | null => {
    const node = binding.graph.nodes.find(candidate => candidate.id === nodeId);
    if (!node || depth > 8) return null;
    const definition = getMaterialNodeDefinition(node.type);
    if (!definition) return null;
    const param = (key: string) => readParam(definition.params.find(candidate => candidate.key === key)!, node.params[key]);
    const fed = (input: string) => binding.graph.links.find(link => link.toNode === node.id && link.toInput === input);
    switch (node.type) {
        case 'color':
            return { colour: srgbToLinear(param('value') as number[]) };
        case 'float': {
            const value = param('value') as number;
            return { colour: [value, value, value] };
        }
        case 'vector': {
            const [x, y, z] = param('value') as number[];
            return { colour: [x, y, z] };
        }
        case 'reroute': {
            const link = fed('in');
            return link ? estimateColour(binding, link.fromNode, depth + 1) : null;
        }
        case 'texture':
        case 'triplanar': {
            const spec = [...binding.specs.values()].find(candidate => candidate.nodeId === node.id && candidate.param === 'texture');
            const value = spec ? binding.uniforms[spec.name]?.value as THREE.Texture | undefined : undefined;
            return { colour: [1, 1, 1], texture: value && value !== WHITE && value !== FLAT_NORMAL ? value : null };
        }
        case 'multiply': {
            const a = fed('a');
            const b = fed('b');
            const left = a ? estimateColour(binding, a.fromNode, depth + 1) : { colour: [param('a'), param('a'), param('a')] as [number, number, number] };
            const right = b ? estimateColour(binding, b.fromNode, depth + 1) : { colour: [param('b'), param('b'), param('b')] as [number, number, number] };
            if (!left || !right || (left.texture !== undefined && right.texture !== undefined)) return null;
            return { colour: [left.colour[0] * right.colour[0], left.colour[1] * right.colour[1], left.colour[2] * right.colour[2]], texture: left.texture ?? right.texture };
        }
        default:
            return null;
    }
};

/** How the base colour of a material a graph shades is made (GraphColourSource), or null for one it does not shade. */
export const graphColourSource = (material: THREE.Material): GraphColourSource | null => {
    const binding = bindings.get(material);
    if (!binding || binding.preview) return null;
    const output = binding.graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    const link = output && binding.graph.links.find(candidate => candidate.toNode === output.id && candidate.toInput === 'baseColor');
    if (!link) {
        const definition = getMaterialNodeDefinition(OUTPUT_NODE_TYPE)!;
        return { kind: 'constant', colour: srgbToLinear(readParam(definition.params.find(param => param.key === 'baseColor')!, output?.params.baseColor) as number[]) };
    }
    const from = binding.graph.nodes.find(node => node.id === link.fromNode);
    const simple = from && (link.fromOutput === 'rgb' || link.fromOutput === 'out') ? estimateColour(binding, from.id, 0) : null;
    if (simple) return simple.texture !== undefined ? { kind: 'texture', texture: simple.texture, tint: simple.colour } : { kind: 'constant', colour: simple.colour };
    // What it works out changes with its values and with the textures that have loaded.
    const textures = [...binding.specs.values()].filter(spec => spec.kind === 'texture').map(spec => (binding.uniforms[spec.name]?.value as THREE.Texture | undefined)?.uuid ?? '-');
    return { kind: 'worked', look: `${materialGraphLook(binding.graph)}#${textures.join(',')}` };
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
