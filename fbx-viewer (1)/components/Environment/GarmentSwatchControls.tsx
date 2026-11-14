import { useMemo, useState } from 'react';
import { FABRIC_FIELDS, readFabricOverrides, type GarmentFabric, type GarmentFabricOverrides } from '../../runtime/garments/fitting';
import { calibrateSwatches, SWATCH_HEADER } from '../../runtime/garments/swatchCalibration';

interface Props {
    fabric: GarmentFabric;
    overrides?: GarmentFabricOverrides;
    weft: number;
    onApply: (values: GarmentFabricOverrides) => void;
}

const display = (value: number) => Number(value.toPrecision(5)).toString();

export function GarmentSwatchControls({ fabric, overrides, weft, onApply }: Props) {
    const [text, setText] = useState('');
    const preview = useMemo(() => {
        if (!text.trim()) return {};
        try { return { result: calibrateSwatches(text, weft) }; }
        catch (e) { return { error: e instanceof Error ? e.message : 'Invalid swatch measurements.' }; }
    }, [text, weft]);
    const result = preview.result;
    return <details className="space-y-2 rounded border border-gray-700 p-2">
        <summary className="cursor-pointer">Fit from swatch measurements</summary>
        <p>Paste CSV or tab-separated measurements. Use unloaded dimensions in mm, tared force in N, and mass in g. For simple shear, move the fixed-separation clamps along warp across the weft gauge.</p>
        <label className="block">Swatch measurements
            <textarea value={text} rows={5} spellCheck={false}
                placeholder={SWATCH_HEADER + '\nwarp,50,100,2,1.85,'}
                className="block w-full rounded border border-gray-700 bg-gray-950 p-1 font-mono text-2xs"
                onChange={event => setText(event.target.value)} />
        </label>
        {preview.error && <p role="alert" className="text-amber-400">{preview.error}</p>}
        {result && <>
            <table className="w-full text-left"><caption className="sr-only">Fitted swatch coefficients and residuals</caption>
                <thead><tr><th>Property</th><th>Fit</th><th>Rows</th><th>RMS error</th></tr></thead>
                <tbody>{result.fits.map(row => {
                    const spec = FABRIC_FIELDS[row.field];
                    return <tr key={row.field}><td>{spec.label}</td><td>{display(row.coefficient * spec.scale)} {spec.unit}</td>
                        <td>{row.count}</td><td title={'Maximum error ' + display(row.maximum) + ' ' + row.residualUnit}>
                            {display(row.rms)} {row.residualUnit}</td></tr>;
                })}</tbody>
            </table>
            {result.shearWeftSource === 'current' && <p>Shear uses the current weft stiffness. Include weft readings to fit both.</p>}
            <button type="button" className="rounded border border-gray-700 px-2 py-1"
                onClick={() => onApply(readFabricOverrides(fabric, { ...overrides, ...result.properties }) ?? {})}>Apply fitted properties</button>
        </>}
    </details>;
}
