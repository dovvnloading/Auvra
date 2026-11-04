import { describe, expect, it } from 'vitest';
import { coverageWarnings, summarizeClips } from '../../components/AnimationGraph/Inspectors/MotionMatchConfig';
import { MotionDatabase, SAMPLE_RATE, type MotionClipSamples, type MotionSample } from '../../runtime/motionMatching';
import { resolveMovementSettings, SETTLE_HALF_LIVES, DEFAULT_MOVEMENT_SETTINGS } from '../../runtime/locomotion/characterMotion';

/** A clip moving at (vx, vz) in the model's space and turning `turn` radians a second, feet still. */
const clip = (name: string, vx: number, vz: number, turn = 0, seconds = 1): MotionClipSamples => {
    const samples: MotionSample[] = [];
    for (let i = 0; i < seconds * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const root = { x: vx * t, y: 0, z: vz * t };
        samples.push({ root, facing: turn * t, hips: { ...root, y: 1 }, leftFoot: { x: root.x + 0.1, y: 0, z: root.z }, rightFoot: { x: root.x - 0.1, y: 0, z: root.z } });
    }
    return { name, loop: true, samples };
};

describe('the motion-matching inspector', () => {
    it('says what each clip does: stands, moves which way how fast, or turns on the spot', () => {
        const database = new MotionDatabase([clip('idle', 0, 0), clip('walk', 0, 1.4), clip('strafe', 1.9, 0), clip('turn', 0, 0, Math.PI / 2)]);
        const said = Object.fromEntries(summarizeClips(database, ['idle', 'walk', 'strafe', 'turn']).map((entry) => [entry.name, entry.text]));
        expect(said.idle).toBe('stands');
        expect(said.walk).toBe('moves forward at 1.4 m/s');
        // +x is the character's left (it faces +z).
        expect(said.strafe).toBe('moves to the left at 1.9 m/s');
        expect(said.turn).toMatch(/^turns 8\d° left on the spot$/);
    });

    it('warns about what is missing', () => {
        const database = new MotionDatabase([clip('walk', 0, 1.4)]);
        const warnings = coverageWarnings(summarizeClips(database, ['walk']));
        expect(warnings.some((warning) => warning.includes('stands still'))).toBe(true);
        expect(warnings.some((warning) => warning.includes('turns on the spot'))).toBe(true);
        expect(warnings.some((warning) => warning.includes('travels'))).toBe(false);
    });
});

describe('movement tuning', () => {
    it('turns the times a player feels into spring half-lives, keeping defaults for what is left out', () => {
        const settings = resolveMovementSettings({ accelerate: 0.56, turnFirst: 60 });
        expect(settings.accelerationHalfLife).toBeCloseTo(0.56 / SETTLE_HALF_LIVES, 6);
        expect(settings.brakingHalfLife).toBe(DEFAULT_MOVEMENT_SETTINGS.brakingHalfLife);
        expect(settings.turnFirstAngle).toBe(60);
        expect(resolveMovementSettings({ turnFirst: 500, brake: -1 })).toMatchObject({ turnFirstAngle: 180, brakingHalfLife: DEFAULT_MOVEMENT_SETTINGS.brakingHalfLife });
    });
});
