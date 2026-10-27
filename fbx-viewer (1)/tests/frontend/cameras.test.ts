import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createCameraDirector } from '../../runtime/cameraDirector';
import { CAMERA_DEFAULTS, frustumLines, resolveCameraSettings } from '../../runtime/components/cameraComponent';
import { evaluateTimeline, normalizeTimeline } from '../../runtime/timeline/evaluate';
import { parseScriptCommand } from '../../runtime/scripting/ScriptRuntime';
import { createScriptHost } from '../../runtime/scripting/scriptApi';
import type { ScriptSnapshot } from '../../runtime/scripting/protocol';

vi.mock('../../components/Scripting/ScriptInspector', () => ({ ScriptInspector: () => null }));

const levelCamera = (position: [number, number, number], fov = 40) => {
  const camera = new THREE.PerspectiveCamera(fov);
  camera.position.set(...position);
  camera.updateMatrixWorld();
  return camera;
};

const view = () => {
  const camera = new THREE.PerspectiveCamera(70);
  camera.position.set(0, 2, 10);
  return camera;
};

describe('camera director', () => {
  it('leaves the gameplay view alone until a level camera is chosen, then shows it', () => {
    const director = createCameraDirector();
    const rendered = view();
    director.register('cam', levelCamera([5, 5, 5]));
    director.apply(rendered, 1 / 60);
    expect(rendered.position.toArray()).toEqual([0, 2, 10]);
    expect(director.overridesView()).toBe(false);

    director.setActive('cam');
    director.apply(rendered, 1 / 60);
    expect(rendered.position.toArray()).toEqual([5, 5, 5]);
    expect(rendered.fov).toBe(40);
    expect(director.activeId()).toBe('cam');
  });

  it('blends over the requested time and restores the gameplay field of view afterwards', () => {
    const director = createCameraDirector();
    const rendered = view();
    director.register('cam', levelCamera([10, 2, 10], 30));
    director.apply(rendered, 1 / 60);
    director.setActive('cam', 1);
    director.apply(rendered, 0.05);
    director.apply(rendered, 0.05);
    director.apply(rendered, 0.05);
    director.apply(rendered, 0.05);
    director.apply(rendered, 0.05);
    // Half way (with smoothstep easing, exactly the middle).
    director.apply(rendered, 0.25);
    director.apply(rendered, 0.0);
    expect(rendered.position.x).toBeGreaterThan(0);
    expect(rendered.position.x).toBeLessThan(10);
    for (let i = 0; i < 20; i++) director.apply(rendered, 0.1);
    expect(rendered.position.x).toBeCloseTo(10);
    expect(rendered.fov).toBeCloseTo(30);

    director.setActive(null);
    rendered.position.set(0, 2, 10); // the rig places the gameplay view again
    director.apply(rendered, 1 / 60);
    expect(rendered.fov).toBe(70);
    expect(director.overridesView()).toBe(false);
  });

  it('ignores unknown cameras and falls back when the active one goes away', () => {
    const director = createCameraDirector();
    director.setActive('nope');
    expect(director.activeId()).toBeNull();
    const unregister = director.register('cam', levelCamera([1, 1, 1]));
    director.setActive('cam');
    unregister();
    expect(director.activeId()).toBeNull();
  });

  it('forgets everything on reset', () => {
    const director = createCameraDirector();
    director.register('cam', levelCamera([1, 1, 1]));
    director.setActive('cam');
    director.reset();
    expect(director.activeId()).toBeNull();
    director.setActive('cam');
    expect(director.activeId()).toBeNull();
  });
});

describe('camera component', () => {
  it('defaults and clamps its settings', () => {
    expect(resolveCameraSettings({ id: 'c', type: 'camera', enabled: true, props: {} })).toEqual(CAMERA_DEFAULTS);
    expect(resolveCameraSettings({ id: 'c', type: 'camera', enabled: true, props: { fov: 999, startActive: true, blendIn: -1 } }))
      .toEqual({ fov: 150, startActive: true, blendIn: 0 });
  });

  it('outlines the view pyramid', () => {
    const lines = frustumLines(90, 2, 1);
    // Four edges from the eye, four along the far rectangle, two for the up marker; two points each.
    expect(lines.length).toBe((4 + 4 + 2) * 2 * 3);
    const far = Array.from(lines.slice(3, 6));
    expect(far[2]).toBe(-1);
    expect(Math.abs(far[1])).toBeCloseTo(1);
    expect(Math.abs(far[0])).toBeCloseTo(2);
  });
});

describe('timeline camera tracks', () => {
  const timeline = normalizeTimeline({
    duration: 10,
    tracks: [{ id: 't', kind: 'camera', blend: 0.5, keys: [{ time: 0, value: 'wide' }, { time: 4, value: '' }, { time: 6, value: 'close' }] }],
  });

  it('keeps camera tracks and their blend through normalization', () => {
    expect(timeline.tracks[0]).toMatchObject({ kind: 'camera', blend: 0.5 });
  });

  it('holds each shot until the next key, with an empty key meaning the gameplay camera', () => {
    expect(evaluateTimeline(timeline, 1).camera).toEqual({ objectId: 'wide', blend: 0.5 });
    expect(evaluateTimeline(timeline, 5).camera).toEqual({ objectId: '', blend: 0.5 });
    expect(evaluateTimeline(timeline, 9).camera).toEqual({ objectId: 'close', blend: 0.5 });
    expect(evaluateTimeline(normalizeTimeline({ duration: 5, tracks: [] }), 1).camera).toBeUndefined();
  });
});

describe('ctx.setCamera', () => {
  const snapshot = (frame: number): ScriptSnapshot => ({
    frame, time: 0, delta: 0.1, objects: [{ id: 'door', name: 'door', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
    player: null, input: {}, variables: {}, events: [], raycasts: {}, net: { connected: false, isHost: true, selfId: null, peers: [] },
  });

  it('queues the last camera switch of the frame', () => {
    const host = createScriptHost();
    host.load([{ id: 's', objectId: 'door', source: "function onUpdate(ctx) { ctx.setCamera('wide'); ctx.setCamera('close', 2); }" }], source => source, snapshot(0));
    expect(host.frame(snapshot(1)).filter(command => command.type === 'setCamera')).toEqual([{ type: 'setCamera', objectId: 'close', blend: 2 }]);
  });

  it('is validated on its way out of the sandbox', () => {
    expect(parseScriptCommand({ type: 'setCamera', objectId: null, blend: 0 })).toEqual({ type: 'setCamera', objectId: null, blend: 0 });
    expect(parseScriptCommand({ type: 'setCamera', objectId: 'cam', blend: -1 })).toBeNull();
    expect(parseScriptCommand({ type: 'setCamera', objectId: 5, blend: 0 })).toBeNull();
  });
});
