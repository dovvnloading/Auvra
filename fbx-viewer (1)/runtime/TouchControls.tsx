import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pause } from 'lucide-react';
import type { InputState } from './input';
import { uiActionLabelKey, useTranslation } from './localization';

/** How far the joystick knob travels from the stick centre, in CSS pixels; a drag this long reads full deflection. */
export const JOYSTICK_RADIUS = 56;

/** Fraction of JOYSTICK_RADIUS a drag must pass before the stick reads as pushed. */
export const TOUCH_DEAD_ZONE = 0.15;

/** Dragging this many radii from the stick centre also holds Sprint, so running needs no second thumb. */
export const JOYSTICK_SPRINT_RATIO = 1.6;

/** The DEFAULT_INPUT_MAP move actions the joystick drives; forward is up the screen. */
export const TOUCH_MOVE_ACTIONS = { forward: 'MoveForward', back: 'MoveBack', left: 'MoveLeft', right: 'MoveRight' } as const;

/** Action held while the joystick is pushed past JOYSTICK_SPRINT_RATIO. */
export const TOUCH_SPRINT_ACTION = 'Sprint';

/** Action of the pause button in the top-right corner. */
export const TOUCH_PAUSE_ACTION = 'Pause';

/** One on-screen button. */
export interface TouchButtonSpec {
    /** Candidate action names; the first one the input map has is used, so a project's 'Attack' stands in for 'Fire'. */
    actions: readonly string[];
    /** Tailwind position, size and text classes. */
    className: string;
}

/** The right-thumb buttons, each shown only when the input map has one of its actions. They hold the action while touched. */
export const TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
    { actions: ['Fire', 'Attack'], className: 'bottom-8 right-6 h-20 w-20 text-sm' },
    { actions: ['Jump'], className: 'bottom-6 right-32 h-16 w-16 text-xs' },
    { actions: ['Aim'], className: 'bottom-32 right-8 h-14 w-14 text-[11px]' },
    { actions: ['Interact', 'Use'], className: 'bottom-28 right-28 h-14 w-14 text-[11px]' },
];

/** A stick reading: x right and y down the screen, length 0..1. */
export interface JoystickVector {
    x: number;
    y: number;
}

/**
 * Stick reading for a drag of (dx, dy) pixels from the joystick centre. A drag within deadZone (a fraction of
 * radius) reads 0; past it the length rises from 0 to 1 at radius and stays 1 beyond, in the drag's direction.
 */
export const joystickVector = (dx: number, dy: number, radius: number, deadZone: number = TOUCH_DEAD_ZONE): JoystickVector => {
    const distance = Math.hypot(dx, dy);
    const zone = Number.isFinite(deadZone) ? Math.max(0, deadZone) : 0;
    if (!(radius > 0) || !Number.isFinite(distance) || distance === 0 || zone >= 1) return { x: 0, y: 0 };
    const deflection = Math.min(1, distance / radius);
    if (deflection <= zone) return { x: 0, y: 0 };
    const length = (deflection - zone) / (1 - zone);
    return { x: (dx / distance) * length, y: (dy / distance) * length };
};

/** Strength 0..1 of each TOUCH_MOVE_ACTIONS action for a stick reading. */
export const joystickMoveValues = (vector: JoystickVector): Record<string, number> => ({
    [TOUCH_MOVE_ACTIONS.forward]: Math.max(0, -vector.y),
    [TOUCH_MOVE_ACTIONS.back]: Math.max(0, vector.y),
    [TOUCH_MOVE_ACTIONS.left]: Math.max(0, -vector.x),
    [TOUCH_MOVE_ACTIONS.right]: Math.max(0, vector.x),
});

const COARSE_POINTER = '(pointer: coarse)';

/** True on phones, tablets and touch screens: a coarse primary pointer or any touch points. */
export const isTouchDevice = (): boolean => {
    if (typeof window === 'undefined') return false;
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER).matches;
    return coarse || (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0);
};

const subscribeTouchDevice = (onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(COARSE_POINTER);
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }
    // Safari before 14 only has the older listener API.
    query.addListener(onChange);
    return () => query.removeListener(onChange);
};

const noTouchOnServer = () => false;

type PointerKind = 'mouse' | 'touch';

/** The kind of pointer the player used last; a mouse counts as soon as it moves, before it can click through the overlay. */
const useLastPointerKind = (watch: boolean): PointerKind | null => {
    const [kind, setKind] = useState<PointerKind | null>(null);
    useEffect(() => {
        if (!watch) return undefined;
        const onPointer = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') setKind('mouse');
            else if (event.type === 'pointerdown' && (event.pointerType === 'touch' || event.pointerType === 'pen')) setKind('touch');
        };
        window.addEventListener('pointerdown', onPointer, true);
        window.addEventListener('pointermove', onPointer, true);
        return () => {
            window.removeEventListener('pointerdown', onPointer, true);
            window.removeEventListener('pointermove', onPointer, true);
        };
    }, [watch]);
    return kind;
};

/** Routes the rest of a touch to the element even when the finger slides off it. Some pointers refuse capture; the control still works while the finger stays inside. */
const capturePointer = (element: Element, pointerId: number) => {
    try {
        element.setPointerCapture(pointerId);
    } catch {
        // The pointer is no longer active.
    }
};

interface DragStart {
    pointerId: number;
    x: number;
    y: number;
}

interface StickView {
    /** Stick centre relative to the joystick area. */
    x: number;
    y: number;
    /** Knob offset from the centre, clamped to JOYSTICK_RADIUS. */
    knobX: number;
    knobY: number;
    sprinting: boolean;
}

/** Left-thumb stick: appears where the touch lands in the lower-left area and drives the move actions. */
const Joystick: React.FC<{ input: InputState; label: string; sprintAction: string | null }> = ({ input, label, sprintAction }) => {
    const drag = useRef<DragStart | null>(null);
    const sprinting = useRef(false);
    const [stick, setStick] = useState<StickView | null>(null);

    const drive = (vector: JoystickVector, sprint: boolean) => {
        for (const [action, value] of Object.entries(joystickMoveValues(vector))) input.setVirtualAxis(action, value);
        if (sprintAction && sprint !== sprinting.current) input.setVirtualButton(sprintAction, sprint);
        sprinting.current = sprint;
    };

    // A stick that goes away mid-drag lets go of the move actions and Sprint.
    useEffect(() => () => {
        if (!drag.current) return;
        drag.current = null;
        for (const action of Object.values(TOUCH_MOVE_ACTIONS)) input.setVirtualAxis(action, 0);
        if (sprintAction && sprinting.current) input.setVirtualButton(sprintAction, false);
        sprinting.current = false;
    }, [input, sprintAction]);

    const release = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        drive({ x: 0, y: 0 }, false);
        setStick(null);
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current) return;
        event.preventDefault();
        capturePointer(event.currentTarget, event.pointerId);
        const area = event.currentTarget.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        setStick({ x: event.clientX - area.left, y: event.clientY - area.top, knobX: 0, knobY: 0, sprinting: false });
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const distance = Math.hypot(dx, dy);
        const sprint = sprintAction !== null && distance >= JOYSTICK_SPRINT_RATIO * JOYSTICK_RADIUS;
        drive(joystickVector(dx, dy, JOYSTICK_RADIUS), sprint);
        const scale = distance > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / distance : 1;
        setStick(view => view && { ...view, knobX: dx * scale, knobY: dy * scale, sprinting: sprint });
    };

    const size = JOYSTICK_RADIUS * 2;
    return (
        <div
            aria-label={label}
            className="pointer-events-auto absolute bottom-0 left-0 h-3/5 w-1/2 touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
        >
            <div
                className={`absolute rounded-full border-2 bg-white/10 transition-opacity ${stick?.sprinting ? 'border-white/70' : 'border-white/30'} ${stick ? 'opacity-90' : 'bottom-10 left-10 opacity-50'}`}
                style={stick ? { width: size, height: size, left: stick.x - JOYSTICK_RADIUS, top: stick.y - JOYSTICK_RADIUS } : { width: size, height: size }}
            >
                <div
                    className="absolute left-1/2 top-1/2 h-12 w-12 rounded-full bg-white/40 shadow-lg"
                    style={{ transform: `translate(calc(-50% + ${stick?.knobX ?? 0}px), calc(-50% + ${stick?.knobY ?? 0}px))` }}
                />
            </div>
        </div>
    );
};

/** Right-side drag area: finger movement feeds the camera look channel (InputState.addLookDelta). */
const LookArea: React.FC<{ input: InputState; label: string }> = ({ input, label }) => {
    const drag = useRef<DragStart | null>(null);

    const release = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current) return;
        event.preventDefault();
        capturePointer(event.currentTarget, event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const last = drag.current;
        if (!last || last.pointerId !== event.pointerId) return;
        input.addLookDelta(event.clientX - last.x, event.clientY - last.y);
        drag.current = { ...last, x: event.clientX, y: event.clientY };
    };

    return (
        <div
            aria-label={label}
            className="pointer-events-auto absolute inset-y-0 right-0 w-1/2 touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
        />
    );
};

/** Holds an action while a finger is on it, through pointer capture so sliding off does not drop or stick it. */
const TouchButton: React.FC<{ input: InputState; action: string; label: string; className: string; children?: React.ReactNode }> = ({ input, action, label, className, children }) => {
    const pointer = useRef<number | null>(null);
    const [pressed, setPressed] = useState(false);

    // A button that goes away (or changes action) mid-press releases what it held.
    useEffect(() => () => {
        if (pointer.current === null) return;
        pointer.current = null;
        input.setVirtualButton(action, false);
    }, [input, action]);

    const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (pointer.current !== null) return;
        event.preventDefault();
        capturePointer(event.currentTarget, event.pointerId);
        pointer.current = event.pointerId;
        input.setVirtualButton(action, true);
        setPressed(true);
    };

    const release = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        input.setVirtualButton(action, false);
        setPressed(false);
    };

    return (
        <button
            type="button"
            aria-label={label}
            className={`pointer-events-auto absolute flex touch-none items-center justify-center rounded-full border border-white/30 font-semibold leading-tight text-white/90 transition-colors ${pressed ? 'bg-white/40' : 'bg-white/15'} ${className}`}
            onPointerDown={onPointerDown}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
        >
            {children ?? label}
        </button>
    );
};

// Keeps the controls clear of notches and the home indicator when the page uses viewport-fit=cover.
const SAFE_AREA: React.CSSProperties = {
    top: 'env(safe-area-inset-top, 0px)',
    right: 'env(safe-area-inset-right, 0px)',
    bottom: 'env(safe-area-inset-bottom, 0px)',
    left: 'env(safe-area-inset-left, 0px)',
};

const preventContextMenu = (event: React.MouseEvent) => event.preventDefault();

const TouchOverlay: React.FC<{ input: InputState }> = ({ input }) => {
    const translate = useTranslation();
    // Hiding or removing the overlay lets go of everything it holds.
    useEffect(() => () => input.clearVirtual(), [input]);

    const actionLabel = (name: string) => translate(uiActionLabelKey(name), undefined, input.findAction(name)?.label ?? name);
    const hasMove = Object.values(TOUCH_MOVE_ACTIONS).some(name => input.hasAction(name));
    const sprintAction = input.hasAction(TOUCH_SPRINT_ACTION) ? TOUCH_SPRINT_ACTION : null;
    const buttons = TOUCH_BUTTONS.flatMap(spec => {
        const action = spec.actions.find(name => input.hasAction(name));
        return action ? [{ action, className: spec.className }] : [];
    });

    return (
        <div className="pointer-events-none absolute z-30 select-none [-webkit-touch-callout:none]" style={SAFE_AREA} onContextMenu={preventContextMenu}>
            <LookArea input={input} label={translate('ui.touch.look', undefined, 'Look')} />
            {hasMove && <Joystick input={input} label={translate('ui.touch.move', undefined, 'Move')} sprintAction={sprintAction} />}
            {buttons.map(({ action, className }) => (
                <TouchButton key={action} input={input} action={action} label={actionLabel(action)} className={className} />
            ))}
            {input.hasAction(TOUCH_PAUSE_ACTION) && (
                <TouchButton input={input} action={TOUCH_PAUSE_ACTION} label={actionLabel(TOUCH_PAUSE_ACTION)} className="right-4 top-4 h-11 w-11">
                    <Pause size={18} aria-hidden />
                </TouchButton>
            )}
        </div>
    );
};

interface TouchControlsProps {
    /** The runtime's live input; the overlay drives its virtual source. */
    input: InputState;
    /** true always shows the controls and false never does; left out, they show on touch devices until a mouse is used. */
    enabled?: boolean;
}

/**
 * On-screen controls for phones and tablets: a left joystick for the move actions (pushed far, it also holds Sprint),
 * a right-side look drag area, and buttons for Fire/Attack, Jump, Aim, Interact and Pause when the map has them.
 * Render it as HTML over the canvas (inside a positioned container), not inside the three Canvas. Unmounting releases its input.
 */
export const TouchControls: React.FC<TouchControlsProps> = ({ input, enabled }) => {
    const touchDevice = useSyncExternalStore(subscribeTouchDevice, isTouchDevice, noTouchOnServer);
    const pointerKind = useLastPointerKind(enabled === undefined && touchDevice);
    const visible = enabled ?? (touchDevice && pointerKind !== 'mouse');
    return visible ? <TouchOverlay input={input} /> : null;
};
