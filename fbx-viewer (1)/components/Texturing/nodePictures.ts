import { useSyncExternalStore } from 'react';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { textureGpu, type TextureGpu } from '../../texturing/gpu/textureGpu';
import { createNode } from '../../texturing/graph/document';
import { AbortedError, TextureGraphEvaluator, mainInput } from '../../texturing/graph/evaluator';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';
import type { TexGraphLink, TexNodeDef, TextureGraph } from '../../texturing/graph/types';

/**
 * PICTURES OF TEXTURE NODES (for the node finder)
 *
 * What each kind of node makes, drawn once at 64 pixels from its default settings and kept for the
 * session. A node that changes an image is shown changing a sample suited to it (noise for most,
 * tiles for edges, distances and flood fills) wired into its main input; its other inputs are left
 * as they are when nothing is wired.
 */

export const NODE_PICTURE_SIZE = 64;

/** A picture to draw: `key` names it (the finder entry), `type` and `params` make the node. */
export interface PictureRequest { key: string; type: string; params?: Record<string, unknown> }

/** A picture, or 'failed' for a node that draws nothing useful on its own (the finder shows its mark). */
export type NodePicture = ImageData | 'failed';

const pictures = new Map<string, NodePicture>();
const listeners = new Set<() => void>();
let queue: PictureRequest[] = [];
let running = false;

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** One entry's picture, once drawn (a component using it redraws when its own picture arrives, and only then). */
export const useNodePicture = (key: string): NodePicture | undefined => useSyncExternalStore(subscribe, () => pictures.get(key));

/** The sample a node changing images is shown with. */
const sampleFor = (definition: TexNodeDef): string => {
    if (definition.category === 'Edges and distance' || definition.type.startsWith('flood')) return 'tiles';
    if (definition.category === 'Height and normals') return 'cells';
    return 'perlinNoise';
};

const nextFrame = () => new Promise<void>((resolve) => {
    // Frames stop while the window is hidden, so a timer stands in.
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 60);
});

const draw = async (gpu: TextureGpu, evaluator: TextureGraphEvaluator, request: PictureRequest): Promise<NodePicture> => {
    const definition = textureNodeDefinitionByType(request.type);
    if (!definition?.outputs.length) return 'failed';
    const node = { ...createNode(request.type, 0, 0, request.params), id: 'picture' };
    const nodes = [node];
    const links: TexGraphLink[] = [];
    const main = mainInput(definition);
    if (main) {
        const sample = sampleFor(definition);
        nodes.unshift({ ...createNode(sample, -200, 0), id: 'sample' });
        links.push({ from: 'sample', fromOutput: 'out', to: 'picture', toInput: main });
    }
    const graph: TextureGraph = { version: 1, size: { w: 6, h: 6 }, seed: 11, nodes, links, parameters: [] };
    try {
        const state = (await evaluator.evaluate({ graph, targets: ['picture'] })).get('picture');
        const image = state && !state.error ? Object.values(state.outputs)[0] : undefined;
        if (!image) return 'failed';
        const preview = gpu.image(NODE_PICTURE_SIZE, NODE_PICTURE_SIZE, 'color', 8);
        gpu.passNow(preview, {
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
        const reading = gpu.readRgba8Later(preview);
        gpu.release(preview);
        const pixels = await reading;
        if (!pixels) return 'failed';
        // Bottom row first as read: top row first for the picture.
        const row = NODE_PICTURE_SIZE * 4;
        const flipped = new Uint8ClampedArray(pixels.length);
        for (let y = 0; y < NODE_PICTURE_SIZE; y++) flipped.set(pixels.subarray((NODE_PICTURE_SIZE - 1 - y) * row, (NODE_PICTURE_SIZE - y) * row), y * row);
        return new ImageData(flipped, NODE_PICTURE_SIZE, NODE_PICTURE_SIZE);
    } finally {
        evaluator.retainOnly(new Set());
    }
};

const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    const gpu = textureGpu();
    const evaluator = new TextureGraphEvaluator(gpu, () => undefined, () => null);
    try {
        while (queue.length) {
            const request = queue.shift()!;
            if (pictures.has(request.key)) continue;
            let picture: NodePicture = 'failed';
            try {
                picture = await draw(gpu, evaluator, request);
            } catch (error) {
                if (!(error instanceof AbortedError)) frontendDiagnostics.failure('texture_node_picture_failed', error);
            }
            pictures.set(request.key, picture);
            for (const listener of listeners) listener();
            // One picture a frame, so the editor stays responsive while they fill in.
            await nextFrame();
        }
    } finally {
        evaluator.dispose();
        running = false;
    }
};

/** Draws the pictures not drawn yet, in the order given (the finder's), one a frame. */
export const requestNodePictures = (requests: readonly PictureRequest[]): void => {
    const waiting = new Set(queue.map((request) => request.key));
    const fresh = requests.filter((request) => !pictures.has(request.key) && !waiting.has(request.key));
    if (!fresh.length) return;
    queue = [...queue, ...fresh];
    void run();
};
