import { describe, expect, it } from 'vitest';
import {
    FN_RESULT_TYPE, FN_REROUTE_TYPE, FN_SAMPLE_TYPE, FN_SETTING_TYPE, FUNCTION_NODE_DEFINITIONS, asColour, compileFunction, createFunctionNode, functionNoise, glslFunction, runFunction,
    wgslFunction, wgslFunctionLibrary, type FnLink, type FnNode, type FunctionEnv, type FunctionGraph, type FunctionIr, type NamedSetting,
} from '../../texturing/graph/functionGraph';
import { perlin } from '../../texturing/graph/noiseMath';
import { floatBits, hash1, hashU } from '../../texturing/graph/scatter';

/**
 * The GLSL and WGSL a function graph is written as, run on the CPU by a small reader of the few forms
 * the writers use (typed lines of one step each, calls, operators, swizzles, constructors), and held
 * against the steps' own CPU run (runFunction): each writer, step for step, gives the same numbers.
 */

type Value = number[];

const hashF = (x: number, seed: number): number => Math.fround(hashU((floatBits(Math.fround(x)) ^ hashU((floatBits(Math.fround(seed)) + 0x9e3779b9) >>> 0)) >>> 0)) / 4294967295;

const zip = (values: Value[], f: (...parts: number[]) => number): Value => {
    const size = Math.max(...values.map((value) => value.length));
    return Array.from({ length: size }, (_, i) => f(...values.map((value) => value[value.length === 1 ? 0 : i])));
};
const lengthOf = (a: Value) => Math.hypot(...a);
const flat = (args: Value[], size: number): Value => {
    const parts = args.flat();
    return parts.length === 1 ? Array(size).fill(parts[0]) : parts;
};

/** What both languages' functions do, by name. */
const BUILTINS: Record<string, (...args: Value[]) => Value> = {
    mix: (a, b, t) => zip([a, b, t], (x, y, s) => x + (y - x) * s),
    clamp: (x, lo, hi) => zip([x, lo, hi], (v, l, h) => Math.min(h, Math.max(l, v))),
    smoothstep: (lo, hi, x) => zip([lo, hi, x], (l, h, v) => { const t = Math.min(1, Math.max(0, (v - l) / (h - l))); return t * t * (3 - 2 * t); }),
    step: (edge, x) => zip([edge, x], (e, v) => (v < e ? 0 : 1)),
    pow: (a, b) => zip([a, b], (x, y) => x ** y),
    min: (a, b) => zip([a, b], Math.min),
    max: (a, b) => zip([a, b], Math.max),
    atan: (a, b) => zip([a, b], Math.atan2),
    atan2: (a, b) => zip([a, b], Math.atan2),
    mod: (a, b) => zip([a, b], (x, y) => x - y * Math.floor(x / y)),
    dot: (a, b) => [a.reduce((sum, v, i) => sum + v * b[i], 0)],
    distance: (a, b) => [lengthOf(zip([a, b], (x, y) => x - y))],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    length: (a) => [lengthOf(a)],
    normalize: (a) => { const l = lengthOf(a); return a.map((v) => v / l); },
    abs: (a) => a.map(Math.abs), floor: (a) => a.map(Math.floor), ceil: (a) => a.map(Math.ceil), fract: (a) => a.map((v) => v - Math.floor(v)),
    sqrt: (a) => a.map(Math.sqrt), exp: (a) => a.map(Math.exp), log: (a) => a.map(Math.log), sign: (a) => a.map(Math.sign),
    sin: (a) => a.map(Math.sin), cos: (a) => a.map(Math.cos), tan: (a) => a.map(Math.tan), asin: (a) => a.map(Math.asin), acos: (a) => a.map(Math.acos),
    saturate: (a) => a.map((v) => Math.min(1, Math.max(0, v))),
    select: (f, t, c) => (c[0] ? t : f),
    float: (a) => [a[0]], f32: (a) => [a[0]], int: (a) => [Math.trunc(a[0])], i32: (a) => [Math.trunc(a[0])],
    vec2: (...a) => flat(a, 2), vec3: (...a) => flat(a, 3), vec4: (...a) => flat(a, 4),
    'vec2<f32>': (...a) => flat(a, 2), 'vec3<f32>': (...a) => flat(a, 3), 'vec4<f32>': (...a) => flat(a, 4),
    ivec2: (...a) => flat(a, 2).map(Math.trunc), 'vec2<i32>': (...a) => flat(a, 2).map(Math.trunc),
    hash1: (p, seed) => [hash1(p[0], p[1], Math.fround(seed[0]))], fn_hash1: (p, seed) => [hash1(p[0], p[1], Math.fround(seed[0]))],
    hashF: (x, seed) => [hashF(x[0], seed[0])], fn_hashF: (x, seed) => [hashF(x[0], seed[0])],
    perlin: (p, period, seed) => [perlin(Math.fround(p[0]), Math.fround(p[1]), period[0], period[1], Math.fround(seed[0]))],
    fn_perlin: (p, period, seed) => [perlin(Math.fround(p[0]), Math.fround(p[1]), period[0], period[1], Math.fround(seed[0]))],
};

/** Reads and works out one expression of the writers' forms. */
const evaluate = (source: string, names: Record<string, Value>, calls: Record<string, (...args: Value[]) => Value>): Value => {
    const tokens = source.match(/vec[234]<(?:f32|i32|u32|bool)>|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?[iu]?|[A-Za-z_]\w*|&&|\|\||==|!=|<=|>=|[-+*/<>!?:(),.]/g) ?? [];
    let at = 0;
    const peek = () => tokens[at];
    const take = (expected?: string) => {
        const token = tokens[at++];
        if (expected !== undefined && token !== expected) throw new Error(`Expected ${expected}, read ${token} in ${source}`);
        return token;
    };
    const truthy = (v: Value) => v[0] !== 0;
    const binary: Record<string, [number, (a: Value, b: Value) => Value]> = {
        '||': [2, (a, b) => [truthy(a) || truthy(b) ? 1 : 0]], '&&': [3, (a, b) => [truthy(a) && truthy(b) ? 1 : 0]],
        '==': [4, (a, b) => [a[0] === b[0] ? 1 : 0]], '!=': [4, (a, b) => [a[0] !== b[0] ? 1 : 0]],
        '<': [5, (a, b) => [a[0] < b[0] ? 1 : 0]], '<=': [5, (a, b) => [a[0] <= b[0] ? 1 : 0]], '>': [5, (a, b) => [a[0] > b[0] ? 1 : 0]], '>=': [5, (a, b) => [a[0] >= b[0] ? 1 : 0]],
        '+': [6, (a, b) => zip([a, b], (x, y) => x + y)], '-': [6, (a, b) => zip([a, b], (x, y) => x - y)],
        '*': [7, (a, b) => zip([a, b], (x, y) => x * y)], '/': [7, (a, b) => zip([a, b], (x, y) => x / y)],
    };
    const primary = (): Value => {
        const token = take();
        let value: Value;
        if (token === '(') { value = expression(0); take(')'); }
        else if (token === '-') value = primary().map((v) => -v);
        else if (token === '!') value = [truthy(primary()) ? 0 : 1];
        else if (/^[\d.]/.test(token)) value = [Number(token.replace(/[iu]$/, ''))];
        else if (token === 'true' || token === 'false') value = [token === 'true' ? 1 : 0];
        else if (peek() === '(') {
            take('(');
            const args: Value[] = [];
            while (peek() !== ')') { args.push(expression(0)); if (peek() === ',') take(','); }
            take(')');
            const call = calls[token] ?? BUILTINS[token];
            if (!call) throw new Error(`No function ${token}`);
            value = call(...args);
        } else {
            if (!(token in names)) throw new Error(`No name ${token} in ${source}`);
            value = names[token];
        }
        while (peek() === '.') {
            take('.');
            const mask = take();
            value = [...mask].map((letter) => value['xyzwrgba'.indexOf(letter) % 4]);
        }
        return value;
    };
    const expression = (least: number): Value => {
        let left = primary();
        for (;;) {
            const op = peek();
            if (op === '?' && least <= 1) {
                take('?');
                const yes = expression(1);
                take(':');
                const no = expression(1);
                left = truthy(left) ? yes : no;
                continue;
            }
            const entry = op ? binary[op] : undefined;
            if (!entry || entry[0] < least) return left;
            take();
            left = entry[1](left, expression(entry[0] + 1));
        }
    };
    const result = expression(0);
    if (at !== tokens.length) throw new Error(`Left over in ${source}: ${tokens.slice(at).join(' ')}`);
    return result;
};

interface Run { glsl: number[]; wgsl: number[]; cpu: number[] }

/** A compiled function written both ways and run each way, with the CPU's own run. */
const runAll = (ir: FunctionIr, env: FunctionEnv): Run => {
    const uv = env.uv ?? [0.5, 0.5];
    const pixel = env.pixel ?? [0, 0];
    const settings: Record<string, Value> = {};
    for (const [key, value] of Object.entries(env.settings ?? {})) settings[`p_${key}`] = Array.isArray(value) ? value.map(Number) : [typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)];
    const tiles = env.tiles ?? [true, true];
    const calls: Record<string, (...args: Value[]) => Value> = {
        c_a: (p) => [...(env.sample?.('a', [p[0], p[1]]) ?? [0, 0, 0, 1])], g_a: (p) => [env.gray?.('a', [p[0], p[1]]) ?? 0],
        tilePeriod: (cells) => [tiles[0] ? cells[0] : 1048576, tiles[1] ? cells[1] : 1048576],
        fn_tilePeriod: (cells) => [tiles[0] ? cells[0] : 1048576, tiles[1] ? cells[1] : 1048576],
    };
    const common = { ...settings };
    const glslNames: Record<string, Value> = {
        ...common, vUv: [...uv], gl_FragCoord: [pixel[0] + 0.5, pixel[1] + 0.5], uSize: [...(env.size ?? [1, 1])], uSeed: [env.seed ?? 0],
        uIteration: [env.iteration ?? 0], uIterations: [env.iterations ?? 1], uWorld: [...(env.world ?? [1, 1])], uTime: [env.time ?? 0], uPhase: [env.phase ?? 0],
    };
    const wgslNames: Record<string, Value> = {
        ...common, uv: [...uv], pixel: [pixel[0] + 0.5, pixel[1] + 0.5], u_size: [...(env.size ?? [1, 1])], u_seed: [env.seed ?? 0],
        u_iteration: [env.iteration ?? 0], u_iterations: [env.iterations ?? 1], u_world: [...(env.world ?? [1, 1])], u_tiles: [tiles[0] ? 1 : 0, tiles[1] ? 1 : 0],
        u_time: [env.time ?? 0], u_phase: [env.phase ?? 0],
    };
    const runLines = (code: string, names: Record<string, Value>, line: (text: string) => { type: string; name: string; expression: string } | null): number[] => {
        const locals = { ...names };
        for (const text of code.split('\n').slice(1, -1)) {
            const declared = line(text);
            if (declared) {
                const { type, name, expression } = declared;
                const value = evaluate(expression, locals, calls);
                locals[name] = type === 'int' || type === 'i32' ? value.map(Math.trunc) : value;
                continue;
            }
            const returned = /^\s*return (.*);$/.exec(text);
            if (returned) return evaluate(returned[1], locals, calls);
            throw new Error(`Unread line: ${text}`);
        }
        throw new Error('No return');
    };
    const glsl = runLines(glslFunction(ir), glslNames, (text) => {
        const found = /^\s*(\w+) (v\d+) = (.*);$/.exec(text);
        return found ? { type: found[1], name: found[2], expression: found[3] } : null;
    });
    const wgsl = runLines(wgslFunction(ir), wgslNames, (text) => {
        const found = /^\s*let (v\d+): ([\w<>]+) = (.*);$/.exec(text);
        return found ? { type: found[2], name: found[1], expression: found[3] } : null;
    });
    // The shaders give the result as a colour, as the GPU stores it.
    return { glsl, wgsl, cpu: asColour(ir.result.type, runFunction(ir, env)) };
};

const close = (actual: readonly number[], expected: readonly number[], label: string, digits = 4) => {
    expect(actual.length, label).toBe(expected.length);
    actual.forEach((value, index) => {
        if (!Number.isFinite(expected[index])) expect(Number.isFinite(value), label).toBe(false);
        else expect(value, `${label} [${index}]`).toBeCloseTo(expected[index], digits);
    });
};

/** A function graph from nodes (id, type, settings) and wires (from[.output] -> to.input). */
const graphOf = (nodes: Array<[string, string, Record<string, unknown>?]>, wires: string[]): FunctionGraph => {
    const made: FnNode[] = nodes.map(([id, type, params]) => ({ ...createFunctionNode(type, 0, 0, params ?? {}), id }));
    const links: FnLink[] = wires.map((wire) => {
        const [from, to] = wire.split('->').map((part) => part.trim());
        const [fromNode, fromOutput = 'out'] = from.split('.');
        const [toNode, toInput] = to.split('.');
        return { from: fromNode, fromOutput, to: toNode, toInput };
    });
    return { nodes: made, links };
};

const ENVS: FunctionEnv[] = [
    { uv: [0.23, 0.71], pixel: [117, 363], size: [512, 512], seed: 7.25, iteration: 2, iterations: 5, world: [2, 3], time: 1.25, phase: 0.3125 },
    { uv: [0.81, 0.07], pixel: [414, 35], size: [512, 512], seed: 101.5, iteration: 0, iterations: 1, world: [1, 1], tiles: [false, true] },
    { uv: [0.5, 0.5], pixel: [256, 256], size: [256, 128], seed: 0, iteration: 4, iterations: 8, world: [0.5, 0.5] },
];

describe('function graphs written as GLSL and WGSL, against the CPU', () => {
    it('every node gives the same numbers in both languages as on the CPU', () => {
        const skip = new Set([FN_RESULT_TYPE, FN_SETTING_TYPE, FN_SAMPLE_TYPE, FN_REROUTE_TYPE]);
        let checked = 0;
        for (const definition of FUNCTION_NODE_DEFINITIONS) {
            if (skip.has(definition.type)) continue;
            for (const output of definition.outputs) {
                // Unwired (its own numbers), and with its first number-taking input fed by the position.
                const variants: FunctionGraph[] = [graphOf([['n', definition.type], ['r', FN_RESULT_TYPE]], [`n.${output.key} -> r.value`])];
                const fed = definition.inputs.find((input) => input.type === 'auto' || input.type === 'vec2' || input.type === 'float');
                if (fed) {
                    variants.push(graphOf([['p', 'fnPosition'], ['k', 'fnNumber', { value: 0.37 }], ['m', 'fnMultiply'], ['n', definition.type], ['r', FN_RESULT_TYPE]],
                        [`p -> m.a`, 'k -> m.b', `${fed.type === 'float' ? 'm' : 'm'} -> n.${fed.key}`, `n.${output.key} -> r.value`]));
                }
                for (const graph of variants) {
                    const compiled = compileFunction(graph, { use: 'pixel' });
                    if (!compiled.ir) continue;
                    for (const env of ENVS) {
                        const run = runAll(compiled.ir, env);
                        close(run.glsl, run.cpu, `${definition.type}.${output.key} GLSL`);
                        close(run.wgsl, run.cpu, `${definition.type}.${output.key} WGSL`);
                        checked++;
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(150);
    });

    it('reads settings and pictures by the same names in both', () => {
        const settings: NamedSetting[] = [{ key: 'on', label: 'On', kind: 'bool', default: true }, { key: 'tint', label: 'Tint', kind: 'color', default: [1, 0, 0, 1] }, { key: 'count', label: 'Count', kind: 'int', default: 3 }];
        const graph = graphOf([
            ['on', FN_SETTING_TYPE, { setting: 'on' }], ['tint', FN_SETTING_TYPE, { setting: 'tint' }], ['count', FN_SETTING_TYPE, { setting: 'count' }],
            ['s', FN_SAMPLE_TYPE, { picture: 'a' }], ['mul', 'fnMultiply'], ['g', FN_SAMPLE_TYPE, { picture: 'a' }], ['add', 'fnAdd'], ['sel', 'fnSelect'], ['r', FN_RESULT_TYPE],
        ], ['s -> mul.a', 'tint -> mul.b', 'g.gray -> add.a', 'count -> add.b', 'on -> sel.test', 'mul -> sel.a', 's -> sel.b', 'sel -> r.value']);
        const ir = compileFunction(graph, { use: 'pixel', settings }).ir!;
        for (const on of [true, false]) {
            const env: FunctionEnv = { ...ENVS[0], settings: { on, tint: [0.2, 0.5, 1, 1], count: 3 }, sample: (_p, at) => [at[0], at[1], 0.3, 1], gray: (_p, at) => at[0] * 0.5 };
            const run = runAll(ir, env);
            close(run.glsl, run.cpu, 'GLSL');
            close(run.wgsl, run.cpu, 'WGSL');
        }
        const wgsl = wgslFunction(ir);
        expect(wgsl.startsWith('fn fn_result(uv: vec2<f32>, pixel: vec2<f32>) -> vec4<f32> {')).toBe(true);
        expect(wgsl).toContain('(p_on != 0i)');
        expect(wgsl).toContain('c_a(');
        expect(wgsl).not.toMatch(/\bvUv\b|\buSeed\b|\bvec[234]\(|\bfloat\(|\bint\(|\?/);
    });

    it('chains of random steps agree, whole numbers kept whole and remainders floored', () => {
        let state = 12345;
        const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
        const unary = ['fnSin', 'fnCos', 'fnFract', 'fnAbs', 'fnFloor', 'fnSaturate', 'fnOneMinus', 'fnRound', 'fnNegate', 'fnSign'];
        const binary = ['fnAdd', 'fnSubtract', 'fnMultiply', 'fnMin', 'fnMax', 'fnModulo', 'fnStep'];
        for (let trial = 0; trial < 40; trial++) {
            const nodes: Array<[string, string, Record<string, unknown>?]> = [['p', 'fnPosition'], ['k', 'fnNumber', { value: Number((random() * 6 - 3).toFixed(3)) }]];
            const wires: string[] = [];
            let last = 'p';
            for (let i = 0; i < 6; i++) {
                const id = `n${i}`;
                if (random() < 0.5) { nodes.push([id, unary[Math.floor(random() * unary.length)]]); wires.push(`${last} -> ${id}.a`); }
                else { nodes.push([id, binary[Math.floor(random() * binary.length)]]); wires.push(`${last} -> ${id}.a`, `${random() < 0.5 ? 'k' : 'p'} -> ${id}.b`); }
                last = id;
            }
            nodes.push(['r', FN_RESULT_TYPE]);
            wires.push(`${last} -> r.value`);
            const ir = compileFunction(graphOf(nodes, wires), { use: 'pixel' }).ir!;
            for (const env of ENVS) {
                const run = runAll(ir, env);
                close(run.glsl, run.cpu, `trial ${trial} GLSL`);
                close(run.wgsl, run.cpu, `trial ${trial} WGSL`);
            }
        }
        // Whole numbers divide as the GPU does (dropping what is left), in both.
        const ints = compileFunction(graphOf([['a', 'fnWhole', { value: -7 }], ['b', 'fnWhole', { value: 2 }], ['d', 'fnDivide'], ['r', FN_RESULT_TYPE]], ['a -> d.a', 'b -> d.b', 'd -> r.value']), { use: 'value' }).ir!;
        const run = runAll(ints, ENVS[0]);
        expect(run.cpu[0]).toBe(-3);
        expect(run.glsl[0]).toBe(-3);
        expect(run.wgsl[0]).toBe(-3);
    });
});

describe('the Noise node on the CPU', () => {
    it('is the shaders\' gradient noise, repeating every whole scale where the picture tiles', () => {
        const graph = graphOf([['p', 'fnPosition'], ['n', 'fnNoise', { in_scale: 5 }], ['r', FN_RESULT_TYPE]], ['p -> n.at', 'n -> r.value']);
        const ir = compileFunction(graph, { use: 'pixel' }).ir!;
        const at = (u: number, v: number, tiles: [boolean, boolean] = [true, true]) => runFunction(ir, { uv: [u, v], seed: 3.5, tiles })[0];
        // It varies, stays about -1 to 1, and its edges meet.
        const samples = Array.from({ length: 50 }, (_, i) => at((i * 0.137) % 1, (i * 0.291) % 1));
        expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
        for (const value of samples) expect(Math.abs(value)).toBeLessThanOrEqual(1.5);
        for (const t of [0.13, 0.47, 0.88]) {
            expect(at(0, t)).toBeCloseTo(at(1, t), 6);
            expect(at(t, 0)).toBeCloseTo(at(t, 1), 6);
        }
        // Not tiling, the noise runs on past the edge.
        expect(Math.abs(at(0, 0.47, [false, false]) - at(1, 0.47, [false, false]))).toBeGreaterThan(1e-4);
        expect(functionNoise([0.3, 0.6], 4, 2)).toBeCloseTo(perlin(Math.fround(1.2), Math.fround(2.4), 4, 4, 2), 9);
    });

    it('the WGSL helpers say the GLSL library\'s hashes and noise', () => {
        const library = wgslFunctionLibrary();
        for (const name of ['fn_hashU', 'fn_hash1', 'fn_hashF', 'fn_wrapCell', 'fn_tilePeriod', 'fn_perlin']) expect(library).toContain(`fn ${name}(`);
        expect(library).toContain('0x7feb352du');
        expect(library).toContain('0x846ca68bu');
        expect(library).toContain('1.41421356');
        expect(wgslFunctionLibrary({ tiles: 'tiling' })).toContain('tiling.x == 1i');
    });
});
