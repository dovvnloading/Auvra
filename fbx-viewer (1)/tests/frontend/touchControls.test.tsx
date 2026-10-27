import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUT_MAP, InputState, type InputActionMap } from '../../runtime/input';
import {
  JOYSTICK_RADIUS,
  JOYSTICK_SPRINT_RATIO,
  TouchControls,
  isTouchDevice,
  joystickMoveValues,
  joystickVector,
} from '../../runtime/TouchControls';

const pad = (axes: number[]) => ({ axes, buttons: [] }) as unknown as Gamepad;

const coarseQuery = (initial: boolean) => {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: '(pointer: coarse)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => query });
  return {
    set(matches: boolean) {
      query.matches = matches;
      listeners.forEach(listener => listener());
    },
    listenerCount: () => listeners.size,
  };
};

const setTouchPoints = (count: number) => {
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, get: () => count });
};

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(window.navigator, 'maxTouchPoints');
});

describe('InputState virtual source', () => {
  it('merges a virtual axis with keyboard and gamepad: the strongest source wins', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualAxis('MoveRight', 0.4);
    expect(input.value('MoveRight')).toBeCloseTo(0.4);
    expect(input.axis('MoveLeft', 'MoveRight')).toBeCloseTo(0.4);
    expect(input.isDown('MoveRight')).toBe(false);

    input.keyDown('KeyD');
    expect(input.value('MoveRight')).toBe(1);
    input.keyUp('KeyD');
    expect(input.value('MoveRight')).toBeCloseTo(0.4);

    input.setGamepads([pad([0.85, 0])]);
    expect(input.value('MoveRight')).toBeCloseTo(0.8);
    input.setGamepads([pad([0.4, 0])]);
    expect(input.value('MoveRight')).toBeCloseTo(0.4);

    input.setVirtualAxis('MoveLeft', 0.9);
    expect(input.axis('MoveLeft', 'MoveRight')).toBeCloseTo(-0.5);
  });

  it('clamps virtual axes and treats 0, negative and non-finite values as released', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualAxis('MoveForward', 3);
    expect(input.value('MoveForward')).toBe(1);
    input.setVirtualAxis('MoveForward', -0.5);
    expect(input.value('MoveForward')).toBe(0);
    input.setVirtualAxis('MoveForward', 0.7);
    input.setVirtualAxis('MoveForward', Number.NaN);
    expect(input.value('MoveForward')).toBe(0);
  });

  it('only drives actions the map has', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualButton('Teleport', true);
    input.setVirtualAxis('Strafe', 1);
    expect(input.value('Teleport')).toBe(0);
    expect(input.value('Strafe')).toBe(0);
    input.endFrame();
    expect(input.wasPressed('Teleport')).toBe(false);
    expect(input.hasAction('Teleport')).toBe(false);
    expect(input.hasAction('Jump')).toBe(true);
    expect(input.findAction('Jump')?.label).toBe('Jump');
  });

  it('holds a virtual button down alongside the keyboard: down while any source is down', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualButton('Jump', true);
    input.keyDown('Space');
    input.setVirtualButton('Jump', false);
    expect(input.isDown('Jump')).toBe(true);
    input.keyUp('Space');
    expect(input.isDown('Jump')).toBe(false);
    input.keyDown('Space');
    input.setVirtualButton('Jump', true);
    input.keyUp('Space');
    expect(input.isDown('Jump')).toBe(true);
  });

  it('reports virtual press and release edges once per frame', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualButton('Fire', true);
    input.endFrame();
    expect(input.wasPressed('Fire')).toBe(true);
    input.endFrame();
    expect(input.wasPressed('Fire')).toBe(false);
    expect(input.isDown('Fire')).toBe(true);
    input.setVirtualButton('Fire', false);
    input.endFrame();
    expect(input.wasReleased('Fire')).toBe(true);
  });

  it('latches a virtual tap released before the next frame, like a key tap', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualButton('Pause', true);
    input.setVirtualButton('Pause', false);
    expect(input.isDown('Pause')).toBe(false);
    input.endFrame();
    expect(input.wasPressed('Pause')).toBe(true);
    input.endFrame();
    expect(input.wasReleased('Pause')).toBe(true);
    expect(input.wasPressed('Pause')).toBe(false);
  });

  it('clearVirtual releases virtual input, including an unread tap, and leaves the keyboard alone', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.keyDown('KeyW');
    input.setVirtualAxis('MoveRight', 1);
    input.setVirtualButton('Aim', true);
    input.setVirtualButton('Jump', true);
    input.setVirtualButton('Jump', false);
    input.addLookDelta(5, 5);
    input.clearVirtual();
    expect(input.value('MoveRight')).toBe(0);
    expect(input.isDown('Aim')).toBe(false);
    expect(input.lookDelta()).toEqual({ x: 0, y: 0 });
    expect(input.isDown('MoveForward')).toBe(true);
    input.endFrame();
    expect(input.wasPressed('Jump')).toBe(false);
    expect(input.wasPressed('MoveForward')).toBe(true);
  });

  it('clear releases the virtual source too', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setVirtualButton('Fire', true);
    input.setVirtualAxis('MoveBack', 0.6);
    input.clear();
    expect(input.isDown('Fire')).toBe(false);
    expect(input.value('MoveBack')).toBe(0);
  });

  it('accumulates look drags until the end of the frame', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.addLookDelta(3, -2);
    input.addLookDelta(4, Number.NaN);
    input.addLookDelta(Number.POSITIVE_INFINITY, 1);
    expect(input.lookDelta()).toEqual({ x: 7, y: -1 });
    input.endFrame();
    expect(input.lookDelta()).toEqual({ x: 0, y: 0 });
  });
});

describe('joystickVector', () => {
  it('reads 0 inside the dead zone', () => {
    expect(joystickVector(0, 0, 50, 0.2)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(6, 8, 50, 0.2)).toEqual({ x: 0, y: 0 });
  });

  it('rescales past the dead zone so the reading starts from 0 and reaches 1 at the radius', () => {
    const half = joystickVector(60, 0, 100, 0.2);
    expect(half.x).toBeCloseTo(0.5);
    expect(half.y).toBeCloseTo(0);
    const just = joystickVector(0, -21, 100, 0.2);
    expect(just.y).toBeLessThan(0);
    expect(Math.abs(just.y)).toBeLessThan(0.02);
    expect(joystickVector(0, -100, 100, 0.2).y).toBeCloseTo(-1);
  });

  it('saturates beyond the radius and keeps the direction', () => {
    const diagonal = joystickVector(300, 300, 100, 0.1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.y).toBeCloseTo(Math.SQRT1_2);
    const partial = joystickVector(-30, 40, 100, 0);
    expect(partial.x).toBeCloseTo(-0.3);
    expect(partial.y).toBeCloseTo(0.4);
  });

  it('reads 0 for a degenerate radius, dead zone or drag', () => {
    expect(joystickVector(10, 0, 0, 0.1)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(10, 0, Number.NaN, 0.1)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(Number.NaN, 0, 50, 0.1)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(50, 0, 50, 1)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(25, 0, 50, Number.NaN).x).toBeCloseTo(0.5);
  });

  it('maps up the screen to forward and right to right', () => {
    const values = joystickMoveValues({ x: 0.25, y: -0.75 });
    expect(values.MoveForward).toBeCloseTo(0.75);
    expect(values.MoveBack).toBe(0);
    expect(values.MoveRight).toBeCloseTo(0.25);
    expect(values.MoveLeft).toBe(0);
  });
});

describe('isTouchDevice', () => {
  it('detects a coarse pointer or touch points', () => {
    expect(isTouchDevice()).toBe(false);
    setTouchPoints(5);
    expect(isTouchDevice()).toBe(true);
    setTouchPoints(0);
    coarseQuery(true);
    expect(isTouchDevice()).toBe(true);
  });
});

describe('TouchControls', () => {
  it('stays hidden on a device without touch unless enabled', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    const { rerender } = render(<TouchControls input={input} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<TouchControls input={input} enabled />);
    expect(screen.getByRole('button', { name: 'Jump' })).toBeInTheDocument();
  });

  it('shows on a touch device, follows pointer media changes and can be turned off', () => {
    const media = coarseQuery(false);
    const input = new InputState(DEFAULT_INPUT_MAP);
    const { rerender, unmount } = render(<TouchControls input={input} />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => media.set(true));
    expect(screen.getByRole('button', { name: 'Fire' })).toBeInTheDocument();
    rerender(<TouchControls input={input} enabled={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it('hides while a mouse is in use and comes back on the next touch', () => {
    setTouchPoints(10);
    const input = new InputState(DEFAULT_INPUT_MAP);
    render(<TouchControls input={input} />);
    const jump = screen.getByRole('button', { name: 'Jump' });
    fireEvent.pointerDown(jump, { pointerId: 1, pointerType: 'touch' });
    expect(input.isDown('Jump')).toBe(true);

    fireEvent.pointerMove(window, { pointerType: 'mouse' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(input.isDown('Jump')).toBe(false);

    fireEvent.pointerDown(window, { pointerType: 'touch' });
    expect(screen.getByRole('button', { name: 'Jump' })).toBeInTheDocument();
  });

  it('gives a player with weapons Reload and Next weapon buttons', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    render(<TouchControls input={input} enabled weapons />);
    expect(screen.getByRole('button', { name: 'Next weapon' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Reload' }), { pointerId: 5 });
    expect(input.isDown('Reload')).toBe(true);
  });

  it('renders the action buttons the map has and drives setVirtualButton on press and release', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    const setVirtualButton = vi.spyOn(input, 'setVirtualButton');
    render(<TouchControls input={input} enabled />);
    for (const name of ['Fire', 'Jump', 'Aim', 'Interact', 'Pause']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    // Weapon buttons only for a player that carries weapons.
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    const jump = screen.getByRole('button', { name: 'Jump' });
    fireEvent.pointerDown(jump, { pointerId: 3 });
    expect(setVirtualButton).toHaveBeenLastCalledWith('Jump', true);
    expect(input.isDown('Jump')).toBe(true);
    input.endFrame();
    expect(input.wasPressed('Jump')).toBe(true);

    // A second finger on the same button is ignored, and only the pressing finger releases it.
    fireEvent.pointerDown(jump, { pointerId: 4 });
    fireEvent.pointerUp(jump, { pointerId: 4 });
    expect(input.isDown('Jump')).toBe(true);
    fireEvent.pointerUp(jump, { pointerId: 3 });
    expect(setVirtualButton).toHaveBeenLastCalledWith('Jump', false);
    expect(input.isDown('Jump')).toBe(false);

    const pause = screen.getByRole('button', { name: 'Pause' });
    fireEvent.pointerDown(pause, { pointerId: 5 });
    fireEvent.pointerCancel(pause, { pointerId: 5 });
    expect(setVirtualButton).toHaveBeenCalledWith('Pause', true);
    expect(setVirtualButton).toHaveBeenLastCalledWith('Pause', false);
    input.endFrame();
    expect(input.wasPressed('Pause')).toBe(true);
  });

  it('uses Attack for the fire button when the map has no Fire, and leaves out missing actions', () => {
    const map: InputActionMap = [
      { name: 'Attack', label: 'Attack', bindings: [] },
      { name: 'MoveForward', label: 'Move forward', bindings: [] },
    ];
    render(<TouchControls input={new InputState(map)} enabled />);
    expect(screen.getByRole('button', { name: 'Attack' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jump' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByLabelText('Move')).toBeInTheDocument();
  });

  it('drives the move actions from the joystick and releases them on pointer up', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    render(<TouchControls input={input} enabled />);
    const stick = screen.getByLabelText('Move');

    fireEvent.pointerDown(stick, { pointerId: 7, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(stick, { pointerId: 7, clientX: 104, clientY: 300 });
    expect(input.value('MoveRight')).toBe(0);

    fireEvent.pointerMove(stick, { pointerId: 7, clientX: 100, clientY: 300 - JOYSTICK_RADIUS });
    expect(input.value('MoveForward')).toBeCloseTo(1);
    expect(input.isDown('Sprint')).toBe(false);

    // Another finger moving over the area does not steer.
    fireEvent.pointerMove(stick, { pointerId: 8, clientX: 300, clientY: 300 });
    expect(input.value('MoveRight')).toBe(0);

    const expected = joystickVector(JOYSTICK_RADIUS / 2, 0, JOYSTICK_RADIUS);
    fireEvent.pointerMove(stick, { pointerId: 7, clientX: 100 + JOYSTICK_RADIUS / 2, clientY: 300 });
    expect(input.value('MoveRight')).toBeCloseTo(expected.x);
    expect(input.value('MoveForward')).toBe(0);

    fireEvent.pointerUp(stick, { pointerId: 7, clientX: 100 + JOYSTICK_RADIUS / 2, clientY: 300 });
    for (const name of ['MoveForward', 'MoveBack', 'MoveLeft', 'MoveRight']) expect(input.value(name)).toBe(0);
  });

  it('holds Sprint while the joystick is pushed far past its edge', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    render(<TouchControls input={input} enabled />);
    const stick = screen.getByLabelText('Move');
    const far = JOYSTICK_RADIUS * JOYSTICK_SPRINT_RATIO + 1;

    fireEvent.pointerDown(stick, { pointerId: 2, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(stick, { pointerId: 2, clientX: 200, clientY: 200 - far });
    expect(input.isDown('Sprint')).toBe(true);
    expect(input.value('MoveForward')).toBeCloseTo(1);
    fireEvent.pointerMove(stick, { pointerId: 2, clientX: 200, clientY: 200 - JOYSTICK_RADIUS });
    expect(input.isDown('Sprint')).toBe(false);
    fireEvent.pointerMove(stick, { pointerId: 2, clientX: 200, clientY: 200 - far });
    fireEvent.pointerCancel(stick, { pointerId: 2 });
    expect(input.isDown('Sprint')).toBe(false);
    expect(input.value('MoveForward')).toBe(0);
  });

  it('feeds look drags from the right-side area', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    render(<TouchControls input={input} enabled />);
    const look = screen.getByLabelText('Look');

    fireEvent.pointerMove(look, { pointerId: 1, clientX: 500, clientY: 100 });
    expect(input.lookDelta()).toEqual({ x: 0, y: 0 });

    fireEvent.pointerDown(look, { pointerId: 1, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(look, { pointerId: 1, clientX: 520, clientY: 95 });
    fireEvent.pointerMove(look, { pointerId: 1, clientX: 530, clientY: 105 });
    expect(input.lookDelta()).toEqual({ x: 30, y: 5 });

    fireEvent.pointerUp(look, { pointerId: 1, clientX: 530, clientY: 105 });
    fireEvent.pointerMove(look, { pointerId: 1, clientX: 600, clientY: 105 });
    expect(input.lookDelta()).toEqual({ x: 30, y: 5 });
  });

  it('releases everything it holds when unmounted', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    const clearVirtual = vi.spyOn(input, 'clearVirtual');
    const { unmount } = render(<TouchControls input={input} enabled />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Fire' }), { pointerId: 1 });
    const stick = screen.getByLabelText('Move');
    fireEvent.pointerDown(stick, { pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(stick, { pointerId: 2, clientX: 50 + JOYSTICK_RADIUS, clientY: 50 });
    expect(input.isDown('Fire')).toBe(true);
    expect(input.value('MoveRight')).toBeCloseTo(1);

    unmount();
    expect(clearVirtual).toHaveBeenCalled();
    expect(input.isDown('Fire')).toBe(false);
    expect(input.value('MoveRight')).toBe(0);
  });
});
