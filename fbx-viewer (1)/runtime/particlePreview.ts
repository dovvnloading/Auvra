/** Transient editor playback, shared by every layer and viewport of one level object. */
export const PARTICLE_PREVIEW_STEP = 1 / 60;

interface Layer {
    pendingSteps: number;
    restart: () => void;
}

interface Preview {
    playing: boolean;
    layers: Set<Layer>;
    listeners: Set<() => void>;
}

const previews = new Map<string, Preview>();

function acquire(id: string): Preview {
    let preview = previews.get(id);
    if (!preview) {
        preview = { playing: true, layers: new Set(), listeners: new Set() };
        previews.set(id, preview);
    }
    return preview;
}

function release(id: string, preview: Preview): void {
    if (!preview.layers.size && !preview.listeners.size && previews.get(id) === preview) previews.delete(id);
}

function setPlaying(preview: Preview, playing: boolean): void {
    if (preview.playing === playing) return;
    preview.playing = playing;
    for (const listener of preview.listeners) listener();
}

export const particlePreview = {
    isPlaying(id: string): boolean { return previews.get(id)?.playing ?? true; },
    subscribe(id: string, listener: () => void): () => void {
        const preview = acquire(id);
        preview.listeners.add(listener);
        return () => { preview.listeners.delete(listener); release(id, preview); };
    },
    attach(id: string, restart: () => void) {
        const preview = acquire(id);
        const layer = { restart, pendingSteps: 0 };
        preview.layers.add(layer);
        return {
            nextDelta(delta: number): number | null {
                if (layer.pendingSteps > 0) {
                    layer.pendingSteps--;
                    return PARTICLE_PREVIEW_STEP;
                }
                return preview.playing ? delta : null;
            },
            release() { preview.layers.delete(layer); release(id, preview); },
        };
    },
    toggle(id: string): void {
        const preview = previews.get(id);
        if (preview) setPlaying(preview, !preview.playing);
    },
    step(id: string): void {
        const preview = previews.get(id);
        if (!preview) return;
        for (const layer of preview.layers) layer.pendingSteps++;
        setPlaying(preview, false);
    },
    restart(id: string): void {
        const preview = previews.get(id);
        if (!preview) return;
        for (const layer of preview.layers) {
            layer.pendingSteps = 0;
            layer.restart();
        }
        setPlaying(preview, true);
    },
};
