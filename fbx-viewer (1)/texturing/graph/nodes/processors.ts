import { compileFunction, defaultPixelFunction, defaultValueFunction, glslFunction, readFunctionGraph, type FunctionGraph, type FunctionIr, type FunctionUse, type NamedSetting } from '../functionGraph';
import { anyIn, out, select } from '../nodeKit';
import type { TexGraphNode, TexNodeDef, TexParamDef } from '../types';
import { pixelProcessorCost } from './io';

/**
 * PROCESSORS
 *
 * A Pixel processor works out every pixel with a function graph of the user's own (or GLSL they
 * write); a Value processor works out one number or vector the same way, on the GPU, for settings to
 * follow. Both have named settings of the user's own, which are ordinary settings of the node: each
 * can be exposed as a parameter of the graph, and function graphs read them with Setting nodes.
 */

export const PIXEL_PROCESSOR_TYPE = 'pixelProcessor';
export const VALUE_PROCESSOR_TYPE = 'valueProcessor';
export const PROCESSOR_TYPES: ReadonlySet<string> = new Set([PIXEL_PROCESSOR_TYPE, VALUE_PROCESSOR_TYPE]);

/** The pictures each kind of processor reads. */
export const PROCESSOR_PICTURES: Readonly<Record<string, readonly string[]>> = { [PIXEL_PROCESSOR_TYPE]: ['a', 'b', 'c', 'd'], [VALUE_PROCESSOR_TYPE]: ['a', 'b'] };
export const processorUse = (type: string): FunctionUse => (type === VALUE_PROCESSOR_TYPE ? 'value' : 'pixel');
/** The function a processor of the type starts with (and falls back to when its own cannot be read). */
export const defaultFunctionFor = (type: string): (() => FunctionGraph) => (type === VALUE_PROCESSOR_TYPE ? defaultValueFunction : defaultPixelFunction);

// ---- named settings ----

/** The processors' own setting keys, which a named setting cannot take. */
const FIXED_KEYS: ReadonlySet<string> = new Set(['mode', 'function', 'code', 'output', 'settings', 'seed']);
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
export const MAX_NAMED_SETTINGS = 24;

/** The settings a Pixel processor had before settings were named: four numbers and a tint. */
export const LEGACY_PIXEL_SETTINGS: readonly NamedSetting[] = [
    { key: 'x', label: 'x', kind: 'float', default: 1, min: -10, max: 10 },
    { key: 'y', label: 'y', kind: 'float', default: 0, min: -10, max: 10 },
    { key: 'z', label: 'z', kind: 'float', default: 0, min: -10, max: 10 },
    { key: 'w', label: 'w', kind: 'float', default: 0, min: -10, max: 10 },
    { key: 'tint', label: 'tint', kind: 'color', default: [1, 1, 1, 1] },
];

const KINDS: ReadonlySet<string> = new Set(['float', 'int', 'bool', 'color', 'vec2']);

/** A setting's default made the right shape for its kind. */
export const settingDefault = (kind: NamedSetting['kind'], value: unknown): NamedSetting['default'] => {
    const numbers = (Array.isArray(value) ? value : [value]).map(Number).map((item) => (Number.isFinite(item) ? item : 0));
    switch (kind) {
        case 'bool': return Array.isArray(value) ? Boolean(value[0]) : Boolean(value);
        case 'int': return Math.round(numbers[0] ?? 0);
        case 'color': return [0, 1, 2, 3].map((index) => Math.min(1, Math.max(0, numbers[index] ?? (index === 3 ? 1 : numbers[0] ?? 0))));
        case 'vec2': return [numbers[0] ?? 0, numbers[1] ?? numbers[0] ?? 0];
        default: return numbers[0] ?? 0;
    }
};

/** Stored named settings made safe: known kinds, usable unique names, defaults of the right shape. */
export const readNamedSettings = (value: unknown): NamedSetting[] => {
    if (!Array.isArray(value)) return [];
    const settings: NamedSetting[] = [];
    const keys = new Set<string>();
    for (const candidate of value) {
        if (settings.length >= MAX_NAMED_SETTINGS) break;
        const raw = candidate as Partial<NamedSetting> | null;
        if (!raw || typeof raw.key !== 'string' || !SETTING_KEY.test(raw.key) || FIXED_KEYS.has(raw.key) || keys.has(raw.key)) continue;
        const kind = KINDS.has(String(raw.kind)) ? raw.kind as NamedSetting['kind'] : 'float';
        keys.add(raw.key);
        const setting: NamedSetting = { key: raw.key, label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 48) : raw.key, kind, default: settingDefault(kind, raw.default) };
        if (kind === 'float' || kind === 'int' || kind === 'vec2') {
            const min = Number(raw.min);
            const max = Number(raw.max);
            if (Number.isFinite(min)) setting.min = min;
            if (Number.isFinite(max) && (!Number.isFinite(min) || max > min)) setting.max = max;
        }
        settings.push(setting);
    }
    return settings;
};

/** A key for a new named setting from its label: letters and digits, not one taken. */
export const settingKeyFor = (label: string, taken: Iterable<string>): string => {
    const used = new Set([...taken, ...FIXED_KEYS]);
    const words = label.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
    let base = words.map((word, index) => (index ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())).join('').replace(/^[0-9]+/, '').slice(0, 20) || 'setting';
    if (!SETTING_KEY.test(base)) base = 'setting';
    let key = base;
    for (let index = 2; used.has(key); index++) key = `${base}${index}`;
    return key;
};

/** The node setting a named setting is. */
export const namedSettingParam = (setting: NamedSetting): TexParamDef => {
    const param: TexParamDef = { key: setting.key, label: setting.label, kind: setting.kind, default: setting.default };
    if (setting.kind === 'float' || setting.kind === 'int' || setting.kind === 'vec2') {
        param.min = setting.min ?? (setting.kind === 'vec2' ? -1 : 0);
        param.max = setting.max ?? (setting.kind === 'int' ? 10 : 1);
        param.step = setting.kind === 'int' ? 1 : (param.max - param.min > 20 ? 0.1 : 0.01);
    }
    return param;
};

/**
 * A processor's definition with its named settings among its settings (the same object for the
 * same settings, so views and caches keep it).
 */
const withSettings = new WeakMap<TexNodeDef, Map<string, TexNodeDef>>();
export const processorDefinition = (base: TexNodeDef, node: Pick<TexGraphNode, 'params'>): TexNodeDef => {
    const settings = readNamedSettings(node.params.settings);
    if (!settings.length) return base;
    const key = JSON.stringify(settings);
    let byKey = withSettings.get(base);
    if (!byKey) withSettings.set(base, byKey = new Map());
    let found = byKey.get(key);
    if (!found) {
        found = { ...base, params: [...base.params, ...settings.map(namedSettingParam)] };
        byKey.set(key, found);
        if (byKey.size > 256) byKey.delete(byKey.keys().next().value!);
    }
    return found;
};

/**
 * A stored Pixel processor from before function graphs keeps working as it was: its code, and its
 * four numbers and tint as named settings.
 */
export const migrateProcessorParams = (type: string, own: Readonly<Record<string, unknown>>): Record<string, unknown> | null => {
    if (type !== PIXEL_PROCESSOR_TYPE || own.mode !== undefined) return null;
    const migrated: Record<string, unknown> = { ...own, mode: 'code' };
    if (own.settings === undefined) migrated.settings = LEGACY_PIXEL_SETTINGS.map((setting) => ({ ...setting }));
    return migrated;
};

// ---- the nodes ----

/** Roughly how many samples a pixel of the function takes, for drawing heavy ones in bands. */
const functionCost = (ir: FunctionIr): number => {
    const reads = ir.steps.filter((step) => step.op === 'sample' || step.op === 'sampleGray').length;
    const noises = ir.steps.filter((step) => step.op === 'noise').length * 6;
    return Math.min(1024, Math.max(1, reads + noises + Math.round(ir.steps.length / 8)));
};

/** The processor's function as a pass that writes its result, and roughly what each pixel costs. */
const functionPass = (params: Readonly<Record<string, unknown>>, use: FunctionUse, pictures: readonly string[], fallback: typeof defaultPixelFunction): { fragment: string; cost: number } => {
    const result = compileFunction(readFunctionGraph(params.function, fallback), { use, settings: readNamedSettings(params.settings), pictures });
    if (!result.ir) throw new Error(`Its function graph: ${result.error}`);
    return { fragment: `${glslFunction(result.ir)}\nvoid main() { outColor = fn_result(); }`, cost: functionCost(result.ir) };
};

const functionParam = (fallback: () => unknown, showIf?: TexParamDef['showIf']): TexParamDef => ({
    key: 'function', label: 'Function', kind: 'function', default: fallback(), ...(showIf ? { showIf } : {}),
    hint: 'Open it to edit: every node shows its value as you build it.',
});
const settingsParam: TexParamDef = { key: 'settings', label: 'Named settings', kind: 'settings', default: [] };

export const PIXEL_PROCESSOR: TexNodeDef = {
    type: PIXEL_PROCESSOR_TYPE,
    label: 'Pixel processor',
    category: 'Utility',
    description: 'Works out every pixel with a function graph of your own, or GLSL you write. It reads pictures A to D, its named settings (each can be exposed as a parameter of the graph), where the pixel is and the seed.',
    keywords: ['custom', 'code', 'shader', 'glsl', 'expression', 'per pixel', 'function', 'math', 'formula'],
    inputs: [anyIn('a', 'A'), anyIn('b', 'B'), anyIn('c', 'C'), anyIn('d', 'D')],
    outputs: [out('any')],
    params: [
        select('mode', 'Made with', 'graph', [['graph', 'A function graph'], ['code', 'GLSL code']]),
        functionParam(defaultPixelFunction, (params) => params.mode !== 'code'),
        {
            key: 'code', label: 'Code', kind: 'code', default: 'vec4 v = c_a(uv);\noutColor = v;', showIf: (params) => params.mode === 'code',
            hint: 'Read pictures with c_a(uv) or g_a(uv) (and b, c, d), named settings as p_ and their name, and write outColor.',
        },
        select('output', 'Makes', 'color', [['color', 'Colour'], ['gray', 'Grey']]),
        settingsParam,
    ],
    sizeFrom: 'graph',
    kindOf: (params) => (params.output === 'gray' ? 'gray' : 'color'),
    settingsInShader: true,
    async run(context) {
        const image = context.image(context.outputKind('out'));
        if (context.params.mode === 'code') {
            const code = String(context.params.code ?? '').slice(0, 8000);
            // #line 1: the compiler counts the typed code's lines from 1, so its errors point at them.
            await context.pass(image, `void main() {\nvec2 uv = vUv;\n#line 1\n${code}\n}`, { cost: pixelProcessorCost(code) });
            return { out: image };
        }
        const { fragment, cost } = functionPass(context.params, 'pixel', PROCESSOR_PICTURES[PIXEL_PROCESSOR_TYPE], defaultPixelFunction);
        await context.pass(image, fragment, { cost });
        return { out: image };
    },
};

export const VALUE_PROCESSOR: TexNodeDef = {
    type: VALUE_PROCESSOR_TYPE,
    label: 'Value processor',
    category: 'Utility',
    description: 'Works out one number or vector with a function graph, on the GPU: from pictures A and B (read at any place), its named settings and the seed. Wire it into a setting shown as a pin, which follows it with nothing read back to the CPU, or into a picture input, which it fills flat.',
    keywords: ['value', 'number', 'vector', 'uniform', 'drive setting', 'function', 'math', 'sample', 'parameter'],
    inputs: [anyIn('a', 'A'), anyIn('b', 'B')],
    outputs: [{ key: 'out', label: 'Value', kind: 'value' }],
    params: [functionParam(defaultValueFunction), settingsParam],
    sizeFrom: 'input',
    bypass: false,
    settingsInShader: true,
    async run(context) {
        const image = context.image('color', 1, 1, 32);
        await context.pass(image, functionPass(context.params, 'value', PROCESSOR_PICTURES[VALUE_PROCESSOR_TYPE], defaultValueFunction).fragment);
        return { out: image };
    },
};

export const PROCESSOR_NODES: TexNodeDef[] = [PIXEL_PROCESSOR, VALUE_PROCESSOR];
