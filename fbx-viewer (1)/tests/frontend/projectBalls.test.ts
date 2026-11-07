import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import { BallShelf, ballLook } from '../../components/Materials/ballShelf';

const asset = (id: string, colour: number[] = [0.8, 0.8, 0.8], pictures?: Record<string, string>): MaterialAsset => {
    const graph = createMaterialGraph();
    return { id, name: id, graph: { ...graph, nodes: graph.nodes.map(node => ({ ...node, params: { ...node.params, baseColor: colour } })) }, ...(pictures ? { pictures } : {}) };
};
const none = () => null;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const shelfWith = () => {
    const drawn: string[] = [];
    let urls = 0;
    const released: string[] = [];
    const shelf = new BallShelf(async (material) => { drawn.push(material.id); return new Blob([material.id]); }, 600, () => Date.now(), () => `url-${++urls}`, (url) => released.push(url));
    return { shelf, drawn, released };
};

describe('balls in the project\'s material list', () => {
    it('are drawn once edits settle, one at a time, and only again when the look changes', async () => {
        const { shelf, drawn, released } = shelfWith();
        const red = asset('red', [1, 0, 0]);
        shelf.want(red, ballLook(red, () => true), none, 1);
        shelf.want(asset('blue'), ballLook(asset('blue'), () => true), none, 1);
        expect(drawn).toEqual([]);
        await vi.advanceTimersByTimeAsync(700);
        expect(drawn).toEqual(['red', 'blue']);
        expect(shelf.ball('red')).toBe('url-1');
        // The same look again draws nothing.
        shelf.want(red, ballLook(red, () => true), none, 1);
        await vi.advanceTimersByTimeAsync(700);
        expect(drawn).toEqual(['red', 'blue']);
        // A slider dragged: only the last value is drawn, and the old ball shows meanwhile.
        for (const value of [0.2, 0.4, 0.6]) {
            const edited = asset('red', [value, 0, 0]);
            shelf.want(edited, ballLook(edited, () => true), none, 1);
            await vi.advanceTimersByTimeAsync(200);
            expect(shelf.ball('red')).toBe('url-1');
        }
        await vi.advanceTimersByTimeAsync(700);
        expect(drawn).toEqual(['red', 'blue', 'red']);
        expect(shelf.ball('red')).toBe('url-3');
        expect(released).toEqual(['url-1']);
    });

    it('are drawn again when a texture the material names arrives', () => {
        const pictured = asset('crate', [1, 1, 1], { baseColor: 'tex-1' });
        expect(ballLook(pictured, () => false)).not.toBe(ballLook(pictured, () => true));
        expect(ballLook(asset('a'), () => false)).toBe(ballLook(asset('a'), () => true));
    });

    it('are let go of when another project opens', async () => {
        const { shelf, released } = shelfWith();
        shelf.want(asset('red'), 'look', none, 1);
        await vi.advanceTimersByTimeAsync(700);
        expect(shelf.ball('red')).toBe('url-1');
        shelf.want(asset('green'), 'look', none, 2);
        expect(shelf.ball('red')).toBeNull();
        expect(released).toEqual(['url-1']);
    });
});
