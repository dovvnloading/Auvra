import React, { createContext, useContext, useEffect, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LevelComponent } from '../../types';
import {
    IKPoseGuard,
    applyLookAt,
    findBone,
    isDescendantOf,
    keepWorldRotation,
    limitDirection,
    offsetBoneWorld,
    solveTwoBoneIK
} from '../ik';
import { usePhysicsQueries } from '../physicsQueries';
import type { PhysicsQueries } from '../physicsQueries';
import { ANIMATION_FRAME_PRIORITY } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * IK components: they run during play, after the frame's animation (their frame callbacks use the default
 * priority, the animation mixer runs before them), and adjust the posed skeleton of the object's model.
 */

/** What a lookAtIK component looks at. */
export type LookAtTarget = 'camera' | 'player';
/** A bone's local axis, for the look-at forward direction. */
export type BoneAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

const LOOK_AT_TARGETS: readonly LookAtTarget[] = ['camera', 'player'];

const BONE_AXES: Record<BoneAxis, THREE.Vector3> = {
    '+x': new THREE.Vector3(1, 0, 0),
    '-x': new THREE.Vector3(-1, 0, 0),
    '+y': new THREE.Vector3(0, 1, 0),
    '-y': new THREE.Vector3(0, -1, 0),
    '+z': new THREE.Vector3(0, 0, 1),
    '-z': new THREE.Vector3(0, 0, -1)
};

const isBoneAxis = (value: unknown): value is BoneAxis => typeof value === 'string' && Object.hasOwn(BONE_AXES, value);

const LOOK_AT_DEFAULTS = { boneName: 'Head', target: 'camera' as LookAtTarget, maxAngle: 70, weight: 1, forwardAxis: '+z' as BoneAxis };
const FOOT_IK_DEFAULTS = { leftFoot: 'LeftFoot', rightFoot: 'RightFoot', maxStep: 0.5, weight: 1 };

/** Largest foot step setting (m). */
const MAX_STEP_LIMIT = 2;
/** Longest step smoothing takes in one frame, so resuming from a pause or a stalled tab does not jump. */
const MAX_FRAME_STEP = 0.1;
/** How fast (1/s) the look direction follows its target. */
const LOOK_SMOOTHING = 8;
/** How fast (1/s) foot heights, ground tilt and the pelvis follow the ground. */
const FOOT_SMOOTHING = 12;
/** Feet tilt to match sloped ground by at most this much. */
const MAX_FOOT_TILT = THREE.MathUtils.degToRad(35);
/** Ground whose normal is flatter than this (steeper than 60 degrees) is an edge: feet keep their pitch over it. */
const MIN_GROUND_NORMAL_Y = 0.5;
/** Offsets (m) below this leave a leg alone. */
const SETTLED = 1e-4;
/** Roughly eye height above a player object's origin, for a player model without a 'Head' bone. */
const PLAYER_EYE_HEIGHT = 1.6;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const NO_BONES: readonly THREE.Object3D[] = [];

const readNumber = (component: LevelComponent, key: string, fallback: number, min: number, max: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
};

const readString = (component: LevelComponent, key: string, fallback: string): string => {
    const value = component.props[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
};

/** Share of a smoothing step at `rate` (1/s) covered in `delta` seconds. */
const easing = (rate: number, delta: number): number =>
    1 - Math.exp(-rate * (Number.isFinite(delta) ? THREE.MathUtils.clamp(delta, 0, MAX_FRAME_STEP) : 0));

/** Nodes of other level objects nested under the host: their bones belong to their own components. */
const skipNestedObjects = (objectId: string) => (node: THREE.Object3D): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId;
};

// --- HOST BONE LOOKUP ---

/** A lookup under the host, redone only when the host, its direct children or the lookup key change, or the found value stops fitting. */
interface HostLookup<T> {
    host: THREE.Object3D | null;
    children: THREE.Object3D[];
    key: string;
    value: T | null;
}

const createHostLookup = <T,>(): HostLookup<T> => ({ host: null, children: [], key: '', value: null });

const sameChildren = (host: THREE.Object3D, children: readonly THREE.Object3D[]): boolean => {
    if (host.children.length !== children.length) return false;
    for (let i = 0; i < children.length; i++) {
        if (host.children[i] !== children[i]) return false;
    }
    return true;
};

/** Before each frame's animation, puts back the pose `guard`'s IK left (see IKPoseGuard.release). */
export const useRestoreBeforeAnimation = (guard: IKPoseGuard): void => {
    useFrame(() => guard.release(), ANIMATION_FRAME_PRIORITY - 1);
};

const lookUpUnderHost = <T,>(
    lookup: HostLookup<T>,
    host: THREE.Object3D,
    key: string,
    resolve: () => T | null,
    fits: (value: T) => boolean
): T | null => {
    if (lookup.host === host && lookup.key === key && sameChildren(host, lookup.children)
        && (lookup.value === null || fits(lookup.value))) return lookup.value;
    lookup.host = host;
    lookup.key = key;
    lookup.children = [...host.children];
    lookup.value = resolve();
    return lookup.value;
};

// --- LOOK-AT IK ---

/** A lookAtIK component's settings, read from its props. */
export interface LookAtIKSettings {
    boneName: string;
    target: LookAtTarget;
    /** Largest turn away from the animated pose, in radians. */
    maxAngle: number;
    weight: number;
    /** The bone's local axis that points at the target (+Z for Mixamo heads). */
    forward: THREE.Vector3;
}

/** A lookAtIK component's settings, with defaults for missing values and numbers clamped to their ranges. */
export const readLookAtIKSettings = (component: LevelComponent): LookAtIKSettings => {
    const target = component.props.target;
    const axis = component.props.forwardAxis;
    return {
        boneName: readString(component, 'boneName', LOOK_AT_DEFAULTS.boneName),
        target: LOOK_AT_TARGETS.includes(target as LookAtTarget) ? target as LookAtTarget : LOOK_AT_DEFAULTS.target,
        maxAngle: THREE.MathUtils.degToRad(readNumber(component, 'maxAngle', LOOK_AT_DEFAULTS.maxAngle, 0, 180)),
        weight: readNumber(component, 'weight', LOOK_AT_DEFAULTS.weight, 0, 1),
        forward: BONE_AXES[isBoneAxis(axis) ? axis : LOOK_AT_DEFAULTS.forwardAxis]
    };
};

/** What a look-at carries between frames, so its bone eases towards a moving target instead of snapping. */
export interface LookAtIKState {
    bone: THREE.Object3D | null;
    /** The eased world look direction; null until the first frame on `bone`. */
    direction: THREE.Vector3 | null;
}

/** Look-at state before its first frame. */
export const createLookAtIKState = (): LookAtIKState => ({ bone: null, direction: null });

const _bonePosition = new THREE.Vector3();
const _boneForward = new THREE.Vector3();
const _wanted = new THREE.Vector3();
const _limited = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();

/**
 * One frame of look-at IK on the bone's current (animated) pose. The look direction is limited to
 * maxAngle first and eased after, so a target passing behind the head swings it back through the front
 * instead of flipping it from one shoulder to the other; then the bone turns along that direction.
 */
export const updateLookAtIK = (
    bone: THREE.Object3D,
    target: THREE.Vector3,
    settings: Pick<LookAtIKSettings, 'maxAngle' | 'weight' | 'forward'>,
    state: LookAtIKState,
    delta: number
): void => {
    if (state.bone !== bone) {
        state.bone = bone;
        state.direction = null;
    }
    if (!(settings.weight > 0)) return;
    bone.updateWorldMatrix(true, false);
    _bonePosition.setFromMatrixPosition(bone.matrixWorld);
    _boneForward.copy(settings.forward).transformDirection(bone.matrixWorld);
    _wanted.subVectors(target, _bonePosition);
    if (!(_wanted.lengthSq() > 1e-12) || !(_boneForward.lengthSq() > 0.5)) return;
    limitDirection(_boneForward, _wanted.normalize(), settings.maxAngle, _limited);

    // The first frame starts from the animated pose and turns from there.
    const direction = state.direction ?? (state.direction = _boneForward.clone());
    direction.lerp(_limited, easing(LOOK_SMOOTHING, delta));
    if (direction.lengthSq() > 1e-12) direction.normalize();
    else direction.copy(_limited);
    applyLookAt(bone, _lookPoint.copy(_bonePosition).add(direction), settings.forward, settings.maxAngle, settings.weight);
};

/**
 * The player character's object in a play session, for look-at targets set to 'player'. Without a
 * provider, or before the object mounts, 'player' follows the camera instead.
 */
export const IKPlayerTargetContext = createContext<React.RefObject<THREE.Object3D | null> | null>(null);

interface PlayerHead {
    player: THREE.Object3D | null;
    head: THREE.Object3D | null;
}

/** Where a look-at aims: the camera, or the player's head bone (else the player's origin raised to eye height). */
const lookTargetPosition = (
    target: LookAtTarget,
    camera: THREE.Camera,
    player: THREE.Object3D | null,
    cache: PlayerHead,
    out: THREE.Vector3
): THREE.Vector3 => {
    if (target !== 'player' || !player) return camera.getWorldPosition(out);
    if (cache.player !== player || (cache.head && !isDescendantOf(cache.head, player))) {
        cache.player = player;
        cache.head = findBone(player, 'Head');
    }
    return cache.head
        ? cache.head.getWorldPosition(out)
        : player.getWorldPosition(out).addScaledVector(UP, PLAYER_EYE_HEIGHT);
};

const _lookTarget = new THREE.Vector3();

const LookAtIKRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const hostRef = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const settings = readLookAtIKSettings(component);
    const [guard] = useState(() => new IKPoseGuard());
    const [lookup] = useState(() => createHostLookup<THREE.Object3D>());
    const [state] = useState(createLookAtIKState);
    const [playerHead] = useState((): PlayerHead => ({ player: null, head: null }));
    useEffect(() => () => guard.release(), [guard]);
    useRestoreBeforeAnimation(guard);

    useFrame((frame, delta) => {
        const host = hostRef?.current;
        if (!host) return;
        const bone = lookUpUnderHost(
            lookup, host, settings.boneName,
            () => findBone(host, settings.boneName, skipNestedObjects(object.id)),
            found => isDescendantOf(found, host)
        );
        guard.begin(bone ? [bone] : NO_BONES);
        if (bone) {
            const target = lookTargetPosition(settings.target, frame.camera, playerRef?.current ?? null, playerHead, _lookTarget);
            updateLookAtIK(bone, target, settings, state, delta);
        }
        guard.commit();
    });

    return null;
};

const LookAtIKRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <LookAtIKRuntime {...props} /> : null
);

// --- FOOT IK ---

/** A footIK component's settings, read from its props. */
export interface FootIKSettings {
    leftFoot: string;
    rightFoot: string;
    /** Highest step up or down a foot follows (m). */
    maxStep: number;
    weight: number;
}

/** A footIK component's settings, with defaults for missing values and numbers clamped to their ranges. */
export const readFootIKSettings = (component: LevelComponent): FootIKSettings => ({
    leftFoot: readString(component, 'leftFoot', FOOT_IK_DEFAULTS.leftFoot),
    rightFoot: readString(component, 'rightFoot', FOOT_IK_DEFAULTS.rightFoot),
    maxStep: readNumber(component, 'maxStep', FOOT_IK_DEFAULTS.maxStep, 0, MAX_STEP_LIMIT),
    weight: readNumber(component, 'weight', FOOT_IK_DEFAULTS.weight, 0, 1)
});

/** One leg: the foot, its parent and grandparent, and a child bone (the toes) that shows where the foot points. */
export interface FootIKLeg {
    thigh: THREE.Object3D;
    calf: THREE.Object3D;
    foot: THREE.Object3D;
    toe: THREE.Object3D | null;
}

/** The legs foot IK moves, resolved once per model. */
export interface FootIKRig {
    /** The thighs' shared parent, lowered when a foot has to reach down; null when the legs have none under the root. */
    hips: THREE.Object3D | null;
    legs: FootIKLeg[];
}

/**
 * The legs under `root` for the named foot bones (found with findBone): each foot with its parent (calf)
 * and grandparent (thigh), which must sit below `root`. Null when no leg is found.
 */
export const resolveFootIKRig = (
    root: THREE.Object3D,
    footNames: readonly string[],
    skip?: (node: THREE.Object3D) => boolean
): FootIKRig | null => {
    const legs: FootIKLeg[] = [];
    for (const name of footNames) {
        const foot = findBone(root, name, skip);
        const calf = foot?.parent ?? null;
        const thigh = calf?.parent ?? null;
        if (!foot || !calf || !thigh || thigh === root || !isDescendantOf(thigh, root)) continue;
        if (legs.some(leg => leg.foot === foot)) continue;
        const toe = foot.children.find(child => (child as THREE.Bone).isBone) ?? null;
        legs.push({ thigh, calf, foot, toe });
    }
    if (!legs.length) return null;
    const hips = legs[0].thigh.parent;
    const shared = hips && hips !== root && isDescendantOf(hips, root) && legs.every(leg => leg.thigh.parent === hips);
    return { hips: shared ? hips : null, legs };
};

/** Every bone a foot IK pass may move, for IKPoseGuard. */
export const footIKBones = (rig: FootIKRig): THREE.Object3D[] => [
    ...(rig.hips ? [rig.hips] : []),
    ...rig.legs.flatMap(leg => [leg.thigh, leg.calf, leg.foot])
];

/** How one foot IK pass runs. */
export interface FootIKOptions {
    maxStep: number;
    weight: number;
    /** Colliders of this object are not ground (the character's own body). */
    excludeObjectId?: string;
}

/** What foot IK carries between frames, so feet, tilt and pelvis ease onto new ground instead of snapping. */
export interface FootIKState {
    rig: FootIKRig | null;
    /** Per leg: the eased height of the ground under the foot above the host's floor (m). */
    offsets: number[];
    /** Per leg: the eased ground normal. */
    normals: THREE.Vector3[];
}

/** Foot IK state before its first frame. */
export const createFootIKState = (): FootIKState => ({ rig: null, offsets: [], normals: [] });

const _floor = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _feet: THREE.Vector3[] = [];
const _goal = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _toward = new THREE.Vector3();
const _pelvisOffset = new THREE.Vector3();
const _tiltNormal = new THREE.Vector3();
const _tilt = new THREE.Quaternion();
const _calfBefore = new THREE.Matrix4();

/** A point ahead of the knee, where the toes point (else the host's +Z), so knees bend forward; null when neither gives a heading. */
const kneePole = (host: THREE.Object3D, leg: FootIKLeg, out: THREE.Vector3): THREE.Vector3 | null => {
    _toward.set(0, 0, 0);
    if (leg.toe) _toward.setFromMatrixPosition(leg.toe.matrixWorld).sub(_knee.setFromMatrixPosition(leg.foot.matrixWorld));
    _toward.y = 0;
    if (!(_toward.lengthSq() > 1e-10)) {
        _toward.set(0, 0, 1).transformDirection(host.matrixWorld);
        _toward.y = 0;
    }
    if (!(_toward.lengthSq() > 1e-10)) return null;
    _knee.setFromMatrixPosition(leg.calf.matrixWorld);
    const thighLength = _knee.distanceTo(_hip.setFromMatrixPosition(leg.thigh.matrixWorld));
    return out.copy(_knee).addScaledVector(_toward.normalize(), Math.max(thighLength, 0.1));
};

/**
 * One frame of foot IK on the current (animated) pose of `rig` under `host`. Each foot casts a ray
 * straight down from `maxStep` above it; ground within `maxStep` of the host's floor (its origin height)
 * moves the foot up or down by that much, so a lifted foot stays lifted above the new ground. The pelvis
 * drops to the lowest foot's ground so that leg can reach, raised ground bends the other knee, and each
 * foot keeps its animated orientation tilted to the ground's slope. A foot with no ground within reach
 * eases back to its animated pose and is then left alone.
 */
export const updateFootIK = (
    host: THREE.Object3D,
    rig: FootIKRig,
    raycast: PhysicsQueries['raycast'],
    options: FootIKOptions,
    state: FootIKState,
    delta: number
): void => {
    if (state.rig !== rig) {
        state.rig = rig;
        state.offsets = [];
        state.normals = [];
    }
    const weight = Math.min(1, options.weight);
    const maxStep = options.maxStep;
    if (!(weight > 0) || !(maxStep > 0)) return;
    const ease = easing(FOOT_SMOOTHING, delta);
    const rayOptions = { excludeObjectId: options.excludeObjectId };
    host.updateWorldMatrix(true, false);
    const floor = _floor.setFromMatrixPosition(host.matrixWorld).y;

    // The ground under each animated foot, as a height above the floor the character stands on.
    let pelvis = 0;
    for (let i = 0; i < rig.legs.length; i++) {
        const leg = rig.legs[i];
        leg.foot.updateWorldMatrix(true, false);
        leg.toe?.updateWorldMatrix(false, false);
        const foot = (_feet[i] ??= new THREE.Vector3()).setFromMatrixPosition(leg.foot.matrixWorld);
        _rayOrigin.set(foot.x, foot.y + maxStep, foot.z);
        const length = _rayOrigin.y - (floor - maxStep);
        const hit = length > 0 ? raycast(_rayOrigin, DOWN, length, rayOptions) : null;
        const step = hit ? hit.point.y - floor : 0;
        const grounded = hit !== null && Math.abs(step) <= maxStep;
        state.offsets[i] = THREE.MathUtils.lerp(state.offsets[i] ?? 0, grounded ? step : 0, ease);
        const normal = state.normals[i] ?? (state.normals[i] = UP.clone());
        normal.lerp(hit && grounded && hit.normal.y >= MIN_GROUND_NORMAL_Y ? hit.normal : UP, ease);
        if (normal.lengthSq() > 1e-12) normal.normalize();
        else normal.copy(UP);
        pelvis = Math.min(pelvis, state.offsets[i]);
    }

    // Lower ground under one foot drops the pelvis so that leg reaches; higher ground only bends a knee.
    const drop = pelvis * weight;
    const dropped = rig.hips !== null && drop < -SETTLED;
    if (rig.hips && dropped) offsetBoneWorld(rig.hips, _pelvisOffset.set(0, drop, 0));

    for (let i = 0; i < rig.legs.length; i++) {
        const leg = rig.legs[i];
        const offset = state.offsets[i];
        const normal = state.normals[i];
        if (!dropped && Math.abs(offset) < SETTLED && normal.y > 1 - 1e-8) continue;
        _goal.copy(_feet[i]).addScaledVector(UP, offset);
        _calfBefore.copy(leg.calf.matrixWorld);
        solveTwoBoneIK(leg.thigh, leg.calf, leg.foot, _goal, kneePole(host, leg, _pole), weight);
        limitDirection(UP, normal, MAX_FOOT_TILT, _tiltNormal);
        keepWorldRotation(leg.foot, _calfBefore, _tilt.setFromUnitVectors(UP, _tiltNormal), weight);
    }
};

interface FootIKSetup {
    rig: FootIKRig;
    bones: THREE.Object3D[];
}

const rigFits = (host: THREE.Object3D, rig: FootIKRig): boolean => {
    for (const leg of rig.legs) {
        if (leg.foot.parent !== leg.calf || leg.calf.parent !== leg.thigh || !isDescendantOf(leg.thigh, host)) return false;
    }
    return true;
};

const FootIKRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const hostRef = useContext(ComponentHostContext);
    const physics = usePhysicsQueries();
    const settings = readFootIKSettings(component);
    const [guard] = useState(() => new IKPoseGuard());
    const [lookup] = useState(() => createHostLookup<FootIKSetup>());
    const [state] = useState(createFootIKState);
    useEffect(() => () => guard.release(), [guard]);
    useRestoreBeforeAnimation(guard);

    useFrame((_frame, delta) => {
        const host = hostRef?.current;
        if (!host) return;
        const setup = lookUpUnderHost(
            lookup, host, `${settings.leftFoot}|${settings.rightFoot}`,
            () => {
                const rig = resolveFootIKRig(host, [settings.leftFoot, settings.rightFoot], skipNestedObjects(object.id));
                return rig ? { rig, bones: footIKBones(rig) } : null;
            },
            found => rigFits(host, found.rig)
        );
        guard.begin(setup ? setup.bones : NO_BONES);
        if (setup) {
            updateFootIK(host, setup.rig, physics.raycast, {
                maxStep: settings.maxStep,
                weight: settings.weight,
                excludeObjectId: object.id
            }, state, delta);
        }
        guard.commit();
    });

    return null;
};

const FootIKRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <FootIKRuntime {...props} /> : null
);

// --- REACH IK ---

/** A twoBoneIK component's settings, read from its props. */
export interface ReachIKSettings {
    /** The bone that reaches (a hand or a foot); it and the two bones above it bend. */
    endBone: string;
    /** What it reaches for: a level object's id, or 'player'. Empty reaches for nothing. */
    target: string;
    /** Added to the target's position, in world units. */
    offset: THREE.Vector3;
    weight: number;
}

const REACH_DEFAULTS = { endBone: 'RightHand', weight: 1 };

export const readReachIKSettings = (component: LevelComponent): ReachIKSettings => {
    const offset = component.props.offset;
    return {
        endBone: readString(component, 'endBone', REACH_DEFAULTS.endBone),
        target: typeof component.props.target === 'string' ? component.props.target.trim() : '',
        offset: Array.isArray(offset) && offset.length === 3 && offset.every(value => typeof value === 'number' && Number.isFinite(value))
            ? new THREE.Vector3(offset[0], offset[1], offset[2])
            : new THREE.Vector3(),
        weight: readNumber(component, 'weight', REACH_DEFAULTS.weight, 0, 1),
    };
};

/** The nearest bone above `node`, or null. */
const boneAbove = (node: THREE.Object3D): THREE.Object3D | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if ((parent as THREE.Bone).isBone) return parent;
    }
    return null;
};

/** The three bones a reach bends, top down (upper arm, forearm, hand), or null when `end` has fewer above it. */
export const resolveReachChain = (end: THREE.Object3D): [THREE.Object3D, THREE.Object3D, THREE.Object3D] | null => {
    const mid = boneAbove(end);
    const root = mid ? boneAbove(mid) : null;
    return root && mid ? [root, mid, end] : null;
};

/** A level object's transform group in the scene, by id. */
const findLevelObject = (scene: THREE.Object3D, id: string): THREE.Object3D | null => {
    let found: THREE.Object3D | null = null;
    scene.traverse((node) => {
        if (!found && node.userData?.levelObjectId === id && !(node as THREE.Mesh).isMesh) found = node;
    });
    return found;
};

const _reach = new THREE.Vector3();

const ReachIKRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const hostRef = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const settings = readReachIKSettings(component);
    const [guard] = useState(() => new IKPoseGuard());
    const [lookup] = useState(() => createHostLookup<[THREE.Object3D, THREE.Object3D, THREE.Object3D]>());
    // The target's group, found once and looked for again only when it leaves the scene.
    const [targetCache] = useState(() => ({ id: '', node: null as THREE.Object3D | null }));
    useEffect(() => () => guard.release(), [guard]);
    useRestoreBeforeAnimation(guard);

    useFrame(({ scene }) => {
        const host = hostRef?.current;
        if (!host) return;
        const chain = lookUpUnderHost(
            lookup, host, settings.endBone,
            () => {
                const end = findBone(host, settings.endBone, skipNestedObjects(object.id));
                return end ? resolveReachChain(end) : null;
            },
            found => found.every(bone => isDescendantOf(bone, host))
        );
        let target: THREE.Object3D | null = null;
        if (settings.target === 'player') {
            target = playerRef?.current ?? null;
        } else if (settings.target && settings.target !== object.id) {
            if (targetCache.id !== settings.target || !targetCache.node || !isDescendantOf(targetCache.node, scene)) {
                targetCache.id = settings.target;
                targetCache.node = findLevelObject(scene, settings.target);
            }
            target = targetCache.node;
        }
        guard.begin(chain && target ? chain : NO_BONES);
        if (chain && target) {
            target.getWorldPosition(_reach).add(settings.offset);
            solveTwoBoneIK(chain[0], chain[1], chain[2], _reach, null, settings.weight);
        }
        guard.commit();
    });

    return null;
};

const ReachIKRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <ReachIKRuntime {...props} /> : null
);

// --- DEFINITIONS ---

/** The IK component types, for the component registry. */
export const IK_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'lookAtIK',
        label: 'Look At IK',
        description: 'During play, turns a bone of the object\'s model (the head by default) towards the camera or the player, up to a maximum angle from its animated pose.',
        props: [
            { key: 'boneName', label: 'Bone', type: 'string', default: LOOK_AT_DEFAULTS.boneName },
            {
                key: 'target', label: 'Look At', type: 'select', default: LOOK_AT_DEFAULTS.target,
                options: [{ label: 'Camera', value: 'camera' }, { label: 'Player', value: 'player' }]
            },
            { key: 'maxAngle', label: 'Max Angle (deg)', type: 'number', default: LOOK_AT_DEFAULTS.maxAngle, min: 0, max: 180, step: 1 },
            { key: 'weight', label: 'Weight', type: 'number', default: LOOK_AT_DEFAULTS.weight, min: 0, max: 1, step: 0.05 },
            {
                key: 'forwardAxis', label: 'Bone Forward Axis', type: 'select', default: LOOK_AT_DEFAULTS.forwardAxis,
                options: (Object.keys(BONE_AXES) as BoneAxis[]).map(axis => ({ label: axis.toUpperCase(), value: axis }))
            }
        ],
        Render: LookAtIKRender
    },
    {
        type: 'footIK',
        label: 'Foot IK',
        description: 'During play, plants the feet of the object\'s model on the ground under them (physics colliders), up or down by at most Max Step, bending the knees and lowering the hips as needed.',
        props: [
            { key: 'leftFoot', label: 'Left Foot Bone', type: 'string', default: FOOT_IK_DEFAULTS.leftFoot },
            { key: 'rightFoot', label: 'Right Foot Bone', type: 'string', default: FOOT_IK_DEFAULTS.rightFoot },
            { key: 'maxStep', label: 'Max Step (m)', type: 'number', default: FOOT_IK_DEFAULTS.maxStep, min: 0, max: MAX_STEP_LIMIT, step: 0.05 },
            { key: 'weight', label: 'Weight', type: 'number', default: FOOT_IK_DEFAULTS.weight, min: 0, max: 1, step: 0.05 }
        ],
        Render: FootIKRender
    },
    {
        type: 'twoBoneIK',
        label: 'Reach IK',
        description: 'During play, bends a limb of the object\'s model so a bone (a hand by default, with the forearm and upper arm above it) reaches another object or the player: a hand on a lever, a foot on a pedal.',
        props: [
            { key: 'endBone', label: 'Reaching Bone', type: 'string', default: REACH_DEFAULTS.endBone },
            { key: 'offset', label: 'Offset From Target', type: 'vector3', default: [0, 0, 0], step: 0.05 },
            { key: 'weight', label: 'Weight', type: 'number', default: REACH_DEFAULTS.weight, min: 0, max: 1, step: 0.05 }
        ],
        Render: ReachIKRender
    }
];
