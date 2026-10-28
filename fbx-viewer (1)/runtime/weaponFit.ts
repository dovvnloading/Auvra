import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { findBone, handGripPoint } from './ik';
import { mirrorBoneName } from '../utils/retargeting';

/**
 * FITTING A WEAPON TO THE HANDS
 *
 * Places a weapon's model on the hand that holds it from the character's own animation, so the
 * weapon fits whatever rig and clip it is used with: the weapon's grip goes where the gripping
 * hand's fingers close (the hollow they curl round), and its barrel runs through the other hand's
 * grip, or the way the character faces for a one-handed weapon.
 */

export type Vec3 = [number, number, number];

/** Points on a weapon model, in its own units, that place it in the hands. */
export interface WeaponFitPoints {
    /** The middle of the grip the gripping hand closes round. */
    grip: Vec3;
    /** Where the other hand holds it (a rifle's handguard): the line from the grip to it runs through the other hand. */
    support?: Vec3 | null;
    /** The end of the barrel: without a support point, the barrel points the way the character faces. */
    muzzle?: Vec3 | null;
}

/** The weapon's placement on the gripping hand bone: position, and rotation in degrees. */
export interface WeaponFit {
    position: Vec3;
    rotation: Vec3;
    /** How the other hand is turned on the weapon in the clip, in degrees in the weapon's frame; null when it has no other hand. */
    supportRotation: Vec3 | null;
}

const UP = new THREE.Vector3(0, 1, 0);

/** A basis whose first axis is `along` and whose second is as near `up` as `along` allows. */
const alongFrame = (along: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 => {
    const a = along.clone().normalize();
    const b = up.clone().addScaledVector(a, -up.dot(a));
    if (b.lengthSq() < 1e-10) b.set(0, 0, 1).addScaledVector(a, -a.z);
    b.normalize();
    return new THREE.Matrix4().makeBasis(a, b, new THREE.Vector3().crossVectors(a, b));
};

/**
 * The placement on `boneName` that puts a weapon into the hands of `model` as `clip` poses them at
 * `time`, the weapon keeping `scale` (the attachment's). Its up (+Y) is kept as near world up as
 * the barrel allows. Null when the rig has no such hand, or the points give no barrel line.
 */
export const fitWeaponToHands = (
    model: THREE.Object3D,
    clip: THREE.AnimationClip,
    boneName: string,
    scale: readonly number[],
    points: WeaponFitPoints,
    time = 0,
): WeaponFit | null => {
    const copy = cloneSkeleton(model);
    const mixer = new THREE.AnimationMixer(copy);
    try {
        mixer.clipAction(clip).play();
        mixer.setTime(Math.min(Math.max(0, time), clip.duration));
        copy.updateMatrixWorld(true);
        const hand = findBone(copy, boneName);
        if (!hand) return null;
        const otherName = mirrorBoneName(boneName);
        const other = otherName ? findBone(copy, otherName) : null;

        const gripAt = handGripPoint(hand, new THREE.Vector3());
        const grip = new THREE.Vector3(...points.grip);
        let along: THREE.Vector3;
        let alongWorld: THREE.Vector3;
        if (points.support && other && other !== hand) {
            along = new THREE.Vector3(...points.support).sub(grip);
            alongWorld = handGripPoint(other, new THREE.Vector3()).sub(gripAt);
        } else if (points.muzzle) {
            along = new THREE.Vector3(...points.muzzle).sub(grip);
            alongWorld = new THREE.Vector3(0, 0, 1).transformDirection(copy.matrixWorld);
        } else {
            return null;
        }
        if (along.lengthSq() < 1e-12 || alongWorld.lengthSq() < 1e-12) return null;

        const rotation = new THREE.Quaternion().setFromRotationMatrix(alongFrame(alongWorld, UP).multiply(alongFrame(along, UP).transpose()));
        const handScale = hand.getWorldScale(new THREE.Vector3());
        const worldScale = new THREE.Vector3(handScale.x * scale[0], handScale.y * scale[1], handScale.z * scale[2]);
        const origin = gripAt.sub(grip.clone().multiply(worldScale).applyQuaternion(rotation));
        const local = hand.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(origin, rotation, worldScale));
        const position = new THREE.Vector3();
        const localRotation = new THREE.Quaternion();
        local.decompose(position, localRotation, new THREE.Vector3());
        const euler = new THREE.Euler().setFromQuaternion(localRotation, 'XYZ');
        const round = (value: number) => Math.round(value * 1000) / 1000;
        const degrees = (e: THREE.Euler) => [e.x, e.y, e.z].map(angle => round(THREE.MathUtils.radToDeg(angle))) as Vec3;
        // The other hand's turn on the weapon in this pose, so it holds the weapon this way in any clip.
        const supportRotation = points.support && other && other !== hand
            ? degrees(new THREE.Euler().setFromQuaternion(rotation.clone().invert().multiply(other.getWorldQuaternion(new THREE.Quaternion())), 'XYZ'))
            : null;
        return {
            position: [round(position.x), round(position.y), round(position.z)],
            rotation: degrees(euler),
            supportRotation,
        };
    } finally {
        mixer.stopAllAction();
        mixer.uncacheRoot(copy);
    }
};
