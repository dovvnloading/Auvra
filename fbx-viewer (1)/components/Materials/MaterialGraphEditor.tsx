import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Plus, Trash2, Search } from 'lucide-react';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { useAssets } from '../../context/AssetContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import {
    MATERIAL_NODE_DEFINITIONS,
    OUTPUT_NODE_TYPE,
    createMaterialGraph,
    defaultParams,
    getMaterialNodeDefinition,
    readParam,
    wouldCreateCycle,
    type MaterialGraph,
    type MaterialGraphNode,
    type MaterialParamDef,
    type MaterialValueType,
} from '../../runtime/materials/materialGraph';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { useGraphViewport } from '../AnimationGraph/hooks/useGraphViewport';

/**
 * MATERIAL GRAPH EDITOR (the Materials tab)
 *
 * The project's material assets: each a node graph wired into a Material Output, edited on a canvas
 * and shown on a lit preview sphere as it changes. Models' materials take an asset in the Material
 * Editor (Retexture tab); every material using an asset follows edits to it straight away.
 */

const NODE_WIDTH = 190;
const HEADER = 28;
const ROW = 22;
// Edits made in quick succession (dragging a slider) are saved together.
const SAVE_DELAY_MS = 400;

const PIN_COLORS: Record<MaterialValueType, string> = { float: '#9ca3af', vec2: '#4ade80', vec3: '#facc15', vec4: '#c084fc' };

/** The material assets, re-rendering when they change. */
const useMaterialAssets = (): MaterialAsset[] => {
    const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    return useMemo(() => materialLibrary.list(), [version]);
};

/** Where a pin sits on the canvas: outputs on the right, one row each, then inputs on the left. */
const pinPosition = (node: MaterialGraphNode, kind: 'in' | 'out', key: string): { x: number; y: number } => {
    const definition = getMaterialNodeDefinition(node.type)!;
    const index = kind === 'out'
        ? definition.outputs.findIndex(port => port.key === key)
        : definition.outputs.length + definition.inputs.findIndex(port => port.key === key);
    return { x: node.x + (kind === 'out' ? NODE_WIDTH : 0), y: node.y + HEADER + index * ROW + ROW / 2 };
};

const nodeHeight = (node: MaterialGraphNode): number => {
    const definition = getMaterialNodeDefinition(node.type)!;
    return HEADER + (definition.outputs.length + definition.inputs.length) * ROW + 8;
};

const wirePath = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
    const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};

const toHex = (rgb: number[]): string => `#${rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const PreviewSphere: React.FC<{ assetId: string }> = ({ assetId }) => {
    const material = useMemo(() => new THREE.MeshStandardMaterial(), []);
    const mesh = useRef<THREE.Mesh>(null);
    useEffect(() => {
        materialLibrary.assign(material, assetId);
        return () => { materialLibrary.assign(material, null); };
    }, [material, assetId]);
    useEffect(() => () => material.dispose(), [material]);
    useFrame((_state, delta) => {
        if (mesh.current) mesh.current.rotation.y += delta * 0.3;
    });
    return (
        <mesh ref={mesh} material={material}>
            <sphereGeometry args={[1, 64, 48]} />
        </mesh>
    );
};

const MaterialPreview: React.FC<{ assetId: string }> = ({ assetId }) => (
    <div className="relative h-56 w-full shrink-0 overflow-hidden rounded border border-gray-800 bg-gray-950">
        <AuvraCanvas surfaceId="preview-material-graph" role="preview" camera={{ position: [0, 0, 3.2], fov: 40 }}>
            <hemisphereLight args={['#dfe9ff', '#2a2420', 0.9]} />
            <directionalLight position={[3, 4, 2]} intensity={2.4} />
            <directionalLight position={[-3, -1, -2]} intensity={0.5} color="#9fb4ff" />
            <PreviewSphere assetId={assetId} />
        </AuvraCanvas>
    </div>
);

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

const ParamField: React.FC<{
    param: MaterialParamDef;
    value: unknown;
    textures: { id: string; name: string }[];
    onChange: (value: unknown) => void;
}> = ({ param, value, textures, onChange }) => {
    const current = readParam(param, value);
    const label = <span className="text-[10px] uppercase text-gray-500">{param.label}</span>;
    if (param.kind === 'texture') {
        return (
            <label className="block space-y-1">{label}
                <select aria-label={param.label} value={current as string} onChange={(event) => onChange(event.target.value)} className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white">
                    <option value="">(none)</option>
                    {textures.map(texture => <option key={texture.id} value={texture.id}>{texture.name}</option>)}
                </select>
            </label>
        );
    }
    if (param.kind === 'color') {
        return (
            <label className="flex items-center justify-between gap-2">{label}
                <input type="color" aria-label={param.label} value={toHex(current as number[])} onChange={(event) => onChange(fromHex(event.target.value))} className="h-6 w-12 rounded border border-gray-700 bg-transparent" />
            </label>
        );
    }
    if (param.kind === 'float') {
        const number = current as number;
        return (
            <label className="block space-y-1">{label}
                <div className="flex items-center gap-2">
                    {param.min !== undefined && param.max !== undefined && (
                        <input type="range" aria-label={`${param.label} slider`} min={param.min} max={param.max} step={param.step ?? 0.01} value={number} onChange={(event) => onChange(Number(event.target.value))} className="flex-1" />
                    )}
                    <input type="number" aria-label={param.label} step={param.step ?? 0.01} value={number} onChange={(event) => onChange(Number(event.target.value))} className="w-20 rounded border border-gray-700 bg-gray-950 px-1 py-0.5 text-xs text-white" />
                </div>
            </label>
        );
    }
    const components = current as number[];
    return (
        <label className="block space-y-1">{label}
            <div className="flex gap-1">
                {components.map((component, index) => (
                    <input key={index} type="number" aria-label={`${param.label} ${'XYZ'[index]}`} step={0.05} value={component} onChange={(event) => onChange(components.map((old, at) => (at === index ? Number(event.target.value) : old)))} className="w-full rounded border border-gray-700 bg-gray-950 px-1 py-0.5 text-xs text-white" />
                ))}
            </div>
        </label>
    );
};

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

interface CanvasProps {
    graph: MaterialGraph;
    selectedNodeId: string | null;
    onSelect: (nodeId: string | null) => void;
    /** `commit` false: a step of a drag, saved when the drag ends. */
    onChange: (graph: MaterialGraph, commit: boolean) => void;
}

const MaterialGraphCanvas: React.FC<CanvasProps> = ({ graph, selectedNodeId, onSelect, onChange }) => {
    const container = useRef<HTMLDivElement>(null);
    const { viewport, isPanning, handleWheel, beginPan, endPan, updatePan } = useGraphViewport();
    const [drag, setDrag] = useState<{ nodeId: string; dx: number; dy: number } | null>(null);
    const [linking, setLinking] = useState<{ fromNode: string; fromOutput: string; type: MaterialValueType; x: number; y: number } | null>(null);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [search, setSearch] = useState('');

    const toGraph = useCallback((clientX: number, clientY: number) => {
        const rect = container.current!.getBoundingClientRect();
        return { x: (clientX - rect.left - viewport.x) / viewport.scale, y: (clientY - rect.top - viewport.y) / viewport.scale };
    }, [viewport]);

    const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);

    const addNode = (type: string) => {
        const rect = container.current!.getBoundingClientRect();
        const center = toGraph(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const node: MaterialGraphNode = { id: crypto.randomUUID(), type, x: center.x - NODE_WIDTH / 2, y: center.y - 40, params: defaultParams(type) };
        onChange({ ...graph, nodes: [...graph.nodes, node] }, true);
        onSelect(node.id);
        setPaletteOpen(false);
        setSearch('');
    };

    const removeNode = useCallback((nodeId: string) => {
        const node = nodes.get(nodeId);
        if (!node || node.type === OUTPUT_NODE_TYPE) return;
        onChange({ nodes: graph.nodes.filter(other => other.id !== nodeId), links: graph.links.filter(link => link.fromNode !== nodeId && link.toNode !== nodeId) }, true);
        onSelect(null);
    }, [graph, nodes, onChange, onSelect]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeId) removeNode(selectedNodeId);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [removeNode, selectedNodeId]);

    const onMouseMove = (event: React.MouseEvent) => {
        if (isPanning) updatePan(event.movementX, event.movementY);
        const point = toGraph(event.clientX, event.clientY);
        if (drag) {
            onChange({ ...graph, nodes: graph.nodes.map(node => (node.id === drag.nodeId ? { ...node, x: point.x - drag.dx, y: point.y - drag.dy } : node)) }, false);
        }
        if (linking) setLinking({ ...linking, x: point.x, y: point.y });
    };

    const onMouseUp = () => {
        if (drag) onChange(graph, true);
        setDrag(null);
        setLinking(null);
        endPan();
    };

    const connect = (toNode: string, toInput: string) => {
        if (!linking) return;
        const { fromNode, fromOutput } = linking;
        setLinking(null);
        if (wouldCreateCycle(graph, fromNode, toNode)) return;
        // One wire into each input: a new one replaces the old.
        const links = graph.links.filter(link => !(link.toNode === toNode && link.toInput === toInput));
        onChange({ ...graph, links: [...links, { fromNode, fromOutput, toNode, toInput }] }, true);
    };

    const palette = MATERIAL_NODE_DEFINITIONS.filter(definition => definition.type !== OUTPUT_NODE_TYPE
        && (!search || definition.label.toLowerCase().includes(search.toLowerCase()) || definition.category.toLowerCase().includes(search.toLowerCase())));

    return (
        <div
            ref={container}
            className="relative flex-1 overflow-hidden bg-[#0d0f12]"
            style={{ backgroundImage: 'radial-gradient(#1f2937 1px, transparent 1px)', backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}
            onWheel={(event) => handleWheel(event, container.current)}
            onMouseDown={(event) => {
                if (event.button === 1 || event.button === 2 || event.target === container.current) {
                    beginPan();
                    if (event.button === 0) onSelect(null);
                }
            }}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className="absolute left-3 top-3 z-20">
                <button onClick={() => setPaletteOpen(open => !open)} className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white hover:bg-blue-500" aria-label="Add node">
                    <Plus size={12} /> Add node
                </button>
                {paletteOpen && (
                    <div className="mt-1 w-64 rounded border border-gray-700 bg-gray-900 p-2 shadow-xl">
                        <div className="mb-2 flex items-center gap-1 rounded border border-gray-700 bg-gray-950 px-2">
                            <Search size={12} className="text-gray-500" />
                            <input autoFocus aria-label="Search nodes" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search nodes…" className="w-full bg-transparent py-1 text-xs text-white outline-none" />
                        </div>
                        <div className="max-h-72 overflow-y-auto">
                            {palette.map(definition => (
                                <button key={definition.type} onClick={() => addNode(definition.type)} title={definition.description} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-gray-200 hover:bg-gray-800">
                                    <span>{definition.label}</span>
                                    <span className="text-[9px] uppercase text-gray-500">{definition.category}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <div className="absolute left-0 top-0" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: '0 0' }}>
                <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
                    {graph.links.map((link, index) => {
                        const from = nodes.get(link.fromNode);
                        const to = nodes.get(link.toNode);
                        if (!from || !to) return null;
                        const port = getMaterialNodeDefinition(from.type)!.outputs.find(output => output.key === link.fromOutput);
                        return (
                            <path
                                key={index}
                                d={wirePath(pinPosition(from, 'out', link.fromOutput), pinPosition(to, 'in', link.toInput))}
                                stroke={port ? PIN_COLORS[port.type] : '#888'}
                                strokeWidth={2.5}
                                fill="none"
                                className="pointer-events-auto cursor-pointer hover:opacity-60"
                                onClick={() => onChange({ ...graph, links: graph.links.filter((_, at) => at !== index) }, true)}
                            >
                                <title>Click to remove</title>
                            </path>
                        );
                    })}
                    {linking && (() => {
                        const from = nodes.get(linking.fromNode);
                        return from ? <path d={wirePath(pinPosition(from, 'out', linking.fromOutput), linking)} stroke={PIN_COLORS[linking.type]} strokeWidth={2} strokeDasharray="5 4" fill="none" /> : null;
                    })()}
                </svg>

                {graph.nodes.map(node => {
                    const definition = getMaterialNodeDefinition(node.type)!;
                    const selected = node.id === selectedNodeId;
                    return (
                        <div
                            key={node.id}
                            data-node-id={node.id}
                            className={`absolute select-none rounded-md border bg-gray-900/95 shadow-lg ${selected ? 'border-blue-500' : node.type === OUTPUT_NODE_TYPE ? 'border-emerald-700' : 'border-gray-700'}`}
                            style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: nodeHeight(node) }}
                            onMouseDown={(event) => {
                                event.stopPropagation();
                                onSelect(node.id);
                                if (event.button !== 0) return;
                                const point = toGraph(event.clientX, event.clientY);
                                setDrag({ nodeId: node.id, dx: point.x - node.x, dy: point.y - node.y });
                            }}
                        >
                            <div className={`flex h-7 items-center justify-between rounded-t-md px-2 text-[11px] font-bold ${node.type === OUTPUT_NODE_TYPE ? 'bg-emerald-900/60 text-emerald-200' : 'bg-gray-800 text-gray-200'}`} title={definition.description}>
                                <span>{definition.label}</span>
                                {node.type !== OUTPUT_NODE_TYPE && (
                                    <button aria-label={`Remove ${definition.label}`} onMouseDown={(event) => event.stopPropagation()} onClick={() => removeNode(node.id)} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                                )}
                            </div>
                            {definition.outputs.map(output => (
                                <div key={output.key} className="relative flex items-center justify-end pr-3 text-[10px] text-gray-300" style={{ height: ROW }}>
                                    {output.label}
                                    <span
                                        role="button"
                                        aria-label={`${definition.label} ${output.label} output`}
                                        className="absolute -right-[6px] h-3 w-3 cursor-crosshair rounded-full border border-gray-900"
                                        style={{ background: PIN_COLORS[output.type] }}
                                        onMouseDown={(event) => {
                                            event.stopPropagation();
                                            const at = pinPosition(node, 'out', output.key);
                                            setLinking({ fromNode: node.id, fromOutput: output.key, type: output.type, x: at.x, y: at.y });
                                        }}
                                    />
                                </div>
                            ))}
                            {definition.inputs.map(input => {
                                const wired = graph.links.some(link => link.toNode === node.id && link.toInput === input.key);
                                return (
                                    <div key={input.key} className="relative flex items-center pl-3 text-[10px] text-gray-300" style={{ height: ROW }}>
                                        <span
                                            role="button"
                                            aria-label={`${definition.label} ${input.label} input`}
                                            className="absolute -left-[6px] h-3 w-3 rounded-full border border-gray-900"
                                            style={{ background: wired ? PIN_COLORS[input.type] : '#374151' }}
                                            onMouseUp={(event) => {
                                                event.stopPropagation();
                                                connect(node.id, input.key);
                                            }}
                                        />
                                        {input.label}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export const MaterialGraphEditor: React.FC = () => {
    const assets = useMaterialAssets();
    const { textures, removeMaterialAsset } = useAssets();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const asset = assets.find(candidate => candidate.id === selectedId) ?? assets[0] ?? null;
    const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    const save = useCallback((next: MaterialAsset, immediately = false) => {
        const timers = pending.current;
        clearTimeout(timers.get(next.id));
        const write = () => {
            timers.delete(next.id);
            projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: next.id, value: materialAssetDocument(next) }])
                .then(() => setError(null), (failure: unknown) => {
                    frontendDiagnostics.failure('material_save_failed', failure);
                    setError('The material could not be saved: is a project open?');
                });
        };
        if (immediately) write();
        else timers.set(next.id, setTimeout(write, SAVE_DELAY_MS));
    }, []);
    useEffect(() => () => {
        // Leaving the tab saves what is waiting.
        for (const [id, timer] of pending.current) {
            clearTimeout(timer);
            const waiting = materialLibrary.get(id);
            if (waiting) void projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id, value: materialAssetDocument(waiting) }]).catch(() => undefined);
        }
    }, []);

    const update = useCallback((graph: MaterialGraph, commit: boolean) => {
        if (!asset) return;
        const next = { ...asset, graph };
        materialLibrary.upsert(next);
        if (commit) save(next);
    }, [asset, save]);

    const create = () => {
        const next: MaterialAsset = { id: crypto.randomUUID(), name: `Material ${assets.length + 1}`, graph: createMaterialGraph() };
        materialLibrary.upsert(next);
        save(next, true);
        setSelectedId(next.id);
        setSelectedNodeId(null);
    };

    const rename = (name: string) => {
        if (!asset) return;
        const next = { ...asset, name: name.slice(0, 128) || 'Material' };
        materialLibrary.upsert(next);
        save(next);
    };

    const remove = () => {
        if (!asset) return;
        // A save still waiting would bring it back.
        clearTimeout(pending.current.get(asset.id));
        pending.current.delete(asset.id);
        removeMaterialAsset(asset.id).then(() => {
            setError(null);
            setSelectedId(null);
            setSelectedNodeId(null);
        }, (failure: unknown) => {
            frontendDiagnostics.failure('material_remove_failed', failure);
            setError('The material could not be deleted.');
        });
    };

    const selectedNode = asset?.graph.nodes.find(node => node.id === selectedNodeId) ?? null;
    const selectedDefinition = selectedNode ? getMaterialNodeDefinition(selectedNode.type) : undefined;

    return (
        <div className="flex h-full min-h-0 w-full bg-gray-950 text-white">
            <aside className="flex w-56 shrink-0 flex-col border-r border-gray-800">
                <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Materials</span>
                    <button onClick={create} aria-label="New material" className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-700"><Plus size={12} /> New</button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {assets.length === 0 && <p className="px-1 text-[11px] text-gray-500">No materials yet. A material is a node graph; give one to a model's material in the Retexture tab.</p>}
                    {assets.map(candidate => (
                        <button
                            key={candidate.id}
                            onClick={() => { setSelectedId(candidate.id); setSelectedNodeId(null); }}
                            className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left text-xs ${candidate.id === asset?.id ? 'bg-blue-900/40 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                        >
                            {candidate.name}
                        </button>
                    ))}
                </div>
            </aside>

            {asset ? (
                <>
                    <MaterialGraphCanvas graph={asset.graph} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} onChange={update} />
                    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-gray-800 p-3">
                        <div className="flex items-center gap-2">
                            <input aria-label="Material name" value={asset.name} onChange={(event) => rename(event.target.value)} className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" />
                            <button onClick={remove} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><Trash2 size={14} /></button>
                        </div>
                        <MaterialPreview assetId={asset.id} />
                        {error && <p className="text-[11px] text-amber-400">{error}</p>}
                        {selectedNode && selectedDefinition ? (
                            <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
                                <div className="text-[11px] font-bold text-gray-200">{selectedDefinition.label}</div>
                                <p className="text-[10px] text-gray-500">{selectedDefinition.description}</p>
                                {selectedDefinition.params.length === 0 && <p className="text-[10px] text-gray-500">No settings.</p>}
                                {selectedDefinition.params.map(param => (
                                    <ParamField
                                        key={param.key}
                                        param={param}
                                        value={selectedNode.params[param.key]}
                                        textures={textures}
                                        onChange={(value) => update({
                                            ...asset.graph,
                                            nodes: asset.graph.nodes.map(node => (node.id === selectedNode.id ? { ...node, params: { ...node.params, [param.key]: value } } : node)),
                                        }, true)}
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-[11px] text-gray-500">Select a node to set it. Drag from an output to an input to wire them; click a wire to remove it.</p>
                        )}
                    </aside>
                </>
            ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-gray-500">Create a material to start.</div>
            )}
        </div>
    );
};
