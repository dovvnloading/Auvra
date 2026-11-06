import type { ChannelTextureIds, PictureLayout } from '../materialOutput';
import { MAX_SIZE_LOG2, MIN_SIZE_LOG2, coerceParameter, createTextureGraph, drawnPart, graphDependencies, hashText, normalizeTextureGraph } from './document';
import type { GraphResolver } from './registry';
import type { TextureGraph } from './types';

/**
 * A material made by a texture graph, as its material document keeps it (`textureGraph`): the graph,
 * the values its parameters are set to on this material, how its pictures are made, and which
 * pictures were made last (so the editor can say when they no longer match the graph).
 */

export interface StoredTextureGraph {
    graph: TextureGraph;
    /** This material's values for the graph's parameters. */
    values: Record<string, unknown>;
    /** Size of the made pictures, a power of two. */
    bakeSize: number;
    layout: PictureLayout;
    /** The pictures last made, and what they were made from. */
    baked?: { textures: ChannelTextureIds; signature: string; size: number; at: number };
    /** Whether this graph is meant to be used inside other graphs rather than drawn on models. */
    library?: boolean;
}

export const readStoredGraph = (value: unknown): StoredTextureGraph => {
    const raw = (value && typeof value === 'object' ? value : {}) as Partial<StoredTextureGraph>;
    const graph = normalizeTextureGraph(raw.graph ?? createTextureGraph());
    const values: Record<string, unknown> = {};
    const given = raw.values && typeof raw.values === 'object' ? raw.values : {};
    for (const parameter of graph.parameters) {
        const v = (given as Record<string, unknown>)[parameter.name];
        if (v !== undefined) values[parameter.name] = coerceParameter(parameter.kind, v, parameter.options);
    }
    const stored: StoredTextureGraph = {
        graph,
        values,
        bakeSize: Math.min(MAX_SIZE_LOG2, Math.max(MIN_SIZE_LOG2 + 4, Math.round(Number(raw.bakeSize) || 11))),
        layout: raw.layout === 'separate' ? 'separate' : 'engine',
    };
    const baked = raw.baked;
    if (baked && typeof baked === 'object' && baked.textures && typeof baked.textures === 'object') {
        const textures: ChannelTextureIds = {};
        for (const [role, id] of Object.entries(baked.textures)) if (typeof id === 'string' && id) textures[role as keyof ChannelTextureIds] = id;
        stored.baked = { textures, signature: String(baked.signature ?? ''), size: Number(baked.size) || stored.bakeSize, at: Number(baked.at) || 0 };
    }
    if (raw.library) stored.library = true;
    return stored;
};

/** What the made pictures depend on: the graph (not where its nodes sit), its values, the graphs it uses and how they are made. */
export const bakeSignature = (stored: StoredTextureGraph, resolve: GraphResolver): string => {
    const shape = (graph: TextureGraph) => [graph.size, graph.seed, graph.parameters, graph.nodes.map(drawnPart), graph.links];
    const used: unknown[] = [];
    const seen = new Set<string>();
    const visit = (graph: TextureGraph) => {
        for (const id of graphDependencies(graph)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const entry = resolve(id);
            if (!entry) { used.push([id, 'missing']); continue; }
            used.push([id, shape(entry.graph)]);
            visit(entry.graph);
        }
    };
    visit(stored.graph);
    return hashText(JSON.stringify([shape(stored.graph), stored.values, stored.bakeSize, stored.layout, used]));
};
