import * as THREE from 'three';
import type { LevelComponent } from '../types';

/**
 * VEHICLES
 *
 * Wheeled vehicles on Rapier's ray-cast vehicle controller: a dynamic chassis body held up by a
 * spring and damper ray under each wheel, pushed along by tyre friction. This module holds what is
 * not tied to React or a running world, so it can be tested on its own:
 *
 * - settings, read from the Vehicle component's props;
 * - the drive model: throttle, brakes, reverse, handbrake and speed-sensitive Ackermann steering,
 *   with an engine of fixed power, a soft limiter at top speed and a gearbox for the engine note;
 * - finding the model's own wheels by name (Wheel_FL, FrontLeftTire, rim_rr ...), or laying out
 *   wheels at the corners of a model that has none;
 * - AI driving along a spline: pure-pursuit steering and a speed plan that brakes for corners
 *   and for the end of an open path;
 * - the play session's vehicles: which one the player drives, the Interact prompt and the HUD.
 *
 * Frames: a vehicle's body frame is its object's world transform without scale. +Z is forward,
 * +Y up and +X the vehicle's left (the model faces +Z, so its right hand is -X).
 */

export const VEHICLE_COMPONENT_TYPE = 'vehicle';

/**
 * Share of a vehicle's mass its colliders carry when the Vehicle owns the body; the rest is added at
 * the vehicle's own centre of mass, low between the wheels, which keeps it from rolling over.
 */
export const VEHICLE_SHELL_MASS_SHARE = 0.1;

export type VehicleDrive = 'rear' | 'front' | 'all';

const DRIVES: readonly VehicleDrive[] = ['rear', 'front', 'all'];

export interface VehicleSettings {
    /** kg. */
    mass: number;
    drive: VehicleDrive;
    /** Engine power, kW. */
    power: number;
    /** Top speed forward, km/h. */
    maxSpeed: number;
    /** Top speed in reverse, km/h. */
    reverseSpeed: number;
    /** Braking at full pedal, m/s² (about 9 is a road car). */
    braking: number;
    /** Front wheel angle at full lock, degrees. */
    steerAngle: number;
    /** Share of the lock left at top speed (0-1): less steering at speed keeps it stable. */
    steerAtSpeed: number;
    /** Tyre grip: friction coefficient (1 is a road tyre; more grips harder). */
    grip: number;
    /** Share of the rear grip the handbrake leaves (0-1): lower slides more. */
    handbrakeGrip: number;
    /** Suspension length at full extension, m. */
    suspensionTravel: number;
    /** Spring stiffness per kg of car: sag at rest is 9.81 / (wheels x stiffness). */
    suspensionStiffness: number;
    /** Damping ratio (0-1): low bounces, high is stiff. */
    suspensionDamping: number;
    /** Anti-roll bars, as a share of the spring rate (0-1): more keeps it flat in corners. */
    antiRoll: number;
    /** Downforce, N per (m/s)². */
    downforce: number;
    /** Centre of mass above (or below, negative) the wheel centres, m. */
    centreOfMass: number;
    /** Wheel radius, m; 0 measures the model's wheels (or sizes them from the body). */
    wheelRadius: number;
    /** The player can get in with Interact. */
    playerCanDrive: boolean;
    /** A Spline object the vehicle drives along on its own whenever the player is not driving it. */
    aiPath: string;
    /** Cruising speed along the AI path, km/h. */
    aiSpeed: number;
    /** Audio asset of an engine loop, pitched by the revs; empty synthesizes the engine. */
    engineSound: string;
    /** 0-2. */
    engineVolume: number;
}

export const VEHICLE_DEFAULTS: VehicleSettings = {
    mass: 1200,
    drive: 'rear',
    power: 120,
    maxSpeed: 160,
    reverseSpeed: 30,
    braking: 9,
    steerAngle: 35,
    steerAtSpeed: 0.3,
    grip: 1.6,
    handbrakeGrip: 0.35,
    suspensionTravel: 0.3,
    suspensionStiffness: 30,
    suspensionDamping: 0.45,
    antiRoll: 0.5,
    downforce: 0.5,
    centreOfMass: 0,
    wheelRadius: 0,
    playerCanDrive: true,
    aiPath: '',
    aiSpeed: 50,
    engineSound: '',
    engineVolume: 1,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** The Vehicle component's props, missing or invalid values at their defaults. */
export const readVehicleSettings = (component: Pick<LevelComponent, 'props'>): VehicleSettings => {
    const p = component.props ?? {};
    const d = VEHICLE_DEFAULTS;
    return {
        mass: clampNumber(p.mass, d.mass, 1, 100000),
        drive: typeof p.drive === 'string' && (DRIVES as readonly string[]).includes(p.drive) ? p.drive as VehicleDrive : d.drive,
        power: clampNumber(p.power, d.power, 0, 5000),
        maxSpeed: clampNumber(p.maxSpeed, d.maxSpeed, 1, 1000),
        reverseSpeed: clampNumber(p.reverseSpeed, d.reverseSpeed, 0, 500),
        braking: clampNumber(p.braking, d.braking, 0, 100),
        steerAngle: clampNumber(p.steerAngle, d.steerAngle, 0, 80),
        steerAtSpeed: clampNumber(p.steerAtSpeed, d.steerAtSpeed, 0, 1),
        grip: clampNumber(p.grip, d.grip, 0.05, 20),
        handbrakeGrip: clampNumber(p.handbrakeGrip, d.handbrakeGrip, 0, 1),
        suspensionTravel: clampNumber(p.suspensionTravel, d.suspensionTravel, 0.02, 5),
        suspensionStiffness: clampNumber(p.suspensionStiffness, d.suspensionStiffness, 1, 500),
        suspensionDamping: clampNumber(p.suspensionDamping, d.suspensionDamping, 0, 2),
        antiRoll: clampNumber(p.antiRoll, d.antiRoll, 0, 2),
        downforce: clampNumber(p.downforce, d.downforce, 0, 100),
        centreOfMass: clampNumber(p.centreOfMass, d.centreOfMass, -5, 5),
        wheelRadius: clampNumber(p.wheelRadius, d.wheelRadius, 0, 10),
        playerCanDrive: typeof p.playerCanDrive === 'boolean' ? p.playerCanDrive : d.playerCanDrive,
        aiPath: typeof p.aiPath === 'string' ? p.aiPath : d.aiPath,
        aiSpeed: clampNumber(p.aiSpeed, d.aiSpeed, 0, 1000),
        engineSound: typeof p.engineSound === 'string' ? p.engineSound : d.engineSound,
        engineVolume: clampNumber(p.engineVolume, d.engineVolume, 0, 2),
    };
};

export const KMH = 1 / 3.6;
export const GRAVITY = 9.81;

// ---------------------------------------------------------------------------
// Drive model
// ---------------------------------------------------------------------------

/** What the driver (player, AI or a level script) asks for. */
export interface VehicleControls {
    /** 0-1. */
    throttle: number;
    /** 0-1: brakes while rolling forward, reverses once stopped. */
    brake: number;
    /** -1 (left) to 1 (right). */
    steer: number;
    handbrake: boolean;
}

export const NO_CONTROLS: Readonly<VehicleControls> = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/** Gearbox stages as shares of top speed; the engine note rises through each. */
const GEAR_TOPS = [0.24, 0.4, 0.56, 0.71, 0.86, 1.02];
export const IDLE_RPM = 850;
export const REDLINE_RPM = 6800;
/** Below this the vehicle counts as stopped: the brake pedal starts reversing, throttle starts forward. */
const STOPPED_SPEED = 0.8;
/** Steering moves towards the wheel's position at this many full locks per second, and back faster. */
const STEER_RATE = 2.2;
const STEER_RETURN_RATE = 3.5;
/** Rolling resistance and engine braking while coasting, as a deceleration (m/s²). */
const COAST_DECELERATION = 0.55;
/** Front share of the brakes. */
const FRONT_BRAKE_SHARE = 0.6;
/** Front share of the drive on all-wheel drive. */
const FRONT_DRIVE_SHARE = 0.4;
/** Reverse pushes this share of the engine's force. */
const REVERSE_FORCE_SHARE = 0.6;

/** The drive model's own state between steps. */
export interface VehicleDriveState {
    /** Current front-wheel steering, radians, positive turning right. */
    steer: number;
    /** 1-6 forward, -1 reverse. */
    gear: number;
    rpm: number;
    reversing: boolean;
}

export const createDriveState = (): VehicleDriveState => ({ steer: 0, gear: 1, rpm: IDLE_RPM, reversing: false });

/** What one step asks of the wheels, split by axle. Forces in newtons, steering in radians. */
export interface VehicleDriveOutput {
    /** Total drive force, positive forward. */
    driveForce: number;
    /** Front share of `driveForce` (0-1). */
    frontDrive: number;
    /** Total brake force on the front and on the rear wheels. */
    frontBrake: number;
    rearBrake: number;
    /** The handbrake is on: rear grip drops to settings.handbrakeGrip. */
    handbrake: boolean;
    /** Steering angle of the front axle's centre, positive turning right. */
    steer: number;
    /** Throttle the engine is under (0-1), for the engine note. */
    load: number;
}

/**
 * Most a launch accelerates the vehicle, as a share of gravity: about what road tyres put down. More
 * at a standstill pitches a short car up onto its rear wheels, where it cannot steer.
 */
export const LAUNCH_ACCELERATION = 0.6;

/** Engine force at `speed` (m/s, any sign) for full throttle: constant power, held under the launch limit at low speed, a soft limiter at top speed. */
export const engineForce = (settings: Pick<VehicleSettings, 'power' | 'maxSpeed' | 'mass'>, speed: number, limit = settings.maxSpeed * KMH): number => {
    const power = settings.power * 1000;
    const top = Math.max(0.1, limit);
    const v = Math.abs(speed);
    const force = Math.min(power / Math.max(v, 0.5), settings.mass * GRAVITY * LAUNCH_ACCELERATION);
    // The last 8% below the limit fades the force out, so top speed is held without bouncing off it.
    const fade = Math.min(1, Math.max(0, (1 - v / top) / 0.08));
    return force * fade;
};

const moveTowards = (value: number, target: number, step: number): number =>
    value < target ? Math.min(target, value + step) : Math.max(target, value - step);

/**
 * One step of the drive model. `speed` is the chassis's forward speed (m/s, negative rolling
 * backwards). Throttle drives forward and brakes a car rolling back; the brake pedal brakes a car
 * rolling forward and reverses one that has stopped.
 */
export const stepVehicleDrive = (
    state: VehicleDriveState,
    controls: VehicleControls,
    speed: number,
    dt: number,
    settings: VehicleSettings,
): VehicleDriveOutput => {
    const throttle = Math.min(1, Math.max(0, controls.throttle || 0));
    const pedal = Math.min(1, Math.max(0, controls.brake || 0));
    const steerInput = Math.min(1, Math.max(-1, controls.steer || 0));
    const weight = settings.mass * GRAVITY;
    const brakeForce = settings.mass * settings.braking;

    // Which way the driver means to go: reverse is chosen only from a stop.
    if (speed > STOPPED_SPEED) state.reversing = false;
    else if (speed < -STOPPED_SPEED) state.reversing = true;
    else if (pedal > 0 && throttle === 0) state.reversing = true;
    else if (throttle > 0) state.reversing = false;

    let driveForce = 0;
    let braking = 0;
    let load = 0;
    if (state.reversing) {
        // Throttle brakes a car rolling backwards; the pedal drives it back.
        if (throttle > 0 && speed < -STOPPED_SPEED) braking = throttle;
        else if (pedal > 0) {
            driveForce = -pedal * REVERSE_FORCE_SHARE * engineForce(settings, speed, settings.reverseSpeed * KMH);
            load = pedal;
        }
    } else {
        if (pedal > 0 && speed > STOPPED_SPEED) braking = pedal;
        else if (throttle > 0) {
            driveForce = throttle * engineForce(settings, speed);
            load = throttle;
        }
    }
    const coasting = driveForce === 0 && braking === 0;
    const totalBrake = braking * brakeForce + (coasting ? settings.mass * COAST_DECELERATION : 0);

    // Steering: less lock at speed, eased towards the wheel's position.
    const atSpeed = Math.min(1, Math.abs(speed) / Math.max(1, settings.maxSpeed * KMH));
    const lock = THREE.MathUtils.degToRad(settings.steerAngle) * (1 - (1 - settings.steerAtSpeed) * atSpeed);
    const wanted = steerInput * lock;
    const returning = Math.abs(wanted) < Math.abs(state.steer) || Math.sign(wanted) !== Math.sign(state.steer);
    const rate = (returning ? STEER_RETURN_RATE : STEER_RATE) * Math.max(lock, 1e-3) * dt;
    state.steer = moveTowards(state.steer, wanted, rate);

    // Gearbox and revs, for the engine note.
    const top = Math.max(1, settings.maxSpeed * KMH);
    const v = Math.abs(speed);
    if (state.reversing && v > 0.1) state.gear = -1;
    else {
        if (state.gear < 1) state.gear = 1;
        while (state.gear < GEAR_TOPS.length && v > GEAR_TOPS[state.gear - 1] * top * 0.97) state.gear++;
        while (state.gear > 1 && v < GEAR_TOPS[state.gear - 2] * top * 0.62) state.gear--;
    }
    const gearIndex = state.gear < 0 ? 0 : state.gear - 1;
    const gearLow = gearIndex === 0 ? 0 : GEAR_TOPS[gearIndex - 1] * top * 0.62;
    const gearTop = GEAR_TOPS[gearIndex] * top;
    const inGear = Math.min(1, Math.max(0, (v - gearLow * 0.5) / Math.max(0.1, gearTop - gearLow * 0.5)));
    const wantedRpm = Math.max(IDLE_RPM + load * 900, IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * inGear);
    state.rpm += (wantedRpm - state.rpm) * Math.min(1, dt * 8);

    return {
        driveForce,
        frontDrive: settings.drive === 'front' ? 1 : settings.drive === 'all' ? FRONT_DRIVE_SHARE : 0,
        frontBrake: totalBrake * FRONT_BRAKE_SHARE,
        rearBrake: totalBrake * (1 - FRONT_BRAKE_SHARE) + (controls.handbrake ? weight * 1.5 : 0),
        handbrake: controls.handbrake,
        steer: state.steer,
        load,
    };
};

/**
 * Each front wheel's angle for the axle's centre angle `steer` (positive right): the inner wheel
 * turns more, so both roll round the same centre (Ackermann geometry).
 */
export const ackermannAngles = (steer: number, wheelbase: number, track: number): { left: number; right: number } => {
    if (Math.abs(steer) < 1e-5 || !(wheelbase > 1e-3) || !(track > 1e-3)) return { left: steer, right: steer };
    const radius = wheelbase / Math.tan(Math.abs(steer));
    const inner = Math.atan(wheelbase / Math.max(1e-3, radius - track / 2));
    const outer = Math.atan(wheelbase / (radius + track / 2));
    const sign = Math.sign(steer);
    // Turning right, the right wheel is inside.
    return steer > 0 ? { left: sign * outer, right: sign * inner } : { left: sign * inner, right: sign * outer };
};

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

/** A node name split into lower-case words: 'Wheel_FL' and 'wheelFL' both give ['wheel', 'fl']. */
const nameWords = (name: string): string[] =>
    name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

const WHEEL_WORDS = new Set(['wheel', 'wheels', 'tire', 'tires', 'tyre', 'tyres', 'rim', 'rims', 'hub', 'hubs', 'hubcap']);
const NOT_WHEEL_WORDS = new Set(['steering', 'steer', 'spare', 'well', 'arch', 'guard', 'fender', 'cover', 'mud', 'flap', 'housing']);

/** True for a node named like a road wheel (or its tyre, rim or hub), not a steering wheel, spare or arch. */
export const isWheelName = (name: string): boolean => {
    const words = nameWords(name);
    return words.some(word => WHEEL_WORDS.has(word)) && !words.some(word => NOT_WHEEL_WORDS.has(word));
};

/**
 * The model's wheel nodes under `root`: the top-most wheel-named node on each branch. A wheel-named
 * group holding two or more wheel-named children ('Wheels' around 'Wheel_FL' ...) is opened instead.
 * `skip` leaves out a node and everything under it.
 */
export const findWheelNodes = (root: THREE.Object3D, skip?: (node: THREE.Object3D) => boolean): THREE.Object3D[] => {
    const found: THREE.Object3D[] = [];
    const visit = (node: THREE.Object3D) => {
        for (const child of node.children) {
            if (skip?.(child)) continue;
            if (isWheelName(child.name) && child.children.filter(grand => isWheelName(grand.name)).length < 2) {
                found.push(child);
                continue;
            }
            visit(child);
        }
    };
    visit(root);
    return found;
};

/** One wheel, in the chassis body's frame (metres). */
export interface VehicleWheel {
    /** Wheel centre with the car resting on it. */
    centre: THREE.Vector3;
    radius: number;
    width: number;
    front: boolean;
    left: boolean;
    /** The model's own nodes that turn with this wheel (tyre, rim ...); empty for a wheel the vehicle draws. */
    nodes: THREE.Object3D[];
}

export interface VehicleLayout {
    wheels: VehicleWheel[];
    /** The bounds of the body without its wheels, in the chassis frame. */
    chassis: THREE.Box3;
    /** True when the wheels were laid out from the body because the model names none. */
    generated: boolean;
}

const _inverse = new THREE.Matrix4();
const _frame = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _box = new THREE.Box3();

/** The chassis frame of `host`: its world transform without scale. */
export const chassisFrame = (host: THREE.Object3D, out = new THREE.Matrix4()): THREE.Matrix4 => {
    host.updateWorldMatrix(true, false);
    host.matrixWorld.decompose(_position, _quaternion, _scale);
    return out.compose(_position, _quaternion, new THREE.Vector3(1, 1, 1));
};

/** Bounds, in the frame `toFrame` maps world space into, of the meshes under `node`; `skip` leaves out subtrees. */
const boundsInFrame = (node: THREE.Object3D, toFrame: THREE.Matrix4, out: THREE.Box3, skip?: (node: THREE.Object3D) => boolean): THREE.Box3 => {
    out.makeEmpty();
    const visit = (current: THREE.Object3D) => {
        if (skip?.(current)) return;
        const mesh = current as THREE.Mesh;
        if (mesh.isMesh && mesh.visible && mesh.geometry) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const local = mesh.geometry.boundingBox;
            if (local && !local.isEmpty()) {
                _box.copy(local).applyMatrix4(_frame.multiplyMatrices(toFrame, mesh.matrixWorld));
                out.union(_box);
            }
        }
        for (const child of current.children) visit(child);
    };
    visit(node);
    return out;
};

/** Wheel nodes whose centres lie within this share of a radius of each other are one wheel (a tyre and its rim). */
const SAME_WHEEL = 0.5;

/**
 * The vehicle's wheels: the model's own (found by name) when it names at least three, else four
 * laid out at the corners of its body. `radius` (when above 0) overrides the measured wheel radius.
 * `skip` leaves out subtrees that are not the model (helpers, nested objects).
 */
export const planVehicleLayout = (
    host: THREE.Object3D,
    radius = 0,
    skip?: (node: THREE.Object3D) => boolean,
): VehicleLayout => {
    host.updateWorldMatrix(true, true);
    _inverse.copy(chassisFrame(host, _frame)).invert();
    const toChassis = _inverse.clone();
    const nodes = findWheelNodes(host, skip);
    const wheelSet = new Set(nodes);
    const isWheel = (node: THREE.Object3D) => wheelSet.has(node) || Boolean(skip?.(node));
    const chassis = boundsInFrame(host, toChassis, new THREE.Box3(), isWheel);

    // Group nodes that share a centre (tyre, rim, brake disc) into one wheel.
    const groups: { box: THREE.Box3; nodes: THREE.Object3D[] }[] = [];
    for (const node of nodes) {
        const box = boundsInFrame(node, toChassis, new THREE.Box3(), skip);
        if (box.isEmpty()) continue;
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        const own = Math.max(size.y, size.z) / 2;
        const match = groups.find(group => group.box.getCenter(_position).distanceTo(centre) < SAME_WHEEL * Math.max(own, 0.05));
        if (match) {
            match.box.union(box);
            match.nodes.push(node);
        } else groups.push({ box, nodes: [node] });
    }

    if (groups.length >= 3) {
        const mean = new THREE.Vector3();
        for (const group of groups) mean.add(group.box.getCenter(_position));
        mean.divideScalar(groups.length);
        const wheels = groups.map(group => {
            const size = group.box.getSize(new THREE.Vector3());
            const centre = group.box.getCenter(new THREE.Vector3());
            return {
                centre,
                radius: radius > 0 ? radius : Math.max(0.02, Math.max(size.y, size.z) / 2),
                width: Math.max(0.02, size.x),
                front: centre.z > mean.z,
                left: centre.x > mean.x,
                nodes: group.nodes,
            };
        });
        if (chassis.isEmpty()) for (const wheel of wheels) chassis.expandByPoint(wheel.centre);
        return { wheels, chassis, generated: false };
    }

    // No wheels in the model: four at the corners of its body, poking out below it.
    const body = chassis.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -1), new THREE.Vector3(0.5, 1, 1)) : chassis;
    const size = body.getSize(new THREE.Vector3());
    const r = radius > 0 ? radius : THREE.MathUtils.clamp(Math.min(size.x, size.z) * 0.2, 0.08, 1.2);
    const width = THREE.MathUtils.clamp(r * 0.7, 0.04, size.x / 3);
    const x = Math.max(0.05, size.x / 2 - width / 2);
    const z = Math.max(0.1, size.z / 2 - r * 1.1);
    const centreX = (body.min.x + body.max.x) / 2;
    const centreZ = (body.min.z + body.max.z) / 2;
    const y = body.min.y + r * 0.45;
    const wheels: VehicleWheel[] = [];
    for (const front of [true, false]) {
        for (const left of [true, false]) {
            wheels.push({
                centre: new THREE.Vector3(centreX + (left ? x : -x), y, centreZ + (front ? z : -z)),
                radius: r,
                width,
                front,
                left,
                nodes: [],
            });
        }
    }
    return { wheels, chassis: body.clone(), generated: true };
};

/** Distance between the front and rear axles and between the left and right wheels. */
export const wheelGeometry = (wheels: readonly VehicleWheel[]): { wheelbase: number; track: number } => {
    const mean = (list: readonly VehicleWheel[], axis: 'x' | 'z') => list.reduce((sum, wheel) => sum + wheel.centre[axis], 0) / Math.max(1, list.length);
    const front = wheels.filter(wheel => wheel.front);
    const rear = wheels.filter(wheel => !wheel.front);
    const left = wheels.filter(wheel => wheel.left);
    const right = wheels.filter(wheel => !wheel.left);
    return {
        wheelbase: front.length && rear.length ? Math.abs(mean(front, 'z') - mean(rear, 'z')) : 0,
        track: left.length && right.length ? Math.abs(mean(left, 'x') - mean(right, 'x')) : 0,
    };
};

/** Static sag of each spring under the car's weight shared by `wheels` wheels. */
export const restingSag = (settings: Pick<VehicleSettings, 'suspensionStiffness'>, wheels: number): number =>
    GRAVITY / (Math.max(1, wheels) * settings.suspensionStiffness);

/** Spring and damper coefficients for Rapier (it scales them by the chassis mass). */
export const suspensionCoefficients = (settings: Pick<VehicleSettings, 'suspensionStiffness' | 'suspensionDamping'>): { stiffness: number; compression: number; relaxation: number } => {
    // Per wheel the damping ratio is c / sqrt(k); rebound is damped harder than compression, as in a road car.
    const critical = Math.sqrt(settings.suspensionStiffness);
    return {
        stiffness: settings.suspensionStiffness,
        compression: settings.suspensionDamping * critical * 0.7,
        relaxation: settings.suspensionDamping * critical * 1.3,
    };
};

// ---------------------------------------------------------------------------
// AI driving
// ---------------------------------------------------------------------------

/** Where the vehicle is and how it moves, in world space. */
export interface VehiclePose {
    position: THREE.Vector3;
    /** Unit forward direction. */
    forward: THREE.Vector3;
    /** Forward speed, m/s. */
    speed: number;
}

/** A path for the AI driver: distances along it are in metres of world space. */
export interface DrivePath {
    length: number;
    closed: boolean;
    pointAt(distance: number, out: THREE.Vector3): THREE.Vector3;
    tangentAt(distance: number, out: THREE.Vector3): THREE.Vector3;
}

/**
 * How hard the AI driver corners, as a share of the tyres' grip setting: the ray-cast tyres hold about
 * half their friction coefficient sideways once they also drive and brake, and some is kept in hand.
 */
const AI_CORNER_GRIP = 0.45;
/** How hard the AI driver brakes for what is ahead, m/s². */
const AI_PLAN_DECELERATION = 5;
/** How far behind and ahead of its last place on the path the AI looks for where it is now, metres. */
const AI_SEARCH_BACK = 6;
const AI_SEARCH_AHEAD = 30;
const AI_SEARCH_STEP = 0.5;

const _ahead = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _next = new THREE.Vector3();
const _to = new THREE.Vector3();
const _right = new THREE.Vector3();

export interface PathFollowerState {
    /** Metres along the path of the vehicle's last place on it; null before the first step. */
    progress: number | null;
}

const wrapDistance = (path: DrivePath, distance: number): number =>
    path.closed && path.length > 0 ? ((distance % path.length) + path.length) % path.length : Math.min(path.length, Math.max(0, distance));

/** The vehicle's place along the path: searched near its last place, so a track that crosses itself is not cut short. */
export const trackProgress = (state: PathFollowerState, path: DrivePath, position: THREE.Vector3): number => {
    const from = state.progress === null ? 0 : state.progress - AI_SEARCH_BACK;
    const to = state.progress === null ? path.length : state.progress + AI_SEARCH_AHEAD;
    const step = state.progress === null ? Math.max(AI_SEARCH_STEP, path.length / 400) : AI_SEARCH_STEP;
    let best = state.progress ?? 0;
    let bestDistance = Infinity;
    for (let d = from; d <= to; d += step) {
        const at = path.closed ? wrapDistance(path, d) : Math.min(path.length, Math.max(0, d));
        const distance = path.pointAt(at, _next).distanceToSquared(position);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = at;
        }
    }
    state.progress = best;
    return best;
};

/**
 * The AI driver's controls for this step: pure pursuit of a point a speed-dependent distance ahead
 * on the path, and a speed that keeps the corners ahead within the tyres' grip and stops at the end
 * of an open path.
 */
export const driveAlongPath = (
    state: PathFollowerState,
    path: DrivePath,
    pose: VehiclePose,
    settings: Pick<VehicleSettings, 'aiSpeed' | 'maxSpeed' | 'grip' | 'steerAngle'>,
    wheelbase: number,
): VehicleControls => {
    if (!(path.length > 0.5)) return { ...NO_CONTROLS, handbrake: true };
    const progress = trackProgress(state, path, pose.position);
    const speed = Math.max(0, pose.speed);

    // Steering: pure pursuit towards the look-ahead point.
    // Short enough not to cut a tight bend, long enough not to weave on a straight.
    const lookAhead = THREE.MathUtils.clamp(3 + speed * 0.45, 4, 25);
    const target = path.pointAt(wrapDistance(path, progress + lookAhead), _ahead);
    _to.subVectors(target, pose.position);
    _to.y = 0;
    // Right of a +Z-facing car is -X: forward (fx, fz) gives right (-fz, fx).
    _right.set(-pose.forward.z, 0, pose.forward.x).normalize();
    const ahead = _to.x * pose.forward.x + _to.z * pose.forward.z;
    const lateral = _to.x * _right.x + _to.z * _right.z;
    const alpha = Math.atan2(lateral, Math.max(1e-3, ahead));
    const distance = Math.max(1, Math.hypot(ahead, lateral));
    const wheelAngle = Math.atan((2 * Math.max(0.5, wheelbase) * Math.sin(alpha)) / distance);
    const steer = THREE.MathUtils.clamp(wheelAngle / Math.max(1e-3, THREE.MathUtils.degToRad(settings.steerAngle)), -1, 1);

    // Speed: the cruise speed, held under what each corner ahead (and the path's end) allows.
    let wanted = Math.min(settings.aiSpeed, settings.maxSpeed) * KMH;
    const cornerGrip = AI_CORNER_GRIP * settings.grip * GRAVITY;
    path.tangentAt(wrapDistance(path, progress), _tangent);
    const startHeading = Math.atan2(_tangent.x, _tangent.z);
    const step = Math.max(3, speed * 0.5);
    for (let k = 1; k <= 6; k++) {
        const along = step * k;
        if (!path.closed && progress + along > path.length) break;
        path.tangentAt(wrapDistance(path, progress + along), _tangent);
        let turn = Math.abs(Math.atan2(_tangent.x, _tangent.z) - startHeading);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < 0.02) continue;
        const curvature = turn / along;
        const corner = Math.sqrt(cornerGrip / curvature);
        // Brake in time: the speed from which the corner's speed is reached over the distance left.
        wanted = Math.min(wanted, Math.sqrt(corner * corner + 2 * AI_PLAN_DECELERATION * Math.max(0, along - lookAhead * 0.5)));
    }
    if (!path.closed) wanted = Math.min(wanted, Math.sqrt(2 * AI_PLAN_DECELERATION * Math.max(0, path.length - progress - 1)));

    const error = wanted - speed;
    const atEnd = !path.closed && path.length - progress < 1.5;
    return {
        throttle: atEnd ? 0 : THREE.MathUtils.clamp(error * 0.4 + (wanted > 0.5 ? 0.15 : 0), 0, 1),
        brake: atEnd ? 0 : error < -1 ? THREE.MathUtils.clamp(-error * 0.25, 0, 1) : 0,
        steer,
        handbrake: atEnd && speed < STOPPED_SPEED,
    };
};

// ---------------------------------------------------------------------------
// Play session: which vehicle the player drives
// ---------------------------------------------------------------------------

/** A vehicle in the running session, as the session and level logic see it. */
export interface VehicleHandle {
    objectId: string;
    /** The object's transform group, which follows the chassis body. */
    host: THREE.Object3D;
    playerCanDrive(): boolean;
    /** Forward speed, m/s. */
    speed(): number;
    gear(): number;
    rpm(): number;
    /** Where a driver sits, world space. */
    seat(out: THREE.Vector3): THREE.Vector3;
    /** Half the body's length and width, metres: how near the player must be to get in. */
    reach(): number;
    /** A clear spot beside the vehicle for the driver to step out to, world space, or null when there is none. */
    exitPoint(out: THREE.Vector3): THREE.Vector3 | null;
    /** Controls a level script set, overriding the AI path until released (null). */
    setScriptControls(controls: VehicleControls | null): void;
}

export interface VehicleHud {
    objectId: string;
    /** km/h. */
    speed: number;
    /** 'R', 'N' or 1-6. */
    gear: string;
    /** 0-1 of the redline. */
    rpm: number;
}

export interface VehiclePrompt {
    objectId: string;
    /** The Interact binding, for the hint. */
    key: string;
}

export interface VehicleSessionState {
    /** The vehicle the player drives, or null on foot. */
    driving: string | null;
    /** A vehicle the player is near enough to get into. */
    prompt: VehiclePrompt | null;
    hud: VehicleHud | null;
}

export type VehicleSessionEvent = { type: 'entered' | 'exited'; objectId: string };

export interface VehicleSession {
    state(): VehicleSessionState;
    subscribe(listener: () => void): () => void;
    onEvent(listener: (event: VehicleSessionEvent) => void): () => void;
    register(handle: VehicleHandle): () => void;
    get(objectId: string): VehicleHandle | null;
    all(): VehicleHandle[];
    /** Puts the player in the vehicle; false when it does not exist, cannot be driven or the player already drives it. */
    enter(objectId: string): boolean;
    /** Takes the player out (wherever they are moved to next); false on foot. */
    exit(): boolean;
    setPrompt(prompt: VehiclePrompt | null): void;
    setHud(hud: VehicleHud | null): void;
    /** Forgets everything, for a new play session. */
    reset(): void;
}

const EMPTY_SESSION: VehicleSessionState = { driving: null, prompt: null, hud: null };

const samePrompt = (a: VehiclePrompt | null, b: VehiclePrompt | null) => a === b || (a !== null && b !== null && a.objectId === b.objectId && a.key === b.key);
const sameHud = (a: VehicleHud | null, b: VehicleHud | null) =>
    a === b || (a !== null && b !== null && a.objectId === b.objectId && a.speed === b.speed && a.gear === b.gear && Math.abs(a.rpm - b.rpm) < 0.02);

export const createVehicleSession = (): VehicleSession => {
    let state = EMPTY_SESSION;
    const handles = new Map<string, VehicleHandle>();
    const listeners = new Set<() => void>();
    const eventListeners = new Set<(event: VehicleSessionEvent) => void>();
    const set = (next: VehicleSessionState) => {
        state = next;
        listeners.forEach(listener => listener());
    };
    const emit = (event: VehicleSessionEvent) => eventListeners.forEach(listener => listener(event));
    const session: VehicleSession = {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        onEvent(listener) {
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
        },
        register(handle) {
            handles.set(handle.objectId, handle);
            return () => {
                if (handles.get(handle.objectId) !== handle) return;
                handles.delete(handle.objectId);
                // A vehicle that goes away (destroyed, streamed out) puts its driver back on foot where it was.
                if (state.driving === handle.objectId) session.exit();
                else if (state.prompt?.objectId === handle.objectId) session.setPrompt(null);
            };
        },
        get: objectId => handles.get(objectId) ?? null,
        all: () => [...handles.values()],
        enter(objectId) {
            const handle = handles.get(objectId);
            if (!handle || !handle.playerCanDrive() || state.driving === objectId) return false;
            const previous = state.driving;
            if (previous) emit({ type: 'exited', objectId: previous });
            set({ driving: objectId, prompt: null, hud: null });
            emit({ type: 'entered', objectId });
            return true;
        },
        exit() {
            const driving = state.driving;
            if (!driving) return false;
            set({ ...state, driving: null, hud: null });
            emit({ type: 'exited', objectId: driving });
            return true;
        },
        setPrompt(prompt) {
            if (!samePrompt(prompt, state.prompt)) set({ ...state, prompt });
        },
        setHud(hud) {
            if (!sameHud(hud, state.hud)) set({ ...state, hud });
        },
        reset() {
            handles.clear();
            if (state !== EMPTY_SESSION) set(EMPTY_SESSION);
        },
    };
    return session;
};

/** The play session's vehicles. */
export const vehicleSession = createVehicleSession();

/** The player can get out below this speed, m/s. */
export const VEHICLE_EXIT_SPEED = 3;

const _exit = new THREE.Vector3();

/** True when the driver can get out of `handle` now: slow enough, with room beside it to step out to. */
export const canStepOut = (handle: VehicleHandle): boolean =>
    Math.abs(handle.speed()) < VEHICLE_EXIT_SPEED && handle.exitPoint(_exit) !== null;

/** Gets the player out of the vehicle they drive when they can step out; false when they cannot (or are on foot). */
export const stepOutOfVehicle = (session: VehicleSession = vehicleSession): boolean => {
    const driving = session.state().driving;
    const handle = driving ? session.get(driving) : null;
    return handle !== null && canStepOut(handle) && session.exit();
};

/** Gear as the HUD shows it. */
export const gearLabel = (gear: number, speed: number): string => (gear < 0 ? 'R' : Math.abs(speed) < 0.3 ? 'N' : String(gear));
