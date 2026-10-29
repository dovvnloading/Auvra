/**
 * MOTION MATCHING
 *
 * Instead of a state machine choosing clips, the character plays whichever moment of its locomotion
 * clips best continues what it is doing now toward where it is asked to go. Every clip is sampled
 * into a database of frames, each described by features in the character's own space:
 *  - where the character will be and which way it will face a little into the future (its trajectory);
 *  - where its feet are and how they move, and how its hips move (its pose).
 * Each search builds the same features from the frame playing now (its pose) and from the desired
 * movement (a trajectory predicted from the current and wanted velocity), and takes the database frame
 * nearest to them. A frame close to the one already playing is kept, so playback only jumps when a
 * better continuation exists, and then crossfades.
 *
 * Features are scaled by their spread across the database and weighted by group, so trajectory and
 * pose count as much as asked whatever their units.
 */

export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }

/** Seconds into the future the trajectory is described at. */
export const TRAJECTORY_TIMES = [0.2, 0.4, 0.6] as const;
/** Frames per second clips are sampled at. */
export const SAMPLE_RATE = 30;

/** One sampled moment of a clip, in world (clip) space: what features are built from. */
export interface MotionSample {
    /** The character's root on the ground (hips projected down) and the way it faces (radians about +Y; 0 faces +Z). */
    root: Vec3;
    facing: number;
    leftFoot: Vec3;
    rightFoot: Vec3;
    hips: Vec3;
}

/** A clip as samples at SAMPLE_RATE, from its start to its end. */
export interface MotionClipSamples {
    name: string;
    loop: boolean;
    samples: MotionSample[];
}

/** Feature layout: trajectory positions (x, z per time), trajectory facings (x, z per time), then pose. */
const TRAJECTORY_SIZE = TRAJECTORY_TIMES.length * 2;
export const FEATURE_SIZE = TRAJECTORY_SIZE * 2 + 6 + 6 + 3;
const POSITIONS = 0;
const FACINGS = TRAJECTORY_SIZE;
const FEET = TRAJECTORY_SIZE * 2;
const FOOT_VELOCITIES = FEET + 6;
const HIPS_VELOCITY = FOOT_VELOCITIES + 6;

export interface MotionWeights {
    trajectoryPosition: number;
    trajectoryFacing: number;
    feet: number;
    footVelocity: number;
    hipsVelocity: number;
}

export const DEFAULT_MOTION_WEIGHTS: MotionWeights = { trajectoryPosition: 2, trajectoryFacing: 1.5, feet: 0.6, footVelocity: 0.6, hipsVelocity: 0.8 };

/**
 * The least spread each group is scaled by, so a feature that hardly varies across the database (the
 * facing, when every clip goes straight) is not blown up past the rest: lengths and speeds in hips
 * heights (a second), directions as they are.
 */
const SPREAD_FLOOR = { trajectoryPosition: 0.1, trajectoryFacing: 0.2, feet: 0.05, footVelocity: 0.25, hipsVelocity: 0.25 };
/** A clip carrying the character slower than this many hips heights a second is standing still. */
const STANDING_SPEED = 0.1;

/** Into the space of a character at `root` facing `facing`: x to its right... */
const toLocal = (point: Vec3, root: Vec3, facing: number): Vec3 => {
    const dx = point.x - root.x, dz = point.z - root.z;
    const c = Math.cos(facing), s = Math.sin(facing);
    // Facing 0 looks along +Z; turning by `facing` about +Y, the local frame is that turned back.
    return { x: dx * c - dz * s, y: point.y - root.y, z: dx * s + dz * c };
};

const localDirection = (x: number, z: number, facing: number): Vec2 => {
    const c = Math.cos(facing), s = Math.sin(facing);
    return { x: x * c - z * s, z: x * s + z * c };
};

/** The sample `offset` frames after `index`, wrapping round a looping clip and holding at the end of one that does not. */
const sampleAt = (clip: MotionClipSamples, index: number, offset: number): MotionSample => {
    const n = clip.samples.length;
    const at = index + offset;
    if (clip.loop) return clip.samples[((at % n) + n) % n];
    return clip.samples[Math.max(0, Math.min(n - 1, at))];
};

/**
 * A looping clip's root keeps going round: a later sample past the end is the wrapped one moved on by
 * the whole clip's travel, so a trajectory across the loop point is continuous.
 */
const rootAt = (clip: MotionClipSamples, index: number, offset: number): { root: Vec3; facing: number } => {
    const n = clip.samples.length;
    const at = index + offset;
    if (!clip.loop || (at >= 0 && at < n)) {
        const sample = sampleAt(clip, index, offset);
        return { root: sample.root, facing: sample.facing };
    }
    const laps = Math.floor(at / n);
    const sample = clip.samples[((at % n) + n) % n];
    const first = clip.samples[0], last = clip.samples[n - 1];
    // One lap's travel, from the first sample to one past the last.
    const step = n > 1 ? { x: (last.root.x - first.root.x) * n / (n - 1), z: (last.root.z - first.root.z) * n / (n - 1) } : { x: 0, z: 0 };
    const turn = n > 1 ? (last.facing - first.facing) * n / (n - 1) : 0;
    return { root: { x: sample.root.x + step.x * laps, y: sample.root.y, z: sample.root.z + step.z * laps }, facing: sample.facing + turn * laps };
};

/** The raw (unscaled) features of a clip's frame. */
export const frameFeatures = (clip: MotionClipSamples, index: number, out = new Float32Array(FEATURE_SIZE)): Float32Array => {
    const now = clip.samples[index];
    const { root, facing } = rootAt(clip, index, 0);
    TRAJECTORY_TIMES.forEach((time, i) => {
        const future = rootAt(clip, index, Math.round(time * SAMPLE_RATE));
        const at = toLocal(future.root, root, facing);
        out[POSITIONS + i * 2] = at.x;
        out[POSITIONS + i * 2 + 1] = at.z;
        const turn = localDirection(Math.sin(future.facing), Math.cos(future.facing), facing);
        out[FACINGS + i * 2] = turn.x;
        out[FACINGS + i * 2 + 1] = turn.z;
    });
    const previous = sampleAt(clip, index, -1);
    const previousRoot = rootAt(clip, index, -1);
    // Across a loop's seam the previous sample is the last one, a lap behind: moved on by the lap's travel.
    const lapX = previousRoot.root.x - previous.root.x, lapZ = previousRoot.root.z - previous.root.z;
    const feet = [[now.leftFoot, previous.leftFoot], [now.rightFoot, previous.rightFoot]] as const;
    feet.forEach(([foot, before], i) => {
        const at = toLocal(foot, now.hips, facing);
        out[FEET + i * 3] = at.x;
        out[FEET + i * 3 + 1] = foot.y - root.y;
        out[FEET + i * 3 + 2] = at.z;
        const velocity = localDirection((foot.x - before.x - lapX) * SAMPLE_RATE, (foot.z - before.z - lapZ) * SAMPLE_RATE, facing);
        out[FOOT_VELOCITIES + i * 3] = velocity.x;
        out[FOOT_VELOCITIES + i * 3 + 1] = (foot.y - before.y) * SAMPLE_RATE;
        out[FOOT_VELOCITIES + i * 3 + 2] = velocity.z;
    });
    const hips = localDirection((now.root.x - previousRoot.root.x) * SAMPLE_RATE, (now.root.z - previousRoot.root.z) * SAMPLE_RATE, facing);
    out[HIPS_VELOCITY] = hips.x;
    out[HIPS_VELOCITY + 1] = (now.hips.y - previous.hips.y) * SAMPLE_RATE;
    out[HIPS_VELOCITY + 2] = hips.z;
    return out;
};

/** A frame in the database: which clip, at what time. */
export interface MotionFrame {
    clip: number;
    time: number;
}

export class MotionDatabase {
    readonly clips: MotionClipSamples[];
    readonly frames: MotionFrame[] = [];
    /** Every frame's features, scaled and weighted, FEATURE_SIZE floats each. */
    readonly features: Float32Array;
    private readonly mean = new Float32Array(FEATURE_SIZE);
    private readonly scale = new Float32Array(FEATURE_SIZE);
    private readonly clipStart: number[] = [];
    /** The hips' average height over the clips: the character's size, in the database's units. */
    readonly body: number;

    constructor(clips: MotionClipSamples[], weights: MotionWeights = DEFAULT_MOTION_WEIGHTS) {
        this.clips = clips.filter(clip => clip.samples.length > 1);
        const raw: Float32Array[] = [];
        this.clips.forEach((clip, c) => {
            this.clipStart.push(this.frames.length);
            // A clip that does not loop needs its trajectory: its last frames cannot see ahead.
            const usable = clip.loop ? clip.samples.length : Math.max(1, clip.samples.length - Math.round(TRAJECTORY_TIMES[TRAJECTORY_TIMES.length - 1] * SAMPLE_RATE));
            for (let i = 0; i < usable; i++) {
                this.frames.push({ clip: c, time: i / SAMPLE_RATE });
                raw.push(frameFeatures(clip, i));
            }
        });
        // Each group scaled by its spread across the database (one scale per group, so directions keep their shape).
        const all = this.clips.flatMap(clip => clip.samples);
        const body = all.reduce((sum, sample) => sum + sample.hips.y - sample.root.y, 0) / Math.max(1, all.length) || 1;
        this.body = body;
        const groups: Array<[number, number, number, number]> = [
            [POSITIONS, TRAJECTORY_SIZE, weights.trajectoryPosition, SPREAD_FLOOR.trajectoryPosition * body],
            [FACINGS, TRAJECTORY_SIZE, weights.trajectoryFacing, SPREAD_FLOOR.trajectoryFacing],
            [FEET, 6, weights.feet, SPREAD_FLOOR.feet * body],
            [FOOT_VELOCITIES, 6, weights.footVelocity, SPREAD_FLOOR.footVelocity * body],
            [HIPS_VELOCITY, 3, weights.hipsVelocity, SPREAD_FLOOR.hipsVelocity * body],
        ];
        const count = Math.max(1, raw.length);
        for (const features of raw) for (let k = 0; k < FEATURE_SIZE; k++) this.mean[k] += features[k] / count;
        for (const [start, size, weight, floor] of groups) {
            let variance = 0;
            for (const features of raw) for (let k = start; k < start + size; k++) variance += (features[k] - this.mean[k]) ** 2;
            const spread = Math.max(floor, Math.sqrt(variance / (count * size))) || 1;
            for (let k = start; k < start + size; k++) this.scale[k] = weight / spread;
        }
        this.features = new Float32Array(raw.length * FEATURE_SIZE);
        raw.forEach((features, f) => this.normalize(features, this.features, f * FEATURE_SIZE));
    }

    /** Scales and weights raw features in place (or into `out` at `offset`). */
    normalize(raw: Float32Array, out: Float32Array = raw, offset = 0): Float32Array {
        for (let k = 0; k < FEATURE_SIZE; k++) out[offset + k] = (raw[k] - this.mean[k]) * this.scale[k];
        return out;
    }

    /** How fast a clip (by name) carries the character on average, in units a second; 0 for one standing still or not in the database. */
    clipSpeed(name: string): number {
        const clip = this.clips.find(entry => entry.name === name);
        if (!clip) return 0;
        const first = clip.samples[0].root, last = clip.samples[clip.samples.length - 1].root;
        const speed = Math.hypot(last.x - first.x, last.z - first.z) * SAMPLE_RATE / (clip.samples.length - 1);
        return speed < STANDING_SPEED * this.body ? 0 : speed;
    }

    /** The database frame of a clip nearest a time, or -1. */
    frameOf(clip: number, time: number): number {
        if (clip < 0 || clip >= this.clips.length) return -1;
        const start = this.clipStart[clip];
        const end = clip + 1 < this.clipStart.length ? this.clipStart[clip + 1] : this.frames.length;
        const index = start + Math.round(time * SAMPLE_RATE);
        return end > start ? Math.max(start, Math.min(end - 1, index)) : -1;
    }

    /** Raw features of a database frame (the pose to continue from). */
    rawFeatures(frame: number): Float32Array {
        const { clip, time } = this.frames[frame];
        return frameFeatures(this.clips[clip], Math.round(time * SAMPLE_RATE));
    }

    /** The frame nearest `query` (normalized features), and its cost; `skip` frames are passed over. */
    search(query: Float32Array, skip?: (frame: number) => boolean): { frame: number; cost: number } {
        let best = -1;
        let bestCost = Infinity;
        const features = this.features;
        for (let f = 0; f < this.frames.length; f++) {
            if (skip?.(f)) continue;
            let cost = 0;
            const base = f * FEATURE_SIZE;
            for (let k = 0; k < FEATURE_SIZE && cost < bestCost; k++) {
                const d = features[base + k] - query[k];
                cost += d * d;
            }
            if (cost < bestCost) {
                bestCost = cost;
                best = f;
            }
        }
        return { frame: best, cost: bestCost };
    }
}

/**
 * Where a character moving at `velocity` (m/s, its own space) will be, and which way it will face,
 * at each trajectory time, easing toward `desired` velocity and `desiredFacing` (radians relative to
 * now) with a critically damped spring of `halfLife` seconds.
 */
export const predictTrajectory = (velocity: Vec2, desired: Vec2, desiredFacing: number, halfLife = 0.25): { positions: Vec2[]; facings: number[] } => {
    const y = (4 * Math.LN2) / Math.max(1e-4, halfLife) / 2;
    const positions: Vec2[] = [];
    const facings: number[] = [];
    for (const t of TRAJECTORY_TIMES) {
        // Critically damped spring on velocity toward `desired`: its integral is the position.
        const decay = Math.exp(-y * t);
        const j0x = velocity.x - desired.x, j0z = velocity.z - desired.z;
        const j1x = j0x * y, j1z = j0z * y;
        const reach = (j0: number, j1: number) => (1 - decay) * j0 / y + (j1 / (y * y)) * (1 - decay - y * t * decay);
        positions.push({ x: desired.x * t + reach(j0x, j1x), z: desired.z * t + reach(j0z, j1z) });
        facings.push(desiredFacing * (1 - Math.exp(-y * t * 1.5)));
    }
    return { positions, facings };
};

/** The query: the playing frame's pose with the predicted trajectory, normalized. */
export const buildQuery = (database: MotionDatabase, playingFrame: number, trajectory: { positions: Vec2[]; facings: number[] }): Float32Array => {
    const raw = playingFrame >= 0 ? database.rawFeatures(playingFrame) : new Float32Array(FEATURE_SIZE);
    trajectory.positions.forEach((position, i) => {
        raw[POSITIONS + i * 2] = position.x;
        raw[POSITIONS + i * 2 + 1] = position.z;
    });
    trajectory.facings.forEach((facing, i) => {
        raw[FACINGS + i * 2] = Math.sin(facing);
        raw[FACINGS + i * 2 + 1] = Math.cos(facing);
    });
    return database.normalize(raw);
};

export interface MotionMatcherOptions {
    /** Seconds between searches. */
    searchInterval: number;
    /** A frame within this many seconds of the playing one, in the same clip, is no jump. */
    sameWindow: number;
    /** A jump must cost this much less (a share) than continuing... */
    switchMargin: number;
    /** ...and at least this much less outright, so frames nearly as good (a character standing still) do not trade places. */
    switchCost: number;
}

export const DEFAULT_MATCHER_OPTIONS: MotionMatcherOptions = { searchInterval: 0.1, sameWindow: 0.25, switchMargin: 0.1, switchCost: 1 };

/** What to play: a clip at a time, and whether to crossfade to it (a jump) or keep going. */
export interface MotionChoice {
    clip: number;
    time: number;
    jumped: boolean;
}

/**
 * Plays a database by matching: advance with the clip, search every so often, and jump when a frame
 * elsewhere continues the motion better than carrying on.
 */
export class MotionMatcher {
    clip = -1;
    time = 0;
    private sinceSearch = Infinity;

    constructor(readonly database: MotionDatabase, readonly options: MotionMatcherOptions = DEFAULT_MATCHER_OPTIONS) {}

    /** Advances by `dt` toward the desired movement; returns what to play now. */
    step(dt: number, velocity: Vec2, desired: Vec2, desiredFacing: number): MotionChoice {
        const db = this.database;
        if (this.clip >= 0) {
            const clip = db.clips[this.clip];
            const duration = clip.samples.length / SAMPLE_RATE;
            this.time += dt;
            if (clip.loop) this.time %= duration;
            else if (this.time >= duration - 1 / SAMPLE_RATE) this.sinceSearch = Infinity;
        }
        this.sinceSearch += dt;
        let jumped = false;
        if (this.sinceSearch >= this.options.searchInterval || this.clip < 0) {
            this.sinceSearch = 0;
            const playing = this.clip >= 0 ? db.frameOf(this.clip, this.time) : -1;
            const query = buildQuery(db, playing, predictTrajectory(velocity, desired, desiredFacing));
            const best = db.search(query);
            if (best.frame >= 0) {
                const candidate = db.frames[best.frame];
                // How far apart in the playing clip, the short way round a loop.
                let gap = Math.abs(candidate.time - this.time);
                if (this.clip >= 0 && db.clips[this.clip].loop) gap = Math.min(gap, db.clips[this.clip].samples.length / SAMPLE_RATE - gap);
                const near = candidate.clip === this.clip && gap <= this.options.sameWindow;
                let continuing = Infinity;
                if (playing >= 0) {
                    const base = playing * FEATURE_SIZE;
                    continuing = 0;
                    for (let k = 0; k < FEATURE_SIZE; k++) continuing += (db.features[base + k] - query[k]) ** 2;
                }
                if (!near && best.cost < continuing * (1 - this.options.switchMargin) - this.options.switchCost) {
                    this.clip = candidate.clip;
                    this.time = candidate.time;
                    jumped = true;
                }
            }
        }
        return { clip: this.clip, time: this.time, jumped };
    }
}
