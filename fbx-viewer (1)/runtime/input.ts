import { useEffect, useMemo, useRef } from 'react';

/** A physical input: keyboard code (KeyboardEvent.code), mouse button, or standard-mapping gamepad button/axis. */
export type InputBinding =
    | { device: 'keyboard'; code: string }
    | { device: 'mouse'; button: number }
    | { device: 'gamepad'; button: number }
    | { device: 'gamepadAxis'; axis: number; direction: 1 | -1 };

export interface InputAction {
    name: string;
    label: string;
    bindings: InputBinding[];
}

export type InputActionMap = InputAction[];

/** Default gameplay actions. Gamepad indices follow the W3C standard mapping. */
export const DEFAULT_INPUT_MAP: InputActionMap = [
    { name: 'MoveForward', label: 'Move forward', bindings: [{ device: 'keyboard', code: 'KeyW' }, { device: 'keyboard', code: 'ArrowUp' }, { device: 'gamepadAxis', axis: 1, direction: -1 }] },
    { name: 'MoveBack', label: 'Move back', bindings: [{ device: 'keyboard', code: 'KeyS' }, { device: 'keyboard', code: 'ArrowDown' }, { device: 'gamepadAxis', axis: 1, direction: 1 }] },
    { name: 'MoveLeft', label: 'Move left', bindings: [{ device: 'keyboard', code: 'KeyA' }, { device: 'keyboard', code: 'ArrowLeft' }, { device: 'gamepadAxis', axis: 0, direction: -1 }] },
    { name: 'MoveRight', label: 'Move right', bindings: [{ device: 'keyboard', code: 'KeyD' }, { device: 'keyboard', code: 'ArrowRight' }, { device: 'gamepadAxis', axis: 0, direction: 1 }] },
    { name: 'Jump', label: 'Jump', bindings: [{ device: 'keyboard', code: 'Space' }, { device: 'gamepad', button: 0 }] },
    { name: 'Sprint', label: 'Sprint', bindings: [{ device: 'keyboard', code: 'ShiftLeft' }, { device: 'gamepad', button: 10 }] },
    { name: 'Fire', label: 'Fire', bindings: [{ device: 'mouse', button: 0 }, { device: 'gamepad', button: 7 }] },
    { name: 'Aim', label: 'Aim', bindings: [{ device: 'mouse', button: 2 }, { device: 'gamepad', button: 6 }] },
    { name: 'Interact', label: 'Interact', bindings: [{ device: 'keyboard', code: 'KeyF' }, { device: 'gamepad', button: 2 }] },
    { name: 'Pause', label: 'Pause', bindings: [{ device: 'keyboard', code: 'Escape' }, { device: 'gamepad', button: 9 }] },
];

/** Gamepad stick deflection below this counts as released. */
export const GAMEPAD_DEADZONE = 0.25;

/** Applies per-action binding overrides (e.g. from settings or the rebinding menu) over a base map. */
export const applyBindingOverrides = (base: InputActionMap, overrides: Record<string, InputBinding[]> | undefined): InputActionMap =>
    base.map(action => (overrides && Array.isArray(overrides[action.name]) ? { ...action, bindings: overrides[action.name] } : action));

export const describeBinding = (binding: InputBinding): string => {
    switch (binding.device) {
        case 'keyboard': return binding.code.replace(/^Key/, '').replace(/^Digit/, '');
        case 'mouse': return ['Left mouse', 'Middle mouse', 'Right mouse'][binding.button] ?? `Mouse ${binding.button}`;
        case 'gamepad': return `Pad ${binding.button}`;
        case 'gamepadAxis': return `Stick ${binding.axis}${binding.direction > 0 ? '+' : '-'}`;
    }
};

/**
 * Live input state. Pure snapshot logic lives here so it can be tested without a DOM.
 * Sources: keyboard, mouse, gamepads and a virtual source (on-screen touch controls) that drives actions by name.
 */
export class InputState {
    private readonly keys = new Set<string>();
    private readonly mouse = new Set<number>();
    // Pressed since the last endFrame, so a tap released before the next frame is not lost.
    private readonly tappedKeys = new Set<string>();
    private readonly tappedButtons = new Set<number>();
    private readonly tappedVirtual = new Set<string>();
    private readonly virtualAxes = new Map<string, number>();
    private readonly virtualButtons = new Set<string>();
    private gamepads: (Gamepad | null)[] = [];
    private previous = new Set<string>();
    private current = new Set<string>();
    private lookX = 0;
    private lookY = 0;

    constructor(private map: InputActionMap) {}

    setMap(map: InputActionMap) { this.map = map; }
    keyDown(code: string) { this.keys.add(code); this.tappedKeys.add(code); }
    keyUp(code: string) { this.keys.delete(code); }
    mouseDown(button: number) { this.mouse.add(button); this.tappedButtons.add(button); }
    mouseUp(button: number) { this.mouse.delete(button); }
    setGamepads(gamepads: (Gamepad | null)[]) { this.gamepads = gamepads; }
    /** Releases everything held on every source, virtual included. */
    clear() { this.keys.clear(); this.mouse.clear(); this.tappedKeys.clear(); this.tappedButtons.clear(); this.clearVirtual(); }

    /** Analog strength 0..1 of an action from a virtual stick (values outside are clamped, non-finite is 0); 0 releases it. */
    setVirtualAxis(action: string, value: number) {
        const strength = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
        if (strength > 0) this.virtualAxes.set(action, strength);
        else this.virtualAxes.delete(action);
    }

    /** Holds or releases an action from an on-screen button. A press latches until the next endFrame, like a key tap. */
    setVirtualButton(action: string, pressed: boolean) {
        if (pressed) { this.virtualButtons.add(action); this.tappedVirtual.add(action); }
        else this.virtualButtons.delete(action);
    }

    /** Releases every virtual axis and button and drops pending look movement. */
    clearVirtual() { this.virtualAxes.clear(); this.virtualButtons.clear(); this.tappedVirtual.clear(); this.lookX = 0; this.lookY = 0; }

    /** Adds a camera-look drag in screen pixels (x right, y down), e.g. from the touch look area. */
    addLookDelta(dx: number, dy: number) {
        if (Number.isFinite(dx)) this.lookX += dx;
        if (Number.isFinite(dy)) this.lookY += dy;
    }

    /** Look drag in pixels since the last endFrame (x right, y down): the touch counterpart of mouse movementX/movementY. */
    lookDelta(): { x: number; y: number } { return { x: this.lookX, y: this.lookY }; }

    /** The action of that name in the current map, if there is one. */
    findAction(name: string): InputAction | undefined { return this.map.find(item => item.name === name); }

    /** True when the current map has an action of that name. */
    hasAction(name: string): boolean { return this.findAction(name) !== undefined; }

    /** Analog strength of one binding in [0, 1]. */
    private strength(binding: InputBinding): number {
        switch (binding.device) {
            case 'keyboard': return this.keys.has(binding.code) ? 1 : 0;
            case 'mouse': return this.mouse.has(binding.button) ? 1 : 0;
            case 'gamepad': return Math.max(0, ...this.gamepads.map(pad => pad?.buttons[binding.button]?.value ?? 0));
            case 'gamepadAxis': {
                const value = Math.max(0, ...this.gamepads.map(pad => (pad?.axes[binding.axis] ?? 0) * binding.direction));
                return value < GAMEPAD_DEADZONE ? 0 : (value - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE);
            }
        }
    }

    /** Strength 0..1 of a mapped action: the strongest of its bindings and the virtual source. Unmapped actions are 0. */
    value(name: string): number {
        const action = this.findAction(name);
        if (!action) return 0;
        const virtual = this.virtualButtons.has(name) ? 1 : this.virtualAxes.get(name) ?? 0;
        return Math.min(1, Math.max(0, virtual, ...action.bindings.map(binding => this.strength(binding))));
    }

    isDown(name: string): boolean { return this.value(name) > 0.5; }

    /** -1..1 from a pair of opposing actions, e.g. axis('MoveLeft', 'MoveRight'). */
    axis(negative: string, positive: string): number { return this.value(positive) - this.value(negative); }

    /** Call once per frame before reading wasPressed/wasReleased. It also starts a new lookDelta. */
    endFrame() {
        this.previous = this.current;
        const tapped = (binding: InputBinding) => (binding.device === 'keyboard' && this.tappedKeys.has(binding.code))
            || (binding.device === 'mouse' && this.tappedButtons.has(binding.button));
        this.current = new Set(this.map
            .filter(action => this.isDown(action.name) || this.tappedVirtual.has(action.name) || action.bindings.some(tapped))
            .map(action => action.name));
        this.tappedKeys.clear();
        this.tappedButtons.clear();
        this.tappedVirtual.clear();
        this.lookX = 0;
        this.lookY = 0;
    }

    wasPressed(name: string): boolean { return this.current.has(name) && !this.previous.has(name); }
    wasReleased(name: string): boolean { return !this.current.has(name) && this.previous.has(name); }
}

const isEditableTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
};

/**
 * Subscribes an InputState to window keyboard/mouse events and polls gamepads.
 * Call `input.endFrame()` from the game loop each frame (after reading pressed edges).
 */
export const useInputActions = (map: InputActionMap, enabled = true): InputState => {
    // One InputState per mount; later map changes are applied in place below.
    const input = useMemo(() => new InputState(map), []);
    const mapRef = useRef(map);
    if (mapRef.current !== map) { mapRef.current = map; input.setMap(map); }

    useEffect(() => {
        if (!enabled) { input.clear(); return; }
        const down = (event: KeyboardEvent) => { if (!isEditableTarget(event.target)) input.keyDown(event.code); };
        const up = (event: KeyboardEvent) => input.keyUp(event.code);
        // Only presses made while the pointer is locked are gameplay input: the click that captures the
        // pointer, or one on editor/HUD UI, must not fire or aim. Releases stay ungated so a held button always clears.
        const mouseDown = (event: MouseEvent) => { if (document.pointerLockElement) input.mouseDown(event.button); };
        const mouseUp = (event: MouseEvent) => input.mouseUp(event.button);
        const blur = () => input.clear();
        let frame = 0;
        const poll = () => {
            if (typeof navigator !== 'undefined' && navigator.getGamepads) input.setGamepads(Array.from(navigator.getGamepads()));
            frame = requestAnimationFrame(poll);
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('mousedown', mouseDown);
        window.addEventListener('mouseup', mouseUp);
        window.addEventListener('blur', blur);
        frame = requestAnimationFrame(poll);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('mousedown', mouseDown);
            window.removeEventListener('mouseup', mouseUp);
            window.removeEventListener('blur', blur);
            cancelAnimationFrame(frame);
            input.clear();
        };
    }, [enabled, input]);

    return input;
};
