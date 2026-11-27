import React from 'react';
import * as THREE from 'three';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoliageTool } from '../../components/Environment/Foliage/FoliageTool';
import { DEFAULT_FOLIAGE_TOOL_SETTINGS, foliageToolStore } from '../../components/Environment/Foliage/foliageSettings';
import { DEFAULT_TERRAIN_TOOL_SETTINGS } from '../../components/Environment/Terrain/terrainTool';
import { useEnvironmentHotkeys } from '../../components/Environment/hooks/useEnvironmentHotkeys';
import { splineEditing } from '../../components/Environment/splineEditing';
import type { InteractionMode } from '../../components/Environment/types';
import { DEFAULT_FOLIAGE_TYPE, type FoliageType } from '../../runtime/foliage';
import { DEFAULT_SPLINE_POINTS, readSplineData, SPLINE_COMPONENT_TYPE, writeSplineData } from '../../runtime/splines';
import type { LevelObject } from '../../types';
import { editorSession } from '../../utils/editorSession';

vi.mock('../../context/SceneContext', () => ({ useScene: () => scene }));
vi.mock('@react-three/fiber', () => ({
  useThree: () => viewport,
  useFrame: () => undefined,
}));
vi.mock('@react-three/drei', () => ({ TransformControls: () => null }));

const canvas = document.createElement('canvas');
const viewport = {
  camera: new THREE.PerspectiveCamera(),
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  scene: new THREE.Scene(),
  gl: { domElement: canvas },
  events: { connected: canvas },
};
const scene = {
  currentLevelId: 'level-1',
  levelObjects: [] as LevelObject[],
  models: [],
  removeLevelObjects: vi.fn(),
  snapshotHistory: vi.fn(),
  updateLevelObject: vi.fn(),
};

const object = (id: string, type: LevelObject['type'] = 'prop', parentId?: string): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name: id, type,
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  ...(parentId ? { parentId } : {}),
});
const transformSettings = { tool: 'translate', space: 'world', snapEnabled: true, snapGrid: 1, snapAngle: 15 } as const;
const foliageSettings = { ...DEFAULT_FOLIAGE_TOOL_SETTINGS, tool: 'select' as const };
const first = [1, 2, 3, 0, 0, 0, 1, 1, 1, 1];
const second = [4, 5, 6, 0, 0, 0, 1, 1, 1, 1];
const foliageType: FoliageType = {
  ...DEFAULT_FOLIAGE_TYPE, id: 'trees', modelId: 'tree-model', instances: new Float32Array([...first, ...second]),
};
const foliageSet: LevelObject = { ...object('foliage', 'foliage_set'), foliageData: { types: [foliageType] } };

const configFor = (interactionMode: InteractionMode): Parameters<typeof useEnvironmentHotkeys>[0] => ({
  state: {
    interactionMode, transformSettings, foliageSettings, sculptSettings: DEFAULT_TERRAIN_TOOL_SETTINGS,
    selectedBrushId: null, selectedObjectId: 'prop', selectedObjectIds: ['prop'],
    isPlaying: false, playFromCamera: false, layout: 'single', cameraSpeed: 1, isMuted: true, showNavigation: false,
  },
  actions: {
    setInteractionMode: vi.fn(), updateTransformSettings: vi.fn(), clearSelection: vi.fn(),
    setSelection: vi.fn(), requestFocus: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  },
  history: { undo: vi.fn(), redo: vi.fn() },
});

const selectSplinePoint = () => {
  scene.levelObjects[0] = {
    ...scene.levelObjects[0],
    components: [{
      id: 'spline', type: SPLINE_COMPONENT_TYPE, enabled: true,
      props: writeSplineData({ points: [...DEFAULT_SPLINE_POINTS], closed: false, up: 'world' }),
    }],
  };
  splineEditing.set({ objectId: 'prop', componentId: 'spline', index: 1, handle: 'point' });
};

const mountFoliage = () => {
  const onTypesChange = vi.fn<(types: FoliageType[]) => void>();
  render(<FoliageTool
    settings={foliageSettings}
    onSettingsChange={vi.fn()}
    set={foliageSet}
    levelObjects={scene.levelObjects}
    transformSettings={transformSettings}
    enabled
    onSnapshot={scene.snapshotHistory}
    onTypesChange={onTypesChange}
  />);
  act(() => foliageToolStore.set({ selection: new Map([['trees', new Set([0])]]) }));
  return onTypesChange;
};
const press = (key: string, init: KeyboardEventInit = {}, target: Window | Element = window) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  fireEvent(target, event);
  return event;
};

beforeEach(() => {
  scene.levelObjects = [object('prop'), object('child', 'prop', 'prop'), foliageSet];
  editorSession.complete(editorSession.beginTransition(), 'project-1', 'level-1', 0);
  // The real foliage component uses R3F intrinsic tags; jsdom/React DOM does not render them.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  foliageToolStore.clearSelection();
  splineEditing.set(null);
  editorSession.close(editorSession.beginTransition());
});

describe('Environment Delete/Backspace ownership', () => {
  it.each([
    { key: 'Delete', foliageFirst: true },
    { key: 'Delete', foliageFirst: false },
    { key: 'Backspace', foliageFirst: true },
    { key: 'Backspace', foliageFirst: false },
  ])('deletes only selected instances ($key, foliage listener first: $foliageFirst)', ({ key, foliageFirst }) => {
    const config = configFor('paint');
    const firstTool = foliageFirst ? mountFoliage() : null;
    renderHook(() => useEnvironmentHotkeys(config));
    const onTypesChange = firstTool ?? mountFoliage();

    expect(press(key).defaultPrevented).toBe(true);
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(config.actions.setSelection).not.toHaveBeenCalled();
    expect(scene.snapshotHistory).toHaveBeenCalledTimes(1);
    expect(onTypesChange).toHaveBeenCalledTimes(1);
    expect(scene.snapshotHistory.mock.invocationCallOrder[0]).toBeLessThan(onTypesChange.mock.invocationCallOrder[0]);
    expect(onTypesChange.mock.calls[0][0][0].instances).toEqual(new Float32Array(second));
    expect(foliageType.instances).toEqual(new Float32Array([...first, ...second]));
    expect(foliageToolStore.get().selection.size).toBe(0);

    // The next keydown, including key repeat, must not delete the hidden prop or add an undo entry.
    press(key, { repeat: true });
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(scene.snapshotHistory).toHaveBeenCalledTimes(1);
    expect(onTypesChange).toHaveBeenCalledTimes(1);
  });

  it.each(['Delete', 'Backspace'])('does not fall back to scene deletion with an empty foliage selection (%s)', (key) => {
    const config = configFor('paint');
    renderHook(() => useEnvironmentHotkeys(config));
    const onTypesChange = mountFoliage();
    // Ctrl-clicking the last selected instance can leave an empty Set in the map.
    act(() => foliageToolStore.set({ selection: new Map([['trees', new Set<number>()]]) }));
    expect(press(key).defaultPrevented).toBe(true);
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
    expect(onTypesChange).not.toHaveBeenCalled();
  });

  it('keeps a hidden scene or spline selection safe even without a mounted foliage viewport', () => {
    const config = configFor('paint');
    selectSplinePoint();
    const command = vi.spyOn(foliageToolStore, 'command');
    renderHook(() => useEnvironmentHotkeys(config));
    expect(press('Delete').defaultPrevented).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(scene.updateLevelObject).not.toHaveBeenCalled();
  });

  it.each(['Delete', 'Backspace'])('retains ordinary subtree deletion after leaving Foliage (%s)', (key) => {
    const config = configFor('paint');
    const { rerender } = renderHook(({ mode }: { mode: InteractionMode }) =>
      useEnvironmentHotkeys({ ...config, state: { ...config.state, interactionMode: mode } }),
      { initialProps: { mode: 'paint' as InteractionMode } });
    rerender({ mode: 'select' });
    expect(press(key).defaultPrevented).toBe(true);
    expect(scene.removeLevelObjects).toHaveBeenCalledTimes(1);
    expect(scene.removeLevelObjects).toHaveBeenCalledWith(['prop', 'child']);
    expect(config.actions.setSelection).toHaveBeenCalledWith([]);
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
  });

  it('deletes a selected spline point instead of its object in Select mode', () => {
    selectSplinePoint();
    renderHook(() => useEnvironmentHotkeys(configFor('select')));
    expect(press('Delete').defaultPrevented).toBe(true);
    expect(scene.snapshotHistory).toHaveBeenCalledTimes(1);
    expect(scene.updateLevelObject).toHaveBeenCalledTimes(1);
    const [id, updates] = scene.updateLevelObject.mock.calls[0];
    expect(id).toBe('prop');
    expect(readSplineData(updates.components[0].props).points).toHaveLength(2);
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
  });

  it('leaves focused input, textarea and select controls, modified keys, and canceled events alone', () => {
    renderHook(() => useEnvironmentHotkeys(configFor('paint')));
    const onTypesChange = mountFoliage();
    const { getByLabelText } = render(<>
      <input aria-label="Name" />
      <textarea aria-label="Notes" />
      <select aria-label="Mode"><option>One</option></select>
    </>);
    for (const name of ['Name', 'Notes', 'Mode']) {
      expect(press('Backspace', {}, getByLabelText(name)).defaultPrevented).toBe(false);
      expect(press('Delete', {}, getByLabelText(name)).defaultPrevented).toBe(false);
    }
    expect(press('Delete', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press('Backspace', { metaKey: true }).defaultPrevented).toBe(false);
    const canceled = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    canceled.preventDefault();
    fireEvent(window, canceled);
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
    expect(onTypesChange).not.toHaveBeenCalled();
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(foliageToolStore.get().selection.get('trees')).toEqual(new Set([0]));
  });

  it('honors an already consumed Delete in Select mode', () => {
    renderHook(() => useEnvironmentHotkeys(configFor('select')));
    const canceled = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    canceled.preventDefault();
    fireEvent(window, canceled);
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
  });

  it('never mutates foliage when the editor session is transitioning', () => {
    renderHook(() => useEnvironmentHotkeys(configFor('paint')));
    const onTypesChange = mountFoliage();
    editorSession.beginTransition();
    expect(press('Delete').defaultPrevented).toBe(true);
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
    expect(onTypesChange).not.toHaveBeenCalled();
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
  });

  it('leaves deletion to Level Blueprint and does not consume its key even with a stale spline selection', () => {
    selectSplinePoint();
    renderHook(() => useEnvironmentHotkeys(configFor('blueprint')));
    expect(press('Delete').defaultPrevented).toBe(false);
    expect(scene.removeLevelObjects).not.toHaveBeenCalled();
    expect(scene.snapshotHistory).not.toHaveBeenCalled();
    expect(scene.updateLevelObject).not.toHaveBeenCalled();
  });
});
