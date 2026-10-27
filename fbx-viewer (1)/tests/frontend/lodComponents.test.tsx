import React from 'react';
import * as THREE from 'three';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentHostContext } from '../../runtime/components/builtins';
import {
  LOD_COMPONENTS,
  LOD_HIDDEN,
  LodEditorPreviewContext,
  chooseLod,
  setNodeHidden,
  useLodEditorPreview,
} from '../../runtime/components/lodComponents';
import type { LevelComponent, LevelObject } from '../../types';

/*
 * LOD Group and Distance Cull: the pure level choice, and the components switching transform groups
 * built the way LevelRuntime draws them (each nested object's group tagged with its id), with frames
 * driven by hand through a stand-in for useFrame.
 */

type FrameCallback = (state: { camera: THREE.Camera }, delta: number) => void;

const frame = vi.hoisted(() => ({ callbacks: new Set<{ current: FrameCallback }>() }));

vi.mock('@react-three/fiber', async () => {
  const R = await import('react');
  return {
    useFrame: (callback: FrameCallback) => {
      const ref = R.useRef(callback);
      ref.current = callback;
      R.useEffect(() => {
        frame.callbacks.add(ref);
        return () => { frame.callbacks.delete(ref); };
      }, []);
    },
  };
});

const camera = new THREE.PerspectiveCamera();

/** Runs one frame with the camera `distance` metres along +Z from the origin. */
const frameAt = (distance: number) => act(() => {
  camera.position.set(0, 0, distance);
  for (const callback of [...frame.callbacks]) callback.current({ camera }, 1 / 60);
});

const definition = (type: string) => {
  const found = LOD_COMPONENTS.find(entry => entry.type === type);
  if (!found) throw new Error(`no ${type} definition`);
  return found;
};

const lodComponent = (type: 'lodGroup' | 'distanceCull', props: Record<string, unknown> = {}): LevelComponent => ({
  id: `${type}-1`,
  type,
  enabled: true,
  props: { ...Object.fromEntries(definition(type).props.map(prop => [prop.key, structuredClone(prop.default)])), ...props },
});

const levelObject = (id: string, extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-1', modelId: '', name: id, type: 'prop',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra,
});

const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());

/** A nested object's transform group, tagged with its id as LevelRuntime tags it. */
const objectGroup = (id: string): THREE.Group => {
  const group = new THREE.Group();
  group.userData = { levelObjectId: id };
  group.add(mesh());
  return group;
};

/** A LOD object's host during play: its model, a light and particles of other components, then nested objects. */
const buildHost = (childIds = ['tree-lod1', 'tree-lod2', 'tree-lod3']) => {
  const host = new THREE.Group();
  host.userData = { levelObjectId: 'tree' };
  const model = new THREE.Group();
  model.add(mesh());
  const light = new THREE.PointLight();
  const particles = new THREE.Points();
  const children = childIds.map(objectGroup);
  host.add(model, light, particles, ...children);
  return { host, model, light, particles, children };
};

const SwitchedObject: React.FC<{
  object: LevelObject;
  component: LevelComponent;
  host: THREE.Object3D;
  mode?: 'editor' | 'runtime';
}> = ({ object, component, host, mode = 'runtime' }) => {
  const hostRef = React.useMemo(() => ({ current: host }), [host]);
  const Render = definition(component.type).Render!;
  return (
    <ComponentHostContext.Provider value={hostRef}>
      <Render object={object} component={component} mode={mode} />
    </ComponentHostContext.Provider>
  );
};

const visibility = (nodes: THREE.Object3D[]) => nodes.map(node => node.visible);

const TREE = levelObject('tree', { modelId: 'tree-model' });

beforeEach(() => {
  frame.callbacks.clear();
});

describe('chooseLod', () => {
  const thresholds = [20, 50, 150];

  it('picks the level whose distance the camera is beyond, and hides past the last one', () => {
    expect(chooseLod(5, thresholds, 0, 0.1)).toBe(0);
    expect(chooseLod(20, thresholds, 0, 0.1)).toBe(0);
    expect(chooseLod(20.01, thresholds, 0, 0.1)).toBe(1);
    expect(chooseLod(49, thresholds, 0, 0.1)).toBe(1);
    expect(chooseLod(60, thresholds, 0, 0.1)).toBe(2);
    expect(chooseLod(150, thresholds, 0, 0.1)).toBe(2);
    expect(chooseLod(151, thresholds, 0, 0.1)).toBe(LOD_HIDDEN);
  });

  it('treats a threshold of 0 (or an unusable one) as off', () => {
    expect(chooseLod(30, [0, 50, 0], 0, 0)).toBe(0);
    expect(chooseLod(60, [0, 50, 0], 0, 0)).toBe(2);
    expect(chooseLod(1e6, [0, 50, 0], 0, 0)).toBe(2);
    expect(chooseLod(1e6, [20, 0, 0], 0, 0)).toBe(1);
    expect(chooseLod(99, [0, 0, 100], 0, 0)).toBe(0);
    expect(chooseLod(101, [0, 0, 100], 0, 0)).toBe(LOD_HIDDEN);
    expect(chooseLod(1000, [-5, Number.NaN, Number.POSITIVE_INFINITY], 0, 0)).toBe(0);
  });

  it('switches farther at the threshold but back nearer only inside the hysteresis band', () => {
    expect(chooseLod(20.5, [20, 50, 0], 0, 0.1)).toBe(1);
    expect(chooseLod(19, [20, 50, 0], 1, 0.1)).toBe(1);
    expect(chooseLod(18.5, [20, 50, 0], 1, 0.1)).toBe(1);
    expect(chooseLod(17.9, [20, 50, 0], 1, 0.1)).toBe(0);
    expect(chooseLod(46, [20, 50, 0], 2, 0.1)).toBe(2);
    expect(chooseLod(44, [20, 50, 0], 2, 0.1)).toBe(1);
  });

  it('keeps a hidden object hidden until it is inside the band', () => {
    expect(chooseLod(99, [100], 0, 0.1)).toBe(0);
    expect(chooseLod(101, [100], 0, 0.1)).toBe(LOD_HIDDEN);
    expect(chooseLod(95, [100], LOD_HIDDEN, 0.1)).toBe(LOD_HIDDEN);
    expect(chooseLod(89, [100], LOD_HIDDEN, 0.1)).toBe(0);
  });

  it('jumps several levels in one frame', () => {
    expect(chooseLod(200, thresholds, 0, 0.1)).toBe(LOD_HIDDEN);
    expect(chooseLod(5, thresholds, LOD_HIDDEN, 0.1)).toBe(0);
    expect(chooseLod(100, thresholds, LOD_HIDDEN, 0.1)).toBe(2);
  });

  it('copes with no thresholds and odd input', () => {
    expect(chooseLod(10, [], 0, 0.1)).toBe(0);
    expect(chooseLod(Number.NaN, thresholds, 0, 0.1)).toBe(0);
    // Negative hysteresis is none; above 1 it is 1, so nothing comes back.
    expect(chooseLod(19.9, [20], LOD_HIDDEN, -1)).toBe(0);
    expect(chooseLod(1, [20], LOD_HIDDEN, 5)).toBe(LOD_HIDDEN);
  });
});

describe('setNodeHidden', () => {
  it('keeps a node hidden while any owner hides it, then restores what it had', () => {
    const node = new THREE.Group();
    const first = {};
    const second = {};
    setNodeHidden(node, first, true);
    setNodeHidden(node, second, true);
    expect(node.visible).toBe(false);
    setNodeHidden(node, first, false);
    expect(node.visible).toBe(false);
    setNodeHidden(node, {}, false);
    expect(node.visible).toBe(false);
    setNodeHidden(node, second, false);
    expect(node.visible).toBe(true);

    const hiddenBefore = new THREE.Group();
    hiddenBefore.visible = false;
    setNodeHidden(hiddenBefore, first, true);
    setNodeHidden(hiddenBefore, first, false);
    expect(hiddenBefore.visible).toBe(false);
  });
});

describe('LOD Group', () => {
  it('shows the own model up close, then each child by camera distance', () => {
    const { host, model, light, particles, children } = buildHost();
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 150] })} host={host} />);

    frameAt(5);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([false, false, false]);

    frameAt(30);
    expect(model.visible).toBe(false);
    expect(visibility(children)).toEqual([true, false, false]);

    frameAt(60);
    expect(model.visible).toBe(false);
    expect(visibility(children)).toEqual([false, true, false]);

    frameAt(200);
    expect(model.visible).toBe(false);
    expect(visibility(children)).toEqual([false, false, false]);

    frameAt(10);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([false, false, false]);

    // Other components' lights and particles, and the host itself, are never switched.
    expect(light.visible).toBe(true);
    expect(particles.visible).toBe(true);
    expect(host.visible).toBe(true);
  });

  it('measures from the host\'s world position', () => {
    const { host, model, children } = buildHost();
    const parent = new THREE.Group();
    parent.position.set(0, 0, 100);
    parent.add(host);
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} />);

    frameAt(95);
    expect(model.visible).toBe(true);
    frameAt(70);
    expect(visibility(children)).toEqual([true, false, false]);
  });

  it('keeps a level until the camera is inside the hysteresis band', () => {
    const { host, model, children } = buildHost();
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 0, 0], hysteresis: 0.1 })} host={host} />);

    frameAt(25);
    expect(visibility(children)).toEqual([true, false, false]);
    frameAt(19);
    expect(model.visible).toBe(false);
    expect(visibility(children)).toEqual([true, false, false]);
    frameAt(17);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([false, false, false]);
  });

  it('counts the children from LOD 0 when the object has no model', () => {
    const { host, model, children } = buildHost();
    render(<SwitchedObject object={levelObject('tree')} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} />);

    frameAt(5);
    expect(visibility(children)).toEqual([true, false, false]);
    frameAt(30);
    expect(visibility(children)).toEqual([false, true, false]);
    frameAt(60);
    expect(visibility(children)).toEqual([false, false, true]);
    // Without a model of its own, nothing else under the host is a level.
    expect(model.visible).toBe(true);
  });

  it('keeps the last level when there are fewer levels than distances', () => {
    const { host, model, children } = buildHost(['tree-lod1']);
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} />);

    frameAt(60);
    expect(model.visible).toBe(false);
    expect(visibility(children)).toEqual([true]);
  });

  it('switches a child added during play', () => {
    const { host, children } = buildHost(['tree-lod1']);
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} />);

    frameAt(60);
    expect(visibility(children)).toEqual([true]);
    const added = objectGroup('tree-lod2');
    host.add(added);
    frameAt(60);
    expect(visibility(children)).toEqual([false]);
    expect(added.visible).toBe(true);
  });

  it('lets every node go when it unmounts, keeping what others hid', () => {
    const { host, model, children } = buildHost();
    children[2].visible = false;
    const { unmount } = render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} />);

    frameAt(60);
    expect(model.visible).toBe(false);
    unmount();
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([true, true, false]);
  });

  it('does not run in the editor unless previewing', () => {
    const { host, model, children } = buildHost();
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0] })} host={host} mode="editor" />);

    expect(frame.callbacks.size).toBe(0);
    frameAt(60);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([true, true, true]);
  });
});

/** The editor's side: the preview provider, with the ids it hides exposed through `seen`. */
const EditorScene: React.FC<{
  objects: LevelObject[];
  host: THREE.Object3D;
  component: LevelComponent;
  seen: { hiddenIds: ReadonlySet<string> };
}> = ({ objects, host, component, seen }) => {
  const { preview, hiddenIds } = useLodEditorPreview(objects);
  seen.hiddenIds = hiddenIds;
  return (
    <LodEditorPreviewContext.Provider value={preview}>
      <SwitchedObject object={objects[0]} component={component} host={host} mode="editor" />
    </LodEditorPreviewContext.Provider>
  );
};

const EDITOR_OBJECTS: LevelObject[] = [
  TREE,
  levelObject('tree-lod1', { parentId: 'tree' }),
  levelObject('rock'),
  levelObject('tree-lod2', { parentId: 'tree' }),
  levelObject('leaf', { parentId: 'tree-lod1' }),
];

const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

describe('editor preview', () => {
  it('hides object ids through the editor, children with their descendants, and leaves nodes alone', () => {
    const { host, model, children } = buildHost();
    const seen = { hiddenIds: new Set<string>() as ReadonlySet<string> };
    const component = lodComponent('lodGroup', { distances: [20, 50, 0], previewInEditor: true });
    const { rerender } = render(<EditorScene objects={EDITOR_OBJECTS} host={host} component={component} seen={seen} />);

    frameAt(5);
    expect(sorted(seen.hiddenIds)).toEqual(['leaf', 'tree-lod1', 'tree-lod2']);
    frameAt(30);
    expect(sorted(seen.hiddenIds)).toEqual(['tree', 'tree-lod2']);
    frameAt(60);
    expect(sorted(seen.hiddenIds)).toEqual(['leaf', 'tree', 'tree-lod1']);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([true, true, true]);

    // Turning the preview off lets every id go.
    rerender(<EditorScene objects={EDITOR_OBJECTS} host={host} component={{ ...component, props: { ...component.props, previewInEditor: false } }} seen={seen} />);
    expect(seen.hiddenIds.size).toBe(0);
  });

  it('does nothing in the editor without the editor\'s preview', () => {
    const { host, model, children } = buildHost();
    render(<SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 50, 0], previewInEditor: true })} host={host} mode="editor" />);

    frameAt(60);
    expect(model.visible).toBe(true);
    expect(visibility(children)).toEqual([true, true, true]);
  });

  it('culls the object with its descendants by id', () => {
    const { host } = buildHost();
    const seen = { hiddenIds: new Set<string>() as ReadonlySet<string> };
    const component = lodComponent('distanceCull', { maxDistance: 40, previewInEditor: true });
    render(<EditorScene objects={EDITOR_OBJECTS} host={host} component={component} seen={seen} />);

    frameAt(30);
    expect(seen.hiddenIds.size).toBe(0);
    frameAt(50);
    expect(sorted(seen.hiddenIds)).toEqual(['leaf', 'tree', 'tree-lod1', 'tree-lod2']);
    expect(host.visible).toBe(true);
    frameAt(30);
    expect(seen.hiddenIds.size).toBe(0);
  });
});

describe('Distance Cull', () => {
  it('hides the object\'s group beyond the distance and shows it inside the hysteresis band', () => {
    const host = objectGroup('crate');
    const nested = objectGroup('crate-lid');
    host.add(nested);
    render(<SwitchedObject object={levelObject('crate')} component={lodComponent('distanceCull', { maxDistance: 100, hysteresis: 0.1 })} host={host} />);

    frameAt(50);
    expect(host.visible).toBe(true);
    frameAt(101);
    expect(host.visible).toBe(false);
    frameAt(95);
    expect(host.visible).toBe(false);
    frameAt(89);
    expect(host.visible).toBe(true);
    expect(nested.visible).toBe(true);
  });

  it('never culls with a distance of 0', () => {
    const host = objectGroup('crate');
    render(<SwitchedObject object={levelObject('crate')} component={lodComponent('distanceCull', { maxDistance: 0 })} host={host} />);

    frameAt(1e5);
    expect(host.visible).toBe(true);
  });

  it('works together with the LOD Group of its parent', () => {
    const { host, model, children } = buildHost(['tree-lod1']);
    const lod1 = children[0];
    render(
      <>
        <SwitchedObject object={TREE} component={lodComponent('lodGroup', { distances: [20, 0, 0] })} host={host} />
        <SwitchedObject object={levelObject('tree-lod1', { parentId: 'tree' })} component={lodComponent('distanceCull', { maxDistance: 40 })} host={lod1} />
      </>
    );

    frameAt(30);
    expect(lod1.visible).toBe(true);
    frameAt(45);
    expect(model.visible).toBe(false);
    expect(lod1.visible).toBe(false);
    frameAt(10);
    expect(model.visible).toBe(true);
    expect(lod1.visible).toBe(false);
    frameAt(30);
    expect(lod1.visible).toBe(true);
  });
});

describe('LOD_COMPONENTS', () => {
  it('defines LOD Group and Distance Cull with their defaults', () => {
    expect(LOD_COMPONENTS.map(entry => [entry.type, entry.label])).toEqual([
      ['lodGroup', 'LOD Group'],
      ['distanceCull', 'Distance Cull'],
    ]);
    const defaults = (type: string) => Object.fromEntries(definition(type).props.map(prop => [prop.key, prop.default]));
    expect(defaults('lodGroup')).toEqual({ distances: [20, 50, 0], hysteresis: 0.1, previewInEditor: false });
    expect(defaults('distanceCull')).toEqual({ maxDistance: 100, hysteresis: 0.1, previewInEditor: false });
  });
});
