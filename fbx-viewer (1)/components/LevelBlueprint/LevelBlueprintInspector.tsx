
import React, { useState } from 'react';
import { Settings2, MessageSquare, Box, Database, Trash2, Shield, Skull, Hash, Type, ToggleLeft, AlertTriangle, DoorOpen, Save, SlidersHorizontal, Link, Plus, Minus } from 'lucide-react';
import { LogicNode, LogicPin, LevelObject } from '../../types';
import { describeActor, isOverlapEvent, overlapEventName, overlapTargetData, overlapTargetWarning, resolveOverlapTarget, selectedOverlapActorId } from './overlapTargets';
import { findLogicNodeDefinition, LogicNodeDefinition } from './LogicNode';
import { sequenceThenPin } from '../../hooks/levelBlueprintNodes/flow';
import { PLAYER_ACTOR_ID } from '../../hooks/levelBlueprintNodes/world';
import { AUDIO_BUSES } from '../../runtime/audioMixer';
import { DEFAULT_INPUT_MAP } from '../../runtime/input';

interface LevelBlueprintInspectorProps {
    node: LogicNode;
    onUpdate: (updates: Partial<LogicNode>) => void;
    levelObjects: LevelObject[];
    /** Levels an Open Level node can travel to. */
    levels?: { id: string, name: string }[];
    globalVariables: { blueprintName: string, name: string, type: string, blueprintType: string }[];
    /** Prefabs a Spawn Prefab node can place. */
    prefabs?: { id: string, name: string }[];
    /** Audio assets a Play Sound node can play. */
    audioAssets?: { id: string, name: string }[];
    /** Declared level variables, offered as names for Get/Set Level Variable. */
    levelVariables?: { name: string, type: string }[];
    /** Clip names a Play Player Animation node can play; empty means unknown (no warning for other names). */
    animationClips?: string[];
    /** Bone names of the player character, offered as a Play Player Animation mask. */
    playerBones?: string[];
    /** Morph target names of an actor's model (PLAYER_ACTOR_ID: the player character), offered by Set Morph Target. */
    morphTargetsOf?: (actorId: string) => string[];
    /** Pins with a wire; a wired input ignores its default value. */
    connectedPinIds?: ReadonlySet<string>;
    onDelete: () => void;
}

const NO_CONNECTIONS: ReadonlySet<string> = new Set();

const FIELD_CLASS = 'w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-sky-500';

/** Number field text to a stored default: blank stays blank (runtime fallback), partial input stays text while typing. */
const parseNumberField = (raw: string, integer: boolean): number | string => {
    if (raw.trim() === '') return '';
    const parsed = integer ? parseInt(raw, 10) : parseFloat(raw);
    return Number.isNaN(parsed) ? raw : parsed;
};

const fieldText = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

/**
 * Set Level Variable value typed as text: an undeclared variable takes the type of its first value, so the
 * literals true/false store a Boolean and a plain number a Float. Partial input ('1.', '-') stays text while typing.
 */
const parseVariableLiteral =(raw: string): boolean | number | string => {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    const number = Number(trimmed);
    return trimmed !== '' && Number.isFinite(number) && String(number) === trimmed ? number : raw;
};

const declaredKind = (type: string | undefined): 'number' | 'boolean' | 'string' => {
    switch ((type ?? '').toLowerCase()) {
        case 'float': case 'integer': case 'int': case 'number': return 'number';
        case 'boolean': case 'bool': return 'boolean';
        default: return 'string';
    }
};

type PinFieldGroup = { kind: 'single', pin: LogicPin } | { kind: 'vector', label: string, pins: LogicPin[] };

/** Groups `<name> X/Y/Z` Float inputs into one vector row; other data inputs stay single. */
const groupDataInputs = (pins: LogicPin[]): PinFieldGroup[] => {
    const groups: PinFieldGroup[] = [];
    for (let i = 0; i < pins.length; i++) {
        const axes = pins.slice(i, i + 3);
        const prefix = axes[0].name.endsWith(' X') ? axes[0].name.slice(0, -2) : null;
        const isVector = prefix !== null && axes.length === 3
            && axes[1].name === `${prefix} Y` && axes[2].name === `${prefix} Z`
            && axes.every(pin => pin.dataType === 'Float');
        if (isVector) {
            groups.push({ kind: 'vector', label: prefix, pins: axes });
            i += 2;
        } else {
            groups.push({ kind: 'single', pin: pins[i] });
        }
    }
    return groups;
};

const Warning: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div role="alert" className="flex items-start gap-2 rounded border border-amber-700/60 bg-amber-950/40 p-2 text-[10px] text-amber-300">
        <AlertTriangle size={12} className="shrink-0 mt-px" />
        <span>{children}</span>
    </div>
);

// Select value for "type a name that is not declared"; it cannot collide with a variable name (names are trimmed).
const CUSTOM_VARIABLE = ' custom';

/** Name of a Get/Set Level Variable node: pick a declared level variable, or type any other name. */
const LevelVariableNameField: React.FC<{
    id: string;
    value: string;
    levelVariables: { name: string, type: string }[];
    onChange: (name: string) => void;
}> = ({ id, value, levelVariables, onChange }) => {
    const [custom, setCustom] = useState(false);
    const name = value.trim();
    const hasDeclared = levelVariables.length > 0;
    const declared = levelVariables.some(v => v.name === name);
    const typing = !hasDeclared || custom || (name !== '' && !declared);
    return (
        <>
            {hasDeclared && (
                <select
                    id={id}
                    value={typing ? CUSTOM_VARIABLE : name}
                    onChange={(e) => {
                        const picked = e.target.value;
                        setCustom(picked === CUSTOM_VARIABLE);
                        if (picked !== CUSTOM_VARIABLE) onChange(picked);
                    }}
                    className={FIELD_CLASS}
                >
                    <option value="" disabled>-- Select Variable --</option>
                    {levelVariables.map(v => <option key={v.name} value={v.name}>{v.name} ({v.type})</option>)}
                    <option value={CUSTOM_VARIABLE}>Other name...</option>
                </select>
            )}
            {typing && (
                <input
                    id={hasDeclared ? undefined : id}
                    aria-label={hasDeclared ? 'Other variable name' : undefined}
                    type="text"
                    value={value}
                    autoFocus={custom}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="variable name"
                    className={FIELD_CLASS}
                />
            )}
            {name === ''
                ? <Warning>No variable name; this node does nothing.</Warning>
                : !declared && <div className="text-[10px] text-gray-500">Not declared in the Variables panel: the variable is created by its first Set, typed by that value.</div>}
        </>
    );
};

interface RegistryNodeFieldsProps {
    node: LogicNode;
    definition: LogicNodeDefinition;
    onUpdate: (updates: Partial<LogicNode>) => void;
    levelObjects: LevelObject[];
    prefabs: { id: string, name: string }[];
    audioAssets: { id: string, name: string }[];
    levelVariables: { name: string, type: string }[];
    animationClips: string[];
    playerBones: string[];
    morphTargetsOf?: (actorId: string) => string[];
    connectedPinIds: ReadonlySet<string>;
}

/** Text field that suggests `options` (a datalist) but takes any name. */
const SuggestField: React.FC<{
    id: string;
    value: string;
    options: string[];
    placeholder: string;
    onChange: (value: string) => void;
}> = ({ id, value, options, placeholder, onChange }) => (
    <>
        <input id={id} type="text" list={`${id}-options`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={FIELD_CLASS} />
        <datalist id={`${id}-options`}>
            {options.map(option => <option key={option} value={option} />)}
        </datalist>
    </>
);

/**
 * Inspector fields for flow and world registry nodes: one field per unwired data input, editing its
 * `default_<pin>` value, with pickers for prefabs, sounds, buses, input actions, actors and level variables,
 * and suggestions for animation clips, mask bones and morph targets.
 */
const RegistryNodeFields: React.FC<RegistryNodeFieldsProps> = ({
    node, definition, onUpdate, levelObjects, prefabs, audioAssets, levelVariables, animationClips, playerBones, morphTargetsOf, connectedPinIds
}) => {
    const data: Record<string, unknown> = node.data || {};
    const keyOf = (pin: LogicPin) => `default_${pin.name}`;
    const fieldId = (pin: LogicPin) => `pin-default-${node.id}-${pin.id}`;
    const setDefault = (pin: LogicPin, value: unknown, name?: string) =>
        onUpdate(name === undefined
            ? { data: { ...data, [keyOf(pin)]: value } }
            : { name, data: { ...data, [keyOf(pin)]: value } });
    // Picking a target also names the node after it (like Open Level and overlap events), in the same update.
    const titled = (label: string | undefined) => label ? `${definition.title} (${label})` : definition.title;

    const dataInputs = node.inputs.filter(pin => pin.dataType !== 'Exec');
    const execOutputs = node.outputs.filter(pin => pin.dataType === 'Exec');

    const renderField = (pin: LogicPin): React.ReactNode => {
        const value = data[keyOf(pin)];
        const text = fieldText(value);

        if (node.type === 'SpawnPrefab' && pin.name === 'Prefab') {
            const missing = text !== '' && prefabs.length > 0 && !prefabs.some(p => p.id === text);
            return (
                <>
                    <select id={fieldId(pin)} value={text} onChange={(e) => setDefault(pin, e.target.value, titled(prefabs.find(p => p.id === e.target.value)?.name))} className={FIELD_CLASS}>
                        <option value="" disabled>-- Select Prefab --</option>
                        {missing && <option value={text} disabled>Missing prefab</option>}
                        {!missing && text !== '' && prefabs.length === 0 && <option value={text}>{text}</option>}
                        {prefabs.map(prefab => <option key={prefab.id} value={prefab.id}>{prefab.name}</option>)}
                    </select>
                    {prefabs.length === 0 && <div className="text-[10px] text-gray-500">No prefabs yet: create one from the World Editor's Prefabs panel.</div>}
                    {missing ? <Warning>Missing prefab: it was deleted.</Warning> : text === '' && <Warning>No prefab selected; this node spawns nothing.</Warning>}
                </>
            );
        }

        if (node.type === 'PlaySound' && pin.name === 'Sound') {
            const missing = text !== '' && audioAssets.length > 0 && !audioAssets.some(a => a.id === text);
            return (
                <>
                    <select id={fieldId(pin)} value={text} onChange={(e) => setDefault(pin, e.target.value, titled(audioAssets.find(a => a.id === e.target.value)?.name))} className={FIELD_CLASS}>
                        <option value="" disabled>-- Select Sound --</option>
                        {missing && <option value={text} disabled>Missing sound</option>}
                        {!missing && text !== '' && audioAssets.length === 0 && <option value={text}>{text}</option>}
                        {audioAssets.map(audio => <option key={audio.id} value={audio.id}>{audio.name}</option>)}
                    </select>
                    {missing ? <Warning>Missing sound: it was deleted.</Warning> : text === '' && <Warning>No sound selected; this node plays nothing.</Warning>}
                </>
            );
        }

        if (node.type === 'PlaySound' && pin.name === 'Bus') {
            return (
                <select id={fieldId(pin)} value={text || 'sfx'} onChange={(e) => setDefault(pin, e.target.value)} className={FIELD_CLASS}>
                    {AUDIO_BUSES.map(bus => <option key={bus} value={bus}>{bus}</option>)}
                </select>
            );
        }

        if (node.type === 'InputActionPressed' && pin.name === 'Action') {
            const known = DEFAULT_INPUT_MAP.some(action => action.name === text);
            return (
                <select
                    id={fieldId(pin)}
                    value={text}
                    onChange={(e) => setDefault(pin, e.target.value, titled(DEFAULT_INPUT_MAP.find(a => a.name === e.target.value)?.label))}
                    className={FIELD_CLASS}
                >
                    <option value="" disabled>-- Select Action --</option>
                    {!known && text !== '' && <option value={text}>{text} (custom)</option>}
                    {DEFAULT_INPUT_MAP.map(action => <option key={action.name} value={action.name}>{action.label} ({action.name})</option>)}
                </select>
            );
        }

        if ((node.type === 'GetLevelVariable' || node.type === 'SetLevelVariable') && pin.name === 'Name') {
            return (
                <LevelVariableNameField
                    key={node.id}
                    id={fieldId(pin)}
                    value={text}
                    levelVariables={levelVariables}
                    onChange={(name) => setDefault(pin, name, titled(name.trim() || undefined))}
                />
            );
        }

        if (node.type === 'SetLevelVariable' && pin.name === 'Value') {
            const variableName = fieldText(data.default_Name).trim();
            const declared = levelVariables.find(v => v.name === variableName);
            const kind = declared ? declaredKind(declared.type) : null;
            if (kind === 'boolean') {
                return (
                    <select id={fieldId(pin)} value={value === true || value === 'true' ? 'true' : 'false'} onChange={(e) => setDefault(pin, e.target.value === 'true')} className={FIELD_CLASS}>
                        <option value="true">True</option>
                        <option value="false">False</option>
                    </select>
                );
            }
            if (kind === 'number') {
                return (
                    <input
                        id={fieldId(pin)}
                        type="number"
                        step="0.1"
                        value={text}
                        onChange={(e) => setDefault(pin, parseNumberField(e.target.value, false))}
                        placeholder="unset"
                        className={FIELD_CLASS}
                    />
                );
            }
            // A declared String keeps the text as typed; an undeclared name is typed by the literal.
            return (
                <>
                    <input
                        id={fieldId(pin)}
                        type="text"
                        value={text}
                        onChange={(e) => setDefault(pin, kind === 'string' ? e.target.value : parseVariableLiteral(e.target.value))}
                        className={FIELD_CLASS}
                    />
                    {kind === null && (
                        <div className="text-[10px] text-gray-500">
                            {typeof value === 'boolean' ? 'Creates a Boolean variable.' : typeof value === 'number' ? 'Creates a Float variable.' : 'Creates a String variable: type true, false or a number for a Boolean or Float.'}
                        </div>
                    )}
                </>
            );
        }

        if (node.type === 'Print' && pin.name === 'Format') {
            return (
                <>
                    <textarea
                        id={fieldId(pin)}
                        value={text}
                        onChange={(e) => setDefault(pin, e.target.value)}
                        className="w-full h-20 bg-gray-950 border border-gray-700 rounded p-2 text-xs text-pink-300 focus:outline-none focus:border-pink-500 resize-none font-mono"
                    />
                    <div className="text-[10px] text-gray-500">{'{0}'}, {'{1}'} and {'{2}'} are replaced by Arg 0-2; {'{{'} and {'}}'} print braces.</div>
                </>
            );
        }

        if (node.type === 'PlayPlayerAnimation' && pin.name === 'Clip') {
            const clip = text.trim();
            return (
                <>
                    <SuggestField id={fieldId(pin)} value={text} options={animationClips} placeholder="clip name" onChange={(name) => setDefault(pin, name, titled(name.trim() || undefined))} />
                    {clip === ''
                        ? <Warning>No clip; this node plays nothing.</Warning>
                        : animationClips.length > 0 && !animationClips.includes(clip) && <Warning>No model in the project has a clip named "{clip}"; Played will be false.</Warning>}
                </>
            );
        }

        if (node.type === 'PlayPlayerAnimation' && pin.name === 'Mask Bone') {
            const bone = text.trim();
            return (
                <>
                    <SuggestField id={fieldId(pin)} value={text} options={playerBones} placeholder="full body" onChange={(name) => setDefault(pin, name)} />
                    <div className="text-[10px] text-gray-500">Empty plays the clip on the full body; a bone limits it to that bone and its children (e.g. Spine for an upper-body attack).</div>
                    {bone !== '' && playerBones.length > 0 && !playerBones.includes(bone) && <Warning>The player character has no bone named "{bone}".</Warning>}
                </>
            );
        }

        if (node.type === 'PlayPlayerAnimation' && pin.name === 'Rate') {
            return (
                <>
                    <input id={fieldId(pin)} type="number" step="0.1" value={text} onChange={(e) => setDefault(pin, parseNumberField(e.target.value, false))} placeholder="1" className={FIELD_CLASS} />
                    {typeof value === 'number' && value <= 0 && <Warning>Rate must be above 0; this node plays nothing.</Warning>}
                </>
            );
        }

        if (node.type === 'SetMorphTarget' && pin.name === 'Morph') {
            // Suggestions come from the picked actor's model; a wired Actor is only known in play.
            const actorPin = node.inputs.find(p => p.name === 'Actor' && p.dataType === 'Object');
            const actorId = actorPin && !connectedPinIds.has(actorPin.id) ? fieldText(data[keyOf(actorPin)]).trim() : '';
            const morphs = actorId && morphTargetsOf ? morphTargetsOf(actorId) : null;
            const morph = text.trim();
            return (
                <>
                    <SuggestField id={fieldId(pin)} value={text} options={morphs ?? []} placeholder="morph target name" onChange={(name) => setDefault(pin, name)} />
                    {morph === ''
                        ? <Warning>No morph target; this node changes nothing.</Warning>
                        : morphs && morphs.length > 0 && !morphs.includes(morph) && <Warning>This actor's model has no morph target named "{morph}".</Warning>}
                    {morphs && morphs.length === 0 && <div className="text-[10px] text-gray-500">This actor's model has no morph targets.</div>}
                </>
            );
        }

        if (node.type === 'SetMorphTarget' && pin.name === 'Weight') {
            return (
                <>
                    <input id={fieldId(pin)} type="number" min="0" max="1" step="0.05" value={text} onChange={(e) => setDefault(pin, parseNumberField(e.target.value, false))} placeholder="unset" className={FIELD_CLASS} />
                    <div className="text-[10px] text-gray-500">0 is off, 1 is the full shape; other values are clamped.</div>
                </>
            );
        }

        if (pin.dataType === 'Object') {
            // Set Morph Target can also reach the player character, which is not a level actor.
            const offersPlayer = node.type === 'SetMorphTarget';
            const isPlayer = offersPlayer && text === PLAYER_ACTOR_ID;
            const missing = text !== '' && !isPlayer && !levelObjects.some(obj => obj.id === text);
            const actorName = (id: string) => offersPlayer && id === PLAYER_ACTOR_ID ? 'Player' : levelObjects.find(obj => obj.id === id)?.name;
            return (
                <>
                    <select
                        id={fieldId(pin)}
                        value={text}
                        onChange={(e) => setDefault(pin, e.target.value, titled(actorName(e.target.value)))}
                        className={FIELD_CLASS}
                    >
                        <option value="">-- None --</option>
                        {offersPlayer && <option value={PLAYER_ACTOR_ID}>Player character</option>}
                        {missing && <option value={text} disabled>Missing actor</option>}
                        {levelObjects.map(obj => <option key={obj.id} value={obj.id}>{describeActor(obj)}</option>)}
                    </select>
                    {missing && <Warning>Missing actor: it was deleted.</Warning>}
                    {offersPlayer && text === '' && <Warning>No actor; this node changes nothing.</Warning>}
                </>
            );
        }

        if (pin.dataType === 'Boolean') {
            return (
                <select id={fieldId(pin)} value={value ? 'true' : 'false'} onChange={(e) => setDefault(pin, e.target.value === 'true')} className={FIELD_CLASS}>
                    <option value="true">True</option>
                    <option value="false">False</option>
                </select>
            );
        }

        if (pin.dataType === 'Float' || pin.dataType === 'Integer') {
            const integer = pin.dataType === 'Integer';
            return (
                <input
                    id={fieldId(pin)}
                    type="number"
                    step={integer ? '1' : '0.1'}
                    value={text}
                    onChange={(e) => setDefault(pin, parseNumberField(e.target.value, integer))}
                    placeholder="unset"
                    className={FIELD_CLASS}
                />
            );
        }

        return (
            <input id={fieldId(pin)} type="text" value={text} onChange={(e) => setDefault(pin, e.target.value)} className={FIELD_CLASS} />
        );
    };

    const connectedBadge = (
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-500"><Link size={10} /> Connected</span>
    );

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sky-400 text-xs font-bold">
                <SlidersHorizontal size={14} /> {definition.title}
            </div>
            {definition.description && <div className="text-[10px] text-gray-400 leading-snug">{definition.description}</div>}

            {node.type === 'Sequence' && (
                <div className="space-y-1">
                    <label className="text-[10px] text-gray-400">Outputs ({execOutputs.length})</label>
                    <div className="flex gap-2">
                        <button
                            onClick={() => onUpdate({ outputs: [...node.outputs, { id: crypto.randomUUID(), ...sequenceThenPin(execOutputs.length) }] })}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-[10px] text-gray-300"
                        >
                            <Plus size={10} /> Add pin
                        </button>
                        <button
                            onClick={() => {
                                const last = execOutputs[execOutputs.length - 1];
                                if (last) onUpdate({ outputs: node.outputs.filter(pin => pin.id !== last.id) });
                            }}
                            disabled={execOutputs.length <= 1}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-[10px] text-gray-300 disabled:opacity-40 disabled:hover:bg-gray-800"
                        >
                            <Minus size={10} /> Remove pin
                        </button>
                    </div>
                </div>
            )}

            {groupDataInputs(dataInputs).map(group => {
                if (group.kind === 'single') {
                    const { pin } = group;
                    return (
                        <div key={pin.id} className="space-y-1">
                            <label htmlFor={fieldId(pin)} className="text-[10px] text-gray-400 flex items-center justify-between">
                                <span>{pin.name}</span>
                                {connectedPinIds.has(pin.id) && connectedBadge}
                            </label>
                            {!connectedPinIds.has(pin.id) && renderField(pin)}
                        </div>
                    );
                }
                return (
                    <div key={group.pins[0].id} className="space-y-1">
                        <div className="text-[10px] text-gray-400">{group.label}</div>
                        <div className="grid grid-cols-3 gap-1">
                            {group.pins.map(pin => {
                                const axis = pin.name.slice(-1);
                                return (
                                    <div key={pin.id} className="space-y-0.5">
                                        <label htmlFor={fieldId(pin)} className="text-[9px] text-gray-500 flex items-center gap-1">
                                            {axis} {connectedPinIds.has(pin.id) && <Link size={8} aria-label="Connected" />}
                                        </label>
                                        {connectedPinIds.has(pin.id) ? (
                                            <div className="p-2 text-[10px] text-gray-500 bg-gray-900 border border-gray-800 rounded">wired</div>
                                        ) : (
                                            <input
                                                id={fieldId(pin)}
                                                aria-label={pin.name}
                                                type="number"
                                                step="0.1"
                                                value={fieldText(data[keyOf(pin)])}
                                                onChange={(e) => setDefault(pin, parseNumberField(e.target.value, false))}
                                                placeholder={node.type === 'SetActorTransform' ? 'keep' : '0'}
                                                className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export const LevelBlueprintInspector: React.FC<LevelBlueprintInspectorProps> = ({
    node,
    onUpdate,
    levelObjects,
    levels = [],
    globalVariables,
    prefabs = [],
    audioAssets = [],
    levelVariables = [],
    animationClips = [],
    playerBones = [],
    morphTargetsOf,
    connectedPinIds = NO_CONNECTIONS,
    onDelete
}) => {
    const definition = findLogicNodeDefinition(node.type);
    
    // Helper to shallow merge into the 'data' object of the node
    const updateData = (key: string, value: any) => {
        onUpdate({
            data: {
                ...(node.data || {}),
                [key]: value
            }
        });
    };

    const overlapTarget = isOverlapEvent(node) ? resolveOverlapTarget(node, levelObjects) : null;
    const overlapWarning = overlapTarget ? overlapTargetWarning(overlapTarget) : null;

    const levelAction = node.type === 'LevelAction' ? node.data?.action : undefined;
    const openLevelId = typeof node.data?.levelId === 'string' ? node.data.levelId : '';
    const openLevelMissing = levelAction === 'OpenLevel' && openLevelId !== '' && !levels.some(level => level.id === openLevelId);

    return (
        <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 shadow-xl z-20 animate-in slide-in-from-right-10 duration-200 h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-800 bg-gray-950 flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-400">
                    <Settings2 size={16} />
                </div>
                <div>
                    <h2 className="text-xs font-bold text-gray-200 uppercase tracking-wider">Node Details</h2>
                    <div className="text-[10px] text-gray-500">{node.type}</div>
                </div>
            </div>

            {/* Properties List */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
                
                {/* Common: Node Name */}
                <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Node Name</label>
                    <input 
                        value={node.name}
                        onChange={(e) => onUpdate({ name: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-colors"
                    />
                </div>

                <div className="h-px bg-gray-800 w-full" />

                {/* Specific: Literal Values (Float, Int, String, Bool) */}
                {node.type.startsWith('Literal') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-green-400 text-xs font-bold">
                             {node.type === 'LiteralString' ? <Type size={14} /> : 
                              node.type === 'LiteralBoolean' ? <ToggleLeft size={14} /> : 
                              <Hash size={14} />} 
                             <span>Constant Value</span>
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">
                                {node.type.replace('Literal', '')} Value
                            </label>
                            {node.type === 'LiteralBoolean' ? (
                                <select
                                    value={node.data?.value ? 'true' : 'false'}
                                    onChange={(e) => updateData('value', e.target.value === 'true')}
                                    className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-green-500"
                                >
                                    <option value="true">True</option>
                                    <option value="false">False</option>
                                </select>
                            ) : (
                                <input
                                    type={node.type === 'LiteralString' ? 'text' : 'number'}
                                    step={node.type === 'LiteralFloat' ? '0.1' : '1'}
                                    value={node.data?.value ?? ''}
                                    onChange={(e) => {
                                        let val: any = e.target.value;
                                        if (node.type !== 'LiteralString') {
                                            const parsed = parseFloat(val);
                                            // Allow empty string or partial number inputs while typing
                                            val = isNaN(parsed) ? val : parsed; 
                                        }
                                        updateData('value', val);
                                    }}
                                    className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-green-500"
                                />
                            )}
                        </div>
                    </div>
                )}

                {/* Specific: Print String */}
                {node.type === 'PrintString' && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-pink-400 text-xs font-bold">
                            <MessageSquare size={14} /> Message Configuration
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Text to Print</label>
                            <textarea 
                                value={node.data?.printMessage || ''}
                                onChange={(e) => {
                                    // Update both printMessage (legacy/visual) and default_String (pin default)
                                    onUpdate({
                                        data: {
                                            ...(node.data || {}),
                                            printMessage: e.target.value,
                                            default_String: e.target.value
                                        }
                                    });
                                }}
                                className="w-full h-24 bg-gray-950 border border-gray-700 rounded p-2 text-xs text-pink-300 focus:outline-none focus:border-pink-500 resize-none font-mono"
                                placeholder="Enter message..."
                            />
                        </div>
                    </div>
                )}

                {/* Specific: Event (Animation Notify) */}
                {node.type === 'SetActiveCamera' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Camera</label>
                        <select
                            value={typeof node.data?.cameraId === 'string' ? node.data.cameraId : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), cameraId: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-pink-500"
                        >
                            <option value="">Gameplay camera</option>
                            {levelObjects.filter(object => object.components?.some(component => component.type === 'camera')).map(object => (
                                <option key={object.id} value={object.id}>{object.name || object.id}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-500">Switches the view to an object with a Camera component, or back to the gameplay camera, blending over Blend seconds.</p>
                    </div>
                )}

                {node.type === 'StartDialogue' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Speaker</label>
                        <select
                            value={typeof node.data?.targetObjectId === 'string' ? node.data.targetObjectId : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), targetObjectId: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-sky-500"
                        >
                            <option value="">Choose an object</option>
                            {levelObjects.filter(object => object.components?.some(component => component.type === 'dialogue')).map(object => (
                                <option key={object.id} value={object.id}>{object.name || object.id}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-500">Opens the conversation on an object with a Dialogue component, wherever the player is. Does nothing while another conversation is open.</p>
                    </div>
                )}

                {node.type === 'Event' && node.name === 'Event DialogueEvent' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Event name (empty: any dialogue event)</label>
                        <input
                            value={typeof node.data?.eventName === 'string' ? node.data.eventName : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), eventName: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                            placeholder="e.g. AcceptedQuest"
                        />
                        <p className="text-[10px] text-gray-500">Runs when a dialogue line or choice that raises this event is shown or chosen.</p>
                    </div>
                )}

                {node.type === 'Event' && (node.name === 'Event VehicleEntered' || node.name === 'Event VehicleExited') && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Vehicle</label>
                        <select
                            aria-label="Event vehicle"
                            value={typeof node.data?.vehicleId === 'string' ? node.data.vehicleId : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), vehicleId: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                        >
                            <option value="">Any vehicle</option>
                            {levelObjects.filter(obj => (obj.components ?? []).some(c => c.type === 'vehicle')).map(obj => (
                                <option key={obj.id} value={obj.id}>{obj.name}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-500">Runs when the player gets {node.name === 'Event VehicleEntered' ? 'into' : 'out of'} this vehicle (or any). Vehicle is the one they {node.name === 'Event VehicleEntered' ? 'got into' : 'left'}.</p>
                    </div>
                )}

                {node.type === 'Event' && node.name === 'Event ObjectBroken' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Object</label>
                        <select
                            aria-label="Event object"
                            value={typeof node.data?.actorId === 'string' ? node.data.actorId : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), actorId: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                        >
                            <option value="">Any object</option>
                            {levelObjects.filter(obj => (obj.components ?? []).some(c => c.type === 'destructible')).map(obj => (
                                <option key={obj.id} value={obj.id}>{obj.name}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-500">Runs when this object (or any with a Destructible component) breaks. Actor is the one that broke.</p>
                    </div>
                )}

                {node.type === 'Event' && (node.name === 'Event AbilityUsed' || node.name === 'Event ActorDied') && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Actor</label>
                        <select
                            aria-label="Event actor"
                            value={typeof node.data?.actorId === 'string' ? node.data.actorId : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), actorId: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                        >
                            <option value="">Any actor</option>
                            <option value="player">The player</option>
                            {levelObjects.filter(obj => (obj.components ?? []).some(c => c.type === 'abilities' && c.props?.owner !== 'player')).map(obj => (
                                <option key={obj.id} value={obj.id}>{obj.name}</option>
                            ))}
                        </select>
                        {node.name === 'Event AbilityUsed' && (
                            <>
                                <label className="text-[10px] text-gray-400">Ability id (empty: any ability)</label>
                                <input
                                    aria-label="Event ability"
                                    value={typeof node.data?.abilityId === 'string' ? node.data.abilityId : ''}
                                    onChange={(e) => onUpdate({ data: { ...(node.data || {}), abilityId: e.target.value } })}
                                    className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                                />
                            </>
                        )}
                        <p className="text-[10px] text-gray-500">{node.name === 'Event AbilityUsed'
                            ? 'Runs when this actor (or any) uses this ability (or any). Actor is the user, Ability its id, Target what it was used on (none for an ability without one).'
                            : 'Runs when this actor (or any with an Abilities component) loses all its health. Actor is the one that died.'}</p>
                    </div>
                )}

                {node.type === 'Event' && node.name === 'Event NetworkEvent' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Event name (empty: any network event)</label>
                        <input
                            value={typeof node.data?.eventName === 'string' ? node.data.eventName : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), eventName: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                            placeholder="e.g. DoorOpened"
                        />
                        <p className="text-[10px] text-gray-500">Runs when another player sends this event. Value is what they sent, as text; From is their player id.</p>
                    </div>
                )}

                {node.type === 'Event' && node.name === 'Event TimelineEvent' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Event name (empty: any timeline event)</label>
                        <input
                            value={typeof node.data?.eventName === 'string' ? node.data.eventName : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), eventName: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                            placeholder="e.g. DoorOpened"
                        />
                    </div>
                )}

                {node.type === 'Event' && node.name === 'Event AnimNotify' && (
                    <div className="space-y-1">
                        <label className="text-[10px] text-gray-400">Notify name (empty: any notify)</label>
                        <input
                            value={typeof node.data?.notifyName === 'string' ? node.data.notifyName : ''}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), notifyName: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                            placeholder="e.g. Footstep"
                        />
                        <label className="text-[10px] text-gray-400">Raised by</label>
                        <select
                            value={node.data?.notifySource === 'enemies' ? 'enemies' : node.data?.notifySource === 'any' ? 'any' : 'player'}
                            onChange={(e) => onUpdate({ data: { ...(node.data || {}), notifySource: e.target.value } })}
                            className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                        >
                            <option value="player">Player</option>
                            <option value="enemies">Enemies</option>
                            <option value="any">Anyone</option>
                        </select>
                    </div>
                )}

                {/* Specific: Event (Overlap) */}
                {overlapTarget && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-red-400 text-xs font-bold">
                            <Box size={14} /> Trigger Settings
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Target Actor</label>
                            <select
                                value={selectedOverlapActorId(overlapTarget)}
                                onChange={(e) => {
                                    const actor = levelObjects.find(obj => obj.id === e.target.value);
                                    // One update: name and data together, so neither overwrites the other.
                                    if (actor) onUpdate({ name: overlapEventName(actor), data: overlapTargetData(node.data, actor) });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-red-500"
                            >
                                <option value="" disabled>-- Select Actor --</option>
                                {overlapTarget.kind === 'missing' && (
                                    <option value={overlapTarget.actorId} disabled>Missing actor</option>
                                )}
                                {levelObjects.map(obj => (
                                    <option key={obj.id} value={obj.id}>{describeActor(obj)}</option>
                                ))}
                            </select>
                            {(overlapTarget.kind === 'linked' || overlapTarget.kind === 'legacy-unique') && (
                                <div className="text-[10px] text-gray-500">Current name: {overlapTarget.actor.name}</div>
                            )}
                        </div>
                        {overlapWarning && (
                            <div role="alert" className="flex items-start gap-2 rounded border border-amber-700/60 bg-amber-950/40 p-2 text-[10px] text-amber-300">
                                <AlertTriangle size={12} className="shrink-0 mt-px" />
                                <span>{overlapWarning}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Specific: Open Level */}
                {levelAction === 'OpenLevel' && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold">
                            <DoorOpen size={14} /> Level Travel
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Target Level</label>
                            <select
                                value={openLevelId}
                                onChange={(e) => {
                                    const level = levels.find(l => l.id === e.target.value);
                                    // One update: name and data together, so neither overwrites the other.
                                    if (level) onUpdate({ name: `Open Level (${level.name})`, data: { ...(node.data || {}), levelId: level.id } });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            >
                                <option value="" disabled>-- Select Level --</option>
                                {openLevelMissing && (
                                    <option value={openLevelId} disabled>Missing level</option>
                                )}
                                {levels.map(level => (
                                    <option key={level.id} value={level.id}>{level.name}</option>
                                ))}
                            </select>
                        </div>
                        {(openLevelMissing || !openLevelId) && (
                            <div role="alert" className="flex items-start gap-2 rounded border border-amber-700/60 bg-amber-950/40 p-2 text-[10px] text-amber-300">
                                <AlertTriangle size={12} className="shrink-0 mt-px" />
                                <span>{openLevelMissing ? 'Missing level: it was deleted.' : 'No level selected; this node does nothing.'}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Specific: Save / Load Game */}
                {(levelAction === 'SaveGame' || levelAction === 'LoadGame') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold">
                            <Save size={14} /> Save Slot
                        </div>
                        <div className="space-y-1">
                            <label htmlFor={`save-slot-${node.id}`} className="text-[10px] text-gray-400">Slot (blank for default)</label>
                            <input
                                id={`save-slot-${node.id}`}
                                type="text"
                                value={typeof node.data?.slot === 'string' ? node.data.slot : ''}
                                onChange={(e) => updateData('slot', e.target.value)}
                                placeholder="default"
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            />
                        </div>
                    </div>
                )}

                {/* Specific: Variable Get/Set */}
                {(node.type === 'VariableGet' || node.type === 'VariableSet') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold">
                            <Database size={14} /> Target Variable
                        </div>
                        
                        {/* Target Scope Switcher */}
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Target Entity</label>
                            <div className="flex bg-gray-800 p-1 rounded border border-gray-700">
                                <button
                                    onClick={() => updateData('targetBlueprintType', 'Player')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] transition-all ${node.data?.targetBlueprintType !== 'Enemy' ? 'bg-blue-900 text-blue-200 font-bold' : 'text-gray-500 hover:text-white'}`}
                                >
                                    <Shield size={10} /> Player
                                </button>
                                <button
                                    onClick={() => updateData('targetBlueprintType', 'Enemy')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] transition-all ${node.data?.targetBlueprintType === 'Enemy' ? 'bg-red-900 text-red-200 font-bold' : 'text-gray-500 hover:text-white'}`}
                                >
                                    <Skull size={10} /> Enemy
                                </button>
                            </div>
                        </div>

                        {/* Variable Select */}
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Variable</label>
                            <select
                                value={node.data?.variableName || ''}
                                onChange={(e) => {
                                    updateData('variableName', e.target.value);
                                    const prefix = node.type === 'VariableGet' ? 'Get' : 'Set';
                                    onUpdate({ name: `${prefix} ${e.target.value}` });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                            >
                                <option value="" disabled>-- Select --</option>
                                {globalVariables
                                    .filter(v => v.blueprintType === (node.data?.targetBlueprintType || 'Player'))
                                    .map((v, i) => (
                                    <option key={i} value={v.name}>{v.name} ({v.type})</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

                {/* Flow control and world nodes: defaults for unwired data inputs */}
                {definition && (
                    <RegistryNodeFields
                        node={node}
                        definition={definition}
                        onUpdate={onUpdate}
                        levelObjects={levelObjects}
                        prefabs={prefabs}
                        audioAssets={audioAssets}
                        levelVariables={levelVariables}
                        animationClips={animationClips}
                        playerBones={playerBones}
                        morphTargetsOf={morphTargetsOf}
                        connectedPinIds={connectedPinIds}
                    />
                )}

            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-800 bg-gray-900">
                <button 
                    onClick={onDelete}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-red-950/30 border border-red-900/50 hover:bg-red-900/50 hover:border-red-500 text-red-400 hover:text-white transition-all text-xs font-bold"
                >
                    <Trash2 size={14} /> Delete Node
                </button>
            </div>
        </div>
    );
};
