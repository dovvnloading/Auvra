import { describe, expect, it } from 'vitest';
import { compileMaterialGraph } from '../../runtime/materials/materialGraph';
import { FLIPBOOK_FRAMES_NODE_TYPE } from '../../runtime/materials/materialNodes';
import { translatePass } from '../../texturing/gpu/glslModule';
import { FLIPBOOK_PACK_GLSL, flipbookCell, flipbookEdge, flipbookPlace, packFlipbook } from '../../texturing/graph/animation';
import { flipbookEdgeOf, materialGraphForTextures, rewriteMaterialPictures } from '../../texturing/materialOutput';

/** Where the pack reads the frame for an atlas pixel, as its shader works it out (in the frame's pixels, texel centres whole). */
const packedFrom = (pixel: [number, number], cell: [number, number, number, number], edge: [number, number], size: [number, number]): [number, number] =>
    [0, 1].map((axis) => (pixel[axis] - cell[axis] - edge[axis]) / Math.max(cell[2 + axis] - 2 * edge[axis], 1) * size[axis] - 0.5) as [number, number];

describe('flipbook frames inside an edge of their own', () => {
    it('leave an edge of about a 64th of a cell, a power of two of pixels, at least one', () => {
        expect(flipbookEdge(256, 256)).toEqual({ u: 4 / 256, v: 4 / 256 });
        expect(flipbookEdge(1024, 512)).toEqual({ u: 8 / 1024, v: 8 / 512 });
        expect(flipbookEdge(16, 16)).toEqual({ u: 1 / 16, v: 1 / 16 });
    });

    it('are read by the Flipbook Frames node exactly where the pack put them, each texel at its own place', () => {
        const columns = 4;
        const rows = 2;
        const frame: [number, number] = [64, 128];
        const edge = flipbookEdge(frame[0], frame[1]);
        const atlas = [frame[0] * columns, frame[1] * rows];
        for (const index of [0, 5, 7]) {
            const [u, v] = flipbookCell(index, columns, rows);
            const cell: [number, number, number, number] = [Math.round(u * atlas[0]), Math.round(v * atlas[1]), frame[0], frame[1]];
            for (const texel of [[0, 0], [10, 77], [63, 127]] as Array<[number, number]>) {
                // The node reads the frame's texel centre here on the whole picture...
                const place = flipbookPlace([(texel[0] + 0.5) / frame[0], (texel[1] + 0.5) / frame[1]], index, columns, rows, edge);
                const pixel: [number, number] = [place[0] * atlas[0], place[1] * atlas[1]];
                // ...inside the frame's cell and its edge...
                expect(pixel[0]).toBeGreaterThan(cell[0] + edge.u * frame[0]);
                expect(pixel[0]).toBeLessThan(cell[0] + frame[0] - edge.u * frame[0]);
                // ...where the pack drew that very texel.
                const from = packedFrom(pixel, cell, [edge.u * frame[0], edge.v * frame[1]], frame);
                expect(from[0]).toBeCloseTo(texel[0], 6);
                expect(from[1]).toBeCloseTo(texel[1], 6);
            }
            // The edge holds the frame carried on round its sides: just outside its left side is its right side.
            const outside = packedFrom([cell[0] + 0.5, cell[1] + frame[1] / 2], cell, [edge.u * frame[0], edge.v * frame[1]], frame);
            expect(outside[0]).toBeLessThan(0);
            expect(((Math.round(outside[0]) % frame[0]) + frame[0]) % frame[0]).toBeGreaterThan(frame[0] - 4);
        }
        // With no edge, a frame is copied as it is: every pixel a texel centre of its own.
        expect(packedFrom([10.5, 20.5], [0, 0, 64, 128], [0, 0], frame)).toEqual([10, 20]);
    });

    it('are packed with the edge given, by a pass that also translates for WebGPU', () => {
        const passes: Array<{ uniforms: Record<string, { x: number; y: number; z?: number; w?: number }>; scissor: unknown }> = [];
        const gpu = {
            image: (width: number, height: number, kind: string, precision: number) => ({ width, height, kind, precision, refs: 1, target: {} }),
            clear: () => undefined,
            passNow: (_target: unknown, options: { uniforms: Record<string, { x: number; y: number }>; scissor: unknown }) => { passes.push(options); },
        };
        const frames = Array.from({ length: 8 }, () => ({ width: 64, height: 128, kind: 'color', precision: 8, refs: 1, target: {} }));
        const atlas = packFlipbook(gpu as never, frames as never, 4, 2, flipbookEdge(64, 128));
        expect([atlas.width, atlas.height]).toEqual([256, 256]);
        expect(passes).toHaveLength(8);
        expect(passes[0].uniforms.uEdge).toMatchObject({ x: 1, y: 1 });
        expect(passes[5].uniforms.uCell).toMatchObject({ x: 64, y: 0, z: 64, w: 128 });
        expect(passes[5].scissor).toEqual({ x: 64, y: 0, width: 64, height: 128 });
        expect(() => translatePass({ fragment: FLIPBOOK_PACK_GLSL, inputs: ['source'] })).not.toThrow();
    });

    it('are read inside their edge by the material Update material writes, and a material from before reads none', () => {
        const flipbook = { frames: 8, columns: 4, rows: 2, loop: 2, edge: flipbookEdge(64, 128) };
        const graph = materialGraphForTextures({ baseColor: 'c', normal: 'n' }, { flipbook });
        expect(graph.nodes.find((node) => node.type === FLIPBOOK_FRAMES_NODE_TYPE)!.params).toMatchObject({ edgeU: 1 / 64, edgeV: 1 / 128 });
        expect(flipbookEdgeOf(graph)).toEqual(flipbook.edge);
        const compiled = compileMaterialGraph(graph);
        expect([...compiled.statements, ...Object.values(compiled.outputs)].join('\n')).toContain('1.0 - 2.0 *');
        expect(compiled.uniforms.filter((uniform) => uniform.param === 'edgeU' || uniform.param === 'edgeV')).toHaveLength(2);

        // Baked again with a new edge, the node takes it.
        const again = rewriteMaterialPictures({ graph, pictures: { baseColor: 'c', normal: 'n' } }, { baseColor: 'c2', normal: 'n2' }, { flipbook: { ...flipbook, edge: { u: 0.02, v: 0.01 } } });
        expect(flipbookEdgeOf(again.graph)).toEqual({ u: 0.02, v: 0.01 });

        // A flipbook made before edges: its node has none, so a game cooking it packs none.
        const before = { nodes: graph.nodes.map((node) => (node.type === FLIPBOOK_FRAMES_NODE_TYPE ? { ...node, params: { frames: 8, columns: 4, rows: 2, loop: 2 } } : node)) };
        expect(flipbookEdgeOf(before)).toEqual({ u: 0, v: 0 });
        expect(flipbookEdgeOf({ nodes: [] })).toEqual({ u: 0, v: 0 });
    });
});
