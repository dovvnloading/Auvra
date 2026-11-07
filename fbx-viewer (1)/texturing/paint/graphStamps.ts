import type * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import type { GraphResolver } from '../graph/registry';
import { OUTPUT_NODE_TYPE } from '../graph/nodes/io';
import { graphContentKey } from '../graph/document';
import { OUTPUT_CHANNEL_LABELS, type OutputChannel } from '../graph/types';

/**
 * GRAPHS AS BRUSHES
 *
 * A brush whose shape is a texture graph's output: each dab stamps it (its brightness, as a picture
 * brush's alpha), drawn with the graph's parameters as the Brush panel sets them. Drawn once for each
 * set of values (on the GPU, at most 1024 across) and kept while the brush uses it.
 */

/** The graph a brush stamps: which graph, which of its outputs, and its parameters' values. */
export interface GraphStamp {
    graphId: string;
    /** The Output node's id; empty for the graph's first output. */
    output: string;
    values: Record<string, unknown>;
    /** Lay the output's colour on the colour channels (else only its brightness shapes the dabs). */
    colour?: boolean;
}

/** A graph stamp read back from a saved brush, made safe; null when it is not one. */
export const readGraphStamp = (value: unknown): GraphStamp | null => {
    const raw = value as Partial<GraphStamp> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.graphId !== 'string' || !raw.graphId) return null;
    const values = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? JSON.parse(JSON.stringify(raw.values)) as Record<string, unknown> : {};
    return { graphId: raw.graphId.slice(0, 128), output: typeof raw.output === 'string' ? raw.output.slice(0, 128) : '', values, ...(raw.colour === true ? { colour: true } : {}) };
};

/** The Output nodes of a graph a brush can stamp, by id and name. */
export const stampOutputs = (resolve: GraphResolver, graphId: string): Array<{ id: string; label: string }> =>
    (resolve(graphId)?.graph.nodes ?? []).filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => ({ id: node.id, label: String(node.params.name || '').trim() || OUTPUT_CHANNEL_LABELS[node.params.channel as OutputChannel] || 'Output' }));

/** How big a stamp is drawn: the graph's own size, at most 1024 across (as a power of two). */
export const stampSize = (graphSize: number): number => Math.min(10, Math.max(6, Math.round(graphSize)));

interface Drawn { key: string; image: GpuImage | null; error: string | null }

/** Stamps drawn for brushes, by their graph, output and values (and the graph's content). */
class GraphStamps {
    private readonly drawn = new Map<string, Drawn>();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    /**
     * The stamp's picture once drawn (null while it draws, or when it cannot be: `error` says why). Drawing
     * starts the first time it is asked for; listeners hear when it is ready.
     */
    get(stamp: GraphStamp, gpu: TextureGpu, resolve: GraphResolver, texture: (textureId: string) => THREE.Texture | null): { texture: THREE.Texture | null; error: string | null } {
        const entry = resolve(stamp.graphId);
        if (!entry) return { texture: null, error: 'The brush\'s graph is no longer in the project.' };
        // The graph (and those it uses, and their pictures loading) changing draws it again.
        const key = JSON.stringify([stamp.graphId, stamp.output, stamp.values, graphContentKey(entry.graph, resolve, (id) => Boolean(texture(id)))]);
        const known = this.drawn.get(key);
        if (known) return { texture: known.image?.target.texture ?? null, error: known.error };
        const drawn: Drawn = { key, image: null, error: null };
        this.drawn.set(key, drawn);
        // Only a few stamps are kept: the oldest go.
        for (const [other, value] of this.drawn) {
            if (this.drawn.size <= 6) break;
            if (other === key) continue;
            if (value.image) gpu.release(value.image);
            this.drawn.delete(other);
        }
        void (async () => {
            try {
                const { TextureGraphEvaluator } = await import('../graph/evaluator');
                const outputs = entry.graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
                const target = outputs.find((node) => node.id === stamp.output) ?? outputs[0];
                if (!target) throw new Error('The brush\'s graph has no output to stamp.');
                const evaluator = new TextureGraphEvaluator(gpu, resolve, texture);
                const size = stampSize(entry.graph.size.w);
                const states = await evaluator.evaluate({ graph: entry.graph, parameters: stamp.values, targets: [target.id], size: { w: size, h: size } });
                const state = states.get(target.id);
                if (state?.error) throw new Error(state.error);
                const image = state?.outputs.out;
                if (!image) throw new Error('The brush\'s graph drew nothing.');
                // Kept past the evaluator, which goes now.
                drawn.image = gpu.retain(image);
                evaluator.dispose();
            } catch (error) {
                drawn.error = error instanceof Error ? error.message : 'The brush\'s graph could not be drawn.';
            }
            this.version++;
            for (const listener of this.listeners) listener();
        })();
        return { texture: null, error: null };
    }
}

export const graphStamps = new GraphStamps();
