import {
    OUTPUT_NODE_TYPE,
    REROUTE_NODE_TYPE,
    getMaterialNodeDefinition,
    normalizeMaterialGraph,
    readParam,
    resolvedPortType,
    type MaterialGraphNode,
    type MaterialInputDef,
    type MaterialValueType,
} from '../../runtime/materials/materialGraph';
import { NODE_PREVIEW_SIZE } from '../../runtime/materials/materialPreviews';
import type { NodeLook } from '../NodeGraph/model';
import type { NodeView, PinKindStyle, PinView } from '../NodeGraph/types';

/**
 * How the shader graph's nodes show on the node graph canvas: their pins in rows (under group
 * headings where the node's inputs name groups), the value an unwired input takes, and their preview.
 */

export const MATERIAL_KINDS: Readonly<Record<string, PinKindStyle>> = {
    float: { colour: '#a3a3a3', words: 'number' },
    vec2: { colour: '#4ade80', words: 'vector 2' },
    vec3: { colour: '#facc15', words: 'vector 3 or colour' },
    vec4: { colour: '#c084fc', words: 'vector 4' },
    auto: { colour: '#e2e3e5', words: 'number or vector' },
};

/** Any value goes into any input (widened or cut down); the same type, or an input taking any, suits best. */
export const materialMatch = (from: string, to: string): number => (from === to || from === 'auto' || to === 'auto' ? 2 : 1);

export const MATERIAL_CATEGORY_TINTS: Readonly<Record<string, string>> = {
    Output: '#2f4f45', Input: '#3f4a5c', Geometry: '#2f5560', UV: '#5f5230', Texture: '#4b3f6b', Procedural: '#523d66',
    Color: '#2f5a48', Math: '#3d4370', Vector: '#634a2c', Logic: '#5f3448', Custom: '#45562e', Utility: '#46474d',
};

export const MATERIAL_NODE_WIDTH = 200;

const probe = (() => {
    try {
        const graph = normalizeMaterialGraph({ nodes: [{ id: 'probe', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: {}, name: 'probe', color: '#123456', collapsed: true, bypass: true }], links: [] });
        return graph.nodes[0] as MaterialGraphNode & NodeLook;
    } catch {
        return null;
    }
})();
/** Whether shader graphs keep a node's own name, colour and folding (asked of the graph's reader once). */
export const MATERIAL_LOOKS_KEPT = probe?.name === 'probe' && probe.color === '#123456' && probe.collapsed === true;
/** Whether shader graphs keep a node bypassed (the shader then passes its main input through). */
export const MATERIAL_BYPASS_KEPT = probe?.bypass === true;

/** True for nodes that show their value as an image. */
export const showsPreview = (node: Pick<MaterialGraphNode, 'type'>): boolean => node.type !== OUTPUT_NODE_TYPE && node.type !== REROUTE_NODE_TYPE;

const toHex = (rgb: readonly number[]): string => `#${rgb.slice(0, 3).map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** The value an unwired input takes from its node's settings, shown beside it. */
const inlineValue = (node: MaterialGraphNode, input: MaterialInputDef): Pick<PinView, 'inline' | 'inlineColour'> => {
    const fallback = input.fallback;
    if (typeof fallback !== 'object' || !('param' in fallback)) return {};
    const param = getMaterialNodeDefinition(node.type)?.params.find((candidate) => candidate.key === fallback.param);
    if (!param) return {};
    const value = readParam(param, node.params[param.key]);
    if (param.kind === 'color' && Array.isArray(value)) return { inlineColour: toHex(value as number[]) };
    if (param.kind === 'float' && typeof value === 'number') return { inline: value.toFixed(2) };
    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return { inline: (value as number[]).map((item) => item.toFixed(1)).join(', ') };
    return {};
};

/** The heading an input is listed under, when its node's definition gives one. */
const groupOf = (input: MaterialInputDef): string | undefined => {
    const group = (input as MaterialInputDef & { group?: unknown }).group;
    return typeof group === 'string' && group ? group : undefined;
};

/** How one node shows on the canvas. */
export const materialNodeView = (
    node: MaterialGraphNode,
    options: { autoTypes?: ReadonlyMap<string, MaterialValueType>; previews: boolean; unused?: boolean },
): NodeView => {
    const definition = getMaterialNodeDefinition(node.type);
    const autoTypes = options.autoTypes ?? new Map<string, MaterialValueType>();
    const look = node as MaterialGraphNode & NodeLook;
    const isOutput = node.type === OUTPUT_NODE_TYPE;
    const label = definition?.label ?? node.type;
    const inputs: PinView[] = (definition?.inputs ?? []).map((input) => {
        const group = groupOf(input);
        return { key: input.key, label: input.label, kind: resolvedPortType(input.type, node.id, autoTypes), ...(group ? { group } : {}), ...inlineValue(node, input) };
    });
    const outputs: PinView[] = (definition?.outputs ?? []).map((output) => ({ key: output.key, label: output.label, kind: resolvedPortType(output.type, node.id, autoTypes) }));
    return {
        title: (MATERIAL_LOOKS_KEPT && look.name) || label,
        tint: MATERIAL_CATEGORY_TINTS[definition?.category ?? 'Utility'] ?? MATERIAL_CATEGORY_TINTS.Utility,
        layout: node.type === REROUTE_NODE_TYPE ? 'dot' : 'rows',
        width: MATERIAL_NODE_WIDTH,
        body: options.previews && showsPreview(node) ? NODE_PREVIEW_SIZE : 0,
        inputs,
        outputs,
        ...(options.unused ? { unused: true } : {}),
        ...(node.parameter ? { badge: node.parameter } : {}),
        description: options.unused ? `${definition?.description ?? ''} Not used: it feeds nothing the material reads.` : definition?.description,
        canBypass: MATERIAL_BYPASS_KEPT && !isOutput && node.type !== REROUTE_NODE_TYPE && Boolean(definition?.inputs.length && definition.outputs.length),
        canDelete: !isOutput,
        ...(isOutput ? { output: true } : {}),
        searchText: `${label} ${definition?.category ?? ''}${node.parameter ? ` ${node.parameter}` : ''}`,
    };
};
