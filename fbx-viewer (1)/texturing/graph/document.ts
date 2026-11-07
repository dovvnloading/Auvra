import { evaluateExpression, type ExprValue } from './expressions';
import { GRAPH_USING_TYPES, INPUT_NODE_TYPE, MESH_READING_NODE_TYPES, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from './nodes/io';
import { migrateProcessorParams } from './nodes/processors';
import { PARAMETER_KINDS, RANGED_KINDS, coerceParameter, conditionScope, readGroups, readPresets } from './parameters';
import { textureNodeDefinitionByType } from './registry';
import {
    isParamLink,
    SHOWN_ONLY_FIELDS,
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

/** Nodes a graph opens with at most: far past what the canvas and the GPU can work with, so only a broken file reaches it. */
export const MAX_NODES = 20000;
export const MAX_PARAMETERS = 128;
export const MIN_SIZE_LOG2 = 4;
export const MAX_SIZE_LOG2 = 13;
export const DEFAULT_SIZE_LOG2 = 10;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * Whole numbers hashed together into one (32 bits, unsigned): every input bit reaches every output
 * bit, so neighbouring seeds give unrelated results and no two pairs line up the way a sum would.
 */
export const mixSeeds = (...parts: number[]): number => {
    let h = 0x9e3779b9;
    for (const part of parts) {
        h = Math.imul(h ^ (Math.round(Number.isFinite(part) ? part : 0) >>> 0), 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
    }
    return h >>> 0;
};

/** A text (a node's name) as a whole number for mixing into seeds. */
export const seedOfText = (text: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
};

/**
 * The seed a node's shaders see: its graph's seed and its own hashed together. Shaders add small
 * steps to it (seed + 1.0, seed + 13.17 * octave), so it is kept under 2^20, where a 32-bit float
 * still tells those steps apart; the half keeps it off whole numbers.
 */
export const shaderSeed = (graphSeed: number, nodeSeed: number): number => (mixSeeds(graphSeed, nodeSeed) & 0xfffff) + 0.5;

/**
 * The seed a graph used as a node runs with. Each copy mixes in the seed of the graph it sits in and
 * its own name, so copies look different (and change with the outer graph's seed); a copy set not to
 * vary takes its look from its own seed alone, so copies with one seed match.
 */
export const subgraphRunSeed = (outerSeed: number, nodeId: string, ownSeed: number, vary: boolean, innerGraphSeed: number): number =>
    vary ? mixSeeds(outerSeed, seedOfText(nodeId), ownSeed, innerGraphSeed) : mixSeeds(innerGraphSeed, ownSeed);

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
    const output = createNode(OUTPUT_NODE_TYPE, 420, 120, { channel: 'custom', name: 'Result', kind: 'gray' });
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

export { coerceParameter } from './parameters';

const readParameter = (value: unknown): GraphParameter | null => {
    const parameter = value as Partial<GraphParameter> | null;
    if (!parameter || typeof parameter.name !== 'string' || !PARAMETER_NAME.test(parameter.name)) return null;
    const kind = PARAMETER_KINDS.includes(parameter.kind as GraphParameterKind) ? parameter.kind as GraphParameterKind : 'float';
    const options = Array.isArray(parameter.options)
        ? parameter.options.filter((option) => option && typeof option.value === 'string').slice(0, 32).map((option) => ({ value: option.value.slice(0, 64), label: String(option.label ?? option.value).slice(0, 64) }))
        : undefined;
    const result: GraphParameter = {
        name: parameter.name,
        label: typeof parameter.label === 'string' && parameter.label.trim() ? parameter.label.trim().slice(0, 64) : parameter.name,
        kind,
        default: coerceParameter(kind, parameter.default, options),
    };
    if (RANGED_KINDS.has(kind)) {
        const number = (key: 'min' | 'max' | 'softMin' | 'softMax') => (typeof parameter[key] === 'number' && Number.isFinite(parameter[key]) ? parameter[key] as number : undefined);
        const min = number('min');
        const max = number('max');
        if (min !== undefined) result.min = min;
        if (max !== undefined && (min === undefined || max >= min)) result.max = max;
        // The slider's ends lie inside the hard limits.
        const softMin = number('softMin');
        const softMax = number('softMax');
        const inside = (x: number) => Math.min(result.max ?? Infinity, Math.max(result.min ?? -Infinity, x));
        if (softMin !== undefined) result.softMin = inside(softMin);
        if (softMax !== undefined && (result.softMin === undefined || inside(softMax) > result.softMin)) result.softMax = inside(softMax);
    }
    if (typeof parameter.step === 'number' && Number.isFinite(parameter.step) && parameter.step > 0) result.step = parameter.step;
    if (typeof parameter.visibleIf === 'string' && parameter.visibleIf.trim()) result.visibleIf = parameter.visibleIf.trim().slice(0, 200);
    if (options?.length) result.options = options;
    if (typeof parameter.group === 'string' && parameter.group.trim()) result.group = parameter.group.trim().slice(0, 64);
    if (typeof parameter.description === 'string' && parameter.description.trim()) result.description = parameter.description.trim().slice(0, 256);
    return result;
};


/**
 * A stored graph made safe to use, with what had to be left out of it said in words. Nodes of a type
 * this build does not know are kept as they are, settings and wires included, so a build that knows
 * them draws them again; the editor shows them as placeholders.
 */
export const readTextureGraph = (value: unknown): { graph: TextureGraph; problems: string[] } => {
    const raw = value as Partial<TextureGraph> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return { graph: createTextureGraph(), problems: [] };
    const problems: string[] = [];
    const ids = new Set<string>();
    const nodes: TexGraphNode[] = [];
    let unreadable = 0;
    for (const candidate of raw.nodes.slice(0, MAX_NODES)) {
        const node = candidate as Partial<TexGraphNode> | null;
        if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.type !== 'string' || !node.type) {
            unreadable++;
            continue;
        }
        ids.add(node.id);
        const definition = textureNodeDefinitionByType(node.type);
        const own = node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : {};
        const params = definition ? { ...defaultNodeParams(definition), ...(migrateProcessorParams(node.type, own) ?? own) } : { ...own };
        const result: TexGraphNode = { id: node.id, type: node.type, x: finite(node.x, 0), y: finite(node.y, 0), params };
        const size = readSize(node.size);
        if (size) result.size = size;
        if (node.precision === 8 || node.precision === 16 || node.precision === 32 || node.precision === 'graph') result.precision = node.precision;
        if (node.tiling === 'input' || node.tiling === 'graph' || node.tiling === 'none' || node.tiling === 'horizontal' || node.tiling === 'vertical' || node.tiling === 'both') result.tiling = node.tiling;
        if (node.seedFrom === 'input' || node.seedFrom === 'fixed') result.seedFrom = node.seedFrom;
        if (typeof node.name === 'string' && node.name.trim()) result.name = node.name.trim().slice(0, 64);
        if (typeof node.color === 'string' && /^#[0-9a-f]{6}$/i.test(node.color)) result.color = node.color.toLowerCase();
        if (node.collapsed === true) result.collapsed = true;
        if (node.bypass === true) result.bypass = true;
        if (Array.isArray(node.valuePins)) {
            const pins = [...new Set(node.valuePins.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 48))].slice(0, 32);
            if (pins.length) result.valuePins = pins;
        }
        nodes.push(result);
    }
    if (raw.nodes.length > MAX_NODES) problems.push(`This graph has ${raw.nodes.length} nodes: only the first ${MAX_NODES} could be opened.`);
    if (unreadable) problems.push(`${unreadable} damaged node${unreadable === 1 ? ' was' : 's were'} left out.`);
    const links: TexGraphLink[] = [];
    const taken = new Set<string>();
    let refused = 0;
    for (const candidate of Array.isArray(raw.links) ? raw.links : []) {
        const link = candidate as Partial<TexGraphLink> | null;
        if (!link || typeof link.from !== 'string' || typeof link.to !== 'string' || typeof link.fromOutput !== 'string' || typeof link.toInput !== 'string') { refused++; continue; }
        if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) { refused++; continue; }
        // One wire into an input.
        const key = `${link.to}:${link.toInput}`;
        if (taken.has(key)) { refused++; continue; }
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
    const storedParameters = Array.isArray(raw.parameters) ? raw.parameters : [];
    for (const candidate of storedParameters.slice(0, MAX_PARAMETERS)) {
        const parameter = readParameter(candidate);
        if (parameter && !parameters.some((existing) => existing.name === parameter.name)) parameters.push(parameter);
    }
    if (storedParameters.length > MAX_PARAMETERS) problems.push(`Only the first ${MAX_PARAMETERS} of its ${storedParameters.length} parameters could be opened.`);
    const kept = dropCycles(nodes, links);
    refused += links.length - kept.length;
    if (refused) problems.push(`${refused} wire${refused === 1 ? ' was' : 's were'} left out: ${refused === 1 ? 'it' : 'they'} led nowhere, doubled up on one input or made a loop.`);
    const graph: TextureGraph = {
        version: 1,
        size: { w: clamp(Math.round(finite(raw.size?.w, DEFAULT_SIZE_LOG2)), MIN_SIZE_LOG2, MAX_SIZE_LOG2), h: clamp(Math.round(finite(raw.size?.h, DEFAULT_SIZE_LOG2)), MIN_SIZE_LOG2, MAX_SIZE_LOG2) },
        seed: clamp(Math.round(finite(raw.seed, 0)), 0, 999),
        nodes,
        links: kept,
        parameters,
    };
    if (comments.length) graph.comments = comments;
    if (raw.tiling === 'none' || raw.tiling === 'horizontal' || raw.tiling === 'vertical') graph.tiling = raw.tiling;
    if (raw.precision === 8 || raw.precision === 16 || raw.precision === 32) graph.precision = raw.precision;
    const groups = readGroups(raw.groups).filter((group) => parameters.some((parameter) => parameter.group === group.name));
    if (groups.length) graph.groups = groups;
    const presets = readPresets(raw.presets, parameters);
    if (presets.length) graph.presets = presets;
    const metres = raw.physicalSize as { w?: unknown; h?: unknown } | undefined;
    if (metres && typeof metres.w === 'number' && typeof metres.h === 'number' && metres.w > 0 && metres.h > 0 && (metres.w !== 1 || metres.h !== 1)) {
        graph.physicalSize = { w: Math.min(10000, metres.w), h: Math.min(10000, metres.h) };
    }
    return { graph, problems };
};

/** A stored graph made safe to use, or a fresh one when it is not a graph. */
export const normalizeTextureGraph = (value: unknown): TextureGraph => readTextureGraph(value).graph;

/** Node types this build does not know, as a graph names them (each once). */
export const unknownNodeTypes = (graph: Pick<TextureGraph, 'nodes'>): string[] =>
    [...new Set(graph.nodes.filter((node) => node.type !== SUBGRAPH_NODE_TYPE && !textureNodeDefinitionByType(node.type)).map((node) => node.type))];

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

/** True when the wires make no loop (Kahn's order: every node can be taken once all that feed it are). */
const acyclic = (links: readonly TexGraphLink[]): boolean => {
    const feeds = new Map<string, number>();
    const downstream = new Map<string, string[]>();
    for (const link of links) {
        feeds.set(link.to, (feeds.get(link.to) ?? 0) + 1);
        if (!feeds.has(link.from)) feeds.set(link.from, 0);
        const list = downstream.get(link.from);
        if (list) list.push(link.to);
        else downstream.set(link.from, [link.to]);
    }
    const ready = [...feeds].filter(([, count]) => count === 0).map(([id]) => id);
    let taken = 0;
    while (ready.length) {
        const id = ready.pop()!;
        taken++;
        for (const next of downstream.get(id) ?? []) {
            const left = feeds.get(next)! - 1;
            feeds.set(next, left);
            if (left === 0) ready.push(next);
        }
    }
    return taken === feeds.size;
};

/** The links in order, leaving out any that would close a loop. */
const dropCycles = (nodes: readonly TexGraphNode[], links: readonly TexGraphLink[]): TexGraphLink[] => {
    // A graph without loops (nearly all) keeps every wire without checking each in turn.
    if (acyclic(links)) return [...links];
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

/**
 * What formulas see: each parameter as a number or vector, the graph's size and seed (inside another
 * graph, the seed this copy of it runs with), and inside a graph an Iterate node runs, the pass
 * ($iteration, from 0) and how many there are ($iterations).
 */
export const formulaScope = (
    graph: TextureGraph,
    values: Readonly<Record<string, unknown>>,
    width: number,
    height: number,
    seed: number = graph.seed,
    iteration: { index: number; count: number } = { index: 0, count: 1 },
): Record<string, ExprValue> => {
    const scope: Record<string, ExprValue> = { $size: width, $width: width, $height: height, $seed: seed, $iteration: iteration.index, $iterations: iteration.count };
    // Numbers, switches, vectors and choices; gradients, curves, pictures, text and fonts are no numbers.
    return { ...scope, ...conditionScope(graph.parameters, values) };
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
        case 'font':
        case 'graph':
            return typeof value === 'string' ? value : param.default;
        case 'function': {
            const graph = value as { nodes?: unknown; links?: unknown } | null;
            if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return structuredClone(param.default);
            // What it works out: where its nodes sit, their names and looks change nothing.
            return {
                nodes: graph.nodes.map((node: { id?: unknown; type?: unknown; params?: unknown } | null) => (node && typeof node === 'object' ? { id: node.id, type: node.type, params: node.params } : node)),
                links: Array.isArray(graph.links) ? graph.links : [],
            };
        }
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

/** A node without what only changes how the canvas shows it (its place, own name, colour, folding). */
export const drawnPart = (node: TexGraphNode): Omit<TexGraphNode, typeof SHOWN_ONLY_FIELDS[number]> => {
    const { x: _x, y: _y, name: _name, color: _color, collapsed: _collapsed, ...rest } = node;
    return rest;
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
    // Pictures picture parameters start with.
    for (const parameter of graph.parameters) if (parameter.kind === 'texture' && typeof parameter.default === 'string' && parameter.default) ids.add(parameter.default);
    return [...ids];
};

/** The graphs a graph uses as nodes (sub-graphs and the graphs Iterate nodes run). */
export const graphDependencies = (graph: TextureGraph): string[] =>
    [...new Set(graph.nodes.filter((node) => GRAPH_USING_TYPES.has(node.type) && typeof node.params.graph === 'string' && node.params.graph).map((node) => node.params.graph as string))];

/** True when a graph (or one it uses, at any depth) reads a model's mesh maps: where the surface is, which way it faces, its baked maps. */
export const graphReadsMeshMaps = (graph: TextureGraph, resolve: (id: string) => { graph: TextureGraph } | undefined): boolean => {
    const seen = new Set<string>();
    const reads = (g: TextureGraph): boolean => {
        if (g.nodes.some((node) => MESH_READING_NODE_TYPES.has(node.type))) return true;
        for (const id of graphDependencies(g)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const entry = resolve(id);
            if (entry && reads(entry.graph)) return true;
        }
        return false;
    };
    return reads(graph);
};

/**
 * A key for everything a graph draws from: its nodes and wires (not where they sit), every graph it
 * uses at any depth, and which of their pictures have loaded. It changes whenever any of them would
 * draw differently.
 */
export const graphContentKey = (graph: TextureGraph, resolve: (id: string) => { graph: TextureGraph } | undefined, loaded: (textureId: string) => boolean): string => {
    const shape = (g: TextureGraph) => [g.size, g.seed, g.parameters, g.nodes.map(drawnPart), g.links, graphTextureIds(g).filter(loaded)];
    const used: unknown[] = [];
    const seen = new Set<string>();
    const visit = (g: TextureGraph) => {
        for (const id of graphDependencies(g)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const entry = resolve(id);
            if (!entry) { used.push([id, 'missing']); continue; }
            used.push([id, shape(entry.graph)]);
            visit(entry.graph);
        }
    };
    visit(graph);
    return hashText(JSON.stringify([shape(graph), used]));
};
