import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_MAP, useInputActions } from '../../runtime/input';

const setPointerLock = (element: Element | null) => {
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => element });
};

const press = (type: 'mousedown' | 'mouseup', button: number) => {
  window.dispatchEvent(new MouseEvent(type, { button }));
};

describe('useInputActions mouse buttons', () => {
  afterEach(() => {
    delete (document as { pointerLockElement?: Element | null }).pointerLockElement;
  });

  it('ignores mouse presses while the pointer is not locked (the capture click must not fire or aim)', () => {
    setPointerLock(null);
    const { result } = renderHook(() => useInputActions(DEFAULT_INPUT_MAP));
    press('mousedown', 0);
    press('mousedown', 2);
    expect(result.current.isDown('Fire')).toBe(false);
    expect(result.current.isDown('Aim')).toBe(false);
    result.current.endFrame();
    expect(result.current.wasPressed('Fire')).toBe(false);
  });

  it('records presses while locked and always clears on release', () => {
    const canvas = document.createElement('canvas');
    setPointerLock(canvas);
    const { result } = renderHook(() => useInputActions(DEFAULT_INPUT_MAP));
    press('mousedown', 0);
    expect(result.current.isDown('Fire')).toBe(true);
    result.current.endFrame();
    expect(result.current.wasPressed('Fire')).toBe(true);

    // The lock is lost (e.g. Escape) while the button is held: the release still clears it.
    setPointerLock(null);
    press('mouseup', 0);
    expect(result.current.isDown('Fire')).toBe(false);
  });
});
