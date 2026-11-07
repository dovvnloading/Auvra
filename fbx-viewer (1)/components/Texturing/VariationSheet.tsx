import React, { useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { CrossIcon } from '../UI/Icons';
import { IconButton, Segmented, Spinner } from '../UI/kit';
import { Select } from '../UI/Select';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { AbortedError, TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { VARIABLE_KINDS, variationSeeds, variationValues } from '../../texturing/graph/parameters';
import type { GraphResolver } from '../../texturing/graph/registry';
import type { GraphParameterValue, TextureGraph } from '../../texturing/graph/types';
import type { TextureGraphSession } from './textureGraphSession';
import { valueWords } from './functionPreviews';

/**
 * A VARIATION SHEET
 *
 * A grid of the graph's result, each cell drawn with one parameter (or the seed) set differently: the
 * parameter spread over its slider's range, each option of a choice, both ways of a switch, a colour
 * round the hues. Clicking a cell keeps its value. The cells are drawn small, one after another, by an
 * evaluator of the sheet's own, which shares nothing with the editing results.
 */

const CELL = 128;
const SEED = '\u0000seed';

export interface VariationCell {
    label: string;
    /** What keeping it changes. */
    keep: { name: string; value: GraphParameterValue } | { seed: number };
}

/** A sheet's cells: the parameter's values (or seeds), each with a label. */
export const variationCells = (graph: TextureGraph, choice: string, count: number, values: Readonly<Record<string, unknown>>): VariationCell[] => {
    if (choice === SEED) return variationSeeds(graph.seed, count).map((seed) => ({ label: `Seed ${seed}`, keep: { seed } }));
    const parameter = graph.parameters.find((candidate) => candidate.name === choice);
    if (!parameter) return [];
    return variationValues(parameter, count, values[parameter.name]).map((value) => ({
        keep: { name: parameter.name, value },
        label: parameter.kind === 'select' ? parameter.options?.find((option) => option.value === value)?.label ?? String(value)
            : parameter.kind === 'bool' ? (value ? 'On' : 'Off')
                : parameter.kind === 'color' ? `#${(value as number[]).slice(0, 3).map((part) => Math.round(part * 255).toString(16).padStart(2, '0')).join('')}`
                    : valueWords(parameter.kind === 'vec2' ? 'vec2' : parameter.kind === 'int' ? 'int' : 'float', Array.isArray(value) ? value as number[] : [Number(value)]),
    }));
};

const CellPicture: React.FC<{ image: ImageData | undefined }> = ({ image }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const context = canvas.current?.getContext('2d');
        if (context && image) context.putImageData(image, 0, 0);
    }, [image]);
    return <canvas ref={canvas} width={CELL} height={CELL} className="h-full w-full rounded-sm bg-well" style={{ imageRendering: 'auto' }} />;
};

export const VariationSheet: React.FC<{
    session: TextureGraphSession;
    graph: TextureGraph;
    values: Readonly<Record<string, unknown>>;
    /** The node drawn in each cell. */
    nodeId: string;
    nodeLabel: string;
    resolve: GraphResolver;
    texture: (textureId: string) => THREE.Texture | null;
    onKeep: (cell: VariationCell) => void;
    onClose: () => void;
}> = ({ session, graph, values, nodeId, nodeLabel, resolve, texture, onKeep, onClose }) => {
    const choices = useMemo(() => [
        { value: SEED, label: 'Random seed' },
        ...graph.parameters.filter((parameter) => VARIABLE_KINDS.has(parameter.kind)).map((parameter) => ({ value: parameter.name, label: parameter.label })),
    ], [graph.parameters]);
    const [choice, setChoice] = useState<string>(choices[1]?.value ?? SEED);
    const [count, setCount] = useState<'9' | '16' | '25'>('9');
    const cells = useMemo(() => variationCells(graph, choice, Number(count), values), [choice, count, graph, values]);
    const [pictures, setPictures] = useState<Array<ImageData | undefined>>([]);
    const [drawing, setDrawing] = useState(false);
    const evaluator = useMemo(() => new TextureGraphEvaluator(session.gpu, resolve, texture), [resolve, session.gpu, texture]);
    useEffect(() => () => evaluator.dispose(), [evaluator]);

    useEffect(() => {
        const controller = new AbortController();
        setPictures([]);
        setDrawing(true);
        const gpu = session.gpu;
        void (async () => {
            for (let index = 0; index < cells.length; index++) {
                if (controller.signal.aborted) return;
                const cell = cells[index];
                const drawn = 'seed' in cell.keep ? { ...graph, seed: cell.keep.seed } : graph;
                const parameters = 'name' in cell.keep ? { ...values, [cell.keep.name]: cell.keep.value } : values;
                try {
                    const states = await evaluator.evaluate({
                        graph: drawn, parameters, targets: [nodeId], size: { w: 7, h: 7 }, signal: controller.signal,
                        external: session.external, externalVersion: session.externalVersion,
                    });
                    const image = Object.values(states.get(nodeId)?.outputs ?? {})[0];
                    if (!image) continue;
                    const small = gpu.image(CELL, CELL, 'color', 8);
                    gpu.passNow(small, {
                        fragment: `uniform int gray;
void main() {
    vec4 v = texture(source, vUv);
    if (gray == 1) v = vec4(v.rrr, 1.0);
    vec2 cell = floor(gl_FragCoord.xy / 8.0);
    vec3 checker = mix(vec3(0.16), vec3(0.22), mod(cell.x + cell.y, 2.0));
    outColor = vec4(mix(checker, v.rgb, clamp(v.a, 0.0, 1.0)), 1.0);
}`,
                        inputs: { source: image },
                        uniforms: { gray: image.kind === 'gray' ? 1 : 0 },
                    });
                    const reading = gpu.readRgba8Later(small);
                    gpu.release(small);
                    const pixels = await reading;
                    if (!pixels || controller.signal.aborted) continue;
                    // Bottom row first as read: top row first for the picture.
                    const row = CELL * 4;
                    const flipped = new Uint8ClampedArray(pixels.length);
                    for (let y = 0; y < CELL; y++) flipped.set(pixels.subarray((CELL - 1 - y) * row, (CELL - y) * row), y * row);
                    const picture = new ImageData(flipped, CELL, CELL);
                    setPictures((current) => { const next = [...current]; next[index] = picture; return next; });
                } catch (error) {
                    if (error instanceof AbortedError || (error as Error)?.name === 'AbortError') return;
                    frontendDiagnostics.failure('texture_graph_variation_failed', error);
                }
            }
            if (!controller.signal.aborted) setDrawing(false);
        })();
        return () => controller.abort();
    }, [cells, evaluator, graph, nodeId, session, values]);

    const columns = Math.ceil(Math.sqrt(cells.length));
    return (
        <div role="dialog" aria-label="Variations" className="absolute inset-0 z-40 flex flex-col bg-ground/95">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-2xs">
                <span className="font-semibold text-ink">Variations of {nodeLabel}</span>
                <span className="text-ink-3">changing</span>
                <Select value={choice} options={choices} onChange={setChoice} className="w-[180px]" />
                <Segmented value={count} label="Cells" onChange={setCount} options={[{ value: '9', label: '9' }, { value: '16', label: '16' }, { value: '25', label: '25' }]} />
                {drawing && <span className="flex items-center gap-1 text-ink-3"><Spinner /> Drawing…</span>}
                <span className="ml-auto text-ink-3">Click a cell to keep it.</span>
                <IconButton label="Close the variations" onClick={onClose}><CrossIcon size={13} /></IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
                {cells.length === 0
                    ? <p className="text-2xs text-ink-3">This parameter cannot be varied: choose a number, switch, choice, colour or pair, or the random seed.</p>
                    : (
                        <div className="mx-auto grid max-w-[900px] gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                            {cells.map((cell, index) => (
                                <button key={`${choice}:${index}`} type="button" onClick={() => onKeep(cell)} title={`Keep ${cell.label}`}
                                    className="group space-y-1 rounded border border-line bg-panel p-1 text-left hover:border-accent focus:border-accent focus:outline-none">
                                    <div className="aspect-square w-full"><CellPicture image={pictures[index]} /></div>
                                    <div className="truncate px-0.5 text-2xs text-ink-2 group-hover:text-ink">{cell.label}</div>
                                </button>
                            ))}
                        </div>
                    )}
            </div>
        </div>
    );
};
