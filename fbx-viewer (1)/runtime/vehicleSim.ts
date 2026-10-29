/**
 * VEHICLE SIMULATION
 *
 * The physics of a wheeled vehicle the way driving games model it, free of React and of the physics
 * engine so every piece can be tested on its own. The vehicle component casts each wheel down its
 * suspension, feeds the contact into these functions and applies the forces they return to the
 * chassis body.
 *
 * - Tyres: Pacejka's "magic formula" for the force against slip ratio (wheel spin or lock) and slip
 *   angle (sliding sideways), combined through a friction circle so a tyre that brakes or drives
 *   hard has less left for cornering, with load sensitivity (a heavily loaded tyre grips a little
 *   less per newton) and a low-speed floor so a car at rest does not jitter.
 * - Wheels: each spins with its own inertia under drive, brake and tyre torque, solved implicitly in
 *   the tyre's slip, so wheels spin up on a launch and lock under hard braking.
 * - Engine and drivetrain: a torque curve sized from the engine's power, engine braking and a rev
 *   limiter, a gearbox whose ratios reach the top speed at the redline in top gear, automatic shifts
 *   that cut the drive for a moment, a slipping clutch at launch, and an open, limited-slip or locked
 *   differential between the driven wheels.
 * - Assists: ABS lets off a locking wheel's brake, traction control trims the throttle while a
 *   driven wheel spins, stability control brakes a single wheel to stop a slide.
 */

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

export interface MagicCurve {
    /** Stiffness. */
    B: number;
    /** Shape. */
    C: number;
    /** Curvature. */
    E: number;
}

/** Longitudinal curve: peaks near 12% slip, about two thirds of the peak once locked or spinning. */
export const LONGITUDINAL_CURVE: MagicCurve = { B: 11, C: 1.65, E: 0.2 };
/** Lateral curve, in radians of slip angle: peaks near 10 degrees, holding most of it in a slide. */
export const LATERAL_CURVE: MagicCurve = { B: 12, C: 1.35, E: -0.2 };

/** Pacejka's magic formula, normalised to a peak of 1. */
export const magicFormula = (x: number, c: MagicCurve): number =>
    Math.sin(c.C * Math.atan(c.B * x - c.E * (c.B * x - Math.atan(c.B * x))));

const peakSlip = (curve: MagicCurve): number => {
    let best = 0;
    let at = 0;
    for (let x = 0.0005; x < 1.5; x += 0.0005) {
        const y = magicFormula(x, curve);
        if (y > best) {
            best = y;
            at = x;
        }
    }
    return at;
};

/** Slip ratio and slip angle (radians) at which each curve peaks. */
export const PEAK_SLIP_RATIO = peakSlip(LONGITUDINAL_CURVE);
export const PEAK_SLIP_ANGLE = peakSlip(LATERAL_CURVE);

/** Below this speed (m/s) slip is measured against it instead, so a tyre at rest has no infinite slip. */
export const SLIP_SPEED_FLOOR = 1.5;
/** How much a tyre's grip per newton drops as its load rises over its share at rest. */
export const LOAD_SENSITIVITY = 0.12;

/** (wheel surface speed - ground speed) / ground speed: positive spinning, -1 locked. */
export const slipRatio = (wheelSpeed: number, groundSpeed: number): number =>
    (wheelSpeed - groundSpeed) / Math.max(Math.abs(groundSpeed), SLIP_SPEED_FLOOR);

/** Angle between where the wheel points and where its contact moves (radians, positive sliding to its left). */
export const slipAngle = (longitudinal: number, lateral: number): number =>
    Math.atan2(lateral, Math.max(Math.abs(longitudinal), SLIP_SPEED_FLOOR));

export interface TyreForce {
    /** Along the wheel's heading, N (positive forward). */
    fx: number;
    /** Across it, N (positive to the wheel's left). */
    fy: number;
}

/** Peak friction force of a tyre: grip times load, a little less per newton as the load rises over `nominalLoad`. */
export const tyreGrip = (load: number, mu: number, nominalLoad: number): number => {
    if (!(load > 0)) return 0;
    const ratio = nominalLoad > 0 ? load / nominalLoad : 1;
    const factor = Math.min(1.15, Math.max(0.6, 1 - LOAD_SENSITIVITY * (ratio - 1)));
    return mu * load * factor;
};

/**
 * The force of a tyre under load `load` (N) with slip ratio `kappa` and slip angle `alpha`, combined
 * through a friction circle: the two slips are measured against their peaks, the force for their
 * combined size is shared out between them, so braking or driving hard leaves less for cornering.
 */
export const tyreForce = (kappa: number, alpha: number, load: number, mu: number, nominalLoad: number, out: TyreForce = { fx: 0, fy: 0 }): TyreForce => {
    const grip = tyreGrip(load, mu, nominalLoad);
    const sx = kappa / PEAK_SLIP_RATIO;
    const sy = alpha / PEAK_SLIP_ANGLE;
    const combined = Math.hypot(sx, sy);
    if (!(grip > 0) || combined < 1e-9) {
        out.fx = 0;
        out.fy = 0;
        return out;
    }
    out.fx = grip * magicFormula(combined * PEAK_SLIP_RATIO, LONGITUDINAL_CURVE) * (sx / combined);
    // A slide to the left is resisted by a force to the right.
    out.fy = -grip * magicFormula(combined * PEAK_SLIP_ANGLE, LATERAL_CURVE) * (sy / combined);
    return out;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Torque share of the peak at fractions of the redline: low-down pull, a broad plateau, tailing off at the top. */
const TORQUE_CURVE: readonly [number, number][] = [
    [0, 0.45], [0.15, 0.62], [0.35, 0.88], [0.55, 1], [0.75, 0.97], [0.9, 0.86], [1, 0.78], [1.1, 0.7],
];

export const torqueShare = (rpm: number, redline: number): number => {
    const x = Math.max(0, rpm / Math.max(1, redline));
    for (let i = 1; i < TORQUE_CURVE.length; i++) {
        const [x1, y1] = TORQUE_CURVE[i];
        if (x <= x1) {
            const [x0, y0] = TORQUE_CURVE[i - 1];
            return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
    }
    return TORQUE_CURVE[TORQUE_CURVE.length - 1][1];
};

const rpmToRadians = (rpm: number): number => (rpm * 2 * Math.PI) / 60;
const radiansToRpm = (omega: number): number => (omega * 60) / (2 * Math.PI);

export interface EngineSpec {
    idleRpm: number;
    redlineRpm: number;
    /** N m. */
    peakTorque: number;
    /** Engine braking at the redline with the throttle shut, N m. */
    brakingTorque: number;
}

/** An engine whose power peaks at `powerKw`, with the torque curve above. */
export const planEngine = (powerKw: number, redlineRpm = 6800, idleRpm = 850): EngineSpec => {
    let best = 0;
    for (let x = 0.3; x <= 1; x += 0.01) best = Math.max(best, torqueShare(x * redlineRpm, redlineRpm) * x);
    const peakTorque = (powerKw * 1000) / Math.max(1e-6, best * rpmToRadians(redlineRpm));
    return { idleRpm, redlineRpm, peakTorque, brakingTorque: peakTorque * 0.18 };
};

/** Engine torque at `rpm` for `throttle` (0-1): the curve under load, engine braking without, nothing above the redline. */
export const engineTorque = (engine: EngineSpec, rpm: number, throttle: number): number => {
    if (rpm >= engine.redlineRpm) return throttle > 0 ? 0 : -engine.brakingTorque;
    const drive = throttle * engine.peakTorque * torqueShare(rpm, engine.redlineRpm);
    const braking = (1 - throttle) * engine.brakingTorque * Math.min(1, Math.max(0, (rpm - engine.idleRpm) / (engine.redlineRpm - engine.idleRpm)));
    return drive - braking;
};

// ---------------------------------------------------------------------------
// Gearbox
// ---------------------------------------------------------------------------

export interface Gearbox {
    /** Forward ratios, first gear first. */
    ratios: number[];
    reverse: number;
    finalDrive: number;
}

/** Share of the drive torque that reaches the wheels. */
export const DRIVETRAIN_EFFICIENCY = 0.9;
/** Seconds the drive is cut while a gear changes. */
export const SHIFT_TIME = 0.22;
/** Seconds a gear is held after a change before the next, so the box does not hunt. */
export const MIN_GEAR_TIME = 0.8;

/**
 * Ratios that reach `topSpeed` (m/s) at the redline in top gear, spread evenly (geometrically) down
 * to a first gear that pulls hard from rest: about 4:1 between first and top over six gears.
 */
export const planGearbox = (topSpeed: number, wheelRadius: number, redlineRpm: number, gears: number): Gearbox => {
    const count = Math.max(1, Math.min(10, Math.round(gears)));
    const top = 0.82;
    const spread = 1 + 0.6 * (count - 1);
    const ratios: number[] = [];
    for (let i = 0; i < count; i++) ratios.push(count === 1 ? top : top * spread ** (1 - i / (count - 1)));
    // Top gear at the redline is a little past the top speed, which the limiter then holds.
    const finalDrive = (rpmToRadians(redlineRpm) * wheelRadius) / (Math.max(1, topSpeed) * 1.04 * top);
    return { ratios, reverse: ratios[0] * 1.1, finalDrive };
};

/** Overall ratio between engine and wheels in `gear` (-1 reverse, 0 neutral). */
export const overallRatio = (box: Gearbox, gear: number): number =>
    gear === 0 ? 0 : (gear < 0 ? -box.reverse : box.ratios[Math.min(box.ratios.length, gear) - 1]) * box.finalDrive;

export interface TransmissionState {
    /** 1..n forward, -1 reverse, 0 neutral. */
    gear: number;
    /** Seconds left of the change in progress; the drive is cut until it ends. */
    shifting: number;
    /** Gear being changed into. */
    target: number;
    /** Seconds since the last change ended. */
    held: number;
}

export const createTransmission = (): TransmissionState => ({ gear: 1, shifting: 0, target: 1, held: MIN_GEAR_TIME });

/**
 * Automatic gear choice, on the road speed (`roadOmega`: the vehicle's speed over the wheel radius,
 * so spinning wheels do not upshift): up near the redline, down when the revs fall low enough that
 * the gear below stays well under it, into reverse or first as the driver asks. Each gear is held a
 * moment before the next change.
 */
export const stepTransmission = (
    state: TransmissionState,
    box: Gearbox,
    engine: EngineSpec,
    roadOmega: number,
    throttle: number,
    reverse: boolean,
    dt: number,
): void => {
    if (state.shifting > 0) {
        state.shifting = Math.max(0, state.shifting - dt);
        if (state.shifting === 0) {
            state.gear = state.target;
            state.held = 0;
        }
        return;
    }
    state.held += dt;
    const shift = (target: number) => {
        if (target === state.gear) return;
        state.target = target;
        state.shifting = SHIFT_TIME;
    };
    // Into or out of reverse whenever asked (it only happens near a stop).
    if (reverse) {
        if (state.gear !== -1) shift(-1);
        return;
    }
    if (state.gear < 1) {
        shift(1);
        return;
    }
    if (state.held < MIN_GEAR_TIME) return;
    const rpmIn = (gear: number) => radiansToRpm(Math.abs(roadOmega * overallRatio(box, gear)));
    const top = box.ratios.length;
    if (state.gear < top && rpmIn(state.gear) > engine.redlineRpm * 0.92 && throttle > 0.05) shift(state.gear + 1);
    else if (state.gear > 1 && rpmIn(state.gear) < engine.redlineRpm * 0.42 && rpmIn(state.gear - 1) < engine.redlineRpm * 0.82) shift(state.gear - 1);
    else if (state.gear > 1 && throttle > 0.9 && rpmIn(state.gear - 1) < engine.redlineRpm * 0.72) shift(state.gear - 1);
};

/** Engine speed below which the clutch slips on a launch instead of stalling the engine. */
export const clutchSlipRpm = (engine: EngineSpec): number => engine.idleRpm + 0.25 * (engine.redlineRpm - engine.idleRpm);

export interface DriveTorque {
    /** Torque on the driven wheels in all, N m (signed: forward positive). */
    wheelTorque: number;
    /** The engine's speed now. */
    rpm: number;
    /** The clutch is slipping (launching) or open (shifting, neutral). */
    clutchSlip: boolean;
}

/**
 * The drive torque reaching the wheels and the engine's speed, from the driven wheels' mean spin.
 * Coupled, the engine turns with the wheels; below the clutch's slip speed (a launch) it revs to a
 * launch speed and the slipping clutch passes its torque on; while shifting nothing is passed on.
 */
export const driveTorque = (
    engine: EngineSpec,
    box: Gearbox,
    transmission: TransmissionState,
    drivenOmega: number,
    throttle: number,
    out: DriveTorque = { wheelTorque: 0, rpm: engine.idleRpm, clutchSlip: false },
): DriveTorque => {
    const ratio = overallRatio(box, transmission.gear);
    const coupledRpm = radiansToRpm(Math.abs(drivenOmega * ratio));
    if (transmission.shifting > 0 || ratio === 0) {
        out.wheelTorque = 0;
        out.rpm = Math.max(engine.idleRpm, Math.min(engine.redlineRpm, engine.idleRpm + throttle * (engine.redlineRpm - engine.idleRpm) * 0.6, coupledRpm));
        out.clutchSlip = true;
        return out;
    }
    const slipRpm = clutchSlipRpm(engine);
    let rpm: number;
    if (coupledRpm < slipRpm && throttle > 0) {
        rpm = Math.max(coupledRpm, engine.idleRpm + throttle * (slipRpm - engine.idleRpm));
        out.clutchSlip = true;
    } else {
        rpm = Math.max(engine.idleRpm, coupledRpm);
        out.clutchSlip = false;
    }
    let torque = engineTorque(engine, rpm, throttle);
    // At idle with no throttle the engine neither drives nor brakes.
    if (throttle <= 0 && coupledRpm <= engine.idleRpm) torque = 0;
    out.wheelTorque = torque * ratio * DRIVETRAIN_EFFICIENCY;
    out.rpm = rpm;
    return out;
};

// ---------------------------------------------------------------------------
// Differential
// ---------------------------------------------------------------------------

export type DifferentialKind = 'open' | 'limited' | 'locked';

/** Torque a limited-slip differential moves to the slower wheel per rad/s of difference, as a share of the axle torque. */
const LSD_COUPLING = 0.08;
/** Most of the axle's torque a limited-slip differential moves across. */
const LSD_BIAS = 0.35;
/** A locked axle moves this much per rad/s (N m), up to all of its torque. */
const LOCKED_COUPLING = 400;

/**
 * Splits an axle's torque between its two wheels spinning at `omegaA` and `omegaB`: equally (open),
 * leaning to the slower wheel (limited slip), or holding them to one speed (locked).
 */
export const splitAxleTorque = (torque: number, omegaA: number, omegaB: number, kind: DifferentialKind): [number, number] => {
    const half = torque / 2;
    if (kind === 'open') return [half, half];
    const difference = omegaA - omegaB;
    const limit = kind === 'locked' ? Math.max(Math.abs(torque), LOCKED_COUPLING * Math.abs(difference)) / 2 : Math.abs(torque) * LSD_BIAS;
    const coupling = kind === 'locked' ? LOCKED_COUPLING : Math.abs(torque) * LSD_COUPLING;
    const transfer = Math.min(limit, Math.max(-limit, coupling * difference));
    return [half - transfer, half + transfer];
};

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

export interface WheelDynamics {
    /** Spin, rad/s (positive rolling forward). */
    omega: number;
    radius: number;
    /** kg m². */
    inertia: number;
}

/** Spin inertia of a wheel and tyre of `radius` (m): about that of a 20 kg hoop-and-disc. */
export const wheelInertia = (radius: number): number => Math.max(0.05, 14 * radius * radius);

export interface WheelContact {
    /** Ground speed of the contact along the wheel's heading and across it (to the left), m/s. */
    longitudinal: number;
    lateral: number;
    /** N. */
    load: number;
    /** Peak friction coefficient of tyre on surface. */
    mu: number;
    /** The tyre's load at rest, for load sensitivity. */
    nominalLoad: number;
    /** Rolling resistance of the ground, as a share of the load (ROLLING_RESISTANCE, a road, when unset). */
    rolling?: number;
}

export interface WheelStepResult extends TyreForce {
    slipRatio: number;
    slipAngle: number;
}

/** Rolling resistance as a share of the load. */
export const ROLLING_RESISTANCE = 0.015;

const _force: TyreForce = { fx: 0, fy: 0 };

/**
 * Advances one wheel's spin over `dt` in `substeps` steps, against the tyre's grip on its contact,
 * and returns the mean tyre force. Each step is solved implicitly in the slip (the tyre's force
 * linearised in the spin), which keeps a stiff tyre stable; the brake (and rolling resistance) is
 * Coulomb friction: it slows the wheel and holds it locked, never spinning it backwards.
 */
export const stepWheel = (
    wheel: WheelDynamics,
    contact: WheelContact | null,
    drive: number,
    brake: number,
    dt: number,
    substeps: number,
    out: WheelStepResult = { fx: 0, fy: 0, slipRatio: 0, slipAngle: 0 },
): WheelStepResult => {
    const h = dt / Math.max(1, substeps);
    const r = wheel.radius;
    let sumX = 0;
    let sumY = 0;
    const alpha = contact ? slipAngle(contact.longitudinal, contact.lateral) : 0;
    for (let i = 0; i < substeps; i++) {
        let fx = 0;
        let stiffness = 0;
        if (contact && contact.load > 0) {
            const kappa = slipRatio(wheel.omega * r, contact.longitudinal);
            fx = tyreForce(kappa, alpha, contact.load, contact.mu, contact.nominalLoad, _force).fx;
            // Slope of the force in the spin, numerically; a falling slope (past the peak) is not used to stiffen the solve.
            const delta = 0.05;
            const ahead = tyreForce(slipRatio((wheel.omega + delta) * r, contact.longitudinal), alpha, contact.load, contact.mu, contact.nominalLoad, _force).fx;
            stiffness = Math.max(0, (ahead - fx) / delta);
        }
        const effective = wheel.inertia + h * r * stiffness;
        wheel.omega += (h * (drive - r * fx)) / effective;
        const resistance = brake + (contact ? (contact.rolling ?? ROLLING_RESISTANCE) * contact.load * r : 0);
        const stop = (h * resistance) / effective;
        wheel.omega = Math.abs(wheel.omega) <= stop ? 0 : wheel.omega - Math.sign(wheel.omega) * stop;
        if (contact && contact.load > 0) {
            const kappa = slipRatio(wheel.omega * r, contact.longitudinal);
            tyreForce(kappa, alpha, contact.load, contact.mu, contact.nominalLoad, _force);
            sumX += _force.fx;
            sumY += _force.fy;
        }
    }
    out.fx = sumX / Math.max(1, substeps);
    out.fy = sumY / Math.max(1, substeps);
    out.slipRatio = contact ? slipRatio(wheel.omega * r, contact.longitudinal) : 0;
    out.slipAngle = alpha;
    return out;
};

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

export interface SuspensionSpec {
    /** N/m. */
    stiffness: number;
    /** N s/m, as the spring compresses and as it extends. */
    compressionDamping: number;
    reboundDamping: number;
    /** Metres from full extension to the bump stop. */
    travel: number;
}

/** The last share of the travel where the bump stop builds up. */
const BUMP_STOP_SHARE = 0.12;
/** The bump stop's stiffness, as a multiple of the spring's. */
const BUMP_STOP_STIFFNESS = 12;

/**
 * Spring, damper and bump stop force (N, pushing the body up) at `compression` metres from full
 * extension, compressing at `velocity` m/s (negative extending). A wheel never pulls the body down.
 */
export const suspensionForce = (spec: SuspensionSpec, compression: number, velocity: number): number => {
    let force = spec.stiffness * compression + (velocity > 0 ? spec.compressionDamping : spec.reboundDamping) * velocity;
    const stopStart = spec.travel * (1 - BUMP_STOP_SHARE);
    if (compression > stopStart) force += spec.stiffness * BUMP_STOP_STIFFNESS * (compression - stopStart);
    return Math.max(0, force);
};

/**
 * A suspension for a vehicle of `mass` kg on `wheels` wheels: `stiffness` per kg of vehicle (so the
 * car sags 9.81 / (wheels x stiffness) metres at rest) and `damping` as a damping ratio, rebound
 * damped harder than compression as in a road car.
 */
export const planSuspension = (mass: number, wheels: number, stiffness: number, damping: number, travel: number): SuspensionSpec => {
    const share = mass / Math.max(1, wheels);
    const k = stiffness * mass;
    // Critical damping of one corner: 2 sqrt(k m).
    const critical = 2 * Math.sqrt(k * share);
    return { stiffness: k, compressionDamping: damping * critical * 0.7, reboundDamping: damping * critical * 1.3, travel };
};

// ---------------------------------------------------------------------------
// Assists
// ---------------------------------------------------------------------------

/** ABS lets a wheel's brake off below this slip ratio (locking). */
export const ABS_SLIP = -0.14;
/** Traction control holds the driven wheels near this slip ratio, a little short of their peak grip. */
export const TRACTION_SLIP = 0.1;

/** The brake torque ABS lets through for a wheel at `slip` under `brake`. */
export const absBrake = (brake: number, slip: number, speed: number): number =>
    slip < ABS_SLIP && Math.abs(speed) > 2 ? brake * 0.25 : brake;

/** Traction control's state: the share of the throttle it lets through. */
export interface TractionControlState {
    share: number;
}

export const createTractionControl = (): TractionControlState => ({ share: 1 });

/**
 * Traction control's gains: the share of the throttle it takes away per second for each unit of slip
 * over TRACTION_SLIP (fast: past its peak a tyre lets go, and the wheel flares within a frame or two),
 * and gives back per second for each unit under it (slow, so the wheels ease up to the target).
 */
const TRACTION_CUT_GAIN = 40;
const TRACTION_RECOVERY_GAIN = 8;
/** It never cuts below this share. */
const TRACTION_MIN_SHARE = 0.03;

/**
 * Throttle after traction control, from the most a driven wheel spins: the share it lets through
 * falls fast while the wheels spin past TRACTION_SLIP and climbs back slowly while they grip, so they
 * hold near the slip that pulls hardest instead of flaring and bogging in turn.
 */
export const stepTractionControl = (state: TractionControlState, throttle: number, maxDrivenSlip: number, dt: number): number => {
    const error = maxDrivenSlip - TRACTION_SLIP;
    const gain = error > 0 ? TRACTION_CUT_GAIN : TRACTION_RECOVERY_GAIN;
    state.share = Math.min(1, Math.max(TRACTION_MIN_SHARE, state.share - error * gain * dt));
    return throttle * state.share;
};

/** What stability control does this step: brakes one wheel (with a share of the most braking), and trims the throttle. */
export interface StabilityCorrection {
    wheel: { front: boolean; left: boolean } | null;
    amount: number;
    /** Multiplies the throttle. */
    throttle: number;
}

const NO_CORRECTION: StabilityCorrection = { wheel: null, amount: 0, throttle: 1 };
const GRAVITY_ACCELERATION = 9.81;

/**
 * Stability control: the yaw rate the steering asks for at `speed` (a bicycle model on the
 * wheelbase), no more than the tyres' `grip` can hold, against the yaw rate the car has (about +Y,
 * positive turning left). A car turning more than that is oversteering: a front wheel is braked on
 * the side that turns it back, and the throttle trimmed. One turning less is understeering: a rear
 * wheel is braked on the side that turns it in.
 */
export const stabilityCorrection = (
    steer: number,
    speed: number,
    wheelbase: number,
    yawRate: number,
    grip: number,
): StabilityCorrection => {
    if (Math.abs(speed) < 5 || wheelbase <= 0) return NO_CORRECTION;
    // Turning right (positive steer) is a negative yaw rate.
    const asked = -(speed * Math.tan(steer)) / wheelbase;
    const limit = (0.9 * grip * GRAVITY_ACCELERATION) / Math.abs(speed);
    const target = Math.max(-limit, Math.min(limit, asked));
    const error = yawRate - target;
    const threshold = 0.08 + 0.1 * Math.abs(target);
    if (Math.abs(error) < threshold) return NO_CORRECTION;
    const amount = Math.min(1, (Math.abs(error) - threshold) * 1.5);
    const oversteer = Math.sign(error) === Math.sign(yawRate);
    // A braked left wheel turns the car left (positive yaw): brake the side that cancels the error.
    return {
        wheel: { front: oversteer, left: error < 0 },
        amount,
        throttle: oversteer ? 1 - 0.8 * amount : 1,
    };
};
