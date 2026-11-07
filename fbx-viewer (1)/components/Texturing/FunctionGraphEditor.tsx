import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PlusIcon, TrashIcon, WarningIcon } from '../UI/Icons';
import { Button, IconButton } from '../UI/kit';
import { Select } from '../UI/Select';
import type { FinderEntry } from '../NodeGraph/finder';
import { cardLayout } from '../NodeGraph/layout';
import type { EditableFrame, EditableGraph, EditableLink, EditableNode, NodeLook, PinSet } from '../NodeGraph/model';
import { NodeGraphCanvas, type NodeGraphAdapter } from '../NodeGraph/NodeGraphCanvas';
import type { NodeView, PinKindStyle, PinView } from '../NodeGraph/types';
import {
    FN_CATEGORY_ORDER,
    FN_REROUTE_TYPE,
    FN_RESULT_TYPE,
    FN_SAMPLE_TYPE,
    FN_SETTING_TYPE,
    FUNCTION_NODE_DEFINITIONS,
    NAMED_SETTING_KINDS,
    compileFunction,
    createFunctionNode,
    fallbackKey,
    functionNodeDefinition,
    newFunctionNodeId,
    type CompiledFunction,
    type FnCategory,
    type FnLink,
    type FnNode,
    type FnParamDef,
    type FunctionGraph,
    type FunctionUse,
    type NamedSetting,
} from '../../texturing/graph/functionGraph';
import { MAX_NAMED_SETTINGS, settingDefault, settingKeyFor } from '../../texturing/graph/nodes/processors';
import type { TexGraphComment, TexParamDef } from '../../texturing/graph/types';
import { DraftNumber, DraftText, ParamControl } from './TextureParamField';
import { FUNCTION_PREVIEW_SIZE, valueWords, type FunctionPreview, type FunctionPreviews } from './functionPreviews';

/** A count with its word, singular for one: "1 step", "3 steps". */
const countWords = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * FUNCTION GRAPH EDITING
 *
 * A processor's function graph on the shared node canvas, every node showing its value as it is
 * built (a small picture in a Pixel processor, the numbers in a Value processor); the inspector for
 * a function node; and the editor of a processor's named settings.
 */

// ---- pins ----

export const FN_KINDS: Readonly<Record<string, PinKindStyle>> = {
    float: { colour: '#a3a3a3', words: 'a number' },
    int: { colour: '#7dd3c0', words: 'a whole number' },
    bool: { colour: '#f28b82', words: 'yes or no' },
    vec2: { colour: '#7fb0e8', words: 'two numbers' },
    vec3: { colour: '#8fd18b', words: 'three numbers' },
    vec4: { colour: '#e9b949', words: 'four numbers (a colour)' },
    auto: { colour: '#f5f5f5', words: 'any value' },
};

const sizeOfKind = (kind: string): number => (kind === 'vec2' ? 2 : kind === 'vec3' ? 3 : kind === 'vec4' ? 4 : 1);

/**
 * What goes into what: anything into a pin that takes any value, a single number (or whole number, or
 * yes or no) into anything, a vector only into one of its own size.
 */
export const fnMatch = (from: string, to: string): number => {
    if (from === to || to === 'auto' || from === 'auto') return 2;
    if (sizeOfKind(from) === 1) return 1;
    return 0;
};
const fnRefusal = (from: string, to: string): string => (sizeOfKind(to) === 1
    ? 'A vector does not fit one number: take one of its parts with Split.'
    : `It takes ${FN_KINDS[to]?.words ?? 'another value'}, not ${FN_KINDS[from]?.words ?? 'this'}: split or join the parts so they match.`);

const FN_TINTS: Record<FnCategory, string> = {
    Inputs: '#3f4a5c', Values: '#46474d', Maths: '#2f5a48', Trigonometry: '#2d5653', Vectors: '#3d4370', Logic: '#5f3448', Random: '#4b3f6b', Result: '#2b4a6b',
};
const NODE_WIDTH = 150;
const LOOK_KEYS = ['name', 'color', 'collapsed'] as const;

// ---- the graph read into the canvas's shape, and back ----

const editableNodes = new WeakMap<FnNode, EditableNode<FnNode>>();
const editableLinks = new WeakMap<FnLink, EditableLink>();
const linkSources = new WeakMap<EditableLink, FnLink>();
const editableFrames = new WeakMap<TexGraphComment, EditableFrame>();
const frameSources = new WeakMap<EditableFrame, TexGraphComment>();

const lookOf = (node: NodeLook): NodeLook => ({
    ...(node.name ? { name: node.name } : {}),
    ...(node.color ? { color: node.color } : {}),
    ...(node.collapsed ? { collapsed: true } : {}),
});
const toNode = (node: FnNode): EditableNode<FnNode> => {
    let found = editableNodes.get(node);
    if (!found) editableNodes.set(node, found = { id: node.id, type: node.type, x: node.x, y: node.y, ...lookOf(node), source: node });
    return found;
};
const toLink = (link: FnLink): EditableLink => {
    let found = editableLinks.get(link);
    if (!found) {
        found = { from: link.from, fromPin: link.fromOutput, to: link.to, toPin: link.toInput };
        editableLinks.set(link, found);
        linkSources.set(found, link);
    }
    return found;
};
const toFrame = (comment: TexGraphComment): EditableFrame => {
    let found = editableFrames.get(comment);
    if (!found) {
        found = { id: comment.id, x: comment.x, y: comment.y, width: comment.width, height: comment.height, title: comment.text, colour: comment.color };
        editableFrames.set(comment, found);
        frameSources.set(found, comment);
    }
    return found;
};
const fromNode = (node: EditableNode<FnNode>): FnNode => {
    const source = node.source;
    if (editableNodes.get(source) === node) return source;
    const next: FnNode = { ...source, id: node.id, x: node.x, y: node.y };
    for (const key of LOOK_KEYS) delete next[key];
    Object.assign(next, lookOf(node));
    editableNodes.set(next, { ...node, source: next });
    return next;
};
const fromEditable = (editable: EditableGraph<FnNode>, base: FunctionGraph): FunctionGraph => {
    const nodes = editable.nodes.map(fromNode);
    const links = editable.links.map((link) => linkSources.get(link) ?? { from: link.from, fromOutput: link.fromPin, to: link.to, toInput: link.toPin });
    const comments = editable.frames.map((frame) => frameSources.get(frame) ?? { id: frame.id, x: frame.x, y: frame.y, width: frame.width, height: frame.height, text: frame.title, color: frame.colour });
    const same = <T,>(a: readonly T[], b: readonly T[] | undefined) => a.length === (b?.length ?? 0) && a.every((item, index) => item === b![index]);
    if (same(nodes, base.nodes) && same(links, base.links) && same(comments, base.comments)) return base;
    return comments.length ? { nodes, links, comments } : { nodes, links };
};

// ---- what each node shows ----

const number = (value: unknown): string => {
    const n = Number(value);
    return Number.isFinite(n) ? String(Number(n.toFixed(Math.abs(n) < 10 ? 3 : 1))) : '0';
};

/** A node's title: its own name, or what it does with the setting or picture it reads. */
export const functionNodeTitle = (node: FnNode, settings: readonly NamedSetting[]): string => {
    if (node.name) return node.name;
    if (node.type === FN_SETTING_TYPE) return `Setting: ${settings.find((setting) => setting.key === node.params.setting)?.label ?? 'choose one'}`;
    if (node.type === FN_SAMPLE_TYPE) return `Sample picture ${String(node.params.picture ?? 'a').toUpperCase()}`;
    return functionNodeDefinition(node.type)?.label ?? `Not available: ${node.type}`;
};

interface ViewContext {
    use: FunctionUse;
    compiled: CompiledFunction;
    settings: readonly NamedSetting[];
    preview?: FunctionPreview;
}

const functionNodeView = (node: FnNode, context: ViewContext): NodeView => {
    const definition = functionNodeDefinition(node.type);
    const types = context.compiled.types.get(node.id);
    const error = definition ? context.compiled.errors.get(node.id) : `This version of the editor has no "${node.type}" function node.`;
    const inputs: PinView[] = (definition?.inputs ?? []).map((port) => ({
        key: port.key, label: port.label, kind: port.type,
        ...(typeof port.fallback === 'number' ? { inline: number(node.params[fallbackKey(port.key)] ?? port.fallback) } : port.fallback === 'uv' ? { inline: context.use === 'pixel' ? 'here' : 'middle' } : {}),
    }));
    const outputs: PinView[] = (definition?.outputs ?? []).map((port) => ({ key: port.key, label: port.label, kind: types?.[port.key] ?? port.type }));
    const constant = definition?.category === 'Values' && node.type !== FN_REROUTE_TYPE ? node.params.value : undefined;
    const value = context.preview?.value;
    const badge = context.use === 'value' && value
        ? valueWords(context.preview?.type, value)
        : constant !== undefined ? (Array.isArray(constant) ? constant.map(number).join(', ') : typeof constant === 'boolean' ? (constant ? 'yes' : 'no') : number(constant)) : undefined;
    return {
        title: functionNodeTitle(node, context.settings),
        tint: definition ? FN_TINTS[definition.category] : '#5a4317',
        layout: node.type === FN_REROUTE_TYPE ? 'dot' : 'rows',
        width: NODE_WIDTH,
        body: context.use === 'pixel' && definition && node.type !== FN_REROUTE_TYPE ? FUNCTION_PREVIEW_SIZE + 4 : 0,
        inputs,
        outputs,
        ...(error ? { error } : {}),
        ...(!definition ? { missing: true } : {}),
        ...(badge && !error ? { badge } : {}),
        description: definition?.description,
        canBypass: false,
        canDelete: node.type !== FN_RESULT_TYPE,
        ...(node.type === FN_RESULT_TYPE ? { output: true } : {}),
        searchText: `${functionNodeTitle(node, context.settings)} ${definition?.category ?? ''}`,
    };
};

/** The finder's choices: every function node that means something here (no Result: there is one). */
const functionEntries = (use: FunctionUse): FinderEntry[] => FUNCTION_NODE_DEFINITIONS
    .filter((definition) => definition.type !== FN_RESULT_TYPE && definition.type !== FN_REROUTE_TYPE && !(use === 'value' && definition.pixelOnly))
    .map((definition) => ({
        id: definition.type, label: definition.label, category: definition.category, description: definition.description, keywords: definition.keywords,
        inputs: definition.inputs.map((port) => port.type), outputs: definition.outputs.map((port) => port.type),
    }))
    .sort((a, b) => FN_CATEGORY_ORDER.indexOf(a.category as FnCategory) - FN_CATEGORY_ORDER.indexOf(b.category as FnCategory));

const pinsOf = (node: EditableNode<FnNode>): PinSet => {
    const definition = functionNodeDefinition(node.type);
    return {
        inputs: (definition?.inputs ?? []).map((port) => ({ key: port.key, kind: port.type })),
        outputs: (definition?.outputs ?? []).map((port) => ({ key: port.key, kind: port.type })),
    };
};

const CLIPBOARD_KIND = 'auvra-function-graph';
const readFunctionClipboard = (text: string): { nodes: FnNode[]; links: FnLink[] } | null => {
    try {
        const value = JSON.parse(text) as { kind?: unknown; nodes?: unknown; links?: unknown };
        if (value?.kind !== CLIPBOARD_KIND || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return null;
        // One Result to a function: a copied one is left behind.
        const nodes = (value.nodes as FnNode[]).filter((node) => node && typeof node.id === 'string' && typeof node.type === 'string' && node.type !== FN_RESULT_TYPE);
        const ids = new Set(nodes.map((node) => node.id));
        const links = (value.links as FnLink[]).filter((link) => link && ids.has(link.from) && ids.has(link.to));
        return { nodes, links };
    } catch {
        return null;
    }
};

const FunctionThumb: React.FC<{ previews: FunctionPreviews; nodeId: string }> = ({ previews, nodeId }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(previews.subscribe, previews.getVersion);
    useEffect(() => {
        const context = canvas.current?.getContext('2d');
        if (!context) return;
        const image = previews.get(nodeId)?.image;
        if (image) context.putImageData(image, 0, 0);
        else context.clearRect(0, 0, FUNCTION_PREVIEW_SIZE, FUNCTION_PREVIEW_SIZE);
    }, [nodeId, previews, version]);
    return (
        <div className="flex justify-center pt-0.5">
            <canvas ref={canvas} width={FUNCTION_PREVIEW_SIZE} height={FUNCTION_PREVIEW_SIZE} className="rounded-sm bg-well" style={{ width: FUNCTION_PREVIEW_SIZE, height: FUNCTION_PREVIEW_SIZE }} />
        </div>
    );
};

// ---- the canvas ----

export const FunctionGraphCanvas: React.FC<{
    fn: FunctionGraph;
    use: FunctionUse;
    settings: readonly NamedSetting[];
    pictures: readonly string[];
    previews: FunctionPreviews;
    selection: ReadonlySet<string>;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    onSelect: (ids: string[]) => void;
    onChange: (fn: FunctionGraph, coalesce?: string) => void;
}> = (props) => {
    const { fn, use, settings, pictures, previews, selection, canUndo, canRedo, onUndo, onRedo } = props;
    const latest = useRef(props);
    latest.current = props;
    const [selectedFrame, setSelectedFrame] = useState<string | null>(null);
    const previewVersion = useSyncExternalStore(previews.subscribe, previews.getVersion);
    const compiled = useMemo(() => compileFunction(fn, { use, settings, pictures }), [fn, pictures, settings, use]);

    const editable = useMemo<EditableGraph<FnNode>>(() => ({ nodes: fn.nodes.map(toNode), links: fn.links.map(toLink), frames: (fn.comments ?? []).map(toFrame) }), [fn]);

    const viewCache = useRef(new Map<string, { key: string; view: NodeView }>());
    const views = useMemo(() => {
        void previewVersion;
        const result = new Map<string, NodeView>();
        for (const node of fn.nodes) {
            const view = functionNodeView(node, { use, compiled, settings, preview: previews.get(node.id) });
            const key = JSON.stringify(view);
            const cached = viewCache.current.get(node.id);
            if (cached?.key === key) result.set(node.id, cached.view);
            else { viewCache.current.set(node.id, { key, view }); result.set(node.id, view); }
        }
        return result;
    }, [compiled, fn.nodes, previewVersion, previews, settings, use]);

    const entries = useMemo(() => functionEntries(use), [use]);
    const renderBody = useCallback((nodeId: string, view: NodeView) => (view.body ? <FunctionThumb previews={latest.current.previews} nodeId={nodeId} /> : null), []);

    const adapter = useMemo<NodeGraphAdapter<FnNode>>(() => ({
        kind: `function-${use}`,
        kinds: FN_KINDS,
        match: fnMatch,
        refusal: fnRefusal,
        entries,
        createNode: (type, at) => (functionNodeDefinition(type) ? toNode(createFunctionNode(type, at.x, at.y)) : null),
        createReroute: (at) => toNode(createFunctionNode(FN_REROUTE_TYPE, at.x, at.y)),
        sizeOf: (node) => cardLayout(functionNodeView(node.source, { use, compiled: compileFunction({ nodes: [node.source], links: [] }, { use }), settings: [] }), node, new Set()),
        pins: pinsOf,
        newId: newFunctionNodeId,
        copy: (current, ids) => {
            const written = fromEditable(current, latest.current.fn);
            return JSON.stringify({
                kind: CLIPBOARD_KIND,
                nodes: written.nodes.filter((node) => ids.has(node.id)).map((node) => structuredClone(node)),
                links: written.links.filter((link) => ids.has(link.from) && ids.has(link.to)).map((link) => ({ ...link })),
            });
        },
        paste: (text) => {
            const clipboard = readFunctionClipboard(text);
            if (!clipboard?.nodes.length) return null;
            return { nodes: clipboard.nodes.map((node) => toNode(structuredClone(node))), links: clipboard.links.map((link) => toLink({ ...link })) };
        },
        looks: true,
        renderBody,
    }), [entries, renderBody, use]);

    const onEdit = useCallback((next: EditableGraph<FnNode>, coalesce?: string) => {
        const current = latest.current.fn;
        const written = fromEditable(next, current);
        if (written !== current) latest.current.onChange(written, coalesce);
    }, []);
    const onSelect = useCallback((ids: string[], frame?: string | null) => {
        setSelectedFrame(frame ?? null);
        latest.current.onSelect(ids);
    }, []);

    return (
        <NodeGraphCanvas
            label="Function graph"
            graph={editable}
            views={views}
            adapter={adapter}
            selection={selection}
            selectedFrame={selectedFrame}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
            undoKeys="workspace"
            onSelect={onSelect}
            onEdit={onEdit}
            status={compiled.error ? `Not working yet: ${compiled.error}` : `${countWords(fn.nodes.length, 'node')}, ${countWords(compiled.ir?.steps.length ?? 0, 'step')}`}
        />
    );
};

// ---- the inspector ----

/** A function node's setting as the texture inspector's controls show it (those it has). */
const asTexParam = (param: FnParamDef): TexParamDef | null => {
    switch (param.kind) {
        case 'float': case 'int': case 'bool': case 'color': case 'vec2': case 'select':
            return { key: param.key, label: param.label, kind: param.kind, default: param.default, min: param.min, max: param.max, step: param.step, options: param.options, hint: param.hint };
        case 'text':
            return { key: param.key, label: param.label, kind: 'string', default: param.default, hint: param.hint };
        default:
            return null;
    }
};

export const FunctionNodeInspector: React.FC<{
    node: FnNode;
    use: FunctionUse;
    settings: readonly NamedSetting[];
    pictures: readonly string[];
    error?: string;
    preview?: FunctionPreview;
    onChange: (node: FnNode, coalesce?: string) => void;
}> = ({ node, use, settings, pictures, error, preview, onChange }) => {
    const definition = functionNodeDefinition(node.type);
    if (!definition) {
        return <div className="flex gap-1.5 rounded border border-warn/40 bg-warn/10 p-1.5 text-2xs text-warn"><WarningIcon size={12} className="mt-px shrink-0" /><span>This version of the editor has no "{node.type}" function node. It is kept as it is.</span></div>;
    }
    const set = (key: string, value: unknown) => onChange({ ...node, params: { ...node.params, [key]: value } }, `${node.id}:${key}`);
    const unwired = definition.inputs.filter((port) => typeof port.fallback === 'number');
    return (
        <div className="space-y-3">
            <div>
                <div className="text-xs font-semibold text-ink">{functionNodeTitle(node, settings)}</div>
                {node.name && <div className="text-2xs text-ink-2">{definition.label}</div>}
                <p className="mt-0.5 text-2xs leading-snug text-ink-3">{definition.description}</p>
            </div>
            {error && <div className="flex gap-1.5 rounded border border-bad/40 bg-bad/10 p-1.5 text-2xs text-bad"><WarningIcon size={12} className="mt-px shrink-0" /><span>{error}</span></div>}
            {use === 'value' && preview?.value && !error && (
                <div className="flex items-baseline justify-between rounded border border-line bg-well px-2 py-1 text-2xs">
                    <span className="text-ink-3">Its value now</span>
                    <span className="font-mono text-ink">{valueWords(preview.type, preview.value)}</span>
                </div>
            )}
            {definition.params.map((param) => {
                const value = node.params[param.key] ?? param.default;
                if (param.kind === 'setting') {
                    return (
                        <div key={param.key} className="space-y-1">
                            <span className="text-2xs text-ink-2">{param.label}</span>
                            {settings.length
                                ? <Select value={String(value)} placeholder="Choose a setting" options={settings.map((setting) => ({ value: setting.key, label: setting.label }))} onChange={(next) => set(param.key, next)} className="w-full" />
                                : <p className="text-2xs leading-snug text-ink-3">The processor has no named settings yet: add them in its inspector, under Named settings.</p>}
                        </div>
                    );
                }
                if (param.kind === 'picture') {
                    return (
                        <div key={param.key} className="space-y-1">
                            <span className="text-2xs text-ink-2">{param.label}</span>
                            <Select value={String(value)} options={pictures.map((key) => ({ value: key, label: `Picture ${key.toUpperCase()}` }))} onChange={(next) => set(param.key, next)} className="w-full" />
                        </div>
                    );
                }
                if (param.kind === 'vec3') {
                    const v = (Array.isArray(value) ? value : [0, 0, 0]) as number[];
                    return (
                        <div key={param.key} className="space-y-1">
                            <span className="text-2xs text-ink-2">{param.label}</span>
                            <div className="flex gap-1">
                                {[0, 1, 2].map((index) => (
                                    <DraftNumber key={index} label={`${param.label} ${'XYZ'[index]}`} value={Number(v[index]) || 0} className="w-full min-w-0"
                                        onCommit={(next) => set(param.key, [0, 1, 2].map((at) => (at === index ? next : Number(v[at]) || 0)))} />
                                ))}
                            </div>
                        </div>
                    );
                }
                const shown = asTexParam(param);
                if (!shown) return null;
                return (
                    <div key={param.key} className={shown.kind === 'bool' || shown.kind === 'color' ? 'flex items-center justify-between gap-2' : 'space-y-1'} title={param.hint}>
                        <span className="text-2xs text-ink-2">{param.label}</span>
                        <ParamControl param={shown} value={value} textures={[]} onChange={(next) => set(param.key, next)} />
                    </div>
                );
            })}
            {unwired.length > 0 && (
                <div className="space-y-1.5 border-t border-line pt-2">
                    <div className="text-2xs font-semibold text-ink-2">Inputs with nothing wired in</div>
                    {unwired.map((port) => (
                        <label key={port.key} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-2xs text-ink-2">{port.label}</span>
                            <DraftNumber label={`${port.label} when unwired`} value={Number(node.params[fallbackKey(port.key)] ?? port.fallback) || 0} className="w-20"
                                onCommit={(next) => set(fallbackKey(port.key), next)} />
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
};

// ---- named settings ----

export const NamedSettingsEditor: React.FC<{
    settings: readonly NamedSetting[];
    onAdd: (setting: NamedSetting) => void;
    onChange: (index: number, setting: NamedSetting) => void;
    onRemove: (index: number) => void;
}> = ({ settings, onAdd, onChange, onRemove }) => {
    const add = () => {
        const label = settings.length ? `Setting ${settings.length + 1}` : 'Amount';
        onAdd({ key: settingKeyFor(label, settings.map((setting) => setting.key)), label, kind: 'float', default: 0.5, min: 0, max: 1 });
    };
    return (
        <div className="space-y-1.5 border-t border-line pt-2">
            <div className="flex items-center justify-between">
                <span className="text-2xs font-semibold text-ink-2">Named settings</span>
                <Button size="sm" variant="ghost" icon={<PlusIcon size={12} />} disabled={settings.length >= MAX_NAMED_SETTINGS} onClick={add}>Add a setting</Button>
            </div>
            {settings.length === 0 && <p className="text-2xs leading-snug text-ink-3">Settings of your own: they show below with the others, Setting nodes read them in the function, and each can be exposed as a parameter of the graph.</p>}
            {settings.map((setting, index) => (
                <div key={setting.key} className="space-y-1 rounded border border-line bg-well p-1.5">
                    <div className="flex items-center gap-1">
                        <DraftText label="Setting name" value={setting.label} maxLength={48} className="min-w-0 flex-1" onCommit={(label) => onChange(index, { ...setting, label: label.trim() || setting.label })} />
                        <Select value={setting.kind} options={NAMED_SETTING_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))}
                            onChange={(kind: NamedSetting['kind']) => {
                                const { min: _min, max: _max, ...rest } = setting;
                                const ranged = kind === 'float' || kind === 'int' || kind === 'vec2';
                                onChange(index, { ...rest, kind, default: settingDefault(kind, setting.default), ...(ranged ? { min: kind === 'vec2' ? -1 : 0, max: kind === 'int' ? 10 : 1 } : {}) });
                            }} className="w-[118px]" />
                        <IconButton label={`Remove ${setting.label}`} onClick={() => onRemove(index)}><TrashIcon size={12} /></IconButton>
                    </div>
                    {(setting.kind === 'float' || setting.kind === 'int' || setting.kind === 'vec2') && (
                        <div className="flex items-center gap-1 text-2xs text-ink-3">
                            <span>From</span>
                            <DraftNumber label={`${setting.label} lowest`} value={setting.min ?? 0} integer={setting.kind === 'int'} className="w-14" onCommit={(min) => onChange(index, { ...setting, min })} />
                            <span>to</span>
                            <DraftNumber label={`${setting.label} highest`} value={setting.max ?? 1} integer={setting.kind === 'int'} className="w-14" onCommit={(max) => onChange(index, { ...setting, max })} />
                            <span className="ml-auto font-mono text-ink-3" title="The name GLSL code reads it by">p_{setting.key}</span>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};
