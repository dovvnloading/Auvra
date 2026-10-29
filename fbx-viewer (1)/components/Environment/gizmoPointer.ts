/**
 * Whether the press now under way started on a transform gizmo. A gizmo hears the press on the
 * canvas before the scene's own handlers do, and those would otherwise take it, and the click
 * that ends the drag, for a click on whatever is behind the gizmo (the terrain selects itself
 * on press). Every press clears it first (a capture listener on the window), a gizmo marks the
 * presses it takes, and the World Editor's selection handlers leave a marked press alone.
 */

let owned = false;

if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', () => { owned = false; }, true);
}

export const gizmoPointer = {
    /** Called from a gizmo's mouse-down: this press, and the click it ends with, are the gizmo's. */
    take(): void {
        owned = true;
    },
    /** True from a press on a gizmo until the next press anywhere. */
    owns(): boolean {
        return owned;
    },
};
