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

/** The player's ability attributes (see the Abilities component), as the HUD shows them. */
export interface PlayerAbilityState {
    /** Each attribute's current value. */
    values: Record<string, number>;
    /** Each attribute's upper bound (its maximum, or the attribute it is bound by). */
    max: Record<string, number>;
    /** Seconds of cooldown left on each ability, to a tenth. */
    cooldowns: Record<string, number>;
}

/** Live values the HUD and menus read while a level runs. */
export interface GameStateSnapshot {
    levelId: string | null;
    player: PlayerGameState;
    vars: Record<string, number | boolean | string>;
    abilities: PlayerAbilityState;
}

const NO_ABILITIES: PlayerAbilityState = { values: {}, max: {}, cooldowns: {} };

/** The player at the start of a session, before its stats and weapon report in. */
export const INITIAL_PLAYER_STATE: PlayerGameState = {
    health: 100, maxHealth: 100, stamina: 100, isAiming: false,
    weapon: '', ammo: 0, magazine: 0, reserve: -1, reloading: false,
};

const INITIAL: GameStateSnapshot = {
    levelId: null,
    player: INITIAL_PLAYER_STATE,
    vars: {},
    abilities: NO_ABILITIES,
};

const sameRecord = (a: Record<string, number>, b: Record<string, number>): boolean => {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
};

let snapshot: GameStateSnapshot = INITIAL;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(listener => listener());

export const gameState = {
    get: (): GameStateSnapshot => snapshot,
    /** Shallow-merges player and vars, replaces abilities; skips the update when nothing changed. */
    update(change: { levelId?: string | null; player?: Partial<GameStateSnapshot['player']>; vars?: GameStateSnapshot['vars']; abilities?: PlayerAbilityState | null }) {
        const player = change.player ? { ...snapshot.player, ...change.player } : snapshot.player;
        const vars = change.vars ? { ...snapshot.vars, ...change.vars } : snapshot.vars;
        const levelId = change.levelId === undefined ? snapshot.levelId : change.levelId;
        const abilities = change.abilities === undefined ? snapshot.abilities : change.abilities ?? NO_ABILITIES;
        const playerChanged = (Object.keys(player) as (keyof typeof player)[]).some(key => player[key] !== snapshot.player[key]);
        const varsChanged = Object.keys(vars).some(key => vars[key] !== snapshot.vars[key]);
        const abilitiesChanged = abilities !== snapshot.abilities && !(sameRecord(abilities.values, snapshot.abilities.values)
            && sameRecord(abilities.max, snapshot.abilities.max) && sameRecord(abilities.cooldowns, snapshot.abilities.cooldowns));
        if (!playerChanged && !varsChanged && !abilitiesChanged && levelId === snapshot.levelId) return;
        snapshot = { levelId, player, vars, abilities: abilitiesChanged ? abilities : snapshot.abilities };
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

/**
 * Reads a binding path: 'player.<field>' (health, maxHealth, stamina, isAiming, weapon, ammo, magazine,
 * reserve, reloading), 'level.id', 'vars.<name>', and the player's abilities: 'abilities.<attribute>',
 * 'abilityMax.<attribute>' and 'cooldowns.<ability>'.
 */
const ownValue = (record: object, key: string): unknown =>
    (Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, unknown>)[key] : undefined);

/** Only own number/boolean/string values resolve, so a path like vars.toString never reaches a prototype member. */
const bindingValue = (value: unknown): number | boolean | string | null =>
    (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? value : null);

export const readGameStateBinding = (state: GameStateSnapshot, path: string): number | boolean | string | null => {
    if (path === 'level.id') return state.levelId;
    if (path.startsWith('player.')) return bindingValue(ownValue(state.player, path.slice('player.'.length)));
    if (path.startsWith('vars.')) return bindingValue(ownValue(state.vars, path.slice('vars.'.length)));
    if (path.startsWith('abilities.')) return bindingValue(ownValue(state.abilities.values, path.slice('abilities.'.length)));
    if (path.startsWith('abilityMax.')) return bindingValue(ownValue(state.abilities.max, path.slice('abilityMax.'.length)));
    if (path.startsWith('cooldowns.')) return bindingValue(ownValue(state.abilities.cooldowns, path.slice('cooldowns.'.length)));
    return null;
};

export const useGameState = <T,>(selector: (state: GameStateSnapshot) => T): T =>
    useSyncExternalStore(gameState.subscribe, () => selector(gameState.get()), () => selector(gameState.get()));
