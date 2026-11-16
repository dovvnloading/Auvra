import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { insideStreamingBox, LEVEL_STREAMING_DEFAULTS, resolveLevelStreamingSettings } from '../../runtime/components/levelStreamingComponent';
import { readReachIKSettings } from '../../runtime/components/ikComponents';
import { objectsByLevel, streamedObjectId, streamedObjects, streamedRoots } from '../../runtime/levelStreaming';
import { readRigConstraints } from '../../runtime/proceduralRig';
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

  it('connects a follower to its streamed spline and preserves external and custom fields', () => {
    const cart = object('cart', 'cave', { components: [
      { id: 'follow', type: 'followSpline', enabled: true, props: { spline: 'path' } },
      { id: 'external', type: 'followSpline', enabled: true, props: { spline: 'town-path' } },
      { id: 'custom', type: 'custom', enabled: true, props: { spline: 'path' } },
    ] });
    const path = object('path', 'cave', { components: [{ id: 's', type: 'spline', enabled: true, props: {} }] });
    const [streamedCart, streamedPath] = streamedObjects('cave', [cart, path], 'town');
    expect(streamedCart.components?.map(component => component.props.spline)).toEqual([streamedPath.id, 'town-path', 'path']);
    expect(cart.components?.[0].props.spline).toBe('path');
  });

  it('remaps timeline object and camera targets while preserving cue data and external targets', () => {
    const tracks = [
      { id: 'move', kind: 'transform', objectId: 'cart', label: 'cart' },
      { id: 'hide', kind: 'visibility', objectId: 'cart', keys: [] },
      { id: 'pose', kind: 'animation', objectId: 'cart', keys: [] },
      { id: 'sound', kind: 'audio', objectId: 'cart', keys: [] },
      { id: 'sparks', kind: 'particle', objectId: 'cart', componentId: 'cart', keys: [] },
      { id: 'cut', kind: 'camera', keys: ['cart', 'town-camera', 'sky', ''].map((value, time) => ({ time, value })) },
      { id: 'cue', kind: 'event', keys: [{ time: 0, value: 'cart' }] },
      { id: 'actor', kind: 'animation', objectId: 'player', keys: [] },
    ];
    const owner = object('sequence', 'cave', { components: [
      { id: 'timeline', type: 'timeline', enabled: true, props: { timeline: { duration: 5, tracks } } },
    ] });
    const source = [owner, object('cart', 'cave'), object('player', 'cave'), object('sky', 'cave', { type: 'sky_sphere' })];
    const authored = structuredClone(source);
    const [sequence, cart] = streamedObjects('cave', source, 'town');
    expect(sequence.components?.[0].props.timeline).toMatchObject({ tracks: [
      { objectId: cart.id, label: 'cart' },
      { objectId: cart.id },
      { objectId: cart.id },
      { objectId: cart.id },
      { objectId: cart.id, componentId: 'cart' },
      { keys: [cart.id, 'town-camera', 'sky', ''].map((value, time) => ({ time, value })) },
      { keys: [{ time: 0, value: 'cart' }] },
      { objectId: 'player' },
    ] });
    expect(source).toEqual(authored);
  });

  it('binds patrols, AI vehicles, physics joints and IK to their streamed targets', () => {
    const spawner = object('spawner', 'cave', { type: 'spawn_point', spawnConfig: {
      blueprintId: 'path', interval: 5, maxSpawns: 1, team: 'Enemy', patrolPath: 'path',
    } });
    const riggedVehicle = object('vehicle', 'cave', { components: [
      { id: 'drive', type: 'vehicle', enabled: true, props: { aiPath: 'path' } },
      { id: 'hinge', type: 'joint', enabled: true, props: { connectedObjectId: ' path ' } },
      { id: 'reach', type: 'twoBoneIK', enabled: true, props: { target: ' path ', endBone: 'path' } },
      { id: 'player-reach', type: 'twoBoneIK', enabled: true, props: { target: ' player ' } },
    ] });
    const [spawn, vehicle, path] = streamedObjects('cave', [spawner, riggedVehicle, object('path', 'cave'), object('player', 'cave')], 'town');
    expect(spawn.spawnConfig).toMatchObject({ blueprintId: 'path', patrolPath: path.id });
    const [drive, joint, reach, playerReach] = vehicle.components!;
    expect(drive.props.aiPath).toBe(path.id);
    expect(joint.props.connectedObjectId).toBe(path.id);
    expect(readReachIKSettings(reach)).toMatchObject({ target: path.id, endBone: 'path' });
    expect(readReachIKSettings(playerReach).target).toBe('player');
  });

  it('keeps self-targets distinct from the gameplay player on a timeline host named player', () => {
    const kinds = ['transform', 'visibility', 'audio', 'animation'];
    const timeline = { duration: 1, tracks: kinds.map(kind => ({ id: kind, kind, objectId: 'player', keys: [] })) };
    const host = object('player', 'cave', { components: [{ id: 't', type: 'timeline', enabled: true, props: { timeline } }] });
    const [streamedHost] = streamedObjects('cave', [host], 'town');
    expect(streamedHost.components![0].props.timeline).toMatchObject({ tracks: [
      { kind: 'transform', objectId: streamedHost.id }, { kind: 'visibility', objectId: streamedHost.id },
      { kind: 'audio', objectId: streamedHost.id }, { kind: 'animation', objectId: 'player' },
    ] });
  });

  it('keeps the full streamed target ID when reading a rig and leaves bone names alone', () => {
    const targetId = 't'.repeat(128);
    const rig = object('rig', 'cave', { components: [{
      id: 'aim', type: 'proceduralRig', enabled: true, props: { constraints: [
        { kind: 'aim', bone: targetId, target: { kind: 'object', id: targetId } },
        { kind: 'copyRotation', bone: 'hand', source: targetId },
      ] },
    }] });
    const [streamedRig, target] = streamedObjects('cave', [rig, object(targetId, 'cave')], 'town');
    const [aim, copyRotation] = readRigConstraints(streamedRig.components![0].props);
    expect(aim.target).toEqual({ kind: 'object', id: target.id });
    expect(aim.bone).toBe(targetId);
    expect(copyRotation.source).toBe(targetId);
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
