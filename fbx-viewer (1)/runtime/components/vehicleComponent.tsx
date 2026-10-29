import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import type { RapierCollider, RapierRigidBody } from '@react-three/rapier';
import type { LevelComponent, LevelObject } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { dialogueStore } from '../dialogue';
import { useGameContent } from '../GameContentContext';
import { objectIdFromCollider, objectIdFromRigidBody, PLAYER_PHYSICS_ID, usePhysicsAvailable, usePhysicsQueries } from '../physics';
import { useRuntimeServices } from '../RuntimeServicesContext';
import { SpatialParamWriter, SpatialPositionalAudio } from '../spatialAudio';
import { releaseSkidMarks, skidMarks } from '../skidMarks';
import { SURFACES, surfaceOfHit, type SurfaceKind } from '../surfaces';
import { createWorldSplineFrame, getLiveSpline, liveSplineWorldScale, sampleLiveSpline, type LiveSpline } from '../splineRegistry';
import {
    ackermannAngles,
    AI_STOP_GAP,
    avoidAhead,
    createAiRecovery,
    createControlState,
    driveAlongPath,
    FRONT_BRAKE_SHARE,
    FRONT_DRIVE_SHARE,
    gearLabel,
    GRAVITY,
    KMH,
    NO_CONTROLS,
    obstacleLookAhead,
    planVehicleLayout,
    readVehicleSettings,
    restingSag,
    stepAiRecovery,
    stepOutOfVehicle,
    stepUpright,
    stepVehicleControls,
    uprightRotation,
    VEHICLE_COMPONENT_TYPE,
    VEHICLE_DEFAULTS,
    VEHICLE_SHELL_MASS_SHARE,
    vehicleFrame,
    vehicleSession,
    wheelGeometry,
    type DrivePath,
    type PathFollowerState,
    type VehicleControls,
    type VehicleControlState,
    type VehicleHandle,
    type VehicleLayout,
    type VehicleSettings,
    type VehicleTelemetry,
} from '../vehicles';
import {
    absBrake,
    createTransmission,
    driveTorque,
    planEngine,
    planGearbox,
    planSuspension,
    splitAxleTorque,
    stabilityCorrection,
    stepTransmission,
    stepWheel,
    suspensionForce,
    createTractionControl,
    stepTractionControl,
    wheelInertia,
    type DriveTorque,
    type EngineSpec,
    type Gearbox,
    type SuspensionSpec,
    type TractionControlState,
    type TransmissionState,
    type WheelDynamics,
    type WheelStepResult,
} from '../vehicleSim';
import { acquireAudioListener, findAudioAsset, releaseSound, routeSoundToBus } from './audioComponents';
import { ComponentHostContext } from './builtins';
import { interactKeyLabel } from './dialogueComponent';
import { IKPlayerTargetContext } from './ikComponents';
import { isPhysicsIgnored, PHYSICS_IGNORED_USER_DATA, PhysicsOwnerBody, planPhysicsBody } from './physicsComponents';
import { createTyreEffects, stepTyreEffects } from './tyreEffects';
import { ENGINE_PARAMS, engineSoundValues, ROAD_PARAMS, roadSoundValues, synthesizeEngine, synthesizeRoad, type RoadVoice } from './vehicleAudio';
import { buildVehicleLights, disposeVehicleLights, setVehicleLights, type VehicleLights } from './vehicleLights';
import { sceneDaylight } from '../daylight';
import { weatherGrip, worldClock } from '../weather';
import { weatherCover } from '../weatherCover';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/** Air drag, N per (m/s)²: about a road car's. */
const AIR_DRAG = 0.4;
/** The player gets in within this far of the body's edge, metres. */
const ENTER_MARGIN = 1.6;
/** How far beside the body the driver steps out, metres. */
const EXIT_GAP = 0.7;
/** An AI vehicle knocked further than this off its path looks for the nearest stretch of it again, metres. */
const AI_REJOIN_DISTANCE = 25;
/** Wheel-spin steps per physics step: the tyres are stiff against a wheel's small inertia. */
const WHEEL_SUBSTEPS = 4;
/**
 * How much shorter than the ray's answer the tyre's shape cast must find the suspension before it is
 * believed (a kerb or an edge under the tread), metres: shape casts are only good to a few millimetres,
 * which the damper would turn into a buzz.
 */
const KERB_MARGIN = 0.015;
/** Below this speed (m/s) a held brake (or a parked car) holds the car still instead of letting the tyres creep. */
const HOLD_SPEED = 0.6;
/** Seconds the driver's door takes to swing open, stays open, and swings shut as they get in or out. */
const DOOR_OPEN = 0.35;
const DOOR_HOLD = 0.35;
const DOOR_CLOSE = 0.4;
/** Auto headlights come on below this much daylight (0 night, 1 day): from dusk. */
const HEADLIGHT_DAYLIGHT = 0.35;
/** How far a door swings open, radians. */
const DOOR_ANGLE = THREE.MathUtils.degToRad(62);

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();
const AXLE = new THREE.Vector3(1, 0, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
/** Turns a Rapier cylinder (axis +Y) to lie along +X, a wheel's axle. */
const CYLINDER_TO_AXLE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

const isNestedObject = (node: THREE.Object3D, objectId: string): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId;
};

/** Leaves out nested objects and helpers (previews, generated wheels) when the vehicle measures its model. */
const notModel = (objectId: string) => (node: THREE.Object3D): boolean => isNestedObject(node, objectId) || isPhysicsIgnored(node);

/** The suspension casts pass through the player's capsule, which rides inside the car while it is driven. */
const notPlayer = (collider: RapierCollider): boolean =>
    objectIdFromCollider(collider) !== PLAYER_PHYSICS_ID && objectIdFromRigidBody(collider.parent()) !== PLAYER_PHYSICS_ID;

/** A live spline as a path in world metres for the AI driver. */
const splineDrivePath = (entry: LiveSpline): DrivePath => {
    const scale = liveSplineWorldScale(entry);
    const frame = createWorldSplineFrame();
    return {
        length: entry.spline.length * scale,
        closed: entry.spline.closed,
        pointAt: (distance, out) => out.copy(sampleLiveSpline(entry, distance / scale, frame).position),
        tangentAt: (distance, out) => out.copy(sampleLiveSpline(entry, distance / scale, frame).tangent),
    };
};

// ---------------------------------------------------------------------------
// Nodes the vehicle moves: wheels and doors
// ---------------------------------------------------------------------------

/** A node that turns about a point (a wheel's centre, a door's hinge), and where it sat at rest. */
interface PivotNode {
    node: THREE.Object3D;
    restQuaternion: THREE.Quaternion;
    /** From the node's origin to its pivot, in the node's own orientation (parent-space lengths). */
    toPivot: THREE.Vector3;
}

const _hostPosition = new THREE.Vector3();
const _hostQuaternion = new THREE.Quaternion();
const _hostScale = new THREE.Vector3();
const _vehicleQuaternion = new THREE.Quaternion();
const _vehicleInverse = new THREE.Quaternion();
const _world = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _steer = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _parentQuaternion = new THREE.Quaternion();
const _parentInverse = new THREE.Quaternion();
const _offset = new THREE.Vector3();
const _scratch = new THREE.Vector3();

const restPivotNode = (node: THREE.Object3D, worldPivot: THREE.Vector3): PivotNode | null => {
    const parent = node.parent;
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    const pivot = parent.worldToLocal(worldPivot.clone());
    return {
        node,
        restQuaternion: node.quaternion.clone(),
        toPivot: pivot.sub(node.position).applyQuaternion(node.quaternion.clone().invert()),
    };
};

/** Turns `entry` by the world rotation `turn` about the world point `pivot`. */
const placePivotNode = (entry: PivotNode, turn: THREE.Quaternion, pivot: THREE.Vector3): void => {
    const parent = entry.node.parent;
    if (!parent) return;
    parent.getWorldQuaternion(_parentQuaternion);
    _parentInverse.copy(_parentQuaternion).invert();
    entry.node.quaternion.copy(_parentInverse).multiply(turn).multiply(_parentQuaternion).multiply(entry.restQuaternion);
    const local = parent.worldToLocal(_offset.copy(pivot));
    entry.node.position.copy(local).sub(_scratch.copy(entry.toPivot).applyQuaternion(entry.node.quaternion));
};

/** A plain wheel for a model without its own: a tyre with a hub, its axle along X. */
const buildGeneratedWheel = (radius: number, width: number): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'VehicleWheel';
    group.userData = { ...PHYSICS_IGNORED_USER_DATA };
    const tyre = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, width, 24).rotateZ(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: '#1c1c1e', roughness: 0.92 }),
    );
    const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width * 1.04, 12).rotateZ(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: '#a1a1aa', roughness: 0.4, metalness: 0.7 }),
    );
    for (const mesh of [tyre, hub]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.raycast = () => undefined;
        group.add(mesh);
    }
    return group;
};

/** A door of the model, with its window and handle: it swings about its front edge. */
interface VehicleDoor {
    nodes: PivotNode[];
    /** Hinge at the door's front edge, outer side, vehicle frame. */
    hinge: THREE.Vector3;
    left: boolean;
    /** The front door on the driver's (left) side: the one that opens as they get in and out. */
    driver: boolean;
}

const DOOR_WORD = /(^|[^a-z])door([^a-z]|$)/i;

/**
 * The model's doors: nodes named with the word 'door' (a door's window or handle as well), grouped
 * by side and by where along the body they sit, so each door's parts swing about one hinge.
 */
const findDoors = (host: THREE.Object3D, layout: VehicleLayout, frame: THREE.Matrix4, skip: (node: THREE.Object3D) => boolean): VehicleDoor[] => {
    const toVehicle = frame.clone().invert();
    const parts: { node: THREE.Object3D; box: THREE.Box3 }[] = [];
    const visit = (node: THREE.Object3D) => {
        for (const child of node.children) {
            if (skip(child)) continue;
            if (DOOR_WORD.test(child.name.replace(/[_.]/g, ' ')) && !layout.wheels.some(wheel => wheel.nodes.includes(child))) {
                const box = new THREE.Box3().setFromObject(child).applyMatrix4(toVehicle);
                if (!box.isEmpty()) {
                    parts.push({ node: child, box });
                    continue;
                }
            }
            visit(child);
        }
    };
    visit(host);
    // Biggest first, so a door's panel sets its group before its window and handle join it.
    const volume = (box: THREE.Box3) => { const size = box.getSize(_scratch); return size.x * size.y * size.z; };
    parts.sort((a, b) => volume(b.box) - volume(a.box));
    const middle = (layout.chassis.min.x + layout.chassis.max.x) / 2;
    const groups: { box: THREE.Box3; nodes: THREE.Object3D[]; left: boolean }[] = [];
    for (const part of parts) {
        const centre = part.box.getCenter(new THREE.Vector3());
        const left = centre.x > middle;
        const group = groups.find(entry => entry.left === left && centre.z >= entry.box.min.z && centre.z <= entry.box.max.z);
        if (group) {
            group.box.union(part.box);
            group.nodes.push(part.node);
        } else groups.push({ box: part.box.clone(), nodes: [part.node], left });
    }
    const driver = groups.filter(group => group.left).sort((a, b) => b.box.max.z - a.box.max.z)[0];
    return groups.map(group => {
        const centre = group.box.getCenter(new THREE.Vector3());
        const hinge = new THREE.Vector3(group.left ? group.box.max.x : group.box.min.x, centre.y, group.box.max.z);
        const worldHinge = hinge.clone().applyMatrix4(frame);
        return {
            nodes: group.nodes.map(node => restPivotNode(node, worldHinge)).filter((entry): entry is PivotNode => entry !== null),
            hinge,
            left: group.left,
            driver: group === driver,
        };
    });
};

// ---------------------------------------------------------------------------
// Engine sound
// ---------------------------------------------------------------------------

interface EngineVoice {
    sound: SpatialPositionalAudio;
    writer: SpatialParamWriter | null;
    stop: () => void;
    /** For an engine recording: the rate and volume last set. */
    recorded: { rate: number; volume: number } | null;
}

const _engineValues = new Float64Array(ENGINE_PARAMS);
const _roadValues = new Float64Array(ROAD_PARAMS);
/** A frame's change in chassis velocity past this (m/s) is an impact; knocks are this far apart at least, seconds. */
const IMPACT_SPEED = 2.5;
const KNOCK_GAP = 0.15;
/** A wheel back on the ground after this long in the air lands with a knock, seconds. */
const LANDING_AIRTIME = 0.25;
/** How fast a knock's telemetry dies away, per second. */
const IMPACT_DECAY = 6;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type RapierModule = ReturnType<typeof useRapier>['rapier'];
type RapierShape = InstanceType<RapierModule['Cylinder']>;

/** One simulated wheel. */
interface SimWheel {
    front: boolean;
    left: boolean;
    driven: boolean;
    radius: number;
    halfWidth: number;
    /** Top of the suspension's travel (the wheel centre at full compression), vehicle frame. */
    anchor: THREE.Vector3;
    dynamics: WheelDynamics;
    shape: RapierShape;
    /** Metres from full extension. */
    compression: number;
    load: number;
    contact: boolean;
    /** Steering angle, radians, positive towards the vehicle's left. */
    steer: number;
    /** Spin angle for the model, radians. */
    rotation: number;
    slipRatio: number;
    slipAngle: number;
    /** World-space contact point while in contact. */
    contactPoint: THREE.Vector3;
    contactNormal: THREE.Vector3;
    /** What the ground under it is made of. */
    surface: SurfaceKind;
    /** The contact's speed over the ground, m/s. */
    groundSpeed: number;
}

interface VehicleRig {
    body: RapierRigidBody;
    layout: VehicleLayout;
    wheels: SimWheel[];
    engine: EngineSpec;
    gearbox: Gearbox;
    suspension: SuspensionSpec;
    transmission: TransmissionState;
    traction: TractionControlState;
    drive: DriveTorque;
    wheelbase: number;
    track: number;
    nodes: PivotNode[][];
    doors: VehicleDoor[];
    lights: VehicleLights;
    generated: THREE.Group[];
    /** Engine speed shown and heard, eased. */
    rpm: number;
    /** Throttle the engine is under, for its note. */
    load: number;
    /** Seconds into the driver's door opening and closing; null when shut. */
    doorTime: number | null;
    /** The last step, for effects, sound and the session. */
    telemetry: VehicleTelemetry;
}

interface VehicleRuntimeProps {
    object: LevelObject;
    component: LevelComponent;
    settings: VehicleSettings;
}

const _bodyQuaternion = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _linear = new THREE.Vector3();
const _angular = new THREE.Vector3();
const _com = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _heading = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _force = new THREE.Vector3();
const _shapeRotation = new THREE.Quaternion();
const _direction = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _righted = new THREE.Quaternion();
const _axle = new THREE.Vector3();
const _down = { x: 0, y: -1, z: 0 };
const _result: WheelStepResult = { fx: 0, fy: 0, slipRatio: 0, slipAngle: 0 };

const VehicleRuntime: React.FC<VehicleRuntimeProps> = ({ object, component, settings }) => {
    const hostRef = useContext(ComponentHostContext);
    const anchorRef = useRef<THREE.Group>(null);
    const { world, rapier } = useRapier();
    const { input, mixer } = useRuntimeServices();
    const { audioAssets } = useGameContent();
    const queries = usePhysicsQueries();
    const { camera } = useThree();
    const [host, setHost] = useState<THREE.Object3D | null>(null);
    const rig = useRef<VehicleRig | null>(null);
    const controlState = useRef<VehicleControlState>(createControlState());
    const follower = useRef<PathFollowerState>({ progress: null });
    // An AI driver backing out when pinned, and any vehicle set back on its wheels once it has lain over a while.
    const recovery = useRef(createAiRecovery());
    const upright = useRef({ over: 0 });
    const scriptControls = useRef<VehicleControls | null>(null);
    const engine = useRef<EngineVoice | null>(null);
    const road = useRef<{ sound: SpatialPositionalAudio; voice: RoadVoice } | null>(null);
    // Knocks: the chassis's velocity last frame, each wheel's time in the air, and when the last knock was.
    const knocks = useRef({ velocity: new THREE.Vector3(), primed: false, airborne: [] as number[], last: 0, clock: 0 });
    // Smoke, dust and marks from the tyres: world-space, so they stay where they were laid.
    const effects = useMemo(createTyreEffects, []);
    useEffect(() => () => effects.dispose(), [effects]);
    const objectId = object.id;
    const ownsBody = useMemo(() => planPhysicsBody(object)?.ownerId === component.id, [object, component.id]);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    useLayoutEffect(() => {
        setHost(hostRef?.current ?? anchorRef.current?.parent ?? null);
    }, [hostRef]);

    const dispose = (current: VehicleRig) => {
        for (const group of current.generated) group.removeFromParent();
        disposeVehicleLights(current.lights);
    };
    useLayoutEffect(() => () => {
        const current = rig.current;
        rig.current = null;
        if (current) dispose(current);
    }, []);

    /** Builds the simulation once the chassis body exists. */
    const build = (target: THREE.Object3D, body: RapierRigidBody): VehicleRig | null => {
        const s = settingsRef.current;
        const skip = notModel(objectId);
        const layout = planVehicleLayout(target, s.wheelRadius, skip, s.facing);
        if (layout.wheels.length === 0) return null;
        const count = layout.wheels.length;
        const suspension = planSuspension(s.mass, count, s.suspensionStiffness, s.suspensionDamping, s.suspensionTravel);
        const sag = restingSag(s, count);
        const meanRadius = layout.wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / count;
        const engineSpec = planEngine(s.power);
        const gearbox = planGearbox(s.maxSpeed * KMH, meanRadius, engineSpec.redlineRpm, s.gears);
        const wheels: SimWheel[] = layout.wheels.map(wheel => ({
            front: wheel.front,
            left: wheel.left,
            driven: s.drive === 'all' || (s.drive === 'front') === wheel.front,
            radius: wheel.radius,
            halfWidth: Math.max(0.01, wheel.width / 2),
            // Anchored so that, sagging under the car's weight, the wheel sits where the model draws it.
            anchor: wheel.centre.clone().addScaledVector(UP, Math.max(0, s.suspensionTravel - sag)),
            dynamics: { omega: 0, radius: wheel.radius, inertia: wheelInertia(wheel.radius) },
            shape: new rapier.Cylinder(Math.max(0.01, wheel.width / 2), wheel.radius),
            compression: 0,
            load: 0,
            contact: false,
            steer: 0,
            rotation: 0,
            slipRatio: 0,
            slipAngle: 0,
            contactPoint: new THREE.Vector3(),
            contactNormal: new THREE.Vector3(0, 1, 0),
            surface: 'default',
            groundSpeed: 0,
        }));
        if (ownsBody) {
            // Most of the mass sits low between the wheels, with the body's inertia, so it corners flat.
            const size = layout.chassis.getSize(new THREE.Vector3());
            const centre = layout.chassis.getCenter(new THREE.Vector3());
            const wheelHeight = layout.wheels.reduce((sum, wheel) => sum + wheel.centre.y, 0) / count;
            const mass = s.mass * (1 - VEHICLE_SHELL_MASS_SHARE);
            const [w, h, l] = [Math.max(0.1, size.x), Math.max(0.1, size.y), Math.max(0.1, size.z)];
            const com = new THREE.Vector3(centre.x, wheelHeight + s.centreOfMass, centre.z).applyQuaternion(layout.facing);
            const f = layout.facing;
            body.setAdditionalMassProperties(
                mass,
                { x: com.x, y: com.y, z: com.z },
                { x: (mass / 12) * (h * h + l * l), y: (mass / 12) * (w * w + l * l), z: (mass / 12) * (w * w + h * h) },
                { x: f.x, y: f.y, z: f.z, w: f.w },
                true,
            );
        }
        body.enableCcd(true);

        // The wheels the vehicle turns: the model's own, or ones it draws.
        const frame = vehicleFrame(target, layout.facing);
        const generated: THREE.Group[] = [];
        target.updateWorldMatrix(true, false);
        target.matrixWorld.decompose(_hostPosition, _hostQuaternion, _hostScale);
        const nodes = layout.wheels.map(wheel => {
            const worldCentre = wheel.centre.clone().applyMatrix4(frame);
            if (layout.generated) {
                const group = buildGeneratedWheel(wheel.radius, wheel.width);
                target.add(group);
                group.position.copy(target.worldToLocal(worldCentre.clone()));
                group.quaternion.copy(layout.facing);
                group.scale.set(1 / Math.max(1e-6, Math.abs(_hostScale.x)), 1 / Math.max(1e-6, Math.abs(_hostScale.y)), 1 / Math.max(1e-6, Math.abs(_hostScale.z)));
                generated.push(group);
                const rested = restPivotNode(group, worldCentre);
                return rested ? [rested] : [];
            }
            return wheel.nodes.map(node => restPivotNode(node, worldCentre)).filter((entry): entry is PivotNode => entry !== null);
        });
        const doors = findDoors(target, layout, frame, skip);
        const lights = buildVehicleLights(target, layout, frame, skip, s.headlights !== 'off');
        const { wheelbase, track } = wheelGeometry(layout.wheels);
        const telemetry: VehicleTelemetry = {
            speed: 0, rpm: engineSpec.idleRpm, idleRpm: engineSpec.idleRpm, redlineRpm: engineSpec.redlineRpm, gear: 1, shifting: 0,
            throttle: 0, brake: 0, handbrake: false, steer: 0, absActive: false, tractionActive: false, stabilityActive: false, impact: 0,
            wheels: wheels.map(wheel => ({
                front: wheel.front, left: wheel.left, contact: false, surface: wheel.surface, load: 0, slipRatio: 0, slipAngle: 0, omega: 0, compression: 0,
                contactPoint: wheel.contactPoint, contactNormal: wheel.contactNormal, groundSpeed: 0,
            })),
        };
        return {
            body, layout, wheels, engine: engineSpec, gearbox, suspension, transmission: createTransmission(), traction: createTractionControl(),
            drive: { wheelTorque: 0, rpm: engineSpec.idleRpm, clutchSlip: false },
            wheelbase, track, nodes, doors, lights, generated, rpm: engineSpec.idleRpm, load: 0, doorTime: null, telemetry,
        };
    };

    /** The chassis body this object's physics mounted, once it exists. */
    const findBody = (): RapierRigidBody | null => {
        const found: { body: RapierRigidBody | null } = { body: null };
        world.forEachRigidBody(candidate => {
            if (!found.body && candidate.isDynamic() && objectIdFromRigidBody(candidate) === objectId) found.body = candidate;
        });
        return found.body;
    };

    const ensureRig = (): VehicleRig | null => {
        const current = rig.current;
        if (current && current.body.isValid()) return current;
        if (current) {
            dispose(current);
            rig.current = null;
        }
        if (!host) return null;
        const body = findBody();
        if (!body) return null;
        try {
            rig.current = build(host, body);
        } catch (error) {
            frontendDiagnostics.failure('vehicle_build_failed', error);
            rig.current = null;
        }
        return rig.current;
    };

    // The vehicle as the session sees it.
    const handle = useMemo((): VehicleHandle | null => {
        if (!host) return null;
        const frame = new THREE.Matrix4();
        const vehiclePoint = (x: number, y: number, z: number, out: THREE.Vector3) =>
            out.set(x, y, z).applyMatrix4(vehicleFrame(host, rig.current?.layout.facing ?? new THREE.Quaternion(), frame));
        const box = () => rig.current?.layout.chassis ?? null;
        return {
            objectId,
            host,
            playerCanDrive: () => settingsRef.current.playerCanDrive,
            speed: () => {
                const current = rig.current;
                if (!current || !current.body.isValid()) return 0;
                const v = current.body.linvel();
                const r = current.body.rotation();
                _forward.set(0, 0, 1).applyQuaternion(_bodyQuaternion.set(r.x, r.y, r.z, r.w).multiply(current.layout.facing));
                return v.x * _forward.x + v.y * _forward.y + v.z * _forward.z;
            },
            gear: () => {
                const transmission = rig.current?.transmission;
                return transmission ? (transmission.shifting > 0 ? transmission.target : transmission.gear) : 1;
            },
            rpm: () => rig.current?.rpm ?? 0,
            seat(out) {
                const chassis = box();
                if (!chassis) return host.getWorldPosition(out);
                const centre = chassis.getCenter(_centre);
                return vehiclePoint(centre.x, chassis.min.y + 0.05, centre.z, out);
            },
            reach() {
                const chassis = box();
                if (!chassis) return 1.5;
                const size = chassis.getSize(_offset);
                return Math.max(size.x, size.z) / 2;
            },
            exitPoint(out) {
                const chassis = box();
                if (!chassis) return null;
                const centre = chassis.getCenter(new THREE.Vector3());
                const y = (chassis.min.y + chassis.max.y) / 2;
                // Driver's side (the left, +X), then the other side, then behind.
                const sides: [number, number, number, number, number, number][] = [
                    [chassis.max.x + 0.05, y, centre.z, chassis.max.x + EXIT_GAP, y, centre.z],
                    [chassis.min.x - 0.05, y, centre.z, chassis.min.x - EXIT_GAP, y, centre.z],
                    [centre.x, y, chassis.min.z - 0.05, centre.x, y, chassis.min.z - EXIT_GAP],
                ];
                const from = new THREE.Vector3();
                const to = new THREE.Vector3();
                const direction = new THREE.Vector3();
                for (const [fx, fy, fz, tx, ty, tz] of sides) {
                    vehiclePoint(fx, fy, fz, from);
                    vehiclePoint(tx, ty, tz, to);
                    direction.subVectors(to, from);
                    const length = direction.length();
                    if (queries.raycast(from, direction, length + 0.3, { excludeObjectId: objectId })) continue;
                    const ground = queries.raycast(to.clone().addScaledVector(UP, 1.5), DOWN, 6, { excludeObjectId: objectId });
                    if (ground) return out.copy(ground.point);
                    return out.copy(to).setY(vehiclePoint(0, chassis.min.y, 0, from).y);
                }
                return null;
            },
            setScriptControls(controls) {
                scriptControls.current = controls;
            },
            telemetry: () => rig.current?.telemetry ?? null,
            frame: out => vehicleFrame(host, rig.current?.layout.facing ?? IDENTITY, out),
            chassis: box,
        };
    }, [host, objectId, queries]);

    useEffect(() => (handle ? vehicleSession.register(handle) : undefined), [handle]);

    // The driver's door opens and shuts as the player gets in or out of this vehicle.
    useEffect(() => vehicleSession.onEvent(event => {
        if (event.objectId === objectId && rig.current) rig.current.doorTime = 0;
    }), [objectId]);

    // The path the AI drives, found again each step so a path streamed in later is still used.
    const pathCache = useRef<{ entry: LiveSpline | null; spline: unknown; path: DrivePath | null }>({ entry: null, spline: null, path: null });
    const aiPath = (): DrivePath | null => {
        const id = settingsRef.current.aiPath;
        if (!id) return null;
        const entry = getLiveSpline(id, 'runtime');
        const cache = pathCache.current;
        if (entry !== cache.entry || entry?.spline !== cache.spline) {
            cache.entry = entry;
            cache.spline = entry?.spline ?? null;
            cache.path = entry ? splineDrivePath(entry) : null;
            follower.current.progress = null;
        }
        return cache.path;
    };

    const _point = useMemo(() => new THREE.Vector3(), []);

    /** How far ahead (m) the nearest thing an AI driver must stop for is, along where it is steering; Infinity for nothing. */
    const obstacleAhead = (current: VehicleRig, position: THREE.Vector3Like, speed: number, steer: number): number => {
        const chassis = current.layout.chassis;
        const width = chassis.max.x - chassis.min.x;
        const centreX = (chassis.min.x + chassis.max.x) / 2;
        const height = chassis.min.y + (chassis.max.y - chassis.min.y) * 0.4;
        _direction.set(0, 0, 1).applyAxisAngle(UP, -steer).applyQuaternion(_vehicleQuaternion);
        const reach = obstacleLookAhead(Math.max(0, speed));
        let nearest = Infinity;
        for (const across of [-0.38, 0, 0.38]) {
            _origin.set(centreX + across * width, height, chassis.max.z + 0.05).applyQuaternion(_vehicleQuaternion).add(position);
            const hit = queries.raycast(_origin, _direction, reach, { excludeObjectId: objectId });
            // Ground it can drive up (a ramp, a hill) is not in its way.
            if (hit && hit.normal.dot(_up) < 0.6) nearest = Math.min(nearest, hit.distance);
        }
        return nearest;
    };

    /** Sets the vehicle back on its wheels where it lies, facing the way it was heading. */
    const rightVehicle = (current: VehicleRig, position: THREE.Vector3Like) => {
        const { body } = current;
        _origin.set(position.x, position.y + 4, position.z);
        const ground = queries.raycast(_origin, DOWN, 12, { excludeObjectId: objectId });
        const y = (ground ? ground.point.y : position.y) + current.suspension.travel + 0.3;
        uprightRotation(_vehicleQuaternion, current.layout.facing, _righted);
        body.setTranslation({ x: position.x, y, z: position.z }, true);
        body.setRotation({ x: _righted.x, y: _righted.y, z: _righted.z, w: _righted.w }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        for (const wheel of current.wheels) wheel.dynamics.omega = 0;
    };

    useBeforePhysicsStep(() => {
        const current = ensureRig();
        if (!current) return;
        const s = settingsRef.current;
        const { body, wheels } = current;
        const dt = world.timestep;
        const t = body.translation();
        const r = body.rotation();
        _bodyQuaternion.set(r.x, r.y, r.z, r.w);
        _vehicleQuaternion.copy(_bodyQuaternion).multiply(current.layout.facing);
        _up.set(0, 1, 0).applyQuaternion(_vehicleQuaternion);
        _forward.set(0, 0, 1).applyQuaternion(_vehicleQuaternion);
        const lv = body.linvel();
        const av = body.angvel();
        const com = body.worldCom();
        _linear.set(lv.x, lv.y, lv.z);
        _angular.set(av.x, av.y, av.z);
        _com.set(com.x, com.y, com.z);
        const speed = _linear.dot(_forward);
        const playerDriving = vehicleSession.state().driving === objectId;

        // Lying on its side or roof, nearly still: set back on its wheels, facing the way it was heading.
        if (stepUpright(upright.current, _up.y, _linear.length(), dt)) {
            rightVehicle(current, t as THREE.Vector3Like);
            return;
        }

        // Who drives: the player, else a level script, else the AI path, else nobody (handbrake on).
        let controls: VehicleControls;
        if (playerDriving) {
            controls = {
                throttle: Math.max(input.value('Throttle'), input.value('MoveForward')),
                brake: Math.max(input.value('Brake'), input.value('MoveBack')),
                steer: input.axis('MoveLeft', 'MoveRight'),
                handbrake: Math.max(input.value('Handbrake'), input.value('Jump')) > 0.5,
            };
        } else if (scriptControls.current) {
            controls = scriptControls.current;
        } else {
            const path = aiPath();
            if (path) {
                _point.set(t.x, t.y, t.z);
                controls = driveAlongPath(follower.current, path, { position: _point, forward: _forward, speed }, s, current.wheelbase);
                // Knocked well off the path: look for the nearest stretch again.
                if (follower.current.progress !== null && path.pointAt(follower.current.progress, _velocity).distanceTo(_point) > AI_REJOIN_DISTANCE) {
                    follower.current.progress = null;
                }
                // Stops short of what is ahead (another car, the player, a wall), and backs out when pinned.
                const ahead = obstacleAhead(current, t as THREE.Vector3Like, speed, controlState.current.steer);
                controls = stepAiRecovery(recovery.current, controls, avoidAhead(controls, speed, ahead), ahead < AI_STOP_GAP + 0.5, speed, dt);
            } else controls = { ...NO_CONTROLS, handbrake: true };
        }
        const pedals = stepVehicleControls(controlState.current, controls, speed, dt, s);
        const angles = ackermannAngles(pedals.steer, current.wheelbase, current.track);

        // Suspension: how far down its travel each wheel reaches before its tyre meets the ground.
        _shapeRotation.copy(_vehicleQuaternion).multiply(CYLINDER_TO_AXLE);
        _axle.copy(AXLE).applyQuaternion(_vehicleQuaternion);
        _down.x = -_up.x;
        _down.y = -_up.y;
        _down.z = -_up.z;
        const travel = current.suspension.travel;
        for (const wheel of wheels) {
            _anchor.copy(wheel.anchor).applyQuaternion(_vehicleQuaternion).add(t as THREE.Vector3Like);
            // A ray down the travel finds the ground under the wheel and its slope exactly; the tyre (a
            // disc across the axle) touches that plane with its centre this far from it.
            let length = Infinity;
            const ray = new rapier.Ray(_anchor, _down);
            const ground = world.castRayAndGetNormal(
                ray, travel + wheel.radius * 2 + wheel.halfWidth, true,
                rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body, notPlayer,
            );
            const facing = ground ? ground.normal.x * _up.x + ground.normal.y * _up.y + ground.normal.z * _up.z : 0;
            if (ground && facing > 0.2) {
                wheel.contactNormal.set(ground.normal.x, ground.normal.y, ground.normal.z);
                const across = wheel.contactNormal.dot(_axle);
                const reach = wheel.radius * Math.sqrt(Math.max(0, 1 - across * across)) + wheel.halfWidth * Math.abs(across);
                length = ground.timeOfImpact - reach / facing;
                wheel.surface = surfaceOfHit(ground.collider, ground.featureId, _anchor.x, _anchor.z);
            } else wheel.contactNormal.copy(_up);
            // The tyre's own shape catches what is under its tread but not under the ray: a kerb or an edge.
            const kerbReach = Math.min(travel, length - KERB_MARGIN);
            const hit = kerbReach > 0 ? world.castShape(
                _anchor, _shapeRotation, _down, wheel.shape, 0, kerbReach, true,
                rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body, notPlayer,
            ) : null;
            if (hit) {
                length = hit.time_of_impact;
                wheel.contactNormal.copy(_up);
                wheel.surface = surfaceOfHit(hit.collider, undefined, _anchor.x, _anchor.z);
            }
            const previous = wheel.compression;
            wheel.contact = length <= travel;
            wheel.compression = wheel.contact ? travel - Math.max(0, length) : 0;
            const velocity = (wheel.compression - previous) / dt;
            wheel.load = wheel.contact ? suspensionForce(current.suspension, wheel.compression, velocity) : 0;
            if (wheel.load > 0) {
                body.applyImpulseAtPoint({ x: _up.x * wheel.load * dt, y: _up.y * wheel.load * dt, z: _up.z * wheel.load * dt }, _anchor, true);
            }
            if (wheel.contact) {
                _centre.copy(_anchor).addScaledVector(_up, -Math.max(0, length));
                wheel.contactPoint.copy(_centre).addScaledVector(wheel.contactNormal, -wheel.radius);
            }
        }

        // Drivetrain: the engine through the gearbox to the driven wheels.
        const driven = wheels.filter(wheel => wheel.driven);
        const drivenOmega = driven.length ? driven.reduce((sum, wheel) => sum + wheel.dynamics.omega, 0) / driven.length : 0;
        const meanRadius = wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / wheels.length;
        const spin = driven.reduce((most, wheel) => Math.max(most, wheel.contact ? wheel.slipRatio * Math.sign(pedals.reverse ? -1 : 1) : 0), 0);
        // Stability control brakes one wheel against a slide and eases off the power.
        const yawRate = _angular.dot(_up);
        const correction = s.stabilityControl ? stabilityCorrection(pedals.steer, speed, current.wheelbase, yawRate, s.grip * weatherGrip('asphalt', worldClock.wetness, worldClock.snowCover)) : null;
        const traction = s.tractionControl ? stepTractionControl(current.traction, pedals.throttle, spin, dt) : pedals.throttle;
        const throttle = traction * (correction?.throttle ?? 1);
        stepTransmission(current.transmission, current.gearbox, current.engine, Math.abs(speed) / meanRadius, throttle, pedals.reverse, dt);
        driveTorque(current.engine, current.gearbox, current.transmission, drivenOmega, throttle, current.drive);
        current.load = throttle;
        current.rpm += (current.drive.rpm - current.rpm) * Math.min(1, dt * 12);

        const torques = new Map<SimWheel, number>();
        const axles: [SimWheel[], number][] = s.drive === 'all'
            ? [[driven.filter(wheel => wheel.front), current.drive.wheelTorque * FRONT_DRIVE_SHARE], [driven.filter(wheel => !wheel.front), current.drive.wheelTorque * (1 - FRONT_DRIVE_SHARE)]]
            : [[driven, current.drive.wheelTorque]];
        for (const [axle, torque] of axles) {
            const left = axle.find(wheel => wheel.left);
            const right = axle.find(wheel => !wheel.left);
            if (left && right && axle.length === 2) {
                const [a, b] = splitAxleTorque(torque, left.dynamics.omega, right.dynamics.omega, s.differential);
                torques.set(left, a);
                torques.set(right, b);
            } else for (const wheel of axle) torques.set(wheel, torque / Math.max(1, axle.length));
        }

        const fronts = wheels.filter(wheel => wheel.front).length || 1;
        const rears = wheels.filter(wheel => !wheel.front).length || 1;
        const brakeForce = s.mass * s.braking;
        const nominalLoad = (s.mass * GRAVITY) / wheels.length;
        const holding = Math.abs(speed) < HOLD_SPEED && pedals.throttle === 0 && (pedals.brake > 0 || pedals.handbrake || !playerDriving && !scriptControls.current);
        let absActive = false;

        for (const wheel of wheels) {
            wheel.steer = wheel.front ? -(wheel.left ? angles.left : angles.right) : 0;
            const share = wheel.front ? FRONT_BRAKE_SHARE / fronts : (1 - FRONT_BRAKE_SHARE) / rears;
            let brake = pedals.brake * brakeForce * share * wheel.radius;
            if (s.abs) {
                const released = absBrake(brake, wheel.slipRatio, speed);
                absActive ||= released < brake;
                brake = released;
            }
            if (!wheel.front && pedals.handbrake) brake += (s.mass * GRAVITY * 1.5 * wheel.radius) / rears;
            if (correction?.wheel && correction.wheel.front === wheel.front && correction.wheel.left === wheel.left) {
                brake += correction.amount * s.mass * GRAVITY * 0.3 * wheel.radius;
            }
            if (!wheel.contact) {
                stepWheel(wheel.dynamics, null, torques.get(wheel) ?? 0, brake, dt, WHEEL_SUBSTEPS, _result);
                wheel.slipRatio = 0;
                wheel.slipAngle = 0;
                wheel.groundSpeed = 0;
                wheel.rotation += wheel.dynamics.omega * dt;
                continue;
            }
            // The tyre's frame on the ground: its heading (steered) and its left, in the contact plane.
            _normal.copy(wheel.contactNormal);
            _heading.set(Math.sin(wheel.steer), 0, Math.cos(wheel.steer)).applyQuaternion(_vehicleQuaternion);
            _heading.addScaledVector(_normal, -_heading.dot(_normal)).normalize();
            _lateral.crossVectors(_normal, _heading).normalize();
            // The contact's velocity over the ground.
            _relative.subVectors(wheel.contactPoint, _com);
            _velocity.crossVectors(_angular, _relative).add(_linear);
            const longitudinal = _velocity.dot(_heading);
            const lateral = _velocity.dot(_lateral);
            wheel.groundSpeed = Math.hypot(longitudinal, lateral);
            const ground = SURFACES[wheel.surface];
            // A wet road holds less, settled snow far less; under cover the road stays dry.
            const sheltered = weatherCover.sheltered(wheel.contactPoint.x, wheel.contactPoint.y, wheel.contactPoint.z);
            const weather = sheltered ? 1 : weatherGrip(wheel.surface, worldClock.wetness, worldClock.snowCover);
            const mu = s.grip * ground.grip * weather * (!wheel.front && pedals.handbrake ? s.handbrakeGrip : 1);
            stepWheel(wheel.dynamics, { longitudinal, lateral, load: wheel.load, mu, nominalLoad, rolling: ground.rolling }, torques.get(wheel) ?? 0, brake, dt, WHEEL_SUBSTEPS, _result);
            wheel.slipRatio = _result.slipRatio;
            wheel.slipAngle = _result.slipAngle;
            wheel.rotation += wheel.dynamics.omega * dt;
            let fx = _result.fx;
            let fy = _result.fy;
            // No more sideways force than would stop the slide this step, so a slow tyre does not overshoot.
            const share2 = wheel.load / GRAVITY;
            const stopSideways = (share2 * Math.abs(lateral)) / dt;
            fy = Math.max(-stopSideways, Math.min(stopSideways, fy));
            if (holding) {
                // Held still: the tyre resists rolling up to its grip.
                const grip = mu * wheel.load;
                fx = Math.max(-grip, Math.min(grip, (-share2 * longitudinal) / dt));
                wheel.dynamics.omega = 0;
            }
            _force.copy(_heading).multiplyScalar(fx * dt).addScaledVector(_lateral, fy * dt);
            body.applyImpulseAtPoint({ x: _force.x, y: _force.y, z: _force.z }, wheel.contactPoint, true);
        }

        // Anti-roll bars: each axle's spring difference pushes the more compressed side up and the other down.
        if (s.antiRoll > 0) {
            for (const front of [true, false]) {
                const left = wheels.find(wheel => wheel.front === front && wheel.left);
                const right = wheels.find(wheel => wheel.front === front && !wheel.left);
                if (!left || !right || !left.contact || !right.contact) continue;
                const force = (left.compression - right.compression) * s.antiRoll * current.suspension.stiffness;
                for (const [wheel, sign] of [[left, 1], [right, -1]] as const) {
                    _anchor.copy(wheel.anchor).applyQuaternion(_vehicleQuaternion).add(t as THREE.Vector3Like);
                    body.applyImpulseAtPoint({ x: _up.x * force * sign * dt, y: _up.y * force * sign * dt, z: _up.z * force * sign * dt }, _anchor, true);
                }
            }
        }

        // What the step did, for effects, sound and the session.
        const telemetry = current.telemetry;
        telemetry.speed = speed;
        telemetry.rpm = current.rpm;
        telemetry.gear = current.transmission.shifting > 0 ? current.transmission.target : current.transmission.gear;
        telemetry.shifting = current.transmission.shifting;
        telemetry.throttle = throttle;
        telemetry.brake = pedals.brake;
        telemetry.handbrake = pedals.handbrake;
        telemetry.steer = pedals.steer;
        telemetry.absActive = absActive;
        telemetry.tractionActive = traction < pedals.throttle;
        telemetry.stabilityActive = Boolean(correction?.wheel);
        wheels.forEach((wheel, index) => {
            const out = telemetry.wheels[index];
            out.contact = wheel.contact;
            out.surface = wheel.surface;
            out.load = wheel.load;
            out.slipRatio = wheel.slipRatio;
            out.slipAngle = wheel.slipAngle;
            out.omega = wheel.dynamics.omega;
            out.compression = wheel.compression;
            out.groundSpeed = wheel.groundSpeed;
        });

        // Air drag, and downforce that grows with speed.
        const airSpeed = _linear.length();
        if (airSpeed > 0.1) {
            const drag = AIR_DRAG * airSpeed * dt;
            const down = s.downforce * speed * speed * dt;
            body.applyImpulse({
                x: -_linear.x * drag - _up.x * down,
                y: -_linear.y * drag - _up.y * down,
                z: -_linear.z * drag - _up.z * down,
            }, true);
        }
    });

    // Engine and tyre sound, on the vehicle.
    useEffect(() => {
        if (!host) return undefined;
        const { listener, release } = acquireAudioListener(camera);
        const sound = new SpatialPositionalAudio(listener);
        sound.setRefDistance(6);
        sound.setRolloffFactor(1);
        routeSoundToBus(sound, mixer, 'sfx');
        host.add(sound);
        let voice: EngineVoice;
        const recording = settings.engineSound ? findAudioAsset(audioAssets, settings.engineSound) : undefined;
        if (recording?.url) {
            voice = { sound, writer: null, stop: () => undefined, recorded: { rate: 1, volume: 0 } };
            let live = true;
            new THREE.AudioLoader().load(recording.url, buffer => {
                if (!live) return;
                sound.setBuffer(buffer);
                sound.setLoop(true);
                sound.setVolume(0);
                sound.play();
            }, undefined, error => frontendDiagnostics.failure('vehicle_engine_sound_failed', error));
            const stop = voice.stop;
            voice.stop = () => { live = false; stop(); };
        } else {
            try {
                voice = { sound, recorded: null, ...synthesizeEngine(sound) };
            } catch (error) {
                frontendDiagnostics.failure('vehicle_engine_synth_failed', error);
                voice = { sound, writer: null, stop: () => undefined, recorded: null };
            }
        }
        engine.current = voice;
        // The road under it: tyres, rumble, wind and knocks.
        const roadSound = new SpatialPositionalAudio(listener);
        roadSound.setRefDistance(5);
        roadSound.setRolloffFactor(1);
        routeSoundToBus(roadSound, mixer, 'sfx');
        host.add(roadSound);
        let roadVoice: RoadVoice | null = null;
        try {
            roadVoice = synthesizeRoad(roadSound);
            road.current = { sound: roadSound, voice: roadVoice };
        } catch (error) {
            frontendDiagnostics.failure('vehicle_road_synth_failed', error);
        }
        return () => {
            engine.current = null;
            road.current = null;
            voice.stop();
            roadVoice?.stop();
            for (const each of [sound, roadSound]) {
                releaseSound(each);
                each.removeFromParent();
            }
            release();
        };
    }, [host, camera, mixer, audioAssets, settings.engineSound]);

    useEffect(() => {
        if (engine.current) routeSoundToBus(engine.current.sound, mixer, 'sfx');
        if (road.current) routeSoundToBus(road.current.sound, mixer, 'sfx');
    }, [mixer]);

    useFrame((frame, delta) => {
        const current = rig.current;
        if (!current || !host || !current.body.isValid()) return;
        const s = settingsRef.current;
        host.updateWorldMatrix(true, false);
        host.matrixWorld.decompose(_hostPosition, _hostQuaternion, _hostScale);
        _vehicleQuaternion.copy(_hostQuaternion).multiply(current.layout.facing);
        _vehicleInverse.copy(_vehicleQuaternion).invert();
        const travel = current.suspension.travel;

        // Wheels: down their suspension, turned by the steering, rolled by their spin.
        current.wheels.forEach((wheel, index) => {
            _centre.copy(wheel.anchor).addScaledVector(DOWN, travel - wheel.compression);
            _world.copy(_centre).applyQuaternion(_vehicleQuaternion).add(_hostPosition);
            _steer.setFromAxisAngle(UP, wheel.steer);
            _spin.setFromAxisAngle(AXIS_X, wheel.rotation % (Math.PI * 2));
            // The wheel's turn since rest, as a world rotation.
            _turn.copy(_vehicleQuaternion).multiply(_steer).multiply(_spin).multiply(_vehicleInverse);
            for (const entry of current.nodes[index] ?? []) placePivotNode(entry, _turn, _world);
        });

        const linear = current.body.linvel();
        stepTyreEffects(effects, current.telemetry, current.wheels.map(wheel => wheel.halfWidth), _velocity.set(linear.x, linear.y, linear.z), delta, frame.camera);

        // The driver's door swings open and shut.
        if (current.doorTime !== null) {
            current.doorTime += delta;
            const time = current.doorTime;
            const open = time < DOOR_OPEN ? time / DOOR_OPEN
                : time < DOOR_OPEN + DOOR_HOLD ? 1
                    : Math.max(0, 1 - (time - DOOR_OPEN - DOOR_HOLD) / DOOR_CLOSE);
            const eased = open * open * (3 - 2 * open);
            for (const door of current.doors) {
                if (!door.driver) continue;
                _world.copy(door.hinge).applyQuaternion(_vehicleQuaternion).add(_hostPosition);
                _steer.setFromAxisAngle(UP, -DOOR_ANGLE * eased);
                _turn.copy(_vehicleQuaternion).multiply(_steer).multiply(_vehicleInverse);
                for (const entry of door.nodes) placePivotNode(entry, _turn, _world);
            }
            if (time > DOOR_OPEN + DOOR_HOLD + DOOR_CLOSE) current.doorTime = null;
        }

        const playerDriving = vehicleSession.state().driving === objectId;
        const driven = playerDriving || scriptControls.current !== null || (Boolean(s.aiPath) && aiPath() !== null);
        // Headlights while it is driven (in the dark, for Auto); brake and reversing lamps as it brakes and reverses.
        setVehicleLights(current.lights, {
            head: driven && (s.headlights === 'on' || (s.headlights === 'auto' && sceneDaylight() < HEADLIGHT_DAYLIGHT)),
            brake: driven && current.telemetry.brake > 0.05,
            reverse: driven && current.telemetry.gear === -1,
        });
        const speed = handle?.speed() ?? 0;
        const engineSpec = current.engine;
        const revs = Math.min(1, Math.max(0, (current.rpm - engineSpec.idleRpm) / (engineSpec.redlineRpm - engineSpec.idleRpm)));
        if (playerDriving) {
            const transmission = current.transmission;
            vehicleSession.setHud({
                objectId,
                speed: Math.round(Math.abs(speed) / KMH),
                gear: gearLabel(transmission.shifting > 0 ? transmission.target : transmission.gear, speed),
                rpm: Math.round(revs * 20) / 20,
            });
        }

        // Sound: the engine runs while someone drives (cut for a moment through a gear change); the road
        // under it squeals, rumbles and roars with the tyres and speed; impacts and hard landings knock.
        const level = s.engineVolume;
        const telemetry = current.telemetry;
        const roadVoice = road.current;
        if (roadVoice) {
            roadVoice.voice.writer.write(roadVoice.sound.context, roadSoundValues(_roadValues, telemetry, level));
            const knock = knocks.current;
            knock.clock += delta;
            _scratch.set(linear.x, linear.y, linear.z);
            const jolt = knock.primed ? _scratch.distanceTo(knock.velocity) : 0;
            let strength = jolt > IMPACT_SPEED ? Math.min(1, (jolt - IMPACT_SPEED) / 8) : 0;
            telemetry.wheels.forEach((wheel, index) => {
                const air = knock.airborne[index] ?? 0;
                if (wheel.contact && air > LANDING_AIRTIME) strength = Math.max(strength, Math.min(1, Math.abs(knock.velocity.y) / 6));
                knock.airborne[index] = wheel.contact ? 0 : air + delta;
            });
            if (strength > 0.05 && knock.clock - knock.last > KNOCK_GAP) {
                knock.last = knock.clock;
                roadVoice.voice.thump(strength * level);
                telemetry.impact = Math.max(telemetry.impact, strength);
            }
            telemetry.impact *= Math.exp(-IMPACT_DECAY * delta);
            knock.velocity.copy(_scratch);
            knock.primed = true;
        }
        const voice = engine.current;
        if (!voice) return;
        const context = voice.sound.context;
        if (voice.writer) {
            voice.writer.write(context, engineSoundValues(_engineValues, current.rpm, revs, current.load, telemetry.shifting > 0, driven, level));
        } else if (voice.recorded && voice.sound.buffer && context.state === 'running') {
            const rate = 0.6 + 1.5 * revs;
            const volume = driven ? level * (0.45 + 0.4 * current.load) * (telemetry.shifting > 0 ? 0.6 : 1) : 0;
            if (Math.abs(rate - voice.recorded.rate) > 0.01) {
                voice.recorded.rate = rate;
                voice.sound.setPlaybackRate(rate);
            }
            if (Math.abs(volume - voice.recorded.volume) > 0.01) {
                voice.recorded.volume = volume;
                voice.sound.setVolume(volume);
            }
        }
    });

    return (
        <group ref={anchorRef} userData={PHYSICS_IGNORED_USER_DATA}>
            <primitive object={effects.smoke.renderer.object} />
            <primitive object={effects.dust.renderer.object} />
        </group>
    );
};

// ---------------------------------------------------------------------------
// Editor preview
// ---------------------------------------------------------------------------

const PREVIEW_REFRESH_FRAMES = 30;
const ignoreRaycast: THREE.Object3D['raycast'] = () => undefined;

/** Rings where the wheels will be, and an arrow along the way the vehicle drives. */
const VehiclePreview: React.FC<{ object: LevelObject; settings: VehicleSettings }> = ({ object, settings }) => {
    const hostRef = useContext(ComponentHostContext);
    const groupRef = useRef<THREE.Group>(null);
    const [layout, setLayout] = useState<{ key: string; rings: { position: THREE.Vector3; radius: number }[]; front: THREE.Vector3; direction: THREE.Vector3; ringTurn: THREE.Quaternion; length: number } | null>(null);
    const frames = useRef(0);

    useFrame(() => {
        if (frames.current++ % PREVIEW_REFRESH_FRAMES !== 0) return;
        const host = hostRef?.current ?? groupRef.current?.parent ?? null;
        if (!host) return;
        const plan = planVehicleLayout(host, settings.wheelRadius, notModel(object.id), settings.facing);
        const toLocal = new THREE.Matrix4().copy(host.matrixWorld).invert().multiply(vehicleFrame(host, plan.facing));
        const rings = plan.wheels.map(wheel => ({ position: wheel.centre.clone().applyMatrix4(toLocal), radius: wheel.radius }));
        const chassis = plan.chassis;
        const front = new THREE.Vector3((chassis.min.x + chassis.max.x) / 2, chassis.max.y + 0.1, chassis.max.z).applyMatrix4(toLocal);
        const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(plan.facing);
        const length = Math.max(0.5, (chassis.max.z - chassis.min.z) * 0.3);
        // A ring stands in the wheel's plane: across the vehicle's left.
        const ringTurn = plan.facing.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));
        const key = rings.map(ring => `${ring.position.toArray().map(v => v.toFixed(3)).join(',')}:${ring.radius.toFixed(3)}`).join('|') + front.toArray().join(',') + direction.toArray().join(',');
        setLayout(current => (current?.key === key ? current : { key, rings, front, direction, ringTurn, length }));
    });

    const scale = hostRef?.current?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
    return (
        <group ref={groupRef} userData={PHYSICS_IGNORED_USER_DATA}>
            {layout?.rings.map((ring, index) => (
                <mesh key={index} position={ring.position} quaternion={layout.ringTurn} scale={[1 / scale.x, 1 / scale.y, 1 / scale.z]} raycast={ignoreRaycast}>
                    <torusGeometry args={[ring.radius, Math.max(0.01, ring.radius * 0.06), 8, 32]} />
                    <meshBasicMaterial color="#f97316" depthTest={false} transparent opacity={0.85} />
                </mesh>
            ))}
            {layout && (
                <arrowHelper args={[layout.direction, layout.front, layout.length / Math.max(1e-6, scale.z), 0xf97316, 0.25, 0.15]} raycast={ignoreRaycast} />
            )}
        </group>
    );
};

const VehicleRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readVehicleSettings(component), [component]);
    const available = usePhysicsAvailable();
    if (mode === 'editor') return <VehiclePreview object={object} settings={settings} />;
    if (!available) return null;
    return (
        <>
            <PhysicsOwnerBody object={object} component={component} />
            <VehicleRuntime object={object} component={component} settings={settings} />
        </>
    );
};

// ---------------------------------------------------------------------------
// Tyre marks
// ---------------------------------------------------------------------------

/** The play session's tyre marks, laid by every vehicle. Mount once per play session; they go when it ends. */
export const VehicleSkidMarks: React.FC = () => {
    const mesh = useMemo(() => skidMarks().mesh, []);
    useEffect(() => () => releaseSkidMarks(), []);
    return <primitive object={mesh} />;
};

// ---------------------------------------------------------------------------
// Player in and out
// ---------------------------------------------------------------------------

const _player = new THREE.Vector3();
const _vehicle = new THREE.Vector3();

/**
 * The play session's driving: offers the nearest drivable vehicle (Interact gets in) while the player
 * is on foot and no conversation is offered, and gets out on Interact once slow enough. Mount once
 * per play session inside RuntimeServicesProvider; `enabled` false hides the prompt and ignores input.
 */
export const VehicleDriver: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const { input } = useRuntimeServices();
    const playerRef = useContext(IKPlayerTargetContext);

    useEffect(() => () => vehicleSession.reset(), []);

    useFrame(() => {
        const state = vehicleSession.state();
        if (!enabled) {
            vehicleSession.setPrompt(null);
            return;
        }
        if (state.driving) {
            const handle = vehicleSession.get(state.driving);
            if (!handle) vehicleSession.exit();
            // Out only where there is room to step out (the player controller puts them there).
            else if (input.wasPressed('Interact')) stepOutOfVehicle();
            return;
        }
        const player = playerRef?.current;
        const dialogue = dialogueStore.state();
        if (!player || dialogue.prompt || dialogue.active) {
            vehicleSession.setPrompt(null);
            return;
        }
        player.getWorldPosition(_player);
        let nearest: VehicleHandle | null = null;
        let nearestDistance = Infinity;
        for (const handle of vehicleSession.all()) {
            if (!handle.playerCanDrive()) continue;
            const distance = handle.seat(_vehicle).distanceTo(_player) - handle.reach();
            if (distance < ENTER_MARGIN && distance < nearestDistance) {
                nearest = handle;
                nearestDistance = distance;
            }
        }
        vehicleSession.setPrompt(nearest ? { objectId: nearest.objectId, key: interactKeyLabel(input) } : null);
        if (nearest && input.wasPressed('Interact')) vehicleSession.enter(nearest.objectId);
    });

    return null;
};

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const VEHICLE_COMPONENT: ComponentDefinition = {
    type: VEHICLE_COMPONENT_TYPE,
    label: 'Vehicle',
    description: 'A wheeled vehicle: the player gets in with Interact and drives it, or it drives itself along a spline. Its wheels are the model\'s own (found by name) or drawn at the corners of its body; on its own it is a dynamic body of its own mass.',
    props: [
        { key: 'mass', label: 'Mass (kg)', type: 'number', default: VEHICLE_DEFAULTS.mass, min: 1, max: 100000, step: 10 },
        {
            key: 'facing', label: 'Model faces', type: 'select', default: VEHICLE_DEFAULTS.facing,
            options: [
                { label: 'Auto (from wheel names)', value: 'auto' },
                { label: '+Z', value: '+z' },
                { label: '-Z', value: '-z' },
                { label: '+X', value: '+x' },
                { label: '-X', value: '-x' },
            ],
        },
        {
            key: 'drive', label: 'Drive', type: 'select', default: VEHICLE_DEFAULTS.drive,
            options: [
                { label: 'Rear wheels', value: 'rear' },
                { label: 'Front wheels', value: 'front' },
                { label: 'All wheels', value: 'all' },
            ],
        },
        { key: 'power', label: 'Power (kW)', type: 'number', default: VEHICLE_DEFAULTS.power, min: 0, max: 5000, step: 5 },
        { key: 'maxSpeed', label: 'Top speed (km/h)', type: 'number', default: VEHICLE_DEFAULTS.maxSpeed, min: 1, max: 1000, step: 5 },
        { key: 'gears', label: 'Gears', type: 'number', default: VEHICLE_DEFAULTS.gears, min: 1, max: 10, step: 1 },
        {
            key: 'differential', label: 'Differential', type: 'select', default: VEHICLE_DEFAULTS.differential,
            options: [
                { label: 'Open', value: 'open' },
                { label: 'Limited slip', value: 'limited' },
                { label: 'Locked', value: 'locked' },
            ],
        },
        { key: 'reverseSpeed', label: 'Reverse speed (km/h)', type: 'number', default: VEHICLE_DEFAULTS.reverseSpeed, min: 0, max: 500, step: 1 },
        { key: 'braking', label: 'Braking (m/s²)', type: 'number', default: VEHICLE_DEFAULTS.braking, min: 0, max: 100, step: 0.5 },
        { key: 'abs', label: 'ABS', type: 'boolean', default: VEHICLE_DEFAULTS.abs },
        { key: 'tractionControl', label: 'Traction control', type: 'boolean', default: VEHICLE_DEFAULTS.tractionControl },
        { key: 'stabilityControl', label: 'Stability control', type: 'boolean', default: VEHICLE_DEFAULTS.stabilityControl },
        {
            key: 'headlights', label: 'Headlights', type: 'select', default: VEHICLE_DEFAULTS.headlights,
            options: [
                { label: 'Auto (driven in the dark)', value: 'auto' },
                { label: 'On (whenever driven)', value: 'on' },
                { label: 'Off', value: 'off' },
            ],
        },
        { key: 'steerAngle', label: 'Steering lock (°)', type: 'number', default: VEHICLE_DEFAULTS.steerAngle, min: 0, max: 80, step: 1 },
        { key: 'steerAtSpeed', label: 'Steering at top speed', type: 'number', default: VEHICLE_DEFAULTS.steerAtSpeed, min: 0, max: 1, step: 0.05 },
        { key: 'grip', label: 'Tyre grip', type: 'number', default: VEHICLE_DEFAULTS.grip, min: 0.05, max: 20, step: 0.05 },
        { key: 'handbrakeGrip', label: 'Handbrake grip', type: 'number', default: VEHICLE_DEFAULTS.handbrakeGrip, min: 0, max: 1, step: 0.05 },
        { key: 'suspensionTravel', label: 'Suspension travel (m)', type: 'number', default: VEHICLE_DEFAULTS.suspensionTravel, min: 0.02, max: 5, step: 0.01 },
        { key: 'suspensionStiffness', label: 'Suspension stiffness', type: 'number', default: VEHICLE_DEFAULTS.suspensionStiffness, min: 1, max: 500, step: 1 },
        { key: 'suspensionDamping', label: 'Suspension damping', type: 'number', default: VEHICLE_DEFAULTS.suspensionDamping, min: 0, max: 2, step: 0.05 },
        { key: 'antiRoll', label: 'Anti-roll', type: 'number', default: VEHICLE_DEFAULTS.antiRoll, min: 0, max: 2, step: 0.05 },
        { key: 'downforce', label: 'Downforce', type: 'number', default: VEHICLE_DEFAULTS.downforce, min: 0, max: 100, step: 0.1 },
        { key: 'centreOfMass', label: 'Centre of mass height (m)', type: 'number', default: VEHICLE_DEFAULTS.centreOfMass, min: -5, max: 5, step: 0.05 },
        { key: 'wheelRadius', label: 'Wheel radius (m, 0 = measure)', type: 'number', default: VEHICLE_DEFAULTS.wheelRadius, min: 0, max: 10, step: 0.01 },
        { key: 'playerCanDrive', label: 'Player can drive', type: 'boolean', default: VEHICLE_DEFAULTS.playerCanDrive },
        { key: 'aiSpeed', label: 'AI cruise speed (km/h)', type: 'number', default: VEHICLE_DEFAULTS.aiSpeed, min: 0, max: 1000, step: 5 },
        { key: 'engineSound', label: 'Engine sound (id or name)', type: 'string', default: VEHICLE_DEFAULTS.engineSound },
        { key: 'engineVolume', label: 'Engine volume', type: 'number', default: VEHICLE_DEFAULTS.engineVolume, min: 0, max: 2, step: 0.05 },
    ],
    Render: VehicleRender,
};
