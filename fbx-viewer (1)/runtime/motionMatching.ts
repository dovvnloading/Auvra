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
export const TRAJECTORY_TIMES = [0.2, 0.5, 1.0] as const;
/** Seconds into the past the trajectory is described at: where the character has come from tells a start from a loop. */
export const HISTORY_TIMES = [0.2, 0.4] as const;
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
    /** Whether each foot (left, right) is planted on the ground at this moment (see footContacts). */
    contacts?: [boolean, boolean];
}

/** A clip as samples at SAMPLE_RATE, from its start to its end. */
export interface MotionClipSamples {
    name: string;
    loop: boolean;
    samples: MotionSample[];
}

/**
 * Feature layout: trajectory positions (x, z per time), trajectory facings (x, z per time), past
 * positions (x, z per history time), then pose.
 */
const TRAJECTORY_SIZE = TRAJECTORY_TIMES.length * 2;
const HISTORY_SIZE = HISTORY_TIMES.length * 2;
export const FEATURE_SIZE = TRAJECTORY_SIZE * 2 + HISTORY_SIZE + 6 + 6 + 3;
const POSITIONS = 0;
const FACINGS = TRAJECTORY_SIZE;
const PAST = TRAJECTORY_SIZE * 2;
const FEET = PAST + HISTORY_SIZE;
const FOOT_VELOCITIES = FEET + 6;
const HIPS_VELOCITY = FOOT_VELOCITIES + 6;

export interface MotionWeights {
    trajectoryPosition: number;
    trajectoryFacing: number;
    trajectoryPast: number;
    feet: number;
    footVelocity: number;
    hipsVelocity: number;
}

export const DEFAULT_MOTION_WEIGHTS: MotionWeights = { trajectoryPosition: 2, trajectoryFacing: 1.5, trajectoryPast: 0.6, feet: 0.6, footVelocity: 0.6, hipsVelocity: 0.8 };

/**
 * The least spread each group is scaled by, so a feature that hardly varies across the database (the
 * facing, when every clip goes straight) is not blown up past the rest: lengths and speeds in hips
 * heights (a second), directions as they are.
 */
const SPREAD_FLOOR = { trajectoryPosition: 0.1, trajectoryFacing: 0.2, trajectoryPast: 0.1, feet: 0.05, footVelocity: 0.25, hipsVelocity: 0.25 };
/** Seconds at the end of a clip that does not loop that matching never starts it at. */
export const END_MARGIN = 0.2;
/** Frames a search block holds (see MotionDatabase.search). */
const SEARCH_BLOCK = 16;
/**
 * The most a looping walk, run or strafe is steered round over the asked path (radians): a bend up to
 * this is the movement's to make; a sharper turn (turning round) is left to clips that turn.
 */
export const STEER_TURN = (100 * Math.PI) / 180;
/** A turn round that has this little (radians) left to turn of what is asked is let go to the next match. */
const TURN_ROUND_DONE = (20 * Math.PI) / 180;
/** A clip that travels and turns less than this over its length (radians) is steered by the movement. */
const STEERED_CLIP_TURN = Math.PI / 4;
/** A clip carrying the character slower than this many hips heights a second is standing still. */
const STANDING_SPEED = 0.1;
/** A clip whose root and feet move slower than STANDING_SPEED, turning slower than this (radians a second), is at rest. */
const REST_TURN = 0.2;

/**
 * The first sample from which a clip stays at rest to its end (a stop's last stance, a turn on the spot
 * that has finished), or its length when it is still moving at its end.
 */
export const restFrom = (clip: MotionClipSamples, body: number): number => {
    const samples = clip.samples;
    const reach = (STANDING_SPEED * body) / SAMPLE_RATE;
    const moved = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > reach;
    let rest = samples.length;
    for (let i = samples.length - 1; i > 0; i--) {
        const a = samples[i - 1], b = samples[i];
        if (moved(a.root, b.root) || moved(a.leftFoot, b.leftFoot) || moved(a.rightFoot, b.rightFoot)
            || Math.abs(b.facing - a.facing) > REST_TURN / SAMPLE_RATE) break;
        rest = i - 1;
    }
    return rest;
};

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
    if (at >= 0 && at < n) {
        const sample = clip.samples[at];
        return { root: sample.root, facing: sample.facing };
    }
    if (!clip.loop) {
        // Past either end of a clip that does not loop, the character carries on as it was moving there:
        // a stop that ends at rest stays put, a start that ends walking walks on. It keeps the facing it
        // ends with: a turn round that ends while still turning has turned round, not gone on spinning.
        const end = at < 0 ? 0 : n - 1;
        const next = at < 0 ? Math.min(1, n - 1) : Math.max(0, n - 2);
        const edge = clip.samples[end], inner = clip.samples[next];
        // Per sample, outward from that end.
        const dx = edge.root.x - inner.root.x, dz = edge.root.z - inner.root.z;
        const reach = at < 0 ? -at : at - end;
        return { root: { x: edge.root.x + dx * reach, y: edge.root.y, z: edge.root.z + dz * reach }, facing: edge.facing };
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
    HISTORY_TIMES.forEach((time, i) => {
        const past = rootAt(clip, index, -Math.round(time * SAMPLE_RATE));
        const at = toLocal(past.root, root, facing);
        out[PAST + i * 2] = at.x;
        out[PAST + i * 2 + 1] = at.z;
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
    private readonly blockLow: Float32Array;
    private readonly blockHigh: Float32Array;
    /** The hips' average height over the clips: the character's size, in the database's units. */
    readonly body: number;
    /**
     * Per clip, whether the movement steers it as it plays (see steadyTrajectory): one that travels and
     * keeps roughly to its line (a walk, a run, a strafe, a start or a stop, which often drift a little).
     * Its frames, and the path asked of them, are compared with the turning taken out; clips that stand
     * or turn round (on the spot, or a turn of 180 degrees) keep their turn, so they win when one is asked.
     */
    readonly steered: boolean[];
    /**
     * Per clip, whether it turns the character round as it plays: one that plays once and turns more than
     * a right angle (a turn of 180 degrees, walking or running). While one plays, the character turns
     * with it instead of by its movement, so the clip has the time it needs.
     */
    readonly turnsRound: boolean[];

    constructor(clips: MotionClipSamples[], weights: MotionWeights = DEFAULT_MOTION_WEIGHTS) {
        this.clips = clips.filter(clip => clip.samples.length > 1);
        const all = this.clips.flatMap(clip => clip.samples);
        const body = all.reduce((sum, sample) => sum + sample.hips.y - sample.root.y, 0) / Math.max(1, all.length) || 1;
        this.body = body;
        this.steered = this.clips.map(clip => this.clipSpeed(clip.name) > 0
            && Math.abs(clip.samples[clip.samples.length - 1].facing - clip.samples[0].facing) < STEERED_CLIP_TURN);
        this.turnsRound = this.clips.map(clip => !clip.loop
            && Math.abs(clip.samples[clip.samples.length - 1].facing - clip.samples[0].facing) > Math.PI / 2);
        const raw: Float32Array[] = [];
        const margin = Math.round(END_MARGIN * SAMPLE_RATE);
        this.clips.forEach((clip, c) => {
            this.clipStart.push(this.frames.length);
            // A clip that does not loop is not started in its last moments, as it would end at once, nor
            // where it has come to rest (a stop's last stance): standing still is for a looping idle.
            const n = clip.samples.length;
            const rest = clip.loop ? n : restFrom(clip, body);
            const usable = clip.loop ? n : Math.max(1, (rest - margin >= 1 ? rest : n) - margin);
            for (let i = 0; i < usable; i++) {
                this.frames.push({ clip: c, time: i / SAMPLE_RATE });
                raw.push(this.steered[c] ? steadyFeatures(frameFeatures(clip, i)) : frameFeatures(clip, i));
            }
        });
        // Each group scaled by its spread across the database (one scale per group, so directions keep their shape).
        const groups: Array<[number, number, number, number]> = [
            [POSITIONS, TRAJECTORY_SIZE, weights.trajectoryPosition, SPREAD_FLOOR.trajectoryPosition * body],
            [FACINGS, TRAJECTORY_SIZE, weights.trajectoryFacing, SPREAD_FLOOR.trajectoryFacing],
            [PAST, HISTORY_SIZE, weights.trajectoryPast, SPREAD_FLOOR.trajectoryPast * body],
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
        // Each block's least and greatest value of every feature, so a search passes over whole blocks
        // that cannot hold anything nearer than what it has found.
        const blocks = Math.ceil(this.frames.length / SEARCH_BLOCK);
        this.blockLow = new Float32Array(blocks * FEATURE_SIZE).fill(Infinity);
        this.blockHigh = new Float32Array(blocks * FEATURE_SIZE).fill(-Infinity);
        for (let f = 0; f < this.frames.length; f++) {
            const b = Math.floor(f / SEARCH_BLOCK) * FEATURE_SIZE;
            for (let k = 0; k < FEATURE_SIZE; k++) {
                const value = this.features[f * FEATURE_SIZE + k];
                if (value < this.blockLow[b + k]) this.blockLow[b + k] = value;
                if (value > this.blockHigh[b + k]) this.blockHigh[b + k] = value;
            }
        }
    }

    /** Scales and weights raw features in place (or into `out` at `offset`). */
    normalize(raw: Float32Array, out: Float32Array = raw, offset = 0): Float32Array {
        for (let k = 0; k < FEATURE_SIZE; k++) out[offset + k] = (raw[k] - this.mean[k]) * this.scale[k];
        return out;
    }

    /** Whether a clip (by name) loops; false for one not in the database. */
    loops(name: string): boolean {
        return this.clips.find(entry => entry.name === name)?.loop ?? false;
    }

    /** How fast a clip (by name) carries the character on average, in units a second; 0 for one standing still or not in the database. */
    clipSpeed(name: string): number {
        const clip = this.clips.find(entry => entry.name === name);
        if (!clip) return 0;
        const first = clip.samples[0].root, last = clip.samples[clip.samples.length - 1].root;
        const speed = Math.hypot(last.x - first.x, last.z - first.z) * SAMPLE_RATE / (clip.samples.length - 1);
        return speed < STANDING_SPEED * this.body ? 0 : speed;
    }

    /**
     * Which way and how fast a clip's root travels at a time, in the clip's own facing (the frame
     * features use: forward is +z), in units a second.
     */
    travelAt(clip: number, time: number): Vec2 {
        const entry = this.clips[clip];
        if (!entry) return { x: 0, z: 0 };
        const index = Math.max(0, Math.min(entry.samples.length - 1, Math.round(time * SAMPLE_RATE)));
        const before = rootAt(entry, index, -1), after = rootAt(entry, index, 1), now = rootAt(entry, index, 0);
        return localDirection((after.root.x - before.root.x) * SAMPLE_RATE / 2, (after.root.z - before.root.z) * SAMPLE_RATE / 2, now.facing);
    }

    /** The way a clip's root faces at a time (radians, unwrapped along the clip). */
    facingAt(clip: number, time: number): number {
        const entry = this.clips[clip];
        if (!entry) return 0;
        // Between samples, blended: frames come faster than samples, and a turn read sample by sample
        // would turn in steps (nothing one frame, twice as much the next).
        const at = Math.max(0, Math.min(entry.samples.length - 1, time * SAMPLE_RATE));
        const index = Math.floor(at);
        const share = at - index;
        const before = rootAt(entry, index, 0).facing;
        return share > 0 ? before + (rootAt(entry, index, 1).facing - before) * share : before;
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
        const raw = frameFeatures(this.clips[clip], Math.round(time * SAMPLE_RATE));
        return this.steered[clip] ? steadyFeatures(raw) : raw;
    }

    /**
     * Raw features of a clip at a time: the pose playing then, also in the moments no search starts at
     * (a clip that plays once, near its end or at rest).
     */
    poseAt(clip: number, time: number): Float32Array {
        const entry = this.clips[clip];
        const raw = frameFeatures(entry, Math.max(0, Math.min(entry.samples.length - 1, Math.round(time * SAMPLE_RATE))));
        return this.steered[clip] ? steadyFeatures(raw) : raw;
    }

    /**
     * The frame nearest `query` (normalized features), and its cost; `skip` frames are passed over. A
     * block of frames whose bounds are already further than the best found is passed over whole.
     */
    search(query: Float32Array, skip?: (frame: number) => boolean): { frame: number; cost: number } {
        let best = -1;
        let bestCost = Infinity;
        const features = this.features;
        const count = this.frames.length;
        for (let start = 0, block = 0; start < count; start += SEARCH_BLOCK, block++) {
            const b = block * FEATURE_SIZE;
            let bound = 0;
            for (let k = 0; k < FEATURE_SIZE && bound < bestCost; k++) {
                const q = query[k];
                const low = this.blockLow[b + k], high = this.blockHigh[b + k];
                const nearest = q < low ? low : q > high ? high : q;
                bound += (q - nearest) * (q - nearest);
            }
            if (bound >= bestCost) continue;
            const end = Math.min(count, start + SEARCH_BLOCK);
            for (let f = start; f < end; f++) {
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

/** Where the character is asked to go (and, when known, where it has been), in its own space and the database's units. */
export interface MotionTrajectory {
    /** At TRAJECTORY_TIMES. */
    positions: Vec2[];
    /** Radians turned from now, at TRAJECTORY_TIMES. */
    facings: number[];
    /** At HISTORY_TIMES ago; without them, the playing frame's own past is used. */
    past?: Vec2[];
}

/**
 * The query: the playing pose (a database frame, or a pose's raw features from poseAt, left as it is)
 * with the predicted trajectory, normalized.
 */
export const buildQuery = (database: MotionDatabase, playing: number | Float32Array | null, trajectory: MotionTrajectory): Float32Array => {
    const raw = typeof playing === 'number'
        ? (playing >= 0 ? database.rawFeatures(playing) : new Float32Array(FEATURE_SIZE))
        : playing ? Float32Array.from(playing) : new Float32Array(FEATURE_SIZE);
    trajectory.positions.forEach((position, i) => {
        raw[POSITIONS + i * 2] = position.x;
        raw[POSITIONS + i * 2 + 1] = position.z;
    });
    trajectory.past?.forEach((position, i) => {
        raw[PAST + i * 2] = position.x;
        raw[PAST + i * 2 + 1] = position.z;
    });
    trajectory.facings.forEach((facing, i) => {
        raw[FACINGS + i * 2] = Math.sin(facing);
        raw[FACINGS + i * 2 + 1] = Math.cos(facing);
    });
    return database.normalize(raw);
};

/**
 * The asked path with the movement's turning taken out, for clips the movement steers (a looping walk,
 * run or strafe). The character's facing comes from its movement, and a matched clip plays with its own
 * turn taken out, so such a clip follows any bend of the path while keeping its gait: what has to match
 * is how fast it goes, and which way relative to the way it faces, not how the path bends. Each stretch
 * of the path is turned back by the facing midway along it, and the facings ask for no turn. A path
 * bending round at walking pace becomes a straight walk; a sideways path with the facing held (aiming)
 * stays sideways; a stop stays a stop. Only up to STEER_TURN is taken out: turning further (turning
 * round) is still asked of the clip, so a clip that turns round wins there.
 */
export const steadyTrajectory = (trajectory: MotionTrajectory): MotionTrajectory => {
    const steer = (facing: number) => Math.max(-STEER_TURN, Math.min(STEER_TURN, facing));
    let x = 0, z = 0, fromX = 0, fromZ = 0, fromFacing = 0;
    const positions = trajectory.positions.map((position, i) => {
        const facing = trajectory.facings[i] ?? fromFacing;
        const leg = localDirection(position.x - fromX, position.z - fromZ, steer((fromFacing + facing) / 2));
        x += leg.x;
        z += leg.z;
        fromX = position.x;
        fromZ = position.z;
        fromFacing = facing;
        return { x, z };
    });
    return { positions, facings: trajectory.facings.map(facing => facing - steer(facing)), past: trajectory.past };
};

/** Raw features (a frame's or a query's) with their path steadied the same way (see steadyTrajectory). */
const steadyFeatures = (raw: Float32Array): Float32Array => {
    const steady = steadyTrajectory({
        positions: TRAJECTORY_TIMES.map((_, i) => ({ x: raw[POSITIONS + i * 2], z: raw[POSITIONS + i * 2 + 1] })),
        facings: TRAJECTORY_TIMES.map((_, i) => Math.atan2(raw[FACINGS + i * 2], raw[FACINGS + i * 2 + 1])),
    });
    steady.positions.forEach((position, i) => {
        raw[POSITIONS + i * 2] = position.x;
        raw[POSITIONS + i * 2 + 1] = position.z;
    });
    steady.facings.forEach((facing, i) => {
        raw[FACINGS + i * 2] = Math.sin(facing);
        raw[FACINGS + i * 2 + 1] = Math.cos(facing);
    });
    return raw;
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

/** The far end of the asked-for path moving this many hips heights since the last search searches at once... */
const SHARP_MOVE = 0.25;
/** ...as does the facing asked for there turning this far (radians). */
const SHARP_TURN = 0.5;

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
    /** Where the asked-for path ended at the last search, to notice a sharp change of mind. */
    private searchedFor: { x: number; z: number; facing: number } | null = null;

    constructor(readonly database: MotionDatabase, readonly options: MotionMatcherOptions = DEFAULT_MATCHER_OPTIONS) {}

    /**
     * Advances by `dt` toward the desired movement; returns what to play now. `trajectory`, when given, is
     * where the character's own movement says it will be at TRAJECTORY_TIMES (its space, the database's
     * units); otherwise one is predicted from the velocities.
     */
    step(dt: number, velocity: Vec2, desired: Vec2, desiredFacing: number, trajectory?: MotionTrajectory): MotionChoice {
        const db = this.database;
        // A clip that plays once and has played to its end cannot carry on: the best match elsewhere takes over now.
        let ended = false;
        if (this.clip >= 0) {
            const clip = db.clips[this.clip];
            const duration = clip.samples.length / SAMPLE_RATE;
            this.time += dt;
            if (clip.loop) this.time %= duration;
            else if (this.time >= duration - 1 / SAMPLE_RATE) {
                ended = true;
                this.sinceSearch = Infinity;
            }
        }
        this.sinceSearch += dt;
        let jumped = false;
        // A sharp change in what is asked for (a stick flicked round, a stop) is answered at once, not at the next search.
        const last = trajectory ? trajectory.positions.length - 1 : -1;
        const asked = last >= 0 ? { x: trajectory!.positions[last].x, z: trajectory!.positions[last].z, facing: trajectory!.facings[last] } : null;
        const sharp = !!asked && !!this.searchedFor && (
            Math.hypot(asked.x - this.searchedFor.x, asked.z - this.searchedFor.z) > SHARP_MOVE * db.body
            || Math.abs(asked.facing - this.searchedFor.facing) > SHARP_TURN);
        // A turn round once begun plays through: the character turns with it (its movement follows the clip's
        // turn), so a path predicted from the movement would always ask for a quicker turn and hop clips.
        // It is let go when the turn asked for goes the other way or is all but done.
        if (!ended && this.clip >= 0 && db.turnsRound[this.clip] && asked) {
            const clip = db.clips[this.clip];
            const left = db.facingAt(this.clip, clip.samples.length / SAMPLE_RATE) - db.facingAt(this.clip, this.time);
            if (Math.sign(left) === Math.sign(asked.facing) && Math.abs(asked.facing) > TURN_ROUND_DONE) {
                this.searchedFor = asked;
                return { clip: this.clip, time: this.time, jumped: false };
            }
        }
        if (this.sinceSearch >= this.options.searchInterval || this.clip < 0 || sharp) {
            this.sinceSearch = 0;
            this.searchedFor = asked;
            // The pose playing now, read from its clip (also in a play-once clip's last moments, which no search starts at).
            const pose = this.clip >= 0 ? db.poseAt(this.clip, this.time) : null;
            const path = trajectory ?? predictTrajectory(velocity, desired, desiredFacing);
            const query = buildQuery(db, pose, path);
            // Clips the movement steers are matched against the path with its turning taken out (see steadyTrajectory).
            const steadyQuery = buildQuery(db, pose, steadyTrajectory(path));
            // An ended clip is not gone back into: its frames would only replay its end.
            const playingClip = this.clip;
            const passed = (frame: number) => ended && db.frames[frame].clip === playingClip;
            const asIs = db.search(query, frame => passed(frame) || db.steered[db.frames[frame].clip]);
            const steadied = db.search(steadyQuery, frame => passed(frame) || !db.steered[db.frames[frame].clip]);
            const best = steadied.cost < asIs.cost ? steadied : asIs;
            // The query the playing clip is held to, carrying on.
            const own = this.clip >= 0 && db.steered[this.clip] ? steadyQuery : query;
            if (best.frame >= 0) {
                const candidate = db.frames[best.frame];
                // How far apart in the playing clip, the short way round a loop.
                let gap = Math.abs(candidate.time - this.time);
                if (this.clip >= 0 && db.clips[this.clip].loop) gap = Math.min(gap, db.clips[this.clip].samples.length / SAMPLE_RATE - gap);
                const near = !ended && candidate.clip === this.clip && gap <= this.options.sameWindow;
                let continuing = Infinity;
                if (pose && !ended) {
                    // Carrying on: the playing moment's own path against the one asked for.
                    const playing = db.normalize(pose);
                    continuing = 0;
                    for (let k = 0; k < FEATURE_SIZE; k++) continuing += (playing[k] - own[k]) ** 2;
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
