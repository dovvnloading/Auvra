import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { textureGpu, type GpuImage, type TextureGpu } from '../../texturing/gpu/textureGpu';
import { AbortedError, TextureGraphEvaluator, type ExternalImage, type NodeState } from '../../texturing/graph/evaluator';
import { OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { textureNodeDefinition, type GraphResolver } from '../../texturing/graph/registry';
import type { OutputChannel, TextureGraph } from '../../texturing/graph/types';
import type { ChannelImages, MaterialChannel } from '../../texturing/materialOutput';

/**
 * A texture graph open for editing: it redraws what an edit reaches as soon as the edit is made,
 * keeps a small picture of every node for the canvas, and keeps the images the 3D view lights
 * (base colour turned linear, the normal, occlusion/roughness/metallic packed, emissive, height).
 */

export const THUMBNAIL_SIZE = 96;

export interface Thumbnail { signature: string; image: ImageData }

/** Images the 3D view draws with, owned by the session. */
export interface PreviewSet {
    baseColor: GpuImage | null;
    normal: GpuImage | null;
    orm: GpuImage | null;
    emissive: GpuImage | null;
    height: GpuImage | null;
    opacity: GpuImage | null;
    /** Changes when any of them does. */
    version: number;
}

const MATERIAL_CHANNELS: readonly MaterialChannel[] = ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ambientOcclusion', 'emissive', 'opacity'];

export class TextureGraphSession {
    readonly gpu: TextureGpu;
    readonly evaluator: TextureGraphEvaluator;
    readonly thumbnails = new Map<string, Thumbnail>();
    /** The latest thumbnail read asked for, per node: a slower, older read that lands later is let go. */
    private readonly thumbnailTickets = new Map<string, number>();
    readonly preview: PreviewSet = { baseColor: null, normal: null, orm: null, emissive: null, height: null, opacity: null, version: 0 };
    graph: TextureGraph;
    parameters: Record<string, unknown> = {};
    external: Record<string, ExternalImage | null> = {};
    externalVersion = '';
    busy = false;
    /** Nodes drawn in the last run and how long the run took. */
    lastRun = { nodes: 0, milliseconds: 0 };
    version = 0;
    private readonly listeners = new Set<() => void>();
    private controller: AbortController | null = null;
    private scheduled = false;
    private disposed = false;
    private previewSignature = '';

    constructor(graph: TextureGraph, resolve: GraphResolver, texture: (id: string) => THREE.Texture | null) {
        this.gpu = textureGpu();
        this.evaluator = new TextureGraphEvaluator(this.gpu, resolve, texture);
        this.graph = graph;
        this.schedule();
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    state(nodeId: string): NodeState | undefined {
        return this.evaluator.state(nodeId);
    }

    setGraph(graph: TextureGraph, parameters: Record<string, unknown> = this.parameters): void {
        if (graph === this.graph && parameters === this.parameters) return;
        this.graph = graph;
        this.parameters = parameters;
        this.schedule();
    }

    /** Something outside the graph changed (a picture finished loading, a model was re-baked). */
    refresh(): void {
        this.schedule();
    }

    private schedule(): void {
        if (this.disposed) return;
        this.controller?.abort();
        if (this.scheduled) return;
        this.scheduled = true;
        let started = false;
        const start = () => {
            if (started) return;
            started = true;
            this.scheduled = false;
            void this.run();
        };
        // Soon after the edit; frames stop while the window is hidden, so a timer stands in.
        requestAnimationFrame(start);
        setTimeout(start, 50);
    }

    private async run(): Promise<void> {
        if (this.disposed) return;
        const controller = new AbortController();
        this.controller = controller;
        this.busy = true;
        this.emit();
        const started = performance.now();
        let drawn = 0;
        const graph = this.graph;
        try {
            this.evaluator.prune(graph);
            await this.evaluator.evaluate({
                graph,
                parameters: this.parameters,
                external: this.external,
                externalVersion: this.externalVersion,
                targets: graph.nodes.map((node) => node.id),
                signal: controller.signal,
                onNode: (nodeId, state) => {
                    drawn++;
                    this.makeThumbnail(nodeId, state);
                    this.emit();
                },
            });
            for (const id of [...this.thumbnails.keys()]) if (!graph.nodes.some((node) => node.id === id)) this.dropThumbnail(id);
            this.updatePreview();
            this.lastRun = { nodes: drawn, milliseconds: performance.now() - started };
        } catch (error) {
            if (!(error instanceof AbortedError)) frontendDiagnostics.failure('texture_graph_evaluation_failed', error);
        } finally {
            if (this.controller === controller) {
                this.controller = null;
                this.busy = false;
                this.emit();
            }
        }
    }

    /** The image a node shows: its chosen output, else its first. */
    imageOf(nodeId: string, output?: string): GpuImage | null {
        const state = this.evaluator.state(nodeId);
        if (!state) return null;
        if (output && state.outputs[output]) return state.outputs[output];
        return Object.values(state.outputs)[0] ?? null;
    }

    /** Forgets a node's thumbnail, and any read of it still on its way. */
    private dropThumbnail(nodeId: string): void {
        this.thumbnails.delete(nodeId);
        this.thumbnailTickets.set(nodeId, (this.thumbnailTickets.get(nodeId) ?? 0) + 1);
    }

    private makeThumbnail(nodeId: string, state: NodeState): void {
        const image = Object.values(state.outputs)[0];
        if (!image) {
            this.dropThumbnail(nodeId);
            return;
        }
        const node = this.graph.nodes.find((candidate) => candidate.id === nodeId);
        const preview = this.gpu.image(THUMBNAIL_SIZE, THUMBNAIL_SIZE, 'color', 8);
        this.gpu.passNow(preview, {
            fragment: `uniform int gray;
void main() {
    vec4 v = texture(source, vUv);
    if (gray == 1) v = vec4(v.rrr, 1.0);
    vec2 cell = floor(gl_FragCoord.xy / 8.0);
    vec3 checker = mix(vec3(0.16), vec3(0.22), mod(cell.x + cell.y, 2.0));
    outColor = vec4(mix(checker, v.rgb, clamp(v.a, 0.0, 1.0)), 1.0);
}`,
            inputs: { source: image },
            uniforms: { gray: image.kind === 'gray' ? 1 : 0 },
        });
        // Read without holding up the GPU: the thumbnail fills in once the drawing is done, and an older read
        // that lands after a newer one is let go.
        const ticket = (this.thumbnailTickets.get(nodeId) ?? 0) + 1;
        this.thumbnailTickets.set(nodeId, ticket);
        const signature = state.signature + (node?.type ?? '');
        const reading = this.gpu.readRgba8Later(preview);
        this.gpu.release(preview);
        void reading.then((pixels) => {
            if (!pixels || this.disposed || this.thumbnailTickets.get(nodeId) !== ticket) return;
            // Bottom row first as read: top row first for the picture.
            const row = THUMBNAIL_SIZE * 4;
            const flipped = new Uint8ClampedArray(pixels.length);
            for (let y = 0; y < THUMBNAIL_SIZE; y++) flipped.set(pixels.subarray((THUMBNAIL_SIZE - 1 - y) * row, (THUMBNAIL_SIZE - y) * row), y * row);
            this.thumbnails.set(nodeId, { signature, image: new ImageData(flipped, THUMBNAIL_SIZE, THUMBNAIL_SIZE) });
            this.emit();
        });
    }

    /** Each engine channel's image: the first Output node set to it that drew. */
    channelImages(): ChannelImages {
        const images: ChannelImages = {};
        for (const node of this.graph.nodes) {
            if (node.type !== OUTPUT_NODE_TYPE) continue;
            const channel = node.params.channel as OutputChannel;
            if (!(MATERIAL_CHANNELS as readonly string[]).includes(channel) || images[channel as MaterialChannel]) continue;
            const image = this.evaluator.state(node.id)?.outputs.out;
            if (image) images[channel as MaterialChannel] = image;
        }
        return images;
    }

    private updatePreview(): void {
        const images = this.channelImages();
        const signature = MATERIAL_CHANNELS.map((channel) => {
            const node = this.graph.nodes.find((candidate) => candidate.type === OUTPUT_NODE_TYPE && candidate.params.channel === channel);
            return node ? this.evaluator.state(node.id)?.signature ?? '' : '';
        }).join('|');
        if (signature === this.previewSignature) return;
        this.previewSignature = signature;
        const gpu = this.gpu;
        const remake = (current: GpuImage | null, source: GpuImage | undefined, kind: 'color' | 'gray', precision: 8 | 16, fragment: string, inputs: Record<string, GpuImage | null | undefined> = {}): GpuImage | null => {
            gpu.release(current);
            if (!source && !Object.values(inputs).some(Boolean)) return null;
            const width = source?.width ?? Object.values(inputs).find(Boolean)!.width;
            const height = source?.height ?? Object.values(inputs).find(Boolean)!.height;
            const image = gpu.image(width, height, kind, precision);
            gpu.passNow(image, { fragment, inputs: source ? { source, ...inputs } : inputs });
            image.target.texture.wrapS = image.target.texture.wrapT = THREE.RepeatWrapping;
            return image;
        };
        const preview = this.preview;
        preview.baseColor = remake(preview.baseColor, images.baseColor, 'color', 16, 'void main() { vec4 c = texture(source, vUv); outColor = vec4(srgbToLinear(c.rgb), c.a); }');
        preview.emissive = remake(preview.emissive, images.emissive, 'color', 16, 'void main() { outColor = vec4(srgbToLinear(texture(source, vUv).rgb), 1.0); }');
        preview.normal = remake(preview.normal, images.normal, 'color', 8, 'void main() { outColor = texture(source, vUv); }');
        preview.height = remake(preview.height, images.height, 'gray', 16, 'void main() { outColor = texture(source, vUv); }');
        // The 3D view's alpha map reads green: a grey copy in every channel.
        preview.opacity = remake(preview.opacity, images.opacity, 'color', 8, 'void main() { float v = texture(source, vUv).r; outColor = vec4(v, v, v, 1.0); }');
        const hasOrm = images.ambientOcclusion || images.roughness || images.metallic;
        gpu.release(preview.orm);
        preview.orm = null;
        if (hasOrm) {
            const size = images.roughness ?? images.metallic ?? images.ambientOcclusion!;
            const orm = gpu.image(size.width, size.height, 'color', 8);
            gpu.passNow(orm, {
                fragment: `uniform int hasAo;\nuniform int hasRough;\nuniform int hasMetal;
void main() { outColor = vec4(hasAo == 1 ? texture(ao, vUv).r : 1.0, hasRough == 1 ? texture(rough, vUv).r : 0.5, hasMetal == 1 ? texture(metal, vUv).r : 0.0, 1.0); }`,
                inputs: { ao: images.ambientOcclusion ?? null, rough: images.roughness ?? null, metal: images.metallic ?? null },
                uniforms: { hasAo: images.ambientOcclusion ? 1 : 0, hasRough: images.roughness ? 1 : 0, hasMetal: images.metallic ? 1 : 0 },
            });
            orm.target.texture.wrapS = orm.target.texture.wrapT = THREE.RepeatWrapping;
            preview.orm = orm;
        }
        preview.version++;
    }

    /** True when a node's definition knows how to draw it. */
    knows(nodeId: string, resolve: GraphResolver): boolean {
        const node = this.graph.nodes.find((candidate) => candidate.id === nodeId);
        return Boolean(node && textureNodeDefinition(node, resolve));
    }

    dispose(): void {
        this.disposed = true;
        this.controller?.abort();
        this.evaluator.dispose();
        for (const key of ['baseColor', 'normal', 'orm', 'emissive', 'height', 'opacity'] as const) {
            this.gpu.release(this.preview[key]);
            this.preview[key] = null;
        }
        this.listeners.clear();
    }
}
