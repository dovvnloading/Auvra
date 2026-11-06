import { describe, expect, it } from 'vitest';
import { alignRects, distributeRects, snapPoint, snapToGrid } from '../../components/NodeGraph/arrange';
import { FRAME_PAD, FRAME_TITLE, fitFrame, frameContents, frameMembers, refitFrames } from '../../components/NodeGraph/frames';
import { fitsWire, pushRecent, rankEntries, scoreEntry, toggleFavourite, type FinderEntry } from '../../components/NodeGraph/finder';
import { HEADER, ROW, cardLayout } from '../../components/NodeGraph/layout';
import { connect, insertReroute, pasteNodes, setLook, spliceNode, wouldCycle, type EditableFrame, type EditableGraph, type EditableNode, type Rect } from '../../components/NodeGraph/model';
import type { NodeView } from '../../components/NodeGraph/types';
import { nearestWire, wireDistance } from '../../components/NodeGraph/wires';

const node = (id: string, x = 0, y = 0): EditableNode<null> => ({ id, type: 'blur', x, y, source: null });
const rect = (id: string, x: number, y: number, width = 100, height = 50) => ({ id, x, y, width, height });

describe('node graph arranging', () => {
    it('lines nodes up on their edges, centres and middles', () => {
        const rects = [rect('a', 10, 0, 100, 40), rect('b', 60, 100, 50, 60), rect('c', 300, 30, 80, 20)];
        expect(alignRects(rects, 'left')).toEqual(new Map([['a', { x: 10, y: 0 }], ['b', { x: 10, y: 100 }], ['c', { x: 10, y: 30 }]]));
        expect(alignRects(rects, 'right').get('b')).toEqual({ x: 330, y: 100 });
        // Centres on the middle of the box round them all: 10 to 380.
        expect(alignRects(rects, 'centre').get('c')).toEqual({ x: 155, y: 30 });
        expect(alignRects(rects, 'top').get('b')).toEqual({ x: 60, y: 0 });
        expect(alignRects(rects, 'bottom').get('a')).toEqual({ x: 10, y: 120 });
        expect(alignRects(rects, 'middle').get('c')).toEqual({ x: 300, y: 70 });
        expect(alignRects([rects[0]], 'left').size).toBe(0);
    });

    it('spaces nodes evenly, the outer two staying put', () => {
        const rects = [rect('a', 0, 0, 100), rect('c', 500, 0, 100), rect('b', 120, 30, 100)];
        const spread = distributeRects(rects, 'horizontal');
        // 600 wide, 300 of nodes: gaps of 150.
        expect(spread.get('a')).toEqual({ x: 0, y: 0 });
        expect(spread.get('b')).toEqual({ x: 250, y: 30 });
        expect(spread.get('c')).toEqual({ x: 500, y: 0 });
        const down = distributeRects([rect('a', 0, 0, 10, 10), rect('b', 0, 15, 10, 30), rect('c', 0, 200, 10, 10)], 'vertical');
        expect(down.get('b')).toEqual({ x: 0, y: 90 });
        expect(distributeRects(rects.slice(0, 2), 'horizontal').size).toBe(0);
    });

    it('snaps places to the grid', () => {
        expect(snapToGrid(29)).toBe(20);
        expect(snapToGrid(31)).toBe(40);
        expect(snapToGrid(-11)).toBe(-20);
        expect(snapPoint({ x: 47, y: 3 }, 10)).toEqual({ x: 50, y: 0 });
    });
});

describe('node graph frames', () => {
    const frame = (x: number, y: number, width: number, height: number, id = 'f'): EditableFrame => ({ id, x, y, width, height, title: 'Frame', colour: '#3b4252' });

    it('fits round the nodes it holds, keeping room for its title', () => {
        const fitted = fitFrame(frame(0, 0, 50, 50), [{ x: 100, y: 100, width: 140, height: 60 }, { x: 300, y: 180, width: 140, height: 60 }]);
        expect(fitted).toMatchObject({ x: 100 - FRAME_PAD, y: 100 - FRAME_PAD - FRAME_TITLE, width: 340 + FRAME_PAD * 2, height: 140 + FRAME_PAD * 2 + FRAME_TITLE, title: 'Frame' });
        const empty = frame(0, 0, 50, 50);
        expect(fitFrame(empty, [])).toBe(empty);
    });

    it('holds the nodes whose middle lies in it, each in the innermost frame round it', () => {
        const outer = frame(0, 0, 1000, 1000, 'outer');
        const inner = frame(100, 100, 300, 300, 'inner');
        const rects = new Map<string, Rect>([['a', { x: 150, y: 150, width: 100, height: 50 }], ['b', { x: 600, y: 600, width: 100, height: 50 }], ['c', { x: 2000, y: 0, width: 100, height: 50 }]]);
        expect(frameMembers(inner, rects, [outer, inner])).toEqual(['a']);
        expect(frameMembers(outer, rects, [outer, inner])).toEqual(['b']);
        // Dragged, the outer frame carries everything in it: the inner frame and its nodes too.
        expect(frameContents(outer, rects, [outer, inner])).toEqual({ nodes: ['a', 'b'], frames: ['inner'] });
        expect(frameContents(inner, rects, [outer, inner])).toEqual({ nodes: ['a'], frames: [] });
    });

    it('lets dragged nodes leave and join frames, and refits the frames they touched', () => {
        const left = frame(0, 0, 400, 300, 'left');
        const right = frame(1000, 0, 400, 300, 'right');
        const lonely = frame(3000, 0, 200, 200, 'lonely');
        const before = new Map<string, Rect>([['a', { x: 50, y: 60, width: 100, height: 50 }], ['b', { x: 200, y: 150, width: 100, height: 50 }]]);
        // b moves into the right frame.
        const after = new Map(before).set('b', { x: 1100, y: 100, width: 100, height: 50 });
        const frames = refitFrames([left, right, lonely], before, after, new Set(['b']));
        expect(frames[0]).toEqual(fitFrame(left, [before.get('a')!]));
        expect(frames[1]).toEqual(fitFrame(right, [after.get('b')!]));
        expect(frames[2]).toBe(lonely);
        // Moved a little within its frame: the frame grows round it.
        const nudged = new Map(before).set('a', { x: 20, y: 230, width: 100, height: 50 });
        expect(refitFrames([left], before, nudged, new Set(['a']))[0]).toEqual(fitFrame(left, [nudged.get('a')!, before.get('b')!]));
    });
});

describe('node graph finder', () => {
    const entries: FinderEntry[] = [
        { id: 'blur', label: 'Blur', category: 'Blurs', keywords: ['gaussian', 'soften'], description: 'A smooth blur.' },
        { id: 'directionalBlur', label: 'Directional blur', category: 'Blurs', keywords: ['motion blur'] },
        { id: 'normalFromHeight', label: 'Normal from height', category: 'Height and normals', keywords: ['bump'] },
        { id: 'levels', label: 'Levels', category: 'Adjustments', description: 'Sets the black and white points.' },
        { id: 'perlin', label: 'Perlin noise', category: 'Noises', keywords: ['gradient noise'] },
    ];
    const ids = (list: FinderEntry[]) => list.map((entry) => entry.id);

    it('ranks the name first, then the words a node is known by, then what it does', () => {
        expect(ids(rankEntries(entries, 'blur', { favourites: [], recent: [] }))).toEqual(['blur', 'directionalBlur']);
        expect(ids(rankEntries(entries, 'motion', { favourites: [], recent: [] }))).toEqual(['directionalBlur']);
        expect(ids(rankEntries(entries, 'nrml', { favourites: [], recent: [] }))).toEqual(['normalFromHeight']);
        expect(ids(rankEntries(entries, 'black points', { favourites: [], recent: [] }))).toEqual(['levels']);
        expect(ids(rankEntries(entries, 'xyz', { favourites: [], recent: [] }))).toEqual([]);
        expect(scoreEntry(entries[0], ['blur'])).toBeGreaterThan(scoreEntry(entries[1], ['blur']));
    });

    it('puts favourites, then recent nodes, first when nothing is typed, and a little ahead when equal', () => {
        const memory = { favourites: ['levels'], recent: ['perlin', 'blur'] };
        expect(ids(rankEntries(entries, '', memory))).toEqual(['levels', 'perlin', 'blur', 'directionalBlur', 'normalFromHeight']);
        const tied: FinderEntry[] = [{ id: 'x', label: 'Warp', category: 'Warps' }, { id: 'y', label: 'Warp', category: 'Warps' }];
        expect(ids(rankEntries(tied, 'warp', { favourites: ['y'], recent: [] }))).toEqual(['y', 'x']);
    });

    it('keeps recent nodes newest first, once each, and toggles favourites', () => {
        expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
        expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
        expect(toggleFavourite(['a'], 'b')).toEqual(['a', 'b']);
        expect(toggleFavourite(['a', 'b'], 'a')).toEqual(['b']);
    });

    it('offers only nodes with a pin that suits a dragged wire', () => {
        const match = (from: string, to: string) => (from === to || to === 'any' ? 2 : 0);
        expect(fitsWire({ id: 'a', label: 'A', category: 'c', inputs: ['gray'] }, { side: 'out', kind: 'gray' }, match)).toBe(true);
        expect(fitsWire({ id: 'a', label: 'A', category: 'c', inputs: ['color'] }, { side: 'out', kind: 'gray' }, match)).toBe(false);
        expect(fitsWire({ id: 'a', label: 'A', category: 'c', outputs: ['gray'] }, { side: 'in', kind: 'any' }, match)).toBe(true);
    });
});

describe('node graph edits', () => {
    const graph = (): EditableGraph<null> => ({
        nodes: [node('noise'), node('out', 400)],
        links: [{ from: 'noise', fromPin: 'out', to: 'out', toPin: 'in' }],
        frames: [],
    });
    const match = (from: string, to: string) => (from === to ? 2 : to === 'any' || from === 'any' ? 1 : 0);

    it('splices a node dropped on a wire into it, through its best pins', () => {
        const blur = node('blur', 200);
        const spliced = spliceNode(graph(), graph().links[0], blur, { inputs: [{ key: 'mask', kind: 'gray' }, { key: 'in', kind: 'color' }], outputs: [{ key: 'out', kind: 'color' }] }, { carried: 'color', taken: 'color' }, match);
        expect(spliced.nodes.map((candidate) => candidate.id)).toEqual(['noise', 'out', 'blur']);
        expect(spliced.links).toEqual([
            { from: 'noise', fromPin: 'out', to: 'blur', toPin: 'in' },
            { from: 'blur', fromPin: 'out', to: 'out', toPin: 'in' },
        ]);
    });

    it('adds a node it cannot splice without breaking the wire', () => {
        const generator = node('shape', 200);
        const kept = spliceNode(graph(), graph().links[0], generator, { inputs: [], outputs: [{ key: 'out', kind: 'gray' }] }, { carried: 'color', taken: 'color' }, match);
        expect(kept.links).toEqual(graph().links);
        expect(kept.nodes.map((candidate) => candidate.id)).toContain('shape');
    });

    it('wires one input once, refuses loops, puts reroute points on wires and pastes with new ids', () => {
        const base = graph();
        expect(wouldCycle(base.links, 'out', 'noise')).toBe(true);
        expect(connect(base, { from: 'out', fromPin: 'out', to: 'noise', toPin: 'in' })).toBeNull();
        const rewired = connect({ ...base, nodes: [...base.nodes, node('other')] }, { from: 'other', fromPin: 'out', to: 'out', toPin: 'in' })!;
        expect(rewired.links).toEqual([{ from: 'other', fromPin: 'out', to: 'out', toPin: 'in' }]);
        const routed = insertReroute(base, base.links[0], node('dot', 200));
        expect(routed.links).toEqual([{ from: 'noise', fromPin: 'out', to: 'dot', toPin: 'in' }, { from: 'dot', fromPin: 'out', to: 'out', toPin: 'in' }]);
        let n = 0;
        const pasted = pasteNodes(base, base.nodes, base.links, { x: 1000, y: 500 }, () => `copy${n++}`);
        expect(pasted.ids).toEqual(['copy0', 'copy1']);
        expect(pasted.graph.links.slice(1)).toEqual([{ from: 'copy0', fromPin: 'out', to: 'copy1', toPin: 'in' }]);
        expect(pasted.graph.nodes.find((candidate) => candidate.id === 'copy1')).toMatchObject({ x: 1400, y: 500 });
        const looked = setLook(base, new Set(['noise']), { name: 'Base noise', bypass: true });
        expect(looked.nodes[0]).toMatchObject({ name: 'Base noise', bypass: true });
        expect('bypass' in setLook(looked, new Set(['noise']), { bypass: false }).nodes[0]).toBe(false);
    });

    it('finds the wire nearest a point', () => {
        const from = { x: 0, y: 0 };
        const to = { x: 200, y: 100 };
        expect(wireDistance({ x: 0, y: 0 }, from, to).distance).toBeCloseTo(0);
        expect(nearestWire({ x: 100, y: 50 }, [{ key: 'a', from, to }, { key: 'b', from: { x: 0, y: 400 }, to: { x: 200, y: 400 } }], 8)).toBe('a');
        expect(nearestWire({ x: 100, y: 250 }, [{ key: 'a', from, to }], 8)).toBeNull();
    });
});

describe('node graph cards', () => {
    const view = (inputs: NodeView['inputs'], outputs: NodeView['outputs'] = [{ key: 'out', label: 'Out', kind: 'vec3' }]): NodeView => ({ title: 'Node', tint: '#333', layout: 'rows', width: 200, body: 0, inputs, outputs, canBypass: true, canDelete: true });

    it('lists pins in rows, then each group under its heading, a closed group showing only its wired pins', () => {
        const card = view([
            { key: 'a', label: 'A', kind: 'float' },
            { key: 'base', label: 'Base colour', kind: 'vec3', group: 'Base' },
            { key: 'coat', label: 'Coat', kind: 'float', group: 'Coat' },
            { key: 'coatRough', label: 'Coat roughness', kind: 'float', group: 'Coat' },
        ]);
        const closed = cardLayout(card, {}, new Set(['in:coatRough']));
        // Row 0: A and Out; Base heading (open, the first group); Base colour; Coat heading (closed); Coat roughness (wired).
        expect(closed.rows.map((row) => (row.kind === 'group' ? `[${row.group}${row.open ? '' : ` +${row.hidden}`}]` : `${row.input?.key ?? ''}|${row.output?.key ?? ''}`))).toEqual(['a|out', '[Base]', 'base|', '[Coat +1]', 'coatRough|']);
        expect(closed.inputs.has('coat')).toBe(false);
        expect(closed.inputs.get('coatRough')).toEqual({ x: 0, y: HEADER + ROW * 4 + ROW / 2 });
        const opened = cardLayout(card, {}, new Set(), new Map([['Coat', true], ['Base', false]]));
        expect(opened.inputs.has('base')).toBe(false);
        expect(opened.inputs.has('coat')).toBe(true);
        const folded = cardLayout(card, { collapsed: true }, new Set(['in:a']));
        expect(folded.height).toBe(HEADER);
        expect([...folded.inputs.keys()]).toEqual(['a']);
    });
});
