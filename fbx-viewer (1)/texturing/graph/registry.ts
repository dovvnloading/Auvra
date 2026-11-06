import { ADJUST_NODES } from './nodes/adjust';
import { DISTANCE_NODES } from './nodes/distance';
import { GENERATOR_NODES } from './nodes/generators';
import { INPUT_NODE_TYPE, IO_NODES, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE, SUBGRAPH_SEED_KEY, SUBGRAPH_VARY_KEY, subgraphParamDefs } from './nodes/io';
import { MATERIAL_NODES } from './nodes/materials';
import { SCATTER_NODES } from './nodes/scatter';
import { TRANSFORM_NODES } from './nodes/transform';
import { OUTPUT_CHANNEL_LABELS, outputNodeKind, type NodeCategory, type OutputChannel, type PortKind, type TexGraphLink, type TexGraphNode, type TexNodeDef, type TexParamDef, type TextureGraph } from './types';

/** Every node a texture graph can hold, by type; sub-graph nodes are made from the graph they use. */

export const TEXTURE_NODE_DEFINITIONS: readonly TexNodeDef[] = [...IO_NODES, ...GENERATOR_NODES, ...SCATTER_NODES, ...ADJUST_NODES, ...TRANSFORM_NODES, ...DISTANCE_NODES, ...MATERIAL_NODES];

const BY_TYPE = new Map(TEXTURE_NODE_DEFINITIONS.map((definition) => [definition.type, definition]));

export const NODE_CATEGORY_ORDER: readonly NodeCategory[] = [
    'Inputs and outputs', 'Mesh maps', 'Materials', 'Noises', 'Patterns', 'Shapes', 'Adjustments', 'Blending', 'Transforms', 'Warps',
    'Blurs and sharpening', 'Edges and distance', 'Height and normals', 'Utility',
];

/** A graph another can use as a node. */
export interface GraphEntry { id: string; name: string; graph: TextureGraph }
export type GraphResolver = (id: string) => GraphEntry | undefined;

/** An output's key on a sub-graph node: the Output node's id, which renaming does not change. */
export const outputLabel = (node: TexGraphNode): string => {
    const name = typeof node.params.name === 'string' ? node.params.name.trim() : '';
    if (name) return name;
    const channel = node.params.channel as OutputChannel;
    return OUTPUT_CHANNEL_LABELS[channel] ?? 'Output';
};

/** The settings every sub-graph node has after the graph's own parameters: its seed, and whether copies vary. */
const SUBGRAPH_SEED_PARAMS: readonly TexParamDef[] = [
    { key: SUBGRAPH_SEED_KEY, label: 'Random seed', kind: 'int', default: 0, min: 0, max: 9999, step: 1, hint: 'Each seed gives a different variation of the graph inside.' },
    { key: SUBGRAPH_VARY_KEY, label: 'Vary each copy', kind: 'bool', default: true, hint: 'On: every copy of this graph looks a little different, even with the same seed. Off: the seed alone sets the look, so copies with one seed match.' },
];

/** A sub-graph node's definition: the used graph's inputs, outputs and parameters. */
const subgraphDefinition = (node: TexGraphNode, resolve: GraphResolver): TexNodeDef => {
    const entry = typeof node.params.graph === 'string' ? resolve(node.params.graph) : undefined;
    const graph = entry?.graph;
    const inputs = (graph?.nodes ?? [])
        .filter((candidate) => candidate.type === INPUT_NODE_TYPE)
        .map((candidate) => ({ key: String(candidate.params.name || candidate.id), label: String(candidate.params.name || 'Input'), kind: (candidate.params.kind === 'gray' ? 'gray' : 'color') as PortKind, fallback: 'black' as const }));
    const outputs = (graph?.nodes ?? [])
        .filter((candidate) => candidate.type === OUTPUT_NODE_TYPE)
        .map((candidate) => ({ key: candidate.id, label: outputLabel(candidate), kind: outputNodeKind(candidate.params) }));
    return {
        type: SUBGRAPH_NODE_TYPE,
        label: entry?.name ?? 'Missing graph',
        category: 'Utility',
        description: entry ? `Uses the graph "${entry.name}" as one node; its exposed parameters are its settings.` : 'The graph this node used is no longer in the project.',
        inputs,
        outputs,
        params: [{ key: 'graph', label: 'Graph', kind: 'graph', default: '' }, ...subgraphParamDefs(graph?.parameters ?? []), ...SUBGRAPH_SEED_PARAMS],
        sizeFrom: 'graph',
        async run(context) {
            if (!entry) throw new Error('The graph this node used is no longer in the project.');
            const given: Record<string, ReturnType<typeof context.input>> = {};
            for (const input of inputs) given[input.key] = context.input(input.key);
            const values: Record<string, unknown> = {};
            for (const parameter of graph!.parameters) values[parameter.name] = context.params[parameter.name];
            return context.subgraph(entry.id, values, given);
        },
    };
};

export const SUBGRAPH_PLACEHOLDER: TexNodeDef = subgraphDefinition({ id: '', type: SUBGRAPH_NODE_TYPE, x: 0, y: 0, params: {} }, () => undefined);

/** The definition a node is drawn and run by; null for a type this build does not know. */
export const textureNodeDefinition = (node: TexGraphNode, resolve: GraphResolver): TexNodeDef | null => {
    if (node.type === SUBGRAPH_NODE_TYPE) return subgraphDefinition(node, resolve);
    return BY_TYPE.get(node.type) ?? null;
};

export const textureNodeDefinitionByType = (type: string): TexNodeDef | undefined => BY_TYPE.get(type);

/**
 * How the canvas shows a node of a type this build does not know: under its stored type, with a pin
 * for every wire into and out of it, so its wires stay in view. It draws nothing.
 */
export const placeholderDefinition = (node: TexGraphNode, links: readonly TexGraphLink[]): TexNodeDef => {
    const inputs = [...new Set(links.filter((link) => link.to === node.id).map((link) => link.toInput))];
    const outputs = [...new Set(links.filter((link) => link.from === node.id).map((link) => link.fromOutput))];
    return {
        type: node.type,
        label: `Not available: ${node.type}`,
        category: 'Utility',
        description: `This version of the editor has no "${node.type}" node, so it draws nothing. Its settings and wires are kept, and a version that has it draws it again.`,
        inputs: inputs.map((key) => ({ key, label: key, kind: 'any' as const })),
        outputs: (outputs.length ? outputs : ['out']).map((key) => ({ key, label: key, kind: 'any' as const })),
        params: [],
        sizeFrom: 'graph',
        async run() {
            throw new Error(`This version of the editor has no "${node.type}" node.`);
        },
    };
};
