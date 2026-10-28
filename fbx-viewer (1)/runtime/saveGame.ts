import type { SaveGameData } from './types';

/** Slot used when the caller does not name one (checkpoints, quick save). */
export const DEFAULT_SAVE_SLOT = 'auto';

const KEY_ROOT = 'auvra.save';

export interface SaveGameSummary {
    slot: string;
    savedAt: string;
    levelId: string;
}

export interface SaveGameStore {
    /** Writes the save under its slot (default 'auto'). Returns false when the data is invalid or storage refuses it. */
    save(data: SaveGameData): boolean;
    /** Returns the validated save for the slot, or null when it is missing, corrupt or belongs to another game. */
    load(slot?: string): SaveGameData | null;
    /** Every valid save for this game, newest first. */
    list(): SaveGameSummary[];
    remove(slot?: string): boolean;
}

export const saveGameKey = (gameId: string, slot: string = DEFAULT_SAVE_SLOT) => `${KEY_ROOT}.${gameId}.${slot}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isVector3 = (value: unknown): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A saved weapon state: the held weapon's id and each weapon's ownership and rounds. */
const isSavedWeapons = (value: unknown): boolean =>
    isRecord(value) && typeof value.active === 'string' && Array.isArray(value.items) && value.items.length <= 64
    && value.items.every(item => isRecord(item) && isNonEmptyString(item.id) && typeof item.owned === 'boolean'
        && isFiniteNumber(item.loaded) && isFiniteNumber(item.reserve));

/** Structural check for a SaveGameData written by this store (optionally pinned to a game and slot). */
export function isSaveGameData(value: unknown, gameId?: string, slot?: string): value is SaveGameData {
    if (!isRecord(value) || value.schema !== 1) return false;
    if (!isNonEmptyString(value.gameId) || (gameId !== undefined && value.gameId !== gameId)) return false;
    if (!isNonEmptyString(value.slot) || (slot !== undefined && value.slot !== slot)) return false;
    if (typeof value.savedAt !== 'string' || !isNonEmptyString(value.levelId)) return false;
    const player = value.player;
    if (!isRecord(player) || !isVector3(player.position) || !isVector3(player.rotation)) return false;
    if (!isFiniteNumber(player.health) || !isFiniteNumber(player.stamina)) return false;
    if (player.weapons !== undefined && !isSavedWeapons(player.weapons)) return false;
    if (!Array.isArray(value.destroyedObjectIds) || !value.destroyedObjectIds.every(id => typeof id === 'string')) return false;
    if (!isRecord(value.variables)) return false;
    return Object.values(value.variables).every(entry =>
        typeof entry === 'boolean' || typeof entry === 'string' || isFiniteNumber(entry));
}

/** window.localStorage, or null where reading it throws (sandboxed frames, disabled storage, no window). */
function defaultStorage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

export function createSaveGameStore(gameId: string, storage: Storage | null = defaultStorage()): SaveGameStore {
    const prefix = `${KEY_ROOT}.${gameId}.`;

    const read = (slot: string): SaveGameData | null => {
        if (!storage || !isNonEmptyString(slot)) return null;
        try {
            const raw = storage.getItem(saveGameKey(gameId, slot));
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            return isSaveGameData(parsed, gameId, slot) ? parsed : null;
        } catch {
            return null;
        }
    };

    return {
        save(data) {
            if (!storage) return false;
            const slot = isNonEmptyString(data?.slot) ? data.slot : DEFAULT_SAVE_SLOT;
            const record = { ...data, slot };
            if (!isSaveGameData(record, gameId)) return false;
            try {
                storage.setItem(saveGameKey(gameId, slot), JSON.stringify(record));
                return true;
            } catch {
                return false;
            }
        },
        load(slot = DEFAULT_SAVE_SLOT) {
            return read(slot);
        },
        list() {
            if (!storage) return [];
            const slots: string[] = [];
            try {
                for (let index = 0; index < storage.length; index++) {
                    const key = storage.key(index);
                    if (key && key.startsWith(prefix) && key.length > prefix.length) slots.push(key.slice(prefix.length));
                }
            } catch {
                return [];
            }
            return slots
                .map(read)
                .filter((save): save is SaveGameData => save !== null)
                .map(({ slot, savedAt, levelId }) => ({ slot, savedAt, levelId }))
                .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        },
        remove(slot = DEFAULT_SAVE_SLOT) {
            if (!storage || !isNonEmptyString(slot)) return false;
            try {
                storage.removeItem(saveGameKey(gameId, slot));
                return true;
            } catch {
                return false;
            }
        },
    };
}
