import type * as THREE from 'three';
import type { GpuImage, ImagePrecision, TextureGpu } from '../gpu/textureGpu';
import { readAnimation, timeAt, type GraphTime } from './animation';
import { coerceParam, formulaScope, graphContentKey, hashText, mixSeeds, parameterValues, resolveNodeParams, subgraphRunSeed, MAX_SIZE_LOG2 } from './document';
import { MATERIAL_CHANNELS, materialKey, materialOf, materialResults, type MaterialImages } from './material';
import { withNamedLinks } from './namedLinks';
import { resolvePrecision, resolveSeed, resolveSize, resolveTiling, tilingAxes } from './inherit';
import { nodeBindings, valuePinKey } from './nodeKit';
import { ALL_MESH_MAPS, GRAPH_USING_TYPES, INPUT_NODE_TYPE, MATERIAL_INPUT_NODE_TYPE, MATERIAL_OUTPUT_NODE_TYPE, MESH_MAP_NODE_TYPE, MESH_READING_NODE_TYPES, OUTPUT_NODE_TYPE, SUBGRAPH_SEED_KEY, SUBGRAPH_VARY_KEY, meshMapKey } from './nodes/io';
import { graphAnimates, textureNodeDefinition, type GraphResolver } from './registry';
import { outputNodeKind, type NodeRunContext, type PortKind, type TexGraphLink, type TexGraphNode, type TexNodeDef, type TextureGraph, type TilingMode } from './types';

/**
 * TEXTURE GRAPH EVALUATION
 *
 * Works out the images a request needs, in order from the start of the graph. Each node's result is
 * kept with a signature of everything it came from (its type, settings, size and the signatures of
 * what is wired into it), so an edit redraws only the nodes it reaches and a view switch redraws
 * nothing. Only what a request needs is drawn: a wanted node whose kept result still matches is not
 * drawn again, and neither is anything that feeds only it. A newer request cancels an older one
 * between nodes; results already made stay good. Sub-graphs run inside their node, with their own
 * short-lived cache.
 */

export type ExternalImage = GpuImage | THREE.Texture;

export interface EvaluateRequest {
    graph: TextureGraph;
    /** Values for the graph's parameters, over their defaults. */
    parameters?: Readonly<Record<string, unknown>>;
    /** Images for Input nodes (by name) and mesh maps ('mesh:curvature', ...). */
    external?: Readonly<Record<string, ExternalImage | null | undefined>>;
    /** Changes whenever an external image's pixels change (a re-bake), so results built on it redraw. */
    externalVersion?: string;
    /** The nodes wanted (all their outputs); every Output node when left out. */
    targets?: readonly string[];
    /** The graph's size for this request (powers of two), instead of its own. */
    size?: { w: number; h: number };
    /** Metres the pictures span when the graph has no size in the world of its own (a graph used inside another takes that one's). */
    world?: { w: number; h: number };
    /** The pass of an Iterate node this run is (shaders see it as uIteration, formulas as $iteration). */
    iteration?: { index: number; count: number };
    /** Seconds of the graph's time (brought round its loop); 0 unless given. Only nodes reading the time draw again as it changes. */
    time?: number;
    /** The loop's length, instead of the graph's own (a graph used inside another keeps that one's loop). */
    timeLoop?: number;
    /**
     * The seed the graph runs with, instead of its own: a graph used inside another runs with a seed
     * of its own copy, so copies of it look different.
     */
    seed?: number;
    signal?: AbortSignal;
    /** Called as each node finishes, for progress. */
    onNode?: (nodeId: string, state: NodeState) => void;
}

export interface NodeState {
    signature: string;
    outputs: Record<string, GpuImage>;
    width: number;
    height: number;
    /** What went wrong drawing it, in words. */
    error?: string;
    /** Settings that could not follow their parameter or formula. */
    warnings?: string[];
    /** What the node said about how it drew (a stand-in it fell back on, a check's findings), in words. */
    notes?: string[];
    milliseconds: number;
    /** When it was last asked for, for letting go of old results first. */
    used: number;
    /** Which ways it tiled, and the seed its shaders saw (for the editor to show and place handles by). */
    tiling?: TilingMode;
    seed?: number;
}

/** GPU bytes of results kept before the oldest go. */
const CACHE_BYTES = 1536 * 1024 * 1024;
const MAX_DEPTH = 8;

export class AbortedError extends Error {
    constructor() { super('Cancelled'); this.name = 'AbortError'; }
}

interface Plan {
    order: TexGraphNode[];
    definitions: Map<string, TexNodeDef>;
    incoming: Map<string, Map<string, TexGraphLink>>;
    cyclic: Set<string>;
}

/** What a node will be drawn with, worked out before anything is drawn. */
interface NodeDetails {
    signature: string;
    width: number;
    height: number;
    kinds: Record<string, PortKind>;
    precision: ImagePrecision;
    /** Which ways it tiles, as worked out from the node, its input or the graph. */
    tiling: TilingMode;
    params: Record<string, unknown>;
    warnings: string[];
    /** The seed its shaders see. */
    seed: number;
    /** A sub-graph node's: the seed the graph inside runs with. */
    innerSeed?: number;
    /** It gives only values (one pixel each). */
    value?: boolean;
    /** Metres the picture spans across and down. */
    world: [number, number];
    iteration: { index: number; count: number };
    time: GraphTime;
}

interface Prepared {
    plan: Plan;
    info: Map<string, NodeDetails>;
    targets: readonly string[];
    external: Readonly<Record<string, ExternalImage | null | undefined>>;
    graphSeed: number;
}

/** A node the editor cannot draw: one this build does not have (kept as it was), in words. */
export const unknownNodeMessage = (type: string): string => `This node ("${type}") is not available in this version of the editor. Its settings and wires are kept.`;

/** The input a node can pass through when bypassed: its main one, when it has inputs and outputs. */
export const mainInput = (definition: TexNodeDef): string | null =>
    (definition.bypass !== false && definition.inputs.length && definition.outputs.length ? definition.main ?? definition.inputs[0].key : null);

/** The input a bypassed node passes through, or null when it is not bypassed (or cannot be). */
const bypassedInput = (node: TexGraphNode, definition: TexNodeDef): string | null => (node.bypass ? mainInput(definition) : null);

const FALLBACK_VALUES: Record<string, [number, number, number, number]> = {
    white: [1, 1, 1, 1], black: [0, 0, 0, 1], mid: [0.5, 0.5, 0.5, 1], normal: [0.5, 0.5, 1, 1], clear: [0, 0, 0, 0],
};

let identities = new WeakMap<object, number>();
let nextIdentity = 1;
const identityOf = (value: object): number => {
    let id = identities.get(value);
    if (!id) identities.set(value, id = nextIdentity++);
    return id;
};

export class TextureGraphEvaluator {
    private readonly cache = new Map<string, NodeState>();
    /**
     * The evaluator each sub-graph node runs its graph with, kept between runs (by node and graph), so an
     * edit redraws only the inner nodes it reaches.
     */
    private readonly nested = new Map<string, TextureGraphEvaluator>();
    private generation = 0;
    private clock = 0;
    private readonly stopListening: () => void;

    constructor(
        private readonly gpu: TextureGpu,
        private readonly resolve: GraphResolver,
        private readonly texture: (textureId: string) => THREE.Texture | null,
        private readonly depth = 0,
        private readonly visiting: ReadonlySet<string> = new Set(),
    ) {
        this.stopListening = gpu.onRestored(() => {
            this.cache.clear();
            identities = new WeakMap();
        });
    }

    /** The last result of a node, if it has one. */
    state(nodeId: string): NodeState | undefined {
        return this.cache.get(nodeId);
    }

    /** Lets go of every kept result. */
    dispose(): void {
        for (const state of this.cache.values()) this.releaseState(state);
        this.cache.clear();
        for (const inner of this.nested.values()) inner.dispose();
        this.nested.clear();
        // Evaluators come and go (one per run of a graph used inside another): each stops listening as it goes.
        this.stopListening();
    }

    /** Lets go of results of nodes the graph no longer has. */
    prune(graph: TextureGraph): void {
        const ids = new Set(graph.nodes.map((node) => node.id));
        for (const [id, state] of this.cache) {
            if (ids.has(id)) continue;
            this.releaseState(state);
            this.cache.delete(id);
        }
        // A sub-graph node gone, or now running another graph: its inner evaluator goes too.
        const using = new Set(graph.nodes.filter((node) => GRAPH_USING_TYPES.has(node.type)).map((node) => `${node.id}:${String(node.params.graph ?? '')}`));
        for (const [key, inner] of this.nested) {
            if (using.has(key)) continue;
            inner.dispose();
            this.nested.delete(key);
        }
    }

    /** Lets go of every kept result but those of `keep` (and of the graphs inside sub-graph nodes). */
    retainOnly(keep: ReadonlySet<string>): void {
        for (const [id, state] of this.cache) {
            if (keep.has(id)) continue;
            this.releaseState(state);
            this.cache.delete(id);
        }
        for (const inner of this.nested.values()) inner.dispose();
        this.nested.clear();
    }

    private releaseState(state: NodeState): void {
        for (const image of Object.values(state.outputs)) this.gpu.release(image);
        state.outputs = {};
    }

    private plan(graph: TextureGraph, targets: readonly string[]): Plan {
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        const incoming = new Map<string, Map<string, TexGraphLink>>();
        // Named links draw as wires from each sender to its receivers.
        for (const link of withNamedLinks(graph).links) {
            if (!nodes.has(link.from) || !nodes.has(link.to)) continue;
            let map = incoming.get(link.to);
            if (!map) incoming.set(link.to, map = new Map());
            map.set(link.toInput, link);
        }
        const definitions = new Map<string, TexNodeDef>();
        const order: TexGraphNode[] = [];
        const state = new Map<string, 'visiting' | 'done'>();
        const cyclic = new Set<string>();
        const visit = (id: string) => {
            const seen = state.get(id);
            if (seen === 'done') return;
            if (seen === 'visiting') { cyclic.add(id); return; }
            const node = nodes.get(id);
            if (!node) return;
            state.set(id, 'visiting');
            const definition = textureNodeDefinition(node, this.resolve);
            if (definition) definitions.set(id, definition);
            for (const link of incoming.get(id)?.values() ?? []) visit(link.from);
            state.set(id, 'done');
            order.push(node);
        };
        for (const id of targets) visit(id);
        return { order, definitions, incoming, cyclic };
    }

    /** Signatures, sizes, kinds and seeds of everything the request reaches, in order from the start. */
    private prepare(request: EvaluateRequest): Prepared {
        const graph = request.graph;
        const targets = request.targets ?? graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => node.id);
        const plan = this.plan(graph, targets);
        const values = parameterValues(graph, request.parameters);
        const sizeLog2 = request.size ?? graph.size;
        const graphWidth = 2 ** Math.min(MAX_SIZE_LOG2, sizeLog2.w);
        const graphHeight = 2 ** Math.min(MAX_SIZE_LOG2, sizeLog2.h);
        const graphSeed = request.seed ?? graph.seed;
        const metres = graph.physicalSize ?? request.world ?? { w: 1, h: 1 };
        const world: [number, number] = [metres.w, metres.h];
        const iteration = request.iteration ?? { index: 0, count: 1 };
        const time = timeAt(request.time ?? 0, request.timeLoop ?? readAnimation(graph.animation).loop);
        const scope = formulaScope(graph, values, graphWidth, graphHeight, graphSeed, iteration);
        const external = request.external ?? {};
        const externalToken = (key: string): string => {
            const value = external[key];
            return value ? `${identityOf(value)}:${request.externalVersion ?? ''}` : '-';
        };

        const info = new Map<string, NodeDetails>();
        const outputKind = (link: TexGraphLink | undefined): PortKind | null => (link ? info.get(link.from)?.kinds[link.fromOutput] ?? null : null);
        for (const node of plan.order) {
            const definition = plan.definitions.get(node.id);
            if (!definition) continue;
            const warnings: string[] = [];
            const params = resolveNodeParams(definition, node, values, scope, warnings);
            const links = plan.incoming.get(node.id);
            // What the node takes after when it takes after its input: the first picture wired (a value a
            // setting follows is no picture).
            const pictures = definition.inputs.filter((port) => port.kind !== 'value');
            const first = pictures.map((port) => info.get(links?.get(port.key)?.from ?? '')).find((details): details is NodeDetails => details !== undefined && !details.value);
            // Size: from the first wired input or the graph, then the node's own change.
            let { width, height } = resolveSize(node.size?.mode ?? definition.sizeFrom, node.size, first, { width: graphWidth, height: graphHeight });
            // A bypassed node passes its main input through: it takes that input's size and kind.
            const main = bypassedInput(node, definition);
            const mainSource = main ? info.get(links?.get(main)?.from ?? '') : undefined;
            if (mainSource) { width = mainSource.width; height = mainSource.height; }
            const limit = Math.min(this.gpu.maxSize, 2 ** MAX_SIZE_LOG2);
            width = Math.max(1, Math.min(limit, Math.round(width)));
            height = Math.max(1, Math.min(limit, Math.round(height)));
            // A node that gives only values gives one pixel each, at full float.
            const value = definition.outputs.length > 0 && definition.outputs.every((port) => port.kind === 'value');
            if (value) { width = 1; height = 1; }
            // Kinds of 'any' outputs.
            const kinds: Record<string, PortKind> = {};
            const follows = definition.kindFrom ? (Array.isArray(definition.kindFrom) ? definition.kindFrom : [definition.kindFrom]) as string[] : [];
            const wiredKinds = follows.map((key) => outputKind(links?.get(key))).filter((kind): kind is PortKind => kind !== null);
            const anyKind: PortKind = definition.kindOf
                ? definition.kindOf(params)
                : wiredKinds.length ? (wiredKinds.includes('color') ? 'color' : 'gray') : definition.anyDefault ?? 'gray';
            // A material output carries a picture per channel, each of its channel's kind: it has no one kind.
            for (const port of definition.outputs) if (port.kind !== 'material') kinds[port.key] = port.kind === 'any' ? anyKind : port.kind === 'value' ? 'color' : port.kind;
            if (node.type === OUTPUT_NODE_TYPE) kinds.out = outputNodeKind(params);
            if (main) {
                const passed = outputKind(links?.get(main)) ?? (definition.inputs.find((port) => port.key === main)?.kind === 'gray' ? 'gray' : null);
                if (passed) for (const port of definition.outputs) if (port.kind !== 'material') kinds[port.key] = passed;
            }
            // Precision: as asked, the graph's, else the widest wired in, else by kind.
            const wired = pictures.map((port) => info.get(links?.get(port.key)?.from ?? '')?.precision).filter((bits): bits is ImagePrecision => bits !== undefined);
            let precision = value ? 32 : resolvePrecision(node.precision, wired, graph.precision, anyKind);
            // A node whose settings need a greater depth (a deep picture) gets it unless it is set to its own.
            const own = (node.precision === undefined || node.precision === 'auto') ? definition.precisionOf?.(params, this.texture) : undefined;
            if (own && own > precision) precision = own;
            const tiling = resolveTiling(node.tiling, first?.tiling, graph.tiling ?? 'both', definition.inputs.length > 0);
            const inputSignatures = definition.inputs.map((port) => {
                const link = links?.get(port.key);
                const source = link ? info.get(link.from) : undefined;
                return source ? `${source.signature}/${link!.fromOutput}` : '-';
            });
            const seed = resolveSeed(node.seedFrom, Math.round(Number(params.seed) || 0), graphSeed, first?.seed);
            const extras: string[] = [];
            let innerSeed: number | undefined;
            if (node.type === INPUT_NODE_TYPE) extras.push(externalToken(String(params.name || 'input')));
            if (node.type === MATERIAL_INPUT_NODE_TYPE) for (const channel of MATERIAL_CHANNELS) extras.push(externalToken(materialKey(String(params.name || 'material'), channel)));
            if (node.type === MESH_MAP_NODE_TYPE) extras.push(externalToken(`mesh:${String(params.map)}`));
            else if (MESH_READING_NODE_TYPES.has(node.type)) {
                for (const name of ALL_MESH_MAPS) extras.push(externalToken(meshMapKey(name)));
            }
            if (GRAPH_USING_TYPES.has(node.type)) {
                const entry = typeof params.graph === 'string' ? this.resolve(params.graph) : undefined;
                // The used graph and those it uses in turn, and their pictures loading: any of them changing draws it again.
                extras.push(entry ? graphContentKey(entry.graph, this.resolve, (id) => Boolean(this.texture(id))) : 'missing');
                for (const key of Object.keys(external)) if (key.startsWith('mesh:')) extras.push(`${key}=${externalToken(key)}`);
                // Each copy runs the graph inside with a seed of its own, from this graph's seed and the copy
                // itself, unless the copy is set to take its look from its seed alone.
                innerSeed = subgraphRunSeed(graphSeed, node.id, Math.round(Number(params[SUBGRAPH_SEED_KEY]) || 0), params[SUBGRAPH_VARY_KEY] !== false, entry?.graph.seed ?? 0);
                extras.push(`seed:${innerSeed}`);
            }
            for (const param of definition.params) {
                if (param.kind !== 'texture') continue;
                const id = params[param.key];
                // Ready, and at which depth: a picture read again at its own depth draws again.
                const picture = typeof id === 'string' && id ? this.texture(id) : null;
                extras.push(picture ? `${id}:ready:${Number(picture.userData?.auvraDepth) || 8}` : `${String(id)}:waiting`);
            }
            if (main) extras.push(`bypass:${main}`);
            if (world[0] !== 1 || world[1] !== 1) extras.push(`world:${world[0]}x${world[1]}`);
            if (request.iteration) extras.push(`pass:${iteration.index}/${iteration.count}`);
            // Nodes reading the time (and graphs used as nodes that animate) draw again as it changes; nothing else does.
            const usedGraph = GRAPH_USING_TYPES.has(node.type) && typeof params.graph === 'string' ? this.resolve(params.graph) : undefined;
            if (definition.readsTime?.(params) || (usedGraph && graphAnimates(usedGraph.graph, this.resolve))) extras.push(`time:${time.seconds}/${time.loop}`);
            const signature = hashText(JSON.stringify([node.type, params, width, height, precision, seed, kinds, inputSignatures, extras, tiling]));
            info.set(node.id, { signature, width, height, kinds, precision, tiling, params, warnings, seed, innerSeed, world, iteration, time, ...(value ? { value } : {}) });
        }
        return { plan, info, targets, external, graphSeed };
    }

    /** The nodes that must be drawn for the targets: those without a matching kept result, and what they need in turn. */
    private needed(prepared: Prepared): Set<string> {
        const { plan, info, targets } = prepared;
        const needed = new Set<string>();
        const visiting = new Set<string>();
        const need = (id: string) => {
            if (needed.has(id) || visiting.has(id)) return;
            visiting.add(id);
            const details = info.get(id);
            const cached = this.cache.get(id);
            if (!(cached && details && cached.signature === details.signature && !plan.cyclic.has(id))) {
                needed.add(id);
                for (const link of plan.incoming.get(id)?.values() ?? []) need(link.from);
            }
            visiting.delete(id);
        };
        for (const id of targets) need(id);
        return needed;
    }

    /** True when every target of the request already has a kept result that matches it: evaluating it would draw nothing. */
    upToDate(request: EvaluateRequest): boolean {
        return this.needed(this.prepare(request)).size === 0;
    }

    /** Draws what the request needs; the results stay readable through state(). */
    async evaluate(request: EvaluateRequest): Promise<Map<string, NodeState>> {
        const generation = ++this.generation;
        const prepared = this.prepare(request);
        const { plan, info, external } = prepared;
        const needed = this.needed(prepared);

        const results = new Map<string, NodeState>();
        for (const node of plan.order) {
            if (request.signal?.aborted || generation !== this.generation) throw new AbortedError();
            const definition = plan.definitions.get(node.id);
            const details = info.get(node.id);
            const cached = this.cache.get(node.id);
            if (!needed.has(node.id)) {
                // Its kept result still matches, or nothing wanted needs it drawn.
                if (cached) {
                    cached.used = ++this.clock;
                    results.set(node.id, cached);
                }
                continue;
            }
            if (!definition || !details) {
                const error = definition ? 'This node could not be prepared.' : unknownNodeMessage(node.type);
                if (cached) this.releaseState(cached);
                const state: NodeState = { signature: 'missing', outputs: {}, width: 0, height: 0, error, milliseconds: 0, used: ++this.clock };
                this.cache.set(node.id, state);
                results.set(node.id, state);
                continue;
            }
            if (cached && cached.signature === details.signature && !plan.cyclic.has(node.id)) {
                cached.used = ++this.clock;
                results.set(node.id, cached);
                continue;
            }
            if (plan.cyclic.has(node.id)) {
                if (cached) this.releaseState(cached);
                const state: NodeState = { signature: details.signature, outputs: {}, width: details.width, height: details.height, error: 'This node feeds itself through a loop of wires.', milliseconds: 0, used: ++this.clock };
                this.cache.set(node.id, state);
                results.set(node.id, state);
                continue;
            }
            const started = performance.now();
            const state: NodeState = { signature: details.signature, outputs: {}, width: details.width, height: details.height, milliseconds: 0, used: ++this.clock, tiling: details.tiling, seed: details.seed };
            if (details.warnings.length) state.warnings = details.warnings;
            // Every picture the node takes, so whatever it still holds when it fails (or is not kept) goes back.
            const made: GpuImage[] = [];
            const notes: string[] = [];
            const leftovers = () => {
                const kept = new Set(Object.values(state.outputs));
                for (const image of made) if (!kept.has(image)) this.gpu.release(image);
            };
            try {
                const main = bypassedInput(node, definition);
                // Settings following values: read on the GPU by nodes that read settings only in shaders,
                // read back first by the rest.
                const runDetails = !main && !definition.settingsInShader ? await this.withValuesRead(definition, details, plan.incoming.get(node.id)) : details;
                state.outputs = main
                    ? this.passThrough(definition, main, details, plan.incoming.get(node.id), made)
                    : await definition.run(this.context(node, definition, runDetails, plan, request, external, made, notes));
                if (notes.length) state.notes = notes;
            } catch (error) {
                state.outputs = {};
                leftovers();
                if (error instanceof AbortedError || (error as Error)?.name === 'AbortError') throw error;
                state.error = error instanceof Error ? error.message : 'This node could not be drawn.';
            }
            leftovers();
            // A newer evaluation began while this node drew: its picture is out of date, and must not
            // replace what the newer one keeps.
            if (generation !== this.generation || request.signal?.aborted) {
                this.releaseState(state);
                throw new AbortedError();
            }
            state.milliseconds = performance.now() - started;
            const current = this.cache.get(node.id);
            if (current && current !== state) this.releaseState(current);
            this.cache.set(node.id, state);
            results.set(node.id, state);
            request.onNode?.(node.id, state);
        }
        this.evict(new Set(plan.order.map((node) => node.id)));
        return results;
    }

    /**
     * A bypassed node's outputs: the image wired into its main input, as it is, on every output; or,
     * with nothing wired there, that input's own fallback value.
     */
    private passThrough(definition: TexNodeDef, main: string, details: NodeDetails, links: Map<string, TexGraphLink> | undefined, made: GpuImage[]): Record<string, GpuImage> {
        const link = links?.get(main);
        const source = link ? this.cache.get(link.from)?.outputs : undefined;
        const outputs: Record<string, GpuImage> = {};
        if (definition.inputs.find((input) => input.key === main)?.kind === 'material') {
            // A material passes on whole to every material output; anything else the node gives is left black.
            const material = source && link ? materialOf(source, link.fromOutput) : null;
            for (const port of definition.outputs) {
                if (port.kind === 'material') {
                    if (!material) continue;
                    const kept: MaterialImages = {};
                    for (const channel of MATERIAL_CHANNELS) { const image = material[channel]; if (image) kept[channel] = this.gpu.retain(image); }
                    Object.assign(outputs, materialResults(port.key, kept));
                    continue;
                }
                const filled = this.gpu.image(details.width, details.height, details.kinds[port.key] ?? 'gray', details.precision);
                made.push(filled);
                this.gpu.clear(filled, FALLBACK_VALUES.black);
                outputs[port.key] = filled;
            }
            return outputs;
        }
        const image = link ? source?.[link.fromOutput] ?? null : null;
        for (const port of definition.outputs) {
            if (image) { outputs[port.key] = this.gpu.retain(image); continue; }
            const kind = details.kinds[port.key] ?? 'color';
            const filled = this.gpu.image(details.width, details.height, kind, details.precision);
            made.push(filled);
            this.gpu.clear(filled, FALLBACK_VALUES[definition.inputs.find((input) => input.key === main)?.fallback ?? 'black'] ?? FALLBACK_VALUES.black);
            outputs[port.key] = filled;
        }
        return outputs;
    }

    /**
     * The node's details with each setting that follows a value wired in set to that value, read back
     * from the GPU (for nodes that read settings outside their shaders). The same details when none do.
     */
    private async withValuesRead(definition: TexNodeDef, details: NodeDetails, links: Map<string, TexGraphLink> | undefined): Promise<NodeDetails> {
        let params: Record<string, unknown> | null = null;
        for (const param of definition.params) {
            const link = links?.get(valuePinKey(param.key));
            const image = link ? this.cache.get(link.from)?.outputs[link.fromOutput] : undefined;
            if (!image) continue;
            const read = await this.gpu.readPixelLater(image, 0, 0);
            if (!read) continue;
            const value = param.kind === 'color' ? [read[0], read[1], read[2], read[3]] : param.kind === 'vec2' ? [read[0], read[1]] : param.kind === 'bool' ? read[0] > 0.5 : read[0];
            (params ??= { ...details.params })[param.key] = coerceParam(param, value);
        }
        return params ? { ...details, params } : details;
    }

    private context(
        node: TexGraphNode,
        definition: TexNodeDef,
        details: NodeDetails,
        plan: Plan,
        request: EvaluateRequest,
        external: Readonly<Record<string, ExternalImage | null | undefined>>,
        made: GpuImage[],
        notes: string[] = [],
    ): NodeRunContext {
        const gpu = this.gpu;
        const links = plan.incoming.get(node.id);
        const input = (key: string): GpuImage | null => {
            const link = links?.get(key);
            if (!link) return null;
            return this.cache.get(link.from)?.outputs[link.fromOutput] ?? null;
        };
        const seed = details.seed;
        const context: NodeRunContext = {
            gpu,
            node,
            width: details.width,
            height: details.height,
            seed,
            precision: details.precision,
            tiling: tilingAxes(details.tiling),
            world: details.world,
            iteration: details.iteration,
            time: details.time,
            params: details.params,
            signal: request.signal ?? new AbortController().signal,
            input,
            outputKind: (key) => details.kinds[key] ?? 'color',
            image: (kind, width = details.width, height = details.height, precision = kind === details.kinds[definition.outputs[0]?.key ?? 'out'] ? details.precision : kind === 'color' ? 8 : 16) => {
                const image = gpu.image(width, height, kind, precision);
                made.push(image);
                return image;
            },
            pass: async (target, fragment, extra = {}) => {
                const bound = nodeBindings(definition, { input, params: details.params, seed, texture: this.texture, tiling: tilingAxes(details.tiling), world: details.world, iteration: details.iteration, time: details.time }, (name) => gpu.constant(name));
                await gpu.pass(target, {
                    ...extra,
                    fragment: `${bound.declarations}\n${fragment}`,
                    inputs: { ...bound.inputs, ...(extra.inputs ?? {}) },
                    uniforms: { ...bound.uniforms, ...(extra.uniforms ?? {}) },
                });
            },
            texture: this.texture,
            external: (name) => external[name] ?? null,
            note: (text) => { if (!notes.includes(text)) notes.push(text); },
            material: (key) => {
                const link = links?.get(key);
                const outputs = link ? this.cache.get(link.from)?.outputs : undefined;
                return outputs && link ? materialOf(outputs, link.fromOutput) : null;
            },
            subgraph: async (graphId, params, inputs, options = {}) => {
                if (this.depth >= MAX_DEPTH || this.visiting.has(graphId)) throw new Error('This graph uses itself, directly or through others.');
                const entry = this.resolve(graphId);
                if (!entry) throw new Error('The graph this node used is no longer in the project.');
                const key = `${node.id}:${graphId}`;
                let nested = this.nested.get(key);
                if (!nested) this.nested.set(key, nested = new TextureGraphEvaluator(gpu, this.resolve, this.texture, this.depth + 1, new Set([...this.visiting, graphId])));
                nested.prune(entry.graph);
                const given: Record<string, ExternalImage | null> = {};
                for (const [key, value] of Object.entries(external)) if (key.startsWith('mesh:')) given[key] = value ?? null;
                for (const [key, value] of Object.entries(inputs)) given[key] = value;
                const result: Record<string, GpuImage> = {};
                try {
                    const outputs = entry.graph.nodes.filter((candidate) => candidate.type === OUTPUT_NODE_TYPE || candidate.type === MATERIAL_OUTPUT_NODE_TYPE);
                    const states = await nested.evaluate({
                        graph: entry.graph,
                        parameters: params,
                        external: given,
                        externalVersion: request.externalVersion,
                        targets: outputs.map((candidate) => candidate.id),
                        size: { w: Math.log2(details.width), h: Math.log2(details.height) },
                        seed: options.seedOffset ? mixSeeds(details.innerSeed ?? request.seed ?? request.graph.seed, options.seedOffset) : details.innerSeed,
                        world: { w: details.world[0], h: details.world[1] },
                        ...(options.iteration ? { iteration: options.iteration } : {}),
                        time: details.time.seconds,
                        timeLoop: details.time.loop,
                        signal: request.signal,
                    });
                    for (const output of outputs) {
                        const state = states.get(output.id);
                        if (state?.error) throw new Error(`Inside "${entry.name}": ${state.error}`);
                        if (output.type === MATERIAL_OUTPUT_NODE_TYPE) {
                            // A whole material comes out as an image per channel under the output's pin.
                            const material = state ? materialOf(state.outputs, 'out') : null;
                            for (const channel of MATERIAL_CHANNELS) {
                                const image = material?.[channel];
                                if (!image) continue;
                                result[materialKey(output.id, channel)] = gpu.retain(image);
                                if (!options.owned) made.push(image);
                            }
                            continue;
                        }
                        const image = state?.outputs.out;
                        if (image) {
                            result[output.id] = gpu.retain(image);
                            if (!options.owned) made.push(image);
                        }
                    }
                    return result;
                } catch (error) {
                    // Results the node would have owned go back; the rest go back with the node's leftovers.
                    if (options.owned) for (const image of Object.values(result)) gpu.release(image);
                    // A run that failed (or was stopped) may leave inner results half made: start afresh next time.
                    nested.dispose();
                    this.nested.delete(key);
                    throw error;
                }
            },
        };
        return context;
    }

    /** Lets go of the oldest results not in `keep` while the cache holds too much. */
    private evict(keep: ReadonlySet<string>): void {
        if (this.gpu.memory.live <= CACHE_BYTES) return;
        const candidates = [...this.cache.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].used - b[1].used);
        for (const [id, state] of candidates) {
            if (this.gpu.memory.live <= CACHE_BYTES * 0.75) break;
            this.releaseState(state);
            this.cache.delete(id);
        }
    }
}
