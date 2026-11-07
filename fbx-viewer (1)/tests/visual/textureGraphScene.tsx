import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { isGpuRenderer } from '../../renderer/gpu/frame';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { normalizeTextureGraph } from '../../texturing/graph/document';
import { textureGpu } from '../../texturing/gpu/textureGpu';
import type { TexturingGpu } from '../../texturing/gpu/texturingGpu';
import { webgpuTexturing, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { encodeChannels } from '../../texturing/materialOutput';

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
export const textureGraphScene = { ready: false, problem: null as string | null };

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params });

/** Bricks, noise multiplied over them, their height as a normal, and a colour from a function graph. */
const proofGraph = () => normalizeTextureGraph({
    version: 1,
    size: { w: 9, h: 9 },
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

/** The graph's base colour and normal on `gpu`, as PNG pictures the way a game cooks them. */
const cook = async (gpu: TexturingGpu): Promise<{ colour: Blob; normal: Blob }> => {
    const evaluator = new TextureGraphEvaluator(gpu, () => undefined, () => null);
    try {
        const states = await evaluator.evaluate({ graph: proofGraph(), targets: ['colour', 'normal'] });
        const colour = states.get('colour');
        const normal = states.get('normal');
        if (!colour?.outputs.out || !normal?.outputs.out) throw new Error(colour?.error ?? normal?.error ?? 'The graph drew nothing.');
        const pictures = await encodeChannels(gpu, { baseColor: colour.outputs.out, normal: normal.outputs.out }, 512, 512, 'separate', true);
        return { colour: pictures.find((picture) => picture.role === 'baseColor')!.blob, normal: pictures.find((picture) => picture.role === 'normal')!.blob };
    } finally {
        evaluator.dispose();
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
        const gpu: TexturingGpu = isGpuRenderer(gl) ? webgpuTexturing(gl.core.device as unknown as WgpuDevice) : textureGpu();
        void (async () => {
            let own = true;
            let pictures: { colour: Blob; normal: Blob };
            try {
                pictures = await cook(gpu);
            } catch (error) {
                // The renderer's own GPU could not: keep why (textureGraphScene.problem), and show WebGL2's cook with the ball red.
                own = false;
                textureGraphScene.problem = error instanceof Error ? error.message : String(error);
                pictures = await cook(textureGpu());
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
