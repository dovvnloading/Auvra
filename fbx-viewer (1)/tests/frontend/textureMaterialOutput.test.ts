import { describe, expect, it } from 'vitest';
import { compileMaterialGraph } from '../../runtime/materials/materialGraph';
import { materialGraphForTextures } from '../../texturing/materialOutput';

describe('painted sets as engine materials', () => {
    it('reads a picture of several UDIM tiles with the coordinates scaled to its grid', () => {
        const graph = materialGraphForTextures({ baseColor: 'colour', normal: 'normal', orm: 'orm', emissive: 'glow' }, { tiles: { columns: 2, rows: 1 } });
        const tiling = graph.nodes.find((node) => node.type === 'tilingOffset');
        expect(tiling?.params.tiling).toEqual([0.5, 1]);
        expect(tiling?.params.offset).toEqual([0, 0]);
        const fed = graph.links.filter((link) => link.fromNode === tiling!.id && link.toInput === 'uv').map((link) => link.toNode).sort();
        expect(fed).toEqual(['baseColor', 'emissive', 'normal', 'orm']);
        // Every picture is sampled at the scaled coordinates.
        const code = compileMaterialGraph(graph).statements.join('\n');
        expect(code).toMatch(/vUv \* mg_udimTiles_tiling/);
        for (const id of ['baseColor', 'normal', 'orm', 'emissive']) expect(code).toMatch(new RegExp(`texture\\(mg_${id}_texture, mg_udimTiles`));
    });

    it('reads a grid two tiles high with the rows scaled too', () => {
        const graph = materialGraphForTextures({ baseColor: 'colour' }, { tiles: { columns: 2, rows: 2 } });
        expect(graph.nodes.find((node) => node.type === 'tilingOffset')?.params.tiling).toEqual([0.5, 0.5]);
    });

    it('reads one tile as it is', () => {
        for (const options of [{}, { tiles: { columns: 1, rows: 1 } }]) {
            const graph = materialGraphForTextures({ baseColor: 'colour', orm: 'orm' }, options);
            expect(graph.nodes.some((node) => node.type === 'tilingOffset')).toBe(false);
            expect(compileMaterialGraph(graph).statements.join('\n')).toContain('texture(mg_baseColor_texture, vUv)');
        }
    });
});
