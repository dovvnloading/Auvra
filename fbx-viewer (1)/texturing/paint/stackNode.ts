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

/**
 * The synthetic graph a paint stack (or folder) is offered as: its node, wired to an Output per channel.
 * Its revision follows the saved layers and, while the set is open in Paint, each change drawn there.
 */
const stackGraph = (assetId: string, folderId: string, document: PaintDocument): TextureGraph => {
    const revision = `${hashOf(JSON.stringify(document.layers))}:${openChanges.get(assetId) ?? 0}`;
    const node: TexGraphNode = { id: 'stack', type: PAINT_STACK_NODE_TYPE, x: 0, y: 0, params: { asset: assetId, folder: folderId, revision } };
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

/** A painted set's name as a graph list shows it: without "(painted)", its run-together words parted. */
export const setName = (assetName: string): string =>
    assetName.replace(/\s*\(painted\)\s*$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim() || assetName;

/** Paint stacks open in Paint now, by their asset: a graph using one draws from it instead of building its own. */
const openStacks = new Map<string, import('./paintStack').PaintStack>();

/** How many changes each set has had drawn while open in Paint: a part of its graphs' revision. */
const openChanges = new Map<string, number>();
const changeListeners = new Set<() => void>();
let changesVersion = 0;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
/** A set's change drawn in Paint, passed on to graphs at most four times a second (a stroke draws every frame). */
const noteChange = (assetId: string) => {
    openChanges.set(assetId, (openChanges.get(assetId) ?? 0) + 1);
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
        changeTimer = null;
        changesVersion++;
        for (const listener of changeListeners) listener();
    }, 250);
};

/** Hears when a set open in Paint has changed (graphs using its stack then build their graph list again). */
export const subscribeOpenStacks = (listener: () => void): (() => void) => {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
};
/** Goes up as sets open in Paint change. */
export const openStacksVersion = (): number => changesVersion;

/**
 * Says a set's stack is open in Paint: graphs draw from it, and draw again as what it draws changes,
 * not only when the set is saved. Gives back what says it has closed.
 */
export const registerOpenStack = (assetId: string, stack: import('./paintStack').PaintStack): (() => void) => {
    openStacks.set(assetId, stack);
    let seen = stack.drawnCount;
    const stop = stack.subscribe(() => {
        // Only a round that drew something: a graph asking the stack to compose sets off a round that draws nothing.
        if (stack.drawnCount === seen) return;
        seen = stack.drawnCount;
        noteChange(assetId);
    });
    return () => {
        stop();
        if (openStacks.get(assetId) === stack) openStacks.delete(assetId);
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
        const set = setName(asset.name);
        entries.push({ id: `${PAINT_STACK_PREFIX}${asset.id}`, name: `${set}: paint stack`, graph: stackGraph(asset.id, '', document) });
        for (const folder of allLayers(document.layers).filter((layer) => layer.kind === 'folder')) {
            entries.push({ id: `${PAINT_STACK_PREFIX}${asset.id}:${folder.id}`, name: `${set}: ${folder.name} folder`, graph: stackGraph(asset.id, folder.id, document) });
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
        /** A stack's tile the node shows: 1001, or its first. */
        const tileOf = (from: import('./paintStack').PaintStack) => (from.tiles.includes(1001) ? 1001 : from.tiles[0]);
        /** Channels' pictures put into the node's outputs at the graph's size. */
        const outputsOf = async (images: Partial<Record<string, GpuImage>>): Promise<Record<string, GpuImage>> => {
            const out: Record<string, GpuImage> = {};
            for (const port of PAINT_STACK_NODE.outputs) {
                const target = context.image(port.kind === 'color' ? 'color' : 'gray');
                const source = images[port.key];
                if (source) await context.pass(target, 'void main() { outColor = texture(painted, vUv); }', { inputs: { painted: source } });
                else context.gpu.clear(target, port.key === 'normal' ? [0.5, 0.5, 1, 1] : port.key === 'opacity' ? [1, 1, 1, 1] : [0, 0, 0, 1]);
                out[port.key] = target;
            }
            return out;
        };
        // The set open in Paint: its stack is put together already (with the set's own bake), and a folder
        // of it is put together from the same pictures.
        const folderId = String(context.params.folder ?? '');
        const open = openStacks.get(assetId);
        if (open && open.usable) {
            await open.compose();
            if (!folderId) return outputsOf(open.channelImages(tileOf(open)) as Partial<Record<string, GpuImage>>);
            const alone = await open.composeFolderAlone(folderId, tileOf(open));
            if (alone) {
                try {
                    return await outputsOf(alone);
                } finally {
                    for (const image of Object.values(alone)) context.gpu.release(image);
                }
            }
        }
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
            // Drawn at the graph's size (never past the set's own): its pictures are read scaled to it.
            }, await flatSquare(), { ...document, udim: false, layers, size: Math.min(document.size, Math.max(7, Math.round(Math.log2(Math.max(context.width, context.height))))) });
            // The set's own bake lies on the same UV square; the graph's mesh maps, when it has them, take its place.
            const bake = await bakeFrom(context.gpu, stack.size, (name) => context.external(name));
            if (bake) {
                const { releaseTileBake } = await import('../bake/meshBaker');
                const own = stack.takeBake(bake);
                for (const result of own?.values() ?? []) releaseTileBake(context.gpu, result);
            }
            await stack.compose();
            return await outputsOf(stack.channelImages(tileOf(stack)) as Partial<Record<string, GpuImage>>);
        } finally {
            stack?.dispose();
            running.delete(assetId);
        }
    },
};
