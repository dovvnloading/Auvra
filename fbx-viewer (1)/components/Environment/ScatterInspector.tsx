import React, { useEffect, useState } from 'react';
import { Dices, Plus, Trash2 } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import {
    DEFAULT_SCATTER_LAYER,
    MAX_SCATTER_LAYERS,
    SCATTER_COLLISIONS,
    readScatterSettings,
    type ScatterLayer,
} from '../../runtime/proceduralScatter';

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200 focus:outline-none focus:border-amber-500';
const BUTTON = 'flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-2xs text-gray-200';
const LABEL = 'text-2xs text-gray-400';

const NumberInput: React.FC<{ label: string; value: number; onCommit: (value: number) => void; step?: number }> = ({ label, value, onCommit, step = 0.1 }) => {
    const shown = String(Math.round(value * 1000) / 1000);
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const take = () => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setText(shown);
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
    <label className="grid grid-cols-[84px_1fr] items-center gap-2"><span className={LABEL}>{label}</span>{children}</label>
);

const RangeRow: React.FC<{ label: string; value: [number, number]; step?: number; onCommit: (value: [number, number]) => void }> = ({ label, value, step, onCommit }) => (
    <Row label={label}>
        <div className="grid grid-cols-2 gap-1">
            <NumberInput label={`${label} from`} value={value[0]} step={step} onCommit={(from) => onCommit([from, value[1]])} />
            <NumberInput label={`${label} to`} value={value[1]} step={step} onCommit={(to) => onCommit([value[0], to])} />
        </div>
    </Row>
);

/**
 * The Procedural Scatter component's layers: which model each places and its rules. The area, seed and
 * distances are the schema fields above.
 */
export const ScatterInspector: React.FC<ComponentInspectorProps> = ({ component, onChangeProps }) => {
    const { models } = useScene();
    const settings = readScatterSettings(component.props);
    const choices = models.filter(model => model.category !== 'Animation' && model.category !== 'Character');
    const commit = (layers: ScatterLayer[]) => onChangeProps({ layers });
    const update = (index: number, change: Partial<ScatterLayer>) => commit(settings.layers.map((layer, i) => (i === index ? { ...layer, ...change } : layer)));

    return (
        <div className="space-y-2">
            <button type="button" className={BUTTON} onClick={() => onChangeProps({ seed: Math.floor(Math.random() * 1e6) })}>
                <Dices size={10} /> New seed (another placement)
            </button>
            {settings.layers.map((layer, index) => (
                <div key={index} className="space-y-1 rounded border border-gray-800 bg-gray-900/60 p-1.5">
                    <div className="grid grid-cols-[1fr_14px] items-center gap-1">
                        <select
                            aria-label={`Layer ${index + 1} model`}
                            value={layer.modelId}
                            onChange={(event) => update(index, { modelId: event.target.value })}
                            className={FIELD}
                        >
                            <option value="">Pick a model...</option>
                            {layer.modelId && !models.some(model => model.id === layer.modelId) && <option value={layer.modelId}>Missing model</option>}
                            {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                        </select>
                        <button type="button" aria-label={`Remove layer ${index + 1}`} onClick={() => commit(settings.layers.filter((_, i) => i !== index))} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                    </div>
                    <Row label="Per 100 m²"><NumberInput label={`Layer ${index + 1} density`} value={layer.density} onCommit={(density) => update(index, { density })} /></Row>
                    <Row label="Spacing (m)"><NumberInput label={`Layer ${index + 1} spacing`} value={layer.spacing} onCommit={(spacing) => update(index, { spacing })} /></Row>
                    <Row label="Clumping"><NumberInput label={`Layer ${index + 1} clumping`} value={layer.clump} onCommit={(clump) => update(index, { clump })} /></Row>
                    <Row label="Clump size (m)"><NumberInput label={`Layer ${index + 1} clump size`} value={layer.clumpSize} step={1} onCommit={(clumpSize) => update(index, { clumpSize })} /></Row>
                    <RangeRow label="Scale" value={layer.scale} onCommit={(scale) => update(index, { scale })} />
                    <RangeRow label="Slope (°)" value={layer.slope} step={1} onCommit={(slope) => update(index, { slope })} />
                    <RangeRow label="Height (m)" value={layer.height} step={1} onCommit={(height) => update(index, { height })} />
                    <Row label="Lean with ground"><NumberInput label={`Layer ${index + 1} lean`} value={layer.align} onCommit={(align) => update(index, { align })} /></Row>
                    <Row label="Sink (m)"><NumberInput label={`Layer ${index + 1} sink`} value={layer.sink} onCommit={(sink) => update(index, { sink })} /></Row>
                    <Row label="Collision">
                        <select aria-label={`Layer ${index + 1} collision`} value={layer.collision} onChange={(event) => update(index, { collision: event.target.value as ScatterLayer['collision'] })} className={FIELD}>
                            {SCATTER_COLLISIONS.map(option => <option key={option} value={option}>{{ none: 'None', trunk: 'A trunk (narrow column)', box: "The model's box" }[option]}</option>)}
                        </select>
                    </Row>
                </div>
            ))}
            {settings.layers.length < MAX_SCATTER_LAYERS && (
                <button type="button" className={BUTTON} onClick={() => commit([...settings.layers, { ...DEFAULT_SCATTER_LAYER }])}><Plus size={10} /> Layer</button>
            )}
            <p className="text-2xs text-gray-500">
                Copies stand on the terrain and meshes in the area, keep each layer's spacing from every copy (place big things in the first layers),
                and are placed again when a setting or the object changes. Lean 0 stands them upright; 1 leans them with the ground.
            </p>
        </div>
    );
};
