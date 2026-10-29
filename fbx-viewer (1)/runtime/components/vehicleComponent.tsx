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
import { createWorldSplineFrame, getLiveSpline, liveSplineWorldScale, sampleLiveSpline, type LiveSpline } from '../splineRegistry';
import {
    ackermannAngles,
    chassisFrame,
    createDriveState,
    driveAlongPath,
    gearLabel,
    GRAVITY,
    IDLE_RPM,
    KMH,
    NO_CONTROLS,
    planVehicleLayout,
    readVehicleSettings,
    REDLINE_RPM,
    restingSag,
    stepOutOfVehicle,
    stepVehicleDrive,
    suspensionCoefficients,
    VEHICLE_COMPONENT_TYPE,
    VEHICLE_DEFAULTS,
    VEHICLE_SHELL_MASS_SHARE,
    vehicleSession,
    wheelGeometry,
    type DrivePath,
    type PathFollowerState,
    type VehicleControls,
    type VehicleDriveState,
    type VehicleHandle,
    type VehicleLayout,
    type VehicleSettings,
} from '../vehicles';
import { acquireAudioListener, findAudioAsset, releaseSound, routeSoundToBus } from './audioComponents';
import { ComponentHostContext } from './builtins';
import { interactKeyLabel } from './dialogueComponent';
import { IKPlayerTargetContext } from './ikComponents';
import { isPhysicsIgnored, PHYSICS_IGNORED_USER_DATA, PhysicsOwnerBody, planPhysicsBody } from './physicsComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/** Air drag, N per (m/s)²: about a road car's. */
const AIR_DRAG = 0.4;
/** The player gets in within this far of the body's edge, metres. */
const ENTER_MARGIN = 1.6;
/** How far beside the body the driver steps out, metres. */
const EXIT_GAP = 0.7;
/** An AI vehicle knocked further than this off its path looks for the nearest stretch of it again, metres. */
const AI_REJOIN_DISTANCE = 25;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);

const isNestedObject = (node: THREE.Object3D, objectId: string): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId;
};

/** Leaves out nested objects and helpers (previews, generated wheels) when the vehicle measures its model. */
const notModel = (objectId: string) => (node: THREE.Object3D): boolean => isNestedObject(node, objectId) || isPhysicsIgnored(node);

/** The suspension rays pass through the player's capsule, which rides inside the car while it is driven. */
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
// Wheel visuals
// ---------------------------------------------------------------------------

/** A node that turns with a wheel, and where it sat at rest. */
interface WheelNode {
    node: THREE.Object3D;
    restQuaternion: THREE.Quaternion;
    /** From the node's origin to the wheel centre, in the node's own orientation (parent-space lengths). */
    toCentre: THREE.Vector3;
}

const _hostPosition = new THREE.Vector3();
const _hostQuaternion = new THREE.Quaternion();
const _hostScale = new THREE.Vector3();
const _hostInverse = new THREE.Quaternion();
const _world = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _steer = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _parentQuaternion = new THREE.Quaternion();
const _parentInverse = new THREE.Quaternion();
const _offset = new THREE.Vector3();

const restWheelNode = (node: THREE.Object3D, worldCentre: THREE.Vector3): WheelNode | null => {
    const parent = node.parent;
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    const centre = parent.worldToLocal(worldCentre.clone());
    return {
        node,
        restQuaternion: node.quaternion.clone(),
        toCentre: centre.sub(node.position).applyQuaternion(node.quaternion.clone().invert()),
    };
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

const NOISE_SECONDS = 1;

/** A synthesized engine (two oscillators at the firing rate through a low-pass) and tyre squeal (filtered noise). */
const synthesizeEngine = (sound: SpatialPositionalAudio): Omit<EngineVoice, 'sound' | 'recorded'> => {
    const context = sound.context;
    const engine = context.createOscillator();
    engine.type = 'sawtooth';
    const sub = context.createOscillator();
    sub.type = 'triangle';
    const subLevel = context.createGain();
    subLevel.gain.value = 0.7;
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 1.5;
    const engineLevel = context.createGain();
    engineLevel.gain.value = 0;
    const noise = context.createBufferSource();
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * NOISE_SECONDS), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    noise.buffer = buffer;
    noise.loop = true;
    const squeal = context.createBiquadFilter();
    squeal.type = 'bandpass';
    squeal.frequency.value = 1400;
    squeal.Q.value = 3;
    const squealLevel = context.createGain();
    squealLevel.gain.value = 0;
    const out = context.createGain();
    engine.connect(tone);
    sub.connect(subLevel).connect(tone);
    tone.connect(engineLevel).connect(out);
    noise.connect(squeal).connect(squealLevel).connect(out);
    sound.setNodeSource(out);
    engine.start();
    sub.start();
    noise.start();
    return {
        writer: new SpatialParamWriter([engine.frequency, sub.frequency, tone.frequency, engineLevel.gain, squealLevel.gain]),
        stop: () => {
            for (const source of [engine, sub, noise]) {
                try { source.stop(); } catch { /* never started */ }
                source.disconnect();
            }
            for (const node of [subLevel, tone, engineLevel, squeal, squealLevel, out]) node.disconnect();
        },
    };
};

const _engineValues = new Float64Array(5);

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface VehicleRig {
    body: RapierRigidBody;
    controller: ReturnType<ReturnType<typeof useRapier>['world']['createVehicleController']>;
    layout: VehicleLayout;
    wheelbase: number;
    track: number;
    nodes: WheelNode[][];
    generated: THREE.Group[];
    /** Wheel centre at rest and its suspension anchor, body frame. */
    anchors: THREE.Vector3[];
}

interface VehicleRuntimeProps {
    object: LevelObject;
    component: LevelComponent;
    settings: VehicleSettings;
}

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
    const drive = useRef<VehicleDriveState>(createDriveState());
    const follower = useRef<PathFollowerState>({ progress: null });
    const scriptControls = useRef<VehicleControls | null>(null);
    const lastControls = useRef<VehicleControls>(NO_CONTROLS);
    const lastLoad = useRef(0);
    const engine = useRef<EngineVoice | null>(null);
    const objectId = object.id;
    const ownsBody = useMemo(() => planPhysicsBody(object)?.ownerId === component.id, [object, component.id]);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    useLayoutEffect(() => {
        setHost(hostRef?.current ?? anchorRef.current?.parent ?? null);
    }, [hostRef]);

    // The controller goes before <Physics> frees its world (layout cleanup runs first).
    useLayoutEffect(() => () => {
        const current = rig.current;
        rig.current = null;
        if (!current) return;
        try { world.removeVehicleController(current.controller); } catch { /* world already gone */ }
        for (const group of current.generated) group.removeFromParent();
    }, [world]);

    /** Builds the controller once the chassis body exists. */
    const build = (target: THREE.Object3D, body: RapierRigidBody): VehicleRig | null => {
        const s = settingsRef.current;
        const layout = planVehicleLayout(target, s.wheelRadius, notModel(objectId));
        if (layout.wheels.length === 0) return null;
        const controller = world.createVehicleController(body);
        controller.indexUpAxis = 1;
        // Rapier 0.12 names this setter like a method.
        controller.setIndexForwardAxis = 2;
        const { stiffness, compression, relaxation } = suspensionCoefficients(s);
        const sag = restingSag(s, layout.wheels.length);
        const rest = s.suspensionTravel;
        const anchors: THREE.Vector3[] = [];
        layout.wheels.forEach((wheel, index) => {
            // Anchored so that, sagging under the car's weight, the wheel sits where the model draws it.
            const anchor = wheel.centre.clone().addScaledVector(UP, Math.max(0, rest - sag));
            anchors.push(anchor);
            controller.addWheel(anchor, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, wheel.radius);
            controller.setWheelSuspensionStiffness(index, stiffness);
            controller.setWheelSuspensionCompression(index, compression);
            controller.setWheelSuspensionRelaxation(index, relaxation);
            controller.setWheelMaxSuspensionTravel(index, rest);
            controller.setWheelMaxSuspensionForce(index, s.mass * GRAVITY * 3);
            controller.setWheelFrictionSlip(index, s.grip);
            controller.setWheelSideFrictionStiffness(index, 1);
        });
        if (ownsBody) {
            // Most of the mass sits low between the wheels, with the body's inertia, so it corners flat.
            const size = layout.chassis.getSize(new THREE.Vector3());
            const centre = layout.chassis.getCenter(new THREE.Vector3());
            const wheelHeight = layout.wheels.reduce((sum, wheel) => sum + wheel.centre.y, 0) / layout.wheels.length;
            const mass = s.mass * (1 - VEHICLE_SHELL_MASS_SHARE);
            const [w, h, l] = [Math.max(0.1, size.x), Math.max(0.1, size.y), Math.max(0.1, size.z)];
            body.setAdditionalMassProperties(
                mass,
                { x: centre.x, y: wheelHeight + s.centreOfMass, z: centre.z },
                { x: (mass / 12) * (h * h + l * l), y: (mass / 12) * (w * w + l * l), z: (mass / 12) * (w * w + h * h) },
                { x: 0, y: 0, z: 0, w: 1 },
                true,
            );
        }
        body.enableCcd(true);

        // The wheels the vehicle turns: the model's own, or ones it draws.
        const frame = chassisFrame(target);
        const generated: THREE.Group[] = [];
        target.updateWorldMatrix(true, false);
        target.matrixWorld.decompose(_hostPosition, _hostQuaternion, _hostScale);
        const nodes = layout.wheels.map(wheel => {
            const worldCentre = wheel.centre.clone().applyMatrix4(frame);
            if (layout.generated) {
                const group = buildGeneratedWheel(wheel.radius, wheel.width);
                target.add(group);
                group.position.copy(target.worldToLocal(worldCentre.clone()));
                group.scale.set(1 / Math.max(1e-6, Math.abs(_hostScale.x)), 1 / Math.max(1e-6, Math.abs(_hostScale.y)), 1 / Math.max(1e-6, Math.abs(_hostScale.z)));
                generated.push(group);
                const rested = restWheelNode(group, worldCentre);
                return rested ? [rested] : [];
            }
            return wheel.nodes.map(node => restWheelNode(node, worldCentre)).filter((entry): entry is WheelNode => entry !== null);
        });
        const { wheelbase, track } = wheelGeometry(layout.wheels);
        return { body, controller, layout, wheelbase, track, nodes, generated, anchors };
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
            try { world.removeVehicleController(current.controller); } catch { /* gone */ }
            for (const group of current.generated) group.removeFromParent();
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
        const chassisPoint = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, y, z).applyMatrix4(chassisFrame(host));
        const box = () => rig.current?.layout.chassis ?? null;
        return {
            objectId,
            host,
            playerCanDrive: () => settingsRef.current.playerCanDrive,
            speed: () => {
                const current = rig.current;
                return current && current.body.isValid() ? current.controller.currentVehicleSpeed() : 0;
            },
            gear: () => drive.current.gear,
            rpm: () => drive.current.rpm,
            seat(out) {
                const chassis = box();
                if (!chassis) return host.getWorldPosition(out);
                const centre = chassis.getCenter(_centre);
                return chassisPoint(centre.x, chassis.min.y + 0.05, centre.z, out);
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
                    chassisPoint(fx, fy, fz, from);
                    chassisPoint(tx, ty, tz, to);
                    direction.subVectors(to, from);
                    const length = direction.length();
                    if (queries.raycast(from, direction, length + 0.3, { excludeObjectId: objectId })) continue;
                    const ground = queries.raycast(to.clone().addScaledVector(UP, 1.5), DOWN, 6, { excludeObjectId: objectId });
                    if (ground) return out.copy(ground.point);
                    return out.copy(to).setY(chassisPoint(0, chassis.min.y, 0, from).y);
                }
                return null;
            },
            setScriptControls(controls) {
                scriptControls.current = controls;
            },
        };
    }, [host, objectId, queries]);

    useEffect(() => (handle ? vehicleSession.register(handle) : undefined), [handle]);

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

    const _velocity = useMemo(() => new THREE.Vector3(), []);
    const _forward = useMemo(() => new THREE.Vector3(), []);
    const _bodyQuaternion = useMemo(() => new THREE.Quaternion(), []);
    const _point = useMemo(() => new THREE.Vector3(), []);

    useBeforePhysicsStep(() => {
        const current = ensureRig();
        if (!current) return;
        const s = settingsRef.current;
        const { body, controller, layout } = current;
        const dt = world.timestep;
        const playerDriving = vehicleSession.state().driving === objectId;
        const speed = controller.currentVehicleSpeed();
        const r = body.rotation();
        _bodyQuaternion.set(r.x, r.y, r.z, r.w);

        // Who drives: the player, else a level script, else the AI path, else nobody (handbrake on).
        let controls: VehicleControls;
        if (playerDriving) {
            controls = {
                throttle: input.value('MoveForward'),
                brake: input.value('MoveBack'),
                steer: input.axis('MoveLeft', 'MoveRight'),
                handbrake: input.value('Jump') > 0.5,
            };
        } else if (scriptControls.current) {
            controls = scriptControls.current;
        } else {
            const path = aiPath();
            if (path) {
                const t = body.translation();
                _point.set(t.x, t.y, t.z);
                _forward.set(0, 0, 1).applyQuaternion(_bodyQuaternion);
                controls = driveAlongPath(follower.current, path, { position: _point, forward: _forward, speed }, s, current.wheelbase);
                // Knocked well off the path: look for the nearest stretch again.
                if (follower.current.progress !== null && path.pointAt(follower.current.progress, _velocity).distanceTo(_point) > AI_REJOIN_DISTANCE) {
                    follower.current.progress = null;
                }
            } else controls = { ...NO_CONTROLS, handbrake: true };
        }
        lastControls.current = controls;

        const out = stepVehicleDrive(drive.current, controls, speed, dt, s);
        lastLoad.current = out.load;
        const angles = ackermannAngles(out.steer, current.wheelbase, current.track);
        const fronts = layout.wheels.filter(wheel => wheel.front).length || 1;
        const rears = layout.wheels.filter(wheel => !wheel.front).length || 1;
        layout.wheels.forEach((wheel, index) => {
            // Rapier turns a positive angle towards +X, the vehicle's left.
            controller.setWheelSteering(index, wheel.front ? -(wheel.left ? angles.left : angles.right) : 0);
            const share = wheel.front ? out.frontDrive / fronts : (1 - out.frontDrive) / rears;
            controller.setWheelEngineForce(index, out.driveForce * share);
            // Rapier takes the brake as an impulse per step.
            controller.setWheelBrake(index, (wheel.front ? out.frontBrake / fronts : out.rearBrake / rears) * dt);
            controller.setWheelFrictionSlip(index, !wheel.front && out.handbrake ? s.grip * s.handbrakeGrip : s.grip);
        });
        controller.updateVehicle(dt, rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, notPlayer);

        // Anti-roll bars: each axle's spring difference pushes the more compressed side up and the other down.
        if (s.antiRoll > 0) {
            for (const front of [true, false]) {
                const left = layout.wheels.findIndex(wheel => wheel.front === front && wheel.left);
                const right = layout.wheels.findIndex(wheel => wheel.front === front && !wheel.left);
                if (left < 0 || right < 0 || !controller.wheelIsInContact(left) || !controller.wheelIsInContact(right)) continue;
                const travel = (index: number) => s.suspensionTravel - (controller.wheelSuspensionLength(index) ?? s.suspensionTravel);
                const force = (travel(left) - travel(right)) * s.antiRoll * s.suspensionStiffness * s.mass;
                const up = _velocity.copy(UP).applyQuaternion(_bodyQuaternion);
                const leftPoint = controller.wheelHardPoint(left);
                const rightPoint = controller.wheelHardPoint(right);
                if (!leftPoint || !rightPoint) continue;
                body.applyImpulseAtPoint({ x: up.x * force * dt, y: up.y * force * dt, z: up.z * force * dt }, leftPoint, true);
                body.applyImpulseAtPoint({ x: -up.x * force * dt, y: -up.y * force * dt, z: -up.z * force * dt }, rightPoint, true);
            }
        }

        // Air drag, and downforce that grows with speed.
        const v = body.linvel();
        _velocity.set(v.x, v.y, v.z);
        const airSpeed = _velocity.length();
        if (airSpeed > 0.1) {
            const drag = AIR_DRAG * airSpeed * dt;
            const down = s.downforce * speed * speed * dt;
            _forward.copy(DOWN).applyQuaternion(_bodyQuaternion);
            body.applyImpulse({
                x: -v.x * drag + _forward.x * down,
                y: -v.y * drag + _forward.y * down,
                z: -v.z * drag + _forward.z * down,
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
        return () => {
            engine.current = null;
            voice.stop();
            releaseSound(sound);
            sound.removeFromParent();
            release();
        };
    }, [host, camera, mixer, audioAssets, settings.engineSound]);

    useEffect(() => {
        if (engine.current) routeSoundToBus(engine.current.sound, mixer, 'sfx');
    }, [mixer]);

    useFrame(() => {
        const current = rig.current;
        if (!current || !host || !current.body.isValid()) return;
        const { controller, layout } = current;
        const s = settingsRef.current;
        host.updateWorldMatrix(true, false);
        host.matrixWorld.decompose(_hostPosition, _hostQuaternion, _hostScale);
        _hostInverse.copy(_hostQuaternion).invert();

        // Wheels: down their suspension, turned by the steering, rolled by the travel.
        layout.wheels.forEach((_, index) => {
            const length = controller.wheelSuspensionLength(index) ?? s.suspensionTravel - restingSag(s, layout.wheels.length);
            _centre.copy(current.anchors[index]).addScaledVector(DOWN, length);
            _world.copy(_centre).applyQuaternion(_hostQuaternion).add(_hostPosition);
            _steer.setFromAxisAngle(UP, controller.wheelSteering(index) ?? 0);
            _spin.setFromAxisAngle(AXIS_X, controller.wheelRotation(index) ?? 0);
            // The wheel's turn since rest, as a world rotation.
            _turn.copy(_hostQuaternion).multiply(_steer).multiply(_spin).multiply(_hostInverse);
            for (const entry of current.nodes[index] ?? []) {
                const parent = entry.node.parent;
                if (!parent) continue;
                parent.getWorldQuaternion(_parentQuaternion);
                _parentInverse.copy(_parentQuaternion).invert();
                entry.node.quaternion.copy(_parentInverse).multiply(_turn).multiply(_parentQuaternion).multiply(entry.restQuaternion);
                const centre = parent.worldToLocal(_offset.copy(_world));
                entry.node.position.copy(centre).sub(_point.copy(entry.toCentre).applyQuaternion(entry.node.quaternion));
            }
        });

        const playerDriving = vehicleSession.state().driving === objectId;
        const controls = lastControls.current;
        const driven = playerDriving || scriptControls.current !== null || (Boolean(s.aiPath) && aiPath() !== null);
        const speed = controller.currentVehicleSpeed();
        if (playerDriving) {
            const state = drive.current;
            vehicleSession.setHud({
                objectId,
                speed: Math.round(Math.abs(speed) / KMH),
                gear: gearLabel(state.gear, speed),
                rpm: Math.round(((state.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)) * 20) / 20,
            });
        }

        // Sound: the engine runs while someone drives; the tyres squeal when the body slides sideways.
        const voice = engine.current;
        if (!voice) return;
        const context = voice.sound.context;
        const rpm = drive.current.rpm;
        const revs = (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
        const v = current.body.linvel();
        _velocity.set(v.x, v.y, v.z);
        _offset.set(-1, 0, 0).applyQuaternion(_hostQuaternion);
        const sideways = Math.abs(_velocity.dot(_offset));
        const touching = layout.wheels.some((_, index) => controller.wheelIsInContact(index));
        let squeal = touching ? THREE.MathUtils.clamp((sideways - 2) / 6, 0, 1) : 0;
        if (touching && controls.handbrake && Math.abs(speed) > 4) squeal = Math.max(squeal, 0.5);
        const level = s.engineVolume;
        if (voice.writer) {
            _engineValues[0] = rpm / 30;
            _engineValues[1] = rpm / 60;
            _engineValues[2] = 280 + 2600 * lastLoad.current + 1400 * revs;
            _engineValues[3] = driven ? level * (0.22 + 0.32 * lastLoad.current + 0.18 * revs) : 0;
            _engineValues[4] = level * 0.35 * squeal;
            voice.writer.write(context, _engineValues);
        } else if (voice.recorded && voice.sound.buffer && context.state === 'running') {
            const rate = 0.6 + 1.5 * revs;
            const volume = driven ? level * (0.45 + 0.4 * lastLoad.current) : 0;
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

    return <group ref={anchorRef} userData={PHYSICS_IGNORED_USER_DATA} />;
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
    const [layout, setLayout] = useState<{ key: string; rings: { position: THREE.Vector3; radius: number }[]; front: THREE.Vector3; length: number } | null>(null);
    const frames = useRef(0);

    useFrame(() => {
        if (frames.current++ % PREVIEW_REFRESH_FRAMES !== 0) return;
        const host = hostRef?.current ?? groupRef.current?.parent ?? null;
        if (!host) return;
        const plan = planVehicleLayout(host, settings.wheelRadius, notModel(object.id));
        const toLocal = new THREE.Matrix4().copy(host.matrixWorld).invert().multiply(chassisFrame(host));
        const rings = plan.wheels.map(wheel => ({ position: wheel.centre.clone().applyMatrix4(toLocal), radius: wheel.radius }));
        const chassis = plan.chassis;
        const front = new THREE.Vector3((chassis.min.x + chassis.max.x) / 2, chassis.max.y + 0.1, chassis.max.z).applyMatrix4(toLocal);
        const length = Math.max(0.5, (chassis.max.z - chassis.min.z) * 0.3);
        const key = rings.map(ring => `${ring.position.toArray().map(v => v.toFixed(3)).join(',')}:${ring.radius.toFixed(3)}`).join('|') + front.toArray().join(',');
        setLayout(current => (current?.key === key ? current : { key, rings, front, length }));
    });

    const scale = hostRef?.current?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
    return (
        <group ref={groupRef} userData={PHYSICS_IGNORED_USER_DATA}>
            {layout?.rings.map((ring, index) => (
                <mesh key={index} position={ring.position} rotation={[0, Math.PI / 2, 0]} scale={[1 / scale.x, 1 / scale.y, 1 / scale.z]} raycast={ignoreRaycast}>
                    <torusGeometry args={[ring.radius, Math.max(0.01, ring.radius * 0.06), 8, 32]} />
                    <meshBasicMaterial color="#f97316" depthTest={false} transparent opacity={0.85} />
                </mesh>
            ))}
            {layout && (
                <arrowHelper args={[new THREE.Vector3(0, 0, 1), layout.front, layout.length / Math.max(1e-6, scale.z), 0xf97316, 0.25, 0.15]} raycast={ignoreRaycast} />
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
            key: 'drive', label: 'Drive', type: 'select', default: VEHICLE_DEFAULTS.drive,
            options: [
                { label: 'Rear wheels', value: 'rear' },
                { label: 'Front wheels', value: 'front' },
                { label: 'All wheels', value: 'all' },
            ],
        },
        { key: 'power', label: 'Power (kW)', type: 'number', default: VEHICLE_DEFAULTS.power, min: 0, max: 5000, step: 5 },
        { key: 'maxSpeed', label: 'Top speed (km/h)', type: 'number', default: VEHICLE_DEFAULTS.maxSpeed, min: 1, max: 1000, step: 5 },
        { key: 'reverseSpeed', label: 'Reverse speed (km/h)', type: 'number', default: VEHICLE_DEFAULTS.reverseSpeed, min: 0, max: 500, step: 1 },
        { key: 'braking', label: 'Braking (m/s²)', type: 'number', default: VEHICLE_DEFAULTS.braking, min: 0, max: 100, step: 0.5 },
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
