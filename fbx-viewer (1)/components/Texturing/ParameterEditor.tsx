import React, { useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon, WarningIcon } from '../UI/Icons';
import { Button, IconButton } from '../UI/kit';
import { Select } from '../UI/Select';
import {
    CONDITION_TESTS,
    PARAMETER_KIND_LABELS,
    RANGED_KINDS,
    coerceParameter,
    conditionError,
    formatCondition,
    parameterSetting,
    parseCondition,
    type ConditionTest,
} from '../../texturing/graph/parameters';
import type { GraphParameter, GraphParameterGroup } from '../../texturing/graph/types';
import { DraftNumber, DraftText, ParamControl } from './TextureParamField';

/**
 * EDITING A GRAPH'S PARAMETERS
 *
 * Each parameter's card: its label and words, the group it is under, when it shows, its default, its
 * hard and soft ranges and step, and a choice's options; moving it up and down; and the groups' own
 * words and whether each starts folded.
 */

const CONDITION_KINDS = new Set(['float', 'int', 'bool', 'select', 'color', 'vec2']);

/** When something shows: always, when one parameter stands some way to a value, or by a formula. */
export const ConditionEditor: React.FC<{
    value: string;
    parameters: readonly GraphParameter[];
    /** The parameter it is for, which it cannot name. */
    self?: string;
    onChange: (condition: string) => void;
}> = ({ value, parameters, self, onChange }) => {
    const others = parameters.filter((parameter) => parameter.name !== self && CONDITION_KINDS.has(parameter.kind));
    const simple = value.trim() ? parseCondition(value) : null;
    const [formula, setFormula] = useState(Boolean(value.trim()) && !simple);
    const mode = !value.trim() && !formula ? 'always' : formula || !simple ? 'formula' : 'when';
    const error = value.trim() ? conditionError(value, parameters, self) : null;
    const target = simple ? others.find((parameter) => parameter.name === simple.name) : undefined;
    const set = (patch: Partial<{ name: string; test: ConditionTest; value: number }>) => {
        const base = simple ?? { name: others[0]?.name ?? '', test: '==' as ConditionTest, value: 1 };
        onChange(formatCondition({ ...base, ...patch }));
    };
    return (
        <div className="space-y-1">
            <Select value={mode} options={[
                { value: 'always', label: 'Always' },
                ...(others.length ? [{ value: 'when', label: 'When another parameter…' }] : []),
                { value: 'formula', label: 'By a formula' },
            ]} onChange={(next) => {
                if (next === 'always') { setFormula(false); onChange(''); return; }
                if (next === 'when') { setFormula(false); set({}); return; }
                setFormula(true);
            }} className="w-full" />
            {mode === 'when' && simple && (
                <div className="flex items-center gap-1">
                    <Select value={simple.name} options={others.map((parameter) => ({ value: parameter.name, label: parameter.label }))} onChange={(name) => set({ name })} className="min-w-0 flex-1" />
                    <Select value={simple.test} options={CONDITION_TESTS.map((test) => ({ value: test.value, label: test.label }))} onChange={(test) => set({ test })} className="w-[96px]" />
                    {target?.kind === 'select'
                        ? <Select value={simple.value} options={(target.options ?? []).map((option, index) => ({ value: index, label: option.label }))} onChange={(next) => set({ value: Number(next) })} className="w-[90px]" />
                        : target?.kind === 'bool'
                            ? <Select value={simple.value ? 1 : 0} options={[{ value: 1, label: 'on' }, { value: 0, label: 'off' }]} onChange={(next) => set({ value: Number(next) })} className="w-[70px]" />
                            : <DraftNumber label="Condition value" value={simple.value} className="w-14" onCommit={(next) => set({ value: next })} />}
                </div>
            )}
            {mode === 'formula' && (
                <DraftText label="Condition formula" value={value} maxLength={200} allowEmpty placeholder={others[0] ? `${others[0].name} > 0.5` : 'a formula of the parameters'} className="w-full font-mono"
                    onCommit={(text) => onChange(text.trim())} />
            )}
            {error && <p className="flex items-center gap-1 text-2xs text-warn"><WarningIcon size={11} className="shrink-0" />{error}</p>}
        </div>
    );
};

/** A key for an option from its label: letters and digits, not one taken. */
const optionKey = (label: string, taken: readonly string[]): string => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'option';
    let key = base;
    for (let n = 2; taken.includes(key); n++) key = `${base}-${n}`;
    return key;
};

/** A choice's options: their labels and keys, in order; add, remove and move them. */
export const OptionEditor: React.FC<{
    options: ReadonlyArray<{ value: string; label: string }>;
    /** Keys node settings rely on (from settings that follow the parameter): kept as they are. */
    fixed?: boolean;
    onChange: (options: Array<{ value: string; label: string }>) => void;
}> = ({ options, fixed = false, onChange }) => {
    const list = options.map((option) => ({ ...option }));
    const move = (index: number, by: number) => {
        const next = [...list];
        const [item] = next.splice(index, 1);
        next.splice(index + by, 0, item);
        onChange(next);
    };
    return (
        <div className="space-y-1">
            {list.map((option, index) => (
                <div key={`${option.value}:${index}`} className="flex items-center gap-1">
                    <DraftText label={`Option ${index + 1} name`} value={option.label} maxLength={64} className="min-w-0 flex-1"
                        onCommit={(label) => onChange(list.map((other, at) => (at === index ? { ...other, label } : other)))} />
                    <DraftText label={`Option ${index + 1} key`} value={option.value} maxLength={64} className="w-20 font-mono text-ink-3"
                        onCommit={(key) => { if (!fixed) onChange(list.map((other, at) => (at === index ? { ...other, value: optionKey(key, list.filter((_, i) => i !== index).map((o) => o.value)) } : other))); }} />
                    <IconButton label={`Move ${option.label} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUpIcon size={11} /></IconButton>
                    <IconButton label={`Move ${option.label} down`} disabled={index === list.length - 1} onClick={() => move(index, 1)}><ArrowDownIcon size={11} /></IconButton>
                    <IconButton label={`Remove ${option.label}`} disabled={list.length <= 1 || fixed} onClick={() => onChange(list.filter((_, at) => at !== index))}><TrashIcon size={11} /></IconButton>
                </div>
            ))}
            {!fixed && (
                <Button size="sm" variant="ghost" icon={<PlusIcon size={12} />} disabled={list.length >= 32}
                    onClick={() => { const label = `Option ${list.length + 1}`; onChange([...list, { value: optionKey(label, list.map((option) => option.value)), label }]); }}>Add an option</Button>
            )}
            {fixed && <p className="text-2xs leading-snug text-ink-3">Its options come from the node setting it was exposed from: their names can change, not the options.</p>}
        </div>
    );
};

const NEW_GROUP = '\u0000new';

/** One parameter's card, folded to its name until opened. */
const ParameterCard: React.FC<{
    parameter: GraphParameter;
    parameters: readonly GraphParameter[];
    index: number;
    textures: ReadonlyArray<{ id: string; name: string }>;
    /** Whether a node setting follows it with options of its own (a choice's keys then stay). */
    bound: boolean;
    onChange: (patch: Partial<GraphParameter>, coalesce?: string) => void;
    onMove: (by: number) => void;
    onRemove: () => void;
}> = ({ parameter, parameters, index, textures, bound, onChange, onMove, onRemove }) => {
    const [open, setOpen] = useState(false);
    const [naming, setNaming] = useState(false);
    const groups = [...new Set(parameters.map((other) => other.group).filter((group): group is string => Boolean(group)))];
    const ranged = RANGED_KINDS.has(parameter.kind);
    const without = <K extends keyof GraphParameter>(key: K): Partial<GraphParameter> => ({ [key]: undefined } as Partial<GraphParameter>);
    return (
        <div className="rounded border border-line bg-well">
            <div className="flex items-center gap-1 px-1.5 py-1">
                <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                    {open ? <ChevronDownIcon size={11} className="shrink-0 text-ink-3" /> : <ChevronRightIcon size={11} className="shrink-0 text-ink-3" />}
                    <span className="truncate text-2xs font-semibold text-ink">{parameter.label}</span>
                    <span className="shrink-0 text-2xs text-ink-3">{PARAMETER_KIND_LABELS[parameter.kind]}{parameter.group ? ` · ${parameter.group}` : ''}{parameter.visibleIf ? ' · conditional' : ''}</span>
                </button>
                <IconButton label={`Move ${parameter.label} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUpIcon size={11} /></IconButton>
                <IconButton label={`Move ${parameter.label} down`} disabled={index === parameters.length - 1} onClick={() => onMove(1)}><ArrowDownIcon size={11} /></IconButton>
                <IconButton label={`Remove ${parameter.label} (settings following it keep its value)`} onClick={onRemove}><TrashIcon size={11} /></IconButton>
            </div>
            {open && (
                <div className="space-y-2 border-t border-line p-1.5">
                    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1.5">
                        <span className="text-2xs text-ink-2">Label</span>
                        <DraftText label="Parameter label" value={parameter.label} maxLength={64} className="w-full" onCommit={(label) => onChange({ label: label.trim() || parameter.name })} />
                        <span className="text-2xs text-ink-2">In formulas</span>
                        <span className="truncate font-mono text-2xs text-ink-3">{parameter.name}</span>
                        <span className="text-2xs text-ink-2">Group</span>
                        {naming
                            ? <DraftText label="New group name" value="" allowEmpty placeholder="Group name" maxLength={64} className="w-full" onCommit={(group) => { setNaming(false); onChange(group.trim() ? { group: group.trim() } : without('group')); }} />
                            : <Select value={parameter.group ?? ''} options={[{ value: '', label: 'None' }, ...groups.map((group) => ({ value: group, label: group })), { value: NEW_GROUP, label: 'A new group…' }]}
                                onChange={(group: string) => (group === NEW_GROUP ? setNaming(true) : onChange(group ? { group } : without('group')))} className="w-full" />}
                        <span className="self-start pt-1 text-2xs text-ink-2">Words</span>
                        <DraftText label="Parameter description" value={parameter.description ?? ''} maxLength={256} allowEmpty placeholder="What it does, shown on hover" className="w-full"
                            onCommit={(text) => onChange(text.trim() ? { description: text.trim() } : without('description'))} />
                    </div>
                    <div className="space-y-1">
                        <span className="text-2xs text-ink-2">Shown</span>
                        <ConditionEditor value={parameter.visibleIf ?? ''} parameters={parameters} self={parameter.name} onChange={(condition) => onChange(condition ? { visibleIf: condition } : without('visibleIf'))} />
                    </div>
                    {parameter.kind === 'select' && (
                        <div className="space-y-1">
                            <span className="text-2xs text-ink-2">Options</span>
                            <OptionEditor options={parameter.options ?? []} fixed={bound} onChange={(options) => onChange({ options, default: coerceParameter('select', parameter.default, options) })} />
                        </div>
                    )}
                    {ranged && (
                        <div className="grid grid-cols-[72px_1fr_auto_1fr] items-center gap-1 text-2xs text-ink-3">
                            <span className="text-ink-2" title="A value never goes past these">Limits</span>
                            <DraftNumber label="Lowest value" value={parameter.min ?? 0} integer={parameter.kind === 'int'} className="w-full"
                                onCommit={(min) => onChange({ min, max: Math.max(min, parameter.max ?? min + 1) })} />
                            <span>to</span>
                            <DraftNumber label="Highest value" value={parameter.max ?? 1} integer={parameter.kind === 'int'} className="w-full"
                                onCommit={(max) => onChange({ max, min: Math.min(max, parameter.min ?? max - 1) })} />
                            <span className="text-ink-2" title="The slider's ends: typing can go past them, up to the limits">Slider</span>
                            <DraftNumber label="Slider start" value={parameter.softMin ?? parameter.min ?? 0} integer={parameter.kind === 'int'} className="w-full"
                                limit={(value) => Math.max(parameter.min ?? -Infinity, Math.min(parameter.max ?? Infinity, value))} onCommit={(softMin) => onChange({ softMin })} />
                            <span>to</span>
                            <DraftNumber label="Slider end" value={parameter.softMax ?? parameter.max ?? 1} integer={parameter.kind === 'int'} className="w-full"
                                limit={(value) => Math.max(parameter.min ?? -Infinity, Math.min(parameter.max ?? Infinity, value))} onCommit={(softMax) => onChange({ softMax })} />
                            <span className="text-ink-2">Step</span>
                            <DraftNumber label="Step" value={parameter.step ?? (parameter.kind === 'int' ? 1 : 0.01)} className="w-full" limit={(value) => Math.max(parameter.kind === 'int' ? 1 : 0.0001, value)}
                                onCommit={(step) => onChange({ step })} />
                            <span />
                            <span />
                        </div>
                    )}
                    <div className="space-y-1">
                        <span className="text-2xs text-ink-2">Default</span>
                        <ParamControl param={parameterSetting(parameter)} value={parameter.default} textures={textures}
                            onChange={(value) => onChange({ default: coerceParameter(parameter.kind, value, parameter.options) }, `default:${parameter.name}`)} />
                    </div>
                </div>
            )}
        </div>
    );
};

/** The groups' words and folding. */
const GroupsEditor: React.FC<{
    names: readonly string[];
    groups: readonly GraphParameterGroup[];
    onChange: (groups: GraphParameterGroup[], renamed?: { from: string; to: string }) => void;
}> = ({ names, groups, onChange }) => {
    if (!names.length) return null;
    const of = (name: string): GraphParameterGroup => groups.find((group) => group.name === name) ?? { name };
    const put = (name: string, patch: Partial<GraphParameterGroup>) => {
        const list = names.map(of).map((group) => (group.name === name ? { ...group, ...patch } : group));
        onChange(list.map((group) => Object.fromEntries(Object.entries(group).filter(([, value]) => value !== undefined && value !== '' && value !== false)) as unknown as GraphParameterGroup), patch.name && patch.name !== name ? { from: name, to: patch.name } : undefined);
    };
    return (
        <div className="space-y-1.5">
            <div className="text-2xs font-semibold text-ink-2">Groups</div>
            {names.map((name) => (
                <div key={name} className="space-y-1 rounded border border-line bg-well p-1.5">
                    <div className="flex items-center gap-1">
                        <DraftText label="Group name" value={name} maxLength={64} className="min-w-0 flex-1" onCommit={(next) => { const trimmed = next.trim(); if (trimmed && trimmed !== name && !names.includes(trimmed)) put(name, { name: trimmed }); }} />
                        <label className="flex shrink-0 items-center gap-1 text-2xs text-ink-2">
                            <input type="checkbox" checked={Boolean(of(name).folded)} onChange={(event) => put(name, { folded: event.target.checked || undefined })} className="accent-accent" />
                            Starts folded
                        </label>
                    </div>
                    <DraftText label="Group description" value={of(name).description ?? ''} maxLength={256} allowEmpty placeholder="Words shown under the group's name" className="w-full"
                        onCommit={(text) => put(name, { description: text.trim() || undefined })} />
                </div>
            ))}
        </div>
    );
};

/** Every parameter's card, then the groups. */
export const ParameterEditor: React.FC<{
    parameters: readonly GraphParameter[];
    groups: readonly GraphParameterGroup[];
    textures: ReadonlyArray<{ id: string; name: string }>;
    /** Choice parameters a node setting with options of its own follows. */
    boundChoices: ReadonlySet<string>;
    onParameters: (parameters: GraphParameter[], coalesce?: string) => void;
    onGroups: (groups: GraphParameterGroup[], renamed?: { from: string; to: string }) => void;
    onRemove: (index: number) => void;
}> = ({ parameters, groups, textures, boundChoices, onParameters, onGroups, onRemove }) => {
    const change = (index: number, patch: Partial<GraphParameter>, coalesce?: string) => onParameters(parameters.map((parameter, at) => {
        if (at !== index) return parameter;
        const next = { ...parameter, ...patch } as GraphParameter;
        for (const key of Object.keys(next) as Array<keyof GraphParameter>) if (next[key] === undefined) delete next[key];
        return next;
    }), coalesce);
    const move = (index: number, by: number) => {
        const next = [...parameters];
        const [item] = next.splice(index, 1);
        next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
        onParameters(next);
    };
    const names = [...new Set(parameters.map((parameter) => parameter.group).filter((group): group is string => Boolean(group)))];
    return (
        <div className="space-y-1.5">
            {parameters.map((parameter, index) => (
                <ParameterCard key={parameter.name} parameter={parameter} parameters={parameters} index={index} textures={textures} bound={boundChoices.has(parameter.name)}
                    onChange={(patch, coalesce) => change(index, patch, coalesce)} onMove={(by) => move(index, by)} onRemove={() => onRemove(index)} />
            ))}
            <GroupsEditor names={names} groups={groups} onChange={onGroups} />
        </div>
    );
};
