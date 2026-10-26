import { useSyncExternalStore } from 'react';
import { gameState } from './gameState';

export type LevelVariableValue = number | boolean | string;

/** Shape of a level blueprint variable (LevelBlueprintData.variables): 'Float', 'Boolean' or 'String'. */
export interface LevelVariableDefinition {
    name: string;
    type?: string;
    value?: unknown;
}

type VariableKind = 'number' | 'boolean' | 'string';

const kindOf = (type: string | undefined, value: unknown): VariableKind | null => {
    switch ((type ?? '').toLowerCase()) {
        case 'float': case 'integer': case 'int': case 'number': return 'number';
        case 'boolean': case 'bool': return 'boolean';
        case 'string': return 'string';
    }
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    return null;
};

/** Converts a value to the variable's kind; null when it cannot be represented. */
const coerce = (kind: VariableKind | null, value: unknown): LevelVariableValue | null => {
    if (kind === 'number') {
        const number = typeof value === 'boolean' ? (value ? 1 : 0)
            : typeof value === 'string' && value.trim() !== '' ? Number(value)
            : value;
        return typeof number === 'number' && Number.isFinite(number) ? number : null;
    }
    if (kind === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
        if (typeof value === 'string') return value === 'true' ? true : value === 'false' ? false : null;
        return null;
    }
    if (kind === 'string') return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return typeof value === 'boolean' || typeof value === 'string' ? value : null;
};

const defaultFor = (kind: VariableKind | null): LevelVariableValue => kind === 'boolean' ? false : kind === 'string' ? '' : 0;

/**
 * Observable level variables. reset() seeds them from the level blueprint; declared variables keep
 * their type on set(), undeclared names are created on first write. Every change is pushed to sync
 * (by default gameState vars) so HUD bindings 'vars.<name>' follow along.
 */
export const createLevelVariablesStore = (sync: (vars: Record<string, LevelVariableValue>) => void = vars => gameState.update({ vars })) => {
    let values: Readonly<Record<string, LevelVariableValue>> = {};
    let kinds: Record<string, VariableKind> = {};
    const listeners = new Set<() => void>();

    const commit = (next: Record<string, LevelVariableValue>, changed: Record<string, LevelVariableValue>) => {
        values = next;
        if (Object.keys(changed).length > 0) sync(changed);
        listeners.forEach(listener => listener());
    };

    return {
        get: (name: string): LevelVariableValue | undefined =>
            Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined,
        /** Current values; the object is replaced on every change so it is safe as a snapshot. */
        all: (): Readonly<Record<string, LevelVariableValue>> => values,
        /** Writes a variable; returns false when the value is invalid for its type. */
        set(name: string, value: unknown): boolean {
            const key = name.trim();
            if (!key) return false;
            const kind = kinds[key] ?? null;
            const next = coerce(kind, value);
            if (next === null) return false;
            if (!kind) kinds = { ...kinds, [key]: kindOf(undefined, next) ?? 'string' };
            if (values[key] === next && Object.prototype.hasOwnProperty.call(values, key)) return true;
            commit({ ...values, [key]: next }, { [key]: next });
            return true;
        },
        /** Replaces every variable with the level's declared initial values. */
        reset(variables: readonly LevelVariableDefinition[] | null | undefined = []) {
            const next: Record<string, LevelVariableValue> = {};
            const nextKinds: Record<string, VariableKind> = {};
            for (const variable of variables ?? []) {
                const key = typeof variable?.name === 'string' ? variable.name.trim() : '';
                if (!key) continue;
                const kind = kindOf(variable.type, variable.value);
                nextKinds[key] = kind ?? 'string';
                next[key] = coerce(kind, variable.value) ?? defaultFor(kind);
            }
            kinds = nextKinds;
            commit(next, next);
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
};

export type LevelVariablesStore = ReturnType<typeof createLevelVariablesStore>;

/** Shared store for the running level, mirrored into gameState vars.*. */
export const levelVariables = createLevelVariablesStore();

export const useLevelVariable = (name: string, store: LevelVariablesStore = levelVariables): LevelVariableValue | undefined =>
    useSyncExternalStore(store.subscribe, () => store.get(name), () => store.get(name));
