import * as THREE from 'three';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { GRAPH_USING_TYPES, OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { PAINT_STACK_NODE_TYPE, paintBakedKey, paintStackEntry, PAINT_STACK_PREFIX } from '../../texturing/paint/stackNode';
import { PAINT_CHANNELS, readPaintDocument } from '../../texturing/paint/paintTypes';
import type { TextureGraph } from '../../texturing/graph/types';
import { flipbookFrameSize, flipbookGrid, frameTime, packFlipbook, readAnimation } from '../../texturing/graph/animation';
import type { GpuImage } from '../../texturing/gpu/textureGpu';
import { graphAnimates, type GraphResolver } from '../../texturing/graph/registry';
import { readStoredGraph } from '../../texturing/graph/stored';
import { textureGpu } from '../../texturing/gpu/textureGpu';
import type { TexturingGpu } from '../../texturing/gpu/texturingGpu';
import { cookingDevice, webgpuFallbacks } from '../../texturing/gpu/cookingDevice';
import { webgpuTexturing, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { encodeChannels, flipbookEdgeOf, type ChannelImages, type MaterialChannel } from '../../texturing/materialOutput';
import { gpuExtensions } from '../../utils/textureCompression/compressTextures';
import { bakedSizeLog2, type CookRequest, type CookedPictures, type Cooker } from './materialCooking';
import type { MaterialAsset } from './materialLibrary';

/**
 * Cooks a texture graph's pictures on this device's GPU, through the editor's own evaluator: the graph's Output nodes
 * drawn at the size asked for, with the use's values and seed, and written as the very pictures "Update material" bakes
 * (the engine's packing, the same way up), so a cooked material looks as its baked pictures do. An animated graph is
 * drawn at the request's time, or (played as a flipbook) at each of its frames, laid out as Update material lays them.
 *
 * A game drawing with WebGPU cooks on its own device (webgpuTexturing.ts). A graph that path cannot draw (a pass that
 * does not translate or compile, or lacks an applied Paint set) is drawn with WebGL2 instead, and why is kept
 * (cookingDevice.ts's webgpuFallbacks) and noted in the diagnostics.
 */

const CHANNELS: ReadonlySet<string> = new Set<MaterialChannel>(['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ambientOcclusion', 'emissive', 'opacity']);

/** Whether this device can cook: WebGL2 drawing into floating-point pictures, which the evaluator works in. */
export const deviceCanCook = (): boolean => {
    if (typeof WebGL2RenderingContext === 'undefined') return false;
    return gpuExtensions().has('EXT_color_buffer_float');
};

/** Texture ids a texture graph's own nodes read (Bitmap nodes and the like), however deep. */
const readTextures = (value: unknown, into: Set<string>, key = ''): void => {
    if (typeof value === 'string') {
        if ((key === 'texture' || key === 'textureId') && value) into.add(value);
        return;
    }
    if (Array.isArray(value)) { for (const item of value) readTextures(item, into); return; }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) readTextures(child, into, childKey);
};


/** Find all textures a cook needs, including nested graphs and the last applied whole Paint sets.
 * Folder-only Paint nodes intentionally receive no whole-set snapshots: they need their own bake.
 */
export const graphCookSources = (
    graph: TextureGraph,
    resolve: GraphResolver,
    assetOf: (id: string) => MaterialAsset | undefined,
): { textureIds: Set<string>; paintInputs: Map<string, string> } => {
    const textureIds = new Set<string>();
    const paintInputs = new Map<string, string>();
    const visited = new Set<string>();
    const visit = (part: TextureGraph): void => {
        readTextures(part, textureIds);
        for (const node of part.nodes) {
            if (node.type === PAINT_STACK_NODE_TYPE) {
                const assetId = String(node.params.asset ?? '');
                if (!assetId) throw new Error('A Paint stack graph is missing its painted-set ID.');
                if (node.params.folder) throw new Error('A Paint stack folder needs its own baked pictures in a standalone game.');
                const asset = assetOf(assetId);
                const document = asset?.paint ? readPaintDocument(asset.paint) : null;
                if (!document?.applied) throw new Error('Paint stack "' + assetId + '" has no applied pictures in this game.');
                // Applied UDIM atlases are not an ordinary 0..1 UV-square picture.
                if (document.udim) throw new Error('Paint stack "' + assetId + '" uses UDIM tiles and needs atlas-aware runtime cooking.');
                let found = false;
                for (const channel of [...PAINT_CHANNELS, 'orm'] as const) {
                    const id = document.applied.textures[channel];
                    if (!id) continue;
                    found = true;
                    textureIds.add(id);
                    paintInputs.set(paintBakedKey(assetId, channel), id);
                }
                if (!found) throw new Error('Paint stack "' + assetId + '" has no saved applied picture texture IDs.');
            }
            const id = node.params.graph;
            if (!GRAPH_USING_TYPES.has(node.type) || typeof id !== 'string' || !id || visited.has(id)) continue;
            visited.add(id);
            const nested = resolve(id);
            if (nested) visit(nested.graph);
        }
    };
    visit(graph);
    return { textureIds, paintInputs };
};

export interface GraphCookerSource {
    /** A material asset by id (the graphs a graph uses as nodes). */
    material(id: string): MaterialAsset | undefined;
    /** Where a project texture's picture is (for the graph's Bitmap nodes). */
    textureUrl(textureId: string): string | undefined;
}

export const createGraphCooker = (source: GraphCookerSource): Cooker => ({
    async cook(request: CookRequest): Promise<CookedPictures> {
        const stored = readStoredGraph(request.asset.textureGraph);
        const resolve: GraphResolver = (id) => {
            if (id.startsWith(PAINT_STACK_PREFIX)) return paintStackEntry(id, source.material);
            const asset = source.material(id);
            return asset?.textureGraph ? { id, name: asset.name, graph: readStoredGraph(asset.textureGraph).graph } : undefined;
        };
        // Load pictures from the graph and all its dependencies, including saved Paint sets.
        const { textureIds: wanted, paintInputs } = graphCookSources(stored.graph, resolve, source.material);
        const loader = new THREE.TextureLoader();
        const loaded = new Map<string, THREE.Texture>();
        await Promise.all([...wanted].map(async (textureId) => {
            const url = source.textureUrl(textureId);
            if (!url) return;
            try { loaded.set(textureId, await loader.loadAsync(url)); } catch { /* drawn without it */ }
        }));
        try {
            // A missing applied picture is not a blank channel. Fail the cook so the game keeps
            // its previously baked fallback rather than baking a subtly damaged material.
            for (const [key, textureId] of paintInputs) if (!loaded.has(textureId)) {
                throw new Error(`Applied Paint stack image "${key}" (${textureId}) could not be loaded in this game.`);
            }
            const device = cookingDevice();
            const webgpu = device ? webgpuTexturing(device as WgpuDevice) : null;
            if (webgpu) {
                try {
                    webgpu.takeProblems();
                    const pictures = await cookOn(webgpu, request, stored, resolve, loaded, paintInputs, true);
                    // A pass drawn at once that the device refused is heard of only afterwards.
                    const problems = webgpu.takeProblems();
                    if (problems.length) throw new Error(problems[0]);
                    webgpuFallbacks.delete(request.asset.id);
                    return pictures;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    webgpuFallbacks.set(request.asset.id, reason);
                    frontendDiagnostics.failure('texture_graph_webgpu_fallback', new Error(`${request.asset.name}: ${reason}`));
                }
            }
            return await cookOn(textureGpu(), request, stored, resolve, loaded, paintInputs);
        } finally {
            for (const texture of loaded.values()) texture.dispose();
        }
    },
});

/**
 * The graph's pictures drawn on one texturing GPU, written as Update material writes them. `strict` (the WebGPU
 * attempt) refuses any node that could not be drawn, so the graph is drawn with WebGL2 instead of with a stand-in.
 */
const cookOn = async (gpu: TexturingGpu, request: CookRequest, stored: ReturnType<typeof readStoredGraph>, resolve: GraphResolver, loaded: ReadonlyMap<string, THREE.Texture>, paintInputs: ReadonlyMap<string, string>, strict = false): Promise<CookedPictures> => {
    const evaluator = new TextureGraphEvaluator(gpu, resolve, (textureId) => loaded.get(textureId) ?? null);
    const external = Object.fromEntries([...paintInputs].map(([key, textureId]) => [key, loaded.get(textureId) ?? null]));
    try {
        const graph = stored.graph;
        // At the size the material bakes at, always, as the editor draws it: a smaller one is read from this.
        const largest = bakedSizeLog2(request.asset);
        const longest = Math.max(graph.size.w, graph.size.h);
        const size = { w: Math.max(4, largest - (longest - graph.size.w)), h: Math.max(4, largest - (longest - graph.size.h)) };
        const outputs = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
        // Each channel's image at a time (held, so the next drawing does not take it back).
        const draw = async (at: { w: number; h: number }, time: number): Promise<ChannelImages> => {
            const states = await evaluator.evaluate({ graph, parameters: request.values, external, targets: outputs.map((node) => node.id), size: at, time, ...(request.seed !== undefined ? { seed: request.seed } : {}) });
            if (strict) {
                for (const [id, state] of states) {
                    if (state.error) throw new Error(`the node "${graph.nodes.find((node) => node.id === id)?.type ?? id}" could not be drawn: ${state.error}`);
                }
            }
            const images: ChannelImages = {};
            for (const node of outputs) {
                const channel = String(node.params.channel ?? '');
                if (!CHANNELS.has(channel) || images[channel as MaterialChannel]) continue;
                const state = states.get(node.id);
                if (state?.error) throw new Error(state.error);
                if (state?.outputs.out) images[channel as MaterialChannel] = gpu.retain(state.outputs.out);
            }
            return images;
        };
        const held: GpuImage[] = [];
        try {
            const animation = readAnimation(graph.animation);
            let images: ChannelImages;
            let width = 2 ** size.w;
            let height = 2 ** size.h;
            if (animation.play === 'flipbook' && graphAnimates(graph, resolve)) {
                const { columns, rows } = flipbookGrid(animation.frames);
                const frames: ChannelImages[] = [];
                for (let index = 0; index < animation.frames; index++) {
                    const frame = await draw(flipbookFrameSize(size, animation.frames), frameTime(index, animation.frames, animation.loop));
                    held.push(...Object.values(frame));
                    frames.push(frame);
                }
                images = {};
                // Each frame inside the edge the material's Flipbook Frames node reads it inside of (none on one made before edges).
                const edge = flipbookEdgeOf(request.asset.graph);
                for (const channel of Object.keys(frames[0]) as MaterialChannel[]) {
                    const atlas = packFlipbook(gpu, frames.map((frame) => frame[channel]!), columns, rows, edge);
                    held.push(atlas);
                    images[channel] = atlas;
                    width = atlas.width;
                    height = atlas.height;
                }
            } else {
                images = await draw(size, request.time ?? 0);
                held.push(...Object.values(images));
            }
            const pictures = await encodeChannels(gpu, images, width, height, stored.layout, true);
            return Object.fromEntries(pictures.map((picture) => [picture.role, picture.blob])) as CookedPictures;
        } finally {
            for (const image of held) gpu.release(image);
        }
    } finally {
        evaluator.dispose();
    }
};
