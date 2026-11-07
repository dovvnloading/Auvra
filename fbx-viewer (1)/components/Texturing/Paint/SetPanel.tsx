import React, { useEffect, useRef, useState } from 'react';
import { CheckCircleIcon, DownloadIcon, FlameIcon, RefreshIcon } from '../../UI/Icons';
import type * as THREE from 'three';
import { BAKE_VERSION, DEFAULT_BAKE_SETTINGS, EXTRA_MAPS, EXTRA_MAP_LABELS, bakeStrips, type BakeSettings } from '../../../texturing/bake/meshBaker';
import { SUPERSAMPLE, type CageMode, type Supersample } from '../../../texturing/bake/bakeSetup';
import { MESH_MAP_LABELS, MESH_MAPS, type MeshMapName } from '../../../texturing/graph/nodes/io';
import { CHANNEL_LABELS, PAINT_CHANNELS, type BakeFix, type PaintChannel } from '../../../texturing/paint/paintTypes';
import type { PictureLayout } from '../../../texturing/materialOutput';
import { Button, Segmented, Spinner } from '../../UI/kit';
import { Select } from '../../UI/Select';
import type { PaintSession } from './paintSession';
import { SliderRow } from './PaintFields';

/** The texture set itself: its size and channels, baking its mesh maps, and handing over its pictures. */

/** A setting dragged or typed (typed values keep to the slider's ends). */
const Row: React.FC<{ label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }> = (props) => <SliderRow labelWidth="w-28" {...props} />;

const SIZES = [9, 10, 11, 12].map((log2) => ({ value: log2, label: `${2 ** log2} × ${2 ** log2}` }));

export const SetPanel: React.FC<{
    session: PaintSession;
    models: ReadonlyArray<{ id: string; name: string; object: THREE.Object3D }>;
    /** Opens the set again (after its picture size changed). */
    onReopen: () => void;
    /** Shows (or, with null, stops showing) the bake rays at spots clicked on the model, for these settings. */
    onShowRays?: (settings: BakeSettings | null) => void;
    showingRays?: boolean;
    /** The bake fix being painted (strokes go into it), and choosing one, or none. */
    paintingFix?: BakeFix | null;
    onPaintFix?: (fix: BakeFix | null) => void;
}> = ({ session, models, onReopen, onShowRays, showingRays = false, paintingFix = null, onPaintFix }) => {
    const document = session.document;
    // The bake's own size starts at the set's (and can be larger, for detail averaged down).
    const [settings, setSettings] = useState<BakeSettings>(() => ({ ...DEFAULT_BAKE_SETTINGS, size: document.size, ...(document.bake?.settings ?? {}) }));
    const [cageModel, setCageModel] = useState('');
    // The rays shown follow the settings as they change.
    useEffect(() => { if (showingRays) onShowRays?.(settings); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
    const [highPoly, setHighPoly] = useState('');
    const [layout, setLayout] = useState<PictureLayout>('separate');
    const [convention, setConvention] = useState<'bottom' | 'top'>('bottom');
    const controller = useRef<AbortController | null>(null);
    const busy = Boolean(session.busy);
    const changeDocument = (patch: Partial<typeof document>, label: string, coalesce?: string) => session.change({ ...document, ...patch }, label, coalesce);

    return (
        <div className="space-y-5 p-3">
            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Texture set</div>
                <div className="flex items-center gap-2 text-2xs text-zinc-400">
                    <span className="w-28 shrink-0">Picture size</span>
                    <Select value={document.size} options={SIZES} disabled={busy} className="w-32"
                        onChange={(value) => { void session.resize(Number(value)).then((changed) => { if (changed) onReopen(); }); }} />
                    <span className="truncate text-zinc-600">{session.stack.tiles.length === 1 ? 'one tile' : `${session.stack.tiles.length} UDIM tiles (${session.stack.tiles.join(', ')})`}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {PAINT_CHANNELS.map((channel: PaintChannel) => (
                        <label key={channel} className="flex items-center gap-1 text-2xs text-zinc-300">
                            <input type="checkbox" className="accent-sky-500" checked={document.channels.includes(channel)} disabled={channel === 'normal'}
                                onChange={(event) => changeDocument({ channels: event.target.checked ? [...document.channels, channel] : document.channels.filter((item) => item !== channel) }, 'Change channels')} />
                            {CHANNEL_LABELS[channel]}
                        </label>
                    ))}
                </div>
                <Row label="Height strength" value={document.heightStrength} min={0} max={8} step={0.05} onChange={(heightStrength) => changeDocument({ heightStrength }, 'Change height strength', 'heightStrength')} />
            </section>

            <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0 text-2xs font-semibold text-zinc-300">Mesh maps</span>
                    {document.bake && ((document.bake.version ?? 1) < BAKE_VERSION
                        ? <span className="text-2xs text-amber-400">Older bake</span>
                        : session.stack.bakeSize === null
                            ? <span className="flex items-center gap-1 text-2xs text-emerald-400"><CheckCircleIcon size={11} /> Baked</span>
                            : <span className="text-right text-2xs text-amber-400">Baked at {2 ** session.stack.bakeSize} × {2 ** session.stack.bakeSize}: bake again for full detail</span>)}
                </div>
                {document.bake && (document.bake.version ?? 1) < BAKE_VERSION && (
                    <p className="text-2xs leading-snug text-amber-200/80">Baked before positions were measured evenly: 3D noise and scratches stretch on long or flat parts, and normals can show faint banding. Bake again to fix both; until then the set looks as it did.</p>
                )}
                <p className="text-2xs leading-snug text-zinc-500">Occlusion, curvature, thickness, normals, position and IDs read from the model. Smart masks and materials are built on them.</p>
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">Detail from</span>
                    <Select value={highPoly} options={[{ value: '', label: 'This surface (and its normal map)' }, ...models.filter((model) => model.id !== session.target.modelId).map((model) => ({ value: model.id, label: `High-poly: ${model.name}` }))]} onChange={(value) => setHighPoly(String(value))} className="min-w-0 flex-1" />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-2xs text-zinc-400">Bake at</span>
                    <Select value={settings.size} options={[9, 10, 11, 12, 13].map((power) => ({ value: power, label: `${2 ** power} × ${2 ** power}${power === document.size ? ' (the set\'s size)' : ''}` }))} onChange={(size) => setSettings({ ...settings, size: Number(size) })} className="min-w-0 flex-1" />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-2xs text-zinc-400">Supersampling</span>
                    <Segmented value={String(settings.supersample ?? 1)} options={SUPERSAMPLE.map((factor) => ({ value: String(factor), label: factor === 1 ? 'Off' : `${factor}×${factor}` }))} onChange={(factor) => setSettings({ ...settings, supersample: Number(factor) as Supersample })} label="Supersampling" />
                </div>
                {(() => {
                    const plan = bakeStrips(settings, Boolean(highPoly), session.gpu.maxSize, document.size);
                    return plan.size !== document.size || plan.strips > 1 ? <p className="text-2xs leading-snug text-zinc-500">Baked at {2 ** plan.size} × {2 ** plan.size}{plan.strips > 1 ? ` in ${plan.strips} strips, to stay within the graphics memory` : ''}{plan.size !== document.size ? `, then averaged to the set's ${2 ** document.size} × ${2 ** document.size}` : ''}.</p> : null;
                })()}
                <Row label="Rays per texel" value={settings.samples} min={16} max={512} step={16} onChange={(samples) => setSettings({ ...settings, samples })} />
                <Row label="Occlusion reach" value={settings.occlusionDistance} min={0.01} max={0.5} step={0.005} onChange={(occlusionDistance) => setSettings({ ...settings, occlusionDistance })} />
                {highPoly && (
                    <>
                        <div className="flex items-center gap-2">
                            <span className="w-28 shrink-0 text-2xs text-zinc-400">Cage</span>
                            <Segmented value={settings.cage ?? 'distance'} options={[{ value: 'distance', label: 'By distance' }, { value: 'auto', label: 'Automatic' }, { value: 'mesh', label: 'From a model' }]} onChange={(cage) => setSettings({ ...settings, cage: cage as CageMode })} label="Cage" />
                        </div>
                        {(settings.cage ?? 'distance') === 'distance' && (
                            <>
                                <Row label="Search in front" value={settings.frontDistance} min={0.001} max={0.1} step={0.001} onChange={(frontDistance) => setSettings({ ...settings, frontDistance })} />
                                <Row label="Search behind" value={settings.rearDistance} min={0.001} max={0.1} step={0.001} onChange={(rearDistance) => setSettings({ ...settings, rearDistance })} />
                            </>
                        )}
                        {settings.cage === 'auto' && <p className="text-2xs leading-snug text-zinc-500">How far rays look is found from the two models: past nearly every gap between them, with a margin.</p>}
                        {settings.cage === 'mesh' && (
                            <Select value={cageModel} placeholder="Pick the cage model" options={models.filter((model) => model.id !== session.target.modelId && model.id !== highPoly).map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => setCageModel(String(value))} className="w-full" />
                        )}
                        <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
                            <input type="checkbox" className="accent-sky-500" checked={settings.averagedNormals ?? true} onChange={(event) => setSettings({ ...settings, averagedNormals: event.target.checked })} />
                            Rays along averaged normals (no gaps at hard edges)
                        </label>
                        <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
                            <input type="checkbox" className="accent-sky-500" checked={settings.matchByName ?? true} onChange={(event) => setSettings({ ...settings, matchByName: event.target.checked })} />
                            Match meshes by name (_low and _high), else by where they are
                        </label>
                    </>
                )}
                <div className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-2xs text-zinc-400">Normal map frame</span>
                    <Select value={settings.tangentSpace ?? 'renderer'} options={[{ value: 'renderer', label: 'As the renderer works it out' }, { value: 'uvs', label: 'From the UVs alone' }]} onChange={(tangentSpace) => setSettings({ ...settings, tangentSpace: tangentSpace as BakeSettings['tangentSpace'] })} className="min-w-0 flex-1" />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-2xs text-zinc-400">Green points</span>
                    <Segmented value={settings.normalConvention ?? 'openGl'} options={[{ value: 'openGl', label: 'Up (OpenGL)' }, { value: 'directX', label: 'Down (DirectX)' }]} onChange={(normalConvention) => setSettings({ ...settings, normalConvention: normalConvention as BakeSettings['normalConvention'] })} label="Normal map green" />
                </div>
                <Row label="Curvature strength" value={settings.curvatureStrength} min={0.1} max={5} step={0.05} onChange={(curvatureStrength) => setSettings({ ...settings, curvatureStrength })} />
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">IDs by</span>
                    <Segmented value={settings.idSource} options={[{ value: 'island', label: 'UV island' }, { value: 'mesh', label: 'Mesh' }, { value: 'vertexColor', label: 'Vertex colour' }]} onChange={(idSource) => setSettings({ ...settings, idSource })} label="IDs by" />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {MESH_MAPS.map((name: MeshMapName) => (
                        <label key={name} className="flex items-center gap-1 text-2xs text-zinc-300">
                            <input type="checkbox" className="accent-sky-500" checked={settings.maps.includes(name)} onChange={(event) => setSettings({ ...settings, maps: event.target.checked ? [...settings.maps, name] : settings.maps.filter((item) => item !== name) })} />
                            {MESH_MAP_LABELS[name]}
                        </label>
                    ))}
                    {EXTRA_MAPS.filter((name) => highPoly || (name !== 'color' && name !== 'opacity' && name !== 'material')).map((name) => (
                        <label key={name} className="flex items-center gap-1 text-2xs text-zinc-300">
                            <input type="checkbox" className="accent-sky-500" checked={(settings.extras ?? []).includes(name)} onChange={(event) => setSettings({ ...settings, extras: event.target.checked ? [...(settings.extras ?? []), name] : (settings.extras ?? []).filter((item) => item !== name) })} />
                            {EXTRA_MAP_LABELS[name]}
                        </label>
                    ))}
                </div>
                {onShowRays && (
                    <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
                        <input type="checkbox" className="accent-sky-500" checked={showingRays} onChange={(event) => onShowRays(event.target.checked ? settings : null)} />
                        Show the bake rays where I click the model
                    </label>
                )}
                {busy && session.busy && session.progress > 0 ? (
                    <div className="space-y-1">
                        <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(session.progress * 100)}%` }} /></div>
                        <div className="flex justify-between text-2xs text-zinc-400"><span>{session.busy}</span><button className="hover:text-white" onClick={() => controller.current?.abort()}>Stop</button></div>
                    </div>
                ) : (
                    <Button className="w-full justify-center" disabled={busy} icon={<FlameIcon size={13} />} onClick={() => {
                        controller.current = new AbortController();
                        void session.bake(settings, models.find((model) => model.id === highPoly)?.object ?? null, controller.current.signal, models.find((model) => model.id === cageModel)?.object ?? null);
                    }}>{document.bake ? 'Bake again' : 'Bake mesh maps'}</Button>
                )}
            </section>

            {document.bake && onPaintFix && (
                <section className="space-y-2">
                    <div className="text-2xs font-semibold text-zinc-300">Fix the bake in place</div>
                    <p className="text-2xs leading-snug text-zinc-500">Paint onto the model where the bake went wrong: skew (white) leans rays to the surface's own normals, for slanted detail; cage offset (mid grey leaves it, white pushes the cage out to twice as far, black pulls it in), for missed or doubled detail. The fixes are kept with the set and read by every bake.</p>
                    <div className="grid grid-cols-2 gap-1.5">
                        <Button size="sm" variant={paintingFix === 'skew' ? 'primary' : 'default'} onClick={() => onPaintFix(paintingFix === 'skew' ? null : 'skew')}>Paint skew</Button>
                        <Button size="sm" variant={paintingFix === 'cage' ? 'primary' : 'default'} onClick={() => onPaintFix(paintingFix === 'cage' ? null : 'cage')}>Paint cage offset</Button>
                    </div>
                    <Button size="sm" className="w-full justify-center" disabled={busy || !session.stack.bakeFixChanged.size || !highPoly}
                        onClick={() => { controller.current = new AbortController(); void session.rebakeRegion(settings, models.find((model) => model.id === highPoly)?.object ?? null, controller.current.signal); }}>
                        Bake the changed region again
                    </Button>
                    <p className="text-2xs leading-snug text-zinc-500">{session.stack.bakeFixChanged.size ? (highPoly ? 'Only the detail maps (normal, world normal, height and what is carried over) are baked again, where fixes were painted. Ctrl+Z undoes a bake like any stroke.' : 'Pick the high-poly model under "Detail from" to bake the region again.') : 'Paint a fix first: the region it covers is what is baked again.'}</p>
                </section>
            )}

            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">On the model</div>
                <div className={`flex items-start gap-1.5 rounded border p-2 text-2xs ${!session.changedSinceApply && document.applied ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-amber-900 bg-amber-950/40 text-amber-200'}`}>
                    {!session.changedSinceApply && document.applied ? <CheckCircleIcon size={13} className="mt-px shrink-0" /> : <RefreshIcon size={13} className="mt-px shrink-0" />}
                    <span>{!session.changedSinceApply && document.applied ? 'The model wears this painting as it is now.' : document.applied ? 'Painted since the model last got it: it still wears the earlier pictures.' : 'The model does not wear this painting yet. Painting is kept as you go either way.'}</span>
                </div>
                <Button variant="primary" className="w-full justify-center" disabled={busy} icon={busy ? <Spinner /> : <RefreshIcon size={13} />} onClick={() => void session.apply()}>{busy && !session.progress ? session.busy : 'Put on the model'}</Button>
            </section>

            <section className="space-y-2">
                <div className="text-2xs font-semibold text-zinc-300">Export pictures</div>
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">Pictures</span>
                    <Segmented value={layout} options={[{ value: 'separate', label: 'One per channel' }, { value: 'engine', label: 'Packed (ORM)' }]} onChange={setLayout} label="Pictures" />
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-28 text-2xs text-zinc-400">UV origin</span>
                    <Segmented value={convention} options={[{ value: 'bottom', label: 'Bottom left' }, { value: 'top', label: 'Top left' }]} onChange={setConvention} label="UV origin" />
                </div>
                <p className="text-2xs leading-snug text-zinc-500">Bottom left suits FBX and OBJ tools; top left suits glTF. Normals are green-up. UDIM tiles are numbered in the file names.</p>
                <Button className="w-full justify-center" disabled={busy} icon={<DownloadIcon size={13} />} onClick={() => void session.exportPictures(layout, convention === 'bottom')}>Download pictures</Button>
            </section>
        </div>
    );
};
