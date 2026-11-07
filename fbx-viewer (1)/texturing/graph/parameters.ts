import { evaluateExpression, type ExprValue } from './expressions';
import { defaultCurves, readCurves, readRamp } from './nodeKit';
import {
    isParamLink,
    type GraphParameter,
    type GraphParameterGroup,
    type GraphParameterKind,
    type GraphParameterValue,
    type GraphPreset,
    type RampStop,
    type TexParamDef,
} from './types';

/**
 * EXPOSED PARAMETERS
 *
 * What a graph shows to whatever uses it (a material, a node using the graph, a fill): its parameters
 * under their groups, each shown only while its condition holds, with words about it, its ranges and
 * steps; and presets, values for them kept under a name. Conditions are formulas of the other
 * parameters ("pattern == 2", "wear > 0.5 && edges"): a choice reads as its option's place (from 0),
 * a switch as 1 or 0. Everything here is plain data, read the same by the editor and by the graph's
 * users.
 */

export const PARAMETER_KIND_LABELS: Record<GraphParameterKind, string> = {
    float: 'Number', int: 'Whole number', bool: 'Switch', color: 'Colour', vec2: 'Pair of numbers', select: 'Choice',
    ramp: 'Gradient', curve: 'Curves', texture: 'Picture', string: 'Text', font: 'Font',
};
export const PARAMETER_KINDS = Object.keys(PARAMETER_KIND_LABELS) as GraphParameterKind[];

/** Kinds formulas and conditions read (as numbers). */
const NUMERIC_KINDS: ReadonlySet<GraphParameterKind> = new Set(['float', 'int', 'bool', 'color', 'vec2', 'select']);
/** Kinds with a range (hard and soft limits, a step). */
export const RANGED_KINDS: ReadonlySet<GraphParameterKind> = new Set(['float', 'int', 'vec2']);

export const DEFAULT_RAMP: RampStop[] = [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [1, 1, 1, 1] }];

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A parameter value of the right shape for its kind (a choice: one of its options). */
export const coerceParameter = (kind: GraphParameterKind, value: unknown, options?: ReadonlyArray<{ value: string }>): GraphParameterValue => {
    switch (kind) {
        case 'bool': return Boolean(value);
        case 'int': return Math.round(finite(value, 0));
        case 'color': {
            const c = Array.isArray(value) ? value : [0.5, 0.5, 0.5, 1];
            return [0, 1, 2, 3].map((i) => clamp(finite(c[i], i === 3 ? 1 : 0.5), 0, 1));
        }
        case 'vec2': {
            const v = Array.isArray(value) ? value : [0, 0];
            return [finite(v[0], 0), finite(v[1], 0)];
        }
        case 'select': return typeof value === 'string' && (!options || options.some((option) => option.value === value)) ? value : options?.[0]?.value ?? '';
        case 'ramp': return { stops: readRamp(value, DEFAULT_RAMP) };
        case 'curve': return value && typeof value === 'object' ? readCurves(value) : defaultCurves();
        case 'texture': case 'string': case 'font': return typeof value === 'string' ? value.slice(0, kind === 'string' ? 2000 : 256) : '';
        default: return finite(value, 0);
    }
};

/** A value kept inside a parameter's hard limits (numbers and pairs; others as they are). */
export const limitParameter = (parameter: GraphParameter, value: GraphParameterValue): GraphParameterValue => {
    const low = parameter.min ?? -Infinity;
    const high = parameter.max ?? Infinity;
    if (parameter.kind === 'float' || parameter.kind === 'int') return clamp(Number(value), low, high);
    if (parameter.kind === 'vec2' && Array.isArray(value)) return value.map((item) => clamp(Number(item), low, high));
    return value;
};

// ---- conditions ----

/** What conditions and formulas see of the parameters: each as a number or vector (a choice: its option's place). */
export const conditionScope = (parameters: readonly GraphParameter[], values: Readonly<Record<string, unknown>>): Record<string, ExprValue> => {
    const scope: Record<string, ExprValue> = {};
    for (const parameter of parameters) {
        if (!NUMERIC_KINDS.has(parameter.kind)) continue;
        const raw = values[parameter.name];
        const value = raw === undefined || isParamLink(raw) ? parameter.default : raw;
        if (typeof value === 'number') scope[parameter.name] = value;
        else if (typeof value === 'boolean') scope[parameter.name] = value ? 1 : 0;
        else if (Array.isArray(value)) scope[parameter.name] = value.map(Number);
        else if (typeof value === 'string') scope[parameter.name] = Math.max(0, parameter.options?.findIndex((option) => option.value === value) ?? 0);
    }
    return scope;
};

/** Whether a condition holds: no condition does; a formula that does not read does too (so nothing vanishes by mistake). */
export const conditionHolds = (condition: string | undefined, scope: Readonly<Record<string, ExprValue>>): boolean => {
    if (!condition?.trim()) return true;
    try {
        const value = evaluateExpression(condition, scope);
        return Array.isArray(value) ? value.some((item) => item !== 0) : value !== 0;
    } catch {
        return true;
    }
};

/** What is wrong with a condition, in words, or null: it must read, and name only other parameters that formulas can read. */
export const conditionError = (condition: string, parameters: readonly GraphParameter[], self?: string): string | null => {
    if (!condition.trim()) return null;
    const names = parameters.filter((parameter) => parameter.name !== self && NUMERIC_KINDS.has(parameter.kind)).map((parameter) => parameter.name);
    try {
        evaluateExpression(condition, Object.fromEntries(names.map((name) => [name, 1])));
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'The condition could not be read';
        return self && new RegExp(`\\b${self}\\b`).test(condition) ? 'A parameter cannot be shown by its own value.' : message;
    }
};

/** The names of the parameters shown with these values. */
export const visibleParameters = (parameters: readonly GraphParameter[], values: Readonly<Record<string, unknown>>): Set<string> => {
    const scope = conditionScope(parameters, values);
    return new Set(parameters.filter((parameter) => conditionHolds(parameter.visibleIf, scope)).map((parameter) => parameter.name));
};

export type ConditionTest = '==' | '!=' | '>' | '<' | '>=' | '<=';
export const CONDITION_TESTS: ReadonlyArray<{ value: ConditionTest; label: string }> = [
    { value: '==', label: 'is' }, { value: '!=', label: 'is not' }, { value: '>', label: 'is above' },
    { value: '<', label: 'is below' }, { value: '>=', label: 'is at least' }, { value: '<=', label: 'is at most' },
];

/** A condition of one parameter against a number, the kind the editor builds. */
export interface SimpleCondition { name: string; test: ConditionTest; value: number }

/** The simple condition a formula is, or null when it is more than that. */
export const parseCondition = (condition: string): SimpleCondition | null => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(condition);
    return match ? { name: match[1], test: match[2] as ConditionTest, value: Number(match[3]) } : null;
};

export const formatCondition = (condition: SimpleCondition): string => `${condition.name} ${condition.test} ${Number(condition.value.toFixed(4))}`;

// ---- groups and settings ----

export interface ParameterSection {
    /** The group (null for parameters in none). */
    group: GraphParameterGroup | null;
    parameters: GraphParameter[];
}

/**
 * The parameters under their groups: those in none first, then each group in the order the graph keeps
 * them (groups it does not mention in the order their first parameter comes).
 */
export const parameterSections = (parameters: readonly GraphParameter[], groups: readonly GraphParameterGroup[] = []): ParameterSection[] => {
    const loose = parameters.filter((parameter) => !parameter.group);
    const names: string[] = [];
    for (const group of groups) if (parameters.some((parameter) => parameter.group === group.name)) names.push(group.name);
    for (const parameter of parameters) if (parameter.group && !names.includes(parameter.group)) names.push(parameter.group);
    const sections: ParameterSection[] = loose.length ? [{ group: null, parameters: loose }] : [];
    for (const name of names) sections.push({ group: groups.find((group) => group.name === name) ?? { name }, parameters: parameters.filter((parameter) => parameter.group === name) });
    return sections;
};

/** A label "Layer: name" split into the part before the colon and the rest, or null. */
const PREFIXED = /^([^:]{1,48}):\s+(\S.*)$/;

/**
 * Parameters labelled "Layer: name" and in no group put into a group named after the part before the
 * colon, with that part taken off the label (as graphs made from smart materials label theirs). Others
 * as they are; the same list when nothing changes.
 */
export const groupByLabelPrefix = (parameters: readonly GraphParameter[]): GraphParameter[] => {
    let changed = false;
    const next = parameters.map((parameter) => {
        const match = parameter.group ? null : PREFIXED.exec(parameter.label);
        if (!match) return parameter;
        changed = true;
        return { ...parameter, group: match[1].trim(), label: match[2].trim() };
    });
    return changed ? next : [...parameters];
};

/** Whether any parameter could be grouped by its label's prefix. */
export const hasLabelPrefixes = (parameters: readonly GraphParameter[]): boolean => parameters.some((parameter) => !parameter.group && PREFIXED.test(parameter.label));

/** A parameter as a setting: for its value control, and as a setting of a node using the graph. */
export const parameterSetting = (parameter: GraphParameter, parameters?: readonly GraphParameter[]): TexParamDef => {
    const setting: TexParamDef = {
        key: parameter.name,
        label: parameter.label || parameter.name,
        kind: parameter.kind,
        default: parameter.default,
        ...(parameter.min !== undefined ? { min: parameter.min } : {}),
        ...(parameter.max !== undefined ? { max: parameter.max } : {}),
        ...(parameter.softMin !== undefined ? { softMin: parameter.softMin } : {}),
        ...(parameter.softMax !== undefined ? { softMax: parameter.softMax } : {}),
        ...(parameter.step !== undefined ? { step: parameter.step } : {}),
        ...(parameter.options ? { options: parameter.options } : {}),
        ...(parameter.description ? { hint: parameter.description } : {}),
        ...(parameter.group ? { group: parameter.group } : {}),
    };
    if (parameter.visibleIf?.trim() && parameters) {
        const condition = parameter.visibleIf;
        setting.showIf = (values) => conditionHolds(condition, conditionScope(parameters, values));
    }
    return setting;
};

/** A stored parameter group list made safe: names, short words, no doubles. */
export const readGroups = (value: unknown): GraphParameterGroup[] => {
    if (!Array.isArray(value)) return [];
    const groups: GraphParameterGroup[] = [];
    for (const candidate of value.slice(0, 64)) {
        const raw = candidate as Partial<GraphParameterGroup> | null;
        const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 64) : '';
        if (!name || groups.some((group) => group.name === name)) continue;
        const group: GraphParameterGroup = { name };
        if (typeof raw!.description === 'string' && raw!.description.trim()) group.description = raw!.description.trim().slice(0, 256);
        if (raw!.folded === true) group.folded = true;
        groups.push(group);
    }
    return groups;
};

// ---- presets ----

export const MAX_PRESETS = 64;
let presetCounter = 0;
export const newPresetId = (): string => `p${Date.now().toString(36)}${(presetCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Stored presets made safe: values only for parameters the graph has, each of the right shape. */
export const readPresets = (value: unknown, parameters: readonly GraphParameter[]): GraphPreset[] => {
    if (!Array.isArray(value)) return [];
    const presets: GraphPreset[] = [];
    for (const candidate of value.slice(0, MAX_PRESETS)) {
        const raw = candidate as Partial<GraphPreset> | null;
        if (!raw || typeof raw.id !== 'string' || !raw.id || presets.some((preset) => preset.id === raw.id)) continue;
        const values: Record<string, GraphParameterValue> = {};
        const given = raw.values && typeof raw.values === 'object' ? raw.values as Record<string, unknown> : {};
        for (const parameter of parameters) if (given[parameter.name] !== undefined) values[parameter.name] = coerceParameter(parameter.kind, given[parameter.name], parameter.options);
        const preset: GraphPreset = { id: raw.id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : 'Preset', values };
        if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) preset.seed = Math.round(raw.seed);
        presets.push(preset);
    }
    return presets;
};

/** A preset of every parameter's value now (and the seed, when given). */
export const presetFrom = (name: string, parameters: readonly GraphParameter[], values: Readonly<Record<string, unknown>>, seed?: number): GraphPreset => {
    const kept: Record<string, GraphParameterValue> = {};
    for (const parameter of parameters) kept[parameter.name] = coerceParameter(parameter.kind, values[parameter.name] ?? parameter.default, parameter.options);
    return { id: newPresetId(), name: name.trim().slice(0, 64) || 'Preset', values: structuredClone(kept), ...(seed !== undefined ? { seed } : {}) };
};

/** Values with a preset applied: its values for the parameters there are (a preset from another graph sets what matches). */
export const applyPreset = (preset: GraphPreset, parameters: readonly GraphParameter[], values: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...values };
    for (const parameter of parameters) {
        const value = preset.values[parameter.name];
        if (value !== undefined) next[parameter.name] = limitParameter(parameter, coerceParameter(parameter.kind, structuredClone(value), parameter.options));
    }
    return next;
};

/** Whether values are as a preset has them (so the panel can show which preset is in use). */
export const matchesPreset = (preset: GraphPreset, parameters: readonly GraphParameter[], values: Readonly<Record<string, unknown>>): boolean =>
    parameters.every((parameter) => preset.values[parameter.name] === undefined
        || JSON.stringify(coerceParameter(parameter.kind, values[parameter.name] ?? parameter.default, parameter.options)) === JSON.stringify(preset.values[parameter.name]));

export const renamePreset = (presets: readonly GraphPreset[], id: string, name: string): GraphPreset[] =>
    presets.map((preset) => (preset.id === id ? { ...preset, name: name.trim().slice(0, 64) || preset.name } : preset));
export const removePreset = (presets: readonly GraphPreset[], id: string): GraphPreset[] => presets.filter((preset) => preset.id !== id);
/** The list with `preset` in place of the one of its id, or added last. */
export const putPreset = (presets: readonly GraphPreset[], preset: GraphPreset): GraphPreset[] =>
    (presets.some((other) => other.id === preset.id) ? presets.map((other) => (other.id === preset.id ? preset : other)) : [...presets, preset].slice(-MAX_PRESETS));

// ---- variations ----

/** Kinds a variation sheet can vary. */
export const VARIABLE_KINDS: ReadonlySet<GraphParameterKind> = new Set(['float', 'int', 'bool', 'select', 'color', 'vec2']);

const hueTurn = (colour: readonly number[], turn: number): number[] => {
    const [r, g, b] = colour;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const delta = max - min;
    // A grey has no hue to turn: give it some colour to show.
    const saturation = delta < 1e-4 ? 0.6 : delta / (1 - Math.abs(2 * light - 1) || 1);
    let hue = delta < 1e-4 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = ((hue / 6 + turn) % 1 + 1) % 1;
    const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
    const x = chroma * (1 - Math.abs(((hue * 6) % 2) - 1));
    const m = light - chroma / 2;
    const [r1, g1, b1] = hue < 1 / 6 ? [chroma, x, 0] : hue < 2 / 6 ? [x, chroma, 0] : hue < 3 / 6 ? [0, chroma, x] : hue < 4 / 6 ? [0, x, chroma] : hue < 5 / 6 ? [x, 0, chroma] : [chroma, 0, x];
    return [r1 + m, g1 + m, b1 + m, colour[3] ?? 1].map((value) => clamp(value, 0, 1));
};

/**
 * The values a variation sheet shows of a parameter, `count` of them at most: numbers spread evenly over
 * its slider's range (whole numbers without doubles), both ways of a switch, each option of a choice,
 * a colour turned round the hues, a pair along its range. Nothing for kinds that cannot be varied.
 */
export const variationValues = (parameter: GraphParameter, count: number, current?: unknown): GraphParameterValue[] => {
    const n = Math.max(1, Math.round(count));
    const low = parameter.softMin ?? parameter.min ?? 0;
    const high = parameter.softMax ?? parameter.max ?? 1;
    const spread = (index: number) => (n === 1 ? (low + high) / 2 : low + (high - low) * index / (n - 1));
    switch (parameter.kind) {
        case 'float': return Array.from({ length: n }, (_, index) => Number(spread(index).toFixed(6)));
        case 'int': return [...new Set(Array.from({ length: n }, (_, index) => Math.round(spread(index))))];
        case 'bool': return [false, true];
        case 'select': return (parameter.options ?? []).slice(0, n).map((option) => option.value);
        case 'color': {
            const base = Array.isArray(current) ? current.map(Number) : Array.isArray(parameter.default) ? parameter.default.map(Number) : [0.8, 0.3, 0.2, 1];
            return Array.from({ length: n }, (_, index) => hueTurn(base, index / n));
        }
        case 'vec2': return Array.from({ length: n }, (_, index) => [Number(spread(index).toFixed(6)), Number(spread(index).toFixed(6))]);
        default: return [];
    }
};

/** Seeds for a sheet that varies the seed: the one in use first, then others, all different and within 0 to 999. */
export const variationSeeds = (seed: number, count: number): number[] => {
    const seeds: number[] = [];
    for (let index = 0; seeds.length < Math.max(1, Math.round(count)) && index < 4000; index++) {
        const candidate = index === 0 ? ((Math.round(seed) % 1000) + 1000) % 1000 : (Math.round(seed) + index * 137 + Math.floor(index / 7) * 11) % 1000;
        if (!seeds.includes(candidate)) seeds.push(candidate);
    }
    return seeds;
};
