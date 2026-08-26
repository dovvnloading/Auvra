
import { useEffect, useRef, useMemo } from 'react';

export interface PlayerInputState {
    moveY: number; // Forward/Back (-1 to 1)
    moveX: number; // Left/Right (-1 to 1)
    isSprinting: boolean;
    isJumping: boolean;
    isFiring: boolean;
    isAiming: boolean;
}

export const usePlayerControls = (enabled: boolean) => {
    const keys = useRef(new Set<string>());
    const mouseButtons = useRef(new Set<number>());

    useEffect(() => {
        if (!enabled) return;

        const onKeyDown = (e: KeyboardEvent) => keys.current.add(e.code);
        const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
        
        const onMouseDown = (e: MouseEvent) => {
            if (document.pointerLockElement) {
                mouseButtons.current.add(e.button);
            }
        };
        const onMouseUp = (e: MouseEvent) => mouseButtons.current.delete(e.button);

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [enabled]);

    // Returns a function to get the current state frame-by-frame
    const getInputState = (): PlayerInputState => {
        const k = keys.current;
        const m = mouseButtons.current;

        const w = k.has('KeyW') ? 1 : 0;
        const s = k.has('KeyS') ? 1 : 0;
        const a = k.has('KeyA') ? 1 : 0;
        const d = k.has('KeyD') ? 1 : 0;

        return {
            moveY: w - s,
            moveX: d - a,
            isSprinting: k.has('ShiftLeft'),
            isJumping: k.has('Space'),
            isAiming: k.has('KeyF'), // New Aim Binding
            isFiring: m.has(0)       // Left Mouse Button
        };
    };

    return { getInputState };
};
