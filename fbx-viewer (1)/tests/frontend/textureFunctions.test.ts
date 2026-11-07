import { describe, expect, it } from 'vitest';
import {
    FN_RESULT_TYPE,
    FUNCTION_NODE_DEFINITIONS,
    asColour,
    compileFunction,
    createFunctionNode,
    defaultPixelFunction,
    fallbackKey,
    glslFunction,
    readFunctionGraph,
    runFunction,
    type FnLink,
    type FnNode,
    type FunctionGraph,
    type NamedSetting,
} from '../../texturing/graph/functionGraph';
import { hash1 } from '../../texturing/graph/scatter';

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

const close = (actual: readonly number[], expected: readonly number[], digits = 5) => {
    expect(actual.length).toBe(expected.length);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
};

describe('function graphs: compiling and running on the CPU', () => {
    it('works out arithmetic place by place, numbers filling vectors, against plain maths', () => {
        // (position * 2 + 0.25) mixed toward (1, 0) by a setting, then its length.
        const graph = graphOf([
            ['p', 'fnPosition'], ['two', 'fnNumber', { value: 2 }], ['mul', 'fnMultiply'], ['add', 'fnAdd', { [fallbackKey('b')]: 0.25 }],
            ['target', 'fnVector2', { value: [1, 0] }], ['amount', 'fnSetting', { setting: 'amount' }], ['mix', 'fnMix'], ['len', 'fnLength'], ['r', FN_RESULT_TYPE],
        ], ['p -> mul.a', 'two -> mul.b', 'mul -> add.a', 'add -> mix.a', 'target -> mix.b', 'amount -> mix.t', 'mix -> len.a', 'len -> r.value']);
        const settings: NamedSetting[] = [{ key: 'amount', label: 'Amount', kind: 'float', default: 0.5 }];
        const compiled = compileFunction(graph, { use: 'pixel', settings });
        expect(compiled.error).toBeNull();
        for (const [u, v, t] of [[0.1, 0.7, 0.3], [0.9, 0.2, 0], [0.5, 0.5, 1]]) {
            const reference = (() => {
                const ax = u * 2 + 0.25;
                const ay = v * 2 + 0.25;
                const mx = ax + (1 - ax) * t;
                const my = ay + (0 - ay) * t;
                return Math.hypot(mx, my);
            })();
            close(runFunction(compiled.ir!, { uv: [u, v], settings: { amount: t } }), [reference]);
        }
        expect(compiled.ir!.settings).toEqual(['amount']);
        expect(compiled.types.get('mix')).toEqual({ out: 'vec2' });
        expect(compiled.types.get('len')).toEqual({ out: 'float' });
    });

    it('splits, joins, reorders, compares and selects', () => {
        const graph = graphOf([
            ['c', 'fnColour', { value: [0.2, 0.4, 0.6, 1] }], ['split', 'fnSplit'], ['cmp', 'fnCompare', { test: 'gt' }], ['sel', 'fnSelect'],
            ['swz', 'fnSwizzle', { mask: 'bgr' }], ['join', 'fnJoin4'], ['r', FN_RESULT_TYPE],
        ], ['c -> split.a', 'split.x -> cmp.a', 'split.y -> cmp.b', 'cmp -> sel.test', 'c -> swz.a', 'swz -> sel.a', 'c -> sel.b', 'sel -> r.value']);
        // 0.2 > 0.4 is no: the colour as it is, alpha dropped by Select's mix of a 3- and 4-number value is refused.
        const refused = compileFunction(graph, { use: 'pixel' });
        expect(refused.error).toMatch(/three-number and four-number/);
        expect(refused.errors.get('sel')).toMatch(/split or join/);
        const fixed = graphOf([
            ['c', 'fnColour', { value: [0.2, 0.4, 0.6, 1] }], ['split', 'fnSplit'], ['cmp', 'fnCompare', { test: 'lt' }], ['sel', 'fnSelect'],
            ['swz', 'fnSwizzle', { mask: 'bgra' }], ['r', FN_RESULT_TYPE],
        ], ['c -> split.a', 'split.x -> cmp.a', 'split.y -> cmp.b', 'cmp -> sel.test', 'c -> swz.a', 'swz -> sel.a', 'c -> sel.b', 'sel -> r.value']);
        const compiled = compileFunction(fixed, { use: 'pixel' });
        expect(compiled.error).toBeNull();
        // 0.2 < 0.4: yes, so the reordered colour.
        close(runFunction(compiled.ir!), [0.6, 0.4, 0.2, 1]);
        const joined = graphOf([['x', 'fnNumber', { value: 3 }], ['join', 'fnJoin3', { [fallbackKey('z')]: 5 }], ['r', FN_RESULT_TYPE]], ['x -> join.y', 'join -> r.value']);
        close(runFunction(compileFunction(joined, { use: 'value' }).ir!), [0, 3, 5]);
    });

    it('keeps whole numbers whole, and divides them as the GPU does', () => {
        const graph = graphOf([['a', 'fnWhole', { value: 7 }], ['b', 'fnWhole', { value: 2 }], ['div', 'fnDivide'], ['r', FN_RESULT_TYPE]], ['a -> div.a', 'b -> div.b', 'div -> r.value']);
        const compiled = compileFunction(graph, { use: 'value' });
        expect(compiled.types.get('div')).toEqual({ out: 'int' });
        expect(runFunction(compiled.ir!)).toEqual([3]);
        expect(asColour('int', [3])).toEqual([3, 3, 3, 1]);
        const mixed = graphOf([['a', 'fnWhole', { value: 7 }], ['b', 'fnNumber', { value: 2 }], ['div', 'fnDivide'], ['r', FN_RESULT_TYPE]], ['a -> div.a', 'b -> div.b', 'div -> r.value']);
        expect(runFunction(compileFunction(mixed, { use: 'value' }).ir!)).toEqual([3.5]);
    });

    it('reads pictures and settings, and makes the same random numbers as the GPU hash', () => {
        const graph = graphOf([['s', 'fnSample', { picture: 'b' }], ['rand', 'fnRandom', { salt: 3 }], ['add', 'fnAdd'], ['r', FN_RESULT_TYPE]], ['s.gray -> add.a', 'rand -> add.b', 'add -> r.value']);
        const compiled = compileFunction(graph, { use: 'pixel', pictures: ['a', 'b'] });
        expect(compiled.ir!.pictures).toEqual(['b']);
        const uv: [number, number] = [0.25, 0.75];
        const value = runFunction(compiled.ir!, { uv, seed: 101.5, gray: (picture, at) => (picture === 'b' ? at[0] + at[1] : -1) });
        close(value, [1 + hash1(Math.floor(0.25 * 4096), Math.floor(0.75 * 4096), 104.5)]);
        expect(compileFunction(graph, { use: 'pixel', pictures: ['a'] }).errors.get('s')).toMatch(/no picture B/);
    });

    it('refuses per-pixel nodes in a Value processor, and names what is wrong', () => {
        const graph = graphOf([['p', 'fnPosition'], ['r', FN_RESULT_TYPE]], ['p -> r.value']);
        const compiled = compileFunction(graph, { use: 'value' });
        expect(compiled.error).toMatch(/only for each pixel/);
        expect(compileFunction(graph, { use: 'pixel' }).error).toBeNull();
        const gone = graphOf([['s', 'fnSetting', { setting: 'gone' }], ['r', FN_RESULT_TYPE]], ['s -> r.value']);
        expect(compileFunction(gone, { use: 'pixel' }).error).toMatch(/gone from the processor/);
    });

    it('previews any step on its own: a node\'s output made the result', () => {
        const graph = graphOf([['p', 'fnPosition'], ['split', 'fnSplit'], ['sin', 'fnSin'], ['r', FN_RESULT_TYPE]], ['p -> split.a', 'split.y -> sin.a', 'sin -> r.value']);
        const preview = compileFunction(graph, { use: 'pixel', target: { node: 'split', output: 'y' } });
        close(runFunction(preview.ir!, { uv: [0.3, 0.8] }), [0.8]);
        close(runFunction(compileFunction(graph, { use: 'pixel' }).ir!, { uv: [0.3, 0.8] }), [Math.sin(0.8)]);
        // Only the steps the preview needs.
        expect(preview.ir!.steps.some((step) => step.op === 'sin')).toBe(false);
    });
});

describe('function graphs: GLSL', () => {
    it('writes one typed line a step and gives the result as a colour', () => {
        const graph = graphOf([
            ['p', 'fnPosition'], ['k', 'fnNumber', { value: 0.5 }], ['sub', 'fnSubtract'], ['len', 'fnLength'], ['st', 'fnSmoothstep', { [fallbackKey('low')]: 0.1, [fallbackKey('high')]: 0.3 }], ['r', FN_RESULT_TYPE],
        ], ['p -> sub.a', 'k -> sub.b', 'sub -> len.a', 'len -> st.a', 'st -> r.value']);
        const compiled = compileFunction(graph, { use: 'pixel' });
        const glsl = glslFunction(compiled.ir!);
        expect(glsl.startsWith('vec4 fn_result() {')).toBe(true);
        expect(glsl).toContain('= vUv;');
        expect(glsl).toMatch(/vec2 v\d+ = vec2\(v\d+\);/);
        expect(glsl).toMatch(/float v\d+ = length\(v\d+\);/);
        expect(glsl).toMatch(/smoothstep\(v\d+, v\d+, v\d+\)/);
        expect(glsl).toMatch(/return vec4\(vec3\(v\d+\), 1\.0\);/);
        // Floats always read as floats.
        expect(glsl).toContain('0.5;');
        expect(glsl).not.toMatch(/= 1;|= 0;/);
    });

    it('reads settings, pictures, seeds and passes by the kit\'s names', () => {
        const graph = graphOf([
            ['on', 'fnSetting', { setting: 'on' }], ['tint', 'fnSetting', { setting: 'tint' }], ['s', 'fnSample', { picture: 'a' }], ['mul', 'fnMultiply'],
            ['pass', 'fnPass'], ['sel', 'fnSelect'], ['r', FN_RESULT_TYPE],
        ], ['s -> mul.a', 'tint -> mul.b', 'on -> sel.test', 'mul -> sel.a', 's -> sel.b', 'sel -> r.value']);
        const settings: NamedSetting[] = [{ key: 'on', label: 'On', kind: 'bool', default: true }, { key: 'tint', label: 'Tint', kind: 'color', default: [1, 0, 0, 1] }];
        const glsl = glslFunction(compileFunction(graph, { use: 'pixel', settings }).ir!);
        expect(glsl).toContain('(p_on != 0)');
        expect(glsl).toContain('= p_tint;');
        expect(glsl).toContain('c_a(');
        expect(glsl).toMatch(/return v\d+;/);
        const passes = glslFunction(compileFunction(graphOf([['pass', 'fnPass'], ['r', FN_RESULT_TYPE]], ['pass -> r.value']), { use: 'value' }).ir!);
        expect(passes).toContain('int v0 = uIteration;');
        expect(passes).toContain('vec4(vec3(float(v0)), 1.0)');
    });
});

describe('function graphs: reading', () => {
    it('keeps one Result, one wire an input, and no loops', () => {
        const base = defaultPixelFunction();
        const [sample, result] = base.nodes;
        const extraResult = { ...createFunctionNode(FN_RESULT_TYPE, 0, 0), id: 'r2' };
        const read = readFunctionGraph({
            nodes: [...base.nodes, extraResult, { id: 'bad' }],
            links: [...base.links, { from: sample.id, fromOutput: 'gray', to: result.id, toInput: 'value' }, { from: result.id, fromOutput: 'x', to: sample.id, toInput: 'at' }, { from: sample.id, fromOutput: 'out', to: sample.id, toInput: 'at' }],
        });
        expect(read.nodes.filter((node) => node.type === FN_RESULT_TYPE)).toHaveLength(1);
        expect(read.links).toHaveLength(1);
        expect(readFunctionGraph({ nodes: [], links: [] }).nodes.map((node) => node.type)).toEqual([FN_RESULT_TYPE]);
        expect(readFunctionGraph(null).nodes.length).toBe(2);
    });

    it('gives every node a label, a category and a description', () => {
        for (const definition of FUNCTION_NODE_DEFINITIONS) {
            expect(definition.label).toBeTruthy();
            expect(definition.description.length).toBeGreaterThan(10);
        }
        expect(new Set(FUNCTION_NODE_DEFINITIONS.map((definition) => definition.type)).size).toBe(FUNCTION_NODE_DEFINITIONS.length);
    });
});
