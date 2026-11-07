import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';

/**
 * ANIMATED TEXTURE GRAPHS
 *
 * A graph whose nodes read the time (a Time node, or a function graph's Time) animates. Its time runs
 * round a loop of a set length, so what it makes at the end of the loop meets what it makes at the
 * start: an animation that tiles in time. The game plays it one of two ways: a flipbook (N frames over
 * the loop, laid out in a grid on one picture and played by the material's Flipbook Frames node), or
 * cooked again on the game's GPU a set number of times a second (round 8's cooking).
 */

export interface GraphAnimation {
    /** Seconds the time takes to come round. */
    loop: number;
    /** Frames in its flipbook. */
    frames: number;
    /** How the game plays it. */
    play: 'flipbook' | 'cook';
    /** Cooks a second, when the game cooks it again as it plays. */
    rate: number;
}

/** The frame counts a flipbook can have: each fills a grid exactly. */
export const FLIPBOOK_FRAMES = [4, 8, 12, 16, 24, 32, 48, 64] as const;

export const DEFAULT_ANIMATION: GraphAnimation = { loop: 4, frames: 16, play: 'flipbook', rate: 8 };

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** A graph's stored animation settings made safe, or the defaults. */
export const readAnimation = (value: unknown): GraphAnimation => {
    const raw = (value && typeof value === 'object' ? value : {}) as Partial<GraphAnimation>;
    const frames = Math.round(finite(raw.frames, DEFAULT_ANIMATION.frames));
    return {
        loop: Math.min(600, Math.max(0.1, finite(raw.loop, DEFAULT_ANIMATION.loop))),
        frames: (FLIPBOOK_FRAMES as readonly number[]).includes(frames) ? frames : DEFAULT_ANIMATION.frames,
        play: raw.play === 'cook' ? 'cook' : 'flipbook',
        rate: Math.min(60, Math.max(0.25, finite(raw.rate, DEFAULT_ANIMATION.rate))),
    };
};

/** The time a node reads: seconds into the loop, the loop's length, and how far round it is (0 to 1). */
export interface GraphTime { seconds: number; loop: number; phase: number }

/** `seconds` brought round its loop. */
export const timeAt = (seconds: number, loop: number): GraphTime => {
    const length = Math.max(1e-3, loop);
    const wrapped = ((seconds % length) + length) % length;
    return { seconds: wrapped, loop: length, phase: wrapped / length };
};

/** The grid a flipbook of `frames` frames is laid out in: the fewest columns at least as many as rows that fill it exactly. */
export const flipbookGrid = (frames: number): { columns: number; rows: number } => {
    const n = Math.max(1, Math.round(frames));
    for (let columns = Math.ceil(Math.sqrt(n)); columns <= n; columns++) if (n % columns === 0) return { columns, rows: n / columns };
    return { columns: n, rows: 1 };
};

/** The time a flipbook frame is drawn at: evenly round the loop, frame 0 at its start. */
export const frameTime = (index: number, frames: number, loop: number): number => (index / Math.max(1, frames)) * loop;

/**
 * Where frame `index` sits in a flipbook's picture (u, v of its bottom left corner, and its width and
 * height): frames run along the rows from the top left, as the material's Flipbook Frames node reads them.
 */
export const flipbookCell = (index: number, columns: number, rows: number): [number, number, number, number] => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [column / columns, (rows - 1 - row) / rows, 1 / columns, 1 / rows];
};

/** The frame a flipbook shows at `seconds`, played round its loop. */
export const flipbookFrameAt = (seconds: number, frames: number, loop: number): number => Math.min(frames - 1, Math.floor(timeAt(seconds, loop).phase * frames));

/** The time a game cooks an animated graph at: the loop's time stepped to `rate` cooks a second. */
export const cookTimeStep = (seconds: number, loop: number, rate: number): number => {
    const wrapped = timeAt(seconds, loop).seconds;
    const step = 1 / Math.max(0.25, rate);
    // Whole steps round the loop: the last one ends where the loop starts again.
    const steps = Math.max(1, Math.round(loop / step));
    return (Math.floor((wrapped / loop) * steps) % steps) * (loop / steps);
};

/** Seconds until the next cook step, from `seconds`. */
export const untilNextStep = (seconds: number, loop: number, rate: number): number => {
    const steps = Math.max(1, Math.round(loop * Math.max(0.25, rate)));
    const length = loop / steps;
    const wrapped = timeAt(seconds, loop).seconds;
    return length - (wrapped % length);
};

/** The size (log2) each frame of a flipbook is drawn at, so the whole picture is the size the material bakes at. */
export const flipbookFrameSize = (size: { w: number; h: number }, frames: number): { w: number; h: number } => {
    const { columns, rows } = flipbookGrid(frames);
    return { w: Math.max(4, size.w - Math.ceil(Math.log2(columns))), h: Math.max(4, size.h - Math.ceil(Math.log2(rows))) };
};

/**
 * Frames laid out into one picture, a grid of `columns` x `rows` from the top left (as flipbookCell
 * places them), each copied into its cell at the frames' size.
 */
export const packFlipbook = (gpu: TextureGpu, frames: readonly GpuImage[], columns: number, rows: number): GpuImage => {
    const first = frames[0];
    const atlas = gpu.image(first.width * columns, first.height * rows, first.kind, first.precision);
    gpu.clear(atlas, first.kind === 'gray' ? [0, 0, 0, 1] : [0, 0, 0, 0]);
    frames.forEach((frame, index) => {
        const [u, v] = flipbookCell(index, columns, rows);
        const x = Math.round(u * atlas.width);
        const y = Math.round(v * atlas.height);
        gpu.passNow(atlas, {
            fragment: 'uniform vec4 uCell;\nvoid main() { outColor = texture(source, (gl_FragCoord.xy - uCell.xy) / uCell.zw); }',
            inputs: { source: frame },
            uniforms: { uCell: new THREE.Vector4(x, y, first.width, first.height) },
            scissor: { x, y, width: first.width, height: first.height },
        });
    });
    return atlas;
};
