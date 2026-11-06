import React from 'react';
import { PlusIcon, TrashIcon } from '../../UI/Icons';
import type { PathStyle, SurfacePath } from '../../../texturing/paint/paths';
import { Button, IconButton, Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { DraftText } from '../TextureParamField';
import { SliderRow } from './PaintFields';
import { PATH_FONTS } from './PaintViewport';

/** The path tool's settings: which path, how it is laid on, its selected point's size and opacity. */
export const PathPanel: React.FC<{
    paths: readonly SurfacePath[];
    path: SurfacePath | null;
    point: number | null;
    /** The model's size, for point sizes as a share of it. */
    extent: number;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    onPick: (id: string | null) => void;
    onNew: () => void;
    onChange: (path: SurfacePath, label: string, coalesce?: string) => void;
    onDelete: (id: string) => void;
    onSelectPoint: (index: number | null) => void;
    onPaint: (how: 'along' | 'fill') => void;
}> = ({ paths, path, point, extent, graphs, onPick, onNew, onChange, onDelete, onSelectPoint, onPaint }) => {
    const selected = path && point !== null ? path.points[point] ?? null : null;
    const setPoint = (patch: Partial<SurfacePath['points'][number]>, label: string) => {
        if (!path || point === null) return;
        onChange({ ...path, points: path.points.map((each, i) => (i === point ? { ...each, ...patch } : each)) }, label, `${path.id}:${point}:${label}`);
    };
    return (
        <section className="space-y-2 border-b border-zinc-800 p-3">
            <div className="flex items-center gap-1.5">
                <span className="flex-1 text-2xs font-semibold text-zinc-300">Path</span>
                <IconButton label="New path" onClick={onNew}><PlusIcon size={12} /></IconButton>
                {path && <IconButton label="Delete this path" onClick={() => onDelete(path.id)}><TrashIcon size={12} /></IconButton>}
            </div>
            {paths.length > 0 && (
                <Select value={path?.id ?? ''} placeholder="Pick a path" options={paths.map((each) => ({ value: each.id, label: `${each.name} (${each.points.length} point${each.points.length === 1 ? '' : 's'})` }))} onChange={(id) => onPick(String(id))} className="w-full" />
            )}
            <p className="text-2xs leading-snug text-zinc-500">Click the model to add points (after the selected one); drag a point to move it. Each point keeps its own size and opacity.</p>
            {path && (
                <>
                    <DraftText label="Path name" value={path.name} maxLength={80} onCommit={(name) => onChange({ ...path, name }, 'Rename path')} className="w-full" />
                    <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
                        <input type="checkbox" checked={path.closed} onChange={(event) => onChange({ ...path, closed: event.target.checked }, 'Close or open path')} className="accent-sky-500" />
                        Closed: its ends join
                    </label>
                    <Segmented value={path.style} options={[{ value: 'brush', label: 'Brush' }, { value: 'ribbon', label: 'Ribbon' }, { value: 'stitches', label: 'Stitches' }, { value: 'text', label: 'Text' }]}
                        onChange={(style) => onChange({ ...path, style: style as PathStyle }, 'Change how the path is laid on')} label="Laid on as" />
                    <p className="text-2xs leading-snug text-zinc-500">{{
                        brush: 'Dabs of the brush along the path, sized by its points.',
                        ribbon: 'A flat band along the path, as wide as its points.',
                        stitches: 'A texture graph\'s first output repeated along the path, turned with it.',
                        text: 'Letters along the path, as tall as its points, in a font the browser has.',
                    }[path.style]}</p>
                    {path.style === 'text' && (
                        <>
                            <DraftText label="Text" value={path.text ?? ''} maxLength={500} allowEmpty placeholder="Text" onCommit={(text) => onChange({ ...path, text }, 'Change path text')} className="w-full" />
                            <Select value={path.font ?? 'sans-serif'} options={PATH_FONTS.map((font) => ({ value: font, label: font }))} onChange={(font) => onChange({ ...path, font: String(font) }, 'Change path font')} className="w-full" />
                        </>
                    )}
                    {path.style === 'stitches' && (
                        <Select value={path.graphId ?? ''} placeholder={graphs.length ? 'Pick a texture graph' : 'No texture graphs in this project'} options={graphs.map((graph) => ({ value: graph.id, label: graph.name }))} onChange={(graphId) => onChange({ ...path, graphId: String(graphId) }, 'Change stitch graph')} className="w-full" />
                    )}
                    {(path.style === 'text' || path.style === 'stitches') && (
                        <SliderRow label="Gap" value={path.gap ?? 0.2} min={0} max={2} hint="Between letters or stitches, as a share of their size." onChange={(gap) => onChange({ ...path, gap }, 'Change path gap', `${path.id}:gap`)} />
                    )}
                    {selected ? (
                        <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                            <div className="flex items-center gap-1.5 text-2xs text-zinc-300">
                                <span className="flex-1">Point {point! + 1} of {path.points.length}</span>
                                <Button size="sm" variant="ghost" onClick={() => { onChange({ ...path, points: path.points.filter((_, i) => i !== point) }, 'Remove path point'); onSelectPoint(path.points.length > 1 ? Math.max(0, point! - 1) : null); }}>Remove</Button>
                            </div>
                            <SliderRow label="Size" value={(selected.size / extent) * 100} min={0.05} max={10} step={0.05} suffix="%" hint="Its radius, as a share of the model's size."
                                onChange={(value) => setPoint({ size: Math.max(1e-6, (value / 100) * extent) }, 'Change point size')} />
                            <SliderRow label="Opacity" value={selected.opacity} min={0} max={1} onChange={(opacity) => setPoint({ opacity }, 'Change point opacity')} />
                        </div>
                    ) : path.points.length > 0 && <p className="text-2xs text-zinc-500">Click a point to change its size and opacity.</p>}
                    <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" disabled={!path.points.length} onClick={() => onPaint('along')} className="flex-1">Paint along it</Button>
                        <Button size="sm" disabled={path.points.length < 3} onClick={() => onPaint('fill')} className="flex-1">Fill inside</Button>
                    </div>
                    <p className="text-2xs leading-snug text-zinc-500">It is laid on the selected paint layer or painted mask, as one step to undo; the path stays to be changed and laid on again. Filling goes through its outline as seen from here.</p>
                </>
            )}
        </section>
    );
};
