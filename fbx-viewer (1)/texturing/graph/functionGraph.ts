import { floatBits, hash1, hashU } from './scatter';
import type { TexGraphComment } from './types';

/**
 * FUNCTION GRAPHS
 *
 * Small graphs of values (numbers and vectors) that a Pixel processor works out for every pixel and a
 * Value processor works out once. They compile in two steps: the graph becomes a list of typed steps
 * that name no shading language (the steps below), then the steps become GLSL (glslFunction). A WGSL
 * writer would read the same steps; nothing before it knows the language. The same steps also run on
 * the CPU (runFunction), which is how they are checked.
 *
 * Any node's value can be made the result instead of the Result node's (a target), which is how
 * every step in between is previewed.
 */

// ---- values ----

export type FnType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool';
/** A pin's type: 'auto' takes whatever is wired in (and an output, what its inputs make). */
export type FnPinType = FnType | 'auto';
/** Worked out for every pixel (a Pixel processor) or once (a Value processor). */
export type FunctionUse = 'pixel' | 'value';

export const FN_TYPES: readonly FnType[] = ['float', 'vec2', 'vec3', 'vec4', 'int', 'bool'];
export const FN_TYPE_LABELS: Record<FnType, string> = {
    float: 'Number', vec2: 'Two numbers', vec3: 'Three numbers', vec4: 'Four numbers (a colour)', int: 'Whole number', bool: 'Yes or no',
};
/** How many numbers a value of the type holds. */
export const fnSize = (type: FnType): number => (type === 'vec2' ? 2 : type === 'vec3' ? 3 : type === 'vec4' ? 4 : 1);
const VECTORS = ['float', 'vec2', 'vec3', 'vec4'] as const;
const vectorOf = (size: number): FnType => VECTORS[Math.max(1, Math.min(4, size)) - 1];
const isVector = (type: FnType): boolean => fnSize(type) > 1;
const SIZE_WORDS = ['', 'one-number', 'two-number', 'three-number', 'four-number'];

// ---- the stored graph ----

export interface FnNode {
    id: string;
    type: string;
    x: number;
    y: number;
    params: Record<string, unknown>;
    name?: string;
    color?: string;
    collapsed?: boolean;
}

export interface FnLink {
    from: string;
    fromOutput: string;
    to: string;
    toInput: string;
}

export interface FunctionGraph {
    nodes: FnNode[];
    links: FnLink[];
    comments?: TexGraphComment[];
}

/** A setting a processor has under a name of its own; function graphs read it with a Setting node. */
export interface NamedSetting {
    key: string;
    label: string;
    kind: 'float' | 'int' | 'bool' | 'color' | 'vec2';
    default: number | boolean | number[];
    min?: number;
    max?: number;
}

export const NAMED_SETTING_KINDS: ReadonlyArray<{ value: NamedSetting['kind']; label: string }> = [
    { value: 'float', label: 'Number' }, { value: 'int', label: 'Whole number' }, { value: 'bool', label: 'Yes or no' },
    { value: 'color', label: 'Colour' }, { value: 'vec2', label: 'Two numbers' },
];

/** The function value type a named setting gives. */
export const settingType = (kind: NamedSetting['kind']): FnType => (kind === 'color' ? 'vec4' : kind === 'vec2' ? 'vec2' : kind === 'int' ? 'int' : kind === 'bool' ? 'bool' : 'float');

// ---- the nodes ----

export type FnCategory = 'Inputs' | 'Values' | 'Maths' | 'Trigonometry' | 'Vectors' | 'Logic' | 'Random' | 'Result';
export const FN_CATEGORY_ORDER: readonly FnCategory[] = ['Inputs', 'Values', 'Maths', 'Trigonometry', 'Vectors', 'Logic', 'Random', 'Result'];

export interface FnPortDef {
    key: string;
    label: string;
    type: FnPinType;
    /** What an unwired input reads: this number (editable on the node), or the pixel's position. */
    fallback?: number | 'uv';
}

export interface FnParamDef {
    key: string;
    label: string;
    /** 'setting': one of the processor's named settings; 'picture': one of its inputs. */
    kind: 'float' | 'vec2' | 'vec3' | 'color' | 'int' | 'bool' | 'select' | 'text' | 'setting' | 'picture';
    default: unknown;
    options?: ReadonlyArray<{ value: string; label: string }>;
    min?: number;
    max?: number;
    step?: number;
    hint?: string;
}

export interface FnNodeDef {
    type: string;
    label: string;
    category: FnCategory;
    description: string;
    keywords?: readonly string[];
    inputs: readonly FnPortDef[];
    outputs: readonly FnPortDef[];
    params: readonly FnParamDef[];
    /** Means something only for each pixel (in a Pixel processor's function). */
    pixelOnly?: boolean;
    /** Its outputs' values from its inputs' values (and settings), as steps. Throws FnError when they do not fit. */
    build(b: IrBuilder, args: Readonly<Record<string, IrValue>>, params: Readonly<Record<string, unknown>>): Record<string, IrValue>;
}

export const FN_RESULT_TYPE = 'fnResult';
export const FN_SETTING_TYPE = 'fnSetting';
export const FN_SAMPLE_TYPE = 'fnSample';
export const FN_REROUTE_TYPE = 'fnReroute';

/** The settings key that holds an unwired input's number. */
export const fallbackKey = (inputKey: string): string => `in_${inputKey}`;

// ---- the steps ----

export type IrOp =
    | 'const' | 'uv' | 'pixel' | 'size' | 'seed' | 'iteration' | 'iterations' | 'world' | 'setting' | 'sample' | 'sampleGray'
    | 'construct' | 'swizzle' | 'toFloat' | 'toInt' | 'toBool'
    | 'neg' | 'abs' | 'floor' | 'ceil' | 'fract' | 'round' | 'sqrt' | 'exp' | 'log' | 'sign' | 'saturate'
    | 'sin' | 'cos' | 'tan' | 'asin' | 'acos' | 'normalize' | 'length' | 'not'
    | 'add' | 'sub' | 'mul' | 'div' | 'mod' | 'pow' | 'min' | 'max' | 'atan2' | 'step' | 'dot' | 'distance' | 'cross'
    | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne' | 'and' | 'or'
    | 'mix' | 'clamp' | 'smoothstep' | 'select' | 'random' | 'noise';

/** One step: its value's type, what it does, the steps it reads, and its own data (numbers, a name or a mask). */
export interface IrStep {
    id: number;
    type: FnType;
    op: IrOp;
    args: number[];
    data?: string | number[];
}

export interface IrValue { id: number; type: FnType }

export interface FunctionIr {
    use: FunctionUse;
    /** Only the steps the result needs, in order. */
    steps: IrStep[];
    result: IrValue;
    /** The named settings and the pictures it reads. */
    settings: string[];
    pictures: string[];
}

/** A function node whose inputs do not fit what it does, in words. */
export class FnError extends Error {
    constructor(message: string) { super(message); this.name = 'FnError'; }
}

/** Builds steps: each value once, constants shared. */
export class IrBuilder {
    readonly steps: IrStep[] = [];
    readonly settings = new Set<string>();
    readonly pictures = new Set<string>();
    private readonly constants = new Map<string, IrValue>();

    constructor(
        readonly use: FunctionUse,
        readonly settingTypes: ReadonlyMap<string, FnType>,
        readonly pictureKeys: readonly string[],
    ) {}

    add(type: FnType, op: IrOp, args: readonly IrValue[] = [], data?: string | number[]): IrValue {
        const id = this.steps.length;
        this.steps.push({ id, type, op, args: args.map((arg) => arg.id), ...(data !== undefined ? { data } : {}) });
        return { id, type };
    }

    constant(type: FnType, values: readonly number[]): IrValue {
        const size = fnSize(type);
        const numbers = Array.from({ length: size }, (_, index) => {
            const value = Number(values[Math.min(index, values.length - 1)] ?? 0);
            const finite = Number.isFinite(value) ? value : 0;
            return type === 'int' ? Math.trunc(finite) : type === 'bool' ? (finite ? 1 : 0) : finite;
        });
        const key = `${type}:${numbers.join(',')}`;
        let found = this.constants.get(key);
        if (!found) this.constants.set(key, found = this.add(type, 'const', [], numbers));
        return found;
    }

    /**
     * `value` as `type`: whole numbers and yes-or-no become numbers, a number fills every place of a
     * vector. `loose` also cuts a vector short or pads it (with 0, alpha 1), as the result does.
     */
    cast(value: IrValue, type: FnType, loose = false): IrValue {
        if (value.type === type) return value;
        const from = value.type;
        if (type === 'bool') {
            if (isVector(from)) throw new FnError(`A ${SIZE_WORDS[fnSize(from)]} value cannot be a yes or no.`);
            return this.add('bool', 'toBool', [value]);
        }
        if (type === 'int') {
            if (isVector(from)) throw new FnError(`A ${SIZE_WORDS[fnSize(from)]} value cannot be a whole number.`);
            return this.add('int', 'toInt', [value]);
        }
        const scalar = from === 'int' || from === 'bool' ? this.add('float', 'toFloat', [value]) : value;
        if (type === 'float') {
            if (isVector(scalar.type)) {
                if (!loose) throw new FnError(`A ${SIZE_WORDS[fnSize(scalar.type)]} value cannot be one number: take one of its parts with Split.`);
                return this.add('float', 'swizzle', [scalar], 'x');
            }
            return scalar;
        }
        // To a vector.
        if (scalar.type === 'float') return this.add(type, 'construct', [scalar]);
        const have = fnSize(scalar.type);
        const want = fnSize(type);
        if (!loose) throw new FnError(`It cannot mix ${SIZE_WORDS[have]} and ${SIZE_WORDS[want]} values: split or join them so they match.`);
        if (have > want) return this.add(type, 'swizzle', [scalar], 'xyzw'.slice(0, want));
        const pad: IrValue[] = [scalar];
        for (let index = have; index < want; index++) pad.push(this.constant('float', [index === 3 ? 1 : 0]));
        return this.add(type, 'construct', pad);
    }

    /** The type values combine to place by place: the vector among them (all the same size), else number, else whole number. */
    unify(values: readonly IrValue[]): FnType {
        if (values.some((value) => value.type === 'bool')) throw new FnError('Yes-or-no values go into Select, And, Or and Not, not into arithmetic.');
        const sizes = [...new Set(values.map((value) => fnSize(value.type)).filter((size) => size > 1))];
        if (sizes.length > 1) throw new FnError(`It cannot mix ${sizes.map((size) => SIZE_WORDS[size]).join(' and ')} values: split or join them so they match.`);
        if (sizes.length) return vectorOf(sizes[0]);
        return values.some((value) => value.type === 'float') ? 'float' : 'int';
    }

    /** `values` made one type for a place-by-place step (`floats`: whole numbers become numbers). */
    same(values: readonly IrValue[], floats = false): IrValue[] {
        let type = this.unify(values);
        if (floats && type === 'int') type = 'float';
        return values.map((value) => this.cast(value, type));
    }
}

// ---- the catalogue ----

const port = (key: string, label: string, type: FnPinType = 'auto', fallback?: number | 'uv'): FnPortDef => ({ key, label, type, ...(fallback !== undefined ? { fallback } : {}) });
const OUT = (type: FnPinType = 'auto', label = 'Value'): FnPortDef => ({ key: 'out', label, type });

const unary = (type: string, label: string, op: IrOp, description: string, keywords: string[], options: { floats?: boolean; result?: 'float' } = {}): FnNodeDef => ({
    type, label, category: ['sin', 'cos', 'tan', 'asin', 'acos'].includes(op) ? 'Trigonometry' : op === 'length' || op === 'normalize' ? 'Vectors' : 'Maths',
    description, keywords, inputs: [port('a', 'Value', 'auto', 0)], outputs: [OUT()], params: [],
    build(b, args) {
        const [a] = b.same([args.a], options.floats);
        return { out: b.add(options.result ?? a.type, op, [a]) };
    },
});

const binary = (type: string, label: string, op: IrOp, description: string, keywords: string[], fallbacks: [number, number], options: { floats?: boolean; labels?: [string, string] } = {}): FnNodeDef => ({
    type, label, category: op === 'atan2' ? 'Trigonometry' : 'Maths', description, keywords,
    inputs: [port('a', options.labels?.[0] ?? 'A', 'auto', fallbacks[0]), port('b', options.labels?.[1] ?? 'B', 'auto', fallbacks[1])],
    outputs: [OUT()], params: [],
    build(b, args) {
        const [a, c] = b.same([args.a, args.b], options.floats);
        return { out: b.add(a.type, op, [a, c]) };
    },
});

const constant = (type: string, label: string, valueType: FnType, kind: FnParamDef['kind'], fallback: unknown, description: string, keywords: string[]): FnNodeDef => ({
    type, label, category: 'Values', description, keywords, inputs: [], outputs: [OUT(valueType, label)],
    params: [{ key: 'value', label: 'Value', kind, default: fallback }],
    build(b, _args, params) {
        const value = params.value;
        const numbers = Array.isArray(value) ? value.map(Number) : [typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)];
        return { out: b.constant(valueType, numbers) };
    },
});

const PICTURE_OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }, { value: 'd', label: 'D' }];
const COMPARE_OPTIONS = [
    { value: 'lt', label: 'A is less than B' }, { value: 'le', label: 'A is at most B' }, { value: 'gt', label: 'A is more than B' },
    { value: 'ge', label: 'A is at least B' }, { value: 'eq', label: 'A equals B' }, { value: 'ne', label: 'A is not B' },
];
const MASK = /^[xyzwrgba]{1,4}$/;

export const FUNCTION_NODE_DEFINITIONS: readonly FnNodeDef[] = [
    // ---- inputs ----
    {
        type: 'fnPosition', label: 'Position', category: 'Inputs', pixelOnly: true,
        description: 'Where the pixel is: 0 to 1 across and down the picture.', keywords: ['uv', 'coordinates', 'where', 'pixel position'],
        inputs: [], outputs: [OUT('vec2', 'Position')], params: [],
        build: (b) => ({ out: b.add('vec2', 'uv') }),
    },
    {
        type: 'fnPixel', label: 'Pixel', category: 'Inputs', pixelOnly: true,
        description: 'Which pixel it is, counted in whole pixels from the corner.', keywords: ['pixel coordinates', 'frag coord', 'integer position'],
        inputs: [], outputs: [OUT('vec2', 'Pixel')], params: [],
        build: (b) => ({ out: b.add('vec2', 'pixel') }),
    },
    {
        type: 'fnSize', label: 'Picture size', category: 'Inputs',
        description: 'The size of the picture in pixels (in a Value processor, of picture A).', keywords: ['resolution', 'width', 'height', 'dimensions'],
        inputs: [], outputs: [OUT('vec2', 'Size')], params: [],
        build: (b) => ({ out: b.add('vec2', 'size') }),
    },
    {
        type: 'fnWorld', label: 'Size in the world', category: 'Inputs',
        description: 'Metres the picture spans across and down: the graph\'s size in the world (1 by 1 when it has none).', keywords: ['physical size', 'metres', 'world units', 'scale'],
        inputs: [], outputs: [OUT('vec2', 'Metres')], params: [],
        build: (b) => ({ out: b.add('vec2', 'world') }),
    },
    {
        type: 'fnSeed', label: 'Random seed', category: 'Inputs',
        description: 'The node\'s random seed, for making random numbers of your own.', keywords: ['seed', 'random'],
        inputs: [], outputs: [OUT('float', 'Seed')], params: [],
        build: (b) => ({ out: b.add('float', 'seed') }),
    },
    {
        type: 'fnPass', label: 'Pass number', category: 'Inputs',
        description: 'Inside a graph an Iterate node runs: which pass this is (0 first) and how many passes there are. Outside one: 0 and 1.', keywords: ['iteration', 'loop index', 'count', 'iterate'],
        inputs: [], outputs: [port('out', 'Pass', 'int'), port('count', 'Passes', 'int')], params: [],
        build: (b) => ({ out: b.add('int', 'iteration'), count: b.add('int', 'iterations') }),
    },
    {
        type: FN_SETTING_TYPE, label: 'Setting', category: 'Inputs',
        description: 'One of the processor\'s named settings. Each can be exposed as a parameter of the graph.', keywords: ['parameter', 'named setting', 'uniform', 'slider', 'exposed'],
        inputs: [], outputs: [OUT('auto', 'Value')],
        params: [{ key: 'setting', label: 'Setting', kind: 'setting', default: '' }],
        build(b, _args, params) {
            const key = String(params.setting ?? '');
            const type = b.settingTypes.get(key);
            if (!type) throw new FnError(key ? 'This setting is gone from the processor: choose another.' : 'Choose which of the processor\'s settings it reads.');
            b.settings.add(key);
            return { out: b.add(type, 'setting', [], key) };
        },
    },
    {
        type: FN_SAMPLE_TYPE, label: 'Sample picture', category: 'Inputs',
        description: 'Reads one of the pictures wired into the processor at a position (unwired: where the pixel is; in a Value processor, the middle).', keywords: ['texture', 'read', 'lookup', 'input', 'image'],
        inputs: [port('at', 'At', 'vec2', 'uv')], outputs: [port('out', 'Colour', 'vec4'), port('gray', 'Grey', 'float')],
        params: [{ key: 'picture', label: 'Picture', kind: 'picture', default: 'a', options: PICTURE_OPTIONS }],
        build(b, args, params) {
            const key = String(params.picture ?? 'a');
            if (!b.pictureKeys.includes(key)) throw new FnError(`The processor has no picture ${key.toUpperCase()}.`);
            b.pictures.add(key);
            const at = b.cast(args.at, 'vec2', true);
            return { out: b.add('vec4', 'sample', [at], key), gray: b.add('float', 'sampleGray', [at], key) };
        },
    },
    // ---- values ----
    constant('fnNumber', 'Number', 'float', 'float', 1, 'A number of your own.', ['constant', 'float', 'scalar', 'value']),
    constant('fnVector2', 'Two numbers', 'vec2', 'vec2', [0, 0], 'Two numbers of your own (a position or an offset).', ['vector', 'vec2', 'float2', 'offset']),
    constant('fnVector3', 'Three numbers', 'vec3', 'vec3', [0, 0, 0], 'Three numbers of your own.', ['vector', 'vec3', 'float3', 'direction']),
    constant('fnColour', 'Colour', 'vec4', 'color', [1, 1, 1, 1], 'A colour of your own (four numbers, with alpha).', ['color', 'vec4', 'rgba', 'tint']),
    constant('fnWhole', 'Whole number', 'int', 'int', 1, 'A whole number of your own.', ['integer', 'int', 'count']),
    constant('fnToggle', 'Yes or no', 'bool', 'bool', true, 'A yes or no of your own, for Select.', ['boolean', 'bool', 'true', 'false', 'switch']),
    // ---- maths ----
    binary('fnAdd', 'Add', 'add', 'A plus B, place by place.', ['plus', 'sum', '+'], [0, 0]),
    binary('fnSubtract', 'Subtract', 'sub', 'A minus B, place by place.', ['minus', 'difference', '-'], [0, 0]),
    binary('fnMultiply', 'Multiply', 'mul', 'A times B, place by place.', ['times', 'product', 'scale', '*'], [1, 1]),
    binary('fnDivide', 'Divide', 'div', 'A divided by B, place by place (whole numbers drop what is left over).', ['divided', 'ratio', '/'], [1, 1]),
    binary('fnPower', 'Power', 'pow', 'A to the power of B (A should not be below 0).', ['pow', 'exponent', '^'], [1, 2], { floats: true, labels: ['Base', 'Power'] }),
    binary('fnMin', 'Smaller', 'min', 'The smaller of A and B, place by place.', ['min', 'minimum', 'lowest'], [0, 1]),
    binary('fnMax', 'Larger', 'max', 'The larger of A and B, place by place.', ['max', 'maximum', 'highest'], [0, 1]),
    binary('fnModulo', 'Remainder', 'mod', 'What is left of A after taking away whole Bs (always between 0 and B): repeats things.', ['mod', 'modulo', 'wrap', 'repeat', '%'], [0, 1], { floats: true }),
    binary('fnStep', 'Step', 'step', '0 where the value is below the edge, 1 from the edge up.', ['threshold', 'edge'], [0.5, 0], { floats: true, labels: ['Edge', 'Value'] }),
    binary('fnAtan2', 'Angle of', 'atan2', 'The angle (in radians, from -π to π) of the point X, Y round the origin.', ['atan2', 'arctangent', 'angle', 'polar'], [0, 1], { floats: true, labels: ['Y', 'X'] }),
    unary('fnNegate', 'Negate', 'neg', 'The value with its sign turned round.', ['negative', 'minus', 'flip sign']),
    unary('fnAbs', 'Absolute', 'abs', 'The value without its sign.', ['abs', 'magnitude', 'positive']),
    unary('fnFloor', 'Round down', 'floor', 'The whole number at or below the value.', ['floor', 'truncate'], { floats: true }),
    unary('fnCeil', 'Round up', 'ceil', 'The whole number at or above the value.', ['ceil', 'ceiling'], { floats: true }),
    unary('fnRound', 'Round', 'round', 'The nearest whole number (halves go up).', ['nearest', 'snap'], { floats: true }),
    unary('fnFract', 'Fraction', 'fract', 'What is left after the whole number: 0 to 1, repeating.', ['fract', 'frac', 'repeat', 'decimal part'], { floats: true }),
    unary('fnSqrt', 'Square root', 'sqrt', 'The square root (of a value not below 0).', ['sqrt', 'root'], { floats: true }),
    unary('fnExp', 'Exponential', 'exp', 'e to the power of the value.', ['exp', 'e'], { floats: true }),
    unary('fnLog', 'Logarithm', 'log', 'The natural logarithm (of a value above 0).', ['log', 'ln'], { floats: true }),
    unary('fnSign', 'Sign', 'sign', '-1 below 0, 0 at 0, 1 above.', ['sign', 'direction']),
    unary('fnSaturate', 'Clamp 0 to 1', 'saturate', 'The value kept between 0 and 1.', ['saturate', 'clamp01', 'limit'], { floats: true }),
    {
        type: 'fnOneMinus', label: 'One minus', category: 'Maths', description: '1 minus the value: inverts 0 to 1.', keywords: ['invert', '1-x', 'complement'],
        inputs: [port('a', 'Value', 'auto', 0)], outputs: [OUT()], params: [],
        build(b, args) {
            const [a] = b.same([args.a], true);
            return { out: b.add(a.type, 'sub', [b.cast(b.constant('float', [1]), a.type), a]) };
        },
    },
    {
        type: 'fnMix', label: 'Mix', category: 'Maths', description: 'From A (amount 0) to B (amount 1), place by place.', keywords: ['lerp', 'blend', 'interpolate', 'mix'],
        inputs: [port('a', 'A', 'auto', 0), port('b', 'B', 'auto', 1), port('t', 'Amount', 'auto', 0.5)], outputs: [OUT()], params: [],
        build(b, args) {
            const [a, c] = b.same([args.a, args.b], true);
            const t = fnSize(args.t.type) > 1 ? b.cast(args.t, a.type) : b.cast(args.t, 'float');
            return { out: b.add(a.type, 'mix', [a, c, t]) };
        },
    },
    {
        type: 'fnClamp', label: 'Clamp', category: 'Maths', description: 'The value kept between the lowest and the highest.', keywords: ['limit', 'range', 'clamp'],
        inputs: [port('a', 'Value', 'auto', 0), port('low', 'Lowest', 'auto', 0), port('high', 'Highest', 'auto', 1)], outputs: [OUT()], params: [],
        build(b, args) {
            const [a, low, high] = b.same([args.a, args.low, args.high]);
            return { out: b.add(a.type, 'clamp', [a, low, high]) };
        },
    },
    {
        type: 'fnSmoothstep', label: 'Smooth step', category: 'Maths', description: '0 below the low edge, 1 above the high edge, a smooth S-curve between.', keywords: ['smoothstep', 'ease', 'soft threshold'],
        inputs: [port('low', 'Low edge', 'auto', 0), port('high', 'High edge', 'auto', 1), port('a', 'Value', 'auto', 0.5)], outputs: [OUT()], params: [],
        build(b, args) {
            const [low, high, a] = b.same([args.low, args.high, args.a], true);
            return { out: b.add(a.type, 'smoothstep', [low, high, a]) };
        },
    },
    // ---- trigonometry ----
    unary('fnSin', 'Sine', 'sin', 'The sine of an angle in radians: waves from -1 to 1.', ['sin', 'wave'], { floats: true }),
    unary('fnCos', 'Cosine', 'cos', 'The cosine of an angle in radians.', ['cos', 'wave'], { floats: true }),
    unary('fnTan', 'Tangent', 'tan', 'The tangent of an angle in radians.', ['tan'], { floats: true }),
    unary('fnAsin', 'Arcsine', 'asin', 'The angle whose sine is the value (-1 to 1).', ['asin', 'inverse sine'], { floats: true }),
    unary('fnAcos', 'Arccosine', 'acos', 'The angle whose cosine is the value (-1 to 1).', ['acos', 'inverse cosine'], { floats: true }),
    // ---- vectors ----
    unary('fnLength', 'Length', 'length', 'How long a vector is.', ['magnitude', 'norm', 'length'], { floats: true, result: 'float' }),
    unary('fnNormalize', 'Normalise', 'normalize', 'The vector made one unit long (a zero vector stays zero).', ['normalize', 'unit', 'direction'], { floats: true }),
    {
        type: 'fnDot', label: 'Dot product', category: 'Vectors', description: 'How much two vectors point the same way, times their lengths.', keywords: ['dot', 'scalar product', 'projection'],
        inputs: [port('a', 'A', 'auto', 0), port('b', 'B', 'auto', 0)], outputs: [OUT('float')], params: [],
        build(b, args) {
            const [a, c] = b.same([args.a, args.b], true);
            return { out: b.add('float', 'dot', [a, c]) };
        },
    },
    {
        type: 'fnDistance', label: 'Distance', category: 'Vectors', description: 'How far apart two points are.', keywords: ['distance', 'length between'],
        inputs: [port('a', 'A', 'auto', 0), port('b', 'B', 'auto', 0)], outputs: [OUT('float')], params: [],
        build(b, args) {
            const [a, c] = b.same([args.a, args.b], true);
            return { out: b.add('float', 'distance', [a, c]) };
        },
    },
    {
        type: 'fnCross', label: 'Cross product', category: 'Vectors', description: 'A vector at right angles to two three-number vectors.', keywords: ['cross', 'perpendicular', 'normal'],
        inputs: [port('a', 'A', 'vec3', 0), port('b', 'B', 'vec3', 0)], outputs: [OUT('vec3')], params: [],
        build(b, args) {
            return { out: b.add('vec3', 'cross', [b.cast(args.a, 'vec3'), b.cast(args.b, 'vec3')]) };
        },
    },
    {
        type: 'fnSplit', label: 'Split', category: 'Vectors', description: 'The parts of a vector or colour, each as a number (missing parts are 0).', keywords: ['separate', 'components', 'xyzw', 'rgba', 'channels', 'break'],
        inputs: [port('a', 'Vector', 'auto', 0)], outputs: [port('x', 'X / R', 'float'), port('y', 'Y / G', 'float'), port('z', 'Z / B', 'float'), port('w', 'W / A', 'float')], params: [],
        build(b, args) {
            const source = args.a.type === 'int' || args.a.type === 'bool' ? b.cast(args.a, 'float') : args.a;
            const size = fnSize(source.type);
            const part = (index: number) => (index >= size ? b.constant('float', [0]) : size === 1 ? source : b.add('float', 'swizzle', [source], 'xyzw'[index]));
            return { x: part(0), y: part(1), z: part(2), w: part(3) };
        },
    },
    ...([2, 3, 4] as const).map((size): FnNodeDef => ({
        type: `fnJoin${size}`, label: `Join ${['', '', 'two', 'three', 'four'][size]}`, category: 'Vectors',
        description: size === 4 ? 'Four numbers made into one value (a colour: R, G, B, A).' : `${size === 2 ? 'Two' : 'Three'} numbers made into one value.`,
        keywords: ['combine', 'make vector', 'merge', 'compose', `vec${size}`, ...(size === 4 ? ['rgba', 'colour'] : [])],
        inputs: ['x', 'y', 'z', 'w'].slice(0, size).map((key, index) => port(key, ['X / R', 'Y / G', 'Z / B', 'W / A'][index], 'float', index === 3 ? 1 : 0)),
        outputs: [OUT(vectorOf(size))], params: [],
        build(b, args) {
            const parts = ['x', 'y', 'z', 'w'].slice(0, size).map((key) => b.cast(args[key], 'float'));
            return { out: b.add(vectorOf(size), 'construct', parts) };
        },
    })),
    {
        type: 'fnSwizzle', label: 'Reorder parts', category: 'Vectors', description: 'Picks and reorders a vector\'s parts by letters: "yx" swaps two, "rrr" repeats red, "xyz" drops alpha.', keywords: ['swizzle', 'shuffle', 'channels', 'mask'],
        inputs: [port('a', 'Vector', 'auto', 0)], outputs: [OUT()], params: [{ key: 'mask', label: 'Parts', kind: 'text', default: 'yx', hint: 'One to four of x y z w (or r g b a).' }],
        build(b, args, params) {
            const mask = String(params.mask ?? '').trim().toLowerCase();
            if (!MASK.test(mask)) throw new FnError('Parts are one to four of the letters x, y, z, w (or r, g, b, a).');
            const letters = mask.replace(/[rgba]/g, (letter) => ({ r: 'x', g: 'y', b: 'z', a: 'w' })[letter]!);
            const source = args.a.type === 'int' || args.a.type === 'bool' ? b.cast(args.a, 'float') : args.a;
            const size = fnSize(source.type);
            const highest = Math.max(...[...letters].map((letter) => 'xyzw'.indexOf(letter)));
            if (highest >= size && size > 1) throw new FnError(`A ${SIZE_WORDS[size]} value has no "${'xyzw'[highest]}" part.`);
            const type = vectorOf(letters.length);
            if (size === 1) return { out: letters.length === 1 ? source : b.add(type, 'construct', [source]) };
            return { out: b.add(type, 'swizzle', [source], letters) };
        },
    },
    // ---- logic ----
    {
        type: 'fnCompare', label: 'Compare', category: 'Logic', description: 'Yes or no: how A stands to B (single numbers).', keywords: ['if', 'greater', 'less', 'equal', 'condition', 'test'],
        inputs: [port('a', 'A', 'auto', 0), port('b', 'B', 'auto', 0.5)], outputs: [OUT('bool', 'Yes or no')],
        params: [{ key: 'test', label: 'Test', kind: 'select', default: 'gt', options: COMPARE_OPTIONS }],
        build(b, args, params) {
            const [a, c] = b.same([args.a, args.b]);
            if (isVector(a.type)) throw new FnError('Compare takes single numbers: take one part of a vector with Split.');
            const op = (COMPARE_OPTIONS.find((option) => option.value === params.test)?.value ?? 'gt') as IrOp;
            return { out: b.add('bool', op, [a, c]) };
        },
    },
    {
        type: 'fnSelect', label: 'Select', category: 'Logic', description: 'One value where the condition holds, the other where it does not.', keywords: ['if', 'else', 'branch', 'choose', 'switch', 'condition'],
        inputs: [port('test', 'Condition', 'bool', 1), port('a', 'If yes', 'auto', 1), port('b', 'If no', 'auto', 0)], outputs: [OUT()], params: [],
        build(b, args) {
            const test = b.cast(args.test, 'bool');
            const [a, c] = args.a.type === 'bool' && args.b.type === 'bool' ? [args.a, args.b] : b.same([args.a, args.b]);
            return { out: b.add(a.type, 'select', [test, a, c]) };
        },
    },
    ...(['and', 'or'] as const).map((op): FnNodeDef => ({
        type: op === 'and' ? 'fnAnd' : 'fnOr', label: op === 'and' ? 'And' : 'Or', category: 'Logic',
        description: op === 'and' ? 'Yes when both are yes.' : 'Yes when either is yes.', keywords: ['logic', 'boolean', op],
        inputs: [port('a', 'A', 'bool', 1), port('b', 'B', 'bool', 1)], outputs: [OUT('bool', 'Yes or no')], params: [],
        build: (b, args) => ({ out: b.add('bool', op, [b.cast(args.a, 'bool'), b.cast(args.b, 'bool')]) }),
    })),
    {
        type: 'fnNot', label: 'Not', category: 'Logic', description: 'Yes when the value is no, and the other way round.', keywords: ['invert', 'boolean', 'negate'],
        inputs: [port('a', 'Value', 'bool', 0)], outputs: [OUT('bool', 'Yes or no')], params: [],
        build: (b, args) => ({ out: b.add('bool', 'not', [b.cast(args.a, 'bool')]) }),
    },
    // ---- random ----
    {
        type: 'fnRandom', label: 'Random number', category: 'Random', description: 'A random number from 0 to 1 for each place (unwired: each pixel), the same every time for the same seed.', keywords: ['hash', 'noise', 'white noise', 'rand'],
        inputs: [port('at', 'At', 'auto', 'uv')], outputs: [OUT('float', 'Random')],
        params: [{ key: 'salt', label: 'Variation', kind: 'int', default: 0, min: 0, max: 9999, hint: 'Different numbers give different random values from the same places.' }],
        build(b, args, params) {
            const at = args.at.type === 'float' ? args.at : b.cast(args.at, args.at.type === 'int' || args.at.type === 'bool' ? 'float' : 'vec2', true);
            return { out: b.add('float', 'random', [at], [Math.max(0, Math.round(Number(params.salt) || 0))]) };
        },
    },
    {
        type: 'fnNoise', label: 'Noise', category: 'Random', description: 'Smooth gradient noise, about -1 to 1, that tiles when the scale is a whole number.', keywords: ['perlin', 'gradient noise', 'smooth random'],
        inputs: [port('at', 'At', 'vec2', 'uv'), port('scale', 'Scale', 'float', 8)], outputs: [OUT('float', 'Noise')], params: [],
        build: (b, args) => ({ out: b.add('float', 'noise', [b.cast(args.at, 'vec2', true), b.cast(args.scale, 'float')]) }),
    },
    {
        type: FN_REROUTE_TYPE, label: 'Reroute point', category: 'Values', description: 'A point a wire passes through, to lead it round other nodes. It changes nothing.', keywords: ['reroute', 'dot', 'elbow'],
        inputs: [port('in', 'In', 'auto', 0)], outputs: [OUT()], params: [],
        build: (_b, args) => ({ out: args.in }),
    },
    // ---- the result ----
    {
        type: FN_RESULT_TYPE, label: 'Result', category: 'Result',
        description: 'What the function gives: in a Pixel processor the pixel\'s colour (one number is grey), in a Value processor the value.', keywords: ['output', 'return', 'result'],
        inputs: [port('value', 'Value', 'auto', 0)], outputs: [], params: [],
        build: (_b, args) => ({ value: args.value }),
    },
];

const FN_BY_TYPE = new Map(FUNCTION_NODE_DEFINITIONS.map((definition) => [definition.type, definition]));
export const functionNodeDefinition = (type: string): FnNodeDef | undefined => FN_BY_TYPE.get(type);

// ---- reading and making ----

let fnCounter = 0;
export const newFunctionNodeId = (): string => `f${Date.now().toString(36)}${(fnCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A function node's settings: its own, else their defaults, and a number for each input that has one. */
export const defaultFunctionParams = (definition: FnNodeDef): Record<string, unknown> => {
    const params: Record<string, unknown> = {};
    for (const param of definition.params) params[param.key] = structuredClone(param.default);
    for (const input of definition.inputs) if (typeof input.fallback === 'number') params[fallbackKey(input.key)] = input.fallback;
    return params;
};

export const createFunctionNode = (type: string, x: number, y: number, params: Record<string, unknown> = {}): FnNode => {
    const definition = functionNodeDefinition(type);
    return { id: newFunctionNodeId(), type, x: Math.round(x), y: Math.round(y), params: { ...(definition ? defaultFunctionParams(definition) : {}), ...params } };
};

/** The function a new Pixel processor starts with: picture A as it is. */
export const defaultPixelFunction = (): FunctionGraph => {
    const sample = createFunctionNode(FN_SAMPLE_TYPE, 40, 60);
    const result = createFunctionNode(FN_RESULT_TYPE, 320, 60);
    return { nodes: [sample, result], links: [{ from: sample.id, fromOutput: 'out', to: result.id, toInput: 'value' }] };
};

/** The function a new Value processor starts with: the middle of picture A's brightness. */
export const defaultValueFunction = (): FunctionGraph => {
    const middle = createFunctionNode('fnVector2', 40, 60, { value: [0.5, 0.5] });
    const sample = createFunctionNode(FN_SAMPLE_TYPE, 260, 60);
    const result = createFunctionNode(FN_RESULT_TYPE, 520, 60);
    return {
        nodes: [middle, sample, result],
        links: [{ from: middle.id, fromOutput: 'out', to: sample.id, toInput: 'at' }, { from: sample.id, fromOutput: 'gray', to: result.id, toInput: 'value' }],
    };
};

const MAX_FUNCTION_NODES = 2000;

/** A stored function graph made safe to use: known shapes, one wire into an input, no loops, one Result. */
export const readFunctionGraph = (value: unknown, fallback: () => FunctionGraph = defaultPixelFunction): FunctionGraph => {
    const raw = value as Partial<FunctionGraph> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return fallback();
    const nodes: FnNode[] = [];
    const ids = new Set<string>();
    let result = false;
    for (const candidate of raw.nodes.slice(0, MAX_FUNCTION_NODES)) {
        const node = candidate as Partial<FnNode> | null;
        if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.type !== 'string' || !node.type) continue;
        // One Result: later ones are left out.
        if (node.type === FN_RESULT_TYPE) { if (result) continue; result = true; }
        ids.add(node.id);
        const definition = functionNodeDefinition(node.type);
        const own = node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : {};
        const kept: FnNode = {
            id: node.id, type: node.type,
            x: typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 0,
            y: typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 0,
            params: { ...(definition ? defaultFunctionParams(definition) : {}), ...own },
        };
        if (typeof node.name === 'string' && node.name.trim()) kept.name = node.name.trim().slice(0, 64);
        if (typeof node.color === 'string' && /^#[0-9a-f]{6}$/i.test(node.color)) kept.color = node.color.toLowerCase();
        if (node.collapsed === true) kept.collapsed = true;
        nodes.push(kept);
    }
    if (!result) nodes.push(createFunctionNode(FN_RESULT_TYPE, Math.max(0, ...nodes.map((node) => node.x)) + 280, 60));
    const links: FnLink[] = [];
    const taken = new Set<string>();
    for (const candidate of Array.isArray(raw.links) ? raw.links : []) {
        const link = candidate as Partial<FnLink> | null;
        if (!link || typeof link.from !== 'string' || typeof link.to !== 'string' || typeof link.fromOutput !== 'string' || typeof link.toInput !== 'string') continue;
        if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) continue;
        const key = `${link.to}:${link.toInput}`;
        if (taken.has(key)) continue;
        if (functionWouldCycle(links, link.from, link.to)) continue;
        taken.add(key);
        links.push({ from: link.from, fromOutput: link.fromOutput, to: link.to, toInput: link.toInput });
    }
    const graph: FunctionGraph = { nodes, links };
    if (Array.isArray(raw.comments) && raw.comments.length) graph.comments = raw.comments.filter((comment): comment is TexGraphComment => Boolean(comment && typeof comment === 'object' && typeof (comment as TexGraphComment).id === 'string'));
    return graph;
};

/** True when a wire from `from` into `to` would close a loop. */
export const functionWouldCycle = (links: readonly FnLink[], from: string, to: string): boolean => {
    if (from === to) return true;
    const next = new Map<string, string[]>();
    for (const link of links) { const list = next.get(link.from); if (list) list.push(link.to); else next.set(link.from, [link.to]); }
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
        const id = stack.pop()!;
        if (id === from) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const after of next.get(id) ?? []) stack.push(after);
    }
    return false;
};

// ---- compiling ----

export interface CompileOptions {
    use: FunctionUse;
    /** The processor's named settings, by key. */
    settings?: readonly NamedSetting[];
    /** The pictures the processor takes (input keys). */
    pictures?: readonly string[];
    /** A node's output to give instead of the Result's (to preview it). */
    target?: { node: string; output: string };
}

export interface CompiledFunction {
    /** The steps the result needs; null when it could not be compiled. */
    ir: FunctionIr | null;
    /** Each node's output types, for the nodes that built. */
    types: Map<string, Record<string, FnType>>;
    /** What went wrong at each node that did not build, in words. */
    errors: Map<string, string>;
    /** What stops the function compiling, in words; null when it compiled. */
    error: string | null;
}

/** The function's steps (and every node's types and problems). */
export const compileFunction = (graph: FunctionGraph, options: CompileOptions): CompiledFunction => {
    const settingTypes = new Map((options.settings ?? []).map((setting) => [setting.key, settingType(setting.kind)]));
    const b = new IrBuilder(options.use, settingTypes, options.pictures ?? ['a', 'b', 'c', 'd']);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, Map<string, FnLink>>();
    for (const link of graph.links) {
        if (!nodes.has(link.from) || !nodes.has(link.to)) continue;
        let map = incoming.get(link.to);
        if (!map) incoming.set(link.to, map = new Map());
        map.set(link.toInput, link);
    }
    const values = new Map<string, Record<string, IrValue>>();
    const types = new Map<string, Record<string, FnType>>();
    const errors = new Map<string, string>();
    const state = new Map<string, 'visiting' | 'done'>();
    const failedUpstream = new Set<string>();

    const build = (id: string): void => {
        const seen = state.get(id);
        if (seen === 'done') return;
        if (seen === 'visiting') { errors.set(id, 'This node feeds itself through a loop of wires.'); return; }
        state.set(id, 'visiting');
        const node = nodes.get(id)!;
        for (const link of incoming.get(id)?.values() ?? []) build(link.from);
        state.set(id, 'done');
        const definition = functionNodeDefinition(node.type);
        if (!definition) { errors.set(id, `This version of the editor has no "${node.type}" function node.`); return; }
        if (definition.pixelOnly && options.use === 'value') { errors.set(id, `${definition.label} means something only for each pixel: use it in a Pixel processor.`); return; }
        const args: Record<string, IrValue> = {};
        for (const input of definition.inputs) {
            const link = incoming.get(id)?.get(input.key);
            if (link) {
                const from = values.get(link.from)?.[link.fromOutput];
                if (!from) {
                    failedUpstream.add(id);
                    errors.set(id, errors.get(link.from) ? 'A node wired into it has a problem.' : 'A wire into it comes from a pin that is not there.');
                    return;
                }
                args[input.key] = from;
                continue;
            }
            if (input.fallback === 'uv') {
                args[input.key] = options.use === 'pixel' ? b.add('vec2', 'uv') : b.constant('vec2', [0.5, 0.5]);
                continue;
            }
            const stored = Number(node.params[fallbackKey(input.key)]);
            const number = Number.isFinite(stored) ? stored : typeof input.fallback === 'number' ? input.fallback : 0;
            const type: FnType = input.type === 'auto' ? 'float' : input.type;
            args[input.key] = b.constant(type, [number]);
        }
        try {
            const outputs = definition.build(b, args, node.params);
            values.set(id, outputs);
            types.set(id, Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, value.type])));
        } catch (error) {
            if (!(error instanceof FnError)) throw error;
            errors.set(id, error.message);
        }
    };
    for (const node of graph.nodes) build(node.id);

    const fail = (error: string): CompiledFunction => ({ ir: null, types, errors, error });
    let result: IrValue | undefined;
    if (options.target) {
        const node = nodes.get(options.target.node);
        if (!node) return fail('The node to preview is gone.');
        const own = errors.get(node.id);
        if (own) return fail(own);
        result = values.get(node.id)?.[options.target.output];
        if (!result) return fail('That pin gives no value.');
    } else {
        const resultNode = graph.nodes.find((node) => node.type === FN_RESULT_TYPE);
        if (!resultNode) return fail('The function has no Result node.');
        const own = errors.get(resultNode.id);
        if (own) return fail(failedUpstream.has(resultNode.id) ? firstRootError(resultNode.id, incoming, errors, failedUpstream) : own);
        result = values.get(resultNode.id)?.value;
        if (!result) return fail('Nothing gives the Result a value.');
    }

    // Only the steps the result needs, in order.
    const needed = new Set<number>();
    const stack = [result.id];
    while (stack.length) {
        const id = stack.pop()!;
        if (needed.has(id)) continue;
        needed.add(id);
        for (const arg of b.steps[id].args) stack.push(arg);
    }
    const steps = b.steps.filter((step) => needed.has(step.id));
    const settings = [...new Set(steps.filter((step) => step.op === 'setting').map((step) => String(step.data)))];
    const pictures = [...new Set(steps.filter((step) => step.op === 'sample' || step.op === 'sampleGray').map((step) => String(step.data)))];
    return { ir: { use: options.use, steps, result, settings, pictures }, types, errors, error: null };
};

/** The problem at the start of a chain of nodes that could not build, for the processor to show. */
const firstRootError = (id: string, incoming: ReadonlyMap<string, ReadonlyMap<string, FnLink>>, errors: ReadonlyMap<string, string>, upstream: ReadonlySet<string>): string => {
    let current = id;
    for (let guard = 0; guard < 4096 && upstream.has(current); guard++) {
        const next = [...(incoming.get(current)?.values() ?? [])].find((link) => errors.has(link.from));
        if (!next) break;
        current = next.from;
    }
    return errors.get(current) ?? 'A node in the function has a problem.';
};

// ---- GLSL ----

const glslNumber = (value: number): string => {
    const finite = Number.isFinite(value) ? value : value > 0 ? 3.4e38 : value < 0 ? -3.4e38 : 0;
    const text = String(Number(Math.fround(finite).toPrecision(9)));
    return /[.e]/.test(text) ? (text.includes('e') && !text.includes('.') ? text.replace('e', '.0e') : text) : `${text}.0`;
};

const glslLiteral = (type: FnType, data: readonly number[]): string => {
    if (type === 'bool') return data[0] ? 'true' : 'false';
    if (type === 'int') return String(Math.trunc(data[0] ?? 0));
    if (type === 'float') return glslNumber(data[0] ?? 0);
    return `${type}(${data.map(glslNumber).join(', ')})`;
};

/** What the picture's size and the pixel read as, when not the pass's own (a preview drawn smaller). */
export interface GlslNames { size?: string; pixel?: string }

/** The step's value as GLSL, from its arguments' names. */
const glslExpression = (step: IrStep, a: readonly string[], argTypes: readonly FnType[], use: FunctionUse, names: GlslNames): string => {
    const [x, y, z] = a;
    switch (step.op) {
        case 'const': return glslLiteral(step.type, step.data as number[]);
        case 'uv': return 'vUv';
        case 'pixel': return names.pixel ?? 'floor(gl_FragCoord.xy)';
        case 'size': return names.size ?? (use === 'pixel' ? 'uSize' : 'vec2(textureSize(t_a, 0))');
        case 'seed': return 'uSeed';
        case 'iteration': return 'uIteration';
        case 'iterations': return 'uIterations';
        case 'world': return 'uWorld';
        case 'setting': return step.type === 'bool' ? `(p_${String(step.data)} != 0)` : `p_${String(step.data)}`;
        case 'sample': return `c_${String(step.data)}(${x})`;
        case 'sampleGray': return `g_${String(step.data)}(${x})`;
        case 'construct': return `${step.type}(${a.join(', ')})`;
        case 'swizzle': return `${x}.${String(step.data)}`;
        case 'toFloat': return argTypes[0] === 'bool' ? `(${x} ? 1.0 : 0.0)` : `float(${x})`;
        case 'toInt': return argTypes[0] === 'bool' ? `(${x} ? 1 : 0)` : `int(${x})`;
        case 'toBool': return argTypes[0] === 'int' ? `(${x} != 0)` : `(${x} != 0.0)`;
        case 'neg': return `(-${x})`;
        case 'round': return `floor(${x} + 0.5)`;
        case 'saturate': return `clamp(${x}, 0.0, 1.0)`;
        case 'normalize': return `(length(${x}) > 0.0 ? normalize(${x}) : ${x})`;
        case 'not': return `(!${x})`;
        case 'abs': case 'floor': case 'ceil': case 'fract': case 'sqrt': case 'exp': case 'log': case 'sign':
        case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'length':
            return `${step.op}(${x})`;
        case 'add': return `(${x} + ${y})`;
        case 'sub': return `(${x} - ${y})`;
        case 'mul': return `(${x} * ${y})`;
        case 'div': return `(${x} / ${y})`;
        case 'mod': return `mod(${x}, ${y})`;
        case 'pow': case 'min': case 'max': case 'step': case 'dot': case 'distance': case 'cross':
            return `${step.op}(${x}, ${y})`;
        case 'atan2': return `atan(${x}, ${y})`;
        case 'lt': return `(${x} < ${y})`;
        case 'le': return `(${x} <= ${y})`;
        case 'gt': return `(${x} > ${y})`;
        case 'ge': return `(${x} >= ${y})`;
        case 'eq': return `(${x} == ${y})`;
        case 'ne': return `(${x} != ${y})`;
        case 'and': return `(${x} && ${y})`;
        case 'or': return `(${x} || ${y})`;
        case 'mix': return `mix(${x}, ${y}, ${z})`;
        case 'clamp': return `clamp(${x}, ${y}, ${z})`;
        case 'smoothstep': return `smoothstep(${x}, ${y}, ${z})`;
        case 'select': return `(${x} ? ${y} : ${z})`;
        case 'random': {
            const salt = glslNumber((step.data as number[] | undefined)?.[0] ?? 0);
            return argTypes[0] === 'float' ? `hashF(${x}, uSeed + ${salt})` : `hash1(ivec2(floor(${x} * 4096.0)), uSeed + ${salt})`;
        }
        case 'noise': return `perlin(${x} * ${y}, tilePeriod(ivec2(max(1.0, floor(${y} + 0.5)))), uSeed)`;
        default: return '0.0';
    }
};

/** A value of `type` as a colour (the Pixel processor's pixel; the Value processor's stored value). */
const glslColour = (type: FnType, name: string): string => {
    switch (type) {
        case 'vec4': return name;
        case 'vec3': return `vec4(${name}, 1.0)`;
        case 'vec2': return `vec4(${name}, 0.0, 1.0)`;
        case 'int': return `vec4(vec3(float(${name})), 1.0)`;
        case 'bool': return `vec4(vec3(${name} ? 1.0 : 0.0), 1.0)`;
        default: return `vec4(vec3(${name}), 1.0)`;
    }
};

/**
 * The steps as a GLSL function `vec4 name()` giving the result as a colour. It reads the kit's names
 * (c_/g_ for pictures, p_ for settings, uSeed, uSize, uWorld, uIteration), so it goes after them.
 */
export const glslFunction = (ir: FunctionIr, name = 'fn_result', names: GlslNames = {}): string => {
    const types = new Map(ir.steps.map((step) => [step.id, step.type]));
    const lines = ir.steps.map((step) => {
        const args = step.args.map((arg) => `v${arg}`);
        return `    ${step.type} v${step.id} = ${glslExpression(step, args, step.args.map((arg) => types.get(arg)!), ir.use, names)};`;
    });
    return `vec4 ${name}() {\n${lines.join('\n')}\n    return ${glslColour(ir.result.type, `v${ir.result.id}`)};\n}`;
};

// ---- the CPU ----

export interface FunctionEnv {
    uv?: readonly [number, number];
    pixel?: readonly [number, number];
    size?: readonly [number, number];
    seed?: number;
    iteration?: number;
    iterations?: number;
    world?: readonly [number, number];
    settings?: Readonly<Record<string, number | boolean | readonly number[]>>;
    /** A picture's colour at a place (0 to 1 across and down). */
    sample?: (picture: string, at: readonly [number, number]) => readonly number[];
    /** Its grey (a grey picture's value, a colour picture's brightness). */
    gray?: (picture: string, at: readonly [number, number]) => number;
}

const hashF = (x: number, seed: number): number => {
    const a = floatBits(Math.fround(x));
    const b = floatBits(Math.fround(seed));
    return Math.fround(hashU((a ^ hashU((b + 0x9e3779b9) >>> 0)) >>> 0)) / 4294967295;
};

const each = (a: readonly number[], f: (value: number, index: number) => number): number[] => a.map(f);
const pair = (a: readonly number[], b: readonly number[], f: (x: number, y: number) => number): number[] => a.map((value, index) => f(value, b[index] ?? b[0]));
const lengthOf = (a: readonly number[]): number => Math.hypot(...a);

/** Runs the steps on the CPU: the result's numbers (one for a number, two to four for a vector). */
export const runFunction = (ir: FunctionIr, env: FunctionEnv = {}): number[] => {
    const values = new Map<number, number[]>();
    const uv = env.uv ?? [0.5, 0.5];
    for (const step of ir.steps) {
        const a = step.args.map((arg) => values.get(arg)!);
        const [x, y, z] = a;
        const int = step.type === 'int';
        let value: number[];
        switch (step.op) {
            case 'const': value = [...(step.data as number[])]; break;
            case 'uv': value = [uv[0], uv[1]]; break;
            case 'pixel': value = [...(env.pixel ?? [0, 0])]; break;
            case 'size': value = [...(env.size ?? [1, 1])]; break;
            case 'seed': value = [env.seed ?? 0]; break;
            case 'iteration': value = [env.iteration ?? 0]; break;
            case 'iterations': value = [env.iterations ?? 1]; break;
            case 'world': value = [...(env.world ?? [1, 1])]; break;
            case 'setting': {
                const raw = env.settings?.[String(step.data)];
                value = Array.isArray(raw) ? raw.map(Number) : [typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw ?? 0)];
                break;
            }
            case 'sample': value = [...(env.sample?.(String(step.data), [x[0], x[1]]) ?? [0, 0, 0, 1])]; break;
            case 'sampleGray': value = [env.gray?.(String(step.data), [x[0], x[1]]) ?? 0]; break;
            case 'construct': {
                const parts = a.flat();
                value = parts.length === 1 ? Array(fnSize(step.type)).fill(parts[0]) : parts;
                break;
            }
            case 'swizzle': value = [...String(step.data)].map((letter) => x['xyzw'.indexOf(letter)] ?? 0); break;
            case 'toFloat': value = [x[0]]; break;
            case 'toInt': value = [Math.trunc(x[0])]; break;
            case 'toBool': value = [x[0] !== 0 ? 1 : 0]; break;
            case 'neg': value = each(x, (v) => -v); break;
            case 'abs': value = each(x, Math.abs); break;
            case 'floor': value = each(x, Math.floor); break;
            case 'ceil': value = each(x, Math.ceil); break;
            case 'fract': value = each(x, (v) => v - Math.floor(v)); break;
            case 'round': value = each(x, (v) => Math.floor(v + 0.5)); break;
            case 'sqrt': value = each(x, Math.sqrt); break;
            case 'exp': value = each(x, Math.exp); break;
            case 'log': value = each(x, Math.log); break;
            case 'sign': value = each(x, Math.sign); break;
            case 'saturate': value = each(x, (v) => Math.min(1, Math.max(0, v))); break;
            case 'sin': value = each(x, Math.sin); break;
            case 'cos': value = each(x, Math.cos); break;
            case 'tan': value = each(x, Math.tan); break;
            case 'asin': value = each(x, Math.asin); break;
            case 'acos': value = each(x, Math.acos); break;
            case 'normalize': { const length = lengthOf(x); value = length > 0 ? each(x, (v) => v / length) : [...x]; break; }
            case 'length': value = [lengthOf(x)]; break;
            case 'not': value = [x[0] ? 0 : 1]; break;
            case 'add': value = pair(x, y, (p, q) => p + q); break;
            case 'sub': value = pair(x, y, (p, q) => p - q); break;
            case 'mul': value = pair(x, y, (p, q) => p * q); break;
            case 'div': value = pair(x, y, (p, q) => (int ? Math.trunc(p / q) : p / q)); break;
            case 'mod': value = pair(x, y, (p, q) => p - q * Math.floor(p / q)); break;
            case 'pow': value = pair(x, y, (p, q) => p ** q); break;
            case 'min': value = pair(x, y, Math.min); break;
            case 'max': value = pair(x, y, Math.max); break;
            case 'atan2': value = pair(x, y, Math.atan2); break;
            case 'step': value = pair(x, y, (edge, v) => (v < edge ? 0 : 1)); break;
            case 'dot': value = [x.reduce((sum, v, index) => sum + v * y[index], 0)]; break;
            case 'distance': value = [lengthOf(pair(x, y, (p, q) => p - q))]; break;
            case 'cross': value = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]; break;
            case 'lt': value = [x[0] < y[0] ? 1 : 0]; break;
            case 'le': value = [x[0] <= y[0] ? 1 : 0]; break;
            case 'gt': value = [x[0] > y[0] ? 1 : 0]; break;
            case 'ge': value = [x[0] >= y[0] ? 1 : 0]; break;
            case 'eq': value = [x[0] === y[0] ? 1 : 0]; break;
            case 'ne': value = [x[0] !== y[0] ? 1 : 0]; break;
            case 'and': value = [x[0] && y[0] ? 1 : 0]; break;
            case 'or': value = [x[0] || y[0] ? 1 : 0]; break;
            case 'mix': value = x.map((p, index) => { const t = z[index] ?? z[0]; return p + ((y[index] ?? y[0]) - p) * t; }); break;
            case 'clamp': value = x.map((v, index) => Math.min(z[index] ?? z[0], Math.max(y[index] ?? y[0], v))); break;
            case 'smoothstep': value = z.map((v, index) => {
                const low = x[index] ?? x[0];
                const high = y[index] ?? y[0];
                const t = Math.min(1, Math.max(0, (v - low) / (high - low)));
                return t * t * (3 - 2 * t);
            }); break;
            case 'select': value = [...(x[0] ? y : z)]; break;
            case 'random': {
                const salt = (step.data as number[] | undefined)?.[0] ?? 0;
                const seed = Math.fround((env.seed ?? 0) + salt);
                value = [x.length === 1 ? hashF(x[0], seed) : hash1(Math.floor(Math.fround(x[0] * 4096)), Math.floor(Math.fround(x[1] * 4096)), seed)];
                break;
            }
            case 'noise': throw new FnError('Noise is worked out on the GPU only.');
            default: value = [0];
        }
        values.set(step.id, int ? value.map(Math.trunc) : value);
    }
    return values.get(ir.result.id) ?? [0];
};

/** A result's numbers as the colour the GPU stores (as glslFunction gives it). */
export const asColour = (type: FnType, value: readonly number[]): [number, number, number, number] => {
    switch (type) {
        case 'vec4': return [value[0], value[1], value[2], value[3]];
        case 'vec3': return [value[0], value[1], value[2], 1];
        case 'vec2': return [value[0], value[1], 0, 1];
        default: return [value[0], value[0], value[0], 1];
    }
};
