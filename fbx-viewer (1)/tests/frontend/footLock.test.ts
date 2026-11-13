import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFootLock, stepFootLock } from '../../runtime/components/ikComponents';

const FRAME = 1 / 60;
/** The ankle's height above the ground when the foot is flat (Mixamo-like, in metres). */
const ANKLE = 0.1;

describe('foot locking', () => {
    it('plants a foot that comes down and keeps still, then holds it while the body turns over it', () => {
        const lock = createFootLock();
        // Swinging in low and fast: not planted.
        for (let i = 0; i < 5; i++) expect(stepFootLock(lock, new THREE.Vector3(i * 0.03, ANKLE + 0.01, 0), 0, 1, FRAME)).toBe(0);
        // Down and still: planted after two frames, held fully.
        let held = 0;
        for (let i = 0; i < 3; i++) held = stepFootLock(lock, new THREE.Vector3(0.15, ANKLE, 0), 0, 1, FRAME);
        expect(lock.locked).toBe(true);
        expect(held).toBe(1);
        // The body turns on the spot: the animated foot is carried round quickly, but stays down: it stays planted.
        for (let i = 1; i <= 8; i++) {
            const angle = (i / 8) * 0.5;
            expect(stepFootLock(lock, new THREE.Vector3(0.15 + 0.15 * Math.sin(angle), ANKLE, 0.15 * (1 - Math.cos(angle))), 0, 1, FRAME)).toBe(1);
        }
        expect(lock.locked).toBe(true);
        expect(lock.anchor.x).toBeCloseTo(0.15, 6);
    });

    it('lets go when the foot lifts, easing back to the animation', () => {
        const lock = createFootLock();
        for (let i = 0; i < 3; i++) stepFootLock(lock, new THREE.Vector3(0, ANKLE, 0), 0, 1, FRAME);
        expect(lock.locked).toBe(true);
        let held = stepFootLock(lock, new THREE.Vector3(0.02, ANKLE + 0.1, 0), 0, 1, FRAME);
        expect(lock.locked).toBe(false);
        expect(held).toBeGreaterThan(0.5);
        for (let i = 0; i < 40; i++) held = stepFootLock(lock, new THREE.Vector3(0.05 * i, ANKLE + 0.15, 0), 0, 1, FRAME);
        expect(held).toBe(0);
    });

    it('lets go once the body has carried on so far the leg would stretch, and scales with the leg', () => {
        const lock = createFootLock();
        for (let i = 0; i < 3; i++) stepFootLock(lock, new THREE.Vector3(0, ANKLE, 0), 0, 1, FRAME);
        stepFootLock(lock, new THREE.Vector3(0.15, ANKLE, 0), 0, 1, FRAME);
        expect(lock.locked).toBe(true);
        stepFootLock(lock, new THREE.Vector3(0.25, ANKLE, 0), 0, 1, FRAME);
        expect(lock.locked).toBe(false);
        // A leg twice as long holds on further.
        const giant = createFootLock();
        for (let i = 0; i < 3; i++) stepFootLock(giant, new THREE.Vector3(0, ANKLE * 2, 0), 0, 2, FRAME);
        stepFootLock(giant, new THREE.Vector3(0.25, ANKLE * 2, 0), 0, 2, FRAME);
        expect(giant.locked).toBe(true);
    });
});
