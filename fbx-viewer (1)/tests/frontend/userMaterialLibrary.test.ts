import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import {
    UserMaterialLibrary, filterLibrary, libraryFolders, libraryMaterial, libraryTags, memoryLibraryStorage, portableSettings, tidyFolder, tidyTags,
    type LibraryPicture,
} from '../../utils/userMaterialLibrary';
import { addToLibrary, bringIntoProject, capturePictures, usesInWords, type ProjectTarget } from '../../utils/userMaterialLibraryActions';
import type { TextureData } from '../../types';

/** A material sampling one texture in its graph and drawing a second as its picture by name. */
const rustyMetal = (): MaterialAsset => ({
    id: 'rust',
    name: 'Rusty metal',
    graph: normalizeMaterialGraph({
        nodes: [
            { id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) },
            { id: 'colour', type: 'texture', x: -200, y: 0, params: { ...defaultParams('texture'), texture: 'tex-colour' } },
            { id: 'normal', type: 'normalMap', x: -200, y: 120, params: { ...defaultParams('normalMap'), texture: 'tex-normal' } },
        ],
        links: [{ fromNode: 'colour', fromOutput: 'rgb', toNode: 'out', toInput: 'baseColor' }],
    }),
    pictures: { height: 'tex-height' },
});

const textures: TextureData[] = [
    { id: 'tex-colour', name: 'rust_col.png', url: 'blob:colour', dimensions: { width: 512, height: 512 } },
    // A deep picture: its own file, with an 8-bit preview beside it.
    { id: 'tex-normal', name: 'rust_nor_gl.exr', url: 'blob:normal-preview', sourceUrl: 'blob:normal-file', dimensions: { width: 512, height: 512 } },
    { id: 'tex-height', name: 'rust_height.png', url: 'blob:height', dimensions: { width: 256, height: 256 } },
];

const projectPictures = {
    projectId: 'project-a',
    textures,
    settingsOf: (id: string) => (id === 'tex-normal'
        ? { normalMap: true, source: { format: 'exr' as const, depth: 32 as const, channels: 3 as const }, preview: { assetId: 'a'.repeat(64) }, compressed: [{ signature: 's', assetId: 'b'.repeat(64) }] }
        : undefined),
    read: async (url: string) => new Blob([url], { type: 'image/png' }),
};

const newLibrary = () => {
    let id = 0;
    let clock = 1000;
    return new UserMaterialLibrary(memoryLibraryStorage(), () => ++clock, () => `entry-${++id}`);
};

const ball = new Blob(['ball'], { type: 'image/png' });

const projectB = (overrides: Partial<ProjectTarget> = {}) => {
    const saved: MaterialAsset[] = [];
    const added: Array<{ picture: LibraryPicture; folder: string }> = [];
    let next = 0;
    const target: ProjectTarget = {
        projectId: 'project-b',
        projectName: 'Harbour',
        materialNames: ['Rusty metal'],
        addPicture: async (picture, folder) => { added.push({ picture, folder }); return `b-${picture.id}`; },
        saveMaterial: async (asset) => { saved.push(asset); },
        newId: () => `material-${++next}`,
        ...overrides,
    };
    return { target, saved, added };
};

describe('My library', () => {
    it('takes a project material in with its pictures and its rendered ball', async () => {
        const library = newLibrary();
        const render = vi.fn(async () => ball);
        const { entry, updated } = await addToLibrary(library, rustyMetal(), projectPictures, render);
        expect(updated).toBe(false);
        expect(entry).toMatchObject({ name: 'Rusty metal', folder: '', tags: [], thumbnail: ball, source: { projectId: 'project-a', materialId: 'rust' }, uses: [] });
        expect(entry.pictureIds.sort()).toEqual(['tex-colour', 'tex-height', 'tex-normal']);
        const pictures = await library.pictures(entry.id);
        const normal = pictures.find(picture => picture.id === 'tex-normal')!;
        // The deep file itself is kept, with its preview; what the project kept for it (its preview and compressed blocks) is not.
        expect(await normal.file.text()).toBe('blob:normal-file');
        expect(await normal.preview!.text()).toBe('blob:normal-preview');
        expect(normal.settings).toEqual({ normalMap: true, source: { format: 'exr', depth: 32, channels: 3 } });
        expect(render).toHaveBeenCalledWith(expect.objectContaining({ id: 'rust' }), pictures);
        expect(libraryMaterial(entry)?.graph.nodes.find(node => node.id === 'colour')?.params.texture).toBe('tex-colour');
    });

    it('updates the entry when the same material is added again, keeping its name, folder and tags', async () => {
        const library = newLibrary();
        const first = (await addToLibrary(library, rustyMetal(), projectPictures, async () => ball)).entry;
        await library.change(first.id, { name: 'Ship hull', folder: ' Metals / Painted ', tags: ['Rust', 'rust', ' worn '] });
        const changed = { ...rustyMetal(), pictures: {} };
        const again = await addToLibrary(library, changed, projectPictures, async () => null);
        expect(again.updated).toBe(true);
        expect(library.entries()).toHaveLength(1);
        expect(again.entry).toMatchObject({ id: first.id, name: 'Ship hull', folder: 'Metals/Painted', tags: ['rust', 'worn'], thumbnail: ball });
        expect(again.entry.pictureIds.sort()).toEqual(['tex-colour', 'tex-normal']);
    });

    it('brings a material into another project as its own copy, its pictures renamed to the textures made there', async () => {
        const library = newLibrary();
        const { entry } = await addToLibrary(library, rustyMetal(), projectPictures, async () => ball);
        const { target, saved, added } = projectB();
        const asset = await bringIntoProject(library, entry.id, target);
        expect(added.map(item => [item.picture.id, item.folder]).sort()).toEqual([
            ['tex-colour', 'Materials/Rusty metal'], ['tex-height', 'Materials/Rusty metal'], ['tex-normal', 'Materials/Rusty metal'],
        ]);
        expect(saved).toEqual([asset]);
        // A free name, a new id, and every texture it names is the project's own.
        expect(asset).toMatchObject({ id: 'material-1', name: 'Rusty metal 2', pictures: { height: 'b-tex-height' } });
        expect(asset.graph.nodes.find(node => node.id === 'colour')?.params.texture).toBe('b-tex-colour');
        expect(asset.graph.nodes.find(node => node.id === 'normal')?.params.texture).toBe('b-tex-normal');
        // Where it was used.
        expect(library.get(entry.id)?.uses).toEqual([{ projectId: 'project-b', projectName: 'Harbour', materialId: 'material-1', at: expect.any(Number) }]);
        expect(usesInWords(library.get(entry.id)!, 'project-b', id => id === 'material-1')).toEqual(['This project']);
        expect(usesInWords(library.get(entry.id)!, 'project-b', () => false)).toEqual(['This project (since deleted there)']);
        expect(usesInWords(library.get(entry.id)!, 'project-a', () => true)).toEqual(['Harbour']);
    });

    it('clears a texture the project did not take rather than naming one it does not have', async () => {
        const library = newLibrary();
        const { entry } = await addToLibrary(library, rustyMetal(), { ...projectPictures, textures: textures.slice(0, 1) }, async () => ball);
        const asset = await bringIntoProject(library, entry.id, projectB().target);
        expect(asset.graph.nodes.find(node => node.id === 'normal')?.params.texture).toBe('');
        expect(asset.pictures).toEqual({});
    });

    it('deletes an entry with a way back, pictures and uses included', async () => {
        const library = newLibrary();
        const { entry } = await addToLibrary(library, rustyMetal(), projectPictures, async () => ball);
        await bringIntoProject(library, entry.id, projectB().target);
        const kept = library.get(entry.id)!;
        const removed = await library.remove(entry.id);
        expect(library.entries()).toEqual([]);
        expect(await library.pictures(entry.id)).toEqual([]);
        await expect(bringIntoProject(library, entry.id, projectB().target)).rejects.toThrow('no longer in your library');
        await library.restore(removed);
        expect(library.get(entry.id)).toEqual(kept);
        expect((await library.pictures(entry.id)).map(picture => picture.id).sort()).toEqual(['tex-colour', 'tex-height', 'tex-normal']);
    });

    it('duplicates an entry with pictures of its own, used nowhere yet', async () => {
        const library = newLibrary();
        const { entry } = await addToLibrary(library, rustyMetal(), projectPictures, async () => ball);
        await bringIntoProject(library, entry.id, projectB().target);
        const copy = await library.duplicate(entry.id);
        expect(copy).toMatchObject({ name: 'Rusty metal copy', uses: [], thumbnail: ball });
        expect(copy.source).toBeUndefined();
        await library.remove(entry.id);
        expect((await library.pictures(copy.id)).length).toBe(3);
        expect((await library.duplicate(copy.id)).name).toBe('Rusty metal copy copy');
    });

    it('is found by search, folder and tag', async () => {
        const library = newLibrary();
        const add = async (name: string, folder: string, tags: string[]) => library.change((await library.add({ asset: { ...rustyMetal(), name }, pictures: [] })).id, { folder, tags });
        await add('Rusty metal', 'Metals', ['rust', 'worn']);
        await add('Brushed steel', 'Metals/Clean', ['steel']);
        await add('Oak planks', 'Wood', ['worn']);
        const names = (filter: Parameters<typeof filterLibrary>[1]) => filterLibrary(library.entries(), filter).map(entry => entry.name);
        expect(names({ query: 'metal' })).toEqual(['Brushed steel', 'Rusty metal']);
        expect(names({ query: 'WORN oak' })).toEqual(['Oak planks']);
        expect(names({ folder: 'Metals' })).toEqual(['Brushed steel', 'Rusty metal']);
        expect(names({ folder: 'Metals/Clean' })).toEqual(['Brushed steel']);
        expect(names({ tag: 'worn' })).toEqual(['Oak planks', 'Rusty metal']);
        expect(libraryFolders(library.entries())).toEqual(['Metals', 'Metals/Clean', 'Wood']);
        expect(libraryTags(library.entries())).toEqual(['worn', 'rust', 'steel']);
    });

    it('tidies names, folders, tags and settings', async () => {
        expect(tidyFolder(' / Metals //  Painted / ')).toBe('Metals/Painted');
        expect(tidyTags(['A', ' a ', '', 'B'])).toEqual(['a', 'b']);
        expect(portableSettings({ colorSpace: 'data', preview: { assetId: 'c'.repeat(64) } })).toEqual({ colorSpace: 'data' });
        expect(portableSettings({ preview: { assetId: 'c'.repeat(64) } })).toBeUndefined();
        const library = newLibrary();
        await library.add({ asset: rustyMetal(), pictures: [] });
        expect((await library.add({ asset: rustyMetal(), pictures: [] })).name).toBe('Rusty metal 2');
    });

    it('leaves out a texture the project no longer has', async () => {
        const pictures = await capturePictures(rustyMetal(), { ...projectPictures, textures: textures.slice(1) });
        expect(pictures.map(picture => picture.id).sort()).toEqual(['tex-height', 'tex-normal']);
    });

    it('carries the graphs a texture graph uses as nodes, and gives them ids of their own in another project', async () => {
        const graph = normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) }], links: [] });
        const inner: MaterialAsset = { id: 'fn-inner', name: 'Grunge mask', graph, textureGraph: { library: true, graph: { nodes: [{ id: 'b', type: 'bitmap', params: { texture: 'tex-height' } }] } } };
        const middle: MaterialAsset = { id: 'fn-middle', name: 'Edge wear', graph, textureGraph: { library: true, graph: { nodes: [{ id: 's', type: 'subgraph', params: { graph: 'fn-inner' } }] } } };
        const rusty: MaterialAsset = { id: 'rust-tex', name: 'Rusty panel', graph, textureGraph: { graph: { nodes: [{ id: 'w', type: 'subgraph', params: { graph: 'fn-middle' } }, { id: 'x', type: 'subgraph', params: { graph: 'gone' } }] } } };
        const project = new Map([inner, middle, rusty].map(each => [each.id, each]));
        const library = newLibrary();
        const { entry } = await addToLibrary(library, rusty, { ...projectPictures, materialOf: (id) => project.get(id) }, async () => ball);
        expect(entry.nodeGraphs?.length).toBe(2);
        expect(entry.pictureIds).toEqual(['tex-height']);

        const { target, saved } = projectB();
        const asset = await bringIntoProject(library, entry.id, target);
        // The two graphs, then the material, each with a new id, naming one another by them.
        expect(saved.map(each => [each.id, each.name])).toEqual([['material-1', 'Edge wear'], ['material-2', 'Grunge mask'], ['material-3', 'Rusty panel']]);
        const nodesOf = (each: MaterialAsset) => (each.textureGraph as { graph: { nodes: Array<{ params: Record<string, unknown> }> } }).graph.nodes;
        expect(nodesOf(asset).map(each => each.params.graph)).toEqual(['material-1', 'gone']);
        expect(nodesOf(saved[0])[0].params.graph).toBe('material-2');
        expect(nodesOf(saved[1])[0].params.texture).toBe('b-tex-height');

        // Back where it came from, the graphs the project has are used as they are.
        const home = projectB({ projectId: 'project-a', hasMaterial: (id) => project.has(id) });
        const back = await bringIntoProject(library, entry.id, home.target);
        expect(home.saved).toEqual([back]);
        expect(nodesOf(back)[0].params.graph).toBe('fn-middle');
    });
});
