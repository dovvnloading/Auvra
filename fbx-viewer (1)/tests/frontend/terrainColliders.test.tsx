import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LevelObject } from '../../types';
import { LevelGroundColliders } from '../../runtime/terrainPhysics';

const rapier = vi.hoisted(() => ({
  /** Every args array a HeightfieldCollider rendered with, per body userData id ('flat' for none). */
  args: new Map<string, unknown[][]>(),
}));

vi.mock('@react-three/rapier', async () => {
  const ReactModule = await import('react');
  const BodyContext = ReactModule.createContext('flat');
  return {
    RigidBody: ({ children, userData }: { children?: React.ReactNode; userData?: { levelObjectId?: string } }) =>
      ReactModule.createElement(BodyContext.Provider, { value: userData?.levelObjectId ?? 'flat' }, children),
    HeightfieldCollider: ({ args }: { args: unknown[] }) => {
      const id = ReactModule.useContext(BodyContext);
      rapier.args.set(id, [...(rapier.args.get(id) ?? []), args]);
      return null;
    },
  };
});

vi.mock('../../runtime/physics', () => ({
  physicsUserData: (levelObjectId: string) => ({ levelObjectId }),
  usePhysicsAvailable: () => true,
}));

const terrain = (id: string, position: [number, number, number], heights: number[] = []): LevelObject => ({
  id, levelId: 'level-1', modelId: '', name: id, type: 'terrain',
  position, rotation: [0, 0, 0], scale: [1, 1, 1],
  terrainData: { resolution: 2, width: 10, depth: 10, heights },
} as LevelObject);

const distinctArgs = (id: string) => new Set(rapier.args.get(id) ?? []).size;

describe('level ground colliders', () => {
  it('keep their collider args across re-renders, so the colliders are not rebuilt', () => {
    rapier.args.clear();
    const hills = terrain('hills', [0, 0, 0], new Array(9).fill(1));
    const view = render(<LevelGroundColliders terrains={[hills]} />);
    // Unrelated session renders hand over a new list, and a parented terrain a new world-space copy.
    view.rerender(<LevelGroundColliders terrains={[hills]} />);
    view.rerender(<LevelGroundColliders terrains={[{ ...hills, position: [0, 0, 0] }]} />);
    expect(rapier.args.get('hills')!.length).toBeGreaterThanOrEqual(3);
    expect(distinctArgs('hills')).toBe(1);
    expect(rapier.args.get('flat')!.length).toBeGreaterThanOrEqual(3);
    expect(distinctArgs('flat')).toBe(1);

    // New heights do rebuild the field.
    view.rerender(<LevelGroundColliders terrains={[{ ...hills, terrainData: { ...hills.terrainData!, heights: new Array(9).fill(2) } }]} />);
    expect(distinctArgs('hills')).toBe(2);
  });

  it('give an unsculpted terrain a field and keep the flat ground unless a terrain dips below it', () => {
    rapier.args.clear();
    const view = render(<LevelGroundColliders terrains={[terrain('plain', [0, 5, 0])]} />);
    expect(rapier.args.has('plain')).toBe(true);
    expect(rapier.args.has('flat')).toBe(true);

    rapier.args.clear();
    view.rerender(<LevelGroundColliders terrains={[terrain('pit', [0, 0, 0], [0, 0, 0, 0, -2, 0, 0, 0, 0])]} />);
    expect(rapier.args.has('pit')).toBe(true);
    expect(rapier.args.has('flat')).toBe(false);
  });
});
