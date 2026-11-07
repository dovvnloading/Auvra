import * as THREE from 'three';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import type { GraphResolver } from '../../texturing/graph/registry';
import { readStoredGraph } from '../../texturing/graph/stored';
import { textureGpu } from '../../texturing/gpu/textureGpu';
import { encodeChannels, type ChannelImages, type MaterialChannel } from '../../texturing/materialOutput';
import { gpuExtensions } from '../../utils/textureCompression/compressTextures';
import { bakedSizeLog2, type CookRequest, type CookedPictures, type Cooker } from './materialCooking';
import type { MaterialAsset } from './materialLibrary';

/**
 * Cooks a texture graph's pictures on this device's GPU, through the editor's own evaluator: the graph's Output nodes
 * drawn at the size asked for, with the use's values and seed, and written as the very pictures "Update material" bakes
 * (the engine's packing, the same way up), so a cooked material looks as its baked pictures do.
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
            const asset = source.material(id);
            return asset?.textureGraph ? { id, name: asset.name, graph: readStoredGraph(asset.textureGraph).graph } : undefined;
        };
        // The pictures its nodes read, loaded before it runs (the evaluator asks for them as it goes).
        const wanted = new Set<string>();
        readTextures(stored.graph, wanted);
        const loader = new THREE.TextureLoader();
        const loaded = new Map<string, THREE.Texture>();
        await Promise.all([...wanted].map(async (textureId) => {
            const url = source.textureUrl(textureId);
            if (!url) return;
            try { loaded.set(textureId, await loader.loadAsync(url)); } catch { /* drawn without it */ }
        }));
        const gpu = textureGpu();
        const evaluator = new TextureGraphEvaluator(gpu, resolve, (textureId) => loaded.get(textureId) ?? null);
        try {
            const graph = stored.graph;
            // At the size the material bakes at, always, as the editor draws it: a smaller one is read from this.
            const largest = bakedSizeLog2(request.asset);
            const longest = Math.max(graph.size.w, graph.size.h);
            const size = { w: Math.max(4, largest - (longest - graph.size.w)), h: Math.max(4, largest - (longest - graph.size.h)) };
            const outputs = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
            const states = await evaluator.evaluate({ graph, parameters: request.values, targets: outputs.map((node) => node.id), size, ...(request.seed !== undefined ? { seed: request.seed } : {}) });
            const images: ChannelImages = {};
            for (const node of outputs) {
                const channel = String(node.params.channel ?? '');
                if (!CHANNELS.has(channel) || images[channel as MaterialChannel]) continue;
                const state = states.get(node.id);
                if (state?.error) throw new Error(state.error);
                if (state?.outputs.out) images[channel as MaterialChannel] = state.outputs.out;
            }
            const pictures = await encodeChannels(gpu, images, 2 ** size.w, 2 ** size.h, stored.layout, true);
            return Object.fromEntries(pictures.map((picture) => [picture.role, picture.blob])) as CookedPictures;
        } finally {
            evaluator.dispose();
            for (const texture of loaded.values()) texture.dispose();
        }
    },
});
