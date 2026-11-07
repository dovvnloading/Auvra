import type { TileBake } from '../bake/meshBaker';
import type { GpuImage } from '../gpu/textureGpu';
import type { BrushSettings, HistoryEntry } from './strokes';
import { PARTICLE_PRESETS } from './particles';

/**
 * THE PAINT HISTORY, AS A LIST
 *
 * What each step of a set's history is (for the history panel), and how many bakes it can keep ready to
 * put back: bake maps live on the GPU, so the bakes held for undo share a budget of their own. Past it
 * the oldest bake steps keep their place in the list but put nothing back.
 */

export type HistoryKind = 'paint' | 'erase' | 'fill' | 'bake' | 'decal' | 'particles' | 'change';

/** What a step is, from what it holds and its name. */
export const historyKind = (entry: Pick<HistoryEntry, 'label' | 'pixels' | 'bakeMaps' | 'document'>): HistoryKind => {
    if (entry.bakeMaps) return 'bake';
    const label = entry.label.toLowerCase();
    if (entry.pixels) {
        if (label.startsWith('erase')) return 'erase';
        if (label.startsWith('fill')) return 'fill';
        if (label.includes('decal')) return 'decal';
        if (label.includes('particle') || label.includes('drip') || label.includes('dust') || label.includes('leak') || label.includes('splash')) return 'particles';
        return 'paint';
    }
    return 'change';
};

/**
 * The name a brush stroke goes into the history under, by what it did: erasing; a particle brush by its
 * preset's name (Drips, Leaks, Dust, Splashes) or by how its particles move; blurring, sharpening,
 * smudging or cloning; else painting.
 */
export const strokeLabel = (tool: 'paint' | 'erase', brush: Pick<BrushSettings, 'mode' | 'particles'>): string => {
    if (tool === 'erase') return 'Erase';
    const particles = brush.particles;
    if (particles?.enabled) {
        const preset = PARTICLE_PRESETS.find((each) => JSON.stringify(each.settings) === JSON.stringify(particles));
        return preset ? preset.name : { flow: 'Running particles', fall: 'Falling particles', bounce: 'Bouncing particles' }[particles.motion];
    }
    return { paint: 'Paint', blur: 'Blur', sharpen: 'Sharpen', smudge: 'Smudge', clone: 'Clone' }[brush.mode] ?? 'Paint';
};

/** Bytes a GPU image holds. */
const imageBytes = (image: GpuImage): number => image.width * image.height * (image.kind === 'color' ? 4 : 1) * (image.precision / 8);

/** Bytes a bake's maps hold on the GPU. */
export const bakeBytes = (maps: ReadonlyMap<number, TileBake>): number => {
    let bytes = 0;
    for (const tile of maps.values()) {
        for (const image of Object.values(tile.maps)) if (image) bytes += imageBytes(image);
        for (const image of Object.values(tile.extras ?? {})) if (image) bytes += imageBytes(image);
        bytes += imageBytes(tile.coverage) + imageBytes(tile.nearest);
    }
    return bytes;
};

/** GPU memory the bakes held for undo and redo may take (the bake in use is not counted). */
export const BAKE_HISTORY_BYTES = 384 * 1024 * 1024;

/**
 * The bake steps (oldest first) whose maps go so the rest fit in `budget`: every set of maps the history
 * holds, counted once, except the one in use. The newest bake step always keeps its maps.
 */
export const bakeStepsToForget = (past: readonly HistoryEntry[], future: readonly HistoryEntry[], inUse: ReadonlyMap<number, TileBake> | null, budget: number, bytesOf: (maps: ReadonlyMap<number, TileBake>) => number = bakeBytes): HistoryEntry[] => {
    const held = new Set<ReadonlyMap<number, TileBake>>();
    for (const entry of [...past, ...future]) {
        if (!entry.bakeMaps) continue;
        if (entry.bakeMaps.before) held.add(entry.bakeMaps.before);
        held.add(entry.bakeMaps.after);
    }
    if (inUse) held.delete(inUse);
    let total = 0;
    for (const maps of held) total += bytesOf(maps);
    const bakes = past.filter((entry) => entry.bakeMaps);
    const newest = [...past, ...future].filter((entry) => entry.bakeMaps).pop();
    const forget: HistoryEntry[] = [];
    for (const entry of bakes) {
        if (total <= budget || entry === newest) break;
        const before = entry.bakeMaps!.before;
        // Its maps from before go (nothing older holds them, as older bakes went first).
        if (before && held.has(before)) { total -= bytesOf(before); held.delete(before); }
        forget.push(entry);
    }
    return forget;
};
