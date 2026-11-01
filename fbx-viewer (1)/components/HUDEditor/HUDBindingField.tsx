import React, { useId, useState } from 'react';
import { Link2, X } from 'lucide-react';

/** Game-state paths readGameStateBinding resolves (runtime/gameState.ts), besides 'vars.<name>'. */
export const HUD_BINDING_SOURCES: readonly { path: string; label: string }[] = [
    { path: 'player.health', label: 'Player health' },
    { path: 'player.maxHealth', label: 'Player max health' },
    { path: 'player.stamina', label: 'Player stamina' },
    { path: 'player.isAiming', label: 'Player is aiming' },
    { path: 'player.weapon', label: 'Held weapon' },
    { path: 'player.ammo', label: 'Ammo in magazine' },
    { path: 'player.magazine', label: 'Magazine size' },
    { path: 'player.reserve', label: 'Ammo in reserve' },
    { path: 'player.reloading', label: 'Player is reloading' },
    { path: 'level.id', label: 'Current level id' },
];

/** Level variables reach the game state as 'vars.<name>'. */
export const HUD_VARIABLE_BINDING_PREFIX = 'vars.';

/**
 * Sources the author names: a level variable, one of the player's ability attributes (its value or
 * its maximum) or an ability's cooldown, each a prefix and a name.
 */
export const HUD_NAMED_SOURCES: readonly { mode: string; prefix: string; label: string; field: string; placeholder: string }[] = [
    { mode: '__variable__', prefix: HUD_VARIABLE_BINDING_PREFIX, label: 'Game variable...', field: 'Variable name', placeholder: 'score' },
    { mode: '__attribute__', prefix: 'abilities.', label: 'Player attribute...', field: 'Attribute name', placeholder: 'mana' },
    { mode: '__attributeMax__', prefix: 'abilityMax.', label: 'Player attribute maximum...', field: 'Attribute name', placeholder: 'mana' },
    { mode: '__cooldown__', prefix: 'cooldowns.', label: 'Ability cooldown (s)...', field: 'Ability id', placeholder: 'fireball' },
];

/** Props that are never bound: code, the menu action, the binding map itself and string-table keys. */
const UNBINDABLE_PROPS = new Set(['code', 'action', 'bind', 'textKey', 'labelKey']);
// Names that would reach Object.prototype through a plain-object assignment.
const RESERVED_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

const NONE = '';
const UNKNOWN = '__unknown__';

const FIELD_CLASS = 'w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-blue-500';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** An element's `props.bind` as prop name -> binding path, skipping malformed entries. */
export const readHUDBindings = (bind: unknown): Record<string, string> => {
    const result: Record<string, string> = {};
    if (!isRecord(bind)) return result;
    for (const [prop, path] of Object.entries(bind)) {
        if (typeof path === 'string' && path && !RESERVED_PROPS.has(prop)) result[prop] = path;
    }
    return result;
};

/** The path `prop` is bound to, or null. Own entries only, so a prop named like an Object method is never "bound". */
export const hudBindingPath = (bind: unknown, prop: string): string | null => {
    const bindings = readHUDBindings(bind);
    return Object.prototype.hasOwnProperty.call(bindings, prop) ? bindings[prop] : null;
};

/** Props with `bind[prop]` set to `path`, or removed for null; an empty map drops `bind` entirely. */
export const withHUDBinding = (props: Record<string, unknown>, prop: string, path: string | null): Record<string, unknown> => {
    if (RESERVED_PROPS.has(prop)) return props;
    const bind = readHUDBindings(props.bind);
    if (path === null) delete bind[prop];
    else bind[prop] = path;
    const next = { ...props };
    if (Object.keys(bind).length > 0) next.bind = bind;
    else delete next.bind;
    return next;
};

/** The props a Bind field offers: the component's suggestions, else its scalar props. */
export const bindablePropsFor = (props: Record<string, unknown>, suggested: readonly string[] | undefined): string[] => {
    const candidates = suggested ?? Object.keys(props).filter(key => ['string', 'number', 'boolean'].includes(typeof props[key]));
    return candidates.filter(key => !UNBINDABLE_PROPS.has(key) && !RESERVED_PROPS.has(key));
};

interface HUDBindingFieldProps {
    /** The element's raw `props.bind`. */
    value: unknown;
    /** Props offered for binding, most useful first. Props already bound are always listed. */
    bindableProps: readonly string[];
    /**
     * Binds `prop` to a game-state path, or unbinds it for null. `typing` marks free-text
     * edits (a variable name) that coalesce into one undo step.
     */
    onChange: (prop: string, path: string | null, typing: boolean) => void;
}

/** Binds one of an element's props to a live game-state value the HUD shows while playing. */
export const HUDBindingField: React.FC<HUDBindingFieldProps> = ({ value, bindableProps, onChange }) => {
    const id = useId();
    const bindings = readHUDBindings(value);
    const isBound = (prop: string) => Object.prototype.hasOwnProperty.call(bindings, prop);
    const props = Array.from(new Set([...bindableProps, ...Object.keys(bindings)]));
    const [selectedProp, setSelectedProp] = useState(() => props.find(isBound) ?? props[0] ?? '');
    // A named source picked before a name is typed: the field stays open without writing its prefix.
    const [pending, setPending] = useState<string | null>(null);
    // The name as typed, so spaces survive while the stored path is trimmed.
    const [nameDraft, setNameDraft] = useState<string | null>(null);

    if (props.length === 0) return null;
    const prop = props.includes(selectedProp) ? selectedProp : props[0];
    const path = isBound(prop) ? bindings[prop] : '';
    const named = HUD_NAMED_SOURCES.find(source => path.startsWith(source.prefix))
        ?? (pending && !path ? HUD_NAMED_SOURCES.find(source => source.mode === pending) ?? null : null);
    const mode = named ? named.mode
        : !path ? NONE
        : HUD_BINDING_SOURCES.some(source => source.path === path) ? path
        : UNKNOWN;
    const storedName = named && path.startsWith(named.prefix) ? path.slice(named.prefix.length) : '';
    // A draft that no longer matches the stored name (undo, redo) gives way to the stored one.
    const shownName = nameDraft !== null && nameDraft.trim() === storedName ? nameDraft : storedName;
    const boundEntries = Object.entries(bindings);

    const write = (next: string | null, typing: boolean) => {
        if (next === (path || null)) return;
        onChange(prop, next, typing);
    };

    const handlePropChange = (next: string) => {
        setSelectedProp(next);
        setPending(null);
        setNameDraft(null);
    };

    const handleSourceChange = (next: string) => {
        if (next === mode || next === UNKNOWN) return;
        setNameDraft(null);
        if (HUD_NAMED_SOURCES.some(source => source.mode === next)) {
            setPending(next);
            // A different source no longer applies; the name decides the new one.
            if (path) write(null, false);
            return;
        }
        setPending(null);
        write(next === NONE ? null : next, false);
    };

    const handleNameChange = (raw: string) => {
        if (!named) return;
        setNameDraft(raw);
        setPending(named.mode);
        const name = raw.trim();
        write(name ? `${named.prefix}${name}` : null, true);
    };

    const handleClear = () => {
        setPending(null);
        setNameDraft(null);
        write(null, false);
    };

    return (
        <div className="space-y-2">
            <div className="text-2xs text-gray-500 font-bold flex items-center gap-1">
                <Link2 size={10} /> Bind
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                    <label htmlFor={`${id}-prop`} className="text-2xs text-gray-500 font-bold ">Prop</label>
                    <select id={`${id}-prop`} value={prop} onChange={(event) => handlePropChange(event.target.value)} className={FIELD_CLASS}>
                        {props.map(option => (
                            <option key={option} value={option}>{isBound(option) ? `${option} (bound)` : option}</option>
                        ))}
                    </select>
                </div>
                <div className="space-y-1">
                    <label htmlFor={`${id}-source`} className="text-2xs text-gray-500 font-bold ">Source</label>
                    <div className="flex items-center gap-1">
                        <select id={`${id}-source`} value={mode} onChange={(event) => handleSourceChange(event.target.value)} className={FIELD_CLASS}>
                            <option value={NONE}>Not bound</option>
                            {mode === UNKNOWN && <option value={UNKNOWN} disabled>Unknown ({path})</option>}
                            {HUD_BINDING_SOURCES.map(source => <option key={source.path} value={source.path}>{source.label}</option>)}
                            {HUD_NAMED_SOURCES.map(source => <option key={source.mode} value={source.mode}>{source.label}</option>)}
                        </select>
                        {(path || pending) && (
                            <button
                                type="button"
                                onClick={handleClear}
                                title="Clear binding"
                                aria-label="Clear binding"
                                className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-800 shrink-0"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
            {named && (
                <div className="space-y-1">
                    <label htmlFor={`${id}-variable`} className="text-2xs text-gray-500 font-bold ">{named.field}</label>
                    <div className="flex items-center rounded border border-gray-700 bg-gray-800 focus-within:border-blue-500">
                        <span className="pl-1.5 text-xs font-mono text-gray-500">{named.prefix}</span>
                        <input
                            id={`${id}-variable`}
                            type="text"
                            value={shownName}
                            placeholder={named.placeholder}
                            spellCheck={false}
                            onChange={(event) => handleNameChange(event.target.value)}
                            onBlur={() => setNameDraft(null)}
                            className="w-full bg-transparent p-1.5 pl-0.5 text-xs font-mono text-white focus:outline-none"
                        />
                    </div>
                </div>
            )}
            {boundEntries.length > 0 && (
                <ul className="space-y-0.5 text-2xs font-mono text-blue-300" aria-label="Bindings">
                    {boundEntries.map(([name, source]) => <li key={name}>{name} = {source}</li>)}
                </ul>
            )}
            <p className="text-2xs text-gray-500 leading-snug">
                While the game runs the prop shows this live value; the editor preview shows the authored one.
            </p>
        </div>
    );
};
