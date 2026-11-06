import { describe, expect, it } from 'vitest';
import { tidyLayout, TIDY_GAP, type TidyNode } from '../../components/NodeGraph/tidy';
import { NAMED_RECEIVE_TYPE, NAMED_SEND_TYPE, namedLinks, withNamedLinks } from '../../texturing/graph/namedLinks';

const box = (id: string, x = 0, y = 0, width = 100, height = 50): TidyNode => ({ id, x, y, width, height });

describe('tidy layout', () => {
    it('puts a chain in columns left to right, keeping the top left corner', () => {
        const places = tidyLayout([box('c', 500, 400), box('a', 100, 100), box('b', 300, 900)], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
        expect(places.get('a')).toEqual({ x: 100, y: 100 });
        expect(places.get('b')).toEqual({ x: 100 + 100 + TIDY_GAP.x, y: 100 });
        expect(places.get('c')).toEqual({ x: 100 + 2 * (100 + TIDY_GAP.x), y: 100 });
    });

    it('sets a node just left of what it feeds, not at the start', () => {
        // n2 -> mid -> out, and n1 -> out: n1 sits beside out, in mid's column.
        const places = tidyLayout([box('out'), box('mid'), box('n1'), box('n2')], [{ from: 'n2', to: 'mid' }, { from: 'mid', to: 'out' }, { from: 'n1', to: 'out' }]);
        expect(places.get('n2')!.x).toBeLessThan(places.get('mid')!.x);
        expect(places.get('n1')!.x).toBe(places.get('mid')!.x);
        expect(places.get('out')!.x).toBeGreaterThan(places.get('mid')!.x);
    });

    it('stacks a column without overlaps, ordered to follow what it feeds, and gives lonely nodes a column of their own', () => {
        const nodes = [box('top', 0, 0), box('bottom', 0, 300), box('a', 0, 600), box('b', 0, 50), box('alone', 0, 0)];
        // a feeds top (which sits first), b feeds bottom: a goes above b in their column.
        const places = tidyLayout(nodes, [{ from: 'a', to: 'top' }, { from: 'b', to: 'bottom' }]);
        expect(places.get('a')!.y).toBeLessThan(places.get('b')!.y);
        expect(places.get('b')!.y - places.get('a')!.y).toBeGreaterThanOrEqual(50 + TIDY_GAP.y);
        expect(places.get('alone')!.x).toBeLessThan(places.get('a')!.x);
    });

    it('copes with a loop of wires', () => {
        const places = tidyLayout([box('a'), box('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
        expect(places.size).toBe(2);
    });
});

describe('named links', () => {
    const node = (id: string, type: string, name: string) => ({ id, type, x: 0, y: 0, params: { name } });

    it('ties each receiver to the first sender of its name, as a wire', () => {
        const graph = {
            nodes: [node('s1', NAMED_SEND_TYPE, 'dirt'), node('s2', NAMED_SEND_TYPE, 'dirt'), node('r1', NAMED_RECEIVE_TYPE, ' dirt '), node('r2', NAMED_RECEIVE_TYPE, 'rust')],
            links: [{ from: 'x', fromOutput: 'out', to: 's1', toInput: 'in' }],
        };
        expect(namedLinks(graph)).toEqual([{ from: 's1', fromOutput: 'out', to: 'r1', toInput: 'in' }]);
        expect(withNamedLinks(graph).links).toHaveLength(2);
        const plain = { nodes: [node('a', 'blur', '')], links: [] };
        expect(withNamedLinks(plain)).toBe(plain);
    });
});
