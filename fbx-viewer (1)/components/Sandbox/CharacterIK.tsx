import React, { useContext, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { AttachmentData, CharacterIKSettings, WeaponSettings } from '../../types';
import { resolveWeaponPoint } from '../../runtime/weapons';
import { findBone, IKPoseGuard, reachWithHand, supportGripPoint, type SupportGrip } from '../../runtime/ik';
import { mirrorBoneName } from '../../utils/retargeting';
import { usePhysicsQueries } from '../../runtime/physicsQueries';
import { crosshairTarget } from '../../runtime/aimTarget';
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
    /**
     * The player is aiming: the spine turns toward the camera's heading when the body faces away
     * from it (a turn in place has not caught up), and with aimPitch on it follows the camera up and down.
     */
    aiming?: boolean;
    /** A weapon held in one hand: the other hand takes hold of it (WeaponSettings.supportGrip). */
    supportGrip?: HeldWeaponGrip | null;
    /** The held weapon's muzzle (+Z along the barrel): while aiming, the spine turns it onto what the crosshair is on. */
    muzzle?: () => THREE.Object3D | null;
}

/** A held weapon's support grip, with the bone of the hand that holds the weapon. */
export interface HeldWeaponGrip extends SupportGrip {
    boneName: string;
}

/** The support grip of `weapon` held in the hands as `attachment` mounts it; null without a support point. */
export const heldWeaponGrip = (
    weapon: Pick<WeaponSettings, 'supportGrip' | 'supportRotation'> | null | undefined,
    attachment: Pick<AttachmentData, 'boneName' | 'position' | 'rotation' | 'scale'> | null | undefined,
): HeldWeaponGrip | null => {
    const point = weapon ? resolveWeaponPoint(weapon.supportGrip) : null;
    return point && attachment
        ? {
            boneName: attachment.boneName, position: attachment.position, rotation: attachment.rotation, scale: attachment.scale, point,
            handRotation: weapon ? resolveWeaponPoint(weapon.supportRotation) : null,
        }
        : null;
};

/** How fast the other hand takes hold of and lets go of a weapon (per second). */
const GRIP_BLEND_RATE = 14;
const _gripTarget = new THREE.Vector3();
const _gripRotation = new THREE.Quaternion();

const _lookTarget = new THREE.Vector3();
const _crosshair = new THREE.Vector3();
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
/** The furthest the spine turns to follow the aim's heading. */
const MAX_AIM_YAW = THREE.MathUtils.degToRad(100);
const UP = new THREE.Vector3(0, 1, 0);
const _bodyForward = new THREE.Vector3();

/**
 * The turn that brings a body facing `forward` round to the heading of the aim `direction` (both
 * world space, turning about world up, left positive), at most MAX_AIM_YAW, scaled by `weight`.
 */
export const aimYaw = (direction: THREE.Vector3, forward: THREE.Vector3, weight: number): number => {
    const turn = Math.atan2(direction.x, direction.z) - Math.atan2(forward.x, forward.z);
    return THREE.MathUtils.clamp(Math.atan2(Math.sin(turn), Math.cos(turn)), -MAX_AIM_YAW, MAX_AIM_YAW) * weight;
};

/** The furthest the spine turns to bring the barrel onto the crosshair, each way. */
const MAX_AIM_CONVERGE = THREE.MathUtils.degToRad(30);
const _muzzleAt = new THREE.Vector3();
const _barrel = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _pitchAxis = new THREE.Vector3();

/**
 * Turns the `spine` bones (shared bottom up) so the barrel of `muzzle` (its +Z) points at
 * `target`: about world up, and when `pitch` is set up and down too, each by at most
 * MAX_AIM_CONVERGE in all, scaled by `weight`. Two passes, since turning the spine also moves the muzzle.
 */
export const aimMuzzleAt = (
    spine: readonly THREE.Object3D[],
    muzzle: THREE.Object3D,
    target: THREE.Vector3,
    pitch: boolean,
    weight: number,
): void => {
    if (!spine.length || !(weight > 0)) return;
    const heading = (v: THREE.Vector3) => Math.atan2(v.x, v.z);
    const elevation = (v: THREE.Vector3) => Math.asin(THREE.MathUtils.clamp(v.y / (v.length() || 1), -1, 1));
    const limit = MAX_AIM_CONVERGE * weight;
    // Each pass's turn, scaled by `weight`, keeping the passes' total within the limit.
    const clampTurn = (angle: number, total: number) =>
        THREE.MathUtils.clamp(Math.atan2(Math.sin(angle), Math.cos(angle)) * weight, -limit - total, limit - total);
    let yawTotal = 0;
    let liftTotal = 0;
    for (let pass = 0; pass < 2; pass++) {
        muzzle.updateWorldMatrix(true, false);
        muzzle.getWorldPosition(_muzzleAt);
        _barrel.set(0, 0, 1).transformDirection(muzzle.matrixWorld);
        _toTarget.copy(target).sub(_muzzleAt);
        if (_toTarget.lengthSq() < 1e-8) return;
        const yaw = clampTurn(heading(_toTarget) - heading(_barrel), yawTotal);
        yawTotal += yaw;
        if (Math.abs(yaw) > 1e-5) for (const bone of spine) turnBoneAboutWorldAxis(bone, UP, yaw / spine.length);
        if (!pitch) continue;
        muzzle.updateWorldMatrix(true, false);
        muzzle.getWorldPosition(_muzzleAt);
        _barrel.set(0, 0, 1).transformDirection(muzzle.matrixWorld);
        _toTarget.copy(target).sub(_muzzleAt);
        // Up about the barrel's right (barrel x up), so a positive turn raises it.
        _pitchAxis.crossVectors(_barrel, UP);
        if (_pitchAxis.lengthSq() < 1e-8) continue;
        _pitchAxis.normalize();
        const lift = clampTurn(elevation(_toTarget) - elevation(_barrel), liftTotal);
        liftTotal += lift;
        if (Math.abs(lift) > 1e-5) for (const bone of spine) turnBoneAboutWorldAxis(bone, _pitchAxis, lift / spine.length);
    }
};

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
export const CharacterIK: React.FC<CharacterIKProps> = ({ model, settings, physicsId, aiming = false, supportGrip = null, muzzle }) => {
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
        () => AIM_SPINE.map(name => findBone(model, name)).filter((bone): bone is THREE.Object3D => !!bone),
        [model],
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
        return { gripHand, arm, forearm, hand };
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
                camera.getWorldDirection(_aimDirection);
                // The body's own heading: the model's forward (+Z) on the ground.
                _bodyForward.set(0, 0, 1).transformDirection(model.matrixWorld);
                const turn = aimYaw(_aimDirection, _bodyForward, aimState.weight);
                if (Math.abs(turn) > 1e-4) for (const bone of spine) turnBoneAboutWorldAxis(bone, UP, turn / spine.length);
                if (resolved.aimPitch) {
                    const lean = aimPitch(_aimDirection, aimState.weight);
                    _aimRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
                    for (const bone of spine) turnBoneAboutWorldAxis(bone, _aimRight, lean / spine.length);
                }
                // Then the barrel itself onto what the crosshair is on (the aim clip holds it a little off).
                const barrel = muzzle?.();
                if (barrel) {
                    crosshairTarget(camera, physics.raycast, physicsId, _crosshair);
                    aimMuzzleAt(spine, barrel, _crosshair, resolved.aimPitch, aimState.weight);
                }
            }
        }
        if (supportArm) {
            // Eases in when a weapon is taken up and out when it is put away or reloaded.
            if (supportGrip) gripState.grip = supportGrip;
            gripState.weight += ((supportGrip ? 1 : 0) - gripState.weight) * (1 - Math.exp(-GRIP_BLEND_RATE * delta));
            if (!supportGrip && gripState.weight < 1e-3) gripState.grip = null;
            if (gripState.grip && gripState.weight > 1e-3) {
                supportGripPoint(supportArm.gripHand, gripState.grip, _gripTarget, _gripRotation);
                reachWithHand(supportArm.arm, supportArm.forearm, supportArm.hand, _gripTarget, gripState.weight, gripState.grip.handRotation ? _gripRotation : null);
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
