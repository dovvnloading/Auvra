import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { insideStreamingBox, LEVEL_STREAMING_DEFAULTS, resolveLevelStreamingSettings } from '../../runtime/components/levelStreamingComponent';
import { objectsByLevel, streamedObjectId, streamedObjects, streamedRoots } from '../../runtime/levelStreaming';
import type { LevelObject } from '../../types';

const object = (id: string, levelId: string, extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId, modelId: 'm', name: id, type: 'prop', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra,
});

describe('streamed objects', () => {
  const cave = [
    object('rock', 'cave'),
    object('torch', 'cave', { parentId: 'rock' }),
    object('orphan', 'cave', { parentId: 'missing' }),
    object('start', 'cave', { type: 'player_start' }),
    object('sky', 'cave', { type: 'sky_sphere' }),
  ];

  it('prefixes ids, remaps parents and leaves out level singletons', () => {
    const streamed = streamedObjects('cave', cave, 'town');
    expect(streamed.map(item => item.id)).toEqual(['rock', 'torch', 'orphan'].map(id => streamedObjectId('cave', id)));
    expect(streamed.every(item => item.levelId === 'town')).toBe(true);
    expect(streamed[1].parentId).toBe(streamedObjectId('cave', 'rock'));
    expect(streamed[2].parentId).toBeNull();
    expect(streamedRoots(streamed)).toEqual([streamedObjectId('cave', 'rock'), streamedObjectId('cave', 'orphan')]);
  });

  it('copies the objects, leaving the source untouched', () => {
    const streamed = streamedObjects('cave', cave, 'town');
    streamed[0].position[0] = 99;
    expect(cave[0].position[0]).toBe(0);
  });

  it('groups objects by level', () => {
    expect(Object.keys(objectsByLevel([object('a', 'one'), object('b', 'two'), object('c', 'one')]))).toEqual(['one', 'two']);
  });
});

describe('streaming volumes', () => {
  it('defaults and clamps its settings', () => {
    expect(resolveLevelStreamingSettings({ id: 'v', type: 'levelStreaming', enabled: true, props: {} })).toEqual(LEVEL_STREAMING_DEFAULTS);
    expect(resolveLevelStreamingSettings({ id: 'v', type: 'levelStreaming', enabled: true, props: { levelId: 'cave', size: [-1, 5, 'x'], unloadDelay: 9999 } }))
      .toEqual({ levelId: 'cave', size: [0.1, 5, 40], unloadDelay: 600 });
  });

  it('measures the box in the volume\'s own space', () => {
    const host = new THREE.Group();
    host.position.set(100, 0, 0);
    host.rotation.set(0, Math.PI / 2, 0);
    host.updateMatrixWorld(true);
    // Rotated a quarter turn: the 40-long local X axis now runs along world Z.
    expect(insideStreamingBox(host, [40, 10, 4], new THREE.Vector3(100, 0, 15))).toBe(true);
    expect(insideStreamingBox(host, [40, 10, 4], new THREE.Vector3(115, 0, 0))).toBe(false);
    expect(insideStreamingBox(host, [40, 10, 4], new THREE.Vector3(100, 6, 0))).toBe(false);
  });
});
