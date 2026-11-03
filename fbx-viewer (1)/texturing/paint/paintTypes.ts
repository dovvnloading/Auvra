import type { BlendMode } from '../gpu/glslLibrary';
import type { MeshMapName } from '../graph/nodes/io';
import type { BakeSettings } from '../bake/meshBaker';
import type { ChannelTextureIds } from '../materialOutput';

/**
 * PAINTED TEXTURE SETS: THE DOCUMENT
 *
 * A texture set is one surface of a model (the materials sharing its pictures) painted in layers.
 * Layers are listed bottom first. Each layer touches some channels, each with its own blend mode and
 * opacity, and can carry a mask: a stack of effects (painted, filled, generated from the mesh maps,
 * levelled, blurred, inverted) worked out top to bottom. Pictures (painted pixels, painted masks, baked
 * mesh maps) are kept as assets of their own and named here by `assetId`, one per UDIM tile.
 */

export const PAINT_CHANNELS = ['baseColor', 'roughness', 'metallic', 'height', 'normal', 'emissive', 'opacity'] as const;
export type PaintChannel = typeof PAINT_CHANNELS[number];

export const CHANNEL_LABELS: Record<PaintChannel, string> = {
    baseColor: 'Base colour', roughness: 'Roughness', metallic: 'Metallic', height: 'Height', normal: 'Normal', emissive: 'Emissive', opacity: 'Opacity',
};

/** Colour channels hold three values; the rest one (in red). */
export const CHANNEL_IS_COLOR: Record<PaintChannel, boolean> = {
    baseColor: true, roughness: false, metallic: false, height: false, normal: true, emissive: true, opacity: false,
};

/** What a channel holds where nothing is painted. */
export const CHANNEL_DEFAULT: Record<PaintChannel, [number, number, number]> = {
    baseColor: [0.5, 0.5, 0.5], roughness: [0.6, 0.6, 0.6], metallic: [0, 0, 0], height: [0.5, 0.5, 0.5], normal: [0.5, 0.5, 1], emissive: [0, 0, 0], opacity: [1, 1, 1],
};

/** Pictures by UDIM tile ('1001'...), each an asset. */
export type TilePictures = Record<string, { assetId: string }>;

export interface ChannelBlend {
    mode: BlendMode | 'normalCombine';
    opacity: number;
}

export type FillSource =
    | { kind: 'value'; value: [number, number, number] }
    | { kind: 'texture'; textureId: string; projection: 'uv' | 'triplanar'; scale: number; rotation: number; sharpness: number }
    /** One output of a texture graph material, drawn with this surface's mesh maps. */
    | { kind: 'graph'; graphId: string; output: string; values: Record<string, unknown> }
    /** What the surface wore before painting began (its own picture for the channel). */
    | { kind: 'current' };

export type MaskEffectKind = 'paint' | 'fill' | 'generator' | 'levels' | 'blur' | 'invert';
export type MaskBlend = 'multiply' | 'add' | 'subtract' | 'replace' | 'max' | 'min';

export interface MaskEffect {
    id: string;
    kind: MaskEffectKind;
    enabled: boolean;
    blend: MaskBlend;
    opacity: number;
    /** Paint: the painted mask. */
    pictures?: TilePictures;
    /** Fill: a value; levels: low, high, mid; blur: radius (share of the picture). */
    value?: number;
    low?: number;
    high?: number;
    mid?: number;
    radius?: number;
    /** Generator: a texture graph and the output (grey) it gives, with its parameter values. */
    graphId?: string;
    output?: string;
    values?: Record<string, unknown>;
}

export type LayerKind = 'paint' | 'fill' | 'folder';

export interface PaintLayer {
    id: string;
    name: string;
    kind: LayerKind;
    visible: boolean;
    /** The channels it changes and how. */
    channels: Partial<Record<PaintChannel, ChannelBlend>>;
    /** Fill layers: where each channel's value comes from. */
    fill?: Partial<Record<PaintChannel, FillSource>>;
    /** Paint layers: the painted pixels of each channel (value in RGB, coverage in alpha). */
    pictures?: Partial<Record<PaintChannel, TilePictures>>;
    /** Folders: their layers, bottom first. */
    layers?: PaintLayer[];
    /** Folders: how strongly the whole folder shows. */
    opacity?: number;
    mask?: MaskEffect[];
    /** Set on layers made from a smart material, for the list to say so. */
    from?: string;
}

export interface PaintDocument {
    version: 1;
    modelId: string;
    /** Names of the model's materials this set paints. */
    materialNames: string[];
    /** Size of each tile's pictures, a power of two. */
    size: number;
    /** Whether texture coordinates past 0..1 are UDIM tiles of their own (else they wrap onto one picture). */
    udim: boolean;
    channels: PaintChannel[];
    /** Bottom first. */
    layers: PaintLayer[];
    /** How far the height channel pushes the normal. */
    heightStrength: number;
    bake: { settings: BakeSettings; maps: Partial<Record<MeshMapName, TilePictures>>; at: number } | null;
    /** The pictures the model last got from this set. */
    applied?: { textures: ChannelTextureIds; at: number };
}

export const BLEND_FOR: Record<PaintChannel, ChannelBlend['mode']> = {
    baseColor: 'normal', roughness: 'normal', metallic: 'normal', height: 'normal', normal: 'normalCombine', emissive: 'normal', opacity: 'normal',
};

let counter = 0;
export const paintId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const channelsOf = (document: PaintDocument, enabled: readonly PaintChannel[] = document.channels): Partial<Record<PaintChannel, ChannelBlend>> =>
    Object.fromEntries(enabled.map((channel) => [channel, { mode: BLEND_FOR[channel], opacity: 1 }]));

export const newPaintLayer = (document: PaintDocument, name = 'Paint'): PaintLayer => ({
    id: paintId('l'), name, kind: 'paint', visible: true, channels: channelsOf(document), pictures: {},
});

export const newFillLayer = (document: PaintDocument, name = 'Fill', fill: Partial<Record<PaintChannel, FillSource>> = {}): PaintLayer => {
    const channels = Object.keys(fill).length ? (Object.keys(fill) as PaintChannel[]) : (['baseColor', 'roughness', 'metallic'] as PaintChannel[]).filter((channel) => document.channels.includes(channel));
    const sources: Partial<Record<PaintChannel, FillSource>> = {};
    for (const channel of channels) sources[channel] = fill[channel] ?? { kind: 'value', value: [...CHANNEL_DEFAULT[channel]] as [number, number, number] };
    return { id: paintId('l'), name, kind: 'fill', visible: true, channels: channelsOf(document, channels), fill: sources };
};

export const newFolder = (name = 'Folder', layers: PaintLayer[] = []): PaintLayer => ({ id: paintId('l'), name, kind: 'folder', visible: true, channels: {}, layers, opacity: 1 });

/** Every layer, folders' layers included, bottom first. */
export const allLayers = (layers: readonly PaintLayer[]): PaintLayer[] => layers.flatMap((layer) => [layer, ...allLayers(layer.layers ?? [])]);

/** The layer list with `id` changed by `change` (or removed when it returns null). */
export const mapLayer = (layers: readonly PaintLayer[], id: string, change: (layer: PaintLayer) => PaintLayer | null): PaintLayer[] => {
    const result: PaintLayer[] = [];
    for (const layer of layers) {
        if (layer.id === id) {
            const changed = change(layer);
            if (changed) result.push(changed);
            continue;
        }
        result.push(layer.layers ? { ...layer, layers: mapLayer(layer.layers, id, change) } : layer);
    }
    return result;
};

/** Where a layer sits: its list's owner (null for the top level) and its index there. */
export const locateLayer = (layers: readonly PaintLayer[], id: string, parent: PaintLayer | null = null): { parent: PaintLayer | null; index: number } | null => {
    for (let index = 0; index < layers.length; index++) {
        if (layers[index].id === id) return { parent, index };
        const inner = layers[index].layers ? locateLayer(layers[index].layers!, id, layers[index]) : null;
        if (inner) return inner;
    }
    return null;
};

/** Inserts `layer` above `above` (in whichever list holds it), or at the top when none is given or found. */
export const insertLayer = (layers: readonly PaintLayer[], layer: PaintLayer, above: string | null): PaintLayer[] => {
    const into = (list: readonly PaintLayer[]): PaintLayer[] | null => {
        const out: PaintLayer[] = [];
        let placed = false;
        for (const candidate of list) {
            if (!placed && candidate.layers) {
                const inner = into(candidate.layers);
                if (inner) {
                    out.push({ ...candidate, layers: inner });
                    placed = true;
                    continue;
                }
            }
            out.push(candidate);
            if (!placed && candidate.id === above) {
                out.push(layer);
                placed = true;
            }
        }
        return placed ? out : null;
    };
    return (above ? into(layers) : null) ?? [...layers, layer];
};

/** Moves `id` to sit just above `target` (or into folder `target` when `into`). */
export const moveLayer = (layers: readonly PaintLayer[], id: string, target: string, into = false): PaintLayer[] => {
    if (id === target) return [...layers];
    const moving = allLayers(layers).find((layer) => layer.id === id);
    if (!moving) return [...layers];
    // A folder cannot go inside itself.
    if (allLayers(moving.layers ?? []).some((layer) => layer.id === target)) return [...layers];
    const without = mapLayer(layers, id, () => null);
    if (into) return mapLayer(without, target, (folder) => ({ ...folder, layers: [...(folder.layers ?? []), moving] }));
    return insertLayer(without, moving, target);
};

export const createPaintDocument = (modelId: string, materialNames: string[], size = 11): PaintDocument => ({
    version: 1,
    modelId,
    materialNames,
    size,
    udim: false,
    channels: ['baseColor', 'roughness', 'metallic', 'height', 'normal'],
    layers: [],
    heightStrength: 1,
    bake: null,
});

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** A stored document made safe to use. */
export const readPaintDocument = (value: unknown): PaintDocument | null => {
    const raw = value as Partial<PaintDocument> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.modelId !== 'string' || !Array.isArray(raw.layers)) return null;
    const channels = Array.isArray(raw.channels) ? raw.channels.filter((channel): channel is PaintChannel => (PAINT_CHANNELS as readonly string[]).includes(channel)) : [];
    const readLayers = (list: unknown[], depth: number): PaintLayer[] => list.slice(0, 256).flatMap((item) => {
        const layer = item as Partial<PaintLayer> | null;
        if (!layer || typeof layer.id !== 'string' || !['paint', 'fill', 'folder'].includes(String(layer.kind))) return [];
        const result: PaintLayer = {
            id: layer.id,
            name: typeof layer.name === 'string' ? layer.name.slice(0, 80) : 'Layer',
            kind: layer.kind as LayerKind,
            visible: layer.visible !== false,
            channels: {},
        };
        for (const [channel, blend] of Object.entries(layer.channels ?? {})) {
            if (!(PAINT_CHANNELS as readonly string[]).includes(channel) || !blend) continue;
            result.channels[channel as PaintChannel] = { mode: (blend as ChannelBlend).mode ?? 'normal', opacity: Math.min(1, Math.max(0, finite((blend as ChannelBlend).opacity, 1))) };
        }
        if (layer.fill) result.fill = layer.fill;
        if (layer.pictures) result.pictures = layer.pictures;
        if (layer.mask && Array.isArray(layer.mask)) result.mask = layer.mask.filter((effect) => effect && typeof effect.id === 'string');
        if (layer.from) result.from = String(layer.from).slice(0, 80);
        if (layer.kind === 'folder') {
            result.layers = depth < 6 && Array.isArray(layer.layers) ? readLayers(layer.layers, depth + 1) : [];
            result.opacity = Math.min(1, Math.max(0, finite(layer.opacity, 1)));
        }
        return [result];
    });
    return {
        version: 1,
        modelId: raw.modelId,
        materialNames: Array.isArray(raw.materialNames) ? raw.materialNames.filter((name): name is string => typeof name === 'string') : [],
        size: Math.min(12, Math.max(8, Math.round(finite(raw.size, 11)))),
        udim: raw.udim === true,
        channels: channels.length ? channels : ['baseColor', 'roughness', 'metallic', 'height', 'normal'],
        layers: readLayers(raw.layers, 0),
        heightStrength: finite(raw.heightStrength, 1),
        bake: raw.bake && typeof raw.bake === 'object' ? raw.bake as PaintDocument['bake'] : null,
        ...(raw.applied ? { applied: raw.applied } : {}),
    };
};
