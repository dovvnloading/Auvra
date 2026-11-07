import type { Point } from './model';

/**
 * TIDY LAYOUT
 *
 * Lays nodes out in columns by depth, left to right as the wires flow: each node sits one column left
 * of the nearest node it feeds (so what feeds a node sits beside it, not far off at the start), nodes
 * feeding nothing in the last column. In each column nodes are ordered to keep wires from crossing
 * (by where the nodes they feed and are fed by sit), then stacked with room between them, the
 * columns centred on one another. Nodes with no wires at all get a column of their own on the left.
 * The tidied nodes keep the top left corner of the box they had.
 */

export interface TidyNode { id: string; x: number; y: number; width: number; height: number }
export interface TidyLink { from: string; to: string }

export const TIDY_GAP = { x: 64, y: 28 };

export const tidyLayout = (nodes: readonly TidyNode[], links: readonly TidyLink[], gap = TIDY_GAP): Map<string, Point> => {
    const places = new Map<string, Point>();
    if (!nodes.length) return places;
    const ids = new Set(nodes.map((node) => node.id));
    const inside = links.filter((link) => ids.has(link.from) && ids.has(link.to) && link.from !== link.to);
    const feeds = new Map<string, string[]>();
    const fedBy = new Map<string, string[]>();
    for (const link of inside) {
        (feeds.get(link.from) ?? feeds.set(link.from, []).get(link.from)!).push(link.to);
        (fedBy.get(link.to) ?? fedBy.set(link.to, []).get(link.to)!).push(link.from);
    }

    // How far each node stands from the end of the flow (0 for nodes feeding nothing); loops are cut.
    const reach = new Map<string, number>();
    const visiting = new Set<string>();
    const distance = (id: string): number => {
        const known = reach.get(id);
        if (known !== undefined) return known;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let far = 0;
        for (const next of feeds.get(id) ?? []) far = Math.max(far, distance(next) + 1);
        visiting.delete(id);
        reach.set(id, far);
        return far;
    };
    const wired = nodes.filter((node) => feeds.has(node.id) || fedBy.has(node.id));
    const lonely = nodes.filter((node) => !feeds.has(node.id) && !fedBy.has(node.id));
    const deepest = Math.max(0, ...wired.map((node) => distance(node.id)));

    // Columns: the lonely ones first, then by depth.
    const columns: TidyNode[][] = [];
    if (lonely.length) columns.push([...lonely].sort((a, b) => a.y - b.y || a.x - b.x));
    const offset = columns.length;
    for (let i = 0; i <= deepest && wired.length; i++) columns.push([]);
    for (const node of wired) columns[offset + deepest - distance(node.id)].push(node);
    for (let i = offset; i < columns.length; i++) columns[i].sort((a, b) => a.y - b.y || a.x - b.x);

    // Order within columns: by the average place of their neighbours, a sweep each way, twice.
    const rank = new Map<string, number>();
    const rerank = () => columns.forEach((column) => column.forEach((node, index) => rank.set(node.id, index)));
    rerank();
    const mean = (list: readonly string[] | undefined, fallback: number) => {
        const known = (list ?? []).map((id) => rank.get(id)).filter((value): value is number => value !== undefined);
        return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : fallback;
    };
    for (let pass = 0; pass < 2; pass++) {
        for (let i = columns.length - 2; i >= offset; i--) {
            columns[i] = columns[i].map((node, index) => ({ node, key: mean(feeds.get(node.id), index) })).sort((a, b) => a.key - b.key).map((item) => item.node);
            rerank();
        }
        for (let i = offset + 1; i < columns.length; i++) {
            columns[i] = columns[i].map((node, index) => ({ node, key: mean(fedBy.get(node.id), index) })).sort((a, b) => a.key - b.key).map((item) => item.node);
            rerank();
        }
    }

    // Places: columns side by side, each stacked and centred on the tallest.
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const heights = columns.map((column) => column.reduce((sum, node) => sum + node.height, 0) + gap.y * Math.max(0, column.length - 1));
    const tallest = Math.max(...heights);
    let x = left;
    columns.forEach((column, index) => {
        let y = top + (tallest - heights[index]) / 2;
        for (const node of column) {
            places.set(node.id, { x: Math.round(x), y: Math.round(y) });
            y += node.height + gap.y;
        }
        x += Math.max(0, ...column.map((node) => node.width)) + gap.x;
    });
    return places;
};
