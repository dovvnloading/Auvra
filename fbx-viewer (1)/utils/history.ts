import { useCallback, useEffect, useRef, useState } from 'react';

/** Bounded undo/redo stack of immutable snapshots. */
export interface History<T> {
    push(snapshot: T): void;
    undo(current: T): T | null;
    redo(current: T): T | null;
    clear(): void;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}

export const createHistory = <T,>(limit = 100): History<T> => {
    const past: T[] = [];
    const future: T[] = [];
    return {
        push(snapshot) {
            past.push(snapshot);
            if (past.length > limit) past.shift();
            future.length = 0;
        },
        undo(current) {
            const previous = past.pop();
            if (previous === undefined) return null;
            future.push(current);
            return previous;
        },
        redo(current) {
            const next = future.pop();
            if (next === undefined) return null;
            past.push(current);
            return next;
        },
        clear() {
            past.length = 0;
            future.length = 0;
        },
        get canUndo() { return past.length > 0; },
        get canRedo() { return future.length > 0; },
    };
};

/** True for text fields and other inputs, where editor shortcuts must leave keys alone. */
export const isEditableTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
};

/**
 * Undo/redo for an editor whose state is a single value.
 *
 * Call `record()` with the value BEFORE applying a change; `undo()`/`redo()` call `apply` with the
 * restored value. While `active` is true, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z are handled (outside text fields).
 * `resetKey` clears the history, e.g. when a different document is opened.
 */
export const useEditorHistory = <T,>({ value, apply, active, resetKey, limit }: {
    value: T;
    apply: (restored: T) => void;
    active: boolean;
    resetKey?: unknown;
    limit?: number;
}) => {
    const historyRef = useRef<History<T>>(createHistory<T>(limit));
    const valueRef = useRef(value);
    valueRef.current = value;
    const applyRef = useRef(apply);
    applyRef.current = apply;
    const [, setVersion] = useState(0);
    const bump = useCallback(() => setVersion(version => version + 1), []);

    useEffect(() => {
        historyRef.current.clear();
        bump();
    }, [resetKey, bump]);

    const record = useCallback((before: T = valueRef.current) => {
        historyRef.current.push(before);
        bump();
    }, [bump]);

    const undo = useCallback(() => {
        const restored = historyRef.current.undo(valueRef.current);
        if (restored !== null) { applyRef.current(restored); bump(); }
    }, [bump]);

    const redo = useCallback(() => {
        const restored = historyRef.current.redo(valueRef.current);
        if (restored !== null) { applyRef.current(restored); bump(); }
    }, [bump]);

    useEffect(() => {
        if (!active) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) return;
            const key = event.key.toLowerCase();
            if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
            else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [active, undo, redo]);

    return {
        record, undo, redo,
        canUndo: historyRef.current.canUndo,
        canRedo: historyRef.current.canRedo,
    };
};
