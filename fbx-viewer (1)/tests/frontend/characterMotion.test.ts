import { describe, expect, it } from 'vitest';
import { CharacterMotion, toCharacterSpace } from '../../runtime/locomotion/characterMotion';
import { planarSpringAt, stepAngleSpring, stoppingDistance, type PlanarSpring } from '../../runtime/locomotion/springs';
import { characterGravityScale } from '../../components/Sandbox/hooks/usePlayerPhysics';

const FRAME = 1 / 60;

/** Advances `motion` toward a goal velocity for `seconds` in 60 Hz steps, settling where it meant to go. */
const run = (motion: CharacterMotion, goalX: number, goalZ: number, seconds: number, each?: (motion: CharacterMotion) => void) => {
    for (let t = 0; t < seconds - 1e-9; t += FRAME) {
        const move = motion.advance(goalX, goalZ, FRAME);
        motion.settle(motion.body.x, motion.body.z);
        expect(Number.isFinite(move.x) && Number.isFinite(move.z)).toBe(true);
        motion.record(FRAME);
        each?.(motion);
    }
};

describe('velocity springs', () => {
    it('land in the same place whether stepped once or in many small steps', () => {
        const start: PlanarSpring = { x: 1, z: -2, vx: 0.5, vz: -1, ax: 3, az: 0 };
        const once = planarSpringAt(start, 2, 1, 0.1, 1, { ...start });
        const stepped = { ...start };
        for (let i = 0; i < 60; i++) planarSpringAt(stepped, 2, 1, 0.1, 1 / 60, stepped);
        for (const key of ['x', 'z', 'vx', 'vz', 'ax', 'az'] as const) expect(stepped[key]).toBeCloseTo(once[key], 6);
    });

    it('come to rest from a speed after speed × half-life / ln 2', () => {
        const rest = planarSpringAt({ x: 0, z: 0, vx: 4, vz: 0, ax: 0, az: 0 }, 0, 0, 0.05, 5, { x: 0, z: 0, vx: 0, vz: 0, ax: 0, az: 0 });
        expect(rest.x).toBeCloseTo(stoppingDistance(4, 0.05), 6);
        expect(stoppingDistance(4, 0.05)).toBeCloseTo((4 * 0.05) / Math.LN2, 3);
    });

    it('turn an angle the short way round, without passing the goal', () => {
        const spring = { x: 3, v: 0 };
        let previous = spring.x;
        for (let i = 0; i < 120; i++) {
            stepAngleSpring(spring, -3, 0.12, FRAME);
            // From 3 to -3 the short way is up through PI: the angle only ever grows (or wraps).
            const turned = Math.atan2(Math.sin(spring.x - previous), Math.cos(spring.x - previous));
            expect(turned).toBeGreaterThanOrEqual(-1e-9);
            previous = spring.x;
        }
        expect(Math.cos(spring.x - -3)).toBeCloseTo(1, 4);
    });
});

describe('character motion', () => {
    it('speeds up to the asked-for velocity over a moment, without overshooting, and brakes faster', () => {
        const motion = new CharacterMotion();
        let most = 0;
        let reached90 = -1;
        let t = 0;
        run(motion, 0, 1.5, 1, (m) => {
            t += FRAME;
            most = Math.max(most, m.speed);
            if (reached90 < 0 && m.speed >= 1.35) reached90 = t;
        });
        expect(most).toBeLessThanOrEqual(1.5 + 1e-6);
        // Not at once (the old controller), and not sluggish.
        expect(reached90).toBeGreaterThan(0.1);
        expect(reached90).toBeLessThan(0.4);
        const from = motion.body.z;
        let stopped = -1;
        t = 0;
        run(motion, 0, 0, 1, (m) => {
            t += FRAME;
            if (stopped < 0 && m.speed < 0.15) stopped = t;
        });
        expect(stopped).toBeGreaterThan(0);
        expect(stopped).toBeLessThan(reached90);
        expect(motion.body.z - from).toBeCloseTo(stoppingDistance(1.5, motion.settings.brakingHalfLife), 2);
    });

    it('predicts where its own springs take it', () => {
        const motion = new CharacterMotion();
        motion.place(2, 3, 0);
        run(motion, 1, 0.5, 0.15);
        const ahead = motion.predict(0.4);
        const copy = new CharacterMotion();
        copy.place(motion.body.x, motion.body.z, 0);
        Object.assign(copy.body, motion.body);
        copy.velocityHalfLife = motion.velocityHalfLife;
        for (let i = 0; i < 24; i++) planarSpringAt(copy.body, 1, 0.5, motion.velocityHalfLife, 0.4 / 24, copy.body);
        expect(ahead.x).toBeCloseTo(copy.body.x, 5);
        expect(ahead.z).toBeCloseTo(copy.body.z, 5);
    });

    it('slides along a wall instead of pressing into it', () => {
        const motion = new CharacterMotion();
        run(motion, 1, 1, 1);
        // A wall facing -x (the character comes at it going +x).
        motion.blockAgainst(-1, 0);
        expect(motion.body.vx).toBeCloseTo(0, 6);
        expect(motion.body.vz).toBeCloseTo(1, 3);
        // Moving away from a wall keeps every bit of the velocity.
        motion.blockAgainst(0, 1);
        expect(motion.body.vz).toBeCloseTo(1, 3);
    });

    it('turns toward a facing and records where it has been', () => {
        const motion = new CharacterMotion();
        for (let i = 0; i < 60; i++) {
            motion.turnToward(Math.PI / 2, FRAME);
            motion.advance(1, 0, FRAME);
            motion.settle(motion.body.x, motion.body.z);
            motion.record(FRAME);
        }
        expect(motion.facing.x).toBeCloseTo(Math.PI / 2, 2);
        // A quarter of a second ago it was a quarter of a second's travel behind, near enough.
        const past = motion.past(0.25);
        expect(motion.body.x - past.x).toBeGreaterThan(0.2);
        expect(motion.body.x - past.x).toBeLessThan(0.3);
        // Placed elsewhere, the past is forgotten.
        motion.place(10, 10, 0);
        expect(motion.past(0.5)).toMatchObject({ x: 10, z: 10 });
    });

    it('sees a point ahead of a turned character as ahead in its own space', () => {
        // Facing +X (a quarter turn), one unit along +X is straight ahead (+z), and halved at scale 2.
        const ahead = toCharacterSpace(5, 3, 4, 3, Math.PI / 2, 2);
        expect(ahead.x).toBeCloseTo(0, 6);
        expect(ahead.z).toBeCloseTo(0.5, 6);
    });
});

describe('character gravity', () => {
    it('is the world gravity up to a person\'s height and grows with a taller character', () => {
        expect(characterGravityScale(1.8)).toBe(1);
        expect(characterGravityScale(0.5)).toBe(1);
        expect(characterGravityScale(5)).toBeCloseTo(5 / 1.8, 6);
    });
});
