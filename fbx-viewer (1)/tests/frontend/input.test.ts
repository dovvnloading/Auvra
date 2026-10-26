import { describe, expect, it } from 'vitest';
import { applyBindingOverrides, DEFAULT_INPUT_MAP, InputState } from '../../runtime/input';

const pad = (axes: number[], buttons: number[] = []) => ({
  axes, buttons: buttons.map(value => ({ value, pressed: value > 0.5, touched: value > 0 })),
}) as unknown as Gamepad;

describe('input actions', () => {
  it('maps keys, mouse and gamepad to actions', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.keyDown('KeyW');
    input.mouseDown(0);
    expect(input.isDown('MoveForward')).toBe(true);
    expect(input.isDown('Fire')).toBe(true);
    input.keyUp('KeyW');
    input.setGamepads([pad([0, -1])]);
    expect(input.value('MoveForward')).toBe(1);
    expect(input.axis('MoveLeft', 'MoveRight')).toBe(0);
  });

  it('ignores stick drift inside the deadzone', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.setGamepads([pad([0.1, 0])]);
    expect(input.value('MoveRight')).toBe(0);
  });

  it('reports press and release edges once per frame', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.keyDown('Space');
    input.endFrame();
    expect(input.wasPressed('Jump')).toBe(true);
    input.endFrame();
    expect(input.wasPressed('Jump')).toBe(false);
    input.keyUp('Space');
    input.endFrame();
    expect(input.wasReleased('Jump')).toBe(true);
  });

  it('applies rebinding overrides', () => {
    const map = applyBindingOverrides(DEFAULT_INPUT_MAP, { Jump: [{ device: 'keyboard', code: 'KeyJ' }] });
    const input = new InputState(map);
    input.keyDown('Space');
    expect(input.isDown('Jump')).toBe(false);
    input.keyDown('KeyJ');
    expect(input.isDown('Jump')).toBe(true);
  });
});
