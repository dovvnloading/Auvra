import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { findBone, handGripPoint } from './ik';
import { mirrorBoneName } from '../utils/retargeting';
import { isPartCopy, originalBone } from '../utils/partCopies';

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

/** How far a carried weapon rests off the body, as a share of the character's height: it touches without sinking in. */
const SEAT_GAP = 0.003;

/**
 * The carry position on `carry.boneName` that seats a weapon against the body as `clip` poses it
 * at `time`: the weapon (`weapon`, its model at `scale`, turned as the carry turns it) slides along
 * the line from the bone out to it until the part of the body under it is just behind it. The carry's
 * rotation stays. Null when the rig has no such bone or no body under the weapon.
 */
export const seatCarryOnBody = (
    model: THREE.Object3D,
    clip: THREE.AnimationClip | null,
    weapon: THREE.Object3D,
    scale: readonly number[],
    carry: { boneName: string; position: readonly number[]; rotation: readonly number[] },
    time = 0,
): Vec3 | null => {
    const copy = cloneSkeleton(model);
    const mixer = new THREE.AnimationMixer(copy);
    try {
        if (clip) {
            mixer.clipAction(clip).play();
            mixer.setTime(Math.min(Math.max(0, time), clip.duration));
        }
        copy.updateMatrixWorld(true);
        const bone = findBone(copy, carry.boneName);
        if (!bone) return null;

        // The weapon's vertices in its own frame, then as the carry places it on the bone.
        weapon.updateMatrixWorld(true);
        const toWeapon = weapon.matrixWorld.clone().invert();
        const local: THREE.Vector3[] = [];
        weapon.traverse(node => {
            const mesh = node as THREE.Mesh;
            const position = mesh.isMesh ? mesh.geometry?.attributes.position : undefined;
            if (!position) return;
            const toLocal = toWeapon.clone().multiply(mesh.matrixWorld);
            const step = Math.max(1, Math.floor(position.count / 4000));
            for (let i = 0; i < position.count; i += step) local.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(toLocal));
        });
        if (!local.length) return null;
        const euler = new THREE.Euler(...(carry.rotation.map(value => THREE.MathUtils.degToRad(value)) as Vec3));
        const placed = new THREE.Matrix4().compose(new THREE.Vector3(...(carry.position as Vec3)), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(scale[0], scale[1], scale[2]));
        const toWorld = bone.matrixWorld.clone().multiply(placed);
        const points = local.map(point => point.clone().applyMatrix4(toWorld));
        const centre = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);

        // Out from the bone's axis (bone to child) through the weapon's middle.
        const start = bone.getWorldPosition(new THREE.Vector3());
        // A part's copy of the bone sits on it with no offset: the bone's own child gives its direction.
        const child = bone.children.find(node => (node as THREE.Bone).isBone && !isPartCopy(node));
        const axis = child ? child.getWorldPosition(new THREE.Vector3()).sub(start) : new THREE.Vector3(0, 1, 0);
        if (axis.lengthSq() < 1e-12) return null;
        axis.normalize();
        const out = centre.clone().sub(start);
        out.addScaledVector(axis, -out.dot(axis));
        if (out.lengthSq() < 1e-10) return null;
        out.normalize();

        // The body's skinned surface under the weapon's footprint (across `out`), and how far out it reaches.
        const side = new THREE.Vector3().crossVectors(axis, out).normalize();
        const along = (point: THREE.Vector3) => [point.dot(axis), point.dot(side)];
        let minA = Infinity, maxA = -Infinity, minS = Infinity, maxS = -Infinity, weaponIn = Infinity;
        for (const point of points) {
            const [a, s] = along(point);
            minA = Math.min(minA, a); maxA = Math.max(maxA, a); minS = Math.min(minS, s); maxS = Math.max(maxS, s);
            weaponIn = Math.min(weaponIn, point.dot(out));
        }
        // Only the body along the bone's own chain counts (the bone, what hangs below it and what it
        // hangs from): an arm hanging beside a thigh is not under a thigh holster.
        const chain = new Set<THREE.Object3D>();
        bone.traverse(node => { if ((node as THREE.Bone).isBone) chain.add(node); });
        for (let up = bone.parent; up && (up as THREE.Bone).isBone; up = up.parent) chain.add(up);
        let bodyOut = -Infinity;
        const vertex = new THREE.Vector3();
        copy.traverse(node => {
            const mesh = node as THREE.SkinnedMesh;
            if (!mesh.isSkinnedMesh || !mesh.geometry?.attributes.position || !mesh.visible) return;
            if (weapon === mesh || weapon.getObjectById(mesh.id)) return;
            mesh.skeleton.update();
            const skinIndex = mesh.geometry.attributes.skinIndex;
            const skinWeight = mesh.geometry.attributes.skinWeight;
            const count = mesh.geometry.attributes.position.count;
            for (let i = 0; i < count; i++) {
                if (skinIndex && skinWeight) {
                    let dominant = 0;
                    for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, dominant)) dominant = k;
                    const owner = mesh.skeleton.bones[skinIndex.getComponent(i, dominant)];
                    if (!owner || !chain.has(originalBone(owner))) continue;
                }
                mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
                const [a, s] = along(vertex);
                if (a < minA || a > maxA || s < minS || s > maxS) continue;
                bodyOut = Math.max(bodyOut, vertex.dot(out));
            }
        });
        if (!Number.isFinite(bodyOut)) return null;

        // Slide the weapon along `out` so its inner side rests just off that surface, in the bone's frame.
        const height = (() => {
            const box = new THREE.Box3().setFromObject(copy);
            return box.max.y - box.min.y;
        })();
        const shift = out.multiplyScalar(bodyOut + SEAT_GAP * height - weaponIn);
        const position = new THREE.Vector3(...(carry.position as Vec3)).applyMatrix4(bone.matrixWorld).add(shift);
        bone.worldToLocal(position);
        const round = (value: number) => Math.round(value * 1000) / 1000;
        return [round(position.x), round(position.y), round(position.z)];
    } finally {
        mixer.stopAllAction();
        mixer.uncacheRoot(copy);
    }
};
