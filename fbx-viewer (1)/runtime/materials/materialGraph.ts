/**
 * MATERIAL GRAPHS
 *
 * A material asset is a graph of nodes (materialNodes.ts) wired output to input, ending in one
 * Material Output node whose inputs shade the surface. compileMaterialGraph turns the part of it a
 * shader stage needs into GLSL that runtime/materials/graphMaterial.ts splices into three's standard
 * material (and its shadow materials), so lighting, shadows, fog, skinning and instancing stay three's:
 *
 * - the fragment stage computes base colour, opacity, metalness, roughness, normal, emissive and
 *   occlusion for each pixel;
 * - the vertex stage computes the World Position Offset that moves each vertex;
 * - the shadow stage computes a masked material's opacity, so its shadow has the same holes.
 *
 * Values are float, vec2, vec3 or vec4. An input takes any of them: a float fills every component,
 * a wider vector is cut down to its first components, a narrower one is padded with zeros (and a
 * colour becoming four components gets an alpha of 1). Math nodes have 'auto' ports, which take the
 * widest type wired into them. Constants a node is set to (a colour, a number, a texture, a ramp)
 * become uniforms, so changing them does not rebuild the shader; only the graph's shape and its
 * static settings (a select, a switch, custom code) do.
 */

import {
    BUILTIN_TYPES,
    MAX_RAMP_STOPS,
    STATIC_PARAM_KINDS,
    type MaterialBuiltin,
    type MaterialInputDef,
    type MaterialNodeDef,
    type MaterialParamDef,
    type MaterialParamKind,
    type MaterialParamValue,
    type MaterialPortType,
    type MaterialRamp,
    type MaterialStage,
    type MaterialValueType,
    type NodeEmitContext,
} from './materialTypes';
import { MATERIAL_NODE_DEFINITIONS, OUTPUT_NODE_TYPE } from './materialNodes';
import { hasHelper } from './materialGlsl';

export * from './materialTypes';
export { MATERIAL_NODE_DEFINITIONS, OUTPUT_NODE_TYPE, REROUTE_NODE_TYPE, swizzleMask } from './materialNodes';

export interface MaterialGraphNode {
    id: string;
    type: string;
    /** Where the node sits on the canvas. */
    x: number;
    y: number;
    /** The node's own settings (constant values, texture id, ...), by the names its definition gives. */
    params: Record<string, unknown>;
    /**
     * Exposes the node's value as a material parameter by this name (Number, Color and Vector
     * nodes): each model material using the asset may set its own value (see withMaterialParameters).
     */
    parameter?: string;
}

export interface MaterialGraphLink {
    fromNode: string;
    fromOutput: string;
    toNode: string;
    toInput: string;
}

/** A titled box behind nodes, grouping them on the canvas; the shader never sees it. */
export interface MaterialGraphComment {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    /** #rrggbb */
    color: string;
}

export interface MaterialGraph {
    nodes: MaterialGraphNode[];
    links: MaterialGraphLink[];
    /** Present only when the graph has some. */
    comments?: MaterialGraphComment[];
}

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

const componentCount: Record<MaterialValueType, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
const TYPES_BY_COUNT: readonly MaterialValueType[] = ['float', 'vec2', 'vec3', 'vec4'];

/** `expression` of type `from` as type `to`. */
export const convertValue = (expression: string, from: MaterialValueType, to: MaterialValueType): string => {
    if (from === to) return expression;
    if (from === 'float') return `${to}(${expression})`;
    const fromCount = componentCount[from];
    const toCount = componentCount[to];
    if (to === 'float') return `(${expression}).x`;
    if (toCount < fromCount) return `(${expression}).${'xyzw'.slice(0, toCount)}`;
    // Widening: zeros, and an alpha of 1 for a colour becoming vec4.
    const pad = Array.from({ length: toCount - fromCount }, (_, i) => (fromCount + i === 3 ? '1.0' : '0.0'));
    return `${to}(${expression}, ${pad.join(', ')})`;
};

/** The GLSL type a uniform param has. */
const PARAM_TYPES: Partial<Record<MaterialParamKind, MaterialValueType>> = { float: 'float', color: 'vec3', vec2: 'vec2', vec3: 'vec3' };

const DEFINITIONS = new Map(MATERIAL_NODE_DEFINITIONS.map(definition => [definition.type, definition]));

export const getMaterialNodeDefinition = (type: string): MaterialNodeDef | undefined => DEFINITIONS.get(type);

/** Material Output inputs each stage computes. */
export const STAGE_OUTPUTS: Record<MaterialStage, readonly string[]> = {
    fragment: ['baseColor', 'opacity', 'metalness', 'roughness', 'normal', 'emissive', 'occlusion'],
    vertex: ['worldPositionOffset'],
    shadow: ['opacity'],
};

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Longest custom code kept (characters). */
export const MAX_CODE_LENGTH = 8000;

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const readRamp = (value: unknown, fallback: MaterialRamp): MaterialRamp => {
    const stops = (value as Partial<MaterialRamp> | null)?.stops;
    if (!Array.isArray(stops)) return structuredClone(fallback);
    const valid = stops
        .filter((stop): stop is { position: number; color: number[] } =>
            !!stop && finiteNumber(stop.position) && Array.isArray(stop.color) && stop.color.length === 3 && stop.color.every(finiteNumber))
        .map(stop => ({ position: Math.min(1, Math.max(0, stop.position)), color: stop.color.map(c => Math.min(1, Math.max(0, c))) }))
        .sort((a, b) => a.position - b.position)
        .slice(0, MAX_RAMP_STOPS);
    return valid.length ? { stops: valid } : structuredClone(fallback);
};

/** A param value of the right shape, or the param's default. */
export const readParam = (param: MaterialParamDef, value: unknown): MaterialParamValue => {
    switch (param.kind) {
        case 'texture':
            return typeof value === 'string' ? value.slice(0, 128) : '';
        case 'float':
            if (!finiteNumber(value)) return param.default as number;
            return Math.min(param.max ?? Infinity, Math.max(param.min ?? -Infinity, value));
        case 'select':
            return typeof value === 'string' && param.options?.some(option => option.value === value) ? value : param.default as string;
        case 'boolean':
            return typeof value === 'boolean' ? value : param.default as boolean;
        case 'code':
            return typeof value === 'string' ? value.slice(0, MAX_CODE_LENGTH) : param.default as string;
        case 'ramp':
            return readRamp(value, param.default as MaterialRamp);
        default: {
            const size = param.kind === 'vec2' ? 2 : 3;
            if (Array.isArray(value) && value.length === size && value.every(finiteNumber)) return value.map(Number);
            return param.default as number[];
        }
    }
};

/** Every param of a node type at its default. */
export const defaultParams = (type: string): Record<string, unknown> => {
    const definition = DEFINITIONS.get(type);
    return Object.fromEntries((definition?.params ?? []).map(param => [param.key, structuredClone(param.default)]));
};

/**
 * How a node's texture is read: colour (decoded from sRGB), data (as stored: masks, roughness,
 * height) or a normal map.
 */
export type TextureSlot = 'map' | 'normal' | 'data';

/** The way `node` reads the texture its 'texture' param picks. */
export const textureSlot = (node: MaterialGraphNode): TextureSlot => {
    if (node.type === 'normalMap') return 'normal';
    const space = DEFINITIONS.get(node.type)?.params.find(param => param.key === 'space');
    return space && readParam(space, node.params.space) === 'data' ? 'data' : 'map';
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Node types whose value can be a material parameter, and the param holding it. */
export const PARAMETER_NODE_PARAMS: Readonly<Record<string, string>> = { float: 'value', color: 'value', vector: 'value', vector2: 'value' };
export const MAX_PARAMETER_NAME_LENGTH = 64;

/** A parameter name trimmed and within its length, or undefined (not exposed). */
export const normalizeParameterName = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const name = value.trim().slice(0, MAX_PARAMETER_NAME_LENGTH);
    return name || undefined;
};

/** A graph's exposed value, as a material using it may set it. */
export interface MaterialParameter {
    name: string;
    /** The value's param definition (kind, range) on the first node exposing the name. */
    param: MaterialParamDef;
    /** The value set in the graph, used where a material sets none. */
    value: number | number[];
}

/** Parameter values by name, as a model material sets them. */
export type MaterialParameterValues = Record<string, number | number[]>;

const parameterParam = (node: MaterialGraphNode): MaterialParamDef | undefined => {
    const key = PARAMETER_NODE_PARAMS[node.type];
    return key ? DEFINITIONS.get(node.type)?.params.find(param => param.key === key) : undefined;
};

/** The graph's parameters by name (nodes sharing a name share the value), sorted by name. */
export const materialGraphParameters = (graph: MaterialGraph): MaterialParameter[] => {
    const found = new Map<string, MaterialParameter>();
    for (const node of graph.nodes) {
        const param = parameterParam(node);
        const name = normalizeParameterName(node.parameter);
        if (!param || !name || found.has(name)) continue;
        found.set(name, { name, param, value: readParam(param, node.params[param.key]) as number | number[] });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The graph with its parameters set to `values` (missing or malformed ones keep the graph's
 * own); the same graph when nothing changes. Only constants change, so the material keeps its
 * shader and only its uniforms differ.
 */
export const withMaterialParameters = (graph: MaterialGraph, values: MaterialParameterValues | null | undefined): MaterialGraph => {
    if (!values || !Object.keys(values).length) return graph;
    let changed = false;
    const nodes = graph.nodes.map((node) => {
        const param = parameterParam(node);
        const name = normalizeParameterName(node.parameter);
        if (!param || !name || !Object.hasOwn(values, name)) return node;
        changed = true;
        return { ...node, params: { ...node.params, [param.key]: readParam(param, values[name]) } };
    });
    return changed ? { ...graph, nodes } : graph;
};

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

/** A new graph: a Material Output on its own, which shades like a plain grey surface. */
export const createMaterialGraph = (): MaterialGraph => ({
    nodes: [{ id: 'output', type: OUTPUT_NODE_TYPE, x: 480, y: 120, params: defaultParams(OUTPUT_NODE_TYPE) }],
    links: [],
});

export const MAX_COMMENT_LENGTH = 500;
const COMMENT_COLOR = /^#[0-9a-f]{6}$/i;

const readComments = (value: unknown): MaterialGraphComment[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const comments: MaterialGraphComment[] = [];
    for (const raw of value) {
        const comment = (raw && typeof raw === 'object' ? raw : {}) as Partial<MaterialGraphComment>;
        if (typeof comment.id !== 'string' || !comment.id || seen.has(comment.id)) continue;
        if (![comment.x, comment.y, comment.width, comment.height].every(finiteNumber)) continue;
        seen.add(comment.id);
        comments.push({
            id: comment.id,
            x: comment.x!,
            y: comment.y!,
            width: Math.min(8000, Math.max(80, comment.width!)),
            height: Math.min(8000, Math.max(48, comment.height!)),
            text: typeof comment.text === 'string' ? comment.text.slice(0, MAX_COMMENT_LENGTH) : '',
            color: typeof comment.color === 'string' && COMMENT_COLOR.test(comment.color) ? comment.color.toLowerCase() : '#3b4252',
        });
    }
    return comments;
};

/**
 * A stored graph made safe to compile: nodes of known types with valid params, links between
 * existing ports, at most one link per input, and exactly one Material Output.
 */
export const normalizeMaterialGraph = (value: unknown): MaterialGraph => {
    const source = (value && typeof value === 'object' ? value : {}) as { nodes?: unknown; links?: unknown; comments?: unknown };
    const rawLinks = Array.isArray(source.links) ? source.links : [];
    const nodes: MaterialGraphNode[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(source.nodes) ? source.nodes : []) {
        if (!raw || typeof raw !== 'object') continue;
        const node = raw as Partial<MaterialGraphNode>;
        const definition = typeof node.type === 'string' ? DEFINITIONS.get(node.type) : undefined;
        if (!definition || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue;
        if (definition.type === OUTPUT_NODE_TYPE && nodes.some(other => other.type === OUTPUT_NODE_TYPE)) continue;
        seen.add(node.id);
        const params = { ...(node.params && typeof node.params === 'object' ? node.params : {}) } as Record<string, unknown>;
        if (definition.type === OUTPUT_NODE_TYPE && !('blendMode' in params)) {
            // Graphs from before blend modes were translucent wherever they set an opacity.
            const opacityWired = rawLinks.some(link => (link as Partial<MaterialGraphLink>)?.toNode === node.id && (link as Partial<MaterialGraphLink>)?.toInput === 'opacity');
            params.blendMode = opacityWired || (finiteNumber(params.opacity) && params.opacity < 1) ? 'translucent' : 'opaque';
        }
        nodes.push({
            id: node.id,
            type: definition.type,
            x: finiteNumber(node.x) ? node.x : 0,
            y: finiteNumber(node.y) ? node.y : 0,
            params: Object.fromEntries(definition.params.map(param => [param.key, readParam(param, params[param.key])])),
            ...(PARAMETER_NODE_PARAMS[definition.type] && normalizeParameterName(node.parameter) ? { parameter: normalizeParameterName(node.parameter) } : {}),
        });
    }
    if (!nodes.some(node => node.type === OUTPUT_NODE_TYPE)) nodes.unshift(createMaterialGraph().nodes[0]);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const links: MaterialGraphLink[] = [];
    const fedInputs = new Set<string>();
    for (const raw of rawLinks) {
        if (!raw || typeof raw !== 'object') continue;
        const link = raw as Partial<MaterialGraphLink>;
        const from = typeof link.fromNode === 'string' ? byId.get(link.fromNode) : undefined;
        const to = typeof link.toNode === 'string' ? byId.get(link.toNode) : undefined;
        if (!from || !to || from === to) continue;
        if (!DEFINITIONS.get(from.type)!.outputs.some(output => output.key === link.fromOutput)) continue;
        if (!DEFINITIONS.get(to.type)!.inputs.some(input => input.key === link.toInput)) continue;
        const inputKey = `${to.id}:${link.toInput}`;
        if (fedInputs.has(inputKey)) continue;
        fedInputs.add(inputKey);
        links.push({ fromNode: from.id, fromOutput: link.fromOutput!, toNode: to.id, toInput: link.toInput! });
    }
    const comments = readComments(source.comments);
    return comments.length ? { nodes, links, comments } : { nodes, links };
};

/** True when linking from `fromNode` into `toNode` would close a loop. */
export const wouldCreateCycle = (graph: MaterialGraph, fromNode: string, toNode: string): boolean => {
    if (fromNode === toNode) return true;
    // Is fromNode reachable downstream of toNode? Then toNode already feeds fromNode.
    const stack = [toNode];
    const visited = new Set<string>();
    while (stack.length) {
        const current = stack.pop()!;
        if (current === fromNode) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const link of graph.links) if (link.fromNode === current) stack.push(link.toNode);
    }
    return false;
};

// ---------------------------------------------------------------------------
// Types of auto ports
// ---------------------------------------------------------------------------

const staticParams = (node: MaterialGraphNode, definition: MaterialNodeDef): Record<string, unknown> =>
    Object.fromEntries(definition.params.filter(param => STATIC_PARAM_KINDS.has(param.kind)).map(param => [param.key, readParam(param, node.params[param.key])]));

const widest = (types: Iterable<MaterialValueType>): MaterialValueType => {
    let count = 1;
    for (const type of types) count = Math.max(count, componentCount[type]);
    return TYPES_BY_COUNT[count - 1];
};

/**
 * The type each node's auto ports take: from its static params when its definition says so (a
 * Swizzle's mask), else the widest type wired into (or set on) its auto inputs; float when none.
 */
export const resolveAutoTypes = (graph: MaterialGraph): Map<string, MaterialValueType> => {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const incoming = new Map<string, MaterialGraphLink>();
    for (const link of graph.links) incoming.set(`${link.toNode}:${link.toInput}`, link);
    const resolved = new Map<string, MaterialValueType>();
    const visiting = new Set<string>();

    const portType = (node: MaterialGraphNode, type: MaterialPortType): MaterialValueType => (type === 'auto' ? resolve(node) : type);

    const fallbackType = (node: MaterialGraphNode, definition: MaterialNodeDef, input: MaterialInputDef): MaterialValueType => {
        const fallback = input.fallback;
        if (typeof fallback === 'string' || 'value' in fallback) return 'float';
        if ('builtin' in fallback) return BUILTIN_TYPES[fallback.builtin];
        const param = definition.params.find(candidate => candidate.key === fallback.param);
        return (param && PARAM_TYPES[param.kind]) ?? 'float';
    };

    const resolve = (node: MaterialGraphNode): MaterialValueType => {
        const done = resolved.get(node.id);
        if (done) return done;
        if (visiting.has(node.id)) return 'float';
        visiting.add(node.id);
        const definition = DEFINITIONS.get(node.type)!;
        let type: MaterialValueType;
        if (definition.autoType) {
            type = definition.autoType(staticParams(node, definition));
        } else {
            const types: MaterialValueType[] = [];
            for (const input of definition.inputs) {
                if (input.type !== 'auto') continue;
                const link = incoming.get(`${node.id}:${input.key}`);
                const source = link && nodes.get(link.fromNode);
                const port = source && DEFINITIONS.get(source.type)?.outputs.find(output => output.key === link!.fromOutput);
                types.push(source && port ? portType(source, port.type) : fallbackType(node, definition, input));
            }
            type = widest(types);
        }
        visiting.delete(node.id);
        resolved.set(node.id, type);
        return type;
    };

    for (const node of graph.nodes) resolve(node);
    return resolved;
};

/** The concrete type of a port of `node`, given the auto types (resolveAutoTypes). */
export const resolvedPortType = (type: MaterialPortType, nodeId: string, autoTypes: ReadonlyMap<string, MaterialValueType>): MaterialValueType =>
    type === 'auto' ? autoTypes.get(nodeId) ?? 'float' : type;

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

export interface MaterialUniformSpec {
    name: string;
    nodeId: string;
    param: string;
    kind: MaterialParamKind;
}

/** How each stage computes the builtins, matched by what graphMaterial.ts declares. */
export const STAGE_BUILTINS: Record<MaterialStage, Record<MaterialBuiltin, string>> = {
    fragment: {
        uv: 'vUv',
        worldPosition: 'vMgWorldPosition',
        localPosition: 'vMgLocalPosition',
        objectPosition: 'vMgObjectPosition',
        worldNormal: 'mgWorldNormal()',
        localNormal: 'vMgLocalNormal',
        viewDirection: 'normalize(cameraPosition - vMgWorldPosition)',
        cameraPosition: 'cameraPosition',
        cameraDistance: 'length(cameraPosition - vMgWorldPosition)',
        vertexColor: 'mgVertexColor()',
        time: 'uMaterialTime',
    },
    vertex: {
        uv: 'uv',
        worldPosition: 'mgVertexWorld',
        localPosition: 'mgVertexLocal',
        objectPosition: 'mgVertexOrigin',
        worldNormal: 'mgVertexWorldNormal',
        localNormal: 'MG_OBJECT_NORMAL',
        viewDirection: 'normalize(cameraPosition - mgVertexWorld)',
        cameraPosition: 'cameraPosition',
        cameraDistance: 'length(cameraPosition - mgVertexWorld)',
        vertexColor: 'mgVertexColorAttribute()',
        time: 'uMaterialTime',
    },
    shadow: {
        uv: 'vUv',
        worldPosition: 'vMgWorldPosition',
        localPosition: 'vMgLocalPosition',
        objectPosition: 'vMgObjectPosition',
        worldNormal: 'vec3(0.0, 1.0, 0.0)',
        localNormal: 'vec3(0.0, 1.0, 0.0)',
        viewDirection: 'vec3(0.0, 1.0, 0.0)',
        cameraPosition: 'cameraPosition',
        cameraDistance: 'length(cameraPosition - vMgWorldPosition)',
        vertexColor: 'vec3(1.0)',
        time: 'uMaterialTime',
    },
};

export interface CompiledMaterialGraph {
    stage: MaterialStage;
    /** GLSL statements, in order, computing everything the outputs need (at the start of main). */
    statements: string[];
    /** GLSL at the top level of the shader: helper functions and nodes' own functions. */
    globals: string[];
    /** Helper functions (materialGlsl.ts) the statements call. */
    helpers: string[];
    /** The expression for each Material Output input compiled, of the input's type. */
    outputs: Record<string, string>;
    /** Output inputs that are wired. */
    connected: Set<string>;
    uniforms: MaterialUniformSpec[];
    /** Builtins the statements read. */
    builtins: Set<MaterialBuiltin>;
    /** Changes only when the compiled part's shape changes (not its constants): the shader is rebuilt only then. */
    key: string;
    /** Nodes left out because they feed nothing the stage computes, or sit on a loop. */
    unused: string[];
    /** For each node of CompileOptions.previews, its first output as a colour (vec3). */
    previews: string[];
}

export interface CompileOptions {
    /** Which shader the GLSL is for (default fragment). */
    stage?: MaterialStage;
    /** Material Output inputs to compute (default: the stage's). */
    outputs?: readonly string[];
    /**
     * Nodes whose first output to compute as well (for the editor's node previews), wired to the
     * output or not. A tangent-space normal comes encoded like a normal map.
     */
    previews?: readonly string[];
}

const glslName = (id: string) => id.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40);

/** Compiles the part of a (normalised) graph a stage needs to GLSL for graphMaterial.ts. */
export const compileMaterialGraph = (graph: MaterialGraph, options: CompileOptions = {}): CompiledMaterialGraph => {
    const stage = options.stage ?? 'fragment';
    const wanted = options.outputs ?? STAGE_OUTPUTS[stage];
    const builtinTable = STAGE_BUILTINS[stage];
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const output = graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    if (!output) throw new Error('A material graph needs a Material Output node.');
    const incoming = new Map<string, MaterialGraphLink>();
    for (const link of graph.links) incoming.set(`${link.toNode}:${link.toInput}`, link);
    const autoTypes = resolveAutoTypes(graph);

    const statements: string[] = [];
    const globals: string[] = [];
    const helpers = new Set<string>();
    const uniforms: MaterialUniformSpec[] = [];
    const uniformNames = new Map<string, string>();
    const results = new Map<string, Record<string, string>>();
    const visiting = new Set<string>();
    const builtins = new Set<MaterialBuiltin>();
    const shape: string[] = [stage];
    let counter = 0;

    const contextFor = (node: MaterialGraphNode): NodeEmitContext => {
        const definition = DEFINITIONS.get(node.type)!;
        const autoType = autoTypes.get(node.id) ?? 'float';
        return {
            stage,
            auto: autoType,
            derivatives: stage === 'fragment',
            param: (key) => {
                const id = `${node.id}:${key}`;
                let name = uniformNames.get(id);
                if (!name) {
                    const param = definition.params.find(candidate => candidate.key === key);
                    if (!param || STATIC_PARAM_KINDS.has(param.kind)) throw new Error(`Node ${node.type} has no uniform param ${key}.`);
                    name = `mg_${glslName(node.id)}_${key}`;
                    uniformNames.set(id, name);
                    uniforms.push({ name, nodeId: node.id, param: key, kind: param.kind });
                }
                return name;
            },
            static: (key) => {
                const param = definition.params.find(candidate => candidate.key === key);
                if (!param || !STATIC_PARAM_KINDS.has(param.kind)) throw new Error(`Node ${node.type} has no static param ${key}.`);
                return readParam(param, node.params[key]);
            },
            local: (name) => `mg_${glslName(node.id)}_${name}`,
            builtin: (name) => {
                builtins.add(name);
                return builtinTable[name];
            },
            helper: (name) => {
                if (!hasHelper(name)) throw new Error(`No material GLSL helper ${name}.`);
                helpers.add(name);
            },
            global: (source) => { globals.push(source); },
            splat: (value) => (autoType === 'float' ? `float(${value})` : `${autoType}(${value})`),
        };
    };

    /** The expression for input `input` of `node`, converted to the input's type. */
    const inputValue = (node: MaterialGraphNode, input: MaterialInputDef): string => {
        const target = resolvedPortType(input.type, node.id, autoTypes);
        const link = incoming.get(`${node.id}:${input.key}`);
        if (link) {
            const source = nodes.get(link.fromNode);
            const sourceDefinition = source && DEFINITIONS.get(source.type);
            const port = sourceDefinition?.outputs.find(candidate => candidate.key === link.fromOutput);
            if (source && port) {
                const value = evaluate(source)?.[port.key];
                if (value !== undefined) {
                    shape.push(`${link.fromNode}.${link.fromOutput}>${node.id}.${input.key}`);
                    return convertValue(value, resolvedPortType(port.type, source.id, autoTypes), target);
                }
            }
        }
        const fallback = input.fallback;
        if (typeof fallback === 'string') return fallback;
        if ('value' in fallback) return convertValue(`${fallback.value.toFixed(6)}`, 'float', target);
        if ('builtin' in fallback) {
            builtins.add(fallback.builtin);
            return convertValue(builtinTable[fallback.builtin], BUILTIN_TYPES[fallback.builtin], target);
        }
        // A param's uniform, converted from its own type like a wired value.
        const param = DEFINITIONS.get(node.type)!.params.find(candidate => candidate.key === fallback.param);
        const type = param && PARAM_TYPES[param.kind];
        if (!param || !type) throw new Error(`Input ${input.key} of ${node.type} falls back to a param it cannot read.`);
        return convertValue(contextFor(node).param(param.key), type, target);
    };

    /** Emits `node` once (after what it reads) and returns its outputs; null on a loop. */
    const evaluate = (node: MaterialGraphNode): Record<string, string> | null => {
        const done = results.get(node.id);
        if (done) return done;
        if (visiting.has(node.id)) return null;
        visiting.add(node.id);
        const definition = DEFINITIONS.get(node.type)!;
        const inputs: Record<string, string> = {};
        for (const input of definition.inputs) inputs[input.key] = inputValue(node, input);
        const context = contextFor(node);
        const emitted = definition.emit(inputs, context);
        // Each output is stored in a local of its own, so a value read by several nodes is computed once.
        const outputs: Record<string, string> = {};
        statements.push(...(emitted.statements ?? []));
        for (const port of definition.outputs) {
            const expression = emitted.outputs[port.key];
            const type = resolvedPortType(port.type, node.id, autoTypes);
            const local = `mg_${glslName(node.id)}_out_${port.key}_${counter++}`;
            statements.push(`${type} ${local} = ${expression};`);
            outputs[port.key] = local;
        }
        visiting.delete(node.id);
        results.set(node.id, outputs);
        shape.push(`${node.id}:${node.type}:${autoTypes.get(node.id)}:${JSON.stringify(staticParams(node, definition))}`);
        return outputs;
    };

    const outputDefinition = DEFINITIONS.get(OUTPUT_NODE_TYPE)!;
    const outputs: Record<string, string> = {};
    const connected = new Set<string>();
    for (const input of outputDefinition.inputs) {
        if (incoming.has(`${output.id}:${input.key}`)) connected.add(input.key);
        if (!wanted.includes(input.key)) continue;
        outputs[input.key] = inputValue(output, input);
    }
    shape.push(`out:${JSON.stringify(staticParams(output, outputDefinition))}`, `#${[...connected].sort().join(',')}`);
    const unused = graph.nodes.filter(node => node.type !== OUTPUT_NODE_TYPE && !results.has(node.id)).map(node => node.id);
    const previews = (options.previews ?? []).map((nodeId) => {
        const node = nodes.get(nodeId);
        const definition = node && DEFINITIONS.get(node.type);
        const port = definition?.outputs[0];
        const value = node && port ? evaluate(node)?.[port.key] : undefined;
        if (!node || !port || value === undefined) return 'vec3(0.0)';
        const color = convertValue(value, resolvedPortType(port.type, node.id, autoTypes), 'vec3');
        return definition!.preview === 'normal' ? `(${color} * 0.5 + 0.5)` : color;
    });
    shape.push(`previews:${(options.previews ?? []).join(',')}`);
    return { stage, statements, globals, helpers: [...helpers], outputs, connected, uniforms, builtins, key: shape.join('|'), unused, previews };
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type MaterialBlendMode = 'opaque' | 'masked' | 'translucent' | 'additive';

export interface MaterialGraphSettings {
    blendMode: MaterialBlendMode;
    /** Opacity below which a masked material's pixels (and shadow) are cut away. */
    alphaClip: number;
    twoSided: boolean;
    unlit: boolean;
}

/** How the graph's Material Output says the material blends, clips, faces and lights. */
export const materialGraphSettings = (graph: MaterialGraph): MaterialGraphSettings => {
    const output = graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    const params = (key: string) => {
        const param = DEFINITIONS.get(OUTPUT_NODE_TYPE)!.params.find(candidate => candidate.key === key)!;
        return readParam(param, output?.params[key]);
    };
    return {
        blendMode: params('blendMode') as MaterialBlendMode,
        alphaClip: params('alphaClip') as number,
        twoSided: params('twoSided') === true,
        unlit: params('shading') === 'unlit',
    };
};
