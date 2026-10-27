import React from 'react';
import * as THREE from 'three';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { gameState } from '../../runtime/gameState';
import { levelVariables } from '../../runtime/levelVariables';
import { readTimelineSettings, TIMELINE_COMPONENT } from '../../runtime/components/timelineComponent';
import {
  collectTimelineTargets,
  crossedTimelineEvents,
  evaluateTimeline,
  findKeyIndex,
  INITIAL_TIMELINE_PLAYBACK,
  interpolationWeight,
  isTimelinePlayValue,
  MIN_TIMELINE_DURATION,
  normalizeTimeline,
  sampleNumberKeys,
  sampleStepKeys,
  sampleVec3Keys,
  stepTimelinePlayback,
  TIMELINE_COMPONENT_TYPE,
  timelineTargetIds,
} from '../../runtime/timeline/evaluate';
import { createTimelineEvents, timelineEvents, type TimelineEvent } from '../../runtime/timeline/events';
import type { TimelineData, TimelineKey, TimelineTrack, TimelineVec3 } from '../../runtime/timeline/types';
import type { LevelComponent, LevelObject } from '../../types';

type FrameCallback = (state: unknown, delta: number) => void;

const fiber = vi.hoisted(() => ({ frame: null as FrameCallback | null, scene: null as unknown }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: FrameCallback) => { fiber.frame = callback; },
  useThree: (selector: (state: { scene: unknown }) => unknown) => selector({ scene: fiber.scene }),
}));

// The inspector is editor UI, not under test here.
vi.mock('../../components/Timeline/TimelineInspector', () => ({ TimelineInspector: () => null }));

afterEach(() => {
  cleanup();
  fiber.frame = null;
  levelVariables.reset();
  gameState.reset();
});

const timeline = (tracks: TimelineTrack[], duration = 4): TimelineData => ({ duration, tracks });

const vecKeys = (...keys: [number, TimelineVec3, TimelineKey<TimelineVec3>['interpolation']?][]): TimelineKey<TimelineVec3>[] =>
  keys.map(([time, value, interpolation]) => (interpolation ? { time, value, interpolation } : { time, value }));

const eventTrack = (id: string, keys: [number, string][], muted = false): TimelineTrack =>
  ({ id, kind: 'event', muted, keys: keys.map(([time, value]) => ({ time, value })) });

const expectVec = (actual: TimelineVec3 | undefined, expected: TimelineVec3) => {
  expect(actual).toBeDefined();
  actual!.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 6));
};

describe('timeline sampling', () => {
  it('interpolates linearly, holds with step and eases with smooth', () => {
    expect(interpolationWeight(undefined, 0.25)).toBe(0.25);
    expect(interpolationWeight('linear', 0.25)).toBe(0.25);
    expect(interpolationWeight('step', 0.99)).toBe(0);
    expect(interpolationWeight('smooth', 0.5)).toBe(0.5);
    expect(interpolationWeight('smooth', 0.25)).toBeCloseTo(0.15625, 6);
    expect(interpolationWeight('linear', 2)).toBe(1);

    const linear = vecKeys([0, [0, 0, 0]], [2, [4, -2, 10]]);
    expectVec(sampleVec3Keys(linear, 0.5), [1, -0.5, 2.5]);
    const stepped = vecKeys([0, [0, 0, 0], 'step'], [2, [4, -2, 10]]);
    expectVec(sampleVec3Keys(stepped, 1.99), [0, 0, 0]);
    expectVec(sampleVec3Keys(stepped, 2), [4, -2, 10]);
    const smooth = vecKeys([0, [0, 0, 0], 'smooth'], [2, [4, 0, 0]]);
    expectVec(sampleVec3Keys(smooth, 0.5), [4 * 0.15625, 0, 0]);
    expectVec(sampleVec3Keys(smooth, 1), [2, 0, 0]);

    // The key a span starts at decides how it moves toward the next one.
    const numbers: TimelineKey<number>[] = [
      { time: 0, value: 0 },
      { time: 1, value: 10, interpolation: 'step' },
      { time: 2, value: 20 },
    ];
    expect(sampleNumberKeys(numbers, 0.5)).toBe(5);
    expect(sampleNumberKeys(numbers, 1.5)).toBe(10);
    expect(sampleNumberKeys(numbers, 2)).toBe(20);
  });

  it('holds the first key before it and the last key after it', () => {
    const keys = vecKeys([1, [1, 1, 1]], [3, [3, 3, 3]]);
    expectVec(sampleVec3Keys(keys, -5), [1, 1, 1]);
    expectVec(sampleVec3Keys(keys, 0), [1, 1, 1]);
    expectVec(sampleVec3Keys(keys, 3), [3, 3, 3]);
    expectVec(sampleVec3Keys(keys, 99), [3, 3, 3]);
    expect(sampleNumberKeys([{ time: 2, value: 7 }], 0)).toBe(7);
    expect(sampleStepKeys([{ time: 1, value: false }, { time: 2, value: true }], 0)).toBe(false);
    expect(sampleStepKeys([{ time: 1, value: false }, { time: 2, value: true }], 5)).toBe(true);
    expect(sampleNumberKeys([], 1)).toBeUndefined();
    expect(sampleVec3Keys([], 1)).toBeUndefined();
    expect(sampleStepKeys([], 1)).toBeUndefined();
  });

  it('finds the last key at or before a time, including the last of equal times', () => {
    const keys = [{ time: 0, value: 'a' }, { time: 1, value: 'b' }, { time: 1, value: 'c' }, { time: 3, value: 'd' }];
    expect(findKeyIndex(keys, -1)).toBe(-1);
    expect(findKeyIndex(keys, 0)).toBe(0);
    expect(findKeyIndex(keys, 1)).toBe(2);
    expect(findKeyIndex(keys, 2.5)).toBe(2);
    expect(findKeyIndex(keys, 10)).toBe(3);
    expect(sampleStepKeys(keys, 1)).toBe('c');
  });

  it('returns new vectors, never the stored key arrays', () => {
    const keys = vecKeys([0, [1, 2, 3]]);
    const sample = sampleVec3Keys(keys, 0)!;
    sample[0] = 99;
    expect(keys[0].value).toEqual([1, 2, 3]);
  });
});

describe('evaluateTimeline', () => {
  it('converts rotation keys from degrees to radians and leaves missing channels out', () => {
    const data = timeline([
      { id: 't1', kind: 'transform', objectId: 'door', rotation: vecKeys([0, [0, 0, 0]], [2, [90, 180, -360]]) },
    ]);
    const { transforms } = evaluateTimeline(data, 2);
    expect(transforms).toHaveLength(1);
    expect(transforms[0].objectId).toBe('door');
    expectVec(transforms[0].rotation, [Math.PI / 2, Math.PI, -2 * Math.PI]);
    expect(transforms[0].position).toBeUndefined();
    expect(transforms[0].scale).toBeUndefined();
    expectVec(evaluateTimeline(data, 1).transforms[0].rotation, [Math.PI / 4, Math.PI / 2, -Math.PI]);
  });

  it('samples every track kind and merges tracks on the same target, later tracks winning', () => {
    const data = timeline([
      { id: 'a', kind: 'transform', objectId: 'box', position: vecKeys([0, [0, 0, 0]], [4, [8, 0, 0]]), scale: vecKeys([0, [1, 1, 1]]) },
      { id: 'b', kind: 'transform', objectId: 'box', position: vecKeys([0, [0, 5, 0]]) },
      { id: 'c', kind: 'visibility', objectId: 'box', keys: [{ time: 0, value: true }, { time: 1, value: false }] },
      { id: 'd', kind: 'variable', name: ' Score ', keys: [{ time: 0, value: 0 }, { time: 4, value: 100 }] },
      eventTrack('e', [[1, 'Ding']]),
    ]);
    expect(evaluateTimeline(data, 2)).toEqual({
      transforms: [{ objectId: 'box', position: [0, 5, 0], scale: [1, 1, 1] }],
      visibility: [{ objectId: 'box', visible: false }],
      variables: [{ name: 'Score', value: 50 }],
    });
  });

  it('skips muted tracks, blank targets and tracks without keys', () => {
    const data = timeline([
      { id: 'a', kind: 'transform', objectId: 'box', muted: true, position: vecKeys([0, [9, 9, 9]]) },
      { id: 'b', kind: 'visibility', objectId: 'box', muted: true, keys: [{ time: 0, value: false }] },
      { id: 'c', kind: 'variable', name: 'Score', muted: true, keys: [{ time: 0, value: 3 }] },
      { id: 'd', kind: 'transform', objectId: '', position: vecKeys([0, [1, 1, 1]]) },
      { id: 'e', kind: 'transform', objectId: 'empty', position: [] },
      { id: 'f', kind: 'variable', name: '   ', keys: [{ time: 0, value: 1 }] },
      { id: 'g', kind: 'visibility', objectId: 'lamp', keys: [] },
    ]);
    expect(evaluateTimeline(data, 1)).toEqual({ transforms: [], visibility: [], variables: [] });
  });

  it('treats a non-finite time as the start', () => {
    const data = timeline([{ id: 'v', kind: 'variable', name: 'X', keys: [{ time: 0, value: 1 }, { time: 1, value: 2 }] }]);
    expect(evaluateTimeline(data, Number.NaN).variables).toEqual([{ name: 'X', value: 1 }]);
  });
});

describe('crossedTimelineEvents', () => {
  const data = timeline([
    eventTrack('e1', [[0, 'Start'], [1, 'One'], [4, 'End']]),
    eventTrack('e2', [[1, 'Also One'], [2.5, '  Trimmed  '], [3, '   ']]),
    eventTrack('muted', [[1, 'Never']], true),
  ]);

  it('reports keys in (previous, time] in time order, skipping muted tracks and blank names', () => {
    expect(crossedTimelineEvents(data, 0, 1, false)).toEqual(['One', 'Also One']);
    expect(crossedTimelineEvents(data, 1, 2, false)).toEqual([]);
    expect(crossedTimelineEvents(data, 2, 3.5, false)).toEqual(['Trimmed']);
    expect(crossedTimelineEvents(data, 3.5, 4, false)).toEqual(['End']);
  });

  it('includes keys at 0 when the previous time is negative (the first step)', () => {
    expect(crossedTimelineEvents(data, -1, 0.5, false)).toEqual(['Start']);
    expect(crossedTimelineEvents(data, 0, 0.5, false)).toEqual([]);
  });

  it('runs to the end and on from the start across a loop wrap', () => {
    expect(crossedTimelineEvents(data, 3, 1, true)).toEqual(['End', 'Start', 'One', 'Also One']);
    expect(crossedTimelineEvents(data, 3.9, 0, true)).toEqual(['End', 'Start']);
    expect(crossedTimelineEvents(data, 4, 0.5, true)).toEqual(['Start']);
  });
});

describe('stepTimelinePlayback', () => {
  const data = timeline([eventTrack('e', [[0, 'Start'], [1, 'One'], [2, 'End']])], 2);

  it('starts at 0 with its keys, advances, and stops finished at the end without a loop', () => {
    let step = stepTimelinePlayback(data, INITIAL_TIMELINE_PLAYBACK, 0.5, false);
    expect(step).toEqual({ playback: { time: 0.5, started: true, finished: false }, events: ['Start'], moved: true });
    step = stepTimelinePlayback(data, step.playback, 1, false);
    expect(step.events).toEqual(['One']);
    step = stepTimelinePlayback(data, step.playback, 5, false);
    expect(step).toEqual({ playback: { time: 2, started: true, finished: true }, events: ['End'], moved: true });
    const after = stepTimelinePlayback(data, step.playback, 1, false);
    expect(after).toEqual({ playback: step.playback, events: [], moved: false });
  });

  it('wraps a looping timeline once per step and raises each crossed event once', () => {
    let step = stepTimelinePlayback(data, INITIAL_TIMELINE_PLAYBACK, 1.5, true);
    expect(step.events).toEqual(['Start', 'One']);
    step = stepTimelinePlayback(data, step.playback, 1, true);
    expect(step.playback.time).toBeCloseTo(0.5, 6);
    expect(step.playback.finished).toBe(false);
    expect(step.events).toEqual(['End', 'Start']);
    step = stepTimelinePlayback(data, step.playback, 9, true);
    expect(step.playback.time).toBeCloseTo(1.5, 6);
    expect(step.events).toEqual(['One', 'End', 'Start', 'One']);
  });

  it('applies the start once at speed 0 and then stays put', () => {
    const first = stepTimelinePlayback(data, INITIAL_TIMELINE_PLAYBACK, 0, false);
    expect(first).toEqual({ playback: { time: 0, started: true, finished: false }, events: ['Start'], moved: true });
    expect(stepTimelinePlayback(data, first.playback, 0, false).moved).toBe(false);
    expect(stepTimelinePlayback(data, first.playback, -3, false).moved).toBe(false);
    expect(stepTimelinePlayback(data, first.playback, Number.NaN, false).moved).toBe(false);
  });
});

describe('isTimelinePlayValue', () => {
  it('plays for true and non-zero values, pauses for everything else', () => {
    for (const value of [true, 1, -0.5, 'true', '2', ' 1 ']) expect(isTimelinePlayValue(value)).toBe(true);
    for (const value of [false, 0, Number.NaN, 'false', '0', '', 'yes', undefined, null, {}]) expect(isTimelinePlayValue(value)).toBe(false);
  });
});

describe('timeline targets', () => {
  it('lists the objects unmuted transform and visibility tracks drive, once each', () => {
    const data = timeline([
      { id: 'a', kind: 'transform', objectId: 'box' },
      { id: 'b', kind: 'visibility', objectId: 'box', keys: [] },
      { id: 'c', kind: 'visibility', objectId: 'lamp', keys: [] },
      { id: 'd', kind: 'transform', objectId: 'ghost', muted: true },
      { id: 'e', kind: 'transform', objectId: '' },
      { id: 'f', kind: 'variable', name: 'box', keys: [] },
    ]);
    expect(timelineTargetIds(data)).toEqual(['box', 'lamp']);
  });

  it('collects targets from enabled timeline components only', () => {
    const stored = { duration: 2, tracks: [{ id: 'a', kind: 'transform', objectId: 'door' }] };
    const other = { duration: 2, tracks: [{ id: 'a', kind: 'visibility', objectId: 'lamp', keys: [] }] };
    const targets = collectTimelineTargets([
      { components: [{ id: 'c1', type: TIMELINE_COMPONENT_TYPE, enabled: true, props: { timeline: stored } }] },
      { components: [{ id: 'c2', type: TIMELINE_COMPONENT_TYPE, enabled: false, props: { timeline: other } }] },
      { components: [{ id: 'c3', type: 'mover', enabled: true, props: { timeline: other } }] },
      { components: [{ id: 'c4', type: TIMELINE_COMPONENT_TYPE, enabled: true, props: {} }] },
      {},
    ]);
    expect([...targets]).toEqual(['door']);
  });
});

describe('normalizeTimeline', () => {
  it('falls back to an empty default timeline for values that are not timelines', () => {
    for (const value of [undefined, null, 5, 'timeline', [], [{ duration: 3 }]]) {
      expect(normalizeTimeline(value)).toEqual({ duration: 5, tracks: [] });
    }
    expect(normalizeTimeline({ duration: 'long', tracks: 'none' })).toEqual({ duration: 5, tracks: [] });
    expect(normalizeTimeline({ duration: Number.POSITIVE_INFINITY })).toEqual({ duration: 5, tracks: [] });
  });

  it('keeps the duration above zero', () => {
    expect(normalizeTimeline({ duration: 0 }).duration).toBe(MIN_TIMELINE_DURATION);
    expect(normalizeTimeline({ duration: -3 }).duration).toBe(MIN_TIMELINE_DURATION);
    expect(normalizeTimeline({ duration: 12.5 }).duration).toBe(12.5);
  });

  it('drops malformed tracks and repeated ids', () => {
    const { tracks } = normalizeTimeline({
      duration: 3,
      tracks: [
        null,
        'track',
        { kind: 'transform', objectId: 'a' },
        { id: '', kind: 'transform', objectId: 'a' },
        { id: 'unknown', kind: 'camera', objectId: 'a' },
        { id: 'noTarget', kind: 'transform' },
        { id: 'badTarget', kind: 'visibility', objectId: 7, keys: [] },
        { id: 'noKeys', kind: 'visibility', objectId: 'a' },
        { id: 'noName', kind: 'variable', keys: [] },
        { id: 'eventKeys', kind: 'event', keys: {} },
        { id: 'ok', kind: 'event', keys: [], label: 'Cues', muted: true },
        { id: 'ok', kind: 'variable', name: 'Dup', keys: [] },
        { id: 'blank', kind: 'transform', objectId: '', label: 3, muted: 'yes' },
      ],
    });
    expect(tracks).toEqual([
      { id: 'ok', kind: 'event', keys: [], label: 'Cues', muted: true },
      { id: 'blank', kind: 'transform', objectId: '' },
    ]);
  });

  it('drops malformed keys, sorts the rest by time and keeps only valid interpolations', () => {
    const { tracks } = normalizeTimeline({
      duration: 3,
      tracks: [
        {
          id: 't',
          kind: 'transform',
          objectId: 'box',
          position: [
            { time: 2, value: [2, 2, 2], interpolation: 'smooth' },
            { time: Number.NaN, value: [0, 0, 0] },
            { time: -1, value: [0, 0, 0] },
            { time: 1, value: [1, 1] },
            { time: 1, value: [1, 1, 'x'] },
            { time: 0, value: [0, 0, 0], interpolation: 'bounce' },
            'key',
          ],
          rotation: 'spin',
          scale: [],
        },
        {
          id: 'v',
          kind: 'visibility',
          objectId: 'box',
          keys: [{ time: 1, value: 'no' }, { time: 0.5, value: false, interpolation: 'smooth' }, { time: 0, value: true }],
        },
        { id: 'n', kind: 'variable', name: 'Score', keys: [{ time: 1, value: '3' }, { time: 0, value: 2, interpolation: 'step' }] },
        { id: 'e', kind: 'event', keys: [{ time: 2, value: 'B' }, { time: 1, value: 4 }, { time: 1, value: 'A' }] },
      ],
    });
    expect(tracks).toEqual([
      {
        id: 't',
        kind: 'transform',
        objectId: 'box',
        position: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [2, 2, 2], interpolation: 'smooth' }],
        scale: [],
      },
      { id: 'v', kind: 'visibility', objectId: 'box', keys: [{ time: 0, value: true }, { time: 0.5, value: false }] },
      { id: 'n', kind: 'variable', name: 'Score', keys: [{ time: 0, value: 2, interpolation: 'step' }] },
      { id: 'e', kind: 'event', keys: [{ time: 1, value: 'A' }, { time: 2, value: 'B' }] },
    ]);
  });

  it('returns a copy that shares nothing with the stored value', () => {
    const stored = { duration: 2, tracks: [{ id: 't', kind: 'transform', objectId: 'box', position: [{ time: 0, value: [1, 2, 3] }] }] };
    const normalized = normalizeTimeline(stored);
    const track = normalized.tracks[0];
    if (track.kind !== 'transform') throw new Error('expected a transform track');
    track.position![0].value[0] = 99;
    expect(stored.tracks[0].position[0].value).toEqual([1, 2, 3]);
  });
});

describe('timeline events bus', () => {
  it('delivers to current listeners in order and stops after unsubscribe', () => {
    const events = createTimelineEvents();
    const seen: string[] = [];
    const first = events.subscribe(event => seen.push(`first:${event.timelineObjectId}:${event.name}`));
    events.subscribe(event => seen.push(`second:${event.name}`));
    events.emit({ timelineObjectId: 'gate', name: 'Open' });
    first();
    events.emit({ timelineObjectId: 'gate', name: 'Close' });
    expect(seen).toEqual(['first:gate:Open', 'second:Open', 'second:Close']);
  });

  it('reports a throwing listener and still delivers to the rest', () => {
    const failure = vi.spyOn(frontendDiagnostics, 'failure').mockImplementation(() => undefined);
    const events = createTimelineEvents();
    const seen: string[] = [];
    events.subscribe(() => { throw new Error('listener broke'); });
    events.subscribe(event => seen.push(event.name));
    events.emit({ timelineObjectId: 'gate', name: 'Open' });
    expect(seen).toEqual(['Open']);
    expect(failure).toHaveBeenCalledWith('runtime_timeline_event_listener_failed', expect.any(Error));
  });
});

describe('timeline component', () => {
  const owner = { id: 'switch' } as LevelObject;

  /** A session scene with the transform groups a play session draws targets in. */
  const sessionScene = (...ids: string[]) => {
    const scene = new THREE.Scene();
    const groups: Record<string, THREE.Group> = {};
    for (const id of ids) {
      const group = new THREE.Group();
      group.userData = { levelObjectId: id };
      // A nested node with the same id (a model clone, say) must not be picked over its group.
      const inner = new THREE.Object3D();
      inner.userData = { levelObjectId: id };
      group.add(inner);
      scene.add(group);
      groups[id] = group;
    }
    fiber.scene = scene;
    return { scene, groups };
  };

  const doorTimeline = {
    duration: 1,
    tracks: [
      {
        id: 'move',
        kind: 'transform',
        objectId: 'door',
        position: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 4, 0] }],
        rotation: [{ time: 0, value: [0, 90, 0] }],
      },
      { id: 'hide', kind: 'visibility', objectId: 'lamp', keys: [{ time: 0, value: true }, { time: 0.5, value: false }] },
      { id: 'progress', kind: 'variable', name: 'Progress', keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
      { id: 'cues', kind: 'event', keys: [{ time: 1, value: 'Opened' }] },
    ],
  };

  const timelineComponent = (props: Record<string, unknown>): LevelComponent => ({
    id: 'tl',
    type: 'timeline',
    enabled: true,
    props: { autoplay: true, loop: false, speed: 1, playVariable: '', timeline: doorTimeline, ...props },
  });

  const mount = (component: LevelComponent, mode: 'editor' | 'runtime' = 'runtime') =>
    render(React.createElement(TIMELINE_COMPONENT.Render!, { object: owner, component, mode }));

  const runFrames = (count: number, delta = 0.1) => {
    for (let i = 0; i < count; i++) fiber.frame?.({}, delta);
  };

  const collectEvents = () => {
    const seen: TimelineEvent[] = [];
    const unsubscribe = timelineEvents.subscribe(event => seen.push(event));
    return { seen, unsubscribe };
  };

  it('defines the timeline component with its schema props; the editor attaches its inspector', () => {
    expect(TIMELINE_COMPONENT.type).toBe(TIMELINE_COMPONENT_TYPE);
    expect(TIMELINE_COMPONENT.label).toBe('Timeline');
    expect(Object.fromEntries(TIMELINE_COMPONENT.props.map(prop => [prop.key, prop.default])))
      .toEqual({ autoplay: true, loop: false, speed: 1, playVariable: '' });
    expect(TIMELINE_COMPONENT.props.some(prop => prop.key === 'timeline')).toBe(false);
    expect(TIMELINE_COMPONENT.Inspector).toBeUndefined();
    expect(readTimelineSettings({ id: 'x', type: 'timeline', enabled: true, props: { speed: 99, loop: 'yes', playVariable: '  Door ' } }))
      .toEqual({ autoplay: true, loop: false, speed: 10, playVariable: 'Door' });
  });

  it('renders nothing and runs nothing in the editor', () => {
    sessionScene('door');
    const { container } = mount(timelineComponent({}), 'editor');
    expect(container.innerHTML).toBe('');
    expect(fiber.frame).toBeNull();
  });

  it('moves, hides, writes variables and raises events on the session groups while it plays', () => {
    const { groups } = sessionScene('door', 'lamp');
    const { seen, unsubscribe } = collectEvents();
    mount(timelineComponent({}));

    runFrames(5);
    expect(groups.door.position.y).toBeCloseTo(2, 6);
    expect(groups.door.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(groups.door.children[0].position.y).toBe(0);
    expect(groups.lamp.visible).toBe(false);
    expect(levelVariables.get('Progress')).toBeCloseTo(0.5, 6);
    expect(seen).toEqual([]);

    // A long frame is capped, and the end holds without raising the event again.
    runFrames(1, 5);
    expect(groups.door.position.y).toBeCloseTo(2.4, 6);
    runFrames(10);
    expect(groups.door.position.y).toBe(4);
    expect(levelVariables.get('Progress')).toBe(1);
    expect(seen).toEqual([{ timelineObjectId: 'switch', name: 'Opened' }]);

    // Finished: other writers are left alone.
    groups.door.position.y = -1;
    runFrames(3);
    expect(groups.door.position.y).toBe(-1);
    unsubscribe();
  });

  it('plays only while its play variable is true or non-zero', () => {
    const { groups } = sessionScene('door', 'lamp');
    levelVariables.reset([{ name: 'DoorOpen', type: 'Boolean', value: false }]);
    mount(timelineComponent({ autoplay: false, playVariable: 'DoorOpen' }));

    runFrames(3);
    expect(groups.door.position.y).toBe(0);
    levelVariables.set('DoorOpen', true);
    runFrames(2);
    expect(groups.door.position.y).toBeCloseTo(0.8, 6);
    levelVariables.set('DoorOpen', false);
    runFrames(4);
    expect(groups.door.position.y).toBeCloseTo(0.8, 6);
    levelVariables.set('DoorOpen', true);
    runFrames(1);
    expect(groups.door.position.y).toBeCloseTo(1.2, 6);
  });

  it('loops, raising the end event on every pass', () => {
    sessionScene('door', 'lamp');
    const { seen, unsubscribe } = collectEvents();
    mount(timelineComponent({ loop: true, speed: 2 }));
    runFrames(10);
    expect(seen.map(event => event.name)).toEqual(['Opened', 'Opened']);
    unsubscribe();
  });

  it('finds a target again after its group is remounted, and reports a missing one once', () => {
    const warning = vi.spyOn(frontendDiagnostics, 'warning').mockImplementation(() => undefined);
    const { scene, groups } = sessionScene('door');
    mount(timelineComponent({}));
    runFrames(2);
    expect(groups.door.position.y).toBeCloseTo(0.8, 6);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('runtime_timeline_target_missing');

    scene.remove(groups.door);
    const remounted = new THREE.Group();
    remounted.userData = { levelObjectId: 'door' };
    scene.add(remounted);
    runFrames(1);
    expect(remounted.position.y).toBeCloseTo(1.2, 6);
    runFrames(10);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
