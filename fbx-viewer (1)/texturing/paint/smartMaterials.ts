import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import { createNode, normalizeTextureGraph } from '../graph/document';
import type { GraphResolver } from '../graph/registry';
import { isParamLink, type GraphParameter, type TexGraphLink, type TexGraphNode, type TextureGraph } from '../graph/types';
import {
    CHANNEL_DEFAULT,
    CHANNEL_IS_COLOR,
    PAINT_CHANNELS,
    allLayers,
    paintId,
    readPaintLayers,
    type ChannelBlend,
    type FillSource,
    type MaskBlend,
    type MaskEffect,
    type PaintChannel,
    type PaintDocument,
    type PaintLayer,
} from './paintTypes';

/**
 * SAVED SMART MATERIALS
 *
 * A layer or folder kept in the project to be used again on any texture set: kept as a material asset
 * whose `paint` holds `{ smartMaterial }` (so it is never taken for a painted set, which names a model).
 * Only what travels is kept: fill and filter layers, folders, and generated mask effects. Paint layers,
 * painted masks and "what it wore before" belong to one set's pictures and are left out.
 *
 * Any smart material or smart mask can also be opened as a texture graph: a copy in the project, built
 * node for node from its layers, to be changed in the texture graph editor.
 */

export interface SavedSmartMaterial {
    version: 1;
    /** The layer or folder, with nothing tied to one texture set. */
    layer: PaintLayer;
    /** When it was saved (ms since 1970). */
    at: number;
}

/** What was left out of a saved smart material, because it belongs to one texture set. */
export interface LeftOut { paintLayers: number; paintedMasks: number; ownPictures: number }

const without = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => {
    const copy: Partial<T> = { ...value };
    for (const key of keys) delete copy[key];
    return copy as Omit<T, K>;
};

/**
 * The layer as a smart material: a deep copy with everything tied to this texture set left out (and
 * counted), or null when nothing would be left.
 */
export const smartMaterialFrom = (layer: PaintLayer): { layer: PaintLayer | null; leftOut: LeftOut } => {
    const leftOut: LeftOut = { paintLayers: 0, paintedMasks: 0, ownPictures: 0 };
    const clean = (item: PaintLayer): PaintLayer | null => {
        if (item.kind === 'paint') { leftOut.paintLayers++; return null; }
        const result = structuredClone(without(item, 'pictures', 'mask', 'layers')) as PaintLayer;
        const mask = (item.mask ?? []).filter((effect) => {
            if (effect.kind !== 'paint') return true;
            leftOut.paintedMasks++;
            return false;
        }).map((effect) => structuredClone(without(effect, 'pictures')) as MaskEffect);
        if (mask.length) result.mask = mask;
        if (item.kind === 'fill') {
            const fill = { ...(result.fill ?? {}) };
            const channels = { ...result.channels };
            for (const [channel, source] of Object.entries(fill) as Array<[PaintChannel, FillSource | undefined]>) {
                if (source?.kind !== 'current') continue;
                leftOut.ownPictures++;
                delete fill[channel];
                delete channels[channel];
            }
            if (!Object.keys(channels).length) return null;
            result.fill = fill;
            result.channels = channels;
        }
        if (item.kind === 'folder') {
            result.layers = (item.layers ?? []).map(clean).filter((inner): inner is PaintLayer => inner !== null);
            if (!result.layers.length) return null;
        }
        return result;
    };
    return { layer: clean(layer), leftOut };
};

/** A saved smart material read from a material asset's `paint`, or null when it holds none. */
export const readSmartMaterial = (paint: unknown): SavedSmartMaterial | null => {
    const record = paint && typeof paint === 'object' ? (paint as Record<string, unknown>).smartMaterial : null;
    if (!record || typeof record !== 'object') return null;
    const saved = record as Partial<SavedSmartMaterial>;
    const [layer] = readPaintLayers([saved.layer]);
    if (!layer) return null;
    return { version: 1, layer, at: typeof saved.at === 'number' && Number.isFinite(saved.at) ? saved.at : 0 };
};

/** Whether a material asset is a saved smart material (not a material to put on a model). */
export const isSmartMaterialAsset = (asset: Pick<MaterialAsset, 'paint'>): boolean => readSmartMaterial(asset.paint) !== null;

/**
 * A smart material put to use on a texture set: fresh ids for every layer and mask effect, and only the
 * channels the set has.
 */
export const instantiateSmartMaterial = (template: PaintLayer, document: Pick<PaintDocument, 'channels'>, name = template.name): PaintLayer => {
    const has = (channel: string) => document.channels.includes(channel as PaintChannel);
    const copy = (item: PaintLayer): PaintLayer => {
        const result = structuredClone(without(item, 'layers', 'mask', 'pictures')) as PaintLayer;
        result.id = paintId('l');
        result.channels = Object.fromEntries(Object.entries(item.channels).filter(([channel]) => has(channel)));
        if (item.fill) result.fill = Object.fromEntries(Object.entries(item.fill).filter(([channel]) => has(channel)));
        if (item.mask) result.mask = item.mask.map((effect) => ({ ...structuredClone(without(effect, 'pictures')), id: paintId('m') }));
        if (item.layers) result.layers = item.layers.map(copy);
        return result;
    };
    return { ...copy(template), name, from: name };
};

/** Where saved smart materials are put and taken back from: the material library and the project. */
export interface SmartMaterialStore {
    upsert: (asset: MaterialAsset) => void;
    remove: (id: string) => void;
    /** Keeps the asset in the project (throws when it cannot). */
    persist: (asset: MaterialAsset) => Promise<void>;
}

/**
 * Saves `layer` as a smart material called `name`. Throws, keeping nothing, when nothing of it can be
 * kept or the project will not take it.
 */
export const saveSmartMaterial = async (layer: PaintLayer, name: string, store: SmartMaterialStore): Promise<{ asset: MaterialAsset; leftOut: LeftOut }> => {
    const { layer: kept, leftOut } = smartMaterialFrom(layer);
    if (!kept) throw new Error('Nothing here can be saved as a smart material: paint layers and painted masks belong to this texture set. Fill layers, filters and smart masks can be.');
    const title = name.trim().slice(0, 80) || layer.name;
    const saved: SavedSmartMaterial = { version: 1, layer: { ...kept, name: title }, at: Date.now() };
    const asset: MaterialAsset = { id: crypto.randomUUID(), name: title, graph: createMaterialGraph(), paint: { smartMaterial: saved } as unknown as Record<string, unknown> };
    store.upsert(asset);
    try {
        await store.persist(asset);
    } catch (error) {
        store.remove(asset.id);
        throw error;
    }
    return { asset, leftOut };
};

// ---------------------------------------------------------------------------
// As a texture graph
// ---------------------------------------------------------------------------

type Ref = { node: string; output: string };

const MASK_BLEND_MODES: Record<MaskBlend, string> = { multiply: 'multiply', add: 'add', subtract: 'subtract', replace: 'normal', max: 'lighten', min: 'darken' };

/** Builds a texture graph node by node, then lays it out left to right by how deep each node sits. */
class GraphBuilder {
    readonly nodes: TexGraphNode[] = [];
    readonly links: TexGraphLink[] = [];
    readonly parameters: GraphParameter[] = [];
    private count = 0;
    private inlined = 0;
    private readonly shared = new Map<string, Ref>();

    add(type: string, params: Record<string, unknown> = {}, inputs: Record<string, Ref | null | undefined> = {}): Ref {
        const id = `n${++this.count}`;
        this.nodes.push({ ...createNode(type, 0, 0, params), id });
        for (const [input, ref] of Object.entries(inputs)) if (ref) this.links.push({ from: ref.node, fromOutput: ref.output, to: id, toInput: input });
        return { node: id, output: 'out' };
    }

    /** One node of a kind and settings, made the first time it is asked for (a mesh map, say). */
    once(key: string, make: () => Ref): Ref {
        let ref = this.shared.get(key);
        if (!ref) this.shared.set(key, ref = make());
        return ref;
    }

    /**
     * Copies the part of `graph` that makes `output` (a channel, an output node's id, or 'custom' for its
     * first named output), with its parameters carried over (named apart from others', labelled with
     * `label`, set to `values`). Returns what fed that output, or null when nothing did.
     */
    inline(graph: TextureGraph, output: string, values: Record<string, unknown>, label: string): Ref | null {
        const outputs = graph.nodes.filter((node) => node.type === 'output');
        const target = outputs.find((node) => node.id === output) ?? outputs.find((node) => node.params.channel === output) ?? (output === 'custom' ? outputs.find((node) => node.params.channel === 'custom') : undefined);
        const feed = target ? graph.links.find((link) => link.to === target.id && link.toInput === 'in') : undefined;
        if (!target || !feed) return null;
        const needed = new Set<string>();
        const visit = (id: string) => {
            if (needed.has(id)) return;
            needed.add(id);
            for (const link of graph.links) if (link.to === id) visit(link.from);
        };
        visit(feed.from);
        const prefix = `g${++this.inlined}_`;
        // Parameters keep their names unless another copied graph took them first.
        const renamed = new Map<string, string>();
        for (const parameter of graph.parameters) {
            let name = parameter.name;
            for (let n = 2; this.parameters.some((other) => other.name === name); n++) name = `${parameter.name}_${n}`;
            renamed.set(parameter.name, name);
            const value = values[parameter.name];
            this.parameters.push({ ...structuredClone(parameter), name, label: `${label}: ${parameter.label}`.slice(0, 80), default: value === undefined ? parameter.default : value as GraphParameter['default'] });
        }
        const relink = (value: unknown): unknown => {
            if (!isParamLink(value)) return value;
            if ('$bind' in value) return { $bind: renamed.get(value.$bind) ?? value.$bind };
            let expression = value.$expr;
            for (const [from, to] of renamed) if (from !== to) expression = expression.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
            return { $expr: expression };
        };
        for (const node of graph.nodes) {
            if (!needed.has(node.id)) continue;
            this.nodes.push({ ...structuredClone(node), id: prefix + node.id, params: Object.fromEntries(Object.entries(node.params).map(([key, value]) => [key, relink(structuredClone(value))])) });
        }
        for (const link of graph.links) if (needed.has(link.from) && needed.has(link.to)) this.links.push({ ...link, from: prefix + link.from, to: prefix + link.to });
        return { node: prefix + feed.from, output: feed.fromOutput };
    }

    graph(): TextureGraph {
        // Columns by the longest chain of inputs before each node, rows in the order nodes were made.
        const depth = new Map<string, number>();
        const inputsOf = new Map<string, string[]>();
        for (const link of this.links) inputsOf.set(link.to, [...(inputsOf.get(link.to) ?? []), link.from]);
        const depthOf = (id: string, seen = new Set<string>()): number => {
            const known = depth.get(id);
            if (known !== undefined) return known;
            if (seen.has(id)) return 0;
            seen.add(id);
            const value = Math.max(-1, ...(inputsOf.get(id) ?? []).map((from) => depthOf(from, seen))) + 1;
            depth.set(id, value);
            return value;
        };
        const rows = new Map<number, number>();
        for (const node of this.nodes) {
            const column = depthOf(node.id);
            const row = rows.get(column) ?? 0;
            rows.set(column, row + 1);
            node.x = 60 + column * 260;
            node.y = 60 + row * 170;
        }
        return normalizeTextureGraph({ version: 1, size: { w: 11, h: 11 }, seed: 0, nodes: this.nodes, links: this.links, parameters: this.parameters });
    }
}

/** Channels a layer or any layer in it touches, in the usual order. */
const channelsIn = (layer: PaintLayer): PaintChannel[] => {
    const used = new Set<PaintChannel>();
    for (const item of [layer, ...allLayers(layer.layers ?? [])]) for (const channel of Object.keys(item.channels) as PaintChannel[]) used.add(channel);
    return PAINT_CHANNELS.filter((channel) => used.has(channel));
};

/**
 * A texture graph that makes what `layer` (a smart material: a layer or a folder of them) lays on a plain
 * surface, one output per channel it touches. Painted pictures and "what it wore before" have no place in
 * a graph and are left out.
 */
export const smartMaterialGraph = (layer: PaintLayer, resolve: GraphResolver): TextureGraph => {
    const b = new GraphBuilder();
    const channels = channelsIn(layer);
    const position = () => b.once('position', () => b.add('meshMap', { map: 'position' }));
    const worldNormal = () => b.once('worldNormal', () => b.add('meshMap', { map: 'worldNormal' }));
    const constant = (channel: PaintChannel, value: [number, number, number]): Ref => (CHANNEL_IS_COLOR[channel]
        ? b.add('uniformColor', { color: [...value, 1] })
        : b.add('uniformValue', { value: value[0] }));
    const grey = (ref: Ref, fromColour: boolean): Ref => (fromColour ? b.add('grayscale', { mode: 'luminance' }, { in: ref }) : ref);
    const mixed = (base: Ref, changed: Ref, opacity: number, mask: Ref | null = null): Ref => (opacity >= 1 && !mask
        ? changed
        : b.add('blend', { mode: 'normal', opacity, useAlpha: false }, { foreground: changed, background: base, mask }));

    const sourceOf = (item: PaintLayer, channel: PaintChannel, source: FillSource, accs: ReadonlyMap<PaintChannel, Ref>): Ref | null => {
        if (source.kind === 'value') return constant(channel, source.value);
        if (source.kind === 'below') {
            const below = accs.get(source.channel);
            return below ? grey(below, CHANNEL_IS_COLOR[source.channel] && !CHANNEL_IS_COLOR[channel]) : null;
        }
        if (source.kind === 'current') return null;
        const projected = (pattern: Ref, projection: 'uv' | 'triplanar' | undefined, scale: number, rotation: number, sharpness: number): Ref => (projection === 'triplanar'
            ? b.add('triplanar', { scale, sharpness, rotation }, { pattern, position: position(), normal: worldNormal() })
            : scale === 1 && rotation === 0 ? pattern : b.add('transform', { scale: [1 / scale, 1 / scale], rotation, repeat: true }, { in: pattern }));
        if (source.kind === 'texture') return projected(b.add('bitmap', { texture: source.textureId }), source.projection, source.scale, source.rotation, source.sharpness);
        const entry = resolve(source.graphId);
        const made = entry ? b.inline(entry.graph, source.output, source.values, item.name) : null;
        return made ? projected(made, source.projection, source.scale ?? 1, source.rotation ?? 0, source.sharpness ?? 4) : null;
    };

    const maskOf = (item: PaintLayer, accs: ReadonlyMap<PaintChannel, Ref>): Ref | null => {
        let mask: Ref | null = null;
        const white = () => b.add('uniformValue', { value: 1 });
        for (const effect of item.mask ?? []) {
            if (!effect.enabled) continue;
            if (effect.kind === 'levels' || effect.kind === 'blur' || effect.kind === 'invert') {
                const base = mask ?? white();
                const changed = effect.kind === 'levels' ? b.add('levels', { inLow: effect.low ?? 0, inHigh: effect.high ?? 1, mid: effect.mid ?? 0.5 }, { in: base })
                    : effect.kind === 'blur' ? b.add('blur', { radius: effect.radius ?? 0.005 }, { in: base })
                        : b.add('invert', {}, { in: base });
                mask = mixed(base, changed, effect.opacity);
                continue;
            }
            let value: Ref | null = null;
            if (effect.kind === 'fill') value = b.add('uniformValue', { value: effect.value ?? 1 });
            else if (effect.kind === 'generator' && effect.graphId) {
                const entry = resolve(effect.graphId);
                value = entry ? b.inline(entry.graph, effect.output ?? 'custom', effect.values ?? {}, item.name) : null;
            } else if (effect.kind === 'below' && effect.channel && accs.get(effect.channel)) {
                const below = grey(accs.get(effect.channel)!, CHANNEL_IS_COLOR[effect.channel]);
                const read = effect.edges ? b.add('edgeDetect', { width: 0.003, tolerance: 0.02, softness: 0.5 }, { in: below }) : below;
                value = (effect.low ?? 0) === 0 && (effect.high ?? 1) === 1 ? read : b.add('levels', { inLow: effect.low ?? 0, inHigh: effect.high ?? 1 }, { in: read });
            }
            // Painted masks belong to a texture set, not to a graph.
            if (!value) continue;
            mask = effect.blend === 'replace' && effect.opacity >= 1
                ? value
                : b.add('blend', { mode: MASK_BLEND_MODES[effect.blend], opacity: effect.opacity, useAlpha: false }, { foreground: value, background: mask ?? white() });
        }
        return mask;
    };

    const laidOver = (channel: PaintChannel, below: Ref, above: Ref, mask: Ref | null, mode: ChannelBlend['mode'], opacity: number): Ref => (channel === 'normal'
        ? b.add('normalCombine', { mode: 'reoriented', strength: opacity }, { base: below, detail: above, mask })
        : b.add('blend', { mode: mode === 'normalCombine' ? 'normal' : mode, opacity, useAlpha: false }, { foreground: above, background: below, mask }));

    const compose = (layers: readonly PaintLayer[], accs: Map<PaintChannel, Ref>) => {
        for (const item of layers) {
            if (!item.visible) continue;
            const opacity = item.opacity ?? 1;
            if (opacity <= 0) continue;
            if (item.kind === 'folder') {
                const inside = new Map(accs);
                compose(item.layers ?? [], inside);
                const mask = maskOf(item, accs);
                for (const [channel, made] of inside) {
                    const below = accs.get(channel);
                    if (!below || made === below) continue;
                    accs.set(channel, channel === 'normal' ? mixed(below, made, opacity, mask) : b.add('blend', { mode: item.blend ?? 'normal', opacity, useAlpha: false }, { foreground: made, background: below, mask }));
                }
                continue;
            }
            const mask = maskOf(item, accs);
            for (const [channel, blend] of Object.entries(item.channels) as Array<[PaintChannel, ChannelBlend]>) {
                const below = accs.get(channel);
                if (!below || blend.opacity <= 0) continue;
                if (item.kind === 'filter' && item.filter) {
                    const filter = item.filter;
                    if (channel === 'normal' && filter.kind !== 'blur' && filter.kind !== 'sharpen' && filter.kind !== 'warp') continue;
                    const filtered = filter.kind === 'blur' ? b.add('blur', { radius: filter.radius }, { in: below })
                        : filter.kind === 'sharpen' ? b.add('sharpen', { amount: filter.amount }, { in: below })
                            : filter.kind === 'hsl' ? b.add('hsl', { hue: filter.hue, saturation: filter.saturation, lightness: filter.lightness }, { in: below })
                                : filter.kind === 'levels' ? b.add('levels', { inLow: filter.low, inHigh: filter.high, mid: filter.mid }, { in: below })
                                    : filter.kind === 'warp' ? b.add('warp', { intensity: filter.radius * 4 }, { in: below, gradient: b.add('perlinNoise', { scale: Math.max(1, Math.round(filter.amount)) }) })
                                        : b.add('invert', {}, { in: below });
                    accs.set(channel, mixed(below, filtered, blend.opacity * opacity, mask));
                    continue;
                }
                const source = item.fill?.[channel];
                const made = source ? sourceOf(item, channel, source, accs) : null;
                if (made) accs.set(channel, laidOver(channel, below, made, mask, blend.mode, blend.opacity * opacity));
            }
        }
    };

    const accs = new Map<PaintChannel, Ref>(channels.map((channel) => [channel, constant(channel, CHANNEL_DEFAULT[channel])]));
    compose([layer], accs);
    for (const channel of channels) b.add('output', { channel, name: '' }, { in: accs.get(channel) });
    return b.graph();
};

/** A copy of a smart mask's graph, its parameters starting at `values` (a mask effect's own). */
export const smartMaskGraph = (graph: TextureGraph, values: Record<string, unknown> = {}): TextureGraph => {
    const copy = structuredClone(graph);
    copy.parameters = copy.parameters.map((parameter) => (values[parameter.name] === undefined ? parameter : { ...parameter, default: values[parameter.name] as GraphParameter['default'] }));
    return normalizeTextureGraph(copy);
};
