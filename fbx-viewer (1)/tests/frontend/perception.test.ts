import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYER_PHYSICS_ID, type PhysicsRaycastHit } from '../../runtime/physics';
import { NoiseBus, characterHeight, lineOfSight } from '../../runtime/perception';
import { OPEN_PERCEPTION, seesTarget } from '../../components/Sandbox/AI/AISenses';
import { evaluateNextState, type DecisionContext } from '../../components/Sandbox/AI/AIStateMachine';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('noises', () => {
  it('reach the listeners within their radius, loudest first, and not the one who made them', () => {
    let now = 10;
    const bus = new NoiseBus(() => now);
    bus.report(v(0, 0, 0), 20, PLAYER_PHYSICS_ID);
    bus.report([15, 0, 0], 10, 'enemy-1');
    const listener = v(12, 0, 0);
    // 8 left over from the first, 7 from the second.
    expect(bus.heardSince(listener, 0)?.source).toBe(PLAYER_PHYSICS_ID);
    expect(bus.heardSince(listener, 0, PLAYER_PHYSICS_ID)?.source).toBe('enemy-1');
    expect(bus.heardSince(v(40, 0, 0), 0)).toBeNull();
    // Only what was made after the last check.
    expect(bus.heardSince(listener, now)).toBeNull();
    now = 11;
    bus.report(v(12, 0, 3), 5, null);
    expect(bus.heardSince(listener, 10)?.position.toArray()).toEqual([12, 0, 3]);
  });

  it('ignores noises of no size or nowhere, and forgets old ones', () => {
    let now = 0;
    const bus = new NoiseBus(() => now);
    bus.report(v(0, 0, 0), 0);
    bus.report(v(Number.NaN, 0, 0), 10);
    expect(bus.heardSince(v(0, 0, 0), -1)).toBeNull();
    bus.report(v(0, 0, 0), 10);
    now = 5;
    bus.report(v(100, 0, 0), 1);
    expect(bus.heardSince(v(0, 0, 0), -1)).toBeNull();
  });
});

describe('line of sight', () => {
  const physics = (hit: Partial<PhysicsRaycastHit> | null) => ({
    raycast: () => (hit ? { objectId: null, point: v(0, 0, 0), normal: v(0, 1, 0), distance: 0, ...hit } : null),
  });

  it('is clear when nothing, or only the player, is in the way', () => {
    expect(lineOfSight(physics(null), v(0, 1.6, 0), v(10, 1, 0))).toBe(true);
    expect(lineOfSight(physics({ objectId: PLAYER_PHYSICS_ID, distance: 9.8 }), v(0, 1.6, 0), v(10, 1, 0))).toBe(true);
    // What the target holds, at the target, does not hide it.
    expect(lineOfSight(physics({ objectId: 'rifle', distance: 9.95 }), v(0, 1.6, 0), v(10, 1.6, 0))).toBe(true);
  });

  it('is blocked by a wall in between', () => {
    expect(lineOfSight(physics({ objectId: 'wall', distance: 4 }), v(0, 1.6, 0), v(10, 1.6, 0))).toBe(false);
  });

  it('measures a character once from its bounds', () => {
    const character = new THREE.Mesh(new THREE.BoxGeometry(1, 5, 1));
    character.geometry.translate(0, 2.5, 0);
    expect(characterHeight(character)).toBeCloseTo(5);
    character.scale.set(1, 2, 1);
    expect(characterHeight(character)).toBeCloseTo(5);
  });
});

describe('what an enemy sees', () => {
  const sense = (targetPosition: THREE.Vector3) => ({
    enemyPosition: v(0, 0, 0),
    enemyForward: v(0, 0, 1),
    targetPosition,
    distToTarget: targetPosition.length(),
  });

  it('sees in front within range unless a wall is in the way, and notices what is close whichever way', () => {
    const blocked = { lineOfSight: false, heard: null };
    expect(seesTarget(sense(v(0, 0, 10)), 15, OPEN_PERCEPTION)).toBe(true);
    expect(seesTarget(sense(v(0, 0, 10)), 15, blocked)).toBe(false);
    expect(seesTarget(sense(v(0, 0, 20)), 15, OPEN_PERCEPTION)).toBe(false);
    expect(seesTarget(sense(v(0, 0, -10)), 15, OPEN_PERCEPTION)).toBe(false);
    expect(seesTarget(sense(v(0, 0, -2)), 15, blocked)).toBe(true);
  });

  it('goes to look when it hears a noise while idle or on patrol', () => {
    const context = (currentState: DecisionContext['currentState'], heard: boolean): DecisionContext => ({
      currentState,
      distToTarget: 30,
      distFromCenter: 0,
      boundarySize: 100,
      canSee: false,
      heard,
      timers: { cooldown: 0, attack: 0, search: 0, patrolWait: 5, strafe: 0, memory: 5 },
      patrolDest: v(50, 0, 50),
      enemyPosition: v(0, 0, 0),
    });
    expect(evaluateNextState(context('IDLE', true)).nextState).toBe('SEARCHING');
    expect(evaluateNextState(context('PATROL', true)).nextState).toBe('SEARCHING');
    expect(evaluateNextState(context('IDLE', false)).nextState).toBe('IDLE');
  });
});
