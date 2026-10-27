import { fireEvent, render, screen } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlayToolbar } from '../../components/Environment/PlayToolbar';
import { inspectScene, type InspectedObject } from '../../runtime/PauseController';

const renderToolbar = (overrides: Partial<React.ComponentProps<typeof PlayToolbar>> = {}) => {
  const props = {
    paused: true,
    onResume: vi.fn(),
    onStep: vi.fn(),
    onRestart: vi.fn(),
    onStop: vi.fn(),
    inspect: () => null,
    objectNames: new Map<string, string>(),
    frame: 0,
    ...overrides,
  };
  const view = render(<PlayToolbar {...props} />);
  return { props, ...view };
};

describe('inspectScene', () => {
  it('reports the outermost group of each level object with its world transform and visibility', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);
    const door = new THREE.Group();
    door.userData.levelObjectId = 'door';
    door.position.set(0, 2, 0);
    const inner = new THREE.Mesh();
    inner.userData.levelObjectId = 'door';
    inner.position.set(5, 0, 0);
    door.add(inner);
    const hidden = new THREE.Group();
    hidden.userData.levelObjectId = 'secret';
    parent.visible = true;
    const hider = new THREE.Group();
    hider.visible = false;
    hider.add(hidden);
    parent.add(door);
    scene.add(parent, hider);

    const found = new Map(inspectScene(scene).map(object => [object.id, object]));
    expect([...found.keys()].sort()).toEqual(['door', 'secret']);
    const doorState = found.get('door')!;
    expect(doorState.position[0]).toBeCloseTo(10);
    expect(doorState.position[1]).toBeCloseTo(2);
    expect(doorState.rotation[1]).toBeCloseTo(90);
    expect(doorState.visible).toBe(true);
    expect(found.get('secret')!.visible).toBe(false);
  });
});

describe('PlayToolbar', () => {
  it('shows only a hint while the game runs', () => {
    renderToolbar({ paused: false });
    expect(screen.getByText('Esc: pause')).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('resumes, steps, restarts and stops from its buttons', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByTitle('Resume (F8)'));
    fireEvent.click(screen.getByTitle('Step one frame (F10)'));
    fireEvent.click(screen.getByTitle('Restart the level'));
    fireEvent.click(screen.getByTitle('Stop and return to the editor (Esc)'));
    expect(props.onResume).toHaveBeenCalledTimes(1);
    expect(props.onStep).toHaveBeenCalledTimes(1);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('maps Escape, F8 and F10 while paused, but not while typing in the filter', () => {
    const { props } = renderToolbar({ inspect: () => () => [] });
    fireEvent.keyDown(window, { key: 'F10' });
    fireEvent.keyDown(window, { key: 'F10' });
    fireEvent.keyDown(window, { key: 'F8' });
    expect(props.onStep).toHaveBeenCalledTimes(2);
    expect(props.onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Inspect the running objects'));
    fireEvent.keyDown(screen.getByPlaceholderText('Filter objects...'), { key: 'Escape' });
    expect(props.onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('lists the running objects by name, filters them and reads them again after a step', () => {
    let objects: InspectedObject[] = [
      { id: 'a', position: [1, 2, 3], rotation: [0, 90, 0], visible: true },
      { id: 'b', position: [0, 0, 0], rotation: [0, 0, 0], visible: false },
    ];
    const names = new Map([['a', 'Door'], ['b', 'Crate']]);
    const { rerender, props } = renderToolbar({ inspect: () => () => objects, objectNames: names });
    fireEvent.click(screen.getByTitle('Inspect the running objects'));
    expect(screen.getByText('Door')).toBeTruthy();
    expect(screen.getByText('Crate')).toBeTruthy();
    expect(screen.getByText('pos 1.00, 2.00, 3.00')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Filter objects...'), { target: { value: 'cra' } });
    expect(screen.queryByText('Door')).toBeNull();
    expect(screen.getByText('Crate')).toBeTruthy();

    objects = [{ id: 'b', position: [0, 5, 0], rotation: [0, 0, 0], visible: true }];
    rerender(<PlayToolbar {...props} inspect={() => () => objects} objectNames={names} frame={1} />);
    expect(screen.getByText('pos 0.00, 5.00, 0.00')).toBeTruthy();
  });
});
