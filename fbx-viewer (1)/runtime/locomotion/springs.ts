/**
 * CRITICALLY DAMPED SPRINGS
 *
 * The movement model is built from springs that never overshoot and are exact for any step, so a
 * character moves the same at 30 or 144 frames a second, and a prediction of where it will be is the
 * same formula evaluated further ahead rather than a simulation run forward.
 *
 * A half-life says how quickly a spring closes a gap: larger is lazier. It sets the decay rate y of
 * e^(-y t), with y = 2 ln 2 / halfLife.
 */

const EPSILON = 1e-5;

/** The decay rate of a critically damped spring with this half-life (seconds). */
export const springDecay = (halfLife: number): number => (2 * Math.LN2) / (Math.max(0, halfLife) + EPSILON);

/** `angle` wrapped into -PI..PI. */
export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A value and its rate of change. */
export interface Spring1 {
    x: number;
    v: number;
}

/** Moves a spring `dt` seconds toward `goal`, in place. */
export const stepSpring = (spring: Spring1, goal: number, halfLife: number, dt: number): Spring1 => {
    const y = springDecay(halfLife);
    const j0 = spring.x - goal;
    const j1 = spring.v + j0 * y;
    const decay = Math.exp(-y * dt);
    spring.x = decay * (j0 + j1 * dt) + goal;
    spring.v = decay * (spring.v - j1 * y * dt);
    return spring;
};

/** Moves an angle spring `dt` seconds toward `goal` the short way round, in place; the angle stays within -PI..PI. */
export const stepAngleSpring = (spring: Spring1, goal: number, halfLife: number, dt: number): Spring1 => {
    const y = springDecay(halfLife);
    const j0 = wrapAngle(spring.x - goal);
    const j1 = spring.v + j0 * y;
    const decay = Math.exp(-y * dt);
    spring.x = wrapAngle(decay * (j0 + j1 * dt) + goal);
    spring.v = decay * (spring.v - j1 * y * dt);
    return spring;
};

/** Where an angle spring will be `t` seconds on, holding its goal: the angle (unwrapped from its present one) and its rate. */
export const angleSpringAt = (spring: Readonly<Spring1>, goal: number, halfLife: number, t: number): Spring1 => {
    const y = springDecay(halfLife);
    const j0 = wrapAngle(spring.x - goal);
    const j1 = spring.v + j0 * y;
    const decay = Math.exp(-y * t);
    // Measured from the present angle, so a prediction does not jump across -PI..PI.
    return { x: spring.x - j0 + decay * (j0 + j1 * t), v: decay * (spring.v - j1 * y * t) };
};

/**
 * A point on the ground moving under a spring on its velocity: position, velocity and acceleration
 * change together toward a goal velocity, with no jump in any of them when the goal changes.
 */
export interface PlanarSpring {
    x: number;
    z: number;
    vx: number;
    vz: number;
    ax: number;
    az: number;
}

const advanceAxis = (x: number, v: number, a: number, goal: number, y: number, t: number): [number, number, number] => {
    const j0 = v - goal;
    const j1 = a + j0 * y;
    const decay = Math.exp(-y * t);
    const position = decay * ((-j1) / (y * y) + (-j0 - j1 * t) / y) + j1 / (y * y) + j0 / y + goal * t + x;
    const velocity = decay * (j0 + j1 * t) + goal;
    const acceleration = decay * (a - j1 * y * t);
    return [position, velocity, acceleration];
};

/** `spring` moved `t` seconds on toward goal velocity (goalX, goalZ), into `out` (which may be `spring` itself). */
export const planarSpringAt = (
    spring: Readonly<PlanarSpring>, goalX: number, goalZ: number, halfLife: number, t: number, out: PlanarSpring,
): PlanarSpring => {
    const y = springDecay(halfLife);
    const [x, vx, ax] = advanceAxis(spring.x, spring.vx, spring.ax, goalX, y, t);
    const [z, vz, az] = advanceAxis(spring.z, spring.vz, spring.az, goalZ, y, t);
    out.x = x; out.z = z; out.vx = vx; out.vz = vz; out.ax = ax; out.az = az;
    return out;
};

/** How far a planar spring travels before it settles at rest from velocity `speed` with no acceleration: speed × halfLife / ln 2. */
export const stoppingDistance = (speed: number, halfLife: number): number => (2 * speed) / springDecay(halfLife);
