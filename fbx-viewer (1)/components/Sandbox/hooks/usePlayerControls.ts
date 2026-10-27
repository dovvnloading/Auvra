
import { useEffect, useRef } from 'react';
import type { InputState } from '../../../runtime/input';
import { useRuntimeServicesAvailable, useRuntimeServices } from '../../../runtime/RuntimeServicesContext';

export interface PlayerInputState {
    moveY: number; // Forward/Back (-1 to 1)
    moveX: number; // Left/Right (-1 to 1)
    isSprinting: boolean;
    isJumping: boolean;
    /** True only on the frame Jump goes down, so holding it does not jump again on landing. */
    jumpPressed: boolean;
    isFiring: boolean;
    isAiming: boolean;
    isReloading: boolean;
    isSwitchingWeapon: boolean;
    /** True only on the frame Fire goes down. */
    firePressed: boolean;
    /** True only on the frame Reload goes down. */
    reloadPressed: boolean;
    /** True only on the frame Next Weapon goes down. */
    nextWeaponPressed: boolean;
}

type HeldInput = Omit<PlayerInputState, 'jumpPressed' | 'firePressed' | 'reloadPressed' | 'nextWeaponPressed'>;

const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

/** Reads the runtime's named actions, so rebinding and gamepads apply. Stick input stays analog. */
export const readActionInput = (input: InputState): HeldInput => ({
    moveY: input.axis('MoveBack', 'MoveForward'),
    moveX: input.axis('MoveLeft', 'MoveRight'),
    isSprinting: input.isDown('Sprint'),
    isJumping: input.isDown('Jump'),
    isFiring: input.isDown('Fire'),
    isAiming: input.isDown('Aim'),
    isReloading: input.isDown('Reload'),
    isSwitchingWeapon: input.isDown('NextWeapon'),
});

/** Fixed keyboard layout used where no game runtime supplies input actions (the Sandbox tab). */
const readKeyboardInput = (keys: Set<string>, mouseButtons: Set<number>): HeldInput => {
    const w = keys.has('KeyW') ? 1 : 0;
    const s = keys.has('KeyS') ? 1 : 0;
    const a = keys.has('KeyA') ? 1 : 0;
    const d = keys.has('KeyD') ? 1 : 0;

    return {
        moveY: w - s,
        moveX: d - a,
        isSprinting: keys.has('ShiftLeft'),
        isJumping: keys.has('Space'),
        isAiming: keys.has('KeyF'),
        isFiring: mouseButtons.has(0), // Left Mouse Button
        isReloading: keys.has('KeyR'),
        isSwitchingWeapon: keys.has('KeyQ'),
    };
};

/**
 * Player input for one frame. Inside a game runtime it reads the runtime's input actions
 * (MoveForward/Back/Left/Right, Sprint, Jump, Fire, Aim); elsewhere it listens to the keyboard itself.
 */
export const usePlayerControls = (enabled: boolean) => {
    const services = useRuntimeServices();
    const actions = useRuntimeServicesAvailable() ? services.input : null;
    const listenToKeyboard = enabled && !actions;

    const keys = useRef(new Set<string>());
    const mouseButtons = useRef(new Set<number>());
    const jumpHeld = useRef(false);
    const held = useRef({ fire: false, reload: false, next: false });

    useEffect(() => {
        if (!listenToKeyboard) return;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || isEditableTarget(e.target)) return;
            keys.current.add(e.code);
        };
        const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);

        const onMouseDown = (e: MouseEvent) => {
            if (document.pointerLockElement) {
                mouseButtons.current.add(e.button);
            }
        };
        const onMouseUp = (e: MouseEvent) => mouseButtons.current.delete(e.button);
        const clearInput = () => {
            keys.current.clear();
            mouseButtons.current.clear();
        };
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') clearInput();
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('blur', clearInput);
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('blur', clearInput);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            clearInput();
        };
    }, [listenToKeyboard]);

    // Call once per frame: the press edges are tracked here, independent of when the runtime advances its own edges.
    const getInputState = (): PlayerInputState => {
        const now = actions ? readActionInput(actions) : readKeyboardInput(keys.current, mouseButtons.current);
        const jumpPressed = now.isJumping && !jumpHeld.current;
        jumpHeld.current = now.isJumping;
        const previous = held.current;
        const pressed = {
            firePressed: now.isFiring && !previous.fire,
            reloadPressed: now.isReloading && !previous.reload,
            nextWeaponPressed: now.isSwitchingWeapon && !previous.next,
        };
        held.current = { fire: now.isFiring, reload: now.isReloading, next: now.isSwitchingWeapon };
        return { ...now, jumpPressed, ...pressed };
    };

    return { getInputState };
};
