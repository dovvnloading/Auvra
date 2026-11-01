import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Variable } from 'lucide-react';
import type { LogicNode } from '../../types';
import { createLevelVariablesStore, type LevelVariableDefinition, type LevelVariableValue } from '../../runtime/levelVariables';
import { WORLD_NODE_DEFINITIONS } from '../../hooks/levelBlueprintNodes/world';

/** Declarable level variable types; runtime/levelVariables.ts seeds them as number, boolean and text. */
export const LEVEL_VARIABLE_TYPES = ['Float', 'Boolean', 'String'] as const;
export type LevelVariableType = typeof LEVEL_VARIABLE_TYPES[number];

/** A variable as the panel writes it: exactly the fields the project schema allows for blueprint variables. */
export interface LevelVariableDeclaration {
    id: string;
    name: string;
    type: LevelVariableType;
    value: LevelVariableValue;
}

/** A stored LevelBlueprintData.variables entry; older data may lack an id or spell the type differently. */
export type LevelVariableEntry = LevelVariableDefinition & { id?: string };

export type LevelVariableNodeType = 'GetLevelVariable' | 'SetLevelVariable';

/** What an edit did, so the editor can record it as one undo step and follow a rename. */
export type LevelVariableEdit =
    | { kind: 'add', index: number }
    | { kind: 'remove', index: number }
    | { kind: 'rename', index: number, from: string, to: string }
    | { kind: 'type', index: number }
    | { kind: 'value', index: number };

const DEFAULT_VALUES: Record<LevelVariableType, LevelVariableValue> = { Float: 0, Boolean: false, String: '' };

const newId = () => crypto.randomUUID();

const nameOf = (variable: LevelVariableEntry) => typeof variable.name === 'string' ? variable.name.trim() : '';

/** The type play start gives a variable: its type spelling first, then the kind of its stored value. */
export const levelVariableTypeOf = (variable: Pick<LevelVariableEntry, 'type' | 'value'>): LevelVariableType => {
    switch ((variable.type ?? '').toLowerCase()) {
        case 'float': case 'integer': case 'int': case 'number': return 'Float';
        case 'boolean': case 'bool': return 'Boolean';
        case 'string': return 'String';
    }
    if (typeof variable.value === 'number') return 'Float';
    if (typeof variable.value === 'boolean') return 'Boolean';
    return 'String';
};

// Play start seeds declared variables through levelVariables.reset; coercing through the same store
// means the default shown here is exactly the value the level starts with.
const seeding = createLevelVariablesStore(() => undefined);

/** Converts a value to the type, as play start would seed it (e.g. 1 -> true, 'abc' -> 0, true -> 'true'). */
export const coerceLevelVariableValue = (type: LevelVariableType, value: unknown): LevelVariableValue => {
    seeding.reset([{ name: 'value', type, value }]);
    return seeding.get('value') ?? DEFAULT_VALUES[type];
};

/** The default value a stored variable starts play with. */
export const levelVariableDefault = (variable: LevelVariableEntry): LevelVariableValue =>
    coerceLevelVariableValue(levelVariableTypeOf(variable), variable.value);

/** Why `name` cannot name the variable at `index` (-1 for a new one), or null when it can. */
export const levelVariableNameError = (name: string, variables: readonly LevelVariableEntry[], index = -1): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return 'Name cannot be blank.';
    if (variables.some((variable, i) => i !== index && nameOf(variable) === trimmed)) return `A variable named "${trimmed}" already exists.`;
    return null;
};

/** First free name of the form NewVar, NewVar1, NewVar2, ... */
export const nextLevelVariableName = (variables: readonly LevelVariableEntry[], base = 'NewVar'): string => {
    const taken = new Set(variables.map(nameOf));
    if (!taken.has(base)) return base;
    let suffix = 1;
    while (taken.has(`${base}${suffix}`)) suffix++;
    return `${base}${suffix}`;
};

/** The entry rewritten as a full declaration with `changes` applied; the value is coerced to the (new) type. */
const declare = (variable: LevelVariableEntry, changes: { name?: string, type?: LevelVariableType, value?: unknown }): LevelVariableDeclaration => {
    const type = changes.type ?? levelVariableTypeOf(variable);
    return {
        id: typeof variable.id === 'string' && variable.id ? variable.id : newId(),
        name: changes.name ?? nameOf(variable),
        type,
        value: coerceLevelVariableValue(type, 'value' in changes ? changes.value : levelVariableDefault(variable)),
    };
};

const replaceAt = (variables: readonly LevelVariableEntry[], index: number, next: LevelVariableEntry) =>
    variables.map((variable, i) => i === index ? next : variable);

/** Pure list edits. Each returns the new list, or null when the edit is refused or changes nothing. */
export const levelVariableEdits = {
    add(variables: readonly LevelVariableEntry[], type: LevelVariableType = 'Float'): LevelVariableEntry[] {
        return [...variables, { id: newId(), name: nextLevelVariableName(variables), type, value: DEFAULT_VALUES[type] }];
    },
    remove(variables: readonly LevelVariableEntry[], index: number): LevelVariableEntry[] | null {
        return index >= 0 && index < variables.length ? variables.filter((_, i) => i !== index) : null;
    },
    rename(variables: readonly LevelVariableEntry[], index: number, name: string): LevelVariableEntry[] | null {
        const variable = variables[index];
        if (!variable || levelVariableNameError(name, variables, index) || name.trim() === nameOf(variable)) return null;
        return replaceAt(variables, index, declare(variable, { name: name.trim() }));
    },
    setType(variables: readonly LevelVariableEntry[], index: number, type: LevelVariableType): LevelVariableEntry[] | null {
        const variable = variables[index];
        if (!variable || levelVariableTypeOf(variable) === type) return null;
        return replaceAt(variables, index, declare(variable, { type }));
    },
    setValue(variables: readonly LevelVariableEntry[], index: number, value: unknown): LevelVariableEntry[] | null {
        const variable = variables[index];
        if (!variable) return null;
        const next = declare(variable, { value });
        return next.value === levelVariableDefault(variable) ? null : replaceAt(variables, index, next);
    },
};

const LEVEL_VARIABLE_NODE_TITLES = new Map<string, string>(WORLD_NODE_DEFINITIONS
    .filter(definition => definition.type === 'GetLevelVariable' || definition.type === 'SetLevelVariable')
    .map(definition => [definition.type, definition.title]));

/**
 * Points Get/Set Level Variable nodes that name `from` at `to`, retitling nodes still named after the
 * variable ("Get Level Variable (from)"). Returns `nodes` itself when no node names `from`.
 */
export const renameLevelVariableReferences = (nodes: LogicNode[], from: string, to: string): LogicNode[] => {
    let changed = false;
    const next = nodes.map(node => {
        const title = LEVEL_VARIABLE_NODE_TITLES.get(node.type);
        const current = node.data?.default_Name;
        if (!title || typeof current !== 'string' || current.trim() !== from) return node;
        changed = true;
        return {
            ...node,
            name: node.name === `${title} (${from})` ? `${title} (${to})` : node.name,
            data: { ...node.data, default_Name: to },
        };
    });
    return changed ? next : nodes;
};

const INPUT_CLASS = 'min-w-0 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-2xs text-white focus:outline-none focus:border-sky-500';

/** Name input that only commits a valid, changed name (on blur or Enter); Escape restores the saved name. */
const NameField: React.FC<{
    name: string;
    errorFor: (draft: string) => string | null;
    onCommit: (name: string) => void;
    autoFocus?: boolean;
}> = ({ name, errorFor, onCommit, autoFocus }) => {
    const [draft, setDraft] = useState(name);
    useEffect(() => setDraft(name), [name]);
    const input = useRef<HTMLInputElement>(null);
    // A freshly added variable opens with its name selected, ready to type over.
    useEffect(() => { if (autoFocus) input.current?.select(); }, []);
    const error = draft.trim() === name.trim() ? null : errorFor(draft);
    const commit = () => {
        if (draft.trim() !== name.trim() && !errorFor(draft)) onCommit(draft.trim());
        else setDraft(name);
    };
    return (
        <div className="min-w-0 flex-1">
            <input
                ref={input}
                aria-label="Name"
                aria-invalid={error ? true : undefined}
                value={draft}
                autoFocus={autoFocus}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    else if (e.key === 'Escape') setDraft(name);
                }}
                className={`${INPUT_CLASS} w-full font-bold ${error ? 'border-amber-600 focus:border-amber-500' : ''}`}
            />
            {error && <div role="alert" className="mt-0.5 text-2xs leading-tight text-amber-300">{error}</div>}
        </div>
    );
};

/** Number input that keeps partial text ("-", "1.") while typing and only reports finite numbers. */
const NumberField: React.FC<{ value: number, onChange: (value: number) => void }> = ({ value, onChange }) => {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(current => current.trim() !== '' && Number(current) === value ? current : String(value)), [value]);
    return (
        <input
            type="number"
            step="any"
            aria-label="Default value"
            value={draft}
            onChange={(e) => {
                setDraft(e.target.value);
                const parsed = e.target.value.trim() === '' ? Number.NaN : Number(e.target.value);
                if (Number.isFinite(parsed) && parsed !== value) onChange(parsed);
            }}
            onBlur={() => setDraft(String(value))}
            className={`${INPUT_CLASS} flex-1`}
        />
    );
};

interface LevelVariablesPanelProps {
    /** The level blueprint's declared variables. */
    variables: readonly LevelVariableEntry[] | undefined;
    /** Called once per edit with the whole new list; the editor saves it as one undo step. */
    onChange: (variables: LevelVariableEntry[], edit: LevelVariableEdit) => void;
    /** Places a Get or Set Level Variable node for the variable. */
    onAddNode?: (type: LevelVariableNodeType, name: string) => void;
}

/**
 * Declared level variables: name, type and the default each play session starts with. Get/Set Level
 * Variable nodes read and write them by name, and HUD text binds to vars.<name>.
 */
export const LevelVariablesPanel: React.FC<LevelVariablesPanelProps> = ({ variables: stored, onChange, onAddNode }) => {
    const variables = stored ?? [];
    const [focusId, setFocusId] = useState<string | null>(null);

    const apply = (next: LevelVariableEntry[] | null, edit: LevelVariableEdit) => {
        if (next) onChange(next, edit);
    };

    const handleAdd = () => {
        const next = levelVariableEdits.add(variables);
        setFocusId(next[next.length - 1].id ?? null);
        apply(next, { kind: 'add', index: next.length - 1 });
    };

    return (
        <section aria-label="Level variables" className="border-b border-gray-800 flex flex-col max-h-[45%] shrink-0">
            <div className="px-4 py-2 bg-gray-950 border-b border-gray-800 flex items-center justify-between">
                <span className="text-xs font-bold text-gray-200 tracking-wider flex items-center gap-1.5">
                    <Variable size={12} className="text-sky-400" /> VARIABLES
                    {variables.length > 0 && <span className="text-2xs font-normal text-gray-500">({variables.length})</span>}
                </span>
                <button
                    onClick={handleAdd}
                    aria-label="Add variable"
                    title="Add a level variable"
                    className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
                >
                    <Plus size={14} />
                </button>
            </div>
            <div className="min-h-0 overflow-y-auto custom-scrollbar p-2">
                {variables.length === 0 ? (
                    <div className="px-1 text-2xs text-gray-500 leading-snug">
                        No level variables. Declared variables start every play session at their default; Get/Set Level Variable nodes use them by name and HUD text binds to vars.&lt;name&gt;.
                    </div>
                ) : (
                    <ul className="space-y-1.5">
                        {variables.map((variable, index) => {
                            const name = nameOf(variable);
                            const type = levelVariableTypeOf(variable);
                            const value = levelVariableDefault(variable);
                            const setValue = (next: unknown) => apply(levelVariableEdits.setValue(variables, index, next), { kind: 'value', index });
                            return (
                                // Index keys: editing an entry stored without an id gives it one, which must not remount the row mid-typing.
                                <li key={index} aria-label={name || `Variable ${index + 1}`} className="rounded border border-gray-800 bg-gray-800/40 p-1.5 space-y-1">
                                    <div className="flex items-start gap-1">
                                        <NameField
                                            name={name}
                                            autoFocus={focusId !== null && variable.id === focusId}
                                            errorFor={(draft) => levelVariableNameError(draft, variables, index)}
                                            onCommit={(to) => apply(levelVariableEdits.rename(variables, index, to), { kind: 'rename', index, from: name, to })}
                                        />
                                        <select
                                            aria-label="Type"
                                            value={type}
                                            onChange={(e) => apply(levelVariableEdits.setType(variables, index, e.target.value as LevelVariableType), { kind: 'type', index })}
                                            className={`${INPUT_CLASS} w-[4.5rem]`}
                                        >
                                            {LEVEL_VARIABLE_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
                                        </select>
                                        <button
                                            onClick={() => apply(levelVariableEdits.remove(variables, index), { kind: 'remove', index })}
                                            aria-label="Delete variable"
                                            title="Delete variable"
                                            className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-950/40 transition-colors"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <span className="text-2xs text-gray-500 w-10 shrink-0">Default</span>
                                        {type === 'Boolean' ? (
                                            <label className="flex-1 flex items-center gap-1.5 text-2xs text-gray-300">
                                                <input
                                                    type="checkbox"
                                                    aria-label="Default value"
                                                    checked={value === true}
                                                    onChange={(e) => setValue(e.target.checked)}
                                                    className="accent-sky-500"
                                                />
                                                {value === true ? 'True' : 'False'}
                                            </label>
                                        ) : type === 'Float' ? (
                                            <NumberField value={typeof value === 'number' ? value : 0} onChange={setValue} />
                                        ) : (
                                            <input
                                                type="text"
                                                aria-label="Default value"
                                                value={typeof value === 'string' ? value : String(value)}
                                                onChange={(e) => setValue(e.target.value)}
                                                placeholder="empty"
                                                className={`${INPUT_CLASS} flex-1`}
                                            />
                                        )}
                                        {onAddNode && name && (
                                            <div className="flex shrink-0 rounded border border-gray-700 overflow-hidden">
                                                <button onClick={() => onAddNode('GetLevelVariable', name)} title={`Add Get Level Variable (${name})`} className="px-1.5 py-1 hover:bg-gray-700 text-2xs text-gray-400 hover:text-white font-bold transition-colors">Get</button>
                                                <button onClick={() => onAddNode('SetLevelVariable', name)} title={`Add Set Level Variable (${name})`} className="px-1.5 py-1 border-l border-gray-700 hover:bg-gray-700 text-2xs text-gray-400 hover:text-white font-bold transition-colors">Set</button>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
};
