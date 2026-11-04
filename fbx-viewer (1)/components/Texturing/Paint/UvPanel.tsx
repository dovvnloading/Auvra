import React, { useSyncExternalStore } from 'react';
import { Check, Grid3x3, Package, RotateCw, Scissors, Wand2, X } from 'lucide-react';
import { Button, Segmented, Spinner } from '../../UI/kit';
import type { UvSession, UvStats } from './uvSession';

/** Unwrapping, seams, packing and texel density of a texture set, with figures for the layout. */

const Row: React.FC<{ label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }> = ({ label, value, min, max, step = 1, suffix = '', onChange }) => (
    <label className="flex items-center gap-2 text-2xs text-zinc-400">
        <span className="w-28 shrink-0">{label}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-sky-500" aria-label={label} />
        <span className="w-12 text-right tabular-nums text-zinc-300">{Number(value.toFixed(2))}{suffix}</span>
    </label>
);

const Figures: React.FC<{ title: string; stats: UvStats; size: number }> = ({ title, stats, size }) => (
    <div className="space-y-1 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-2xs">
        <div className="font-semibold text-zinc-300">{title}</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-zinc-400">
            <span>Islands</span><span className="text-right tabular-nums text-zinc-200">{stats.islands}</span>
            <span>Picture used</span><span className="text-right tabular-nums text-zinc-200">{Math.round(stats.coverage * 100)}%</span>
            <span>Stretch (mean / worst)</span><span className="text-right tabular-nums text-zinc-200">{stats.stretch.mean.toFixed(2)} / {stats.stretch.worst > 20 ? '20+' : stats.stretch.worst.toFixed(1)}</span>
            <span>Folded or overlapping</span><span className={`text-right tabular-nums ${stats.folded ? 'text-red-400' : 'text-zinc-200'}`} title="Triangles that face against their island or lie over others: those places share texels, so painting one paints the other. Shown in magenta in the UV stretch view.">{stats.folded}</span>
            <span>Texel density</span><span className="text-right tabular-nums text-zinc-200">{Math.round(stats.density.mean)} px/unit</span>
            <span>Density spread</span><span className="text-right tabular-nums text-zinc-200">{Math.round(stats.density.low)}–{Math.round(stats.density.high)}</span>
        </div>
        <div className="text-zinc-600">at {size} × {size}{stats.tiles > 1 ? `, on each of ${stats.tiles} UDIM tiles` : ''}</div>
    </div>
);

export const UvPanel: React.FC<{ uv: UvSession; onSeamTool: () => void; onApplied: () => void }> = ({ uv, onSeamTool, onApplied }) => {
    useSyncExternalStore(uv.subscribe, uv.getVersion);
    const busy = Boolean(uv.busy);
    const set = uv.unwrapSettings;
    const pack = uv.packSettings;
    const touch = () => uv.repack();
    const size = uv.paint.stack.size;
    return (
        <div className="space-y-4 p-3">
            <Figures title="Current layout" stats={uv.current} size={size} />
            {uv.proposal && <Figures title="New layout (not used yet)" stats={uv.proposal.stats} size={size} />}

            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Seams and unwrapping</div>
                <p className="text-2xs leading-snug text-zinc-500">Seams are where the surface is cut to lie flat. Orange lines on the model show them; the seam tool adds or removes one with a click (Shift removes).</p>
                <Row label="Always cut over" value={set.hardAngle} min={20} max={120} suffix="°" onChange={(hardAngle) => { uv.unwrapSettings = { ...set, hardAngle }; touchVersion(uv); }} />
                <Row label="Piece curvature" value={set.coneAngle} min={20} max={110} suffix="°" onChange={(coneAngle) => { uv.unwrapSettings = { ...set, coneAngle }; touchVersion(uv); }} />
                <Row label="Stretch allowed" value={set.stretchLimit} min={1.1} max={4} step={0.05} onChange={(stretchLimit) => { uv.unwrapSettings = { ...set, stretchLimit }; touchVersion(uv); }} />
                <div className="grid grid-cols-2 gap-1.5">
                    <Button size="sm" disabled={busy} icon={<Wand2 size={12} />} onClick={() => uv.unwrapAuto(false)}>Unwrap afresh</Button>
                    <Button size="sm" disabled={busy} icon={<Wand2 size={12} />} onClick={() => uv.unwrapAuto(true)}>Unwrap, keep seams</Button>
                    <Button size="sm" disabled={busy} icon={<Scissors size={12} />} onClick={onSeamTool}>Seam tool</Button>
                    <Button size="sm" disabled={busy} icon={<Scissors size={12} />} onClick={() => uv.unwrapWithSeams()}>Unwrap these seams</Button>
                </div>
            </section>

            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Packing</div>
                <Row label="Padding" value={pack.padding} min={0} max={32} suffix="px" onChange={(padding) => { uv.packSettings = { ...pack, padding }; touchVersion(uv); }} />
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">Turn islands</span>
                    <Segmented value={pack.rotate ? 'yes' : 'no'} options={[{ value: 'yes', label: 'To fit best' }, { value: 'no', label: 'Never' }]} onChange={(value) => { uv.packSettings = { ...pack, rotate: value === 'yes' }; touchVersion(uv); }} label="Turn islands" />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">UDIM tiles</span>
                    <Segmented value={`${pack.tilesX}x${pack.tilesY}`} options={[{ value: '1x1', label: 'One' }, { value: '2x1', label: '2' }, { value: '2x2', label: '4' }, { value: '4x2', label: '8' }]}
                        onChange={(value) => { const [x, y] = value.split('x').map(Number); uv.packSettings = { ...pack, tilesX: x, tilesY: y }; touchVersion(uv); }} label="UDIM tiles" />
                </div>
                <Button size="sm" className="w-full justify-center" disabled={busy} icon={<Package size={12} />} onClick={touch}>{uv.proposal ? 'Pack again' : 'Pack the current islands'}</Button>
                <p className="text-2xs leading-snug text-zinc-500">Every island gets the same texel density, follows its size on the model, and is turned to its tightest box. In the UV view, drag islands to move them, R turns the selected ones, + and − scale them.</p>
            </section>

            {uv.proposal && (
                <section className="space-y-2">
                    <div className="flex gap-1.5">
                        <Button variant="primary" className="flex-1 justify-center" disabled={busy} icon={busy ? <Spinner /> : <Check size={13} />} onClick={() => void uv.apply().then(onApplied)}>{uv.busy ?? 'Use this layout'}</Button>
                        <Button disabled={busy} icon={<X size={13} />} onClick={() => uv.discard()}>Discard</Button>
                    </div>
                    <p className="text-2xs leading-snug text-zinc-500">The model's meshes are split along the new seams and saved with the project. Its own pictures and every painted layer are carried over, so it looks the same.</p>
                </section>
            )}
            {busy && !uv.proposal && <p className="flex items-center gap-2 text-2xs text-zinc-400"><Spinner /> {uv.busy}</p>}
            {uv.status && <p className="text-2xs text-sky-300">{uv.status}</p>}
            <p className="flex items-center gap-1 text-2xs text-zinc-600"><Grid3x3 size={11} /><RotateCw size={11} /> Show “UV checker” or “UV stretch” to judge a layout on the model.</p>
        </div>
    );
};

/** Settings changed: redraw the panel (the session reads them when it next runs). */
const touchVersion = (uv: UvSession) => uv.emit();
