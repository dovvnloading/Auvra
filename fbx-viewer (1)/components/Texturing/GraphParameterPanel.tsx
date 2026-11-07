import React, { useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, GridIcon, InfoIcon, PencilIcon, ResetIcon, SaveIcon, TrashIcon } from '../UI/Icons';
import { Button, IconButton, Popover, Segmented } from '../UI/kit';
import { Select } from '../UI/Select';
import {
    coerceParameter,
    limitParameter,
    matchesPreset,
    parameterSections,
    parameterSetting,
    visibleParameters,
} from '../../texturing/graph/parameters';
import type { GraphParameter, GraphParameterGroup, GraphPreset } from '../../texturing/graph/types';
import { DraftText, ParamControl } from './TextureParamField';

/**
 * A GRAPH'S PARAMETERS, AS WHATEVER USES THE GRAPH SEES THEM
 *
 * The finished panel: the parameters under their groups (folding open and shut), each shown only while
 * its condition holds, its words on hover, a way back to its default once changed; and a bar of the
 * graph's presets above it.
 */

/** Whether a value is not the parameter's default. */
const changed = (parameter: GraphParameter, value: unknown): boolean => value !== undefined
    && JSON.stringify(coerceParameter(parameter.kind, value, parameter.options)) !== JSON.stringify(coerceParameter(parameter.kind, parameter.default, parameter.options));

/** Laid out with its control under its name rather than beside it. */
const tall = (parameter: GraphParameter) => parameter.kind === 'ramp' || parameter.kind === 'curve' || parameter.kind === 'string' || parameter.kind === 'vec2';

export const GraphParameterPanel: React.FC<{
    parameters: readonly GraphParameter[];
    groups?: readonly GraphParameterGroup[];
    values: Readonly<Record<string, unknown>>;
    textures: ReadonlyArray<{ id: string; name: string }>;
    onChange: (values: Record<string, unknown>, coalesce?: string) => void;
    /** Said when there are no parameters. */
    empty?: React.ReactNode;
}> = ({ parameters, groups = [], values, textures, onChange, empty }) => {
    // Groups the user opened or folded; others as the graph sets them.
    const [folded, setFolded] = useState<Record<string, boolean>>({});
    if (!parameters.length) return <>{empty ?? null}</>;
    const shown = visibleParameters(parameters, values);
    const set = (parameter: GraphParameter, value: unknown) =>
        onChange({ ...values, [parameter.name]: limitParameter(parameter, coerceParameter(parameter.kind, value, parameter.options)) }, `value:${parameter.name}`);

    const row = (parameter: GraphParameter) => {
        const value = values[parameter.name] ?? parameter.default;
        const control = <ParamControl param={parameterSetting(parameter)} value={value} textures={textures} onChange={(next) => set(parameter, next)} />;
        const label = (
            // Long labels wrap rather than being cut; the label and its description show in full on hover.
            <span className="flex min-w-0 items-start gap-1 text-2xs leading-tight text-ink-2" title={parameter.description ? `${parameter.label}: ${parameter.description}` : parameter.label}>
                <span className="min-w-0 break-words">{parameter.label}</span>
                {parameter.description && <InfoIcon size={10} className="mt-px shrink-0 text-ink-3" />}
            </span>
        );
        const reset = changed(parameter, values[parameter.name]) && (
            <button type="button" aria-label={`${parameter.label} back to its default`} title="Back to its default" onClick={() => set(parameter, structuredClone(parameter.default))}
                className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink"><ResetIcon size={11} /></button>
        );
        return tall(parameter) ? (
            <div key={parameter.name} className="space-y-1">
                <div className="flex items-center gap-1">{label}<span className="flex-1" />{reset}</div>
                {control}
            </div>
        ) : (
            <div key={parameter.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-1.5 gap-y-0.5">
                {label}
                <div className="min-w-0">{control}</div>
                <span className="w-4">{reset}</span>
            </div>
        );
    };

    return (
        <div className="space-y-2">
            {parameterSections(parameters, groups).map((section) => {
                const visible = section.parameters.filter((parameter) => shown.has(parameter.name));
                if (!visible.length) return null;
                if (!section.group) return <div key="" className="space-y-2">{visible.map(row)}</div>;
                const name = section.group.name;
                const shut = folded[name] ?? Boolean(section.group.folded);
                return (
                    <div key={name} className="rounded border border-line">
                        <button type="button" aria-expanded={!shut} onClick={() => setFolded((current) => ({ ...current, [name]: !shut }))}
                            className="flex w-full items-center gap-1 px-1.5 py-1 text-left text-2xs font-semibold text-ink-2 hover:text-ink">
                            {shut ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
                            <span className="min-w-0 flex-1 truncate">{name}</span>
                            {shut && <span className="font-normal text-ink-3">{visible.length}</span>}
                        </button>
                        {!shut && (
                            <div className="space-y-2 border-t border-line px-1.5 py-1.5">
                                {section.group.description && <p className="text-2xs leading-snug text-ink-3">{section.group.description}</p>}
                                {visible.map(row)}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

// ---- presets ----

export type PresetPlace = 'graph' | 'project';
export interface PlacedPreset { preset: GraphPreset; place: PresetPlace }

/**
 * The graph's presets: choose one to apply it; keep the values now as a new one, in the graph (it goes
 * wherever the graph goes) or shared in the project (for this graph, without changing it); rename or
 * delete the one in use. `onSave` is left out where presets can only be applied (a node using the graph).
 */
export const PresetBar: React.FC<{
    presets: readonly PlacedPreset[];
    parameters: readonly GraphParameter[];
    values: Readonly<Record<string, unknown>>;
    onApply: (preset: GraphPreset) => void;
    onSave?: (name: string, place: PresetPlace, withSeed: boolean) => void;
    onRename?: (item: PlacedPreset, name: string) => void;
    onDelete?: (item: PlacedPreset) => void;
    onVariations?: () => void;
}> = ({ presets, parameters, values, onApply, onSave, onRename, onDelete, onVariations }) => {
    const anchor = useRef<HTMLButtonElement>(null);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const [place, setPlace] = useState<PresetPlace>('graph');
    const [withSeed, setWithSeed] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const active = presets.find((item) => matchesPreset(item.preset, parameters, values)) ?? null;
    const save = () => {
        onSave?.(name.trim() || `Preset ${presets.length + 1}`, place, withSeed);
        setSaving(false);
        setName('');
    };
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1">
                <Select value={active?.preset.id ?? ''} placeholder={presets.length ? 'Presets…' : 'No presets yet'} disabled={!presets.length}
                    options={presets.map((item) => ({ value: item.preset.id, label: item.place === 'project' ? `${item.preset.name} (in the project)` : item.preset.name }))}
                    onChange={(id) => { const item = presets.find((candidate) => candidate.preset.id === id); if (item) onApply(item.preset); setDeleting(false); setRenaming(false); }}
                    className="min-w-0 flex-1" />
                {onSave && <IconButton ref={anchor} label="Keep these values as a preset" onClick={() => setSaving(true)}><SaveIcon size={12} /></IconButton>}
                {active && onRename && <IconButton label={`Rename ${active.preset.name}`} active={renaming} onClick={() => { setRenaming(!renaming); setDeleting(false); }}><PencilIcon size={12} /></IconButton>}
                {active && onDelete && <IconButton label={`Delete ${active.preset.name}`} active={deleting} onClick={() => { setDeleting(!deleting); setRenaming(false); }}><TrashIcon size={12} /></IconButton>}
                {onVariations && <IconButton label="Variations: a grid of the graph with one parameter changed across it" onClick={onVariations}><GridIcon size={12} /></IconButton>}
            </div>
            {renaming && active && onRename && (
                <DraftText label="Preset name" value={active.preset.name} className="w-full" onCommit={(next) => { onRename(active, next); setRenaming(false); }} />
            )}
            {deleting && active && onDelete && (
                <div className="flex items-center gap-1.5 rounded border border-bad/40 bg-bad/10 px-1.5 py-1 text-2xs text-bad">
                    <span className="min-w-0 flex-1 truncate">Delete "{active.preset.name}"{active.place === 'project' ? ' from the project' : ''}?</span>
                    <Button size="sm" variant="danger" onClick={() => { onDelete(active); setDeleting(false); }}>Delete</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>Keep</Button>
                </div>
            )}
            {onSave && (
                <Popover anchor={anchor} open={saving} onClose={() => setSaving(false)} width={250} label="Keep as a preset">
                    <div className="space-y-2 p-2 text-xs">
                        <input aria-label="Preset name" autoFocus value={name} maxLength={64} placeholder={`Preset ${presets.length + 1}`} onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
                            className="w-full rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent" />
                        <Segmented value={place} label="Kept" onChange={setPlace} options={[
                            { value: 'graph', label: 'In this graph', hint: 'Goes wherever the graph goes, and shows wherever it is used' },
                            { value: 'project', label: 'In the project', hint: 'Shared in this project for this graph, without changing the graph' },
                        ]} />
                        <label className="flex items-center gap-2 text-2xs text-ink-2">
                            <input type="checkbox" checked={withSeed} onChange={(event) => setWithSeed(event.target.checked)} className="accent-accent" />
                            Keep the random seed with it
                        </label>
                        <div className="flex justify-end"><Button size="sm" variant="primary" onClick={save}>Keep</Button></div>
                    </div>
                </Popover>
            )}
        </div>
    );
};
