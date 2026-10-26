import { useSyncExternalStore } from 'react';

/** Live values the HUD and menus read while a level runs. */
export interface GameStateSnapshot {
    levelId: string | null;
    player: { health: number; maxHealth: number; stamina: number; isAiming: boolean };
    vars: Record<string, number | boolean | string>;
}

const INITIAL: GameStateSnapshot = {
    levelId: null,
    player: { health: 100, maxHealth: 100, stamina: 100, isAiming: false },
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

/** Reads a binding path: 'player.health', 'player.maxHealth', 'player.stamina', 'player.isAiming', 'level.id', 'vars.<name>'. */
export const readGameStateBinding = (state: GameStateSnapshot, path: string): number | boolean | string | null => {
    if (path === 'level.id') return state.levelId;
    if (path.startsWith('player.')) {
        const key = path.slice('player.'.length) as keyof GameStateSnapshot['player'];
        return key in state.player ? state.player[key] : null;
    }
    if (path.startsWith('vars.')) return state.vars[path.slice('vars.'.length)] ?? null;
    return null;
};

export const useGameState = <T,>(selector: (state: GameStateSnapshot) => T): T =>
    useSyncExternalStore(gameState.subscribe, () => selector(gameState.get()), () => selector(gameState.get()));
