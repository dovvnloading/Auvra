interface Bc1Capabilities {
    webgpuBC: boolean;
    webgl2S3TC: boolean;
}

export type Bc1ParityResult = Bc1Capabilities & (
    | { status: 'verified' }
    | { status: 'not-tested' | 'failed'; reason: string }
);

export async function checkBc1Parity(capabilities: Bc1Capabilities, compare: () => Promise<void>): Promise<Bc1ParityResult> {
    const missing = [];
    if (!capabilities.webgpuBC) missing.push('texture-compression-bc');
    if (!capabilities.webgl2S3TC) missing.push('WEBGL_compressed_texture_s3tc');
    if (missing.length) return { ...capabilities, status: 'not-tested', reason: `Missing ${missing.join(' and ')}` };
    try {
        await compare();
        return { ...capabilities, status: 'verified' };
    } catch (error) {
        return { ...capabilities, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}

/** BC1 fixture: two solid stripes, red at x=1 and green at x=6. */
export function compareBc1Pixels(webgpu: Uint8Array, webgl2: Uint8Array): void {
    if (webgpu.length !== 8 * 8 * 4 || webgl2.length !== webgpu.length) throw new Error('Incomplete BC1 pixel readback.');
    for (const x of [1, 6]) for (const y of [1, 6]) {
        const at = (y * 8 + x) * 4;
        const expected = x === 1 ? [255, 0, 0] : [0, 255, 0];
        for (let channel = 0; channel < 3; channel++) {
            const gpuValue = webgpu[at + channel];
            const glValue = webgl2[at + channel];
            const wanted = expected[channel];
            if (Math.max(gpuValue, glValue, wanted) - Math.min(gpuValue, glValue, wanted) > 4) {
                throw new Error(`BC1 pixel (${x}, ${y}) channel ${channel}: WebGPU ${gpuValue}, WebGL2 ${glValue}, expected ${wanted}.`);
            }
        }
    }
}
