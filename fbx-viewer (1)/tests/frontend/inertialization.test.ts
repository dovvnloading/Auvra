import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Inertializer } from '../../runtime/locomotion/inertialization';

const FRAME = 1 / 60;

/** A model of two bones: an arm the "animation" turns about Z, and a hand no animation moves. */
const rig = () => {
    const model = new THREE.Group();
    const arm = new THREE.Bone();
    arm.name = 'arm';
    const hand = new THREE.Bone();
    hand.name = 'hand';
    arm.add(hand);
    model.add(arm);
    return { model, arm, hand };
};

const angleOf = (bone: THREE.Object3D) => 2 * Math.atan2(bone.quaternion.z, bone.quaternion.w);

describe('inertialization', () => {
    it('starts from the pose on screen and settles into the new animation, without a jump', () => {
        const { model, arm } = rig();
        const inertializer = new Inertializer(model);
        // The old animation holds the arm at 1 radian for a few frames.
        for (let i = 0; i < 3; i++) {
            arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1);
            arm.position.set(0, 2, 0);
            inertializer.apply(FRAME);
        }
        // A switch to an animation holding it at 0 (and lower down).
        let previous = 1;
        let largestStep = 0;
        const shown: number[] = [];
        for (let i = 0; i < 90; i++) {
            inertializer.restore();
            arm.quaternion.identity();
            arm.position.set(0, 1, 0);
            if (i === 0) inertializer.switchNow(FRAME);
            inertializer.apply(FRAME);
            const angle = angleOf(arm);
            largestStep = Math.max(largestStep, Math.abs(angle - previous));
            previous = angle;
            shown.push(angle);
        }
        // The switch's frame shows the old pose, then it eases down to the new one and stays there.
        expect(shown[0]).toBeCloseTo(1, 4);
        expect(largestStep).toBeLessThan(0.2);
        expect(Math.abs(shown[shown.length - 1])).toBeLessThan(1e-3);
        expect(arm.position.y).toBeCloseTo(1, 3);
        expect(shown.every(angle => angle > -0.05)).toBe(true);
        expect(inertializer.fading).toBe(false);
    });

    it('keeps the old motion going for a moment: a switch mid-swing does not stop the swing dead', () => {
        const { model, arm } = rig();
        const inertializer = new Inertializer(model);
        // Swinging at 3 radians a second toward the switch.
        for (let i = 0; i < 4; i++) {
            arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 3 * FRAME * i);
            inertializer.apply(FRAME);
        }
        const before = angleOf(arm);
        inertializer.restore();
        arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), before);
        inertializer.switchNow(FRAME);
        inertializer.apply(FRAME);
        inertializer.restore();
        arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), before);
        inertializer.apply(FRAME);
        // The new animation holds still where the old one was, yet the arm carries on a little.
        expect(angleOf(arm)).toBeGreaterThan(before + 0.06);
    });

    it('does not build up an offset on a bone no animation moves', () => {
        const { model, arm, hand } = rig();
        const inertializer = new Inertializer(model);
        hand.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
        arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1);
        inertializer.apply(FRAME);
        inertializer.apply(FRAME);
        // A switch the hand plays no part in: only the arm's animation changes, the hand is left alone.
        for (let i = 0; i < 120; i++) {
            inertializer.restore();
            arm.quaternion.identity();
            if (i === 0) inertializer.switchNow(FRAME);
            inertializer.apply(FRAME);
        }
        expect(hand.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5))).toBeLessThan(1e-4);
    });

    it('counts how fast the new animation moves, so a switch into the same motion leaves nothing to ease', () => {
        const { model, arm } = rig();
        const inertializer = new Inertializer(model);
        const swing = (t: number) => arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 2 * t);
        for (let i = 0; i < 4; i++) {
            swing(i * FRAME);
            inertializer.apply(FRAME);
        }
        // "Switching" to a copy of the same swing at the same moment.
        inertializer.restore();
        swing(3 * FRAME);
        inertializer.noteBefore(FRAME);
        swing(4 * FRAME);
        inertializer.switchNow(FRAME);
        inertializer.apply(FRAME);
        expect(angleOf(arm)).toBeCloseTo(2 * 4 * FRAME, 4);
        // And nothing to ease afterwards either.
        inertializer.restore();
        swing(5 * FRAME);
        inertializer.apply(FRAME);
        expect(angleOf(arm)).toBeCloseTo(2 * 5 * FRAME, 4);
    });
});
