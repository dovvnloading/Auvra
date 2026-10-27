import { useSyncExternalStore } from 'react';

/**
 * In-app replacements for window.alert / confirm / prompt. The browser's own dialogs read
 * "127.0.0.1:3000 says" (or the packaged origin) in the desktop editor and block the page; these are
 * drawn by AppDialogHost in the editor's own style and resolve a promise instead.
 */

export interface AppDialogRequest {
    id: number;
    kind: 'alert' | 'confirm' | 'prompt';
    title: string;
    message?: string;
    /** prompt: the field's starting text. */
    defaultValue?: string;
    /** The accept button's label. */
    acceptLabel: string;
    /** confirm: the action destroys something, so the accept button is red. */
    danger?: boolean;
    resolve(value: string | boolean | null): void;
}

let queue: readonly AppDialogRequest[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const publish = (next: readonly AppDialogRequest[]) => {
    queue = next;
    listeners.forEach(listener => listener());
};

const open = <T extends string | boolean | null>(request: Omit<AppDialogRequest, 'id' | 'resolve'>): Promise<T> =>
    new Promise<T>((resolve) => {
        publish([...queue, { ...request, id: nextId++, resolve: value => resolve(value as T) }]);
    });

/** Answers the dialog `id` and shows the next one waiting, if any. */
export const settleAppDialog = (id: number, value: string | boolean | null): void => {
    const request = queue.find(item => item.id === id);
    if (!request) return;
    publish(queue.filter(item => item.id !== id));
    request.resolve(value);
};

/** Shows a message with an OK button. */
export const appAlert = (title: string, message?: string): Promise<null> =>
    open<null>({ kind: 'alert', title, message, acceptLabel: 'OK' });

/** Asks a yes/no question; resolves true when accepted. */
export const appConfirm = (title: string, options: { message?: string; acceptLabel?: string; danger?: boolean } = {}): Promise<boolean> =>
    open<boolean>({ kind: 'confirm', title, message: options.message, acceptLabel: options.acceptLabel ?? 'OK', danger: options.danger });

/** Asks for a line of text; resolves null when cancelled. */
export const appPrompt = (title: string, options: { message?: string; defaultValue?: string; acceptLabel?: string } = {}): Promise<string | null> =>
    open<string | null>({ kind: 'prompt', title, message: options.message, defaultValue: options.defaultValue ?? '', acceptLabel: options.acceptLabel ?? 'OK' });

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
const snapshot = () => queue;

/** The dialogs waiting to be answered, oldest first; the first is the one on screen. */
export const useAppDialogs = (): readonly AppDialogRequest[] => useSyncExternalStore(subscribe, snapshot, snapshot);
