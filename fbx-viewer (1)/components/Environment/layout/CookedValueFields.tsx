import React from 'react';
import { DiceIcon } from '../../UI/Icons';
import { IconButton } from '../../UI/kit';
import { GRAPH_SEED } from '../../../runtime/materials/materialCooking';
import type { MaterialAsset } from '../../../runtime/materials/materialLibrary';
import type { MaterialParameterSetting } from '../../../utils/materialOverrides';

/**
 * A placed object's own values for a material its texture graph makes (runtime/materials/materialCooking.ts): its
 * graph's number parameters and a seed of its own. The game cooks this object's pictures for them (shared with every
 * object asking for the same), where its Texture graph pictures setting lets it.
 */

interface NumberParameter { name: string; label: string; min?: number; max?: number; step?: number; integer: boolean; fallback: number }

/** The texture graph's parameters an object can set here: numbers. */
const numberParameters = (asset: MaterialAsset): NumberParameter[] => {
    const stored = asset.textureGraph as { graph?: { parameters?: Array<Record<string, unknown>> }; values?: Record<string, unknown> } | undefined;
    return (stored?.graph?.parameters ?? []).flatMap((parameter) => {
        const name = typeof parameter.name === 'string' ? parameter.name : '';
        if (!name || (parameter.kind !== 'float' && parameter.kind !== 'int')) return [];
        const given = stored?.values?.[name] ?? parameter.default;
        return [{
            name,
            label: typeof parameter.label === 'string' && parameter.label ? parameter.label : name,
            ...(typeof parameter.min === 'number' ? { min: parameter.min } : {}),
            ...(typeof parameter.max === 'number' ? { max: parameter.max } : {}),
            ...(typeof parameter.step === 'number' ? { step: parameter.step } : {}),
            integer: parameter.kind === 'int',
            fallback: typeof given === 'number' ? given : 0,
        }];
    });
};

/** The settings with one value set (or left to the material when undefined). */
const withValue = (settings: readonly MaterialParameterSetting[] | undefined, name: string, value: number | undefined): MaterialParameterSetting[] | undefined => {
    const next = (settings ?? []).filter(setting => setting.name !== name);
    if (value !== undefined) next.push({ name, value });
    return next.length ? next : undefined;
};

export const CookedValueFields: React.FC<{
    asset: MaterialAsset;
    values: readonly MaterialParameterSetting[] | undefined;
    onChange: (parameters: MaterialParameterSetting[] | undefined) => void;
}> = ({ asset, values, onChange }) => {
    const valueOf = (name: string): number | undefined => {
        const found = values?.find(setting => setting.name === name)?.value;
        return typeof found === 'number' ? found : undefined;
    };
    const seed = valueOf(GRAPH_SEED);
    const field = 'w-full rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-xs text-white';
    const set = (name: string, text: string, integer = false) => {
        const number = Number(text);
        onChange(withValue(values, name, text.trim() === '' || !Number.isFinite(number) ? undefined : integer ? Math.round(number) : number));
    };
    return (
        <div className="space-y-1.5 rounded border border-gray-800 p-2">
            <div className="text-2xs font-semibold text-gray-400">Picture variation</div>
            <p className="text-2xs leading-snug text-gray-500">The game cooks this object's pictures from the material's texture graph with these values. Blank keeps the material's own.</p>
            <label className="flex items-center gap-2 text-2xs text-gray-400">
                <span className="w-24 shrink-0">Seed</span>
                <input type="number" step={1} aria-label="Graph seed" value={seed ?? ''} placeholder="The material's" onChange={(event) => set(GRAPH_SEED, event.target.value, true)} className={field} />
                <IconButton label="A new seed for this object" onClick={() => onChange(withValue(values, GRAPH_SEED, Math.floor(Math.random() * 10000)))}><DiceIcon size={12} /></IconButton>
            </label>
            {numberParameters(asset).map(parameter => (
                <label key={parameter.name} className="flex items-center gap-2 text-2xs text-gray-400">
                    <span className="w-24 shrink-0 truncate" title={parameter.label}>{parameter.label}</span>
                    <input type="number" aria-label={parameter.label} min={parameter.min} max={parameter.max} step={parameter.step ?? (parameter.integer ? 1 : 0.01)}
                        value={valueOf(parameter.name) ?? ''} placeholder={String(parameter.fallback)}
                        onChange={(event) => set(parameter.name, event.target.value, parameter.integer)} className={field} />
                </label>
            ))}
        </div>
    );
};
