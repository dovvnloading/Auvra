import React from 'react';
import { CHANNEL_IS_COLOR, CHANNEL_LABELS, type PaintChannel } from '../../../texturing/paint/paintTypes';
import type { BrushSettings } from '../../../texturing/paint/strokes';
import { fromHex, toHex } from '../../Materials/MaterialParamField';
import { Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';

/** The brush: its size and feel, how it is cast onto the model, and what it lays down on each channel. */

const Row: React.FC<{ label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }> = ({ label, value, min, max, step = 0.01, suffix = '', onChange }) => (
    <label className="flex items-center gap-2 text-2xs text-zinc-400">
        <span className="w-24 shrink-0">{label}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-sky-500" aria-label={label} />
        <span className="w-10 text-right tabular-nums text-zinc-300">{Number(value.toFixed(2))}{suffix}</span>
    </label>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (value: boolean) => void }> = ({ label, checked, onChange }) => (
    <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-sky-500" />{label}
    </label>
);

export const BrushPanel: React.FC<{
    brush: BrushSettings;
    onChange: (brush: BrushSettings) => void;
    channels: readonly PaintChannel[];
    paintingMask: boolean;
    textures: ReadonlyArray<{ id: string; name: string }>;
}> = ({ brush, onChange, channels, paintingMask, textures }) => {
    const set = (patch: Partial<BrushSettings>) => onChange({ ...brush, ...patch });
    return (
        <div className="space-y-4 p-3">
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">{paintingMask ? 'Painting a mask' : 'What it paints'}</div>
                {paintingMask ? (
                    <Row label="Grey" value={brush.maskValue} min={0} max={1} onChange={(maskValue) => set({ maskValue })} />
                ) : channels.map((channel) => {
                    const on = brush.channels.includes(channel);
                    const value = brush.values[channel];
                    return (
                        <div key={channel} className="flex items-center gap-2">
                            <input type="checkbox" checked={on} aria-label={`Paint ${CHANNEL_LABELS[channel]}`} className="accent-sky-500"
                                onChange={(event) => set({ channels: event.target.checked ? [...brush.channels, channel] : brush.channels.filter((item) => item !== channel) })} />
                            <span className={`w-20 text-2xs ${on ? 'text-zinc-200' : 'text-zinc-500'}`}>{CHANNEL_LABELS[channel]}</span>
                            {CHANNEL_IS_COLOR[channel] && channel !== 'normal' ? (
                                <input type="color" value={toHex(value)} aria-label={`${CHANNEL_LABELS[channel]} colour`} disabled={!on}
                                    onChange={(event) => set({ values: { ...brush.values, [channel]: fromHex(event.target.value) as [number, number, number] } })}
                                    className="h-5 w-10 cursor-pointer rounded border border-zinc-700 bg-transparent disabled:opacity-30" />
                            ) : channel === 'normal' ? (
                                <span className="text-2xs text-zinc-500">Flat (smooths detail)</span>
                            ) : (
                                <input type="range" min={0} max={1} step={0.01} value={value[0]} disabled={!on} aria-label={`${CHANNEL_LABELS[channel]} value`}
                                    onChange={(event) => { const v = Number(event.target.value); set({ values: { ...brush.values, [channel]: [v, v, v] } }); }} className="h-1 min-w-0 flex-1 accent-sky-500 disabled:opacity-30" />
                            )}
                        </div>
                    );
                })}
            </section>
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Brush</div>
                <Row label="Size" value={brush.size} min={1} max={400} step={1} suffix="px" onChange={(size) => set({ size })} />
                <Row label="Hardness" value={brush.hardness} min={0} max={1} onChange={(hardness) => set({ hardness })} />
                <Row label="Flow" value={brush.flow} min={0.01} max={1} onChange={(flow) => set({ flow })} />
                <Row label="Opacity" value={brush.opacity} min={0} max={1} onChange={(opacity) => set({ opacity })} />
                <Row label="Spacing" value={brush.spacing} min={0.02} max={2} onChange={(spacing) => set({ spacing })} />
                <Row label="Angle" value={brush.angle} min={-180} max={180} step={1} suffix="°" onChange={(angle) => set({ angle })} />
                <div className="flex items-center gap-2">
                    <span className="w-24 text-2xs text-zinc-400">Shape</span>
                    <Segmented value={brush.shape} options={[{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }, { value: 'picture', label: 'Picture' }]} onChange={(shape) => set({ shape })} label="Brush shape" />
                </div>
                {brush.shape === 'picture' && <Select value={brush.alphaTexture} placeholder="Pick a picture (its brightness)" options={textures.map((texture) => ({ value: texture.id, label: texture.name }))} onChange={(alphaTexture) => set({ alphaTexture: String(alphaTexture) })} className="w-full" />}
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <Toggle label="Pressure sets size" checked={brush.pressureSize} onChange={(pressureSize) => set({ pressureSize })} />
                    <Toggle label="Pressure sets flow" checked={brush.pressureFlow} onChange={(pressureFlow) => set({ pressureFlow })} />
                    <Toggle label="Turn with the stroke" checked={brush.followStroke} onChange={(followStroke) => set({ followStroke })} />
                </div>
            </section>
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Jitter</div>
                <Row label="Size" value={brush.sizeJitter} min={0} max={1} onChange={(sizeJitter) => set({ sizeJitter })} />
                <Row label="Angle" value={brush.angleJitter} min={0} max={1} onChange={(angleJitter) => set({ angleJitter })} />
                <Row label="Scatter" value={brush.scatter} min={0} max={2} onChange={(scatter) => set({ scatter })} />
                <Row label="Flow" value={brush.flowJitter} min={0} max={1} onChange={(flowJitter) => set({ flowJitter })} />
            </section>
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Laying it on</div>
                <Segmented value={brush.projection} options={[{ value: 'screen', label: 'From the screen' }, { value: 'surface', label: 'On the surface' }]} onChange={(projection) => set({ projection })} label="Projection" />
                <p className="text-2xs leading-snug text-zinc-500">{brush.projection === 'screen' ? 'Cast onto what you see; hidden and away-facing parts are left alone.' : 'A disc lying on the surface under the pointer: it wraps round edges.'}</p>
                <Row label="Facing limit" value={brush.facingLimit} min={10} max={179} step={1} suffix="°" onChange={(facingLimit) => set({ facingLimit })} />
                <div className="flex items-center gap-3">
                    <span className="w-24 text-2xs text-zinc-400">Mirror across</span>
                    {(['x', 'y', 'z'] as const).map((axis) => <Toggle key={axis} label={axis.toUpperCase()} checked={brush.symmetry[axis]} onChange={(on) => set({ symmetry: { ...brush.symmetry, [axis]: on } })} />)}
                </div>
            </section>
            <section className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold text-zinc-300">Stencil</span>
                    <Toggle label="Use" checked={brush.stencil.enabled} onChange={(enabled) => set({ stencil: { ...brush.stencil, enabled } })} />
                </div>
                {brush.stencil.enabled && (
                    <>
                        <Select value={brush.stencil.textureId} placeholder="Pick a picture" options={textures.map((texture) => ({ value: texture.id, label: texture.name }))} onChange={(textureId) => set({ stencil: { ...brush.stencil, textureId: String(textureId) } })} className="w-full" />
                        <Row label="Size" value={brush.stencil.scale} min={0.1} max={3} onChange={(scale) => set({ stencil: { ...brush.stencil, scale } })} />
                        <Row label="Turn" value={brush.stencil.rotation} min={-180} max={180} step={1} suffix="°" onChange={(rotation) => set({ stencil: { ...brush.stencil, rotation } })} />
                        <Row label="Across" value={brush.stencil.offsetX} min={-0.5} max={0.5} onChange={(offsetX) => set({ stencil: { ...brush.stencil, offsetX } })} />
                        <Row label="Down" value={brush.stencil.offsetY} min={-0.5} max={0.5} onChange={(offsetY) => set({ stencil: { ...brush.stencil, offsetY } })} />
                        <Row label="Strength" value={brush.stencil.opacity} min={0} max={1} onChange={(opacity) => set({ stencil: { ...brush.stencil, opacity } })} />
                        <p className="text-2xs text-zinc-500">The stencil stays still on the screen while the model turns under it.</p>
                    </>
                )}
            </section>
        </div>
    );
};
