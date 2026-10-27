import { useSyncExternalStore } from 'react';

/** The held weapon, as the HUD shows it: rounds in the magazine (`ammo`) and carried (`reserve`, -1 unlimited). */
export interface PlayerWeaponStatus {
    weapon: string;
    ammo: number;
    magazine: number;
    reserve: number;
    reloading: boolean;
}

export interface PlayerGameState extends PlayerWeaponStatus {
    health: number;
    maxHealth: number;
    stamina: number;
    isAiming: boolean;
}

/** Live values the HUD and menus read while a level runs. */
export interface GameStateSnapshot {
    levelId: string | null;
    player: PlayerGameState;
    vars: Record<string, number | boolean | string>;
}

/** The player at the start of a session, before its stats and weapon report in. */
export const INITIAL_PLAYER_STATE: PlayerGameState = {
    health: 100, maxHealth: 100, stamina: 100, isAiming: false,
    weapon: '', ammo: 0, magazine: 0, reserve: -1, reloading: false,
};

const INITIAL: GameStateSnapshot = {
    levelId: null,
    player: INITIAL_PLAYER_STATE,
    vars: {},
};

let snapshot: GameStateSnapshot = INITIAL;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(listener => listener());

export const gameState = {
    get: (): GameStateSnapshot => snapshot,
    /** Shallow-merges player and vars; skips the update when nothing changed. */
    update(change: { levelId?: string | null; player?: Partial<GameStateSnapshot['player']>; vars?: GameStateSnapshot['vars'] }) {
        const player = change.player ? { ...snapshot.player, ...change.player } : snapshot.player;
        const vars = change.vars ? { ...snapshot.vars, ...change.vars } : snapshot.vars;
        const levelId = change.levelId === undefined ? snapshot.levelId : change.levelId;
        const playerChanged = (Object.keys(player) as (keyof typeof player)[]).some(key => player[key] !== snapshot.player[key]);
        const varsChanged = Object.keys(vars).some(key => vars[key] !== snapshot.vars[key]);
        if (!playerChanged && !varsChanged && levelId === snapshot.levelId) return;
        snapshot = { levelId, player, vars };
        emit();
    },
    reset() {
        snapshot = INITIAL;
        emit();
    },
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
};

/** Reads a binding path: 'player.<field>' (health, maxHealth, stamina, isAiming, weapon, ammo, magazine, reserve, reloading), 'level.id', 'vars.<name>'. */
const ownValue = (record: object, key: string): unknown =>
    (Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, unknown>)[key] : undefined);

/** Only own number/boolean/string values resolve, so a path like vars.toString never reaches a prototype member. */
const bindingValue = (value: unknown): number | boolean | string | null =>
    (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? value : null);

export const readGameStateBinding = (state: GameStateSnapshot, path: string): number | boolean | string | null => {
    if (path === 'level.id') return state.levelId;
    if (path.startsWith('player.')) return bindingValue(ownValue(state.player, path.slice('player.'.length)));
    if (path.startsWith('vars.')) return bindingValue(ownValue(state.vars, path.slice('vars.'.length)));
    return null;
};

export const useGameState = <T,>(selector: (state: GameStateSnapshot) => T): T =>
    useSyncExternalStore(gameState.subscribe, () => selector(gameState.get()), () => selector(gameState.get()));
