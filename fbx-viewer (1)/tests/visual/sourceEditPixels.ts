import * as THREE from 'three';
import type { GpuImage } from '../../texturing/gpu/textureGpu';
import type { TexturingGpu } from '../../texturing/gpu/texturingGpu';
import { normalizeTextureGraph } from '../../texturing/graph/document';
import { AbortedError, TextureGraphEvaluator } from '../../texturing/graph/evaluator';

const sourceId = 'retained-source-photo';
const graph = normalizeTextureGraph({
    version: 1, size: { w: 5, h: 5 }, nodes: [
        { id: 'photo', type: 'bitmap', x: 0, y: 0, params: { texture: sourceId } },
        { id: 'result', type: 'output', x: 1, y: 0, params: { channel: 'baseColor' } },
        { id: 'independent', type: 'uniformColor', x: 0, y: 1, params: {} },
    ],
    links: [{ from: 'photo', fromOutput: 'out', to: 'result', toInput: 'in' }],
});
const targets = ['result', 'independent'];

async function assertImage(gpu: TexturingGpu, image: GpuImage | undefined, expected: number[]) {
    if (!image) throw new Error('Missing cooked Bitmap output');
    const pixels = await gpu.readRgba8Later(image);
    if (pixels?.length !== 32 * 32 * 4 || !pixels.every((byte, i) => byte === expected[i % 4])) {
        throw new Error(`Expected Bitmap RGBA ${expected}, read ${pixels?.slice(0, 4) ?? 'no pixels'}`);
    }
    return Array.from(pixels.slice(0, 4));
}

/** Interrupt a real recook after the edited Bitmap is published but before its dependent output commits. */
export async function sourceEditPixels(gpu: TexturingGpu) {
    const red = [255, 0, 0, 255];
    const green = [0, 255, 0, 255];
    const data = Uint8Array.from(red);
    const texture = new THREE.DataTexture(data, 1, 1);
    texture.needsUpdate = true;
    const liveBefore = gpu.memory.live;
    const evaluator = new TextureGraphEvaluator(gpu, () => undefined, id => id === sourceId ? texture : null);
    let retained: GpuImage | undefined;
    try {
        const initial = await evaluator.evaluate({ graph, targets });
        const output = initial.get('result')?.outputs.out;
        if (!output) throw new Error('Initial cook produced no material output');
        retained = gpu.retain(output);
        const first = await assertImage(gpu, retained, red);

        data.set(green);
        texture.needsUpdate = true;
        const controller = new AbortController();
        const interrupted: string[] = [];
        try {
            await evaluator.evaluate({ graph, targets, signal: controller.signal, onNode: id => {
                interrupted.push(id);
                if (id === 'photo') controller.abort();
            } });
            throw new Error('Bitmap cook completed despite cancellation');
        } catch (error) {
            if (!(error instanceof AbortedError)) throw error;
        }
        if (interrupted.join(',') !== 'photo' || evaluator.state('result')?.outputs.out !== retained) {
            throw new Error(`Cancelled cook replaced the last output or reran unrelated nodes: ${interrupted}`);
        }
        const afterCancel = await assertImage(gpu, retained, red);
        const retried: string[] = [];
        const recovered = await evaluator.evaluate({ graph, targets, onNode: id => { retried.push(id); } });
        if (retried.join(',') !== 'result') throw new Error(`Unexpected retry work: ${retried}`);
        const afterRetry = await assertImage(gpu, recovered.get('result')?.outputs.out, green);
        await assertImage(gpu, retained, red);
        if (!evaluator.upToDate({ graph, targets })) throw new Error('Recovered Bitmap cook missed its cache');
        return { status: 'verified', first, afterCancel, afterRetry, interrupted, retried };
    } finally {
        gpu.release(retained);
        evaluator.dispose();
        texture.dispose();
        if (gpu.memory.live !== liveBefore) throw new Error('Cancelled Bitmap fixture leaked a live texture target');
    }
}
