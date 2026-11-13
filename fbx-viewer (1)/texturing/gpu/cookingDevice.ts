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
