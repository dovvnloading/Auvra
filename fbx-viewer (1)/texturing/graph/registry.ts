import { ADJUST_NODES } from './nodes/adjust';
import { DISTANCE_NODES } from './nodes/distance';
import { GENERATOR_NODES } from './nodes/generators';
import { INPUT_NODE_TYPE, IO_NODES, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE, subgraphParamDefs } from './nodes/io';
import { TRANSFORM_NODES } from './nodes/transform';
import { CHANNEL_KIND, OUTPUT_CHANNEL_LABELS, type NodeCategory, type OutputChannel, type PortKind, type TexGraphNode, type TexNodeDef, type TextureGraph } from './types';

/** Every node a texture graph can hold, by type; sub-graph nodes are made from the graph they use. */

export const TEXTURE_NODE_DEFINITIONS: readonly TexNodeDef[] = [...IO_NODES, ...GENERATOR_NODES, ...ADJUST_NODES, ...TRANSFORM_NODES, ...DISTANCE_NODES];

const BY_TYPE = new Map(TEXTURE_NODE_DEFINITIONS.map((definition) => [definition.type, definition]));

export const NODE_CATEGORY_ORDER: readonly NodeCategory[] = [
    'Inputs and outputs', 'Mesh maps', 'Noises', 'Patterns', 'Shapes', 'Adjustments', 'Blending', 'Transforms', 'Warps',
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

/** A sub-graph node's definition: the used graph's inputs, outputs and parameters. */
const subgraphDefinition = (node: TexGraphNode, resolve: GraphResolver): TexNodeDef => {
    const entry = typeof node.params.graph === 'string' ? resolve(node.params.graph) : undefined;
    const graph = entry?.graph;
    const inputs = (graph?.nodes ?? [])
        .filter((candidate) => candidate.type === INPUT_NODE_TYPE)
        .map((candidate) => ({ key: String(candidate.params.name || candidate.id), label: String(candidate.params.name || 'Input'), kind: (candidate.params.kind === 'gray' ? 'gray' : 'color') as PortKind, fallback: 'black' as const }));
    const outputs = (graph?.nodes ?? [])
        .filter((candidate) => candidate.type === OUTPUT_NODE_TYPE)
        .map((candidate) => ({ key: candidate.id, label: outputLabel(candidate), kind: CHANNEL_KIND[(candidate.params.channel as OutputChannel)] ?? 'color' }));
    return {
        type: SUBGRAPH_NODE_TYPE,
        label: entry?.name ?? 'Missing graph',
        category: 'Utility',
        description: entry ? `Uses the graph "${entry.name}" as one node; its exposed parameters are its settings.` : 'The graph this node used is no longer in the project.',
        inputs,
        outputs,
        params: [{ key: 'graph', label: 'Graph', kind: 'graph', default: '' }, ...subgraphParamDefs(graph?.parameters ?? [])],
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
