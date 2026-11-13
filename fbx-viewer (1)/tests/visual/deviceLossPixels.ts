import { acquireGpuCore, releaseIdleGpuCore, type GpuCore } from '../../renderer/gpu/device';
import { webgpuTexturing, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];

/** Reuse the texture target pool. Each run must overwrite both rows and yield exactly the requested colour. */
async function draw(core: GpuCore, expected: number[]): Promise<number[]> {
    const gpu = webgpuTexturing(core.device as unknown as WgpuDevice);
    const image = gpu.image(2, 2, 'color', 8);
    try {
        await gpu.pass(image, {
            fragment: 'uniform vec4 tone;\nvoid main() { outColor = tone; }',
            uniforms: { tone: expected.map(byte => byte / 255) },
        });
        const rgba = await gpu.readRgba8Later(image);
        if (rgba?.length !== 16 || !rgba.every((byte, i) => byte === expected[i % 4])) {
            throw new Error(`WebGPU recovery fixture expected ${expected.join(',')}, read ${rgba?.join(',') ?? 'no pixels'}`);
        }
        return Array.from(rgba.slice(0, 4));
    } finally {
        gpu.release(image);
    }
}

/** Called after the visual scene and its shared device have been released. */
export async function deviceLossPixels() {
    try {
        const { core, reason } = await acquireGpuCore();
        if (!core) throw new Error(`Cannot start WebGPU loss fixture: ${reason}`);
        const first = await draw(core, RED);
        const afterFirst = await draw(core, GREEN);
        core.device.destroy();
        const lost = await core.lost;
        if (lost.reason !== 'destroyed') throw new Error(`Unexpected WebGPU loss: ${lost.reason} ${lost.message}`);
        const replacement = await acquireGpuCore();
        if (!replacement.core || replacement.core.device === core.device) {
            throw new Error(`Missing replacement WebGPU device: ${replacement.reason ?? 'same device'}`);
        }
        const afterRecovery = await draw(replacement.core, GREEN);
        return { status: 'verified', lossReason: lost.reason, first, afterFirst, afterRecovery };
    } finally {
        await releaseIdleGpuCore();
    }
}
