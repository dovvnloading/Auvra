import { useSyncExternalStore } from 'react';
import { normalizeBusVolumes, type AudioBusVolumes } from './audioMixer';
import type { InputBinding } from './input';
import type { GameSettings } from './types';

/** Per-player choices saved on the player's machine, layered over the game's authored settings. */
export interface PlayerOptions {
    mouseSensitivity: number;
    invertY: boolean;
    volumes: AudioBusVolumes;
    /** Action name -> bindings that replace the defaults for that action. */
    bindings: Record<string, InputBinding[]>;
}

const KEY_ROOT = 'auvra.options';

export const defaultPlayerOptions = (settings: GameSettings): PlayerOptions => ({
    mouseSensitivity: settings.input.mouseSensitivity,
    invertY: settings.input.invertY,
    volumes: normalizeBusVolumes({ master: settings.audio.masterVolume }),
    bindings: {},
});

const isBinding = (value: unknown): value is InputBinding => {
    const binding = value as Partial<InputBinding> | null;
    if (!binding || typeof binding !== 'object') return false;
    switch (binding.device) {
        case 'keyboard': return typeof (binding as { code?: unknown }).code === 'string';
        case 'mouse':
        case 'gamepad': return Number.isInteger((binding as { button?: unknown }).button);
        case 'gamepadAxis': return Number.isInteger((binding as { axis?: unknown }).axis) && [1, -1].includes((binding as { direction?: number }).direction ?? 0);
        default: return false;
    }
};

export const normalizePlayerOptions = (value: unknown, defaults: PlayerOptions): PlayerOptions => {
    const stored = (value && typeof value === 'object' ? value : {}) as Partial<PlayerOptions>;
    const bindings: Record<string, InputBinding[]> = {};
    if (stored.bindings && typeof stored.bindings === 'object') {
        for (const [action, list] of Object.entries(stored.bindings)) {
            if (Array.isArray(list)) bindings[action] = list.filter(isBinding);
        }
    }
    const sensitivity = Number(stored.mouseSensitivity);
    return {
        mouseSensitivity: Number.isFinite(sensitivity) && sensitivity > 0 ? Math.min(0.02, sensitivity) : defaults.mouseSensitivity,
        invertY: typeof stored.invertY === 'boolean' ? stored.invertY : defaults.invertY,
        volumes: normalizeBusVolumes({ ...defaults.volumes, ...(stored.volumes ?? {}) }),
        bindings,
    };
};

const storageFor = (): Storage | null => {
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

/** Observable per-game options store; saves to localStorage and tolerates storage being unavailable. */
export const createPlayerOptionsStore = (gameId: string, defaults: PlayerOptions, storage: Storage | null = storageFor()) => {
    const key = `${KEY_ROOT}.${gameId}`;
    let current = defaults;
    try {
        const raw = storage?.getItem(key);
        if (raw) current = normalizePlayerOptions(JSON.parse(raw), defaults);
    } catch { current = defaults; }
    const listeners = new Set<() => void>();
    return {
        get: () => current,
        update(change: Partial<PlayerOptions>) {
            current = normalizePlayerOptions({ ...current, ...change }, defaults);
            try { storage?.setItem(key, JSON.stringify(current)); } catch { /* storage full or blocked: keep in memory */ }
            listeners.forEach(listener => listener());
        },
        reset() { this.update({ ...defaults, bindings: {} }); },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
};

export type PlayerOptionsStore = ReturnType<typeof createPlayerOptionsStore>;

export const usePlayerOptions = (store: PlayerOptionsStore): PlayerOptions =>
    useSyncExternalStore(store.subscribe, store.get, store.get);
