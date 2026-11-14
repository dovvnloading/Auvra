import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GarmentContactControls } from './GarmentContactControls';
import { GarmentFabricControls } from './GarmentFabricControls';
import { GarmentBakeControls } from './GarmentBakeControls';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import {
    cookGarment, createSleevelessTop, duplicateGarmentPanel, GARMENT_LIMITS, readGarmentPattern, removeGarmentPanel, removeGarmentPoint,
    rotateGarmentPanel, splitGarmentEdge,
    type GarmentPanel, type GarmentPattern, type GarmentRotationAxis, type GarmentSeamSide,
} from '../../runtime/garments/pattern';

const field = 'w-full min-w-0 rounded border border-gray-700 bg-gray-950 px-1.5 py-1 text-2xs text-gray-200';
const button = 'rounded border border-gray-700 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-800 disabled:opacity-40';
const label = 'block text-2xs text-gray-400';
const WIDTH = 300, HEIGHT = 220, PAD = 20;
const mm = (m: number) => Number((1000 * m).toFixed(2));
const reason = (error: unknown) => error instanceof Error ? error.message : 'The pattern is invalid.';

function availableId(ids: string[], prefix: string): string {
    const existing = new Set(ids);
    let index = 1;
    while (existing.has(prefix + index)) index++;
    return prefix + index;
}

function NumberField({ title, value, step = 1, commit }: {
    title: string; value: number; step?: number; commit: (value: number) => void;
}) {
    const [text, setText] = useState(String(value));
    const cancelled = useRef(false);
    useLayoutEffect(() => setText(String(value)), [value]);
    return <label className={label}>{title}
        <input className={field} type="number" step={step} value={text} onChange={event => setText(event.target.value)}
            onBlur={() => {
                setText(String(value));
                if (cancelled.current) { cancelled.current = false; return; }
                if (text.trim() && Number.isFinite(Number(text)) && Number(text) !== value) commit(Number(text));
            }}
            onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    cancelled.current = true;
                    event.currentTarget.blur();
                }
            }} />
    </label>;
}

function editorFrame(panel: GarmentPanel) {
    const xs = panel.boundary.map(point => point.x), ys = panel.boundary.map(point => point.y);
    const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
    const scale = Math.min((WIDTH - 2 * PAD) / (right - left), (HEIGHT - 2 * PAD) / (top - bottom));
    return { scale, ox: (WIDTH - (left + right) * scale) / 2, oy: (HEIGHT + (bottom + top) * scale) / 2 };
}

function sameSpan(a: GarmentSeamSide, b: GarmentSeamSide) {
    return a.panelId === b.panelId && ((a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from));
}

function PatternTools({ pattern, onCommit }: { pattern: GarmentPattern; onCommit: (next: GarmentPattern) => void }) {
    const [panelId, selectPanel] = useState(pattern.panels[0].id);
    const [pointId, selectPoint] = useState('');
    const [rotationAxis, setRotationAxis] = useState<GarmentRotationAxis>('normal');
    const [degrees, setDegrees] = useState('15');
    const [stitchStart, setStitchStart] = useState<GarmentSeamSide | null>(null);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState<{ id: string; x: number; y: number } | null>(null);
    const svg = useRef<SVGSVGElement>(null);
    const drag = useRef<{ id: string; pointer: number; source: GarmentPattern } | null>(null);
    const panel = pattern.panels.find(item => item.id === panelId) ?? pattern.panels[0];
    const selected = Math.max(0, panel.boundary.findIndex(point => point.id === pointId));
    const point = panel.boundary[selected];
    const next = panel.boundary[(selected + 1) % panel.boundary.length];
    const span = { panelId: panel.id, from: point.id, to: next.id };
    const seam = pattern.seams.find(item => sameSpan(item.a, span) || sameSpan(item.b, span));
    const frame = useMemo(() => editorFrame(panel), [panel]);
    const points = panel.boundary.map(item => item.id === draft?.id ? draft : item);
    const px = (x: number) => frame.ox + x * frame.scale;
    const py = (y: number) => frame.oy - y * frame.scale;
    const select = (id: string) => { selectPoint(id); setError(''); };
    useLayoutEffect(() => {
        drag.current = null; setDraft(null); setStitchStart(null); setError('');
    }, [pattern]);

    const save = (make: () => GarmentPattern) => {
        try {
            const updated = readGarmentPattern(make());
            cookGarment(updated);
            onCommit(updated);
            setError('');
            return updated;
        } catch (err) { setError(reason(err)); return null; }
    };
    const editPanel = (change: Partial<GarmentPanel>): GarmentPattern => ({
        ...pattern, panels: pattern.panels.map(item => item.id === panel.id ? { ...panel, ...change } : item),
    });
    const movePoint = (id: string, x: number, y: number) => {
        if (panel.boundary.some(p => p.id === id && p.x === x && p.y === y)) return;
        save(() => editPanel({ boundary: panel.boundary.map(item => item.id === id ? { ...item, x, y } : item) }));
    };
    const cursor = (event: React.PointerEvent<SVGSVGElement>) => {
        const transform = svg.current?.getScreenCTM();
        if (!transform || !svg.current) return null;
        const position = svg.current.createSVGPoint();
        position.x = event.clientX; position.y = event.clientY;
        const local = position.matrixTransform(transform.inverse());
        return { x: Math.round((local.x - frame.ox) / frame.scale * 10000) / 10000,
            y: Math.round((frame.oy - local.y) / frame.scale * 10000) / 10000 };
    };
    const selectPatternPanel = (id: string) => { selectPanel(id); selectPoint(''); setError(''); setDraft(null); drag.current = null; };
    const toggleSeam = () => {
        if (seam) { save(() => ({ ...pattern, seams: pattern.seams.filter(entry => entry.id !== seam.id) })); return; }
        if (!stitchStart) { setStitchStart(span); return; }
        save(() => ({
            ...pattern, seams: [...pattern.seams, { id: availableId(pattern.seams.map(s => s.id), 'seam-'),
                a: stitchStart, b: { panelId: panel.id, from: next.id, to: point.id } }],
        }));
    };
    const addPanel = () => {
        const id = availableId(pattern.panels.map(p => p.id), 'panel-');
        const newPanel: GarmentPanel = { id, name: id, grain: [0, 1], pins: [], layer: panel.layer,
            placement: { ...panel.placement, origin: [panel.placement.origin[0] + 0.3, panel.placement.origin[1], panel.placement.origin[2]] },
            boundary: [{ id: 'a', x: -0.10, y: 0 }, { id: 'b', x: 0.10, y: 0 },
                { id: 'c', x: 0.10, y: 0.25 }, { id: 'd', x: -0.10, y: 0.25 }] };
        if (save(() => ({ ...pattern, panels: [...pattern.panels, newPanel] }))) selectPatternPanel(id);
    };
    const duplicatePanel = () => {
        const updated = save(() => duplicateGarmentPanel(pattern, panel.id));
        if (updated) selectPatternPanel(updated.panels[updated.panels.length - 1].id);
    };
    const removePanel = () => {
        const neighbor = pattern.panels[pattern.panels.indexOf(panel) + 1] ?? pattern.panels[pattern.panels.indexOf(panel) - 1];
        if (save(() => removeGarmentPanel(pattern, panel.id)) && neighbor) selectPatternPanel(neighbor.id);
    };
    const removePoint = () => {
        if (save(() => removeGarmentPoint(pattern, panel.id, point.id))) select(next.id);
    };
    const pinned = panel.pins.includes(point.id);
    const grainAngle = Math.round(Math.atan2(panel.grain[1], panel.grain[0]) * 180 / Math.PI * 100) / 100;
    return <div className="space-y-2" aria-label="Garment pattern">
        <div className="space-y-1">
            <label className={label}>Pattern panel
                <select className={field} value={panel.id} onChange={event => selectPatternPanel(event.target.value)}>
                    {pattern.panels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
            </label>
            <div className="flex flex-wrap gap-1">
                <button type="button" className={button} onClick={addPanel}>Add panel</button>
                <button type="button" className={button} onClick={duplicatePanel}
                    title="Copy the panel and pins onto the next layer. Copies are spaced 8 mm outward and have open edges.">Duplicate panel</button>
                <button type="button" className={button} disabled={pattern.panels.length === 1}
                    title="Delete this panel and its seams" onClick={removePanel}>Delete panel</button>
            </div>
        </div>
        <svg ref={svg} role="img" aria-label={panel.name + ' pattern outline'} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="w-full touch-none rounded border border-gray-700 bg-gray-950"
            onPointerMove={event => {
                const active = drag.current;
                if (!active || active.pointer !== event.pointerId) return;
                const pos = cursor(event);
                if (pos) setDraft({ id: active.id, ...pos });
            }}
            onPointerUp={event => {
                const active = drag.current;
                if (!active || active.pointer !== event.pointerId) return;
                const pos = cursor(event);
                if (active.source === pattern && pos && draft) movePoint(active.id, pos.x, pos.y);
                drag.current = null; setDraft(null);
            }}
            onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDraft(null); } }}
            onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDraft(null); } }}>
            <polygon points={points.map(p => `${px(p.x)},${py(p.y)}`).join(' ')} fill="#193932" />
            {points.map((a, i) => {
                const b = points[(i + 1) % points.length];
                const side = { panelId: panel.id, from: a.id, to: b.id };
                const sewn = pattern.seams.some(s => sameSpan(s.a, side) || sameSpan(s.b, side));
                return <g key={a.id}>
                    <line x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke={i === selected ? '#facc15' : sewn ? '#63d9a8' : '#81929b'} strokeWidth={i === selected ? 3.5 : 2} />
                    <line x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke="transparent" strokeWidth={10} onClick={() => select(a.id)} />
                </g>;
            })}
            {points.map(p => <circle key={p.id} cx={px(p.x)} cy={py(p.y)} r={p.id === point.id ? 4.8 : 3.6}
                fill={panel.pins.includes(p.id) ? '#fb923c' : '#cbd5e1'} stroke="#102525" className="cursor-move"
                onPointerDown={event => {
                    if (event.button !== 0 || drag.current) return;
                    select(p.id); drag.current = { id: p.id, pointer: event.pointerId, source: pattern };
                    svg.current?.setPointerCapture(event.pointerId);
                }}><title>{p.id}</title></circle>)}
        </svg>
        <label className={label}>Point / outgoing edge
            <select className={field} value={point.id} onChange={event => select(event.target.value)}>
                {panel.boundary.map((p, i) => <option key={p.id} value={p.id}>{p.id} → {panel.boundary[(i + 1) % panel.boundary.length].id}</option>)}
            </select>
        </label>
        <div className="grid grid-cols-2 gap-1">
            <NumberField title="Point X (mm)" value={mm(point.x)} commit={n => movePoint(point.id, n / 1000, point.y)} />
            <NumberField title="Point Y (mm)" value={mm(point.y)} commit={n => movePoint(point.id, point.x, n / 1000)} />
            <NumberField title="Grain angle (°)" value={grainAngle} commit={n => save(() => editPanel({ grain: [Math.cos(n * Math.PI / 180), Math.sin(n * Math.PI / 180)] }))} />
            <NumberField title="Mesh edge (mm)" value={mm(pattern.edgeLength)} commit={n => save(() => ({ ...pattern, edgeLength: n / 1000 }))} />
            <label className={label}>Contact layer
                <select className={field} value={panel.layer ?? 0}
                    title="Higher layers lie farther along the outward normal. Different ranks enable inter-layer contact."
                    onChange={event => save(() => editPanel({ layer: Number(event.target.value) }))}>
                    {Array.from({ length: GARMENT_LIMITS.maxLayer + 1 }, (_, i) =>
                        <option key={i} value={i}>{i === 0 ? '0 · Base' : i}</option>)}
                </select>
            </label>
        </div>
        <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={button} onClick={() => save(() => splitGarmentEdge(pattern, panel.id, point.id, next.id))}>Split edge</button>
            <button type="button" className={button} disabled={panel.boundary.length === 3}
                title="Delete this point, its pin and seams on either adjacent edge" onClick={removePoint}>Delete point</button>
            <button type="button" className={button} aria-pressed={pinned} onClick={() => save(() => editPanel({
                pins: pinned ? panel.pins.filter(id => id !== point.id) : [...panel.pins, point.id],
            }))}>{pinned ? 'Unpin point' : 'Pin point'}</button>
        </div>
        <div className="rounded border border-gray-700 p-2 text-2xs text-gray-300">
            <p>{seam ? 'Seam ' + seam.id : 'Open edge'} · {mm(Math.hypot(next.x - point.x, next.y - point.y))} mm</p>
            {seam && <p>{[seam.a, seam.b].map(s => s.panelId + ' / ' + s.from + ' → ' + s.to).join(' ↔ ')}</p>}
            {stitchStart && <p>First edge: {stitchStart.panelId} / {stitchStart.from} → {stitchStart.to}. Select its open partner.</p>}
            <div className="mt-1 flex gap-1">
                <button type="button" className={button} disabled={Boolean(stitchStart && (Boolean(seam) || sameSpan(stitchStart, span)))}
                    onClick={toggleSeam}>{seam ? 'Unsew edge' : stitchStart ? 'Sew to first edge' : 'Start seam'}</button>
                {stitchStart && <button type="button" className={button} onClick={() => setStitchStart(null)}>Cancel seam</button>}
            </div>
        </div>
        <details><summary className="cursor-pointer text-2xs text-gray-300">Panel placement</summary>
            <div className="grid grid-cols-3 gap-1">{['X', 'Y', 'Z'].map((axis, i) =>
                <NumberField key={axis} title={axis + ' offset (mm)'} value={mm(panel.placement.origin[i])} commit={n => {
                    const origin: [number, number, number] = [...panel.placement.origin];
                    origin[i] = n / 1000;
                    save(() => editPanel({ placement: { ...panel.placement, origin } }));
                }} />)}</div>
            <div className="mt-1 flex items-end gap-1">
                <label className={label + ' flex-1'}>Local rotation axis
                    <select className={field} value={rotationAxis} onChange={e => setRotationAxis(e.target.value as GarmentRotationAxis)}>
                        <option value="u">Panel X</option><option value="v">Panel Y</option><option value="normal">Panel normal</option>
                    </select>
                </label>
                <label className={label + ' flex-1'}>Rotate by (°)
                    <input className={field} type="number" min="-360" max="360" step="any" value={degrees}
                        onChange={e => setDegrees(e.target.value)} />
                </label>
                <button type="button" className={button} disabled={!degrees.trim() || !Number.isFinite(Number(degrees)) || Number(degrees) === 0}
                    title="Rotate the arranged panel about its chart origin" onClick={() =>
                        save(() => rotateGarmentPanel(pattern, panel.id, rotationAxis, Number(degrees)))}>Rotate panel</button>
            </div>
        </details>
        {error && <p role="alert" className="text-2xs text-amber-400">{error}</p>}
    </div>;
}

export const GarmentInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const source = component.props.pattern;
    const parsed = useMemo(() => {
        try {
            const pattern = source === undefined ? createSleevelessTop() : readGarmentPattern(source);
            cookGarment(pattern);
            return { pattern, error: '' };
        } catch (error) { return { pattern: null, error: reason(error) }; }
    }, [source]);
    if (!parsed.pattern) return <div className="space-y-1">
        <p role="alert" className="text-2xs text-amber-400">{parsed.error}</p>
        <button type="button" className={button} onClick={() => onChangeProps({ pattern: createSleevelessTop() })}>Replace with starter pattern</button>
    </div>;
    return <div className="space-y-3">
        <PatternTools key={component.id} pattern={parsed.pattern} onCommit={pattern => onChangeProps({ pattern })} />
        <GarmentFabricControls component={component} onChangeProps={onChangeProps} />
        <GarmentBakeControls object={object} component={component} pattern={parsed.pattern} onChangeProps={onChangeProps} />
        <GarmentContactControls object={object} component={component} />
    </div>;
};
