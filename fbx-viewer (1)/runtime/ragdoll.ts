import * as THREE from 'three';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { findBone } from './ik';

type RapierWorld = RapierContext['world'];
type RapierModule = RapierContext['rapier'];

/**
 * RAGDOLLS
 *
 * A humanoid skeleton becomes a chain of capsule rigid bodies (pelvis, chest, head, upper and lower
 * arms and legs) joined by ball joints at the bones' pivots. Each frame after the animation, every
 * segment's bone takes its body's world rotation (and the hips its position), so the character
 * collapses under physics while its bone lengths stay as authored.
 */

/** One rigid segment: `bone` is posed by the body, which spans from the bone to `tip`. */
export interface RagdollSegment {
    name: string;
    bone: THREE.Object3D;
    tip: THREE.Object3D | null;
    /** Capsule radius and half-height of its cylinder part, in world units. */
    radius: number;
    halfHeight: number;
    /** Segment that this one hangs from; null for the pelvis. */
    parent: string | null;
}

export interface RagdollPlan {
    root: THREE.Object3D;
    segments: RagdollSegment[];
}

/** Segment layout: bone, the bone its capsule reaches toward, parent segment, radius as a fraction of the length. */
const LAYOUT: { name: string; bone: string; tip: string[]; parent: string | null; radius: number }[] = [
    { name: 'pelvis', bone: 'Hips', tip: ['Spine'], parent: null, radius: 0.55 },
    { name: 'chest', bone: 'Spine', tip: ['Neck', 'Head'], parent: 'pelvis', radius: 0.4 },
    { name: 'head', bone: 'Head', tip: ['HeadTop_End', 'HeadTop'], parent: 'chest', radius: 0.45 },
    { name: 'upperArmL', bone: 'LeftArm', tip: ['LeftForeArm'], parent: 'chest', radius: 0.18 },
    { name: 'lowerArmL', bone: 'LeftForeArm', tip: ['LeftHand'], parent: 'upperArmL', radius: 0.15 },
    { name: 'upperArmR', bone: 'RightArm', tip: ['RightForeArm'], parent: 'chest', radius: 0.18 },
    { name: 'lowerArmR', bone: 'RightForeArm', tip: ['RightHand'], parent: 'upperArmR', radius: 0.15 },
    { name: 'thighL', bone: 'LeftUpLeg', tip: ['LeftLeg'], parent: 'pelvis', radius: 0.16 },
    { name: 'shinL', bone: 'LeftLeg', tip: ['LeftFoot'], parent: 'thighL', radius: 0.13 },
    { name: 'thighR', bone: 'RightUpLeg', tip: ['RightLeg'], parent: 'pelvis', radius: 0.16 },
    { name: 'shinR', bone: 'RightLeg', tip: ['RightFoot'], parent: 'thighR', radius: 0.13 },
];

/** Bones every humanoid ragdoll needs; without them the character keeps its death animation. */
const REQUIRED = ['pelvis', 'chest', 'thighL', 'shinL', 'thighR', 'shinR'];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const worldPosition = (object: THREE.Object3D, out: THREE.Vector3) => out.setFromMatrixPosition(object.matrixWorld);

/** The ragdoll layout for a humanoid skeleton under `root` (mixamorig and plain names), or null when it is not one. */
export const buildRagdollPlan = (root: THREE.Object3D): RagdollPlan | null => {
    root.updateMatrixWorld(true);
    const segments: RagdollSegment[] = [];
    const found = new Set<string>();
    for (const entry of LAYOUT) {
        const bone = findBone(root, entry.bone);
        if (!bone || (entry.parent && !found.has(entry.parent))) continue;
        const tip = entry.tip.map(name => findBone(root, name)).find((candidate): candidate is THREE.Object3D => !!candidate) ?? null;
        worldPosition(bone, _a);
        // A head has no tip bone in many rigs: give it a length of about its distance to the chest.
        const length = tip ? worldPosition(tip, _b).distanceTo(_a) : entry.name === 'head' ? headLength(segments, _a) : 0;
        if (!(length > 1e-4)) continue;
        const radius = Math.max(1e-3, length * entry.radius * 0.5);
        segments.push({ name: entry.name, bone, tip, radius, halfHeight: Math.max(0, length / 2 - radius), parent: entry.parent });
        found.add(entry.name);
    }
    if (!REQUIRED.every(name => found.has(name))) return null;
    return { root, segments };
};

const headLength = (segments: RagdollSegment[], headPosition: THREE.Vector3): number => {
    const chest = segments.find(segment => segment.name === 'chest');
    return chest ? worldPosition(chest.bone, _b).distanceTo(headPosition) * 0.6 : 0;
};

/** A built ragdoll: its bodies, and the bone write-back to run each frame after the animation. */
export interface Ragdoll {
    bodies: Map<string, RapierRigidBody>;
    /** Poses every segment's bone from its body. */
    step(): void;
    dispose(): void;
}

/** Ragdoll parts collide with the world but not with each other (Rapier membership << 16 | filter). */
export const RAGDOLL_COLLISION_GROUPS = (0x0002 << 16) | 0xfffd;

const UP = new THREE.Vector3(0, 1, 0);

interface SegmentState {
    segment: RagdollSegment;
    body: RapierRigidBody;
    /** The bone's world rotation relative to its body's, fixed at creation. */
    boneOffset: THREE.Quaternion;
    /** The bone's position in its body's frame, fixed at creation (only the pelvis uses it). */
    boneLocal: THREE.Vector3;
}

const _start = new THREE.Vector3();
const _end = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _bodyRotation = new THREE.Quaternion();
const _boneRotation = new THREE.Quaternion();
const _parentRotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _position = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/**
 * Builds the bodies and joints for `plan` in `world`, posed as the skeleton is now, moving at
 * `velocity` (world units per second).
 */
export const createRagdoll = (world: RapierWorld, rapier: RapierModule, plan: RagdollPlan, velocity: THREE.Vector3 = new THREE.Vector3()): Ragdoll => {
    plan.root.updateMatrixWorld(true);
    const states = new Map<string, SegmentState>();
    const joints: ReturnType<RapierWorld['createImpulseJoint']>[] = [];

    for (const segment of plan.segments) {
        worldPosition(segment.bone, _start);
        if (segment.tip) worldPosition(segment.tip, _end);
        else _end.copy(_start).addScaledVector(UP, segment.halfHeight * 2 + segment.radius * 2);
        _direction.subVectors(_end, _start);
        if (_direction.lengthSq() < 1e-10) _direction.copy(UP);
        _direction.normalize();
        _bodyRotation.setFromUnitVectors(UP, _direction);
        _centre.addVectors(_start, _end).multiplyScalar(0.5);

        const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic()
            .setTranslation(_centre.x, _centre.y, _centre.z)
            .setRotation({ x: _bodyRotation.x, y: _bodyRotation.y, z: _bodyRotation.z, w: _bodyRotation.w })
            .setLinvel(velocity.x, velocity.y, velocity.z)
            .setLinearDamping(0.2)
            .setAngularDamping(2));
        world.createCollider(rapier.ColliderDesc.capsule(segment.halfHeight, segment.radius)
            .setDensity(900)
            .setFriction(0.8)
            .setCollisionGroups(RAGDOLL_COLLISION_GROUPS), body);

        segment.bone.matrixWorld.decompose(_position, _boneRotation, _scale);
        const boneOffset = _bodyRotation.clone().invert().multiply(_boneRotation);
        const boneLocal = _start.clone().sub(_centre).applyQuaternion(_bodyRotation.clone().invert());
        states.set(segment.name, { segment, body, boneOffset, boneLocal });
    }

    // Ball joints at each child bone's pivot, expressed in both bodies' frames.
    for (const state of states.values()) {
        const parent = state.segment.parent ? states.get(state.segment.parent) : undefined;
        if (!parent) continue;
        worldPosition(state.segment.bone, _a);
        const anchorIn = (target: SegmentState) => {
            const translation = target.body.translation();
            const rotation = target.body.rotation();
            const inverse = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert();
            const local = _a.clone().sub(new THREE.Vector3(translation.x, translation.y, translation.z)).applyQuaternion(inverse);
            return { x: local.x, y: local.y, z: local.z };
        };
        const joint = world.createImpulseJoint(rapier.JointData.spherical(anchorIn(parent), anchorIn(state)), parent.body, state.body, true);
        joint.setContactsEnabled(false);
        joints.push(joint);
    }

    const bodies = new Map([...states].map(([name, state]) => [name, state.body]));
    let disposed = false;

    return {
        bodies,
        step() {
            if (disposed) return;
            // Parents first (LAYOUT order), so each child reads its parent's new world matrix.
            for (const state of states.values()) {
                const { bone } = state.segment;
                const translation = state.body.translation();
                const rotation = state.body.rotation();
                _bodyRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
                _boneRotation.copy(_bodyRotation).multiply(state.boneOffset);
                const parent = bone.parent;
                if (parent) {
                    parent.updateWorldMatrix(true, false);
                    parent.matrixWorld.decompose(_position, _parentRotation, _scale);
                    bone.quaternion.copy(_parentRotation.invert().multiply(_boneRotation));
                } else {
                    bone.quaternion.copy(_boneRotation);
                }
                if (!state.segment.parent) {
                    // The pelvis also carries the body's position; every other bone keeps its length.
                    _position.copy(state.boneLocal).applyQuaternion(_bodyRotation).add(_centre.set(translation.x, translation.y, translation.z));
                    if (parent) _position.applyMatrix4(_matrix.copy(parent.matrixWorld).invert());
                    bone.position.copy(_position);
                }
                bone.updateMatrixWorld(true);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const joint of joints) if (world.getImpulseJoint(joint.handle)) world.removeImpulseJoint(joint, true);
            for (const body of bodies.values()) if (world.getRigidBody(body.handle)) world.removeRigidBody(body);
        },
    };
};
