import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import {
    ABILITY_PRESET_IDS,
    ABILITY_PRESET_LABELS,
    EFFECT_DURATIONS,
    EFFECT_STACKINGS,
    MODIFIER_OPERATIONS,
    isTag,
    resolveAbilitySet,
    sanitizeAbilitySet,
    type AbilityDefinition,
    type AbilityPresetId,
    type AbilitySetDefinition,
    type AttributeDefinition,
    type EffectDefinition,
} from '../../runtime/abilities';
import { ABILITY_INPUTS } from '../../runtime/components/abilitiesComponent';

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200 focus:outline-none focus:border-amber-500';
const BUTTON = 'flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-2xs text-gray-200';
const LABEL = 'text-2xs text-gray-400';

/** Text taken on Enter or when the field is left. */
const TextInput: React.FC<{ label: string; value: string; onCommit: (value: string) => void; placeholder?: string }> = ({ label, value, onCommit, placeholder }) => {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <input
            aria-label={label}
            value={text}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => { if (text !== value) onCommit(text); }}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
            className={FIELD}
        />
    );
};

const NumberInput: React.FC<{ label: string; value: number; onCommit: (value: number) => void; step?: number }> = ({ label, value, onCommit, step = 1 }) => {
    const shown = String(Math.round(value * 1000) / 1000);
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const take = () => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setText(shown);
    };
    return (
        <input
            aria-label={label}
            type="number"
            step={step}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={take}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
            className={FIELD}
        />
    );
};

/** A number, or the name of another attribute (a bound such as "maxHealth"). */
const BoundInput: React.FC<{ label: string; value: number | string; onCommit: (value: number | string) => void }> = ({ label, value, onCommit }) => (
    <TextInput label={label} value={String(value)} onCommit={(text) => {
        const parsed = Number(text);
        onCommit(text.trim() !== '' && Number.isFinite(parsed) ? parsed : text.trim());
    }} />
);

/** Tags as a comma-separated list; malformed ones are dropped. */
const TagsInput: React.FC<{ label: string; value: string[]; onCommit: (value: string[]) => void }> = ({ label, value, onCommit }) => (
    <TextInput label={label} value={value.join(', ')} placeholder="State.Stunned, ..." onCommit={(text) => onCommit(text.split(',').map(tag => tag.trim()).filter(isTag))} />
);

const Select = <T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (value: T) => void }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)} className={FIELD}>
        {options.map(option => <option key={option} value={option}>{labels?.[option] ?? option}</option>)}
    </select>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <label className="grid grid-cols-[88px_1fr] items-center gap-2"><span className={LABEL}>{label}</span>{children}</label>
);

/** Effect ids as checkboxes. */
const EffectPicker: React.FC<{ label: string; effects: EffectDefinition[]; value: string[]; onCommit: (value: string[]) => void }> = ({ label, effects, value, onCommit }) => (
    <div className="space-y-0.5">
        <div className={LABEL}>{label}</div>
        {effects.length === 0 && <div className="text-2xs text-gray-600">No effects yet.</div>}
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
            {effects.map(effect => (
                <label key={effect.id} className="flex items-center gap-1 text-2xs text-gray-300">
                    <input
                        type="checkbox"
                        aria-label={`${label}: ${effect.name}`}
                        checked={value.includes(effect.id)}
                        onChange={(event) => onCommit(event.target.checked ? [...value, effect.id] : value.filter(id => id !== effect.id))}
                    />
                    {effect.name}
                </label>
            ))}
        </div>
    </div>
);

const Card: React.FC<{ title: string; onRemove: () => void; children: React.ReactNode }> = ({ title, onRemove, children }) => {
    const [open, setOpen] = useState(false);
    return (
        <div className="rounded border border-gray-800 bg-gray-900/60">
            <div className="flex items-center gap-1 px-1.5 py-1">
                <button type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`} onClick={() => setOpen(!open)} className="text-gray-400 hover:text-gray-200">
                    {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
                <span className="flex-1 truncate text-2xs text-gray-200">{title}</span>
                <button type="button" aria-label={`Remove ${title}`} onClick={onRemove} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
            </div>
            {open && <div className="space-y-1 border-t border-gray-800 p-1.5">{children}</div>}
        </div>
    );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="space-y-1">
        <div className="text-2xs font-bold text-gray-500">{title}</div>
        {children}
    </div>
);

const uniqueId = (taken: string[], base: string): string => {
    let n = 1;
    while (taken.includes(`${base}${n}`)) n++;
    return `${base}${n}`;
};

/**
 * The Abilities component's editor: a preset to start from, the actor's tags, its attributes, the
 * effects it can apply, and its abilities.
 */
export const AbilitiesInspector: React.FC<ComponentInspectorProps> = ({ component, onChangeProps }) => {
    const set = resolveAbilitySet(component.props);
    const preset = (component.props.abilities ? '' : (component.props.preset as string) || 'fighter') as AbilityPresetId | '';
    const commit = (next: Partial<AbilitySetDefinition>) => onChangeProps({ abilities: sanitizeAbilitySet({ ...set, ...next }), preset: undefined });
    const attributeNames = set.attributes.map(attribute => attribute.name);

    const updateAttribute = (index: number, change: Partial<AttributeDefinition>) =>
        commit({ attributes: set.attributes.map((attribute, i) => (i === index ? { ...attribute, ...change } : attribute)) });
    const updateEffect = (index: number, change: Partial<EffectDefinition>) =>
        commit({ effects: set.effects.map((effect, i) => (i === index ? { ...effect, ...change } : effect)) });
    const updateAbility = (index: number, change: Partial<AbilityDefinition>) =>
        commit({ abilities: set.abilities.map((ability, i) => (i === index ? { ...ability, ...change } : ability)) });

    return (
        <div className="space-y-3">
            <Row label="Preset">
                <select
                    aria-label="Ability preset"
                    value={preset}
                    onChange={(event) => { if (event.target.value) onChangeProps({ preset: event.target.value, abilities: undefined }); }}
                    className={FIELD}
                >
                    {!preset && <option value="">Custom</option>}
                    {ABILITY_PRESET_IDS.map(id => <option key={id} value={id}>{ABILITY_PRESET_LABELS[id]}</option>)}
                </select>
            </Row>
            <Row label="Tags"><TagsInput label="Actor tags" value={set.tags} onCommit={(tags) => commit({ tags })} /></Row>

            <Section title="Attributes">
                {set.attributes.map((attribute, index) => (
                    <div key={attribute.name} className="space-y-1 rounded border border-gray-800 bg-gray-900/60 p-1.5">
                        <div className="grid grid-cols-[1fr_14px] items-center gap-1">
                            <TextInput label={`Attribute ${index + 1} name`} value={attribute.name} onCommit={(name) => updateAttribute(index, { name })} />
                            <button type="button" aria-label={`Remove ${attribute.name}`} onClick={() => commit({ attributes: set.attributes.filter((_, i) => i !== index) })} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-2xs text-gray-500">
                            <label className="space-y-0.5"><span>Base</span><NumberInput label={`${attribute.name} base`} value={attribute.base} onCommit={(base) => updateAttribute(index, { base })} /></label>
                            <label className="space-y-0.5"><span>Min</span><BoundInput label={`${attribute.name} minimum`} value={attribute.min} onCommit={(min) => updateAttribute(index, { min })} /></label>
                            <label className="space-y-0.5"><span>Max</span><BoundInput label={`${attribute.name} maximum`} value={attribute.max} onCommit={(max) => updateAttribute(index, { max })} /></label>
                            <label className="space-y-0.5"><span>Regen /s</span><NumberInput label={`${attribute.name} regeneration`} value={attribute.regen} onCommit={(regen) => updateAttribute(index, { regen })} /></label>
                            <label className="space-y-0.5"><span>After (s)</span><NumberInput label={`${attribute.name} regeneration delay`} value={attribute.regenDelay} step={0.1} onCommit={(regenDelay) => updateAttribute(index, { regenDelay })} /></label>
                        </div>
                    </div>
                ))}
                <button type="button" className={BUTTON} onClick={() => commit({ attributes: [...set.attributes, { name: uniqueId(attributeNames, 'attribute'), base: 100, min: 0, max: 100, regen: 0, regenDelay: 0 }] })}><Plus size={10} /> Attribute</button>
                <p className="text-2xs text-gray-500">A bound can be another attribute's name (health's maximum is maxHealth). An actor with health takes damage from weapons and blasts, less its armor.</p>
            </Section>

            <Section title="Effects">
                {set.effects.map((effect, index) => (
                    <Card key={effect.id} title={`${effect.name} (${effect.duration}${effect.period > 0 ? ', periodic' : ''})`} onRemove={() => commit({ effects: set.effects.filter((_, i) => i !== index) })}>
                        <Row label="Name"><TextInput label={`Effect ${effect.id} name`} value={effect.name} onCommit={(name) => updateEffect(index, { name })} /></Row>
                        <Row label="Lasts"><Select label={`Effect ${effect.id} duration`} value={effect.duration} options={EFFECT_DURATIONS} labels={{ instant: 'Instantly (changes base values)', timed: 'For some seconds', infinite: 'Until removed' }} onChange={(duration) => updateEffect(index, { duration })} /></Row>
                        {effect.duration === 'timed' && <Row label="Seconds"><NumberInput label={`Effect ${effect.id} seconds`} value={effect.seconds} step={0.5} onCommit={(seconds) => updateEffect(index, { seconds })} /></Row>}
                        {effect.duration !== 'instant' && <Row label="Every (s)"><NumberInput label={`Effect ${effect.id} period`} value={effect.period} step={0.5} onCommit={(period) => updateEffect(index, { period })} /></Row>}
                        {effect.duration !== 'instant' && (
                            <Row label="Again">
                                <div className="grid grid-cols-[1fr_48px] gap-1">
                                    <Select label={`Effect ${effect.id} stacking`} value={effect.stacking} options={EFFECT_STACKINGS} labels={{ refresh: 'Starts over', stack: 'Stacks', none: 'Refused' }} onChange={(stacking) => updateEffect(index, { stacking })} />
                                    <NumberInput label={`Effect ${effect.id} max stacks`} value={effect.maxStacks} onCommit={(maxStacks) => updateEffect(index, { maxStacks })} />
                                </div>
                            </Row>
                        )}
                        <div className={LABEL}>Changes</div>
                        {effect.modifiers.map((modifier, m) => (
                            <div key={m} className="grid grid-cols-[1.2fr_1fr_1fr_14px] items-center gap-1">
                                <Select label={`Effect ${effect.id} change ${m + 1} attribute`} value={modifier.attribute} options={attributeNames.includes(modifier.attribute) ? attributeNames : [modifier.attribute, ...attributeNames]} onChange={(attribute) => updateEffect(index, { modifiers: effect.modifiers.map((entry, i) => (i === m ? { ...entry, attribute } : entry)) })} />
                                <Select label={`Effect ${effect.id} change ${m + 1} operation`} value={modifier.operation} options={MODIFIER_OPERATIONS} labels={{ add: 'Add', multiply: 'Multiply by 1 +', override: 'Set to' }} onChange={(operation) => updateEffect(index, { modifiers: effect.modifiers.map((entry, i) => (i === m ? { ...entry, operation } : entry)) })} />
                                <NumberInput label={`Effect ${effect.id} change ${m + 1} value`} value={modifier.value} onCommit={(value) => updateEffect(index, { modifiers: effect.modifiers.map((entry, i) => (i === m ? { ...entry, value } : entry)) })} />
                                <button type="button" aria-label={`Remove change ${m + 1}`} onClick={() => updateEffect(index, { modifiers: effect.modifiers.filter((_, i) => i !== m) })} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                            </div>
                        ))}
                        {attributeNames.length > 0 && <button type="button" className={BUTTON} onClick={() => updateEffect(index, { modifiers: [...effect.modifiers, { attribute: attributeNames[0], operation: 'add', value: -10 }] })}><Plus size={10} /> Change</button>}
                        <Row label="Grants tags"><TagsInput label={`Effect ${effect.id} granted tags`} value={effect.grantedTags} onCommit={(grantedTags) => updateEffect(index, { grantedTags })} /></Row>
                        <Row label="Needs tags"><TagsInput label={`Effect ${effect.id} required tags`} value={effect.requiredTags} onCommit={(requiredTags) => updateEffect(index, { requiredTags })} /></Row>
                        <Row label="Immune with"><TagsInput label={`Effect ${effect.id} blocked tags`} value={effect.blockedTags} onCommit={(blockedTags) => updateEffect(index, { blockedTags })} /></Row>
                        <Row label="Removes"><TagsInput label={`Effect ${effect.id} removes effects with tags`} value={effect.removeEffectsWithTags} onCommit={(removeEffectsWithTags) => updateEffect(index, { removeEffectsWithTags })} /></Row>
                    </Card>
                ))}
                <button type="button" className={BUTTON} onClick={() => {
                    const id = uniqueId(set.effects.map(effect => effect.id), 'effect');
                    commit({ effects: [...set.effects, { id, name: id, duration: 'instant', seconds: 5, period: 0, modifiers: [], grantedTags: [], requiredTags: [], blockedTags: [], removeEffectsWithTags: [], stacking: 'refresh', maxStacks: 1 }] });
                }}><Plus size={10} /> Effect</button>
            </Section>

            <Section title="Abilities">
                {set.abilities.map((ability, index) => (
                    <Card key={ability.id} title={ability.input ? `${ability.name} (${ability.input})` : ability.name} onRemove={() => commit({ abilities: set.abilities.filter((_, i) => i !== index) })}>
                        <Row label="Name"><TextInput label={`Ability ${ability.id} name`} value={ability.name} onCommit={(name) => updateAbility(index, { name })} /></Row>
                        <Row label="Key"><Select label={`Ability ${ability.id} input`} value={ability.input} options={['', ...ABILITY_INPUTS]} labels={{ '': 'None (scripts only)', Ability1: 'Ability 1 (key 1)', Ability2: 'Ability 2 (key 2)', Ability3: 'Ability 3 (key 3)', Ability4: 'Ability 4 (key 4)' }} onChange={(input) => updateAbility(index, { input })} /></Row>
                        <Row label="Cooldown (s)"><NumberInput label={`Ability ${ability.id} cooldown`} value={ability.cooldown} step={0.5} onCommit={(cooldown) => updateAbility(index, { cooldown })} /></Row>
                        <Row label="Active (s)"><NumberInput label={`Ability ${ability.id} active time`} value={ability.activeTime} step={0.5} onCommit={(activeTime) => updateAbility(index, { activeTime })} /></Row>
                        <Row label="Range (m)"><NumberInput label={`Ability ${ability.id} range`} value={ability.range} onCommit={(range) => updateAbility(index, { range })} /></Row>
                        <div className={LABEL}>Costs</div>
                        {ability.costs.map((cost, c) => (
                            <div key={c} className="grid grid-cols-[1.4fr_1fr_14px] items-center gap-1">
                                <Select label={`Ability ${ability.id} cost ${c + 1} attribute`} value={cost.attribute} options={attributeNames.includes(cost.attribute) ? attributeNames : [cost.attribute, ...attributeNames]} onChange={(attribute) => updateAbility(index, { costs: ability.costs.map((entry, i) => (i === c ? { ...entry, attribute } : entry)) })} />
                                <NumberInput label={`Ability ${ability.id} cost ${c + 1} amount`} value={cost.amount} onCommit={(amount) => updateAbility(index, { costs: ability.costs.map((entry, i) => (i === c ? { ...entry, amount } : entry)) })} />
                                <button type="button" aria-label={`Remove cost ${c + 1}`} onClick={() => updateAbility(index, { costs: ability.costs.filter((_, i) => i !== c) })} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                            </div>
                        ))}
                        {attributeNames.length > 0 && ability.costs.length < 4 && <button type="button" className={BUTTON} onClick={() => updateAbility(index, { costs: [...ability.costs, { attribute: attributeNames[0], amount: 10 }] })}><Plus size={10} /> Cost</button>}
                        <EffectPicker label="On the user" effects={set.effects} value={ability.selfEffects} onCommit={(selfEffects) => updateAbility(index, { selfEffects })} />
                        <EffectPicker label="On the target" effects={set.effects} value={ability.targetEffects} onCommit={(targetEffects) => updateAbility(index, { targetEffects })} />
                        <Row label="Needs tags"><TagsInput label={`Ability ${ability.id} required tags`} value={ability.requiredTags} onCommit={(requiredTags) => updateAbility(index, { requiredTags })} /></Row>
                        <Row label="Blocked by"><TagsInput label={`Ability ${ability.id} blocked tags`} value={ability.blockedTags} onCommit={(blockedTags) => updateAbility(index, { blockedTags })} /></Row>
                        <Row label="While active"><TagsInput label={`Ability ${ability.id} active tags`} value={ability.activeTags} onCommit={(activeTags) => updateAbility(index, { activeTags })} /></Row>
                        <Row label="Cancels"><TagsInput label={`Ability ${ability.id} cancels abilities with tags`} value={ability.cancelTags} onCommit={(cancelTags) => updateAbility(index, { cancelTags })} /></Row>
                    </Card>
                ))}
                <button type="button" className={BUTTON} onClick={() => {
                    const id = uniqueId(set.abilities.map(ability => ability.id), 'ability');
                    commit({ abilities: [...set.abilities, { id, name: id, costs: [], cooldown: 1, activeTime: 0, requiredTags: [], blockedTags: [], activeTags: [], cancelTags: [], selfEffects: [], targetEffects: [], range: 0, input: '' }] });
                }}><Plus size={10} /> Ability</button>
            </Section>

            <Section title="At start">
                <EffectPicker label="Effects applied when it starts" effects={set.effects} value={set.startEffects} onCommit={(startEffects) => commit({ startEffects })} />
            </Section>
        </div>
    );
};
