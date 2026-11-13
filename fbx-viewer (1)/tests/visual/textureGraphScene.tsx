import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { isGpuRenderer } from '../../renderer/gpu/frame';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { normalizeTextureGraph } from '../../texturing/graph/document';
import { textureGpu, type InstanceOptions } from '../../texturing/gpu/textureGpu';
import { packCopies, SCATTER_VERTEX, SCATTER_VARYINGS, type ScatterCopy } from '../../texturing/graph/scatter';
import type { TexturingGpu } from '../../texturing/gpu/texturingGpu';
import { webgpuTexturing, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { encodeChannels } from '../../texturing/materialOutput';
import { paintBakedKey } from '../../texturing/paint/stackNode';
import { realNow } from './instrument';

/**
 * ONE TEXTURE GRAPH COOKED ON THE RENDERER'S OWN GPU
 *
 * On WebGL2 the graph is drawn by the WebGL2 texturing context; on WebGPU by the WebGPU path on the
 * renderer's device (webgpuTexturing.ts), with nothing falling back. Its pictures (base colour and
 * normal, as a game cooks them) are shown on a plane, so the two renderers' pictures compare how the
 * two paths cook: noise multiplied over bricks, the bricks' height turned into a normal map, and the
 * colour from a Pixel processor's function graph (WGSL from its writer on WebGPU). A small ball beside
 * the plane is green when the cook ran on the renderer's own GPU, red when it could not.
 */

/** Seen by the scene's settle step: the cooked pictures are on the plane, and why the renderer's own GPU could not cook (if it could not). */
export interface TextureCookBenchmark {
    resolution: number;
    backend: 'webgl2' | 'webgpu' | 'webgl2-fallback';
    graphSha256: string;
    editedGraphSha256: string;
    adapter: { vendor: string | null; renderer: string | null; architecture?: string | null; device?: string | null };
    firstNodes: number;
    coldEvalMs: number;
    coldSyncMs: number;
    encodeMs: number;
    cachedNodes: number;
    cachedEvalMs: number;
    editNodes: number;
    editEvalMs: number;
    editSyncMs: number;
}

/** Total time of the ordinary 512px graph bake, including PNG encoding. */
export interface TextureGraphCookMeasurement {
    milliseconds: number;
    pixels: number;
    backend: 'webgl2' | 'webgpu';
    fallback: boolean;
}

/** Optional measurements, only when ?textureBench=1; default screenshots do not run extra cooks. */
export const textureGraphScene = {
    ready: false,
    problem: null as string | null,
    benchmark: null as TextureCookBenchmark | null,
    cook: null as TextureGraphCookMeasurement | null,
};

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params });

/** Bricks, noise multiplied over them, their height as a normal, and a colour from a function graph. */
const proofGraph = (logSize = 9) => normalizeTextureGraph({
    version: 1,
    size: { w: logSize, h: logSize },
    seed: 7,
    parameters: [],
    nodes: [
        node('noise', 'perlinNoise', { scale: 6, seed: 3 }),
        node('bricks', 'tiles', { columns: 4, rows: 8, gap: 0.05, bevel: 0.2, heightRandom: 0.35, seed: 2 }),
        node('height', 'blend', { mode: 'multiply', opacity: 1 }),
        node('normal', 'normalFromHeight', { intensity: 5 }),
        node('colour', 'pixelProcessor', {
            mode: 'graph',
            function: {
                nodes: [
                    { id: 's', type: 'fnSample', x: 0, y: 0, params: { picture: 'a' } },
                    { id: 'dark', type: 'fnColour', x: 0, y: 0, params: { value: [0.32, 0.12, 0.08, 1] } },
                    { id: 'light', type: 'fnColour', x: 0, y: 0, params: { value: [0.86, 0.52, 0.34, 1] } },
                    { id: 'mix', type: 'fnMix', x: 0, y: 0, params: {} },
                    { id: 'r', type: 'fnResult', x: 0, y: 0, params: {} },
                ],
                links: [
                    { from: 'dark', fromOutput: 'out', to: 'mix', toInput: 'a' },
                    { from: 'light', fromOutput: 'out', to: 'mix', toInput: 'b' },
                    { from: 's', fromOutput: 'gray', to: 'mix', toInput: 't' },
                    { from: 'mix', fromOutput: 'out', to: 'r', toInput: 'value' },
                ],
            },
        }),
    ],
    links: [
        { from: 'noise', fromOutput: 'out', to: 'height', toInput: 'foreground' },
        { from: 'bricks', fromOutput: 'out', to: 'height', toInput: 'background' },
        { from: 'height', fromOutput: 'out', to: 'normal', toInput: 'in' },
        { from: 'height', fromOutput: 'out', to: 'colour', toInput: 'a' },
    ],
});


/**
 * Exercise the real instanced shader on both GPUs without changing the kept scene picture.
 * It checks overlapping copies, image-edge wrapping and all four stack modes at interior pixels.
 * A failed comparison marks the WebGPU scene as failed (its green proof ball turns red).
 */
const checkScatterParity = async (webgpu: TexturingGpu): Promise<void> => {
    const makeCopy = (x: number): ScatterCopy => ({
        x, y: 0.5, halfWidth: 0.22, halfHeight: 0.22,
        turn: 0, pattern: 0, random: 0.5, mirrorX: false, mirrorY: false,
        tiltX: 0, tiltY: 0, brightness: 1, lift: 0,
    });
    const packed = packCopies([makeCopy(0.47), makeCopy(0.54), makeCopy(0.96)]);
    const placements = packed.data.map((values) => {
        const texture = new THREE.DataTexture(values, packed.width, packed.height, THREE.RGBAFormat, THREE.FloatType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        return texture;
    });
    const fragment = `void main() {
    vec2 d = abs(vLocal - vec2(0.5));
    if (max(d.x, d.y) > 0.47) discard;
    float value = (float(vCopy) + 1.0) / 5.0;
    gl_FragDepth = 1.0 - value * 0.999;
    outColor = vec4(value, value * 0.2, 0.1, 1.0);
}`;
    const sample = async (gpu: TexturingGpu, stack: InstanceOptions['stack']): Promise<Uint8Array> => {
        const image = gpu.image(32, 32, 'color', 8);
        try {
            await gpu.drawInstances(image, {
                count: 3, stack, wrap: [true, false], varyings: SCATTER_VARYINGS,
                vertex: SCATTER_VERTEX, fragment,
                inputs: { place0: placements[0], place1: placements[1], place2: placements[2] },
                uniforms: { uPlaceWidth: packed.width },
            });
            const pixels = await gpu.readRgba8Later(image);
            if (!pixels) throw new Error(`Could not read ${stack} scatter pixels`);
            return pixels;
        } finally {
            gpu.release(image);
        }
    };
    try {
        for (const stack of ['higher', 'over', 'max', 'add'] as const) {
            const [actual, expected] = await Promise.all([sample(webgpu, stack), sample(textureGpu(), stack)]);
            for (const [x, y] of [[0, 16], [10, 16], [16, 16], [23, 16], [31, 16]]) {
                const offset = (y * 32 + x) * 4;
                if (expected[offset] === 0 || Math.abs(actual[offset] - expected[offset]) > 3) {
                    throw new Error(`WebGPU ${stack} scatter differs from WebGL2 at (${x}, ${y}): ${actual[offset]} vs ${expected[offset]}`);
                }
            }
        }
    } finally {
        placements.forEach((texture) => texture.dispose());
    }
};

/** Compare a real compressed BC1 input read through the texturing pass on both backends.
 * This leaves the visual reference unchanged, and runs only if both adapters expose BC/S3TC.
 */
const checkCompressedParity = async (webgpu: TexturingGpu): Promise<void> => {
    const glgpu = textureGpu();
    if (!glgpu.renderer.getContext().getExtension('WEBGL_compressed_texture_s3tc')) return;
    const blocks = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        // Two vertical stripes, each a solid RGB565 colour: red or green.
        const value = i % 2 === 0 ? 0xf800 : 0x07e0;
        blocks[i * 8] = value & 255;
        blocks[i * 8 + 1] = value >> 8;
    }
    const compressed = new THREE.CompressedTexture([
        { data: blocks, width: 8, height: 8 },
    ] as unknown as ImageData[], 8, 8, THREE.RGB_S3TC_DXT1_Format);
    compressed.minFilter = compressed.magFilter = THREE.NearestFilter;
    compressed.colorSpace = THREE.NoColorSpace;
    compressed.needsUpdate = true;
    const sample = async (gpu: TexturingGpu): Promise<Uint8Array> => {
        const result = gpu.image(8, 8, 'color', 8);
        try {
            await gpu.pass(result, { fragment: 'void main() { outColor = texture(picture, vUv); }', inputs: { picture: compressed } });
            const pixels = await gpu.readRgba8Later(result);
            if (!pixels) throw new Error('Could not read compressed texture pixels');
            return pixels;
        } finally {
            gpu.release(result);
        }
    };
    try {
        const [actual, expected] = await Promise.all([sample(webgpu), sample(glgpu)]);
        for (const x of [1, 6]) for (const y of [1, 6]) {
            const at = (y * 8 + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                if (Math.abs(actual[at + channel] - expected[at + channel]) > 4) {
                    throw new Error('Compressed BC1 differs between WebGPU and WebGL2 at (' + x + ', ' + y + ') channel ' + channel);
                }
            }
        }
    } finally {
        compressed.dispose();
    }
};

/** Record the context that drew the benchmark, including a WebGL fallback. */
const benchmarkAdapter = (adapter?: GPUAdapter): TextureCookBenchmark['adapter'] => {
    if (adapter) {
        const info = adapter.info;
        return { vendor: info?.vendor || null, renderer: info?.description || null,
            architecture: info?.architecture || null, device: info?.device || null };
    }
    const gl = textureGpu().renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
};

const graphSha256 = async (graph: ReturnType<typeof proofGraph>): Promise<string> => {
    const bytes = new TextEncoder().encode(JSON.stringify(graph));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

/** The graph's base colour and normal on `gpu`, as PNG pictures the way a game cooks them. */
const cook = async (gpu: TexturingGpu, benchmark = false, logSize = 9): Promise<{
    colour: Blob;
    normal: Blob;
    timings?: Omit<TextureCookBenchmark, 'backend' | 'adapter'>;
}> => {
    const evaluator = new TextureGraphEvaluator(gpu, () => undefined, () => null);
    const graph = proofGraph(logSize);
    const resolution = 2 ** logSize;
    const targets = ['colour', 'normal'];
    try {
        let firstNodes = 0;
        const coldStart = realNow();
        const states = await evaluator.evaluate({ graph, targets, onNode: () => { firstNodes++; } });
        const coldEvalMs = realNow() - coldStart;
        // Any node the GPU could not draw counts, not only the two shown (a node upstream would leave a stand-in).
        for (const [id, state] of states) if (state.error) throw new Error(`${id}: ${state.error}`);
        const colour = states.get('colour');
        const normal = states.get('normal');
        if (!colour?.outputs.out || !normal?.outputs.out) throw new Error(colour?.error ?? normal?.error ?? 'The graph drew nothing.');
        let coldSyncMs = 0;
        if (benchmark) {
            const syncStart = realNow();
            if (!await gpu.readPixelLater(colour.outputs.out, 0, 0)) throw new Error('Cannot synchronize the texture-graph benchmark with its GPU.');
            coldSyncMs = realNow() - syncStart;
        }
        const encodeStart = realNow();
        const pictures = await encodeChannels(gpu, { baseColor: colour.outputs.out, normal: normal.outputs.out },
            resolution, resolution, 'separate', true);
        const encodeMs = realNow() - encodeStart;
        const result = {
            colour: pictures.find((picture) => picture.role === 'baseColor')!.blob,
            normal: pictures.find((picture) => picture.role === 'normal')!.blob,
        };
        if (!benchmark) return result;
        // The exact same request must be a cache hit. An upstream parameter edit
        // must only recompute descendants, not every unrelated node. Count actual
        // onNode completions instead of pretending repeated timing proves cache use.
        let cachedNodes = 0;
        const cachedStart = realNow();
        const cached = await evaluator.evaluate({ graph, targets, onNode: () => { cachedNodes++; } });
        const cachedEvalMs = realNow() - cachedStart;
        for (const [id, state] of cached) if (state.error) throw new Error(`Cached ${id}: ${state.error}`);
        const editedGraph = normalizeTextureGraph({
            ...graph,
            nodes: graph.nodes.map((node) => node.id === 'noise'
                ? { ...node, params: { ...node.params, scale: 7 } } : node),
        });
        let editNodes = 0;
        const editStart = realNow();
        const edited = await evaluator.evaluate({ graph: editedGraph, targets, onNode: () => { editNodes++; } });
        const editEvalMs = realNow() - editStart;
        for (const [id, state] of edited) if (state.error) throw new Error(`Incremental ${id}: ${state.error}`);
        const editedImage = edited.get('colour')?.outputs.out;
        if (!editedImage) throw new Error('Incremental graph did not produce the base colour.');
        const editSyncStart = realNow();
        if (!await gpu.readPixelLater(editedImage, 0, 0)) throw new Error('Cannot synchronize incremental texture cooking.');
        const editSyncMs = realNow() - editSyncStart;
        return {
            ...result,
            timings: { graphSha256: await graphSha256(graph), editedGraphSha256: await graphSha256(editedGraph),
                resolution, firstNodes, coldEvalMs, coldSyncMs, encodeMs,
                cachedNodes, cachedEvalMs, editNodes, editEvalMs, editSyncMs },
        };
    } finally {
        evaluator.dispose();
    }
};


/** Read the last-applied Paint set on real WebGPU and WebGL2 texture graph evaluators.
 * No visible reference image changes: a mismatch fails the existing WebGPU scene.
 */
const checkPaintSnapshotParity = async (webgpu: TexturingGpu): Promise<void> => {
    const source = new THREE.DataTexture(new Uint8Array([181, 47, 21, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    const orm = new THREE.DataTexture(new Uint8Array([245, 158, 31, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    source.needsUpdate = true;
    orm.needsUpdate = true;
    source.minFilter = source.magFilter = orm.minFilter = orm.magFilter = THREE.NearestFilter;
    const graph = normalizeTextureGraph({
        version: 1, size: { w: 5, h: 5 }, seed: 0, parameters: [],
        nodes: [
            { id: 'paint', type: 'paintStack', x: 0, y: 0, params: { asset: 'paint-proof', folder: '', revision: 'applied' } },
            { id: 'colour', type: 'output', x: 100, y: 0, params: { channel: 'baseColor' } },
            { id: 'rough', type: 'output', x: 100, y: 100, params: { channel: 'roughness' } },
            { id: 'metal', type: 'output', x: 100, y: 200, params: { channel: 'metallic' } },
        ],
        links: [
            { from: 'paint', fromOutput: 'baseColor', to: 'colour', toInput: 'in' },
            { from: 'paint', fromOutput: 'roughness', to: 'rough', toInput: 'in' },
            { from: 'paint', fromOutput: 'metallic', to: 'metal', toInput: 'in' },
        ],
    });
    const snapshot = {
        [paintBakedKey('paint-proof', 'baseColor')]: source,
        [paintBakedKey('paint-proof', 'orm')]: orm,
    };
    const channels = ['colour', 'rough', 'metal'] as const;
    const evaluate = async (gpu: TexturingGpu): Promise<Record<string, Uint8Array>> => {
        const evaluator = new TextureGraphEvaluator(gpu, () => undefined, () => null);
        try {
            const states = await evaluator.evaluate({ graph, targets: [...channels], external: snapshot });
            for (const [id, state] of states) if (state.error) throw new Error('Paint snapshot node ' + id + ': ' + state.error);
            const output: Record<string, Uint8Array> = {};
            for (const id of channels) {
                const image = states.get(id)?.outputs.out;
                if (!image) throw new Error('Paint snapshot ' + id + ' produced no image');
                const rgba = await gpu.readRgba8Later(image);
                if (!rgba) throw new Error('Paint snapshot ' + id + ' could not be read');
                output[id] = rgba;
            }
            return output;
        } finally {
            evaluator.dispose();
        }
    };
    try {
        const [actual, expected] = await Promise.all([evaluate(webgpu), evaluate(textureGpu())]);
        const wanted = { colour: [181, 47, 21], rough: [158, 158, 158], metal: [31, 31, 31] };
        for (const id of channels) {
            for (const [x, y] of [[4, 4], [16, 16], [27, 27]]) {
                const at = (y * 32 + x) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    if (Math.abs(actual[id][at + channel] - expected[id][at + channel]) > 3 ||
                        Math.abs(actual[id][at + channel] - wanted[id][channel]) > 3) {
                        throw new Error('Paint snapshot ' + id + ' differs on WebGPU at (' + x + ', ' + y + ') channel ' + channel +
                            ': ' + actual[id][at + channel] + ' vs ' + expected[id][at + channel]);
                    }
                }
            }
        }
    } finally {
        source.dispose();
        orm.dispose();
    }
};

const load = async (blob: Blob, srgb: boolean): Promise<THREE.Texture> => {
    const url = URL.createObjectURL(blob);
    try {
        const texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = 4;
        return texture;
    } finally {
        URL.revokeObjectURL(url);
    }
};

export const TextureGraphScene: React.FC = () => {
    const gl = useThree((state) => state.gl);
    const [maps, setMaps] = useState<{ colour: THREE.Texture; normal: THREE.Texture; own: boolean } | null>(null);
    useEffect(() => {
        let gone = false;
        textureGraphScene.ready = false;
        textureGraphScene.problem = null;
        textureGraphScene.benchmark = null;
        textureGraphScene.cook = null;
        const options = new URLSearchParams(window.location.search);
        const benchmark = options.has('textureBench');
        const requestedSize = Number(options.get('textureSize') ?? 9);
        const logSize = benchmark && [9, 11, 12].includes(requestedSize) ? requestedSize : 9;
        const gpu: TexturingGpu = isGpuRenderer(gl) ? webgpuTexturing(gl.core.device as unknown as WgpuDevice) : textureGpu();
        void (async () => {
            let own = true;
            let pictures: Awaited<ReturnType<typeof cook>>;
            try {
                if (isGpuRenderer(gl)) {
                    await checkScatterParity(gpu);
                    if (gl.core.device.features.has('texture-compression-bc')) await checkCompressedParity(gpu);
                    await checkPaintSnapshotParity(gpu);
                }
                const cookStarted = realNow();
                pictures = await cook(gpu, benchmark, logSize);
                // Only time the normal visual bake; the opt-in benchmark has
                // separate cold/cache/incremental durations and should not
                // aggregate those phases into a misleading single number.
                if (!benchmark) textureGraphScene.cook = {
                    milliseconds: realNow() - cookStarted,
                    backend: isGpuRenderer(gl) ? 'webgpu' : 'webgl2',
                    fallback: false,
                    pixels: 512 * 512,
                };
                if (pictures.timings) textureGraphScene.benchmark = { ...pictures.timings, backend: isGpuRenderer(gl) ? 'webgpu' : 'webgl2',
                    adapter: benchmarkAdapter(isGpuRenderer(gl) ? gl.core.adapter : undefined) };
            } catch (error) {
                // The renderer's own GPU could not: keep why (textureGraphScene.problem), and show WebGL2's cook with the ball red.
                own = false;
                textureGraphScene.problem = error instanceof Error ? error.message : String(error);
                const fallbackStarted = realNow();
                pictures = await cook(textureGpu(), benchmark, logSize);
                if (!benchmark) textureGraphScene.cook = {
                    milliseconds: realNow() - fallbackStarted,
                    backend: 'webgl2',
                    fallback: isGpuRenderer(gl),
                    pixels: 512 * 512,
                };
                if (pictures.timings) textureGraphScene.benchmark = { ...pictures.timings, backend: 'webgl2-fallback', adapter: benchmarkAdapter() };
            }
            const [colour, normal] = await Promise.all([load(pictures.colour, true), load(pictures.normal, false)]);
            if (gone) return;
            setMaps({ colour, normal, own });
        })();
        return () => { gone = true; };
    }, [gl]);
    useEffect(() => {
        if (maps) textureGraphScene.ready = true;
    }, [maps]);
    return (
        <>
            <ambientLight intensity={0.35} />
            <directionalLight position={[2.5, 3, 4]} intensity={2.6} />
            {maps && (
                <mesh rotation={[-0.3, 0, 0]}>
                    <planeGeometry args={[4, 4]} />
                    <meshStandardMaterial map={maps.colour} normalMap={maps.normal} roughness={0.85} metalness={0} />
                </mesh>
            )}
            {maps && (
                <mesh position={[2.35, 1.6, 0]}>
                    <sphereGeometry args={[0.14, 24, 16]} />
                    <meshBasicMaterial color={maps.own ? '#3fcf6a' : '#e04040'} />
                </mesh>
            )}
        </>
    );
};
