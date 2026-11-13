/**
 * WHERE A GAME COOKS ITS TEXTURE GRAPHS
 *
 * A game drawing with WebGPU says so here (the canvas does, for the game's own surface), and texture
 * graphs it cooks are drawn on that device (webgpuTexturing.ts); otherwise, and in the editor, on the
 * WebGL2 texturing context. A graph the WebGPU path cannot draw is drawn with WebGL2 instead, and why
 * is kept here. Nothing here loads the WebGPU path itself.
 */

let device: unknown = null;

/** The game's WebGPU device, or null when it draws with WebGL2 (or stops drawing). */
export const setCookingDevice = (next: unknown): void => {
    const resolved = next ?? null;
    if (device === resolved) return;
    device = resolved;
    // These diagnostics belong to the old GPU device's cooking attempts.
    // A project/backend switch or device loss must not display stale reasons
    // for a new runtime material with the same asset id.
    webgpuFallbacks.clear();
};

/** The device a game cooks on, if it draws with WebGPU. */
export const cookingDevice = (): unknown => device;

/** Why each graph (by material id) was drawn with WebGL2 instead of WebGPU, the last time it was cooked. */
export const webgpuFallbacks = new Map<string, string>();

export interface TextureCookingCapabilitySnapshot {
    backend: 'webgl2' | 'webgpu';
    /** Hardware-reported limit, not proof every graph size can run. */
    maxTextureDimension2D: number | null;
    /** WebGPU adapter feature flags, not proof a particular format uploads successfully. */
    compression: { bc: boolean | null; etc2: boolean | null; astc: boolean | null };
    float32Filterable: boolean | null;
    /** Per-material fallback reasons from the current device only. */
    fallbacks: ReadonlyArray<{ materialId: string; reason: string }>;
}

/**
 * A serializable status snapshot for M0.4 diagnostics. It reports observed
 * adapter flags and recorded fallbacks, NOT unsupported node-family claims
 * or a hardware-tested feature matrix. An absent WebGPU device keeps unknown
 * WebGL2 extension capabilities marked unknown rather than guessing.
 */
export const textureCookingCapabilities = (): TextureCookingCapabilitySnapshot => {
    const gpu = device as { limits?: { maxTextureDimension2D?: unknown }; features?: { has?: (name: string) => boolean } } | null;
    const features = gpu?.features;
    const limit = gpu?.limits?.maxTextureDimension2D;
    const valid = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && typeof features?.has === 'function';
    const has = (name: string): boolean | null => valid ? features!.has!(name) : null;
    return {
        backend: valid ? 'webgpu' : 'webgl2',
        maxTextureDimension2D: valid ? limit as number : null,
        compression: {
            bc: has('texture-compression-bc'),
            etc2: has('texture-compression-etc2'),
            astc: has('texture-compression-astc'),
        },
        float32Filterable: has('float32-filterable'),
        fallbacks: [...webgpuFallbacks].map(([materialId, reason]) => ({ materialId, reason })),
    };
};
