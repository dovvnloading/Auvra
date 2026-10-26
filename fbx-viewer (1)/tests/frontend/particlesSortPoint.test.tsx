import { render } from '@testing-library/react';
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTICLES_COMPONENT } from '../../runtime/components/particles';
import type { LevelComponent, LevelObject } from '../../types';

const frame = vi.hoisted(() => ({ callback: null as ((state: unknown, delta: number) => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

const frameState = { size: { height: 720 }, viewport: { dpr: 1 } };

beforeEach(() => {
  // react-dom does not know the <primitive> intrinsic; that noise is not under test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Mounts the particles component and returns its Points, captured as three constructs it. */
const mountEmitter = () => {
  const created: THREE.Points[] = [];
  const original = THREE.Points.prototype.updateMorphTargets;
  vi.spyOn(THREE.Points.prototype, 'updateMorphTargets').mockImplementation(function (this: THREE.Points) {
    created.push(this);
    return original.call(this);
  });
  const Render = PARTICLES_COMPONENT.Render!;
  const component = { id: 'smoke', type: 'particles', enabled: true, props: { preset: 'smoke', rate: 30, burst: 0, loop: true } } as unknown as LevelComponent;
  render(<Render object={{ id: 'owner' } as LevelObject} component={component} mode="runtime" />);
  expect(created).toHaveLength(1);
  return created[0];
};

describe('particle depth sorting', () => {
  it('sorts by the emitter position, never a sphere computed over the zero-filled pool', () => {
    const points = mountEmitter();
    const computeSpy = vi.spyOn(points.geometry, 'computeBoundingSphere');
    // three's projectObject computes a missing sphere lazily; it must already exist.
    expect(points.geometry.boundingSphere).not.toBeNull();

    const owner = new THREE.Group();
    owner.position.set(100, 0, 0);
    owner.add(points);
    frame.callback?.(frameState, 1 / 60);
    expect(points.geometry.boundingSphere!.center.toArray()).toEqual([100, 0, 0]);

    // The sort point follows a moving emitter.
    owner.position.set(-20, 5, 3);
    frame.callback?.(frameState, 1 / 60);
    expect(points.geometry.boundingSphere!.center.toArray()).toEqual([-20, 5, 3]);
    expect(computeSpy).not.toHaveBeenCalled();
  });
});
