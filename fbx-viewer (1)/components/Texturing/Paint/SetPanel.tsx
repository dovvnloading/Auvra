import React, { useRef, useState } from 'react';
import { CheckCircleIcon, DownloadIcon, FlameIcon, RefreshIcon } from '../../UI/Icons';
import type * as THREE from 'three';
import { BAKE_VERSION, DEFAULT_BAKE_SETTINGS, type BakeSettings } from '../../../texturing/bake/meshBaker';
import { MESH_MAP_LABELS, MESH_MAPS, type MeshMapName } from '../../../texturing/graph/nodes/io';
import { CHANNEL_LABELS, PAINT_CHANNELS, type PaintChannel } from '../../../texturing/paint/paintTypes';
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
}> = ({ session, models, onReopen }) => {
    const document = session.document;
    const [settings, setSettings] = useState<BakeSettings>(() => ({ ...DEFAULT_BAKE_SETTINGS, ...(document.bake?.settings ?? {}) }));
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
                <Row label="Rays per texel" value={settings.samples} min={16} max={512} step={16} onChange={(samples) => setSettings({ ...settings, samples })} />
                <Row label="Occlusion reach" value={settings.occlusionDistance} min={0.01} max={0.5} step={0.005} onChange={(occlusionDistance) => setSettings({ ...settings, occlusionDistance })} />
                {highPoly && (
                    <>
                        <Row label="Search in front" value={settings.frontDistance} min={0.001} max={0.1} step={0.001} onChange={(frontDistance) => setSettings({ ...settings, frontDistance })} />
                        <Row label="Search behind" value={settings.rearDistance} min={0.001} max={0.1} step={0.001} onChange={(rearDistance) => setSettings({ ...settings, rearDistance })} />
                    </>
                )}
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
                </div>
                {busy && session.busy && session.progress > 0 ? (
                    <div className="space-y-1">
                        <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(session.progress * 100)}%` }} /></div>
                        <div className="flex justify-between text-2xs text-zinc-400"><span>{session.busy}</span><button className="hover:text-white" onClick={() => controller.current?.abort()}>Stop</button></div>
                    </div>
                ) : (
                    <Button className="w-full justify-center" disabled={busy} icon={<FlameIcon size={13} />} onClick={() => {
                        controller.current = new AbortController();
                        void session.bake(settings, models.find((model) => model.id === highPoly)?.object ?? null, controller.current.signal);
                    }}>{document.bake ? 'Bake again' : 'Bake mesh maps'}</Button>
                )}
            </section>

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
