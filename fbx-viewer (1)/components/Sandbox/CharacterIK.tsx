import React, { useContext, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { CharacterIKSettings } from '../../types';
import { findBone, IKPoseGuard, reachWithHand, supportGripPoint, type SupportGrip } from '../../runtime/ik';
import { mirrorBoneName } from '../../utils/retargeting';
import { usePhysicsQueries } from '../../runtime/physics';
import {
    createFootIKState,
    createLookAtIKState,
    footIKBones,
    IKPlayerTargetContext,
    resolveFootIKRig,
    updateFootIK,
    updateLookAtIK,
    useRestoreBeforeAnimation,
} from '../../runtime/components/ikComponents';

const DEFAULT_FOOT_STEP = 0.5;
const DEFAULT_LOOK_BONE = 'Head';
const DEFAULT_LOOK_ANGLE = 70;
/** Mixamo heads look along their local +Z. */
const HEAD_FORWARD = new THREE.Vector3(0, 0, 1);
const PLAYER_EYE_HEIGHT = 1.6;

/** A blueprint's IK settings with defaults filled in and numbers clamped. */
export const resolveCharacterIK = (settings: CharacterIKSettings | undefined) => {
    const finite = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    return {
        footIK: settings?.footIK === true,
        footMaxStep: finite(settings?.footMaxStep, DEFAULT_FOOT_STEP, 0, 10),
        lookAt: settings?.lookAt === 'camera' || settings?.lookAt === 'player' ? settings.lookAt : 'none' as const,
        lookAtBone: settings?.lookAtBone?.trim() || DEFAULT_LOOK_BONE,
        lookAtMaxAngle: THREE.MathUtils.degToRad(finite(settings?.lookAtMaxAngle, DEFAULT_LOOK_ANGLE, 0, 180)),
        aimPitch: settings?.aimPitch === true,
    };
};

interface CharacterIKProps {
    model: THREE.Object3D;
    settings?: CharacterIKSettings;
    /** The character's own physics id, so its capsule is not taken for ground. */
    physicsId?: string;
    /** The player is aiming: with aimPitch on, the spine follows the camera up and down. */
    aiming?: boolean;
    /** A weapon held in one hand: the other hand takes hold of it (WeaponSettings.supportGrip). */
    supportGrip?: HeldWeaponGrip | null;
}

/** A held weapon's support grip, with the bone of the hand that holds the weapon. */
export interface HeldWeaponGrip extends SupportGrip {
    boneName: string;
}

/** How fast the other hand takes hold of and lets go of a weapon (per second). */
const GRIP_BLEND_RATE = 14;
const _gripTarget = new THREE.Vector3();

const _lookTarget = new THREE.Vector3();
const _aimDirection = new THREE.Vector3();
const _aimRight = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _boneWorld = new THREE.Quaternion();
const _parentWorld = new THREE.Quaternion();

/** The spine bones the aim lean is shared across, bottom up. */
const AIM_SPINE = ['Spine', 'Spine1', 'Spine2'];
/** The furthest the spine leans up or down to follow the aim. */
const MAX_AIM_PITCH = THREE.MathUtils.degToRad(60);
/** How quickly the lean comes in and goes, per second. */
const AIM_BLEND_RATE = 8;

/** Turns `bone` by `angle` radians about the world-space `axis`, keeping its parent where it is. */
export const turnBoneAboutWorldAxis = (bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void => {
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_boneWorld).premultiply(_turn.setFromAxisAngle(axis, angle));
    if (bone.parent) bone.parent.getWorldQuaternion(_parentWorld).invert();
    else _parentWorld.identity();
    bone.quaternion.copy(_parentWorld.multiply(_boneWorld));
    bone.updateMatrixWorld(true);
};

/**
 * The lean that points an aim along the camera: the camera's pitch (up positive), at most
 * MAX_AIM_PITCH, scaled by `weight`.
 */
export const aimPitch = (direction: THREE.Vector3, weight: number): number =>
    THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)), -MAX_AIM_PITCH, MAX_AIM_PITCH) * weight;

/**
 * Applies a character blueprint's IK after its animation graph each frame (the graph animates at
 * priority -1, this runs at the default priority): foot planting on the ground under each foot and
 * a look-at toward the camera or the player.
 */
export const CharacterIK: React.FC<CharacterIKProps> = ({ model, settings, physicsId, aiming = false, supportGrip = null }) => {
    const resolved = resolveCharacterIK(settings);
    const physics = usePhysicsQueries();
    const playerRef = useContext(IKPlayerTargetContext);
    const [guard] = useState(() => new IKPoseGuard());
    const [footState] = useState(createFootIKState);
    const [lookState] = useState(createLookAtIKState);
    const [aimState] = useState(() => ({ weight: 0 }));
    const [gripState] = useState(() => ({ weight: 0, grip: null as HeldWeaponGrip | null }));
    useEffect(() => () => guard.release(), [guard, model]);
    useRestoreBeforeAnimation(guard);

    const rig = useMemo(() => (resolved.footIK ? resolveFootIKRig(model, ['LeftFoot', 'RightFoot']) : null), [model, resolved.footIK]);
    const lookBone = useMemo(() => (resolved.lookAt !== 'none' ? findBone(model, resolved.lookAtBone) : null), [model, resolved.lookAt, resolved.lookAtBone]);
    const spine = useMemo(
        () => (resolved.aimPitch ? AIM_SPINE.map(name => findBone(model, name)).filter((bone): bone is THREE.Object3D => !!bone) : []),
        [model, resolved.aimPitch],
    );
    // The hand holding the weapon, and the other arm that takes hold of it.
    const gripBone = supportGrip?.boneName ?? gripState.grip?.boneName ?? null;
    const supportArm = useMemo(() => {
        const gripHand = gripBone ? findBone(model, gripBone) : null;
        const otherName = gripBone ? mirrorBoneName(gripBone) : null;
        const hand = otherName ? findBone(model, otherName) : null;
        const forearm = hand?.parent;
        const arm = forearm?.parent;
        if (!gripHand || !hand || hand === gripHand || !forearm || !arm) return null;
        let palm: THREE.Object3D | null = null;
        hand.traverse(bone => { if (!palm && /middle1$/i.test(bone.name)) palm = bone; });
        return { gripHand, arm, forearm, hand, palm: palm as THREE.Object3D | null };
    }, [model, gripBone]);
    const bones = useMemo(
        () => [
            ...(rig ? footIKBones(rig) : []), ...spine, ...(lookBone ? [lookBone] : []),
            ...(supportArm ? [supportArm.arm, supportArm.forearm, supportArm.hand] : []),
        ],
        [rig, spine, lookBone, supportArm],
    );

    useFrame(({ camera }, delta) => {
        if (!bones.length) return;
        guard.begin(bones);
        if (rig) {
            updateFootIK(model, rig, physics.raycast, { maxStep: resolved.footMaxStep, weight: 1, excludeObjectId: physicsId }, footState, delta);
        }
        if (spine.length) {
            // The lean eases in and out with aiming, and is shared by the spine bones bottom up.
            aimState.weight += ((aiming ? 1 : 0) - aimState.weight) * (1 - Math.exp(-AIM_BLEND_RATE * delta));
            if (aimState.weight > 1e-3) {
                const lean = aimPitch(camera.getWorldDirection(_aimDirection), aimState.weight);
                _aimRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
                for (const bone of spine) turnBoneAboutWorldAxis(bone, _aimRight, lean / spine.length);
            }
        }
        if (supportArm) {
            // Eases in when a weapon is taken up and out when it is put away or reloaded.
            if (supportGrip) gripState.grip = supportGrip;
            gripState.weight += ((supportGrip ? 1 : 0) - gripState.weight) * (1 - Math.exp(-GRIP_BLEND_RATE * delta));
            if (!supportGrip && gripState.weight < 1e-3) gripState.grip = null;
            if (gripState.grip && gripState.weight > 1e-3) {
                supportGripPoint(supportArm.gripHand, gripState.grip, _gripTarget);
                reachWithHand(supportArm.arm, supportArm.forearm, supportArm.hand, supportArm.palm, _gripTarget, gripState.weight);
            }
        }
        if (lookBone) {
            const player = resolved.lookAt === 'player' ? playerRef?.current ?? null : null;
            if (player && player !== model) {
                player.getWorldPosition(_lookTarget);
                _lookTarget.y += PLAYER_EYE_HEIGHT;
            } else {
                camera.getWorldPosition(_lookTarget);
            }
            updateLookAtIK(lookBone, _lookTarget, { maxAngle: resolved.lookAtMaxAngle, weight: 1, forward: HEAD_FORWARD }, lookState, delta);
        }
        guard.commit();
    });

    return null;
};
