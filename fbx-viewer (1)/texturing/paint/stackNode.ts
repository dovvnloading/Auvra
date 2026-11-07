import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import type { GraphEntry, GraphResolver } from '../graph/registry';
import type { TexGraphNode, TexNodeDef, TextureGraph } from '../graph/types';
import type { TileBake } from '../bake/meshBaker';
import { allLayers, CHANNEL_IS_COLOR, CHANNEL_LABELS, PAINT_CHANNELS, readPaintDocument, type PaintDocument, type PaintLayer } from './paintTypes';

/**
 * Reads a painted picture the project keeps. The editor sets it at start (index.tsx); a game has none,
 * since texture graphs run there too and the project's host is the editor's alone.
 */
let storedPictureFetcher: ((assetId: string) => Promise<Response>) | null = null;
export const setPaintStackPictureFetcher = (fetcher: (assetId: string) => Promise<Response>): void => {
    storedPictureFetcher = fetcher;
};

/**
 * PAINT STACKS AS GRAPH NODES
 *
 * A texture set's layer stack (or one folder of it) used inside a texture graph. Each painted set, and
 * each folder in it, is offered to graphs as a graph of its own (paintStackEntries): one Paint stack node
 * wired to an Output per channel, so a graph uses it as it uses any other, through a sub-graph node, and
 * redraws it when the painting changes (the node carries the document's revision). The Paint stack node
 * puts the stack together flat on the UV square at its own size: painted layers, fills, masks and
 * effects as in Paint, with fills and masks that read mesh maps reading the graph's.
 */

export const PAINT_STACK_NODE_TYPE = 'paintStack';
/** Graph ids paint stacks are offered under: `paint:<asset id>` or `paint:<asset id>:<folder layer id>`. */
export const PAINT_STACK_PREFIX = 'paint:';

/** A steady short hash of a text (the document's revision). */
const hashOf = (text: string): string => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
};

/** The synthetic graph a paint stack (or folder) is offered as: its node, wired to an Output per channel. */
const stackGraph = (assetId: string, folderId: string, document: PaintDocument): TextureGraph => {
    const node: TexGraphNode = { id: 'stack', type: PAINT_STACK_NODE_TYPE, x: 0, y: 0, params: { asset: assetId, folder: folderId, revision: hashOf(JSON.stringify(document.layers)) } };
    const channels = PAINT_CHANNELS.filter((channel) => document.channels.includes(channel));
    const outputs: TexGraphNode[] = channels.map((channel, i) => ({ id: `out:${channel}`, type: 'output', x: 320, y: i * 120, params: { channel, name: '', kind: CHANNEL_IS_COLOR[channel] ? 'color' : 'gray', visibleIf: '' } }));
    return {
        version: 1,
        size: { w: document.size, h: document.size },
        seed: 0,
        nodes: [node, ...outputs],
        links: channels.map((channel) => ({ from: 'stack', fromOutput: channel, to: `out:${channel}`, toInput: 'in' })),
        parameters: [],
    };
};

/**
 * The project's painted sets, and the folders in them, as graphs other graphs can use: `assets` are the
 * material assets (those holding a paint document count).
 */
export const paintStackEntries = (assets: ReadonlyArray<{ id: string; name: string; paint?: Record<string, unknown> }>): GraphEntry[] => {
    const entries: GraphEntry[] = [];
    for (const asset of assets) {
        const document = asset.paint ? readPaintDocument(asset.paint) : null;
        if (!document || !document.layers.length) continue;
        entries.push({ id: `${PAINT_STACK_PREFIX}${asset.id}`, name: `${asset.name} (paint stack)`, graph: stackGraph(asset.id, '', document) });
        for (const folder of allLayers(document.layers).filter((layer) => layer.kind === 'folder')) {
            entries.push({ id: `${PAINT_STACK_PREFIX}${asset.id}:${folder.id}`, name: `${asset.name}: ${folder.name} (paint folder)`, graph: stackGraph(asset.id, folder.id, document) });
        }
    }
    return entries;
};

/** The paint stack (or folder) a graph id stands for, from the asset it names; undefined for other ids. */
export const paintStackEntry = (id: string, assetOf: (assetId: string) => { id: string; name: string; paint?: Record<string, unknown> } | undefined): GraphEntry | undefined => {
    if (!id.startsWith(PAINT_STACK_PREFIX)) return undefined;
    const [assetId] = id.slice(PAINT_STACK_PREFIX.length).split(':');
    const asset = assetOf(assetId);
    return asset ? paintStackEntries([asset]).find((entry) => entry.id === id) : undefined;
};

/** The layers a stack node puts together: the whole stack, or one folder of it on its own. */
export const stackLayers = (document: PaintDocument, folderId: string): PaintLayer[] | null => {
    if (!folderId) return document.layers;
    const folder = allLayers(document.layers).find((layer) => layer.id === folderId && layer.kind === 'folder');
    return folder ? [folder] : null;
};

/** The flat square a stack is put together on (one quad over the UV square, tile 1001). */
let flatPart: import('../mesh/partMesh').PartMesh | null = null;
const flatSquare = async () => {
    if (flatPart) return flatPart;
    const { buildPartMesh } = await import('../mesh/partMesh');
    const material = new THREE.MeshBasicMaterial();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0.5, 0.5, 0);
    flatPart = buildPartMesh(new THREE.Mesh(geometry, material), new Set([material]), { udim: false });
    return flatPart;
};

/** Stacks being put together now: one using itself (through a fill graph) is stopped. */
const running = new Set<string>();

/** The graph's mesh maps (images or textures) as a bake the stack's fills and masks read, at its size. */
const bakeFrom = async (gpu: TextureGpu, size: number, external: (name: string) => GpuImage | THREE.Texture | null): Promise<Map<number, TileBake> | null> => {
    const { MESH_MAPS, EXTRA_MESH_MAPS, meshMapKey } = await import('../graph/nodes/io');
    const copy = (source: GpuImage | THREE.Texture, kind: 'color' | 'gray'): GpuImage => {
        const image = gpu.image(size, size, kind, 16);
        gpu.passNow(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source } });
        return image;
    };
    const maps: TileBake['maps'] = {};
    const extras: NonNullable<TileBake['extras']> = {};
    let found = false;
    for (const name of MESH_MAPS) {
        const source = external(meshMapKey(name));
        if (!source) continue;
        maps[name] = copy(source, name === 'normal' || name === 'worldNormal' || name === 'position' || name === 'id' ? 'color' : 'gray');
        found = true;
    }
    for (const name of EXTRA_MESH_MAPS) {
        const source = external(meshMapKey(name));
        if (!source) continue;
        (extras as Record<string, GpuImage>)[name] = copy(source, name === 'cavity' || name === 'opacity' ? 'gray' : 'color');
        found = true;
    }
    if (!found) return null;
    const coverage = gpu.image(size, size, 'gray', 8);
    gpu.clear(coverage, [1, 1, 1, 1]);
    const nearest = gpu.image(size, size, 'color', 16);
    gpu.clear(nearest, [0, 0, 0, 0]);
    return new Map([[1001, { maps, extras, coverage, nearest }]]);
};

export const PAINT_STACK_NODE: TexNodeDef = {
    type: PAINT_STACK_NODE_TYPE,
    label: 'Paint stack',
    category: 'Materials',
    description: 'A texture set\'s layers as painted in Paint, or one folder of them, put together on the UV square: each channel an output. Add one from the graph list (each painted set and folder is there); fills and masks that read mesh maps read this graph\'s.',
    keywords: ['paint', 'layers', 'stack', 'folder', 'texture set'],
    inputs: [],
    outputs: PAINT_CHANNELS.map((channel) => ({ key: channel, label: CHANNEL_LABELS[channel], kind: CHANNEL_IS_COLOR[channel] ? 'color' as const : 'gray' as const })),
    params: [
        { key: 'asset', label: 'Painted set', kind: 'string', default: '' },
        { key: 'folder', label: 'Folder', kind: 'string', default: '' },
        { key: 'revision', label: 'Revision', kind: 'string', default: '' },
    ],
    sizeFrom: 'graph',
    bypass: false,
    async run(context) {
        const assetId = String(context.params.asset ?? '');
        if (!assetId) throw new Error('Pick a paint stack from the graph list: each painted set and each folder of one is there.');
        if (running.has(assetId)) throw new Error('A paint stack cannot use itself (through a fill or mask graph).');
        const fetchStored = storedPictureFetcher;
        if (!fetchStored) throw new Error('A paint stack draws only in the editor, where its painted pictures can be read.');
        const [{ materialLibrary }, { PaintStack }, { BUILTIN_GRAPHS }, { readStoredGraph }] = await Promise.all([
            import('../../runtime/materials/materialLibrary'),
            import('./paintStack'),
            import('./smartLibrary'),
            import('../graph/stored'),
        ]);
        const asset = materialLibrary.get(assetId);
        const document = asset?.paint ? readPaintDocument(asset.paint) : null;
        if (!document) throw new Error('The painted set this node used is no longer in the project.');
        const layers = stackLayers(document, String(context.params.folder ?? ''));
        if (!layers) throw new Error('The folder this node used is no longer in the painted set.');
        // Fill and mask graphs: the built-in smart ones and the project's.
        const resolveGraph: GraphResolver = (id) => {
            const stackEntry = paintStackEntry(id, (other) => materialLibrary.get(other));
            if (stackEntry) return stackEntry;
            const builtin = BUILTIN_GRAPHS.get(id);
            if (builtin) return builtin;
            const found = materialLibrary.get(id);
            return found?.textureGraph ? { id, name: found.name, graph: readStoredGraph(found.textureGraph).graph } : undefined;
        };
        running.add(assetId);
        let stack: import('./paintStack').PaintStack | null = null;
        try {
            stack = await PaintStack.open({
                gpu: context.gpu,
                resolveGraph,
                texture: (id) => context.texture(id),
                current: {},
                fetchPicture: async (pictureId) => {
                    const response = await fetchStored(pictureId);
                    if (!response.ok) throw new Error('A painted picture could not be read.');
                    return response.blob();
                },
                storePicture: () => Promise.reject(new Error('A paint stack in a graph keeps nothing.')),
            }, await flatSquare(), { ...document, udim: false, layers });
            // The set's own bake lies on the same UV square; the graph's mesh maps, when it has them, take its place.
            const bake = await bakeFrom(context.gpu, stack.size, (name) => context.external(name));
            if (bake) {
                const { releaseTileBake } = await import('../bake/meshBaker');
                const own = stack.takeBake(bake);
                for (const result of own?.values() ?? []) releaseTileBake(context.gpu, result);
            }
            await stack.compose();
            const images = stack.channelImages(1001) as Partial<Record<string, GpuImage>>;
            const out: Record<string, GpuImage> = {};
            for (const port of PAINT_STACK_NODE.outputs) {
                const target = context.image(port.kind === 'color' ? 'color' : 'gray');
                const source = images[port.key];
                if (source) await context.pass(target, 'void main() { outColor = texture(painted, vUv); }', { inputs: { painted: source } });
                else context.gpu.clear(target, port.key === 'normal' ? [0.5, 0.5, 1, 1] : port.key === 'opacity' ? [1, 1, 1, 1] : [0, 0, 0, 1]);
                out[port.key] = target;
            }
            return out;
        } finally {
            stack?.dispose();
            running.delete(assetId);
        }
    },
};
