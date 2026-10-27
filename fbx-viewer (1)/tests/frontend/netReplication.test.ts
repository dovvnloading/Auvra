import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { playerVars, REPLICATED_PLAYER_VARS } from '../../runtime/net/RemotePlayers';
import { applyEntityState, createInterpolationBuffer, entityStateOf, MAX_EXTRAPOLATION_MS, slerpEuler } from '../../runtime/net/replication';
import type { NetEntityState } from '../../runtime/net/protocol';

const at = (x: number, yaw = 0, extra: Partial<NetEntityState> = {}): NetEntityState => ({ id: 'e', position: [x, 0, 0], rotation: [0, yaw, 0], ...extra });

describe('interpolation buffer', () => {
  it('draws the entity the delay in the past, between the two states around that moment', () => {
    const buffer = createInterpolationBuffer(100);
    expect(buffer.sample(0)).toBeNull();
    buffer.push(1000, at(0));
    buffer.push(1050, at(10, Math.PI / 2, { vars: { Speed: 1 } }));
    const sample = buffer.sample(1125)!;
    expect(sample.position[0]).toBeCloseTo(5);
    expect(sample.rotation[1]).toBeCloseTo(Math.PI / 4);
    // Before the first state it holds the first.
    expect(buffer.sample(900)!.position[0]).toBe(0);
  });

  it('puts late states in order', () => {
    const buffer = createInterpolationBuffer(0);
    buffer.push(1100, at(10));
    buffer.push(1000, at(0));
    expect(buffer.sample(1050)!.position[0]).toBeCloseTo(5);
    expect(buffer.newest()).toBe(1100);
  });

  it('extrapolates along the last velocity for a short while, then holds', () => {
    const buffer = createInterpolationBuffer(0);
    buffer.push(1000, at(0, 0, { velocity: [2, 0, 0] }));
    expect(buffer.sample(1100)!.position[0]).toBeCloseTo(0.2);
    expect(buffer.sample(5000)!.position[0]).toBeCloseTo(2 * MAX_EXTRAPOLATION_MS / 1000);
  });

  it('drops states more than a second behind the newest', () => {
    const buffer = createInterpolationBuffer(0);
    for (let t = 0; t <= 3000; t += 100) buffer.push(t, at(t));
    expect(buffer.sample(0)!.position[0]).toBeGreaterThanOrEqual(1900);
  });

  it('turns the short way round', () => {
    // 3 and -3 radians are 0.28 apart through pi, not 6 through 0.
    const half = slerpEuler([0, 3, 0], [0, -3, 0], 0.5);
    const result = new THREE.Quaternion().setFromEuler(new THREE.Euler(...half));
    const facingBack = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
    expect(result.angleTo(facingBack)).toBeLessThan(0.01);
  });
});

describe('entity states', () => {
  it('round-trips an object through world space under a moved parent, keeping its scale', () => {
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);
    const child = new THREE.Object3D();
    child.scale.set(2, 2, 2);
    parent.add(child);
    applyEntityState(child, at(3, 1));
    const world = child.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBeCloseTo(3);
    expect(child.scale.x).toBeCloseTo(2);
    const state = entityStateOf('e', child);
    expect(state.position[0]).toBeCloseTo(3);
    expect(state.rotation[1]).toBeCloseTo(1);
  });

  it('reads only the replicated graph inputs that hold numbers or booleans', () => {
    const values: Record<string, unknown> = { Speed: 1, IsJumping: true, InputX: Number.NaN, Secret: 5 };
    const vars = playerVars({ getVariable: (name: string) => values[name] as number | boolean | undefined });
    expect(vars).toEqual({ Speed: 1, IsJumping: true });
    expect(REPLICATED_PLAYER_VARS).toContain('IsDead');
    expect(playerVars(undefined)).toEqual({});
  });
});
