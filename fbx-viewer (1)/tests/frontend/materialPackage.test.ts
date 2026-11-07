import { describe, expect, it } from 'vitest';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { cookable, graphParameterNames } from '../../runtime/materials/materialCooking';
import { withMaterialPictures } from '../../runtime/materials/materialGraph';
import { graphTextures, materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { rewriteMaterialPictures } from '../../texturing/materialOutput';
import { normalizeTextureGraph } from '../../texturing/graph/document';
import { readStoredGraph, withParameterPictures, type StoredTextureGraph } from '../../texturing/graph/stored';
import { makeZip, readZip } from '../../texturing/zip';
import type { TextureData } from '../../types';
import {
    MaterialPackageError, PACKAGE_FORMAT, PACKAGE_VERSION, packageFromLibrary, packageFromProject, packageIntoLibrary, readMaterialPackage, writeMaterialPackage,
} from '../../utils/materialPackage';
import { UserMaterialLibrary, memoryLibraryStorage, type LibraryPicture } from '../../utils/userMaterialLibrary';
import { bringIntoProject, bringMaterialIn, type ProjectTarget } from '../../utils/userMaterialLibraryActions';

const shaderGraph = () => normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) }], links: [] });

/** A graph for other graphs, reading a picture of its own. */
const grungeMask = (): MaterialAsset => ({
    id: 'fn-mask',
    name: 'Grunge mask',
    graph: shaderGraph(),
    textureGraph: { library: true, graph: normalizeTextureGraph({ version: 1, size: { w: 8, h: 8 }, seed: 0, parameters: [], links: [], nodes: [{ id: 'b', type: 'bitmap', x: 0, y: 0, params: { texture: 'tex-grunge' } }] }) },
});

/**
 * A published texture graph: two exposed parameters (one a picture), a preset, a graph used as a node and pictures
 * last made, kept as the editor keeps it (with the record of the pictures its picture parameter names).
 */
const paintedPlanks = (): MaterialAsset => ({
    id: 'planks',
    name: 'Painted planks',
    graph: shaderGraph(),
    textureGraph: withParameterPictures({
        graph: normalizeTextureGraph({
            version: 1,
            size: { w: 9, h: 9 },
            seed: 4,
            parameters: [
                { name: 'wear', label: 'Wear', kind: 'float', default: 0.3, min: 0, max: 1 },
                { name: 'paint', label: 'Paint photo', kind: 'texture', default: 'tex-paint' },
            ],
            presets: [{ id: 'weathered', name: 'Weathered', values: { wear: 0.9, paint: 'tex-photo' } }],
            nodes: [
                { id: 'mask', type: 'subgraph', x: 0, y: 0, params: { graph: 'fn-mask' } },
                { id: 'photo', type: 'bitmap', x: 0, y: 0, params: { texture: 'tex-photo' } },
            ],
            links: [],
        }),
        values: { wear: 0.6, paint: 'tex-paint' },
        bakeSize: 10,
        layout: 'engine',
        baked: { textures: { baseColor: 'tex-colour' }, signature: 'sig', size: 10, at: 5 },
    }) as unknown as Record<string, unknown>,
    pictures: { baseColor: 'tex-colour' },
});

const textures: TextureData[] = [
    { id: 'tex-paint', name: 'paint.png', url: 'blob:paint', dimensions: { width: 256, height: 256 } },
    { id: 'tex-photo', name: 'oak_planks.jpg', url: 'blob:photo', dimensions: { width: 1024, height: 512 } },
    { id: 'tex-colour', name: 'Painted planks colour', url: 'blob:colour', dimensions: { width: 1024, height: 1024 } },
    // A deep picture: its own file, with an 8-bit preview beside it.
    { id: 'tex-grunge', name: 'grunge.exr', url: 'blob:grunge-preview', sourceUrl: 'blob:grunge-file', dimensions: { width: 512, height: 512 } },
];

const projectA = new Map([paintedPlanks(), grungeMask()].map(asset => [asset.id, asset]));
const projectPictures = {
    textures,
    settingsOf: (id: string) => (id === 'tex-grunge' ? { source: { format: 'exr' as const, depth: 32 as const, channels: 1 as const }, preview: { assetId: 'a'.repeat(64) } } : undefined),
    read: async (url: string) => new Blob([`bytes of ${url}`], { type: url.includes('photo') ? 'image/jpeg' : 'image/png' }),
    materialOf: (id: string) => projectA.get(id),
};

const ball = new Blob(['ball'], { type: 'image/png' });

const projectB = () => {
    const saved: MaterialAsset[] = [];
    const added: Array<{ picture: LibraryPicture; folder: string }> = [];
    let next = 0;
    const target: ProjectTarget = {
        projectId: 'project-b',
        projectName: 'Harbour',
        materialNames: ['Painted planks'],
        addPicture: async (picture, folder) => { added.push({ picture, folder }); return `b-${picture.id}`; },
        saveMaterial: async (asset) => { saved.push(asset); },
        newId: () => `material-${++next}`,
    };
    return { target, saved, added };
};

const nodesOf = (asset: MaterialAsset) => readStoredGraph(asset.textureGraph).graph.nodes;

/**
 * "Texture 2", as Update material leaves it: its four pictures made (named by role, and as what its graph last made)
 * and a surface graph reading them, none of them loaded by the editor (no open level needed them). Its graph uses a
 * graph for other graphs as a node, giving it a picture for that graph's picture parameter, and has a picture
 * parameter of its own saved before the editor kept a record of them.
 */
const madePictures = { baseColor: 'baked-colour', normal: 'baked-normal', orm: 'baked-orm', height: 'baked-height' };
const stainGraph = (): MaterialAsset => ({
    id: 'fn-stain',
    name: 'Stain',
    graph: shaderGraph(),
    textureGraph: { library: true, graph: normalizeTextureGraph({ version: 1, size: { w: 8, h: 8 }, seed: 0, links: [], nodes: [], parameters: [{ name: 'stain', label: 'Stain', kind: 'texture', default: '' }] }) },
});
const texture2 = (): MaterialAsset => {
    const surface = rewriteMaterialPictures({ graph: shaderGraph() }, madePictures);
    return {
        id: 'texture-2',
        name: 'Texture 2',
        graph: surface.graph,
        pictures: surface.pictures,
        textureGraph: {
            graph: normalizeTextureGraph({
                version: 1, size: { w: 9, h: 9 }, seed: 0, links: [],
                parameters: [{ name: 'decal', label: 'Decal', kind: 'texture', default: 'tex-decal' }],
                nodes: [{ id: 'stained', type: 'subgraph', x: 0, y: 0, params: { graph: 'fn-stain', stain: 'tex-stain' } }],
            }),
            values: {},
            bakeSize: 10,
            layout: 'engine',
            baked: { textures: madePictures, signature: 'sig', size: 10, at: 5 },
        },
    };
};

describe('Material packages (.auvramat)', () => {
    it('carry every picture a material names, loaded or not, and the material comes in drawing with them', async () => {
        const project = new Map([texture2(), stainGraph()].map((asset) => [asset.id, asset]));
        const asked: string[][] = [];
        const pkg = await packageFromProject(texture2(), {
            // Only the stain picture is loaded; the rest are read from the project.
            textures: [{ id: 'tex-stain', name: 'stain.png', url: 'blob:stain', dimensions: { width: 128, height: 128 } }],
            settingsOf: () => undefined,
            read: async (url) => new Blob([`bytes of ${url}`], { type: 'image/png' }),
            unlisted: async (ids) => {
                asked.push([...ids]);
                return ids.filter((id) => id !== 'nowhere').map((id) => ({ id, name: `${id}.png`, file: new Blob([`stored ${id}`], { type: 'image/png' }), dimensions: { width: 1024, height: 1024 } }));
            },
            materialOf: (id) => project.get(id),
        });
        expect(asked.map((ids) => [...ids].sort())).toEqual([['baked-colour', 'baked-height', 'baked-normal', 'baked-orm', 'tex-decal']]);
        const read = await readMaterialPackage(await writeMaterialPackage(pkg));
        expect(read.pictures.map((picture) => picture.id).sort()).toEqual(['baked-colour', 'baked-height', 'baked-normal', 'baked-orm', 'tex-decal', 'tex-stain']);
        expect(await read.pictures.find((picture) => picture.id === 'baked-normal')!.file.text()).toBe('stored baked-normal');

        const { target, saved, added } = projectB();
        const asset = await bringMaterialIn(read, target);
        const newIds = new Set(added.map((each) => `b-${each.picture.id}`));
        expect(newIds.size).toBe(6);
        // It draws with the pictures it brought: its surface graph reads its pictures by name, each now the project's own.
        expect(asset.pictures).toEqual({ baseColor: 'b-baked-colour', normal: 'b-baked-normal', orm: 'b-baked-orm', height: 'b-baked-height' });
        const drawn = graphTextures(withMaterialPictures(asset.graph, asset.pictures)).map((texture) => texture.textureId);
        expect([...new Set(drawn)].sort()).toEqual(['b-baked-colour', 'b-baked-height', 'b-baked-normal', 'b-baked-orm']);
        expect(drawn.every((id) => newIds.has(id))).toBe(true);
        // What its graph last made, its own picture parameter, and the picture it gives the graph it uses as a node.
        const stored = readStoredGraph(asset.textureGraph);
        expect(stored.baked?.textures).toEqual({ baseColor: 'b-baked-colour', normal: 'b-baked-normal', orm: 'b-baked-orm', height: 'b-baked-height' });
        expect(stored.graph.parameters[0].default).toBe('b-tex-decal');
        expect(stored.graph.nodes[0].params).toMatchObject({ graph: saved[0].id, stain: 'b-tex-stain' });
        // Nothing still names a picture of the project it came from.
        expect(JSON.stringify([asset, ...saved])).not.toMatch(/"(?:baked|tex)-/);
    });

    it('writes a texture graph with its parameters, presets, pictures and node graphs, and reads the same back', async () => {
        const pkg = await packageFromProject(paintedPlanks(), projectPictures, async () => ball);
        expect(pkg.nodeGraphs.map(graph => graph.id)).toEqual(['fn-mask']);
        expect(pkg.pictures.map(picture => picture.id).sort()).toEqual(['tex-colour', 'tex-grunge', 'tex-paint', 'tex-photo']);

        const file = await writeMaterialPackage(pkg, Date.UTC(2026, 10, 7));
        // An ordinary archive: its description names the format and version, its pictures sit beside it.
        const inside = await readZip(file);
        const manifest = JSON.parse(new TextDecoder().decode(inside.get('auvramat.json')!));
        expect(manifest).toMatchObject({ format: PACKAGE_FORMAT, version: PACKAGE_VERSION, name: 'Painted planks', made: '2026-11-07T00:00:00.000Z', ball: 'ball.png' });
        expect([...inside.keys()].filter(name => name.startsWith('pictures/')).sort()).toEqual([
            'pictures/1 oak_planks.jpg', 'pictures/2 Painted planks colour.png', 'pictures/3 paint.png', 'pictures/4 grunge preview.png', 'pictures/4 grunge.exr',
        ]);

        const read = await readMaterialPackage(file);
        expect(read.name).toBe('Painted planks');
        expect(read.made).toBe(Date.UTC(2026, 10, 7));
        expect(materialAssetDocument(read.material)).toEqual(materialAssetDocument(paintedPlanks()));
        expect(read.nodeGraphs.map(graph => materialAssetDocument(graph))).toEqual([materialAssetDocument(grungeMask())]);
        expect(await read.ball!.text()).toBe('ball');
        const grunge = read.pictures.find(picture => picture.id === 'tex-grunge')!;
        expect(await grunge.file.text()).toBe('bytes of blob:grunge-file');
        expect(await grunge.preview!.text()).toBe('bytes of blob:grunge-preview');
        // What one project kept for it (its preview's asset) stays behind.
        expect(grunge.settings).toEqual({ source: { format: 'exr', depth: 32, channels: 1 } });
        const photo = read.pictures.find(picture => picture.id === 'tex-photo')!;
        expect(photo).toMatchObject({ name: 'oak_planks.jpg', dimensions: { width: 1024, height: 512 } });
        expect(photo.file.type).toBe('image/jpeg');
    });

    it('comes into another project as a material whose parameters stay live and which a game cooks like any graph', async () => {
        const read = await readMaterialPackage(await writeMaterialPackage(await packageFromProject(paintedPlanks(), projectPictures)));
        const { target, saved, added } = projectB();
        const asset = await bringMaterialIn(read, target);
        // The node graph first, then the material, each with an id and a free name of its own there.
        expect(saved.map(each => [each.id, each.name])).toEqual([['material-1', 'Grunge mask'], ['material-2', 'Painted planks 2']]);
        expect(added.map(each => each.folder)).toEqual(Array(4).fill('Materials/Painted planks'));
        expect(nodesOf(asset).find(node => node.id === 'mask')!.params.graph).toBe('material-1');
        expect(nodesOf(asset).find(node => node.id === 'photo')!.params.texture).toBe('b-tex-photo');
        expect(nodesOf(saved[0])[0].params.texture).toBe('b-tex-grunge');
        expect(asset.pictures).toEqual({ baseColor: 'b-tex-colour' });

        // Its parameters, their values and its presets, with the pictures they name being the project's own.
        const stored = readStoredGraph(asset.textureGraph);
        expect(cookable(asset)).toBe(true);
        expect(graphParameterNames(asset)).toEqual(['wear', 'paint']);
        expect(stored.values).toEqual({ wear: 0.6, paint: 'b-tex-paint' });
        expect(stored.graph.presets).toEqual([{ id: 'weathered', name: 'Weathered', values: { wear: 0.9, paint: 'b-tex-photo' } }]);
        expect(stored.graph.parameters.find(parameter => parameter.name === 'paint')!.default).toBe('b-tex-paint');
        expect((asset.textureGraph as unknown as StoredTextureGraph).textures).toEqual({ paint: 'b-tex-paint', 'paint:default': 'b-tex-paint', 'paint:weathered': 'b-tex-photo' });
        expect(stored.baked?.textures).toEqual({ baseColor: 'b-tex-colour' });
    });

    it('goes into My library, and from there into a project', async () => {
        const read = await readMaterialPackage(await writeMaterialPackage(await packageFromProject(paintedPlanks(), projectPictures, async () => ball)));
        let id = 0;
        const library = new UserMaterialLibrary(memoryLibraryStorage(), () => 1000, () => `entry-${++id}`);
        const entry = await packageIntoLibrary(library, read);
        expect(entry).toMatchObject({ name: 'Painted planks', thumbnail: read.ball });
        expect(entry.nodeGraphs).toHaveLength(1);
        expect(entry.pictureIds.sort()).toEqual(['tex-colour', 'tex-grunge', 'tex-paint', 'tex-photo']);

        // Written again from the library, it is the same package.
        const again = await readMaterialPackage(await writeMaterialPackage(packageFromLibrary(entry, await library.pictures(entry.id))));
        expect(materialAssetDocument(again.material)).toEqual(materialAssetDocument(read.material));

        const { target } = projectB();
        const asset = await bringIntoProject(library, entry.id, target);
        expect(graphParameterNames(asset)).toEqual(['wear', 'paint']);
        expect(library.get(entry.id)!.uses).toEqual([{ projectId: 'project-b', projectName: 'Harbour', materialId: asset.id, at: 1000 }]);
    });

    it('refuses a package from a newer version plainly, and says when a file is not a package or is damaged', async () => {
        const manifest = (fields: Record<string, unknown>) => makeZip([{ name: 'auvramat.json', data: new TextEncoder().encode(JSON.stringify({ format: PACKAGE_FORMAT, name: 'Lava', material: materialAssetDocument(paintedPlanks()), nodeGraphs: [], pictures: [], ...fields })) }]);
        const newer = readMaterialPackage(await manifest({ version: PACKAGE_VERSION + 1 }));
        await expect(newer).rejects.toBeInstanceOf(MaterialPackageError);
        await expect(readMaterialPackage(await manifest({ version: PACKAGE_VERSION + 1 }))).rejects.toThrow(`"Lava" is a version ${PACKAGE_VERSION + 1} material package, written by a newer editor. This editor reads packages up to version ${PACKAGE_VERSION}, so it was not opened.`);

        await expect(readMaterialPackage(new Blob(['just some text']))).rejects.toThrow('This file is not a material package (.auvramat).');
        await expect(readMaterialPackage(await makeZip([{ name: 'readme.txt', data: new Uint8Array([1, 2]) }]))).rejects.toThrow('not a material package');
        await expect(readMaterialPackage(await manifest({ format: 'something-else', version: 1 }))).rejects.toThrow('not a material package');
        await expect(readMaterialPackage(await manifest({ version: 'one' }))).rejects.toThrow('does not say which version');
        await expect(readMaterialPackage(await manifest({ version: 1, pictures: [{ id: 'p', name: 'rust.png', file: 'pictures/1 rust.png', type: 'image/png', width: 8, height: 8 }] })))
            .rejects.toThrow('This material package is damaged: the picture "rust.png" is missing.');

        // A byte changed inside a picture is caught.
        const good = new Uint8Array(await (await writeMaterialPackage(await packageFromProject(paintedPlanks(), projectPictures))).arrayBuffer());
        const at = new TextDecoder('latin1').decode(good).indexOf('bytes of blob:paint');
        good[at] ^= 0xff;
        await expect(readMaterialPackage(new Blob([good]))).rejects.toThrow('damaged');
    });
});
