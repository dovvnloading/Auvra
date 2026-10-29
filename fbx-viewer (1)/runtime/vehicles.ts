import * as THREE from 'three';
import type { LevelComponent } from '../types';
import type { DifferentialKind } from './vehicleSim';
import type { SurfaceKind } from './surfaces';

/**
 * VEHICLES
 *
 * Wheeled vehicles: a dynamic chassis body held up by a suspension under each wheel and driven by
 * its tyres (runtime/vehicleSim.ts holds the physics). This module holds what is not tied to React
 * or a running world, so it can be tested on its own:
 *
 * - settings, read from the Vehicle component's props;
 * - the driver's controls: throttle, brakes, reverse from a stop, handbrake and speed-sensitive
 *   Ackermann steering;
 * - finding the model's own wheels by name (Wheel_FL, FrontLeftTire, rim_rr ...) and which way the
 *   model faces (from wheel names such as fl and rr, or a setting), or laying out wheels at the
 *   corners of a model that has none;
 * - AI driving along a spline: pure-pursuit steering and a speed plan that brakes for corners
 *   and for the end of an open path;
 * - the play session's vehicles: which one the player drives, the Interact prompt and the HUD.
 *
 * Frames: a vehicle's body frame is its object's world transform without scale. Its vehicle frame
 * is the body frame turned about +Y to the way the model faces: +Z forward, +Y up and +X the
 * vehicle's left (so its right hand is -X).
 */

export const VEHICLE_COMPONENT_TYPE = 'vehicle';

/**
 * Share of a vehicle's mass its colliders carry when the Vehicle owns the body; the rest is added at
 * the vehicle's own centre of mass, low between the wheels, which keeps it from rolling over.
 */
export const VEHICLE_SHELL_MASS_SHARE = 0.1;

export type VehicleDrive = 'rear' | 'front' | 'all';
/** Which way the model's front points in its own space; auto reads it from the wheel names (else +Z). */
export type VehicleFacing = 'auto' | '+z' | '-z' | '+x' | '-x';
/** Headlights: on whenever it is driven, never, or (auto) while it is driven in the dark. */
export type VehicleHeadlights = 'auto' | 'on' | 'off';

const DRIVES: readonly VehicleDrive[] = ['rear', 'front', 'all'];
const FACINGS: readonly VehicleFacing[] = ['auto', '+z', '-z', '+x', '-x'];
const DIFFERENTIALS: readonly DifferentialKind[] = ['open', 'limited', 'locked'];
const HEADLIGHTS: readonly VehicleHeadlights[] = ['auto', 'on', 'off'];

export interface VehicleSettings {
    /** kg. */
    mass: number;
    drive: VehicleDrive;
    /** Engine power, kW. */
    power: number;
    /** Forward gears. */
    gears: number;
    differential: DifferentialKind;
    /** Anti-lock brakes. */
    abs: boolean;
    tractionControl: boolean;
    stabilityControl: boolean;
    facing: VehicleFacing;
    headlights: VehicleHeadlights;
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
    /** Tyre grip: peak friction coefficient (1 is a road tyre, 1.3 a sports tyre). */
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
    gears: 6,
    differential: 'limited',
    abs: true,
    tractionControl: true,
    stabilityControl: true,
    facing: 'auto',
    headlights: 'auto',
    maxSpeed: 160,
    reverseSpeed: 30,
    braking: 9,
    steerAngle: 35,
    steerAtSpeed: 0.3,
    grip: 1.2,
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
        gears: Math.round(clampNumber(p.gears, d.gears, 1, 10)),
        differential: typeof p.differential === 'string' && (DIFFERENTIALS as readonly string[]).includes(p.differential) ? p.differential as DifferentialKind : d.differential,
        abs: typeof p.abs === 'boolean' ? p.abs : d.abs,
        tractionControl: typeof p.tractionControl === 'boolean' ? p.tractionControl : d.tractionControl,
        stabilityControl: typeof p.stabilityControl === 'boolean' ? p.stabilityControl : d.stabilityControl,
        facing: typeof p.facing === 'string' && (FACINGS as readonly string[]).includes(p.facing) ? p.facing as VehicleFacing : d.facing,
        headlights: typeof p.headlights === 'string' && (HEADLIGHTS as readonly string[]).includes(p.headlights) ? p.headlights as VehicleHeadlights : d.headlights,
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

/** Below this the vehicle counts as stopped: the brake pedal starts reversing, throttle starts forward. */
const STOPPED_SPEED = 0.8;
/** Steering moves towards the wheel's position at this many full locks per second, and back faster. */
const STEER_RATE = 2.2;
const STEER_RETURN_RATE = 3.5;
/** Front share of the brakes. */
export const FRONT_BRAKE_SHARE = 0.6;
/** Front share of the drive on all-wheel drive. */
export const FRONT_DRIVE_SHARE = 0.4;

/** The controls' own state between steps. */
export interface VehicleControlState {
    /** Current front-wheel steering, radians, positive turning right. */
    steer: number;
    reversing: boolean;
}

export const createControlState = (): VehicleControlState => ({ steer: 0, reversing: false });

/** What the controls ask of the vehicle this step. */
export interface VehiclePedals {
    /** Engine throttle, 0-1 (the brake pedal while reversing). */
    throttle: number;
    /** Service brakes, 0-1. */
    brake: number;
    /** In reverse gear. */
    reverse: boolean;
    handbrake: boolean;
    /** Steering angle of the front axle's centre, radians, positive turning right. */
    steer: number;
}

const moveTowards = (value: number, target: number, step: number): number =>
    value < target ? Math.min(target, value + step) : Math.max(target, value - step);

/**
 * One step of the driver's controls. `speed` is the chassis's forward speed (m/s, negative rolling
 * backwards). Throttle drives forward and brakes a car rolling back; the brake pedal brakes a car
 * rolling forward and reverses one that has stopped, up to the reverse speed. Steering eases
 * towards the wheel's position, with less lock at speed.
 */
export const stepVehicleControls = (
    state: VehicleControlState,
    controls: VehicleControls,
    speed: number,
    dt: number,
    settings: Pick<VehicleSettings, 'maxSpeed' | 'reverseSpeed' | 'steerAngle' | 'steerAtSpeed'>,
): VehiclePedals => {
    const throttle = Math.min(1, Math.max(0, controls.throttle || 0));
    const pedal = Math.min(1, Math.max(0, controls.brake || 0));
    const steerInput = Math.min(1, Math.max(-1, controls.steer || 0));

    // Which way the driver means to go: reverse is chosen only from a stop.
    if (speed > STOPPED_SPEED) state.reversing = false;
    else if (speed < -STOPPED_SPEED) state.reversing = true;
    else if (pedal > 0 && throttle === 0) state.reversing = true;
    else if (throttle > 0) state.reversing = false;

    let engine = 0;
    let brake = 0;
    if (state.reversing) {
        // Throttle brakes a car rolling backwards; the pedal drives it back, up to the reverse speed.
        if (throttle > 0 && speed < -STOPPED_SPEED) brake = throttle;
        else if (pedal > 0 && -speed < settings.reverseSpeed * KMH) engine = pedal;
    } else {
        if (pedal > 0 && speed > STOPPED_SPEED) brake = pedal;
        else if (throttle > 0) engine = throttle;
    }

    const atSpeed = Math.min(1, Math.abs(speed) / Math.max(1, settings.maxSpeed * KMH));
    const lock = THREE.MathUtils.degToRad(settings.steerAngle) * (1 - (1 - settings.steerAtSpeed) * atSpeed);
    const wanted = steerInput * lock;
    const returning = Math.abs(wanted) < Math.abs(state.steer) || Math.sign(wanted) !== Math.sign(state.steer);
    const rate = (returning ? STEER_RETURN_RATE : STEER_RATE) * Math.max(lock, 1e-3) * dt;
    state.steer = moveTowards(state.steer, wanted, rate);

    return { throttle: engine, brake, reverse: state.reversing, handbrake: controls.handbrake, steer: state.steer };
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

/** Where a wheel's name puts it: fl, rr, lf, front, rear, left, right ...; undefined where it says nothing. */
export const wheelNameTags = (name: string): { front?: boolean; left?: boolean } => {
    const tags: { front?: boolean; left?: boolean } = {};
    for (const word of nameWords(name)) {
        if (word === 'front') tags.front = true;
        else if (word === 'rear' || word === 'back') tags.front = false;
        else if (word === 'left') tags.left = true;
        else if (word === 'right') tags.left = false;
        else if (/^[fbr][lr]$/.test(word)) {
            tags.front = word[0] === 'f';
            tags.left = word[1] === 'l';
        } else if (/^[lr][fb]$/.test(word)) {
            tags.left = word[0] === 'l';
            tags.front = word[1] === 'f';
        }
    }
    return tags;
};

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
    /** Wheels in the vehicle frame. */
    wheels: VehicleWheel[];
    /** The bounds of the body without its wheels, in the vehicle frame. */
    chassis: THREE.Box3;
    /** True when the wheels were laid out from the body because the model names none. */
    generated: boolean;
    /** Turns the vehicle frame into the body frame (a quarter turn about +Y, or none). */
    facing: THREE.Quaternion;
}

const FACING_YAW: Record<Exclude<VehicleFacing, 'auto'>, number> = { '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 };

/** The facing whose front is nearest the body-frame direction (x, z). */
const facingOf = (x: number, z: number): Exclude<VehicleFacing, 'auto'> =>
    Math.abs(z) >= Math.abs(x) ? (z >= 0 ? '+z' : '-z') : (x >= 0 ? '+x' : '-x');

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

const UNIT = new THREE.Vector3(1, 1, 1);
const ORIGIN = new THREE.Vector3();

/** The vehicle frame of `host`: its chassis frame turned to the way its model faces. */
export const vehicleFrame = (host: THREE.Object3D, facing: THREE.Quaternion, out = new THREE.Matrix4()): THREE.Matrix4 =>
    chassisFrame(host, out).multiply(_frame.compose(ORIGIN, facing, UNIT));

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
    facingSetting: VehicleFacing = 'auto',
): VehicleLayout => {
    host.updateWorldMatrix(true, true);
    _inverse.copy(chassisFrame(host, _frame)).invert();
    const toChassis = _inverse.clone();
    const nodes = findWheelNodes(host, skip);
    const wheelSet = new Set(nodes);
    const isWheel = (node: THREE.Object3D) => wheelSet.has(node) || Boolean(skip?.(node));
    const bodyBox = boundsInFrame(host, toChassis, new THREE.Box3(), isWheel);

    // Group nodes that share a centre (tyre, rim, brake disc) into one wheel; its name tags say where it sits.
    const groups: { box: THREE.Box3; nodes: THREE.Object3D[]; front?: boolean; left?: boolean }[] = [];
    for (const node of nodes) {
        const box = boundsInFrame(node, toChassis, new THREE.Box3(), skip);
        if (box.isEmpty()) continue;
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        const own = Math.max(size.x, size.y, size.z) / 2;
        const tags = wheelNameTags(node.name);
        const match = groups.find(group => group.box.getCenter(_position).distanceTo(centre) < SAME_WHEEL * Math.max(own, 0.05));
        const group = match ?? { box: new THREE.Box3(), nodes: [] as THREE.Object3D[] };
        group.box.union(box);
        group.nodes.push(node);
        if (tags.front !== undefined) group.front = tags.front;
        if (tags.left !== undefined) group.left = tags.left;
        if (!match) groups.push(group);
    }

    // Which way the model faces: the setting, else from the front and rear wheels' names, else +Z.
    let facingName: Exclude<VehicleFacing, 'auto'> = facingSetting === 'auto' ? '+z' : facingSetting;
    if (facingSetting === 'auto') {
        const front = new THREE.Vector3();
        const rear = new THREE.Vector3();
        let fronts = 0;
        let rears = 0;
        for (const group of groups) {
            if (group.front === true) { front.add(group.box.getCenter(_position)); fronts++; }
            if (group.front === false) { rear.add(group.box.getCenter(_position)); rears++; }
        }
        if (fronts && rears) {
            front.divideScalar(fronts).sub(rear.divideScalar(rears));
            facingName = facingOf(front.x, front.z);
        }
    }
    const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), FACING_YAW[facingName]);
    // Body frame into the vehicle frame.
    const toVehicle = new THREE.Matrix4().makeRotationFromQuaternion(facing.clone().invert());
    const chassis = bodyBox.isEmpty() ? bodyBox : bodyBox.clone().applyMatrix4(toVehicle);

    if (groups.length >= 3) {
        const boxes = groups.map(group => group.box.clone().applyMatrix4(toVehicle));
        const mean = new THREE.Vector3();
        for (const box of boxes) mean.add(box.getCenter(_position));
        mean.divideScalar(boxes.length);
        const wheels = groups.map((group, index) => {
            const size = boxes[index].getSize(new THREE.Vector3());
            const centre = boxes[index].getCenter(new THREE.Vector3());
            return {
                centre,
                radius: radius > 0 ? radius : Math.max(0.02, Math.max(size.y, size.z) / 2),
                width: Math.max(0.02, size.x),
                front: group.front ?? centre.z > mean.z,
                left: group.left ?? centre.x > mean.x,
                nodes: group.nodes,
            };
        });
        if (chassis.isEmpty()) for (const wheel of wheels) chassis.expandByPoint(wheel.centre);
        return { wheels, chassis, generated: false, facing };
    }

    // No wheels in the model: four at the corners of its body, poking out below it.
    const box = chassis.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -1), new THREE.Vector3(0.5, 1, 1)) : chassis;
    const size = box.getSize(new THREE.Vector3());
    const r = radius > 0 ? radius : THREE.MathUtils.clamp(Math.min(size.x, size.z) * 0.2, 0.08, 1.2);
    const width = THREE.MathUtils.clamp(r * 0.7, 0.04, size.x / 3);
    const x = Math.max(0.05, size.x / 2 - width / 2);
    const z = Math.max(0.1, size.z / 2 - r * 1.1);
    const centreX = (box.min.x + box.max.x) / 2;
    const centreZ = (box.min.z + box.max.z) / 2;
    const y = box.min.y + r * 0.45;
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
    return { wheels, chassis: box.clone(), generated: true, facing };
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

/** The braking an AI driver plans on, m/s², and the gap it stops short of what is ahead, metres. */
export const AI_BRAKING = 6;
export const AI_STOP_GAP = 3.5;

/** The fastest an AI driver may go and still stop AI_STOP_GAP short of something `distance` metres ahead. */
export const obstacleSpeedLimit = (distance: number): number =>
    Math.sqrt(2 * AI_BRAKING * Math.max(0, distance - AI_STOP_GAP));

/** How far ahead an AI driver looks for what it must stop for at `speed`, metres. */
export const obstacleLookAhead = (speed: number): number => AI_STOP_GAP + 4 + (speed * speed) / (2 * AI_BRAKING);

/**
 * An AI driver's controls held to what is `distance` metres ahead (Infinity when nothing is): no
 * throttle once it is at the speed it could still stop from, and the brake harder the further over.
 */
export const avoidAhead = (controls: VehicleControls, speed: number, distance: number): VehicleControls => {
    if (!Number.isFinite(distance)) return controls;
    const limit = obstacleSpeedLimit(distance);
    // Inside the gap it holds still rather than creeping up.
    if (limit > 0 && speed <= limit * 0.85) return controls;
    const over = speed - limit * 0.85;
    return { ...controls, throttle: 0, brake: Math.max(controls.brake, THREE.MathUtils.clamp(over * 0.35, 0.2, 1)) };
};

/**
 * Seconds an AI driver trying to move but pinned in place waits before backing out, how long it
 * waits held up by something in its way that does not move off, and how long it backs out for.
 */
export const AI_STUCK_TIME = 2.5;
export const AI_BLOCKED_TIME = 5;
export const AI_BACK_OUT_TIME = 1.6;

export interface AiRecoveryState {
    /** Seconds pinned so far. */
    stuck: number;
    /** Seconds held up so far. */
    blocked: number;
    /** Seconds of backing out left. */
    backing: number;
}

export const createAiRecovery = (): AiRecoveryState => ({ stuck: 0, blocked: 0, backing: 0 });

/**
 * An AI driver against a wall or another car: once it has tried to move for AI_STUCK_TIME without
 * getting anywhere, or has been held up close behind something for AI_BLOCKED_TIME (`blocked`: what
 * is ahead is inside its stopping gap), it backs out for AI_BACK_OUT_TIME with the steering turned
 * the other way, then drives on. `wanted` is what it would do with nothing in the way; returns the
 * controls to use.
 */
export const stepAiRecovery = (
    state: AiRecoveryState,
    wanted: VehicleControls,
    controls: VehicleControls,
    blocked: boolean,
    speed: number,
    dt: number,
): VehicleControls => {
    const backOut = { throttle: 0, brake: 1, steer: -wanted.steer, handbrake: false };
    if (state.backing > 0) {
        state.backing = Math.max(0, state.backing - dt);
        return backOut;
    }
    const trying = wanted.throttle > 0.2 && !wanted.handbrake;
    const still = Math.abs(speed) < 0.8;
    state.stuck = trying && still && controls.throttle > 0 ? state.stuck + dt : 0;
    state.blocked = trying && still && blocked ? state.blocked + dt : 0;
    if (state.stuck > AI_STUCK_TIME || state.blocked > AI_BLOCKED_TIME) {
        state.stuck = 0;
        state.blocked = 0;
        state.backing = AI_BACK_OUT_TIME;
        return backOut;
    }
    return controls;
};

/** A vehicle lying further over than this (its up against the world's, as a cosine) for RIGHT_AFTER seconds, nearly still, is set back on its wheels. */
export const UPRIGHT_DOT = 0.35;
export const RIGHT_AFTER = 2;

export interface UprightState {
    /** Seconds it has lain over. */
    over: number;
}

/** True when the vehicle should be righted now: it has lain over, barely moving, for RIGHT_AFTER seconds. */
export const stepUpright = (state: UprightState, upDot: number, speed: number, dt: number): boolean => {
    state.over = upDot < UPRIGHT_DOT && speed < 2 ? state.over + dt : 0;
    if (state.over < RIGHT_AFTER) return false;
    state.over = 0;
    return true;
};

const _heading = new THREE.Vector3();

/**
 * The body rotation that puts a vehicle back on its wheels facing where it was heading: its frame's
 * front levelled onto the ground, its up the world's. `facing` turns the body into the vehicle frame.
 */
export const uprightRotation = (vehicle: THREE.Quaternion, facing: THREE.Quaternion, out = new THREE.Quaternion()): THREE.Quaternion => {
    _heading.set(0, 0, 1).applyQuaternion(vehicle).setY(0);
    // Pointing straight up or down: fall back on where its roof faced.
    if (_heading.lengthSq() < 1e-6) _heading.set(0, 1, 0).applyQuaternion(vehicle).setY(0);
    const yaw = _heading.lengthSq() < 1e-6 ? 0 : Math.atan2(_heading.x, _heading.z);
    return out.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(facing.clone().invert());
};

// ---------------------------------------------------------------------------
// Play session: which vehicle the player drives
// ---------------------------------------------------------------------------

/** A vehicle in the running session, as the session and level logic see it. */
/** One wheel as the simulation last stepped it. */
export interface WheelTelemetry {
    front: boolean;
    left: boolean;
    /** On the ground. */
    contact: boolean;
    /** What the ground under it is made of (the last ground it touched while in the air). */
    surface: SurfaceKind;
    /** Suspension load, N. */
    load: number;
    /** Longitudinal slip ratio: positive spinning, negative locking. */
    slipRatio: number;
    /** Slip angle, radians. */
    slipAngle: number;
    /** Spin, rad/s. */
    omega: number;
    /** Suspension compression, metres from full extension. */
    compression: number;
    /** Where the tyre touches the ground, world space (meaningful while in contact). */
    contactPoint: THREE.Vector3;
    /** The ground's normal under the tyre, world space. */
    contactNormal: THREE.Vector3;
    /** The contact's speed over the ground, m/s. */
    groundSpeed: number;
}

/** The vehicle's state for effects, sound, HUDs and debugging: read it, never write it. */
export interface VehicleTelemetry {
    /** Forward speed, m/s. */
    speed: number;
    rpm: number;
    idleRpm: number;
    redlineRpm: number;
    /** Gear engaged (-1 reverse); while shifting, the one being shifted into. */
    gear: number;
    /** Seconds left of a gear change under way. */
    shifting: number;
    /** What the engine is given after the assists, 0-1. */
    throttle: number;
    brake: number;
    handbrake: boolean;
    /** Front axle steering, radians, positive right. */
    steer: number;
    /** The assists acting this step. */
    absActive: boolean;
    tractionActive: boolean;
    stabilityActive: boolean;
    /** The last knock (an impact or a hard landing), 0-1, dying away over a moment: for camera shake and the like. */
    impact: number;
    wheels: WheelTelemetry[];
}

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
    /** The simulation's last step, or null before it has run. */
    telemetry(): VehicleTelemetry | null;
    /** The vehicle frame in world space: +Z its front, +X its left, +Y its up (the model may face any way). */
    frame(out: THREE.Matrix4): THREE.Matrix4;
    /** Its body's bounds in the vehicle frame, without the wheels, or null before it is measured. */
    chassis(): THREE.Box3 | null;
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
