import { describe, expect, it, vi } from 'vitest';
import { compileMaterialGraph, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { compileGraphWgsl } from '../../renderer/gpu/surfaces/materialWgsl';
import { readUdimTiles } from '../../runtime/materials/materialNodes';
import { encodeChannels, materialGraphForTextures, materialReadsPicture, tileAtlasLayout, udimAtlasPoint, type ChannelImages } from '../../texturing/materialOutput';
import type { GpuImage, TextureGpu } from '../../texturing/gpu/textureGpu';

// The test browser cannot compress a PNG; which way each picture is written is what matters here.
vi.mock('../../texturing/png', () => ({ encodePng16: async () => new Blob(), encodePng: async () => new Blob() }));

/** What feeds each Material Output input: `node.output`. */
const feeds = (graph: ReturnType<typeof materialGraphForTextures>) => Object.fromEntries(graph.links
    .filter((link) => link.toNode === 'output')
    .map((link) => [link.toInput, `${link.fromNode}.${link.fromOutput}`]));

describe('painted and graph-made pictures as engine materials', () => {
    it('reads occlusion, roughness and metallic from the packed picture', () => {
        const graph = materialGraphForTextures({ baseColor: 'colour', orm: 'orm' });
        expect(feeds(graph)).toEqual({ baseColor: 'baseColor.rgb', occlusion: 'orm.r', roughness: 'orm.g', metalness: 'orm.b' });
    });

    it('reads one picture per channel when that is what was written', () => {
        const graph = materialGraphForTextures({ baseColor: 'colour', roughness: 'rough', metallic: 'metal', ambientOcclusion: 'ao' });
        expect(feeds(graph)).toEqual({ baseColor: 'baseColor.rgb', occlusion: 'ambientOcclusion.r', roughness: 'roughness.r', metalness: 'metallic.r' });
        const textures = Object.fromEntries(graph.nodes.filter((node) => node.type === 'texture').map((node) => [node.id, [node.params.texture, node.params.space]]));
        expect(textures).toMatchObject({ roughness: ['rough', 'data'], metallic: ['metal', 'data'], ambientOcclusion: ['ao', 'data'] });
        const code = compileMaterialGraph(normalizeMaterialGraph(graph)).statements.join('\n');
        expect(code).toContain('texture(mg_roughness_texture, vUv)');
    });

    it('draws height through Parallax, moving the other pictures and shading the low parts', () => {
        const graph = materialGraphForTextures({ baseColor: 'colour', height: 'bumps' });
        const parallax = graph.nodes.find((node) => node.type === 'parallax')!;
        expect(parallax.params.texture).toBe('bumps');
        expect(graph.links).toEqual(expect.arrayContaining([
            { fromNode: 'parallax', fromOutput: 'uv', toNode: 'baseColor', toInput: 'uv' },
            { fromNode: 'parallax', fromOutput: 'shadow', toNode: 'output', toInput: 'selfShadow' },
            { fromNode: 'heightDepth', fromOutput: 'out', toNode: 'parallax', toInput: 'depth' },
        ]));
        // Its depth is a value each use of the material can change.
        expect(graph.nodes.find((node) => node.id === 'heightDepth')).toMatchObject({ parameter: 'Height depth', params: { value: 0.03 } });
        expect(materialReadsPicture('height')).toBe(true);
        expect(materialReadsPicture('orm')).toBe(true);
        // Without height nothing marches through one.
        expect(materialGraphForTextures({ baseColor: 'colour' }).nodes.some((node) => node.type === 'parallax')).toBe(false);
    });

    it('writes height at 16 bits whatever the pictures are for, and the rest as asked', async () => {
        const deep: string[] = [];
        const gpu = {
            readUint16Async: async (image: GpuImage) => { deep.push((image as unknown as { name: string }).name); return new Uint16Array(4); },
            toPng: async () => new Blob(),
        } as unknown as TextureGpu;
        const image = (name: string, kind: 'color' | 'gray') => ({ name, kind }) as unknown as GpuImage;
        const images: ChannelImages = { baseColor: image('baseColor', 'color'), normal: image('normal', 'color'), height: image('height', 'gray') };
        const pictures = await encodeChannels(gpu, images, 2, 2, 'separate', true);
        expect(pictures.map((picture) => picture.role)).toEqual(['baseColor', 'normal', 'height']);
        expect(deep).toEqual(['height']);
    });
});

describe('a UDIM tile atlas', () => {
    it('holds only the tiles in use, side by side', () => {
        // Before, 1001 and 1010 made a picture ten tiles wide.
        const layout = tileAtlasLayout([1010, 1001], 2048, 16384);
        expect(layout).toMatchObject({ tiles: [1001, 1010], columns: 2, rows: 1, cell: 2048, gutter: 32 });
        expect([layout.width, layout.height]).toEqual([2 * 2112, 2112]);
    });

    it('packs larger sets into a grid that never passes what the GPU holds', () => {
        const tiles = [1001, 1002, 1003, 1004, 1005, 1011, 1012, 1013];
        const layout = tileAtlasLayout(tiles, 4096, 8192);
        expect([layout.columns, layout.rows]).toEqual([3, 3]);
        expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(8192);
        expect(layout.cell).toBeLessThan(4096);
    });

    it('keeps every cell on the texel edges of the first mip levels', () => {
        for (const [size, maxSize] of [[2048, 16384], [1000, 16384], [4096, 6000], [512, 16384]]) {
            const { cell, gutter } = tileAtlasLayout([1001, 1002, 1003], size, maxSize);
            expect(Math.log2(gutter) % 1).toBe(0);
            expect(gutter).toBeGreaterThanOrEqual(2);
            // A cell is a multiple of two gutters, so mip levels down to texels that wide never straddle two cells.
            expect((cell + 2 * gutter) % (2 * gutter)).toBe(0);
        }
    });

    it('reads each point inside its own tile\'s cell, never in a neighbour or the gutter', () => {
        const layout = tileAtlasLayout([1001, 1002, 1010, 1011], 256, 16384);
        const stride = layout.cell + 2 * layout.gutter;
        const pixelOf = (u: number, v: number) => {
            const [x, y] = udimAtlasPoint(layout, u, v);
            return [x * layout.width, y * layout.height];
        };
        // 1010 is the third tile: column 0, row 1 of a 2 × 2 grid.
        const [x, y] = pixelOf(9.5, 0.5);
        expect(x).toBeCloseTo(layout.gutter + 128);
        expect(y).toBeCloseTo(stride + layout.gutter + 128);
        // Its edges stay half a pixel inside the tile.
        const [left, bottom] = pixelOf(9, 0);
        expect(left).toBeCloseTo(layout.gutter + 0.5);
        expect(bottom).toBeCloseTo(stride + layout.gutter + 0.5);
        const [right] = pixelOf(9.99999, 0.5);
        expect(right).toBeLessThanOrEqual(layout.gutter + layout.cell - 0.5 + 1e-6);
    });

    it('is read through a UDIM Atlas node, wired into every picture', () => {
        const layout = tileAtlasLayout([1001, 1010], 1024, 16384);
        const graph = materialGraphForTextures({ baseColor: 'colour', normal: 'normal', orm: 'orm', emissive: 'glow' }, { tiles: layout });
        const atlas = graph.nodes.find((node) => node.type === 'udimAtlas')!;
        expect(atlas.params).toMatchObject({ tiles: '1001 1010', columns: 2, tileSize: 1024, gutter: 16 });
        const fed = graph.links.filter((link) => link.fromNode === atlas.id && link.toInput === 'uv').map((link) => link.toNode).sort();
        expect(fed).toEqual(['baseColor', 'emissive', 'normal', 'orm']);
        const code = compileMaterialGraph(normalizeMaterialGraph(graph)).statements.join('\n');
        // 1010 is the second cell.
        expect(code).toMatch(/if \(abs\(mg_udimTiles_tile - 1010\.0\) < 0\.5\) mg_udimTiles_cell = 1\.0;/);
        for (const id of ['baseColor', 'normal', 'orm', 'emissive']) expect(code).toMatch(new RegExp(`textureGrad\\(mg_${id}_texture, mg_udimTiles_out_out_`));
    });

    it('retains continuous atlas gradients through height parallax, the normal map and material pictures', () => {
        const layout = tileAtlasLayout([1001, 1002, 1011], 256, 4096);
        const graph = normalizeMaterialGraph(materialGraphForTextures({ baseColor: 'colour', normal: 'normal', height: 'height' }, { tiles: layout }));
        const colour = graph.nodes.find(node => node.id === 'baseColor')!;
        colour.type = 'materialPicture';
        const compiled = compileMaterialGraph(graph).statements.join('\n');
        const dx = 'dFdx((mg_udimTiles_uv * mg_udimTiles_tileSize';
        expect(compiled).toContain('textureGrad(mg_baseColor_texture');
        expect(compiled).toContain('textureGrad(mg_normal_texture');
        expect(compiled.split(dx).length - 1).toBeGreaterThanOrEqual(4);
        const wgsl = compileGraphWgsl(graph).wgsl;
        expect(wgsl).toContain('textureSampleGrad(');
        expect(wgsl).toContain('dpdx(');
        const vertex = compileMaterialGraph(graph, { stage: 'vertex', outputs: ['baseColor'] }).statements.join('\n');
        expect(vertex).not.toMatch(/dFdx|textureGrad/);
    });

    it('reads one tile as it is', () => {
        for (const options of [{}, { tiles: tileAtlasLayout([1001], 1024, 16384) }, { tiles: { columns: 1, rows: 1 } }]) {
            const graph = materialGraphForTextures({ baseColor: 'colour', orm: 'orm' }, options);
            expect(graph.nodes.some((node) => node.type === 'udimAtlas')).toBe(false);
            expect(compileMaterialGraph(normalizeMaterialGraph(graph)).statements.join('\n')).toContain('texture(mg_baseColor_texture, vUv)');
        }
    });

    it('refuses a grid size alone, which no longer says where each tile is', () => {
        expect(() => materialGraphForTextures({ baseColor: 'colour' }, { tiles: { columns: 2, rows: 1 } })).toThrow(/places of the UDIM tiles/);
    });

    it('reads its list of tiles forgivingly', () => {
        expect(readUdimTiles('1001, 1010 1001\n999 2000 1002')).toEqual([1001, 1010, 1002]);
        expect(readUdimTiles(undefined)).toEqual([]);
    });
});
