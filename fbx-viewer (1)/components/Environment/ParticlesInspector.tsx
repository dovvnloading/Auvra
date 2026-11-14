import React, { useEffect, useState } from 'react';
import { PlusIcon, SparklesIcon, TrashIcon } from '../UI/Icons';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import {
    BUILTIN_SPRITES,
    createParticleForceField,
    MAX_PARTICLE_FORCE_FIELDS,
    PARTICLE_BLENDINGS,
    PARTICLE_COLLISION_MODES,
    PARTICLE_CURL_DEFAULTS,
    PARTICLE_FRAME_MODES,
    PARTICLE_FORCE_FIELD_KINDS,
    particleEmitterName,
    PARTICLE_PRESET_IDS,
    PARTICLE_PRESET_LABELS,
    PARTICLE_PRESETS,
    PARTICLE_RENDER_MODES,
    PARTICLE_SHAPES,
    PARTICLE_SIMULATION_MODES,
    resolveParticleEffect,
    sanitizeParticleEffect,
    SUB_EMITTER_TRIGGERS,
    type Gradient,
    type ParticleEffect,
    type ParticleForceField,
    type ParticlePresetId,
    type Range,
    type Vec3,
} from '../../runtime/particleEffect';
import { ParticleCurveEditor } from './ParticleCurveEditor';
import { ColourField } from '../UI/ColourPicker';

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200 focus:outline-none focus:border-amber-500';
const BUTTON = 'flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-2xs text-gray-200';
const LABEL = 'text-2xs text-gray-400';

const SHAPE_LABELS: Record<string, string> = {
    point: 'Point', sphere: 'Sphere', hemisphere: 'Hemisphere', cone: 'Cone', box: 'Box', circle: 'Disc', edge: 'Line', mesh: "Model's surface",
};
const MODE_LABELS: Record<string, string> = {
    billboard: 'Facing the camera', stretched: 'Stretched along motion', horizontal: 'Flat (facing up)', vertical: 'Upright', ribbon: 'Ribbon (trail)',
};

const FORCE_HINTS: Record<ParticleForceField['kind'], string> = {
    radial: 'Positive strength pulls toward the center. Negative strength pushes outward.',
    vortex: 'Particles turn around the axis. Negative strength reverses the swirl.',
    directional: 'Positive strength pushes along the axis. Negative strength pushes against it.',
    curl: 'Scale sets swirl size. A seed repeats the pattern. Evolution 0 holds it still. Arrows show the flow at 1 s.',
};

/** A number typed in and taken on Enter or when the field is left. */
const NumberInput: React.FC<{ label: string; value: number; onCommit: (value: number) => void; step?: number }> = ({ label, value, onCommit, step = 0.1 }) => {
    const shown = String(Math.round(value * 1000) / 1000);
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const take = () => {
        const parsed = Number(text);
        setText(shown);
        if (text.trim() && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
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

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <label className="grid grid-cols-[96px_1fr] items-center gap-1">
        <span className={LABEL}>{label}</span>
        <div className="flex gap-1 min-w-0">{children}</div>
    </label>
);

const Section: React.FC<{ title: string; open?: boolean; children: React.ReactNode }> = ({ title, open = false, children }) => (
    <details open={open} className="rounded border border-gray-800 bg-gray-900/50">
        <summary className="cursor-pointer select-none px-2 py-1 text-2xs font-bold text-gray-400">{title}</summary>
        <div className="space-y-1 px-2 pb-2">{children}</div>
    </details>
);

const Select = <T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (value: T) => void }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)} className={FIELD}>
        {options.map(option => <option key={option} value={option}>{labels?.[option] ?? option}</option>)}
    </select>
);

const Toggle: React.FC<{ label: string; value: boolean; onChange: (value: boolean) => void }> = ({ label, value, onChange }) => (
    <input aria-label={label} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 accent-amber-500" />
);

const RangeInputs: React.FC<{ label: string; value: Range; step?: number; onCommit: (value: Range) => void }> = ({ label, value, step, onCommit }) => (
    <Row label={label}>
        <NumberInput label={`${label} from`} value={value[0]} step={step} onCommit={(from) => onCommit([from, Math.max(from, value[1])])} />
        <NumberInput label={`${label} to`} value={value[1]} step={step} onCommit={(to) => onCommit([Math.min(value[0], to), to])} />
    </Row>
);

const VectorInputs: React.FC<{ label: string; value: Vec3; step?: number; onCommit: (value: Vec3) => void }> = ({ label, value, step, onCommit }) => (
    <fieldset className="min-w-0">
        <legend className={LABEL}>{label}</legend>
        <div className="grid grid-cols-3 gap-1">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <label key={axis} className="flex min-w-0 items-center gap-1">
                    <span className="text-2xs text-gray-500">{axis}</span>
                    <NumberInput label={`${label} ${axis}`} value={value[i]} step={step} onCommit={(next) => {
                        const out: Vec3 = [...value];
                        out[i] = next;
                        onCommit(out);
                    }} />
                </label>
            ))}
        </div>
    </fieldset>
);

const ColorInput: React.FC<{ label: string; value: string; onCommit: (value: string) => void }> = ({ label, value, onCommit }) => (
    <ColourField label={label} value={value} onChange={onCommit} className="h-5 w-10" />
);

const hexAlpha = (hex: string, alpha: number) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
};

/** A gradient's stops over a preview strip: position, colour and alpha each, added and removed. */
const GradientEditor: React.FC<{ label: string; value: Gradient; onCommit: (value: Gradient) => void }> = ({ label, value, onCommit }) => {
    const stops = value.stops;
    const set = (index: number, patch: Partial<Gradient['stops'][number]>) =>
        onCommit({ stops: stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)).sort((a, b) => a.t - b.t) });
    const strip = `linear-gradient(to right, ${stops.map(stop => `${hexAlpha(stop.color, stop.alpha)} ${stop.t * 100}%`).join(', ')}), repeating-conic-gradient(#333 0% 25%, #555 0% 50%) 50% / 10px 10px`;
    return (
        <div className="space-y-1">
            <div className={LABEL}>{label}</div>
            <div aria-label={`${label} preview`} className="h-4 rounded border border-gray-700" style={{ background: strip }} />
            {stops.map((stop, index) => (
                <div key={index} className="grid grid-cols-[1fr_44px_1fr_20px] items-center gap-1">
                    <NumberInput label={`${label} stop ${index + 1} position`} value={stop.t} step={0.05} onCommit={(t) => set(index, { t: Math.min(1, Math.max(0, t)) })} />
                    <ColorInput label={`${label} stop ${index + 1} colour`} value={stop.color} onCommit={(color) => set(index, { color })} />
                    <NumberInput label={`${label} stop ${index + 1} alpha`} value={stop.alpha} step={0.05} onCommit={(alpha) => set(index, { alpha: Math.min(1, Math.max(0, alpha)) })} />
                    <button type="button" aria-label={`Remove ${label} stop ${index + 1}`} disabled={stops.length <= 1} onClick={() => onCommit({ stops: stops.filter((_, i) => i !== index) })} className="text-gray-500 hover:text-red-400 disabled:opacity-30"><TrashIcon size={11} /></button>
                </div>
            ))}
            {stops.length < 8 && (
                <button type="button" className={BUTTON} onClick={() => onCommit({ stops: [...stops, { t: 1, color: stops[stops.length - 1]?.color ?? '#ffffff', alpha: 1 }].sort((a, b) => a.t - b.t) })}>
                    <PlusIcon size={10} /> Stop
                </button>
            )}
        </div>
    );
};

const ForceFieldEditor: React.FC<{ fields: ParticleForceField[]; onChange: (fields: ParticleForceField[]) => void }> = ({ fields, onChange }) => {
    const edit = (index: number, patch: Partial<ParticleForceField>) =>
        onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field));
    return (
        <Section title="Force fields" open={fields.length > 0}>
            {fields.map((field, index) => (
                <fieldset key={index} className="min-w-0 space-y-1 border-b border-gray-800 pb-2">
                    <legend className="text-2xs font-semibold text-gray-300">Field {index + 1}</legend>
                    <div className="flex items-center gap-1">
                        <Toggle label="Field enabled" value={field.enabled} onChange={(enabled) => edit(index, { enabled })} />
                        <Select label="Field type" value={field.kind} options={PARTICLE_FORCE_FIELD_KINDS} labels={{ radial: 'Radial', vortex: 'Vortex', directional: 'Directional', curl: 'Curl noise' }} onChange={(kind) => edit(index, { kind })} />
                        <button type="button" aria-label={`Remove field ${index + 1}`} className={BUTTON} onClick={() => onChange(fields.filter((_, i) => i !== index))}><TrashIcon size={11} /></button>
                    </div>
                    <VectorInputs label="Center (m)" value={field.center} onCommit={(center) => edit(index, { center })} />
                    {(field.kind === 'directional' || field.kind === 'vortex') && <VectorInputs label="Axis" value={field.axis} onCommit={(axis) => edit(index, { axis })} />}
                    <Row label="Radius (m)"><NumberInput label="Field radius" value={field.radius} onCommit={(radius) => edit(index, { radius })} /></Row>
                    <Row label="Strength (m/s²)"><NumberInput label="Field strength" value={field.strength} onCommit={(strength) => edit(index, { strength })} /></Row>
                    {field.kind === 'curl' && <>
                        <Row label="Swirl scale (m)"><NumberInput label="Curl swirl scale" value={field.scale ?? PARTICLE_CURL_DEFAULTS.scale} step={0.05} onCommit={(scale) => edit(index, { scale })} /></Row>
                        <Row label="Evolution (rad/s)"><NumberInput label="Curl evolution" value={field.evolution ?? PARTICLE_CURL_DEFAULTS.evolution} onCommit={(evolution) => edit(index, { evolution })} /></Row>
                        <Row label="Seed"><NumberInput label="Curl seed" value={field.seed ?? PARTICLE_CURL_DEFAULTS.seed} step={1} onCommit={(seed) => edit(index, { seed })} /></Row>
                    </>}
                    <p className={LABEL}>{FORCE_HINTS[field.kind]}</p>
                    <Row label="Falloff exponent"><NumberInput label="Field falloff" value={field.falloff} step={0.25} onCommit={(falloff) => edit(index, { falloff })} /></Row>
                </fieldset>
            ))}
            {fields.length > 0 && <p className={LABEL}>Centers follow the emitter. Higher falloff concentrates the field toward its center.</p>}
            <button type="button" className={BUTTON + ' disabled:opacity-40'} disabled={fields.length >= MAX_PARTICLE_FORCE_FIELDS} onClick={() => onChange([...fields, createParticleForceField()])}>
                <PlusIcon size={10} /> Add force field ({fields.length}/{MAX_PARTICLE_FORCE_FIELDS})
            </button>
        </Section>
    );
};

/** The Particles component's effect: a preset to start from, and every module of it. */
export const ParticlesInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { textures } = useScene();
    const effect = resolveParticleEffect(component.props);
    const update = (patch: Partial<ParticleEffect>) => onChangeProps({ effect: sanitizeParticleEffect({ ...effect, ...patch }) });
    const preset = typeof component.props.preset === 'string' && component.props.preset in PARTICLE_PRESETS ? component.props.preset as ParticlePresetId : null;
    const emitters = (object.components ?? []).filter(entry => entry.type === 'particles');
    const siblings = emitters.filter(entry => entry.id !== component.id);
    const sprites = [...BUILTIN_SPRITES, ...textures.map(texture => `texture:${texture.id}`)];
    const spriteLabels: Record<string, string> = Object.fromEntries(textures.map(texture => [`texture:${texture.id}`, `Texture: ${texture.name}`]));
    const custom = effect.render.sprite.startsWith('texture:');

    return (
        <div className="space-y-1.5">
            <Row label="Preset">
                <select
                    aria-label="Particle preset"
                    value={preset ?? ''}
                    onChange={(event) => {
                        const id = event.target.value as ParticlePresetId;
                        if (id) onChangeProps({ preset: id, effect: PARTICLE_PRESETS[id] });
                    }}
                    className={FIELD}
                >
                    {!preset && <option value="">Custom</option>}
                    {PARTICLE_PRESET_IDS.map(id => <option key={id} value={id}>{PARTICLE_PRESET_LABELS[id]}</option>)}
                </select>
            </Row>
            <p className="flex items-center gap-1 text-2xs text-gray-500"><SparklesIcon size={10} /> A preset sets every module below; change any of them from there.</p>

            <Section title="Emission" open>
                <Row label="Simulation"><Select label="Simulation" value={effect.simulation} options={PARTICLE_SIMULATION_MODES} labels={{ cpu: 'CPU (every feature)', gpu: 'GPU (up to a million)' }} onChange={(simulation) => update({ simulation })} /></Row>
                {effect.simulation === 'gpu' && <p className="text-2xs text-gray-500">WebGL2 GPU mode draws unsorted sprites and collides with the ground under the emitter. Choose CPU for ribbons or sub-emitters on WebGL2.</p>}
                <Row label="Rate (per s)"><NumberInput label="Rate" value={effect.rate} step={1} onCommit={(rate) => update({ rate })} /></Row>
                <details className="rounded border border-gray-800 px-1.5 py-1">
                    <summary className="cursor-pointer text-2xs text-gray-300">Rate over cycle</summary>
                    <ParticleCurveEditor label="Rate multiplier" domain="Cycle" maximum={10} value={effect.rateOverCycle}
                        onCommit={(rateOverCycle) => update({ rateOverCycle })} />
                </details>
                <Row label="Per metre moved"><NumberInput label="Rate over distance" value={effect.rateOverDistance} step={0.5} onCommit={(rateOverDistance) => update({ rateOverDistance })} /></Row>
                <Row label="Cycle (s)"><NumberInput label="Duration" value={effect.duration} onCommit={(duration) => update({ duration })} /></Row>
                <Row label="Loop"><Toggle label="Loop" value={effect.loop} onChange={(loop) => update({ loop })} /></Row>
                <Row label="Prewarm"><Toggle label="Prewarm" value={effect.prewarm} onChange={(prewarm) => update({ prewarm })} /></Row>
                <Row label="Delay (s)"><NumberInput label="Delay" value={effect.delay} onCommit={(delay) => update({ delay })} /></Row>
                <Row label="Max alive"><NumberInput label="Max particles" value={effect.maxParticles} step={50} onCommit={(maxParticles) => update({ maxParticles })} /></Row>
                <div className={LABEL}>Bursts (time in the cycle, count)</div>
                {effect.bursts.map((burst, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_20px] items-center gap-1">
                        <NumberInput label={`Burst ${index + 1} time`} value={burst.time} onCommit={(time) => update({ bursts: effect.bursts.map((entry, i) => (i === index ? { ...entry, time } : entry)) })} />
                        <NumberInput label={`Burst ${index + 1} count`} value={burst.count} step={1} onCommit={(count) => update({ bursts: effect.bursts.map((entry, i) => (i === index ? { ...entry, count } : entry)) })} />
                        <button type="button" aria-label={`Remove burst ${index + 1}`} onClick={() => update({ bursts: effect.bursts.filter((_, i) => i !== index) })} className="text-gray-500 hover:text-red-400"><TrashIcon size={11} /></button>
                    </div>
                ))}
                {effect.bursts.length < 8 && <button type="button" className={BUTTON} onClick={() => update({ bursts: [...effect.bursts, { time: 0, count: 20 }] })}><PlusIcon size={10} /> Burst</button>}
            </Section>

            <Section title="Shape">
                <Row label="Shape"><Select label="Shape" value={effect.shape.kind} options={PARTICLE_SHAPES} labels={SHAPE_LABELS} onChange={(kind) => update({ shape: { ...effect.shape, kind } })} /></Row>
                <Row label="Radius"><NumberInput label="Shape radius" value={effect.shape.radius} onCommit={(radius) => update({ shape: { ...effect.shape, radius } })} /></Row>
                <Row label="Spread (°)"><NumberInput label="Spread angle" value={effect.shape.angle} step={1} onCommit={(angle) => update({ shape: { ...effect.shape, angle } })} /></Row>
                <VectorInputs label="Box size" value={effect.shape.size} onCommit={(size) => update({ shape: { ...effect.shape, size } })} />
                <Row label="Fill (0 edge-1)"><NumberInput label="Shape fill" value={effect.shape.volume} step={0.1} onCommit={(volume) => update({ shape: { ...effect.shape, volume } })} /></Row>
                <Row label="Random dir."><NumberInput label="Random direction" value={effect.shape.randomDirection} step={0.1} onCommit={(randomDirection) => update({ shape: { ...effect.shape, randomDirection } })} /></Row>
                <VectorInputs label="Launch axis" value={effect.shape.axis} onCommit={(axis) => update({ shape: { ...effect.shape, axis } })} />
            </Section>

            <Section title="Start">
                <RangeInputs label="Lifetime (s)" value={effect.lifetime} onCommit={(lifetime) => update({ lifetime })} />
                <RangeInputs label="Speed (m/s)" value={effect.speed} onCommit={(speed) => update({ speed })} />
                <RangeInputs label="Size (m)" value={effect.size} step={0.01} onCommit={(size) => update({ size })} />
                <RangeInputs label="Rotation (°)" value={effect.rotation} step={5} onCommit={(rotation) => update({ rotation })} />
                <RangeInputs label="Spin (°/s)" value={effect.spin} step={5} onCommit={(spin) => update({ spin })} />
                <Row label="Colour between">
                    <ColorInput label="Start colour A" value={effect.startColor[0]} onCommit={(a) => update({ startColor: [a, effect.startColor[1]] })} />
                    <ColorInput label="Start colour B" value={effect.startColor[1]} onCommit={(b) => update({ startColor: [effect.startColor[0], b] })} />
                </Row>
                <Row label="Inherit motion"><NumberInput label="Inherit velocity" value={effect.inheritVelocity} step={0.1} onCommit={(inheritVelocity) => update({ inheritVelocity })} /></Row>
                <Row label="Space"><Select label="Simulation space" value={effect.space} options={['world', 'local'] as const} labels={{ world: 'World (left behind)', local: 'Local (moves with it)' }} onChange={(space) => update({ space })} /></Row>
            </Section>

            <Section title="Forces">
                <Row label="Gravity (m/s²)"><NumberInput label="Gravity" value={effect.gravity} onCommit={(gravity) => update({ gravity })} /></Row>
                <Row label="Drag"><NumberInput label="Drag" value={effect.drag} onCommit={(drag) => update({ drag })} /></Row>
                <VectorInputs label="Wind (m/s²)" value={effect.wind} onCommit={(wind) => update({ wind })} />
                <Row label="Turbulence"><NumberInput label="Turbulence" value={effect.turbulence} onCommit={(turbulence) => update({ turbulence })} /></Row>
                <Row label="Swirl size (m)"><NumberInput label="Turbulence scale" value={effect.turbulenceScale} onCommit={(turbulenceScale) => update({ turbulenceScale })} /></Row>
                <Row label="Orbit (rad/s)"><NumberInput label="Orbit" value={effect.orbit} onCommit={(orbit) => update({ orbit })} /></Row>
            </Section>

            <ForceFieldEditor fields={effect.forceFields} onChange={(forceFields) => update({ forceFields })} />

            <Section title="Over life">
                <GradientEditor label="Colour and alpha" value={effect.colorOverLife} onCommit={(colorOverLife) => update({ colorOverLife })} />
                <ParticleCurveEditor label="Size" domain="Lifetime" maximum={50} value={effect.sizeOverLife} onCommit={(sizeOverLife) => update({ sizeOverLife })} />
                <ParticleCurveEditor label="Speed" domain="Lifetime" maximum={10} value={effect.speedOverLife} onCommit={(speedOverLife) => update({ speedOverLife })} />
            </Section>

            <Section title="Collision">
                <Row label="Collide"><Select label="Collision" value={effect.collision.mode} options={PARTICLE_COLLISION_MODES} labels={{ none: 'None', world: 'With the world' }} onChange={(mode) => update({ collision: { ...effect.collision, mode } })} /></Row>
                <Row label="Bounce"><NumberInput label="Bounce" value={effect.collision.bounce} onCommit={(bounce) => update({ collision: { ...effect.collision, bounce } })} /></Row>
                <Row label="Friction"><NumberInput label="Friction" value={effect.collision.friction} onCommit={(friction) => update({ collision: { ...effect.collision, friction } })} /></Row>
                <Row label="Die on hit"><Toggle label="Die on hit" value={effect.collision.kill} onChange={(kill) => update({ collision: { ...effect.collision, kill } })} /></Row>
            </Section>

            <Section title="Sub-emitters">
                {siblings.length === 0 && <p className="text-2xs text-gray-500">Add another Particles component to this object to set it off where these particles die or hit.</p>}
                {effect.subEmitters.map((sub, index) => (
                    <div key={index} className="space-y-1 rounded border border-gray-800 p-1">
                        <Row label="When a particle">
                            <Select label={`Sub-emitter ${index + 1} trigger`} value={sub.trigger} options={SUB_EMITTER_TRIGGERS} labels={{ death: 'dies', collision: 'hits something' }} onChange={(trigger) => update({ subEmitters: effect.subEmitters.map((entry, i) => (i === index ? { ...entry, trigger } : entry)) })} />
                        </Row>
                        <Row label="Set off">
                            <select aria-label={`Sub-emitter ${index + 1} target`} value={sub.target} onChange={(event) => update({ subEmitters: effect.subEmitters.map((entry, i) => (i === index ? { ...entry, target: event.target.value } : entry)) })} className={FIELD}>
                                <option value="">Choose…</option>
                                {siblings.map(entry => <option key={entry.id} value={entry.id}>{particleEmitterName(entry.props) || `Particles ${emitters.indexOf(entry) + 1}`}{typeof entry.props.preset === 'string' ? ` (${PARTICLE_PRESET_LABELS[entry.props.preset as ParticlePresetId] ?? entry.props.preset})` : ''}</option>)}
                            </select>
                        </Row>
                        <Row label="Count"><NumberInput label={`Sub-emitter ${index + 1} count`} value={sub.count} step={1} onCommit={(count) => update({ subEmitters: effect.subEmitters.map((entry, i) => (i === index ? { ...entry, count } : entry)) })} /></Row>
                        <Row label="Inherit motion"><NumberInput label={`Sub-emitter ${index + 1} inherit`} value={sub.inheritVelocity} step={0.1} onCommit={(inheritVelocity) => update({ subEmitters: effect.subEmitters.map((entry, i) => (i === index ? { ...entry, inheritVelocity } : entry)) })} /></Row>
                        <button type="button" className={BUTTON} onClick={() => update({ subEmitters: effect.subEmitters.filter((_, i) => i !== index) })}><TrashIcon size={10} /> Remove</button>
                    </div>
                ))}
                {siblings.length > 0 && effect.subEmitters.length < 4 && (
                    <button type="button" className={BUTTON} onClick={() => update({ subEmitters: [...effect.subEmitters, { trigger: 'death', target: siblings[0].id, count: 5, inheritVelocity: 0.3 }] })}><PlusIcon size={10} /> Sub-emitter</button>
                )}
            </Section>

            <Section title="Rendering">
                <Row label="Draw as"><Select label="Render mode" value={effect.render.mode} options={PARTICLE_RENDER_MODES} labels={MODE_LABELS} onChange={(mode) => update({ render: { ...effect.render, mode } })} /></Row>
                <Row label="Sprite"><Select label="Sprite" value={effect.render.sprite} options={sprites} labels={spriteLabels} onChange={(sprite) => update({ render: { ...effect.render, sprite } })} /></Row>
                {custom && (
                    <Row label="Flipbook grid">
                        <NumberInput label="Flipbook columns" value={effect.render.columns} step={1} onCommit={(columns) => update({ render: { ...effect.render, columns } })} />
                        <NumberInput label="Flipbook rows" value={effect.render.rows} step={1} onCommit={(rows) => update({ render: { ...effect.render, rows } })} />
                    </Row>
                )}
                <Row label="Frames"><Select label="Frame mode" value={effect.render.frameMode} options={PARTICLE_FRAME_MODES} labels={{ life: 'Over its life', fps: 'At a frame rate', random: 'One at random' }} onChange={(frameMode) => update({ render: { ...effect.render, frameMode } })} /></Row>
                <Row label="Frame rate"><NumberInput label="Frame rate" value={effect.render.fps} step={1} onCommit={(fps) => update({ render: { ...effect.render, fps } })} /></Row>
                <Row label="Blending"><Select label="Blending" value={effect.render.blending} options={PARTICLE_BLENDINGS} labels={{ alpha: 'Blended', additive: 'Added (glows)' }} onChange={(blending) => update({ render: { ...effect.render, blending } })} /></Row>
                <Row label="Brightness"><NumberInput label="Brightness" value={effect.render.emissive} step={0.25} onCommit={(emissive) => update({ render: { ...effect.render, emissive } })} /></Row>
                <Row label="Stretch"><NumberInput label="Stretch" value={effect.render.stretch} step={0.02} onCommit={(stretch) => update({ render: { ...effect.render, stretch } })} /></Row>
                <Row label="Sort"><Toggle label="Sort back to front" value={effect.render.sort} onChange={(sort) => update({ render: { ...effect.render, sort } })} /></Row>
            </Section>

            <Section title="Light">
                <Row label="Casts light"><Toggle label="Light" value={effect.light.enabled} onChange={(enabled) => update({ light: { ...effect.light, enabled } })} /></Row>
                <Row label="Colour"><ColorInput label="Light colour" value={effect.light.color} onCommit={(color) => update({ light: { ...effect.light, color } })} /></Row>
                <Row label="Intensity (cd)"><NumberInput label="Light intensity" value={effect.light.intensity} step={5} onCommit={(intensity) => update({ light: { ...effect.light, intensity } })} /></Row>
                <Row label="Range (m)"><NumberInput label="Light range" value={effect.light.range} onCommit={(range) => update({ light: { ...effect.light, range } })} /></Row>
                <Row label="Flicker"><NumberInput label="Light flicker" value={effect.light.flicker} step={0.1} onCommit={(flicker) => update({ light: { ...effect.light, flicker } })} /></Row>
            </Section>
        </div>
    );
};
