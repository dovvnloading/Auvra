import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Awareness, DEFAULT_AWARENESS_TUNING, SUSPICIOUS_LEVEL, sightRate } from '../../runtime/awareness';
import { perceive } from '../../components/Sandbox/AI/AISenses';
import { DEFAULT_AI_TUNING } from '../../components/Sandbox/AI/AIConfig';

const eye = new THREE.Vector3(0, 0, 0);
const forward = new THREE.Vector3(0, 0, 1);
const at = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const rate = (target: THREE.Vector3, lineOfSight = true) => sightRate(DEFAULT_AWARENESS_TUNING, eye, forward, target, lineOfSight);

describe('awareness', () => {
  it('notices sooner close by and straight ahead, slowly out of the corner of the eye, never behind a wall', () => {
    const ahead = rate(at(0, 5));
    expect(ahead).toBeGreaterThan(0.9 / DEFAULT_AWARENESS_TUNING.reactionSeconds);
    expect(ahead).toBeLessThanOrEqual(1 / DEFAULT_AWARENESS_TUNING.reactionSeconds);
    expect(rate(at(0, 13))).toBeLessThan(ahead / 2);
    // 80 degrees off: outside the central 120 but inside the peripheral 200.
    const side = rate(new THREE.Vector3(Math.sin(1.4), 0, Math.cos(1.4)).multiplyScalar(5));
    expect(side).toBeGreaterThan(0);
    expect(side).toBeLessThan(ahead / 2);
    expect(rate(at(0, -6))).toBe(0);
    expect(rate(at(0, 6), false)).toBe(0);
    expect(rate(at(0, 20))).toBe(0);
    // Right behind it but close: noticed at once.
    expect(rate(at(0, -2))).toBe(Infinity);
  });

  it('fills to suspicious, then alerted; holds, fades, and calms only below suspicion', () => {
    const awareness = new Awareness(2);
    expect(awareness.update(1, false, 0.2)).toBe('unaware');
    expect(awareness.update(1, false, 0.2)).toBe('suspicious');
    expect(awareness.update(1, false, 0.7)).toBe('alerted');
    // Out of sight: held a moment, then fading, still alerted until below suspicion.
    expect(awareness.update(0, false, 1)).toBe('alerted');
    expect(awareness.level).toBe(1);
    awareness.update(0, false, 1);
    expect(awareness.level).toBeCloseTo(0.5, 5);
    expect(awareness.stage).toBe('alerted');
    awareness.update(0, false, 0.5);
    expect(awareness.stage).toBe('unaware');
    // A noise makes it suspicious; being hurt alerts it.
    expect(awareness.update(0, true, 0.1)).toBe('suspicious');
    expect(awareness.level).toBe(SUSPICIOUS_LEVEL);
    awareness.alert();
    expect(awareness.stage).toBe('alerted');
  });

  it('notices a nearby target immediately even on a zero-length frame', () => {
    const awareness = new Awareness();
    expect(awareness.update(rate(at(0, -2)), false, 0)).toBe('alerted');
    expect(awareness.level).toBe(1);
    expect(Number.isFinite(awareness.level)).toBe(true);

    // The real AI senses path must also chase a nearby target on its first frame.
    const input = { enemyPosition: eye, enemyForward: forward, targetPosition: at(0, -2), distToTarget: 2 };
    const frame = perceive(new Awareness(), input, DEFAULT_AI_TUNING, { lineOfSight: true, heard: null }, 0);
    expect(frame).toMatchObject({ canSee: true, investigate: null, stage: 'alerted', level: 1 });
    expect(new Awareness().update(Infinity, false, -0.01)).toBe('alerted');
  });

  it('preserves normal meter updates for zero, tiny, and regular frame lengths', () => {
    const awareness = new Awareness(2);
    expect(awareness.update(2, false, 0)).toBe('unaware');
    expect(awareness.level).toBe(0);
    awareness.update(2, false, 1e-9);
    expect(awareness.level).toBe(2e-9);
    awareness.update(2, false, 0.25);
    expect(awareness.level).toBeCloseTo(0.500000002, 10);
    awareness.update(0, false, 1.5);
    expect(awareness.level).toBeCloseTo(0.500000002, 10);
    awareness.update(0, false, 0.25);
    expect(awareness.level).toBeCloseTo(0.375000002, 10);
  });

  it('does not rewind seeing or forgetting on negative or non-finite frame lengths', () => {
    const awareness = new Awareness(2);
    awareness.update(1, false, 0.5);
    for (const delta of [-0.1, -Infinity, NaN, Infinity]) {
      awareness.update(1, false, delta);
      expect(awareness.level).toBe(0.5);
    }
    awareness.update(0, false, 2);
    expect(awareness.level).toBe(0);
    awareness.update(0, false, -0.25);
    expect(awareness.level).toBe(0);
    expect(Number.isFinite(awareness.level)).toBe(true);
  });

  it('recovers a previously poisoned awareness meter on the next frame', () => {
    const awareness = new Awareness();
    awareness.level = NaN; // A corrupted value from a prior zero-delta frame (or saved state).
    awareness.alerted = true;
    expect(awareness.update(1, false, 0.2)).toBe('unaware');
    expect(awareness.level).toBeCloseTo(0.2, 10);
    expect(awareness.alerted).toBe(false);
    expect(awareness.update(1, false, 0.8)).toBe('alerted');
    expect(awareness.level).toBe(1);
  });

  it('investigates a glimpse until alerted, and only then gives chase', () => {
    const awareness = new Awareness();
    const input = { enemyPosition: eye, enemyForward: forward, targetPosition: at(0, 8), distToTarget: 8 };
    const open = { lineOfSight: true, heard: null };
    let frame = perceive(awareness, input, DEFAULT_AI_TUNING, open, 0.05);
    expect(frame.canSee).toBe(false);
    expect(frame.investigate).toBeNull();
    for (let i = 0; i < 6; i++) frame = perceive(awareness, input, DEFAULT_AI_TUNING, open, 0.05);
    expect(frame.stage).toBe('suspicious');
    expect(frame.investigate).toBe(input.targetPosition);
    for (let i = 0; i < 40 && !frame.canSee; i++) frame = perceive(awareness, input, DEFAULT_AI_TUNING, open, 0.05);
    expect(frame.canSee).toBe(true);
    expect(frame.investigate).toBeNull();
    // A noise somewhere it cannot see is investigated.
    const heard = new THREE.Vector3(3, 0, -9);
    const unseen = perceive(new Awareness(), input, DEFAULT_AI_TUNING, { lineOfSight: false, heard }, 0.05);
    expect(unseen.investigate).toBe(heard);
  });
});
