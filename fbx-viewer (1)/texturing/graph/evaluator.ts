import type * as THREE from 'three';
import type { GpuImage, ImagePrecision, TextureGpu } from '../gpu/textureGpu';
import { formulaScope, graphContentKey, hashText, parameterValues, resolveNodeParams, MAX_SIZE_LOG2 } from './document';
import { nodeBindings } from './nodeKit';
import { INPUT_NODE_TYPE, MESH_MAP_NODE_TYPE, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from './nodes/io';
import { textureNodeDefinition, type GraphResolver } from './registry';
import type { NodeRunContext, PortKind, TexGraphLink, TexGraphNode, TexNodeDef, TextureGraph } from './types';

/**
 * TEXTURE GRAPH EVALUATION
 *
 * Works out the images a request needs, in order from the start of the graph. Each node's result is
 * kept with a signature of everything it came from (its type, settings, size and the signatures of
 * what is wired into it), so an edit redraws only the nodes it reaches and a view switch redraws
 * nothing. A newer request cancels an older one between nodes; results already made stay good.
 * Sub-graphs run inside their node, with their own short-lived cache.
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
    milliseconds: number;
    /** When it was last asked for, for letting go of old results first. */
    used: number;
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
        const using = new Set(graph.nodes.filter((node) => node.type === 'subgraph').map((node) => `${node.id}:${String(node.params.graph ?? '')}`));
        for (const [key, inner] of this.nested) {
            if (using.has(key)) continue;
            inner.dispose();
            this.nested.delete(key);
        }
    }

    private releaseState(state: NodeState): void {
        for (const image of Object.values(state.outputs)) this.gpu.release(image);
        state.outputs = {};
    }

    private plan(graph: TextureGraph, targets: readonly string[]): Plan {
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        const incoming = new Map<string, Map<string, TexGraphLink>>();
        for (const link of graph.links) {
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

    /** Draws what the request needs; the results stay readable through state(). */
    async evaluate(request: EvaluateRequest): Promise<Map<string, NodeState>> {
        const generation = ++this.generation;
        const graph = request.graph;
        const targets = request.targets ?? graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => node.id);
        const plan = this.plan(graph, targets);
        const values = parameterValues(graph, request.parameters);
        const sizeLog2 = request.size ?? graph.size;
        const graphWidth = 2 ** Math.min(MAX_SIZE_LOG2, sizeLog2.w);
        const graphHeight = 2 ** Math.min(MAX_SIZE_LOG2, sizeLog2.h);
        const scope = formulaScope(graph, values, graphWidth, graphHeight);
        const external = request.external ?? {};
        const externalToken = (key: string): string => {
            const value = external[key];
            return value ? `${identityOf(value)}:${request.externalVersion ?? ''}` : '-';
        };

        // Signatures, sizes and kinds, in order from the start.
        const info = new Map<string, { signature: string; width: number; height: number; kinds: Record<string, PortKind>; precision: ImagePrecision; params: Record<string, unknown>; warnings: string[] }>();
        const outputKind = (link: TexGraphLink | undefined): PortKind | null => (link ? info.get(link.from)?.kinds[link.fromOutput] ?? null : null);
        for (const node of plan.order) {
            const definition = plan.definitions.get(node.id);
            if (!definition) continue;
            const warnings: string[] = [];
            const params = resolveNodeParams(definition, node, values, scope, warnings);
            const links = plan.incoming.get(node.id);
            // Size: from the first wired input or the graph, then the node's own change.
            let width = graphWidth;
            let height = graphHeight;
            const mode = node.size?.mode ?? definition.sizeFrom;
            if (mode === 'absolute') {
                width = 2 ** (node.size?.w ?? 10);
                height = 2 ** (node.size?.h ?? 10);
            } else {
                if (mode === 'input') {
                    for (const port of definition.inputs) {
                        const source = info.get(links?.get(port.key)?.from ?? '');
                        if (source) { width = source.width; height = source.height; break; }
                    }
                }
                width = width * 2 ** (node.size?.w ?? 0);
                height = height * 2 ** (node.size?.h ?? 0);
            }
            const limit = Math.min(this.gpu.maxSize, 2 ** MAX_SIZE_LOG2);
            width = Math.max(1, Math.min(limit, Math.round(width)));
            height = Math.max(1, Math.min(limit, Math.round(height)));
            // Kinds of 'any' outputs.
            const kinds: Record<string, PortKind> = {};
            const follows = definition.kindFrom ? (Array.isArray(definition.kindFrom) ? definition.kindFrom : [definition.kindFrom]) as string[] : [];
            const wiredKinds = follows.map((key) => outputKind(links?.get(key))).filter((kind): kind is PortKind => kind !== null);
            const anyKind: PortKind = definition.kindOf
                ? definition.kindOf(params)
                : wiredKinds.length ? (wiredKinds.includes('color') ? 'color' : 'gray') : definition.anyDefault ?? 'gray';
            for (const port of definition.outputs) kinds[port.key] = port.kind === 'any' ? anyKind : port.kind;
            if (node.type === OUTPUT_NODE_TYPE) kinds.out = (params.channel === 'roughness' || params.channel === 'metallic' || params.channel === 'height' || params.channel === 'ambientOcclusion' || params.channel === 'opacity') ? 'gray' : 'color';
            // Precision: as asked, else the widest wired in, else by kind.
            let precision: ImagePrecision = anyKind === 'color' ? 8 : 16;
            if (node.precision && node.precision !== 'auto') precision = node.precision;
            else {
                const wired = definition.inputs.map((port) => info.get(links?.get(port.key)?.from ?? '')?.precision).filter((value): value is ImagePrecision => value !== undefined);
                if (wired.length) precision = Math.max(...wired) as ImagePrecision;
            }
            const inputSignatures = definition.inputs.map((port) => {
                const link = links?.get(port.key);
                const source = link ? info.get(link.from) : undefined;
                return source ? `${source.signature}/${link!.fromOutput}` : '-';
            });
            const extras: string[] = [];
            if (node.type === INPUT_NODE_TYPE) extras.push(externalToken(String(params.name || 'input')));
            if (node.type === MESH_MAP_NODE_TYPE) extras.push(externalToken(`mesh:${String(params.map)}`));
            if (['triplanar', 'directionMask', 'axisGradient', 'blendMeshNormals', 'noise3d'].includes(node.type)) {
                for (const key of ['mesh:position', 'mesh:worldNormal', 'mesh:normal']) extras.push(externalToken(key));
            }
            if (node.type === SUBGRAPH_NODE_TYPE) {
                const entry = typeof params.graph === 'string' ? this.resolve(params.graph) : undefined;
                // The used graph and those it uses in turn, and their pictures loading: any of them changing draws it again.
                extras.push(entry ? graphContentKey(entry.graph, this.resolve, (id) => Boolean(this.texture(id))) : 'missing');
                for (const key of Object.keys(external)) if (key.startsWith('mesh:')) extras.push(`${key}=${externalToken(key)}`);
            }
            for (const param of definition.params) {
                if (param.kind !== 'texture') continue;
                const id = params[param.key];
                extras.push(typeof id === 'string' && id && this.texture(id) ? `${id}:ready` : `${String(id)}:waiting`);
            }
            const seed = graph.seed * 7919 + Math.round(Number(params.seed) || 0) * 131;
            const signature = hashText(JSON.stringify([node.type, params, width, height, precision, seed, kinds, inputSignatures, extras]));
            info.set(node.id, { signature, width, height, kinds, precision, params, warnings });
        }

        const results = new Map<string, NodeState>();
        for (const node of plan.order) {
            if (request.signal?.aborted || generation !== this.generation) throw new AbortedError();
            const definition = plan.definitions.get(node.id);
            const details = info.get(node.id);
            const cached = this.cache.get(node.id);
            if (!definition || !details) {
                const error = definition ? 'This node could not be prepared.' : `This build has no "${node.type}" node.`;
                if (cached) this.releaseState(cached);
                const state: NodeState = { signature: 'missing', outputs: {}, width: 0, height: 0, error, milliseconds: 0, used: ++this.clock };
                this.cache.set(node.id, state);
                results.set(node.id, state);
                continue;
            }
            if (cached && cached.signature === details.signature) {
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
            const state: NodeState = { signature: details.signature, outputs: {}, width: details.width, height: details.height, milliseconds: 0, used: ++this.clock };
            if (details.warnings.length) state.warnings = details.warnings;
            // Every picture the node takes, so whatever it still holds when it fails (or is not kept) goes back.
            const made: GpuImage[] = [];
            const leftovers = () => {
                const kept = new Set(Object.values(state.outputs));
                for (const image of made) if (!kept.has(image)) this.gpu.release(image);
            };
            try {
                state.outputs = await definition.run(this.context(node, definition, details, plan, request, external, made));
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

    private context(
        node: TexGraphNode,
        definition: TexNodeDef,
        details: { width: number; height: number; kinds: Record<string, PortKind>; precision: ImagePrecision; params: Record<string, unknown> },
        plan: Plan,
        request: EvaluateRequest,
        external: Readonly<Record<string, ExternalImage | null | undefined>>,
        made: GpuImage[],
    ): NodeRunContext {
        const gpu = this.gpu;
        const links = plan.incoming.get(node.id);
        const input = (key: string): GpuImage | null => {
            const link = links?.get(key);
            if (!link) return null;
            return this.cache.get(link.from)?.outputs[link.fromOutput] ?? null;
        };
        const graphSeed = request.graph.seed;
        const seed = graphSeed * 7919 + Math.round(Number(details.params.seed) || 0) * 131 + 0.5;
        const context: NodeRunContext = {
            gpu,
            node,
            width: details.width,
            height: details.height,
            seed,
            precision: details.precision,
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
                const bound = nodeBindings(definition, { input, params: details.params, seed, texture: this.texture }, (name) => gpu.constant(name));
                await gpu.pass(target, {
                    ...extra,
                    fragment: `${bound.declarations}\n${fragment}`,
                    inputs: { ...bound.inputs, ...(extra.inputs ?? {}) },
                    uniforms: { ...bound.uniforms, ...(extra.uniforms ?? {}) },
                });
            },
            texture: this.texture,
            external: (name) => external[name] ?? null,
            subgraph: async (graphId, params, inputs) => {
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
                try {
                    const outputs = entry.graph.nodes.filter((candidate) => candidate.type === OUTPUT_NODE_TYPE);
                    const states = await nested.evaluate({
                        graph: entry.graph,
                        parameters: params,
                        external: given,
                        externalVersion: request.externalVersion,
                        targets: outputs.map((candidate) => candidate.id),
                        size: { w: Math.log2(details.width), h: Math.log2(details.height) },
                        signal: request.signal,
                    });
                    const result: Record<string, GpuImage> = {};
                    for (const output of outputs) {
                        const state = states.get(output.id);
                        if (state?.error) throw new Error(`Inside "${entry.name}": ${state.error}`);
                        const image = state?.outputs.out;
                        if (image) {
                            result[output.id] = gpu.retain(image);
                            made.push(image);
                        }
                    }
                    return result;
                } catch (error) {
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
