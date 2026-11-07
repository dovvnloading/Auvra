import React, { useRef, useState } from 'react';
import { BrushIcon, TrashIcon } from '../../UI/Icons';
import { BUILT_IN_ALPHAS, BUILT_IN_BRUSHES, PRESSURE_CURVES, applyPreset, loadPresets, presetFrom, savePresets, type BrushPreset } from '../../../texturing/paint/brushLibrary';
import { CHANNEL_IS_COLOR, CHANNEL_LABELS, type PaintChannel } from '../../../texturing/paint/paintTypes';
import type { PreviewHost } from '../../../texturing/paint/previews';
import { MAX_BRUSH_SIZE, type BrushMode, type BrushSettings, type SymmetryAxis } from '../../../texturing/paint/strokes';
import { Button, Popover, Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { ColourFieldRgb } from '../../UI/ColourPicker';
import { MaterialPicker, type MaterialChoice, type MaterialSection } from './MaterialPicker';
import { SliderRow } from './PaintFields';
import { GraphParameterPanel } from '../GraphParameterPanel';
import { stampOutputs } from '../../../texturing/paint/graphStamps';
import type { GraphResolver } from '../../../texturing/graph/registry';
import { DEFAULT_PARTICLES, PARTICLE_PRESETS, type ParticleMotion, type ParticleSettings } from '../../../texturing/paint/particles';

/** The brush: its size and feel, how it is cast onto the model, and what it lays down on each channel. */

/** A setting dragged or typed (typed values keep to the slider's ends). */
const Row: React.FC<{ label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }> = (props) => <SliderRow labelWidth="w-24" {...props} />;

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
    /** Picks the base colour off the model (the paint tab's pick tool). */
    onPick?: () => void;
    /** Materials to paint on whole, and what picking one does. */
    paintWith?: { sections: readonly MaterialSection[]; host: PreviewHost; onPick: (choice: MaterialChoice) => void; onMessage: (message: string) => void };
    onMessage?: (message: string) => void;
    /** Texture graphs a brush can stamp, and how the stamp stands (drawing, or why it cannot be). */
    stamp?: { graphs: ReadonlyArray<{ id: string; name: string }>; resolve: GraphResolver; status: string | null };
}> = ({ brush, onChange, channels, paintingMask, textures, onPick, paintWith, onMessage, stamp }) => {
    const set = (patch: Partial<BrushSettings>) => onChange({ ...brush, ...patch });
    const pickButton = useRef<HTMLButtonElement>(null);
    const [picking, setPicking] = useState(false);
    const saveButton = useRef<HTMLButtonElement>(null);
    const [saving, setSaving] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [saved, setSaved] = useState<BrushPreset[]>(() => loadPresets());
    const [armed, setArmed] = useState<string | null>(null);
    const keep = (next: BrushPreset[]) => {
        if (savePresets(next)) setSaved(next);
        else onMessage?.('The brush could not be kept: this browser is not keeping settings.');
    };
    const offset = brush.symmetry.offset ?? [0, 0, 0];
    const particles = brush.particles ?? DEFAULT_PARTICLES;
    const setParticles = (patch: Partial<ParticleSettings>) => set({ particles: { ...particles, ...patch } });
    const particleHints: Record<ParticleMotion, string> = {
        flow: 'They run down over the surface from under the brush, slowing as they go: drips and leaks.',
        fall: 'They are thrown off the surface and fall back, leaving a speck where each lands: dust and grit.',
        bounce: 'They are thrown off and bounce where they land, leaving a mark at each bounce: splashes.',
    };
    const curve = PRESSURE_CURVES.find((each) => each.curve.every((value, i) => Math.abs(value - (brush.pressureCurve?.[i] ?? 0)) < 1e-6))?.id ?? 'custom';
    const modeHints: Record<BrushMode, string> = {
        paint: 'Lays the brush\'s values on.',
        blur: 'Softens what is painted, more with each pass.',
        sharpen: 'Brings out the detail of what is painted.',
        smudge: 'Pushes what is painted along with the stroke.',
        clone: 'Copies what is painted from another place: Ctrl-click where to copy from, then paint.',
    };
    return (
        <div className="space-y-4 p-3">
            <section className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold text-zinc-300">Brushes</span>
                    <button ref={saveButton} onClick={() => { setSaveName(''); setSaving(true); }} className="text-2xs text-sky-400 hover:text-sky-300">Save this brush</button>
                </div>
                <div className="grid grid-cols-2 gap-1">
                    {[...BUILT_IN_BRUSHES, ...saved].map((preset) => (
                        <div key={preset.id} className="group relative">
                            <button onClick={() => onChange(applyPreset(brush, preset))} title={preset.builtIn ? preset.name : `${preset.name} (saved)`}
                                className="w-full rounded border border-zinc-800 px-2 py-1 text-left text-2xs leading-tight text-zinc-200 hover:bg-zinc-800">{preset.name}</button>
                            {!preset.builtIn && (
                                <button aria-label={armed === preset.id ? `Click again to remove ${preset.name}` : `Remove ${preset.name}`} title={armed === preset.id ? 'Click again to remove it' : 'Remove'}
                                    onMouseLeave={() => setArmed((current) => (current === preset.id ? null : current))}
                                    onClick={() => { if (armed !== preset.id) { setArmed(preset.id); return; } setArmed(null); keep(saved.filter((each) => each.id !== preset.id)); }}
                                    className={`absolute right-0.5 top-0.5 hidden rounded bg-zinc-900/90 p-0.5 group-hover:block ${armed === preset.id ? 'text-red-400' : 'text-zinc-400 hover:text-white'}`}><TrashIcon size={10} /></button>
                            )}
                        </div>
                    ))}
                </div>
                <Popover anchor={saveButton} open={saving} onClose={() => setSaving(false)} width={260} label="Save this brush">
                    <form className="space-y-2 p-2.5" onSubmit={(event) => { event.preventDefault(); keep([...saved, presetFrom(brush, saveName)]); setSaving(false); }}>
                        <div className="text-xs font-semibold text-zinc-200">Save this brush</div>
                        <p className="text-2xs leading-snug text-zinc-500">Keeps how it feels (size, softness, spacing, jitter, pressure, its shape), not what it paints. Kept in this browser.</p>
                        <input aria-label="Brush name" value={saveName} maxLength={48} placeholder="Name" autoFocus onChange={(event) => setSaveName(event.target.value)}
                            className="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-sky-600" />
                        <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setSaving(false)}>Cancel</Button>
                            <Button size="sm" variant="primary" type="submit">Save</Button>
                        </div>
                    </form>
                </Popover>
            </section>
            {paintWith && (
                <section>
                    <button ref={pickButton} onClick={() => setPicking(true)} className="flex w-full items-center gap-2 rounded border border-sky-800/70 bg-sky-950/40 px-2 py-1.5 text-left hover:bg-sky-900/40">
                        <BrushIcon size={14} className="shrink-0 text-sky-400" />
                        <span><span className="block text-xs text-zinc-100">Paint with a material</span><span className="block text-2xs leading-snug text-zinc-400">Steel, rust, a smart material, a picture: every channel in one stroke.</span></span>
                    </button>
                    <Popover anchor={pickButton} open={picking} onClose={() => setPicking(false)} width={340} label="Paint with a material">
                        <MaterialPicker sections={paintWith.sections} host={paintWith.host} onPick={(choice) => { setPicking(false); paintWith.onPick(choice); }} onMessage={paintWith.onMessage} />
                    </Popover>
                </section>
            )}
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
                                <ColourFieldRgb value={value} label={/colour/i.test(CHANNEL_LABELS[channel]) ? CHANNEL_LABELS[channel] : `${CHANNEL_LABELS[channel]} colour`} disabled={!on} className="h-5 w-10" onPick={channel === 'baseColor' ? onPick : undefined}
                                    onChange={(next) => set({ values: { ...brush.values, [channel]: next as [number, number, number] } })} />
                            ) : channel === 'normal' ? (
                                <span className="text-2xs text-zinc-500">Flat (smooths detail)</span>
                            ) : (
                                <SliderRow label={`${CHANNEL_LABELS[channel]} value`} hideLabel value={value[0]} min={0} max={1} disabled={!on}
                                    onChange={(v) => set({ values: { ...brush.values, [channel]: [v, v, v] } })} />
                            )}
                        </div>
                    );
                })}
            </section>
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Brush</div>
                <div className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-2xs text-zinc-400">What it does</span>
                    <Select value={brush.mode ?? 'paint'} options={[{ value: 'paint', label: 'Paint' }, { value: 'blur', label: 'Blur' }, { value: 'sharpen', label: 'Sharpen' }, { value: 'smudge', label: 'Smudge' }, { value: 'clone', label: 'Clone' }]}
                        onChange={(mode) => set({ mode: mode as BrushMode })} className="min-w-0 flex-1" />
                </div>
                <p className="text-2xs leading-snug text-zinc-500">{modeHints[brush.mode ?? 'paint']}</p>
                <Row label="Size" value={brush.size} min={1} max={MAX_BRUSH_SIZE} step={1} suffix="px" onChange={(size) => set({ size })} />
                <Row label="Hardness" value={brush.hardness} min={0} max={1} onChange={(hardness) => set({ hardness })} />
                <Row label="Flow" value={brush.flow} min={0.01} max={1} onChange={(flow) => set({ flow })} />
                <Row label="Opacity" value={brush.opacity} min={0} max={1} onChange={(opacity) => set({ opacity })} />
                <Row label="Spacing" value={brush.spacing} min={0.02} max={2} onChange={(spacing) => set({ spacing })} />
                <Row label="Angle" value={brush.angle} min={-180} max={180} step={1} suffix="°" onChange={(angle) => set({ angle })} />
                <div className="flex items-center gap-2">
                    <span className="w-24 text-2xs text-zinc-400">Shape</span>
                    <Segmented value={brush.shape} options={[{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }, { value: 'picture', label: 'Picture' }, { value: 'graph', label: 'Graph', hint: 'Each dab stamps a texture graph\'s output' }]} onChange={(shape) => set({ shape })} label="Brush shape" />
                </div>
                {brush.shape === 'graph' && stamp && (
                    <div className="space-y-1.5">
                        <Select value={brush.graphStamp?.graphId ?? ''} placeholder="Pick a texture graph to stamp" options={stamp.graphs.map((graph) => ({ value: graph.id, label: graph.name }))}
                            onChange={(graphId) => set({ graphStamp: { graphId: String(graphId), output: '', values: {} } })} className="w-full" />
                        {brush.graphStamp && (() => {
                            const entry = stamp.resolve(brush.graphStamp.graphId);
                            const outputs = stampOutputs(stamp.resolve, brush.graphStamp.graphId);
                            const current = brush.graphStamp;
                            return (
                                <>
                                    {outputs.length > 1 && <Select value={current.output || outputs[0].id} options={outputs.map((output) => ({ value: output.id, label: output.label }))} onChange={(output) => set({ graphStamp: { ...current, output: String(output) } })} className="w-full" />}
                                    {entry && <GraphParameterPanel parameters={entry.graph.parameters} groups={entry.graph.groups} values={current.values} textures={textures} onChange={(values) => set({ graphStamp: { ...current, values } })} />}
                                    {stamp.status && <p className="text-2xs leading-snug text-zinc-500">{stamp.status}</p>}
                                </>
                            );
                        })()}
                        <p className="text-2xs leading-snug text-zinc-500">Each dab stamps the graph's output (its brightness), turned and sized as the brush is; the brush's values are what it lays on.</p>
                    </div>
                )}
                {brush.shape === 'picture' && <Select value={brush.alphaTexture} placeholder="Pick an alpha (its brightness)" options={[...BUILT_IN_ALPHAS.map((alpha) => ({ value: alpha.id, label: alpha.name })), ...textures.map((texture) => ({ value: texture.id, label: texture.name }))]} onChange={(alphaTexture) => set({ alphaTexture: String(alphaTexture) })} className="w-full" />}
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <Toggle label="Pressure sets size" checked={brush.pressureSize} onChange={(pressureSize) => set({ pressureSize })} />
                    <Toggle label="Pressure sets flow" checked={brush.pressureFlow} onChange={(pressureFlow) => set({ pressureFlow })} />
                    <Toggle label="Turn with the stroke" checked={brush.followStroke} onChange={(followStroke) => set({ followStroke })} />
                    <Toggle label="Turn with the pen's tilt" checked={Boolean(brush.tiltAngle)} onChange={(tiltAngle) => set({ tiltAngle })} />
                    <Toggle label="Build up within a stroke" checked={Boolean(brush.buildUp)} onChange={(buildUp) => set({ buildUp })} />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-2xs text-zinc-400">Pressure curve</span>
                    <Select value={curve} options={[...PRESSURE_CURVES.map((each) => ({ value: each.id, label: each.name })), ...(curve === 'custom' ? [{ value: 'custom', label: 'Its own' }] : [])]}
                        onChange={(id) => { const picked = PRESSURE_CURVES.find((each) => each.id === id); if (picked) set({ pressureCurve: [...picked.curve] as BrushSettings['pressureCurve'] }); }} className="min-w-0 flex-1" />
                    <svg viewBox="0 0 1 1" className="h-5 w-5 shrink-0 rounded-sm border border-zinc-700 bg-zinc-950" aria-hidden>
                        <path d={`M0 1 C${brush.pressureCurve?.[0] ?? 0.25} ${1 - (brush.pressureCurve?.[1] ?? 0.25)} ${brush.pressureCurve?.[2] ?? 0.75} ${1 - (brush.pressureCurve?.[3] ?? 0.75)} 1 0`} fill="none" stroke="currentColor" strokeWidth={0.08} className="text-sky-400" />
                    </svg>
                </div>
                <Row label="Lazy mouse" value={brush.lazy ?? 0} min={0} max={200} step={1} suffix="px" onChange={(lazy) => set({ lazy })} />
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
                <Select value={brush.projection} options={[{ value: 'screen', label: 'From the screen' }, { value: 'surface', label: 'On the surface' }, { value: 'planar', label: 'Flat along an axis' }, { value: 'triplanar', label: 'From three sides' }]} onChange={(projection) => set({ projection: projection as BrushSettings['projection'] })} className="w-full" />
                <p className="text-2xs leading-snug text-zinc-500">{{
                    screen: 'Cast onto what you see; hidden and away-facing parts are left alone.',
                    surface: 'A disc lying on the surface under the pointer: it wraps round edges.',
                    planar: 'Cast straight along one axis through whatever lies under the brush, as a decal is, within three brush widths either side.',
                    triplanar: 'Cast along each of the model\'s three axes and blended by how the surface faces, so it runs on round corners without stretching.',
                }[brush.projection]}</p>
                {brush.projection === 'planar' && (
                    <div className="flex items-center gap-2">
                        <span className="w-24 text-2xs text-zinc-400">Along</span>
                        <Segmented value={brush.planarAxis ?? 'view'} options={[{ value: 'view', label: 'The view' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} onChange={(planarAxis) => set({ planarAxis: planarAxis as BrushSettings['planarAxis'] })} label="Flat brush axis" />
                    </div>
                )}
                <Row label="Facing limit" value={brush.facingLimit} min={10} max={179} step={1} suffix="°" onChange={(facingLimit) => set({ facingLimit })} />
                <div className="flex items-center gap-3">
                    <span className="w-24 text-2xs text-zinc-400">Mirror across</span>
                    {(['x', 'y', 'z'] as const).map((axis) => <Toggle key={axis} label={axis.toUpperCase()} checked={brush.symmetry[axis]} onChange={(on) => set({ symmetry: { ...brush.symmetry, [axis]: on } })} />)}
                </div>
                {(['x', 'y', 'z'] as const).map((axis, i) => brush.symmetry[axis] && (
                    <Row key={axis} label={`${axis.toUpperCase()} mirror at`} value={offset[i]} min={-0.5} max={0.5}
                        onChange={(value) => set({ symmetry: { ...brush.symmetry, offset: offset.map((each, j) => (j === i ? value : each)) as [number, number, number] } })} />
                ))}
                <Row label="Turned copies" value={brush.radial?.count ?? 1} min={1} max={16} step={1} onChange={(count) => set({ radial: { axis: brush.radial?.axis ?? 'y', count } })} />
                {(brush.radial?.count ?? 1) > 1 && (
                    <div className="flex items-center gap-2">
                        <span className="w-24 text-2xs text-zinc-400">Round the axis</span>
                        <Segmented value={brush.radial?.axis ?? 'y'} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} onChange={(axis) => set({ radial: { count: brush.radial?.count ?? 1, axis: axis as SymmetryAxis } })} label="Radial axis" />
                    </div>
                )}
                <p className="text-2xs leading-snug text-zinc-500">Mirrors sit at the model's middle, moved by a share of its size; turned copies go round the axis through the same point. Up to 16 copies in all.</p>
            </section>
            <section className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold text-zinc-300">Particles</span>
                    <Toggle label="Use" checked={particles.enabled} onChange={(enabled) => setParticles({ enabled })} />
                </div>
                {particles.enabled && (
                    <>
                        <div className="flex flex-wrap gap-1">
                            {PARTICLE_PRESETS.map((preset) => (
                                <Button key={preset.id} size="sm" variant="ghost" onClick={() => set({ particles: structuredClone(preset.settings) })}>{preset.name}</Button>
                            ))}
                        </div>
                        <Segmented value={particles.motion} options={[{ value: 'flow', label: 'Run down' }, { value: 'fall', label: 'Fall' }, { value: 'bounce', label: 'Bounce' }]} onChange={(motion) => setParticles({ motion })} label="How particles move" />
                        <p className="text-2xs leading-snug text-zinc-500">{particleHints[particles.motion]}</p>
                        <Row label="Per dab" value={particles.count} min={1} max={40} step={1} onChange={(count) => setParticles({ count })} />
                        <Row label="Spread" value={particles.spread} min={0} max={1} onChange={(spread) => setParticles({ spread })} />
                        <Row label="Speed" value={particles.speed} min={0} max={2} step={0.01} onChange={(speed) => setParticles({ speed })} />
                        <Row label="Gravity" value={particles.gravity} min={0} max={5} step={0.05} onChange={(gravity) => setParticles({ gravity })} />
                        <Row label="Life" value={particles.life} min={0.1} max={6} step={0.1} suffix="s" onChange={(life) => setParticles({ life })} />
                        <Row label="Size at start" value={particles.sizeStart} min={0.01} max={1} onChange={(sizeStart) => setParticles({ sizeStart })} />
                        <Row label="Size at end" value={particles.sizeEnd} min={0.01} max={1} onChange={(sizeEnd) => setParticles({ sizeEnd })} />
                        <Row label="Wander" value={particles.wander} min={0} max={1} onChange={(wander) => setParticles({ wander })} />
                        {particles.motion === 'bounce' && <Row label="Bounce" value={particles.bounce} min={0} max={1} onChange={(bounce) => setParticles({ bounce })} />}
                        <Toggle label="Paint where the brush is too" checked={particles.paintAtBrush} onChange={(paintAtBrush) => setParticles({ paintAtBrush })} />
                        <p className="text-2xs leading-snug text-zinc-500">Speed and gravity are in shares of the set's size a second; gravity pulls down the model's Y axis. Sizes are shares of the brush. Particles move over this texture set only, in the 3D view.</p>
                    </>
                )}
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
                        <p className="text-2xs leading-snug text-zinc-500">Shown faintly over the view, in its picture's proportions. It stays still on the screen while the model turns under it, whether the brush is laid on from the screen or on the surface.</p>
                    </>
                )}
            </section>
        </div>
    );
};
