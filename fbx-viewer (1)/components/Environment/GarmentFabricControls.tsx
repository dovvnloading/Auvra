import { useRef, useState } from 'react';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { FABRIC_FIELDS, fabricFieldNames, fabricPreset, readFabricOverrides, type FabricField } from '../../runtime/garments/fitting';

type Props = Pick<ComponentInspectorProps, 'component' | 'onChangeProps'>;

export function GarmentFabricControls({ component, onChangeProps }: Props) {
    const { fabric, fabricProperties } = component.props;
    const selected = fabric === 'linen' || fabric === 'silk' ? fabric : 'cotton';
    const preset = fabricPreset(selected);
    const overrides = readFabricOverrides(selected, fabricProperties);
    const [error, setError] = useState('');
    const cancelled = useRef(false);

    function apply(key: FabricField, input: HTMLInputElement, prior: number) {
        const { min, max, scale, label } = FABRIC_FIELDS[key];
        const value = input.valueAsNumber;
        input.value = String(prior);
        if (cancelled.current) { cancelled.current = false; return; }
        if (!Number.isFinite(value) || value < min * scale || value > max * scale) {
            setError(label + ' must be between ' + min * scale + ' and ' + max * scale + '.');
            return;
        }
        setError('');
        if (value === prior) return;
        const next = readFabricOverrides(selected, { ...overrides, [key]: value / scale });
        onChangeProps({ fabricProperties: next ?? {} });
    }

    return <details className="space-y-2 text-2xs text-gray-300">
        <summary className="cursor-pointer">Fabric properties</summary>
        <div className="grid grid-cols-2 gap-1">
            {fabricFieldNames.map(key => {
                const { label, unit, scale, min, max } = FABRIC_FIELDS[key];
                const value = Number(((overrides?.[key] ?? preset[key]) * scale).toPrecision(12));
                return <label key={key} className="block text-gray-400">{unit ? label + ' (' + unit + ')' : label}
                    <input key={selected + '/' + value} type="number" step="any" defaultValue={value}
                        min={min * scale} max={max * scale}
                        className="w-full rounded border border-gray-700 bg-gray-950 px-1.5 py-1 text-gray-200"
                        onFocus={() => { cancelled.current = false; }}
                        onBlur={e => apply(key, e.currentTarget, value)}
                        onKeyDown={e => {
                            if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; }
                            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                        }} />
                </label>;
            })}
        </div>
        <button type="button" disabled={!overrides}
            className="rounded border border-gray-700 px-2 py-1 disabled:opacity-40"
            onClick={() => { setError(''); onChangeProps({ fabricProperties: {} }); }}>Restore preset values</button>
        {error && <p className="text-amber-400" role="alert">{error}</p>}
    </details>;
}
