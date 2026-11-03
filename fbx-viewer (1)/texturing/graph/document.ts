import { evaluateExpression, type ExprValue } from './expressions';
import { INPUT_NODE_TYPE, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from './nodes/io';
import { textureNodeDefinitionByType } from './registry';
import {
    isParamLink,
    type GraphParameter,
    type GraphParameterKind,
    type NodeSize,
    type TexGraphComment,
    type TexGraphLink,
    type TexGraphNode,
    type TexNodeDef,
    type TexParamDef,
    type TextureGraph,
} from './types';

/**
 * TEXTURE GRAPH DOCUMENTS
 *
 * Making, checking and reading texture graphs as the project stores them, and working out a node's
 * settings from the graph's parameters.
 */

export const MAX_NODES = 1500;
export const MIN_SIZE_LOG2 = 4;
export const MAX_SIZE_LOG2 = 13;
export const DEFAULT_SIZE_LOG2 = 10;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

let counter = 0;
export const newNodeId = (prefix = 'n'): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const defaultNodeParams = (definition: TexNodeDef): Record<string, unknown> =>
    Object.fromEntries(definition.params.map((param) => [param.key, structuredClone(param.default)]));

export const createNode = (type: string, x: number, y: number, params: Record<string, unknown> = {}): TexGraphNode => {
    const definition = textureNodeDefinitionByType(type);
    return { id: newNodeId(), type, x, y, params: { ...(definition ? defaultNodeParams(definition) : {}), ...params } };
};

/** A new material graph: every engine channel has an Output, fed by simple starting values. */
export const createTextureGraph = (): TextureGraph => {
    const nodes: TexGraphNode[] = [];
    const links: TexGraphLink[] = [];
    const add = (type: string, x: number, y: number, params: Record<string, unknown> = {}) => {
        const node = createNode(type, x, y, params);
        nodes.push(node);
        return node;
    };
    const wire = (from: TexGraphNode, to: TexGraphNode, toInput = 'in', fromOutput = 'out') => links.push({ from: from.id, fromOutput, to: to.id, toInput });
    const height = add('fractalSum', 40, 260, { scale: 4, octaves: 5 });
    const color = add('gradientMap', 320, 40);
    const normal = add('normalFromHeight', 320, 260, { intensity: 3 });
    const ao = add('aoFromHeight', 320, 480, { depth: 0.05 });
    const roughness = add('uniformValue', 320, 700, { value: 0.6 });
    const metallic = add('uniformValue', 320, 880, { value: 0 });
    wire(height, color);
    wire(height, normal);
    wire(height, ao);
    const y = [40, 260, 480, 700, 880, 1060];
    const outputs = (['baseColor', 'normal', 'ambientOcclusion', 'roughness', 'metallic', 'height'] as const).map((channel, index) => add(OUTPUT_NODE_TYPE, 620, y[index], { channel, name: '' }));
    wire(color, outputs[0]);
    wire(normal, outputs[1]);
    wire(ao, outputs[2]);
    wire(roughness, outputs[3]);
    wire(metallic, outputs[4]);
    wire(height, outputs[5]);
    return { version: 1, size: { w: DEFAULT_SIZE_LOG2, h: DEFAULT_SIZE_LOG2 }, seed: 0, nodes, links, parameters: [] };
};

/** A blank graph for masks and filters used inside other graphs: one grey input, one output. */
export const createFunctionGraph = (): TextureGraph => {
    const input = createNode(INPUT_NODE_TYPE, 40, 120, { name: 'input', kind: 'gray', fallback: 'black' });
    const output = createNode(OUTPUT_NODE_TYPE, 420, 120, { channel: 'custom', name: 'Result' });
    return { version: 1, size: { w: DEFAULT_SIZE_LOG2, h: DEFAULT_SIZE_LOG2 }, seed: 0, nodes: [input, output], links: [{ from: input.id, fromOutput: 'out', to: output.id, toInput: 'in' }], parameters: [] };
};

const readSize = (value: unknown): NodeSize | undefined => {
    const size = value as Partial<NodeSize> | null;
    if (!size || typeof size !== 'object') return undefined;
    const mode = size.mode === 'graph' || size.mode === 'absolute' ? size.mode : 'input';
    const low = mode === 'absolute' ? MIN_SIZE_LOG2 : -6;
    const high = mode === 'absolute' ? MAX_SIZE_LOG2 : 4;
    return { mode, w: clamp(Math.round(finite(size.w, mode === 'absolute' ? DEFAULT_SIZE_LOG2 : 0)), low, high), h: clamp(Math.round(finite(size.h, mode === 'absolute' ? DEFAULT_SIZE_LOG2 : 0)), low, high) };
};

const readParameter = (value: unknown): GraphParameter | null => {
    const parameter = value as Partial<GraphParameter> | null;
    if (!parameter || typeof parameter.name !== 'string' || !PARAMETER_NAME.test(parameter.name)) return null;
    const kinds: GraphParameterKind[] = ['float', 'int', 'bool', 'color', 'vec2', 'select'];
    const kind = kinds.includes(parameter.kind as GraphParameterKind) ? parameter.kind as GraphParameterKind : 'float';
    const options = Array.isArray(parameter.options)
        ? parameter.options.filter((option) => option && typeof option.value === 'string').slice(0, 32).map((option) => ({ value: option.value.slice(0, 64), label: String(option.label ?? option.value).slice(0, 64) }))
        : undefined;
    const result: GraphParameter = {
        name: parameter.name,
        label: typeof parameter.label === 'string' && parameter.label.trim() ? parameter.label.trim().slice(0, 64) : parameter.name,
        kind,
        default: coerceParameter(kind, parameter.default, options),
    };
    if (typeof parameter.min === 'number' && Number.isFinite(parameter.min)) result.min = parameter.min;
    if (typeof parameter.max === 'number' && Number.isFinite(parameter.max)) result.max = parameter.max;
    if (typeof parameter.step === 'number' && Number.isFinite(parameter.step) && parameter.step > 0) result.step = parameter.step;
    if (options?.length) result.options = options;
    if (typeof parameter.group === 'string' && parameter.group.trim()) result.group = parameter.group.trim().slice(0, 64);
    if (typeof parameter.description === 'string' && parameter.description.trim()) result.description = parameter.description.trim().slice(0, 256);
    return result;
};

/** A parameter value of the right shape for its kind. */
export const coerceParameter = (kind: GraphParameterKind, value: unknown, options?: ReadonlyArray<{ value: string }>): GraphParameter['default'] => {
    switch (kind) {
        case 'bool': return Boolean(value);
        case 'int': return Math.round(finite(value, 0));
        case 'color': {
            const c = Array.isArray(value) ? value : [0.5, 0.5, 0.5, 1];
            return [0, 1, 2, 3].map((i) => clamp(finite(c[i], i === 3 ? 1 : 0.5), 0, 1));
        }
        case 'vec2': {
            const v = Array.isArray(value) ? value : [0, 0];
            return [finite(v[0], 0), finite(v[1], 0)];
        }
        case 'select': return typeof value === 'string' && (!options || options.some((option) => option.value === value)) ? value : options?.[0]?.value ?? '';
        default: return finite(value, 0);
    }
};

/** A stored graph made safe to use, or a fresh one when it is not a graph. */
export const normalizeTextureGraph = (value: unknown): TextureGraph => {
    const raw = value as Partial<TextureGraph> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return createTextureGraph();
    const ids = new Set<string>();
    const nodes: TexGraphNode[] = [];
    for (const candidate of raw.nodes.slice(0, MAX_NODES)) {
        const node = candidate as Partial<TexGraphNode> | null;
        if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.type !== 'string') continue;
        if (node.type !== SUBGRAPH_NODE_TYPE && !textureNodeDefinitionByType(node.type)) continue;
        ids.add(node.id);
        const definition = textureNodeDefinitionByType(node.type);
        const params = { ...(definition ? defaultNodeParams(definition) : {}), ...(node.params && typeof node.params === 'object' ? node.params : {}) };
        const result: TexGraphNode = { id: node.id, type: node.type, x: finite(node.x, 0), y: finite(node.y, 0), params };
        const size = readSize(node.size);
        if (size) result.size = size;
        if (node.precision === 8 || node.precision === 16 || node.precision === 32) result.precision = node.precision;
        nodes.push(result);
    }
    const links: TexGraphLink[] = [];
    const taken = new Set<string>();
    for (const candidate of Array.isArray(raw.links) ? raw.links : []) {
        const link = candidate as Partial<TexGraphLink> | null;
        if (!link || typeof link.from !== 'string' || typeof link.to !== 'string' || typeof link.fromOutput !== 'string' || typeof link.toInput !== 'string') continue;
        if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) continue;
        // One wire into an input.
        const key = `${link.to}:${link.toInput}`;
        if (taken.has(key)) continue;
        taken.add(key);
        links.push({ from: link.from, fromOutput: link.fromOutput, to: link.to, toInput: link.toInput });
    }
    const comments: TexGraphComment[] = [];
    for (const candidate of Array.isArray(raw.comments) ? raw.comments : []) {
        const comment = candidate as Partial<TexGraphComment> | null;
        if (!comment || typeof comment.id !== 'string') continue;
        comments.push({
            id: comment.id,
            x: finite(comment.x, 0),
            y: finite(comment.y, 0),
            width: clamp(finite(comment.width, 300), 40, 20000),
            height: clamp(finite(comment.height, 200), 40, 20000),
            text: typeof comment.text === 'string' ? comment.text.slice(0, 500) : '',
            color: typeof comment.color === 'string' && /^#[0-9a-f]{6}$/i.test(comment.color) ? comment.color : '#3b4252',
        });
    }
    const parameters: GraphParameter[] = [];
    for (const candidate of Array.isArray(raw.parameters) ? raw.parameters.slice(0, 128) : []) {
        const parameter = readParameter(candidate);
        if (parameter && !parameters.some((existing) => existing.name === parameter.name)) parameters.push(parameter);
    }
    const graph: TextureGraph = {
        version: 1,
        size: { w: clamp(Math.round(finite(raw.size?.w, DEFAULT_SIZE_LOG2)), MIN_SIZE_LOG2, MAX_SIZE_LOG2), h: clamp(Math.round(finite(raw.size?.h, DEFAULT_SIZE_LOG2)), MIN_SIZE_LOG2, MAX_SIZE_LOG2) },
        seed: clamp(Math.round(finite(raw.seed, 0)), 0, 999),
        nodes,
        links: dropCycles(nodes, links),
        parameters,
    };
    if (comments.length) graph.comments = comments;
    return graph;
};

/** True when wiring `from` into `to` would make a loop. */
export const wouldCycle = (graph: Pick<TextureGraph, 'nodes' | 'links'>, from: string, to: string): boolean => {
    if (from === to) return true;
    const downstream = new Map<string, string[]>();
    for (const link of graph.links) {
        const list = downstream.get(link.from);
        if (list) list.push(link.to);
        else downstream.set(link.from, [link.to]);
    }
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
        const current = stack.pop()!;
        if (current === from) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of downstream.get(current) ?? []) stack.push(next);
    }
    return false;
};

/** The links in order, leaving out any that would close a loop. */
const dropCycles = (nodes: readonly TexGraphNode[], links: readonly TexGraphLink[]): TexGraphLink[] => {
    const kept: TexGraphLink[] = [];
    for (const link of links) if (!wouldCycle({ nodes: nodes as TexGraphNode[], links: kept }, link.from, link.to)) kept.push(link);
    return kept;
};

// ---------------------------------------------------------------------------
// Parameters and settings
// ---------------------------------------------------------------------------

/** Each parameter's value: the graph's default, or the given one. */
export const parameterValues = (graph: TextureGraph, given: Readonly<Record<string, unknown>> = {}): Record<string, GraphParameter['default']> => {
    const values: Record<string, GraphParameter['default']> = {};
    for (const parameter of graph.parameters) {
        const value = given[parameter.name];
        values[parameter.name] = value === undefined ? parameter.default : coerceParameter(parameter.kind, value, parameter.options);
    }
    return values;
};

/** What formulas see: each parameter as a number or vector, the graph's size and seed. */
export const formulaScope = (graph: TextureGraph, values: Readonly<Record<string, unknown>>, width: number, height: number): Record<string, ExprValue> => {
    const scope: Record<string, ExprValue> = { $size: width, $width: width, $height: height, $seed: graph.seed };
    for (const parameter of graph.parameters) {
        const value = values[parameter.name];
        if (typeof value === 'number') scope[parameter.name] = value;
        else if (typeof value === 'boolean') scope[parameter.name] = value ? 1 : 0;
        else if (Array.isArray(value)) scope[parameter.name] = value.map(Number);
        else if (typeof value === 'string') scope[parameter.name] = Math.max(0, parameter.options?.findIndex((option) => option.value === value) ?? 0);
    }
    return scope;
};

/** A setting's value made the right shape for it (and inside its limits). */
export const coerceParam = (param: TexParamDef, value: unknown): unknown => {
    switch (param.kind) {
        case 'float': {
            const v = typeof value === 'number' ? value : Array.isArray(value) ? Number(value[0]) : Number(value);
            return clamp(Number.isFinite(v) ? v : (param.default as number), param.min ?? -Infinity, param.max ?? Infinity);
        }
        case 'int': {
            const v = typeof value === 'number' ? value : Array.isArray(value) ? Number(value[0]) : Number(value);
            return clamp(Math.round(Number.isFinite(v) ? v : (param.default as number)), param.min ?? -Infinity, param.max ?? Infinity);
        }
        case 'bool': return Array.isArray(value) ? Boolean(value[0]) : Boolean(value);
        case 'select': {
            if (typeof value === 'number') return param.options?.[clamp(Math.round(value), 0, (param.options?.length ?? 1) - 1)]?.value ?? param.default;
            return param.options?.some((option) => option.value === value) ? value : param.default;
        }
        case 'color': {
            const c = typeof value === 'number' ? [value, value, value, 1] : Array.isArray(value) ? value : (param.default as number[]);
            return [0, 1, 2, 3].map((i) => clamp(finite(Number(c[i]), i === 3 ? 1 : 0), 0, 1));
        }
        case 'vec2': {
            const v = typeof value === 'number' ? [value, value] : Array.isArray(value) ? value : (param.default as number[]);
            return [0, 1].map((i) => clamp(finite(Number(v[i]), 0), param.min ?? -Infinity, param.max ?? Infinity));
        }
        case 'string':
        case 'code':
        case 'texture':
        case 'graph':
            return typeof value === 'string' ? value : param.default;
        default:
            return value ?? structuredClone(param.default);
    }
};

/**
 * A node's settings with links to the graph's parameters followed. A formula that does not read
 * leaves the setting's own default, and says why in `problems`.
 */
export const resolveNodeParams = (
    definition: TexNodeDef,
    node: TexGraphNode,
    values: Readonly<Record<string, unknown>>,
    scope: Readonly<Record<string, ExprValue>>,
    problems?: string[],
): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const param of definition.params) {
        const raw = node.params[param.key];
        let value: unknown = raw === undefined ? param.default : raw;
        if (isParamLink(value)) {
            if ('$bind' in value) {
                value = values[value.$bind];
                if (value === undefined) {
                    problems?.push(`"${param.label}" follows a parameter that is gone.`);
                    value = param.default;
                }
            } else {
                try {
                    value = evaluateExpression(value.$expr, scope);
                } catch (error) {
                    problems?.push(`"${param.label}": ${error instanceof Error ? error.message : 'the formula does not read'}.`);
                    value = param.default;
                }
            }
        }
        result[param.key] = coerceParam(param, value);
    }
    return result;
};

/** Short, stable text hash (FNV-1a, 52 bits), for telling results apart. */
export const hashText = (text: string): string => {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
};

/** Every project texture a graph draws from (Bitmap nodes), for keeping them while it does. */
export const graphTextureIds = (graph: TextureGraph): string[] => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
        const definition = textureNodeDefinitionByType(node.type);
        for (const param of definition?.params ?? []) {
            const value = node.params[param.key];
            if (param.kind === 'texture' && typeof value === 'string' && value) ids.add(value);
        }
    }
    return [...ids];
};

/** The graphs a graph uses as nodes. */
export const graphDependencies = (graph: TextureGraph): string[] =>
    [...new Set(graph.nodes.filter((node) => node.type === SUBGRAPH_NODE_TYPE && typeof node.params.graph === 'string' && node.params.graph).map((node) => node.params.graph as string))];
