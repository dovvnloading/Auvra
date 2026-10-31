/**
 * HOW MUCH RAY WORK A FRAME CAN AFFORD
 *
 * Rays cost what the GPU in front of the player makes of them, which no setting chosen in the editor can know. So the
 * GPU's own clock times the work and the work is cut to fit a limit in milliseconds: the same level does everything on
 * a strong card and a share of it on a weak one, where the light is only slower to follow.
 *
 * All of this but the timer is pure logic, so that it can be checked without a GPU.
 */

/** The least of the work a frame does: below this the light would all but stop following the level. */
export const MIN_RAY_SHARE = 1 / 32;
/** Where the work starts before any timing has come back: a weak card must not be handed all of it first. */
const FIRST_SHARE = 1 / 8;
/** How fast the share may rise, per frame. It falls at once. */
const CLIMB_PER_FRAME = 1.1;
/** How fast the known cost follows a new timing: a rise must be answered, a fall may only be a moment looking at the sky. */
const COST_RISE = 0.5;
const COST_FALL = 0.05;
/** While work stands down the clock has nothing to say, so what it last cost is slowly forgotten: in time the work is tried again. */
const FORGET_PER_FRAME = 0.998;

export class RayBudget {
    /** The share of the full work the coming frame may do. */
    share: number;
    /** What the work has been costing, in milliseconds of the GPU's time. */
    spentMs = 0;
    /** False while the limit will not pay even for the least of the work. */
    affordable = true;
    private fullCostMs: number | null = null;

    /** `least` is the smallest share of the work worth doing at all. */
    constructor(private readonly least = MIN_RAY_SHARE) {
        this.share = Math.max(FIRST_SHARE, least);
    }

    /** A timing has come back: the work cost `ms` at the share it ran with. */
    noteSpent(ms: number, share: number): void {
        this.spentMs += (ms - this.spentMs) * COST_RISE;
        const full = ms / Math.max(share, MIN_RAY_SHARE);
        if (this.fullCostMs === null) this.fullCostMs = full;
        else this.fullCostMs += (full - this.fullCostMs) * (full > this.fullCostMs ? COST_RISE : COST_FALL);
    }

    /** Sets the share to what `limitMs` pays for. With no timings to go on, `pressure` is all there is to tell. */
    settle(limitMs: number, pressure: number): number {
        const pays = this.fullCostMs === null ? pressure : limitMs / Math.max(this.fullCostMs, 1e-6);
        this.affordable = pays >= this.least;
        if (!this.affordable && this.fullCostMs !== null) this.fullCostMs *= FORGET_PER_FRAME;
        const wanted = Math.min(1, Math.max(this.least, pays));
        this.share = wanted < this.share ? wanted : Math.min(wanted, this.share * CLIMB_PER_FRAME);
        return this.share;
    }
}

/** Frames slower than this mean the whole frame needs help, whatever the rays cost. */
const SLOW_FRAME_MS = 1000 / 45;
/** Frames faster than this have room to give the rays more again. */
const EASY_FRAME_MS = 1000 / 55;
/** Longer than this is a hitch or a hidden tab, which says nothing about what the GPU can do. */
const NOT_A_FRAME_MS = 250;
/** Rays are rarely all of a slow frame: past this, cutting them takes more from the light than it gives the frame. */
const MIN_PRESSURE = 1 / 4;
const PRESSURE_FALL = 0.99;
const PRESSURE_RISE = 1 / 512;
const FRAME_SMOOTHING = 0.1;

/** Whether the frames as a whole are keeping up, from the time between them: scales the limit, and stands in for it where the GPU has no clock. */
export class FramePressure {
    /** 1 while frames keep up, falling towards MIN_PRESSURE while they do not. */
    value = 1;
    /** Time between frames, smoothed. */
    frameMs = 1000 / 60;

    noteFrame(ms: number): void {
        if (ms <= 0 || ms > NOT_A_FRAME_MS) return;
        this.frameMs += (ms - this.frameMs) * FRAME_SMOOTHING;
        if (this.frameMs > SLOW_FRAME_MS) this.value = Math.max(MIN_PRESSURE, this.value * PRESSURE_FALL);
        else if (this.frameMs < EASY_FRAME_MS) this.value = Math.min(1, this.value + PRESSURE_RISE);
    }
}

const TIME_ELAPSED = 0x88bf;
const GPU_DISJOINT = 0x8fbb;
/** Spans waiting on the GPU at most: past this they are not timed, rather than piling up on a stalled one. */
const MOST_WAITING = 8;

interface TimedSpan {
    query: WebGLQuery;
    frame: number;
    share: number;
}

/**
 * Times stretches of GPU work on its own clock. The answers come back a few frames later, a frame's spans added up, so
 * each view of a level counts towards the same frame.
 */
export class GpuSpanTimer {
    readonly available: boolean;
    private readonly spans: TimedSpan[] = [];
    private readonly free: WebGLQuery[] = [];
    private running: TimedSpan | null = null;

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.available = typeof gl.createQuery === 'function' && !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }

    begin(frame: number, share: number): void {
        if (!this.available || this.running || this.spans.length >= MOST_WAITING || this.gl.isContextLost()) return;
        const query = this.free.pop() ?? this.gl.createQuery();
        if (!query) return;
        this.gl.beginQuery(TIME_ELAPSED, query);
        this.running = { query, frame, share };
    }

    end(): void {
        if (!this.running) return;
        this.gl.endQuery(TIME_ELAPSED);
        this.spans.push(this.running);
        this.running = null;
    }

    /** Hands over each frame whose timings have all come back. Call between frames. */
    read(done: (ms: number, share: number) => void): void {
        if (!this.spans.length) return;
        const gl = this.gl;
        // A lost context took its queries with it.
        if (gl.isContextLost()) {
            this.spans.length = 0;
            this.free.length = 0;
            this.running = null;
            return;
        }
        // The clock jumped while these ran, so none of what has come back can be trusted.
        const disjoint = gl.getParameter(GPU_DISJOINT) as boolean;
        while (this.spans.length) {
            const frame = this.spans[0].frame;
            let count = 0;
            while (count < this.spans.length && this.spans[count].frame === frame) count++;
            for (let index = 0; index < count; index++) {
                if (!gl.getQueryParameter(this.spans[index].query, gl.QUERY_RESULT_AVAILABLE)) return;
            }
            const { share } = this.spans[0];
            let nanoseconds = 0;
            for (const span of this.spans.splice(0, count)) {
                nanoseconds += gl.getQueryParameter(span.query, gl.QUERY_RESULT) as number;
                this.free.push(span.query);
            }
            if (!disjoint) done(nanoseconds / 1e6, share);
        }
    }

    dispose(): void {
        const gl = this.gl;
        if (this.running) gl.endQuery(TIME_ELAPSED);
        for (const span of this.spans) gl.deleteQuery(span.query);
        for (const query of this.free) gl.deleteQuery(query);
        if (this.running) gl.deleteQuery(this.running.query);
        this.spans.length = 0;
        this.free.length = 0;
        this.running = null;
    }
}
