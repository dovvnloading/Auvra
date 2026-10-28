/**
 * MATERIAL GRAPHS
 *
 * A material asset is a graph of nodes wired output to input, ending in one Material Output node
 * whose inputs (base colour, roughness, metalness, normal, emissive, opacity, occlusion) shade the
 * surface. compileMaterialGraph turns it into GLSL that runtime/materials/graphMaterial.ts splices
 * into three's standard material, so lighting, shadows, fog, skinning and instancing stay three's.
 *
 * Values are float, vec2, vec3 or vec4. An input takes any of them: a float fills every component,
 * a wider vector is cut down to its first components, a narrower one is padded with zeros (and a
 * colour becoming four components gets an alpha of 1). Constants a node is set to (a colour, a number, a texture) become uniforms, so
 * changing them does not rebuild the shader; only changing the graph's shape does.
 */

export type MaterialValueType = 'float' | 'vec2' | 'vec3' | 'vec4';

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

export interface MaterialGraph {
    nodes: MaterialGraphNode[];
    links: MaterialGraphLink[];
}

export type MaterialParamKind = 'float' | 'color' | 'vec2' | 'vec3' | 'texture';

export interface MaterialParamDef {
    key: string;
    label: string;
    kind: MaterialParamKind;
    default: number | number[] | string;
    min?: number;
    max?: number;
    step?: number;
}

export interface MaterialPortDef {
    key: string;
    label: string;
    type: MaterialValueType;
}

export interface MaterialInputDef extends MaterialPortDef {
    /** The value an unconnected input takes: GLSL of the input's type, or one of the node's params. */
    fallback: string | { param: string };
}

/** What a node definition sees while it is compiled. */
export interface NodeEmitContext {
    /** The uniform holding this node's param `key`. */
    param(key: string): string;
    /** A local GLSL name unique to this node, for statements that need one. */
    local(name: string): string;
}

export interface MaterialNodeDef {
    type: string;
    label: string;
    category: 'Output' | 'Input' | 'Texture' | 'Math' | 'Vector' | 'UV' | 'Surface';
    description: string;
    inputs: MaterialInputDef[];
    outputs: MaterialPortDef[];
    params: MaterialParamDef[];
    /**
     * GLSL statements computing the outputs, given each input as an expression of its declared
     * type; returns each output as an expression (of its declared type) the statements made available.
     */
    emit(inputs: Record<string, string>, context: NodeEmitContext): { statements?: string[]; outputs: Record<string, string> };
}

export const OUTPUT_NODE_TYPE = 'output';

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

const componentCount: Record<MaterialValueType, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

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

const constant = (value: string) => value;
const fromParam = (key: string) => ({ param: key });

/** The GLSL type a param's uniform has. */
const PARAM_TYPES: Record<Exclude<MaterialParamKind, 'texture'>, MaterialValueType> = { float: 'float', color: 'vec3', vec2: 'vec2', vec3: 'vec3' };

/** A node applying a GLSL function component-wise to vec4s (inputs widened, the result the widest input's type). */
const binary = (type: string, label: string, description: string, glsl: (a: string, b: string) => string, defaults: [number, number] = [0, 0]): MaterialNodeDef => ({
    type,
    label,
    category: 'Math',
    description,
    inputs: [
        { key: 'a', label: 'A', type: 'vec4', fallback: fromParam('a') },
        { key: 'b', label: 'B', type: 'vec4', fallback: fromParam('b') },
    ],
    outputs: [{ key: 'out', label: 'Result', type: 'vec4' }],
    params: [
        { key: 'a', label: 'A', kind: 'float', default: defaults[0] },
        { key: 'b', label: 'B', kind: 'float', default: defaults[1] },
    ],
    emit: (inputs) => ({ outputs: { out: glsl(inputs.a, inputs.b) } }),
});

const unary = (type: string, label: string, description: string, glsl: (a: string) => string): MaterialNodeDef => ({
    type,
    label,
    category: 'Math',
    description,
    inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: constant('vec4(0.0)') }],
    outputs: [{ key: 'out', label: 'Result', type: 'vec4' }],
    params: [],
    emit: (inputs) => ({ outputs: { out: glsl(inputs.in) } }),
});

export const MATERIAL_NODE_DEFINITIONS: MaterialNodeDef[] = [
    {
        type: OUTPUT_NODE_TYPE,
        label: 'Material Output',
        category: 'Output',
        description: 'How the surface shades. Unconnected inputs take the values set here.',
        inputs: [
            { key: 'baseColor', label: 'Base Color', type: 'vec3', fallback: fromParam('baseColor') },
            { key: 'opacity', label: 'Opacity', type: 'float', fallback: fromParam('opacity') },
            { key: 'metalness', label: 'Metalness', type: 'float', fallback: fromParam('metalness') },
            { key: 'roughness', label: 'Roughness', type: 'float', fallback: fromParam('roughness') },
            { key: 'normal', label: 'Normal (tangent space)', type: 'vec3', fallback: constant('vec3(0.0, 0.0, 1.0)') },
            { key: 'emissive', label: 'Emissive', type: 'vec3', fallback: fromParam('emissive') },
            { key: 'occlusion', label: 'Ambient Occlusion', type: 'float', fallback: constant('1.0') },
        ],
        outputs: [],
        params: [
            { key: 'baseColor', label: 'Base Color', kind: 'color', default: [0.8, 0.8, 0.8] },
            { key: 'opacity', label: 'Opacity', kind: 'float', default: 1, min: 0, max: 1, step: 0.01 },
            { key: 'metalness', label: 'Metalness', kind: 'float', default: 0, min: 0, max: 1, step: 0.01 },
            { key: 'roughness', label: 'Roughness', kind: 'float', default: 0.6, min: 0, max: 1, step: 0.01 },
            { key: 'emissive', label: 'Emissive', kind: 'color', default: [0, 0, 0] },
        ],
        emit: () => ({ outputs: {} }),
    },
    {
        type: 'float',
        label: 'Number',
        category: 'Input',
        description: 'A constant number.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Value', type: 'float' }],
        params: [{ key: 'value', label: 'Value', kind: 'float', default: 1 }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'color',
        label: 'Color',
        category: 'Input',
        description: 'A constant colour.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [{ key: 'value', label: 'Color', kind: 'color', default: [1, 1, 1] }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'vector',
        label: 'Vector',
        category: 'Input',
        description: 'A constant three-component vector.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Vector', type: 'vec3' }],
        params: [{ key: 'value', label: 'Value', kind: 'vec3', default: [0, 0, 0] }],
        emit: (_inputs, context) => ({ outputs: { out: context.param('value') } }),
    },
    {
        type: 'time',
        label: 'Time',
        category: 'Input',
        description: 'Seconds since play started, for animated materials.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Seconds', type: 'float' }],
        params: [],
        emit: () => ({ outputs: { out: 'uMaterialTime' } }),
    },
    {
        type: 'uv',
        label: 'UV',
        category: 'UV',
        description: "The mesh's texture coordinates.",
        inputs: [],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [],
        emit: () => ({ outputs: { out: 'vUv' } }),
    },
    {
        type: 'tilingOffset',
        label: 'Tiling and Offset',
        category: 'UV',
        description: 'Repeats and shifts texture coordinates.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: constant('vUv') }],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [
            { key: 'tiling', label: 'Tiling', kind: 'vec2', default: [1, 1] },
            { key: 'offset', label: 'Offset', kind: 'vec2', default: [0, 0] },
        ],
        emit: (inputs, context) => ({ outputs: { out: `(${inputs.uv} * ${context.param('tiling')} + ${context.param('offset')})` } }),
    },
    {
        type: 'panner',
        label: 'Panner',
        category: 'UV',
        description: 'Scrolls texture coordinates over time (flowing water, conveyor belts).',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: constant('vUv') }],
        outputs: [{ key: 'out', label: 'UV', type: 'vec2' }],
        params: [{ key: 'speed', label: 'Speed (per second)', kind: 'vec2', default: [0.1, 0] }],
        emit: (inputs, context) => ({ outputs: { out: `(${inputs.uv} + ${context.param('speed')} * uMaterialTime)` } }),
    },
    {
        type: 'texture',
        label: 'Texture Sample',
        category: 'Texture',
        description: 'Reads a texture at UV. Colour textures read in linear light.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: constant('vUv') }],
        outputs: [
            { key: 'rgb', label: 'RGB', type: 'vec3' },
            { key: 'a', label: 'A', type: 'float' },
            { key: 'r', label: 'R', type: 'float' },
            { key: 'g', label: 'G', type: 'float' },
            { key: 'b', label: 'B', type: 'float' },
        ],
        params: [{ key: 'texture', label: 'Texture', kind: 'texture', default: '' }],
        emit: (inputs, context) => {
            const sample = context.local('sample');
            return {
                statements: [`vec4 ${sample} = texture2D(${context.param('texture')}, ${inputs.uv});`],
                outputs: { rgb: `${sample}.rgb`, a: `${sample}.a`, r: `${sample}.r`, g: `${sample}.g`, b: `${sample}.b` },
            };
        },
    },
    {
        type: 'normalMap',
        label: 'Normal Map',
        category: 'Texture',
        description: 'Reads a tangent-space normal map at UV, with a strength, for the Normal input.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: constant('vUv') }],
        outputs: [{ key: 'out', label: 'Normal', type: 'vec3' }],
        params: [
            { key: 'texture', label: 'Texture', kind: 'texture', default: '' },
            { key: 'strength', label: 'Strength', kind: 'float', default: 1, min: 0, max: 4, step: 0.05 },
        ],
        emit: (inputs, context) => {
            const normal = context.local('normal');
            return {
                statements: [
                    `vec3 ${normal} = texture2D(${context.param('texture')}, ${inputs.uv}).xyz * 2.0 - 1.0;`,
                    `${normal}.xy *= ${context.param('strength')};`,
                ],
                outputs: { out: `normalize(${normal})` },
            };
        },
    },
    {
        type: 'fresnel',
        label: 'Fresnel',
        category: 'Surface',
        description: 'Brighter where the surface turns away from the camera: rims, glass edges, force fields.',
        inputs: [],
        outputs: [{ key: 'out', label: 'Fresnel', type: 'float' }],
        params: [{ key: 'power', label: 'Power', kind: 'float', default: 3, min: 0.1, max: 16, step: 0.1 }],
        emit: (_inputs, context) => ({ outputs: { out: `pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), ${context.param('power')})` } }),
    },
    {
        type: 'worldPosition',
        label: 'World Position',
        category: 'Surface',
        description: "The surface point's position in the world.",
        inputs: [],
        outputs: [{ key: 'out', label: 'Position', type: 'vec3' }],
        params: [],
        emit: () => ({ outputs: { out: 'vMaterialWorldPosition' } }),
    },
    {
        type: 'vertexColor',
        label: 'Vertex Color',
        category: 'Surface',
        description: "The mesh's vertex colours (white where it has none).",
        inputs: [],
        outputs: [{ key: 'out', label: 'Color', type: 'vec3' }],
        params: [],
        emit: () => ({ outputs: { out: 'materialVertexColor()' } }),
    },
    {
        type: 'noise',
        label: 'Noise',
        category: 'Math',
        description: 'Smooth value noise at UV times scale, from 0 to 1.',
        inputs: [{ key: 'uv', label: 'UV', type: 'vec2', fallback: constant('vUv') }],
        outputs: [{ key: 'out', label: 'Noise', type: 'float' }],
        params: [{ key: 'scale', label: 'Scale', kind: 'float', default: 8, min: 0.01, max: 1000, step: 0.1 }],
        emit: (inputs, context) => ({ outputs: { out: `materialNoise(${inputs.uv} * ${context.param('scale')})` } }),
    },
    binary('add', 'Add', 'A + B.', (a, b) => `(${a} + ${b})`),
    binary('subtract', 'Subtract', 'A - B.', (a, b) => `(${a} - ${b})`),
    binary('multiply', 'Multiply', 'A × B, component by component.', (a, b) => `(${a} * ${b})`, [1, 1]),
    binary('divide', 'Divide', 'A ÷ B, component by component.', (a, b) => `(${a} / ${b})`, [1, 1]),
    binary('min', 'Min', 'The smaller of A and B.', (a, b) => `min(${a}, ${b})`),
    binary('max', 'Max', 'The larger of A and B.', (a, b) => `max(${a}, ${b})`),
    binary('power', 'Power', 'A raised to B.', (a, b) => `pow(max(${a}, vec4(0.0)), ${b})`, [1, 2]),
    binary('step', 'Step', '1 where B is at least A, else 0.', (a, b) => `step(${a}, ${b})`, [0.5, 0]),
    {
        type: 'lerp',
        label: 'Lerp',
        category: 'Math',
        description: 'Blends from A to B by T (0 gives A, 1 gives B).',
        inputs: [
            { key: 'a', label: 'A', type: 'vec4', fallback: fromParam('a') },
            { key: 'b', label: 'B', type: 'vec4', fallback: fromParam('b') },
            { key: 't', label: 'T', type: 'vec4', fallback: fromParam('t') },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'vec4' }],
        params: [
            { key: 'a', label: 'A', kind: 'float', default: 0 },
            { key: 'b', label: 'B', kind: 'float', default: 1 },
            { key: 't', label: 'T', kind: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
        ],
        emit: (inputs) => ({ outputs: { out: `mix(${inputs.a}, ${inputs.b}, ${inputs.t})` } }),
    },
    {
        type: 'clamp',
        label: 'Clamp',
        category: 'Math',
        description: 'Keeps the value between Min and Max.',
        inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: constant('vec4(0.0)') }],
        outputs: [{ key: 'out', label: 'Result', type: 'vec4' }],
        params: [
            { key: 'min', label: 'Min', kind: 'float', default: 0 },
            { key: 'max', label: 'Max', kind: 'float', default: 1 },
        ],
        emit: (inputs, context) => ({ outputs: { out: `clamp(${inputs.in}, vec4(${context.param('min')}), vec4(${context.param('max')}))` } }),
    },
    {
        type: 'smoothstep',
        label: 'Smoothstep',
        category: 'Math',
        description: 'A smooth 0 to 1 ramp as the value goes from Edge 0 to Edge 1.',
        inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: constant('vec4(0.0)') }],
        outputs: [{ key: 'out', label: 'Result', type: 'vec4' }],
        params: [
            { key: 'edge0', label: 'Edge 0', kind: 'float', default: 0 },
            { key: 'edge1', label: 'Edge 1', kind: 'float', default: 1 },
        ],
        emit: (inputs, context) => ({ outputs: { out: `smoothstep(vec4(${context.param('edge0')}), vec4(${context.param('edge1')}), ${inputs.in})` } }),
    },
    unary('oneMinus', 'One Minus', '1 - In.', (a) => `(vec4(1.0) - ${a})`),
    unary('abs', 'Abs', 'The value without its sign.', (a) => `abs(${a})`),
    unary('saturate', 'Saturate', 'Clamps between 0 and 1.', (a) => `clamp(${a}, vec4(0.0), vec4(1.0))`),
    unary('sine', 'Sine', 'sin(In), In in radians.', (a) => `sin(${a})`),
    unary('cosine', 'Cosine', 'cos(In), In in radians.', (a) => `cos(${a})`),
    unary('fract', 'Fraction', 'The part after the decimal point.', (a) => `fract(${a})`),
    unary('floor', 'Floor', 'Rounds down.', (a) => `floor(${a})`),
    {
        type: 'split',
        label: 'Split',
        category: 'Vector',
        description: 'The components of a vector.',
        inputs: [{ key: 'in', label: 'In', type: 'vec4', fallback: constant('vec4(0.0)') }],
        outputs: [
            { key: 'x', label: 'X / R', type: 'float' },
            { key: 'y', label: 'Y / G', type: 'float' },
            { key: 'z', label: 'Z / B', type: 'float' },
            { key: 'w', label: 'W / A', type: 'float' },
        ],
        params: [],
        emit: (inputs, context) => {
            const value = context.local('value');
            return { statements: [`vec4 ${value} = ${inputs.in};`], outputs: { x: `${value}.x`, y: `${value}.y`, z: `${value}.z`, w: `${value}.w` } };
        },
    },
    {
        type: 'combine',
        label: 'Combine',
        category: 'Vector',
        description: 'A vector from its components.',
        inputs: [
            { key: 'x', label: 'X / R', type: 'float', fallback: constant('0.0') },
            { key: 'y', label: 'Y / G', type: 'float', fallback: constant('0.0') },
            { key: 'z', label: 'Z / B', type: 'float', fallback: constant('0.0') },
            { key: 'w', label: 'W / A', type: 'float', fallback: constant('1.0') },
        ],
        outputs: [{ key: 'out', label: 'Vector', type: 'vec4' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `vec4(${inputs.x}, ${inputs.y}, ${inputs.z}, ${inputs.w})` } }),
    },
    {
        type: 'dot',
        label: 'Dot',
        category: 'Vector',
        description: 'The dot product of A and B.',
        inputs: [
            { key: 'a', label: 'A', type: 'vec3', fallback: constant('vec3(0.0)') },
            { key: 'b', label: 'B', type: 'vec3', fallback: constant('vec3(0.0)') },
        ],
        outputs: [{ key: 'out', label: 'Result', type: 'float' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `dot(${inputs.a}, ${inputs.b})` } }),
    },
    {
        type: 'normalize',
        label: 'Normalize',
        category: 'Vector',
        description: 'The vector at length 1.',
        inputs: [{ key: 'in', label: 'In', type: 'vec3', fallback: constant('vec3(0.0, 0.0, 1.0)') }],
        outputs: [{ key: 'out', label: 'Result', type: 'vec3' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `normalize(${inputs.in})` } }),
    },
    {
        type: 'length',
        label: 'Length',
        category: 'Vector',
        description: "The vector's length.",
        inputs: [{ key: 'in', label: 'In', type: 'vec3', fallback: constant('vec3(0.0)') }],
        outputs: [{ key: 'out', label: 'Length', type: 'float' }],
        params: [],
        emit: (inputs) => ({ outputs: { out: `length(${inputs.in})` } }),
    },
];

const DEFINITIONS = new Map(MATERIAL_NODE_DEFINITIONS.map(definition => [definition.type, definition]));

export const getMaterialNodeDefinition = (type: string): MaterialNodeDef | undefined => DEFINITIONS.get(type);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Node types whose value can be a material parameter, and the param holding it. */
export const PARAMETER_NODE_PARAMS: Readonly<Record<string, string>> = { float: 'value', color: 'value', vector: 'value' };
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

/** Every param of a node type at its default. */
export const defaultParams = (type: string): Record<string, unknown> => {
    const definition = DEFINITIONS.get(type);
    return Object.fromEntries((definition?.params ?? []).map(param => [param.key, structuredClone(param.default)]));
};

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A param value of the right shape, or the param's default. */
export const readParam = (param: MaterialParamDef, value: unknown): number | number[] | string => {
    if (param.kind === 'texture') return typeof value === 'string' ? value.slice(0, 128) : '';
    if (param.kind === 'float') {
        if (!finiteNumber(value)) return param.default as number;
        return Math.min(param.max ?? Infinity, Math.max(param.min ?? -Infinity, value));
    }
    const size = param.kind === 'vec2' ? 2 : 3;
    if (Array.isArray(value) && value.length === size && value.every(finiteNumber)) return value.map(Number);
    return param.default as number[];
};

/**
 * A stored graph made safe to compile: nodes of known types with valid params, links between
 * existing ports, at most one link per input, and exactly one Material Output.
 */
export const normalizeMaterialGraph = (value: unknown): MaterialGraph => {
    const source = (value && typeof value === 'object' ? value : {}) as { nodes?: unknown; links?: unknown };
    const nodes: MaterialGraphNode[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(source.nodes) ? source.nodes : []) {
        if (!raw || typeof raw !== 'object') continue;
        const node = raw as Partial<MaterialGraphNode>;
        const definition = typeof node.type === 'string' ? DEFINITIONS.get(node.type) : undefined;
        if (!definition || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue;
        if (definition.type === OUTPUT_NODE_TYPE && nodes.some(other => other.type === OUTPUT_NODE_TYPE)) continue;
        seen.add(node.id);
        const params = (node.params && typeof node.params === 'object' ? node.params : {}) as Record<string, unknown>;
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
    for (const raw of Array.isArray(source.links) ? source.links : []) {
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
    return { nodes, links };
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
// Compiling
// ---------------------------------------------------------------------------

export interface MaterialUniformSpec {
    name: string;
    nodeId: string;
    param: string;
    kind: MaterialParamKind;
}

export interface CompiledMaterialGraph {
    /** GLSL statements, in order, computing everything the output needs (fragment shader, start of main). */
    statements: string[];
    /** The expression for each Material Output input, of the input's type. */
    outputs: Record<string, string>;
    /** Output inputs that are wired, or whose param differs from what the standard material does on its own. */
    connected: Set<string>;
    uniforms: MaterialUniformSpec[];
    /** Changes only when the graph's shape changes (not its constants): the shader is rebuilt only then. */
    key: string;
    /** Nodes left out because they feed nothing that reaches the output, or sit on a loop. */
    unused: string[];
}

const glslName = (id: string) => id.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40);

/** Compiles a (normalised) graph to GLSL for graphMaterial.ts. */
export const compileMaterialGraph = (graph: MaterialGraph): CompiledMaterialGraph => {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const output = graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    if (!output) throw new Error('A material graph needs a Material Output node.');
    const incoming = new Map<string, MaterialGraphLink>();
    for (const link of graph.links) incoming.set(`${link.toNode}:${link.toInput}`, link);

    const statements: string[] = [];
    const uniforms: MaterialUniformSpec[] = [];
    const uniformNames = new Map<string, string>();
    const results = new Map<string, Record<string, string>>();
    const visiting = new Set<string>();
    const shape: string[] = [];
    let counter = 0;

    const contextFor = (node: MaterialGraphNode): NodeEmitContext => ({
        param: (key) => {
            const id = `${node.id}:${key}`;
            let name = uniformNames.get(id);
            if (!name) {
                const definition = DEFINITIONS.get(node.type)!;
                const param = definition.params.find(candidate => candidate.key === key);
                if (!param) throw new Error(`Node ${node.type} has no param ${key}.`);
                name = `mg_${glslName(node.id)}_${key}`;
                uniformNames.set(id, name);
                uniforms.push({ name, nodeId: node.id, param: key, kind: param.kind });
            }
            return name;
        },
        local: (name) => `mg_${glslName(node.id)}_${name}`,
    });

    /** The expression for input `input` of `node`, converted to `type`. */
    const inputValue = (node: MaterialGraphNode, input: MaterialInputDef): string => {
        const link = incoming.get(`${node.id}:${input.key}`);
        if (link) {
            const source = nodes.get(link.fromNode);
            const sourceDefinition = source && DEFINITIONS.get(source.type);
            const port = sourceDefinition?.outputs.find(candidate => candidate.key === link.fromOutput);
            if (source && port) {
                const value = evaluate(source)?.[port.key];
                if (value !== undefined) {
                    shape.push(`${link.fromNode}.${link.fromOutput}>${node.id}.${input.key}`);
                    return convertValue(value, port.type, input.type);
                }
            }
        }
        if (typeof input.fallback === 'string') return input.fallback;
        // A param's uniform, converted from its own type like a wired value.
        const definition = DEFINITIONS.get(node.type)!;
        const param = definition.params.find(candidate => candidate.key === (input.fallback as { param: string }).param);
        if (!param || param.kind === 'texture') throw new Error(`Input ${input.key} of ${node.type} falls back to a param it does not have.`);
        return convertValue(contextFor(node).param(param.key), PARAM_TYPES[param.kind], input.type);
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
        const emitted = definition.emit(inputs, contextFor(node));
        // Each output is stored in a local of its own, so a value read by several nodes is computed once.
        const outputs: Record<string, string> = {};
        statements.push(...(emitted.statements ?? []));
        for (const port of definition.outputs) {
            const expression = emitted.outputs[port.key];
            const local = `mg_${glslName(node.id)}_out_${port.key}_${counter++}`;
            statements.push(`${port.type} ${local} = ${expression};`);
            outputs[port.key] = local;
        }
        visiting.delete(node.id);
        results.set(node.id, outputs);
        shape.push(`${node.id}:${node.type}`);
        return outputs;
    };

    const outputDefinition = DEFINITIONS.get(OUTPUT_NODE_TYPE)!;
    const outputs: Record<string, string> = {};
    const connected = new Set<string>();
    for (const input of outputDefinition.inputs) {
        const wired = incoming.has(`${output.id}:${input.key}`);
        outputs[input.key] = inputValue(output, input);
        if (wired) connected.add(input.key);
    }
    const unused = graph.nodes.filter(node => node.type !== OUTPUT_NODE_TYPE && !results.has(node.id)).map(node => node.id);
    return { statements, outputs, connected, uniforms, key: shape.join('|') + `#${[...connected].sort().join(',')}`, unused };
};
