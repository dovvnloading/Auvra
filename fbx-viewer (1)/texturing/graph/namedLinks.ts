import type { TexGraphLink, TexGraphNode, TextureGraph } from './types';

/**
 * NAMED LINKS
 *
 * A sender and its receivers tie two far-apart places of a graph together without a wire across it:
 * every receiver gives out what the first sender of its name takes in. To drawing, they are one wire
 * from the sender to each receiver (on the receiver's hidden input).
 */

export const NAMED_SEND_TYPE = 'namedSend';
export const NAMED_RECEIVE_TYPE = 'namedReceive';

/** A sender's or receiver's name, as written (trimmed). */
export const linkName = (node: Pick<TexGraphNode, 'params'>): string => String(node.params.name ?? '').trim();

/** The wires the graph's named links stand for: each receiver fed by the first sender of its name. */
export const namedLinks = (graph: Pick<TextureGraph, 'nodes'>): TexGraphLink[] => {
    const senders = new Map<string, string>();
    for (const node of graph.nodes) {
        if (node.type !== NAMED_SEND_TYPE) continue;
        const name = linkName(node);
        if (name && !senders.has(name)) senders.set(name, node.id);
    }
    const links: TexGraphLink[] = [];
    for (const node of graph.nodes) {
        if (node.type !== NAMED_RECEIVE_TYPE) continue;
        const from = senders.get(linkName(node));
        if (from) links.push({ from, fromOutput: 'out', to: node.id, toInput: 'in' });
    }
    return links;
};

/** The graph with the wires its named links stand for added (the same graph when it has none). */
export const withNamedLinks = <G extends Pick<TextureGraph, 'nodes' | 'links'>>(graph: G): G => {
    const extra = namedLinks(graph);
    return extra.length ? { ...graph, links: [...graph.links.filter((link) => !extra.some((other) => other.to === link.to && other.toInput === link.toInput)), ...extra] } : graph;
};
