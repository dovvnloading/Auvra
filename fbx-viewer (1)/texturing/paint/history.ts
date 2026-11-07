import type { TileBake } from '../bake/meshBaker';
import type { GpuImage } from '../gpu/textureGpu';
import { historyBytes, type BrushSettings, type HistoryEntry } from './strokes';
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

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/** Steps undone and then replaced by a new one, kept as a branch off the step they came after (null: the start). */
export interface HistoryBranch { from: HistoryEntry | null; steps: HistoryEntry[] }

/** The history's lines: the one the set is on (past, and future as redo takes it, last first) and the branches off it. */
export interface HistoryLines { past: HistoryEntry[]; future: HistoryEntry[]; branches: HistoryBranch[] }

/** Before a new step: the undone steps it replaces are kept as a branch off where it is made. */
export const branchBeforeStep = (lines: HistoryLines): void => {
    if (!lines.future.length) return;
    lines.branches.push({ from: lines.past[lines.past.length - 1] ?? null, steps: [...lines.future].reverse() });
    lines.future = [];
};

/** The branch holding a step, or null. */
export const branchOf = (lines: Pick<HistoryLines, 'branches'>, entry: HistoryEntry | null): HistoryBranch | null =>
    entry ? lines.branches.find((branch) => branch.steps.includes(entry)) ?? null : null;

/**
 * Goes to just after `target` (null: the start) anywhere in the history: along the current line, or onto
 * the branch holding it (and first onto any branch that one comes off), the line it leaves kept as a
 * branch. `step` takes one step back or forward on the current line, false when it cannot.
 */
export const travelTo = (lines: HistoryLines, target: HistoryEntry | null, step: (direction: 'undo' | 'redo') => boolean): boolean => {
    const at = () => lines.past[lines.past.length - 1] ?? null;
    const onLine = (entry: HistoryEntry | null) => entry === null || lines.past.includes(entry) || lines.future.includes(entry);
    const along = (entry: HistoryEntry | null): boolean => {
        const back = entry === null || lines.past.includes(entry);
        while (at() !== entry) if (!step(back ? 'undo' : 'redo')) return false;
        return true;
    };
    if (onLine(target)) return along(target);
    const branch = branchOf(lines, target);
    if (!branch) return false;
    if (!onLine(branch.from) && !travelTo(lines, branch.from, step)) return false;
    if (!along(branch.from)) return false;
    const tail = [...lines.future].reverse();
    lines.branches = lines.branches.filter((other) => other !== branch);
    if (tail.length) lines.branches.push({ from: branch.from, steps: tail });
    lines.future = [...branch.steps].reverse();
    return along(target);
};

/**
 * The branches to let go of: the oldest first while every step held (on the line and on branches) takes
 * more than `budget` bytes or there are more than `most` branches; then any branch nothing reaches any
 * more (it came off a step let go of, or off the start once older steps went: `startMoved`).
 */
export const branchesToDrop = (lines: HistoryLines, budget: number, most: number, startMoved: boolean): HistoryBranch[] => {
    const bytesOf = (steps: readonly HistoryEntry[]) => steps.reduce((sum, entry) => sum + historyBytes(entry), 0);
    let total = bytesOf(lines.past) + bytesOf(lines.future) + lines.branches.reduce((sum, branch) => sum + bytesOf(branch.steps), 0);
    const kept = [...lines.branches];
    const dropped: HistoryBranch[] = [];
    while (kept.length && (total > budget || kept.length > most)) {
        const oldest = kept.shift()!;
        total -= bytesOf(oldest.steps);
        dropped.push(oldest);
    }
    // Those coming off a step no longer held go too, and those coming off theirs.
    for (let changed = true; changed;) {
        changed = false;
        for (const branch of [...kept]) {
            const reached = branch.from === null ? !startMoved : lines.past.includes(branch.from) || lines.future.includes(branch.from) || kept.some((other) => other !== branch && other.steps.includes(branch.from!));
            if (reached) continue;
            kept.splice(kept.indexOf(branch), 1);
            dropped.push(branch);
            changed = true;
        }
    }
    return dropped;
};
