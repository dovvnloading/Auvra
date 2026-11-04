import { angleSpringAt, planarSpringAt, stepAngleSpring, wrapAngle, type PlanarSpring, type Spring1 } from './springs';

/**
 * HOW A CHARACTER MOVES
 *
 * Every character a controller moves (the player, an AI) keeps one of these: where it stands on the
 * ground, how fast it is going and which way it faces. Each frame its controller says what it wants
 * (a velocity and a facing) and springs carry the character toward it, so it speeds up, slows down and
 * turns smoothly at any frame rate. Held on what is wanted now, the same springs say where the character
 * will be in a moment; with the record of where it has been, that is its trajectory, which the
 * animation system reads to choose motion that carries the character there.
 *
 * World space: x and z on the ground, facing in radians about +Y with 0 looking along +Z (as a model's
 * rotation.y), distances in world units.
 */

export interface MovementSettings {
    /** Seconds the speed takes to close most of the gap to a faster target (a spring half-life). */
    accelerationHalfLife: number;
    /** The same when slowing down, stopping, turning across or turning back. */
    brakingHalfLife: number;
    /** Seconds the facing takes to close most of a turn. */
    turnHalfLife: number;
}

export const DEFAULT_MOVEMENT_SETTINGS: MovementSettings = { accelerationHalfLife: 0.1, brakingHalfLife: 0.05, turnHalfLife: 0.12 };

/** How often the past is recorded, a second. */
export const HISTORY_RATE = 30;
/** How far back the past is kept, seconds. */
export const HISTORY_SECONDS = 1.5;
const HISTORY_CAPACITY = Math.ceil(HISTORY_SECONDS * HISTORY_RATE) + 2;
/** time, x, z, facing, vx, vz */
const HISTORY_STRIDE = 6;

/** A point of a trajectory: where on the ground and which way facing. */
export interface TrajectoryPoint {
    x: number;
    z: number;
    facing: number;
}

/** A speed this close to the target counts as reaching it (units a second). */
const SPEED_TOLERANCE = 1e-3;
/** How quickly a facing turned from outside is predicted to stop turning, a second. */
const FREE_TURN_DECAY = 4;

export class CharacterMotion {
    settings: MovementSettings = { ...DEFAULT_MOVEMENT_SETTINGS };
    /** Position on the ground, velocity and acceleration. */
    readonly body: PlanarSpring = { x: 0, z: 0, vx: 0, vz: 0, ax: 0, az: 0 };
    /** Facing and how fast it turns (radians a second). */
    readonly facing: Spring1 = { x: 0, v: 0 };
    /** What the controller asks for: a velocity, and a facing (null: the facing is set directly, by a clip or a turn in place). */
    readonly goal = { vx: 0, vz: 0, facing: null as number | null };
    /** The half-lives the velocity and facing moved with on the last step, so a prediction moves the same way. */
    velocityHalfLife = DEFAULT_MOVEMENT_SETTINGS.accelerationHalfLife;
    turnHalfLife = DEFAULT_MOVEMENT_SETTINGS.turnHalfLife;
    /** Seconds since the motion began; what the history is timed by. */
    time = 0;
    /** Where the last step meant to take the character, and where it started from, to tell what the world allowed. */
    private readonly from = { x: 0, z: 0 };
    private readonly history = new Float64Array(HISTORY_CAPACITY * HISTORY_STRIDE);
    private historyCount = 0;
    private historyHead = 0;
    private nextRecord = 0;
    private readonly scratch: PlanarSpring = { x: 0, z: 0, vx: 0, vz: 0, ax: 0, az: 0 };

    /** Puts the character at rest at a place and facing (spawned, teleported, out of a vehicle); the past is forgotten. */
    place(x: number, z: number, facing: number): void {
        Object.assign(this.body, { x, z, vx: 0, vz: 0, ax: 0, az: 0 });
        this.facing.x = wrapAngle(facing);
        this.facing.v = 0;
        this.goal.vx = 0;
        this.goal.vz = 0;
        this.goal.facing = null;
        this.from.x = x;
        this.from.z = z;
        this.historyCount = 0;
        this.nextRecord = this.time;
    }

    /** Speed over the ground now. */
    get speed(): number {
        return Math.hypot(this.body.vx, this.body.vz);
    }

    /**
     * Moves the character `dt` seconds toward goal velocity (goalVx, goalVz) and returns the move it wants
     * this step, for the controller to try against the world (then `settle`). Speeding up toward the goal
     * follows the acceleration half-life; slowing, stopping or changing direction the braking one.
     */
    advance(goalVx: number, goalVz: number, dt: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
        const body = this.body;
        this.goal.vx = goalVx;
        this.goal.vz = goalVz;
        const speed = Math.hypot(body.vx, body.vz);
        const goalSpeed = Math.hypot(goalVx, goalVz);
        // Within 60 degrees of where it is going and faster: it accelerates. Otherwise it brakes into the change.
        const along = body.vx * goalVx + body.vz * goalVz;
        const speedingUp = goalSpeed > speed + SPEED_TOLERANCE && (speed < SPEED_TOLERANCE || along >= 0.5 * speed * goalSpeed);
        this.velocityHalfLife = speedingUp ? this.settings.accelerationHalfLife : this.settings.brakingHalfLife;
        this.from.x = body.x;
        this.from.z = body.z;
        planarSpringAt(body, goalVx, goalVz, this.velocityHalfLife, Math.max(0, dt), body);
        out.x = body.x - this.from.x;
        out.z = body.z - this.from.z;
        return out;
    }

    /**
     * Moves the character by `moveX, moveZ` over `dt` seconds instead of by its springs (a clip's root
     * motion): its velocity becomes that move's, so the springs carry on from it afterwards.
     */
    drive(moveX: number, moveZ: number, dt: number): void {
        const body = this.body;
        this.from.x = body.x;
        this.from.z = body.z;
        body.x += moveX;
        body.z += moveZ;
        if (dt > 0) {
            const vx = moveX / dt, vz = moveZ / dt;
            body.ax = (vx - body.vx) / dt;
            body.az = (vz - body.vz) / dt;
            body.vx = vx;
            body.vz = vz;
        }
        this.goal.vx = body.vx;
        this.goal.vz = body.vz;
    }

    /**
     * Where the world let the character go this step (after collisions, steps and slopes). The velocity
     * is left alone: slowed by a step or a slope, the character keeps pressing on and climbs it.
     */
    settle(x: number, z: number): void {
        this.body.x = x;
        this.body.z = z;
    }

    /**
     * The character ran into a wall facing (normalX, normalZ) (unit, pointing out of the wall): the part
     * of its velocity and acceleration going into the wall is dropped, so it slides along the wall rather
     * than building up speed against it, and its predicted path runs along the wall.
     */
    blockAgainst(normalX: number, normalZ: number): void {
        const body = this.body;
        const into = body.vx * normalX + body.vz * normalZ;
        if (into < 0) {
            body.vx -= into * normalX;
            body.vz -= into * normalZ;
        }
        const pushing = body.ax * normalX + body.az * normalZ;
        if (pushing < 0) {
            body.ax -= pushing * normalX;
            body.az -= pushing * normalZ;
        }
    }

    /** Turns `dt` seconds toward `goal` with this half-life (the settings' when left out); returns the facing. */
    turnToward(goal: number, dt: number, halfLife = this.settings.turnHalfLife): number {
        this.goal.facing = wrapAngle(goal);
        this.turnHalfLife = halfLife;
        stepAngleSpring(this.facing, this.goal.facing, halfLife, Math.max(0, dt));
        return this.facing.x;
    }

    /** Turns by `angle` radians over `dt` seconds, set from outside (a turn clip, a capped turn in place); returns the facing. */
    turnBy(angle: number, dt: number): number {
        this.facing.x = wrapAngle(this.facing.x + angle);
        this.facing.v = dt > 0 ? angle / dt : 0;
        return this.facing.x;
    }

    /** Ends a frame: the time moves on and the past is recorded at HISTORY_RATE. */
    record(dt: number): void {
        this.time += Math.max(0, dt);
        if (this.time + 1e-9 < this.nextRecord) return;
        this.nextRecord = this.time + 1 / HISTORY_RATE;
        const at = this.historyHead * HISTORY_STRIDE;
        const h = this.history;
        h[at] = this.time;
        h[at + 1] = this.body.x;
        h[at + 2] = this.body.z;
        h[at + 3] = this.facing.x;
        h[at + 4] = this.body.vx;
        h[at + 5] = this.body.vz;
        this.historyHead = (this.historyHead + 1) % HISTORY_CAPACITY;
        this.historyCount = Math.min(HISTORY_CAPACITY, this.historyCount + 1);
    }

    /**
     * Where the character will be `t` seconds from now, holding what it is asked for now. The facing is
     * unwrapped from the present one, so a turn reads as one continuous angle.
     */
    predict(t: number, out: TrajectoryPoint = { x: 0, z: 0, facing: 0 }): TrajectoryPoint {
        const at = planarSpringAt(this.body, this.goal.vx, this.goal.vz, this.velocityHalfLife, Math.max(0, t), this.scratch);
        out.x = at.x;
        out.z = at.z;
        // A facing set directly carries on turning at its present rate, easing off.
        out.facing = this.goal.facing === null
            ? this.facing.x + this.facing.v * (1 - Math.exp(-FREE_TURN_DECAY * Math.max(0, t))) / FREE_TURN_DECAY
            : angleSpringAt(this.facing, this.goal.facing, this.turnHalfLife, Math.max(0, t)).x;
        return out;
    }

    /**
     * Where the character was `t` seconds ago (t > 0), from the recorded past, between records by
     * interpolation; further back than the record reaches, its oldest point. The present when there is no record.
     */
    past(t: number, out: TrajectoryPoint = { x: 0, z: 0, facing: 0 }): TrajectoryPoint {
        const when = this.time - Math.max(0, t);
        out.x = this.body.x;
        out.z = this.body.z;
        out.facing = this.facing.x;
        if (!this.historyCount) return out;
        const h = this.history;
        const index = (k: number) => (((this.historyHead - 1 - k) % HISTORY_CAPACITY) + HISTORY_CAPACITY) % HISTORY_CAPACITY * HISTORY_STRIDE;
        // Newest first: the first record at or before `when`, and the one after it (or the present).
        let laterTime = this.time, laterX = this.body.x, laterZ = this.body.z, laterFacing = this.facing.x;
        for (let k = 0; k < this.historyCount; k++) {
            const at = index(k);
            if (h[at] <= when) {
                const span = laterTime - h[at];
                const blend = span > 1e-9 ? (when - h[at]) / span : 0;
                out.x = h[at + 1] + (laterX - h[at + 1]) * blend;
                out.z = h[at + 2] + (laterZ - h[at + 2]) * blend;
                out.facing = h[at + 3] + wrapAngle(laterFacing - h[at + 3]) * blend;
                return out;
            }
            laterTime = h[at];
            laterX = h[at + 1];
            laterZ = h[at + 2];
            laterFacing = h[at + 3];
        }
        out.x = laterX;
        out.z = laterZ;
        out.facing = laterFacing;
        return out;
    }
}

/**
 * A world point seen from a character standing at (x, z) facing `facing`, divided by `scale` (to put it
 * in a model's own units): the same frame motion matching describes clips in (forward is +z).
 */
export const toCharacterSpace = (pointX: number, pointZ: number, x: number, z: number, facing: number, scale = 1): { x: number; z: number } => {
    const dx = (pointX - x) / scale, dz = (pointZ - z) / scale;
    const c = Math.cos(facing), s = Math.sin(facing);
    return { x: dx * c - dz * s, z: dx * s + dz * c };
};

/** The motion of each character a controller moves, by its model. */
const motions = new WeakMap<object, CharacterMotion>();

/** The movement state of the character drawn by `model`, made the first time it is asked for. */
export const characterMotionOf = (model: object): CharacterMotion => {
    let motion = motions.get(model);
    if (!motion) {
        motion = new CharacterMotion();
        motions.set(model, motion);
    }
    return motion;
};

/** The movement state of a character a controller moves, or undefined when nothing moves it (a preview, a prop). */
export const findCharacterMotion = (model: object): CharacterMotion | undefined => motions.get(model);
