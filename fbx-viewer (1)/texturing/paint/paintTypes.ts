import { BLEND_MODES, type BlendMode } from '../gpu/glslLibrary';
import type { MeshMapName } from '../graph/nodes/io';
import type { BakeSettings, PositionSpace } from '../bake/meshBaker';
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

/**
 * How a tiling picture is laid on: along the surface's UVs, or from three sides (cast along each axis
 * and blended by how the surface faces, so it runs on across UV seams). Scale is repeats across the
 * model's longest side when cast from three sides, repeats per UV square along the UVs.
 */
export interface FillProjection { projection: 'uv' | 'triplanar'; scale: number; rotation: number; sharpness: number }

export type FillSource =
    | { kind: 'value'; value: [number, number, number] }
    | ({ kind: 'texture'; textureId: string } & FillProjection)
    /**
     * One output of a texture graph material, drawn with this surface's mesh maps. Laid on along the
     * UVs unless a projection says otherwise.
     */
    | ({ kind: 'graph'; graphId: string; output: string; values: Record<string, unknown> } & Partial<FillProjection>)
    /** What the surface wore before painting began (its own picture for the channel). */
    | { kind: 'current' }
    /** What the layers below this one make of a channel (its brightness, when a colour fills a grey channel). */
    | { kind: 'below'; channel: PaintChannel };

export type MaskEffectKind = 'paint' | 'fill' | 'generator' | 'levels' | 'blur' | 'invert' | 'below';
export type MaskBlend = 'multiply' | 'add' | 'subtract' | 'replace' | 'max' | 'min';

export interface MaskEffect {
    id: string;
    kind: MaskEffectKind;
    enabled: boolean;
    blend: MaskBlend;
    opacity: number;
    /** Paint: the painted mask. */
    pictures?: TilePictures;
    /** Fill: a value; levels and below: low, high (and levels mid); blur: radius (share of the picture). */
    value?: number;
    low?: number;
    high?: number;
    mid?: number;
    radius?: number;
    /** Generator: a texture graph and the output (grey) it gives, with its parameter values. */
    graphId?: string;
    output?: string;
    values?: Record<string, unknown>;
    /** Below: the channel of the layers below read (its brightness), or where it changes fastest (`edges`). */
    channel?: PaintChannel;
    edges?: boolean;
}

export type LayerKind = 'paint' | 'fill' | 'folder' | 'filter';

/** What a filter layer does to the layers below it, in each channel it is on. */
export type FilterKind = 'blur' | 'sharpen' | 'hsl' | 'levels' | 'warp' | 'invert';

export const FILTER_LABELS: Record<FilterKind, string> = {
    blur: 'Blur', sharpen: 'Sharpen', hsl: 'Hue, saturation and lightness', levels: 'Levels', warp: 'Warp', invert: 'Invert',
};

export interface FilterSettings {
    kind: FilterKind;
    /** Blur and sharpen: how far it reaches, as a share of the picture. Warp: how far it pushes. */
    radius: number;
    /** Sharpen: how strongly. Warp: how fine its swirls are (repeats across the picture). */
    amount: number;
    /** Hue turn (-0.5..0.5 of the wheel), saturation and lightness changes (-1..1). */
    hue: number;
    saturation: number;
    lightness: number;
    /** Levels: in black, in white, midtones. */
    low: number;
    high: number;
    mid: number;
}

export const DEFAULT_FILTER: Record<FilterKind, FilterSettings> = {
    blur: { kind: 'blur', radius: 0.004, amount: 1, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
    sharpen: { kind: 'sharpen', radius: 0.002, amount: 1, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
    hsl: { kind: 'hsl', radius: 0, amount: 1, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
    levels: { kind: 'levels', radius: 0, amount: 1, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
    warp: { kind: 'warp', radius: 0.004, amount: 8, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
    invert: { kind: 'invert', radius: 0, amount: 1, hue: 0, saturation: 0, lightness: 0, low: 0, high: 1, mid: 0.5 },
};

export interface PaintLayer {
    id: string;
    name: string;
    kind: LayerKind;
    visible: boolean;
    /** The channels it changes and how (a filter layer: the channels it acts on, and how strongly). */
    channels: Partial<Record<PaintChannel, ChannelBlend>>;
    /** Fill layers: where each channel's value comes from. */
    fill?: Partial<Record<PaintChannel, FillSource>>;
    /** Paint layers: the painted pixels of each channel (value in RGB, coverage in alpha). */
    pictures?: Partial<Record<PaintChannel, TilePictures>>;
    /** Folders: their layers, bottom first. */
    layers?: PaintLayer[];
    /** How strongly the whole layer (or folder) shows, on top of each channel's own opacity. */
    opacity?: number;
    /** Folders: how what the folder makes is laid over what is below it (each channel but normal). */
    blend?: BlendMode;
    /** Filter layers: what they do. */
    filter?: FilterSettings;
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
    /**
     * Where 3D placement is measured from: a cube round the whole model, shared by its texture sets, which
     * the position map and fills cast from three sides both use. Sets made before it was kept use their
     * own box (and fills cast from three sides keep their old placement).
     */
    space?: PositionSpace;
    /** The baked maps; `version` (BAKE_VERSION) and `space` are missing on bakes made before they were kept. */
    bake: { settings: BakeSettings; maps: Partial<Record<MeshMapName, TilePictures>>; at: number; version?: number; space?: PositionSpace } | null;
    /** The pictures the model last got from this set. */
    applied?: { textures: ChannelTextureIds; at: number };
    /**
     * What the surface wore before painting began, carried onto the set's own layout (a picture per tile)
     * once it was laid out afresh. "What it wore before" fills read these over the model's own pictures,
     * which only fit the layout it came with.
     */
    before?: Partial<Record<PaintChannel, TilePictures>>;
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

/** Channels a filter of this kind works on: every one but the normal, which only blurs, sharpens and warps. */
export const filterChannels = (kind: FilterKind, channels: readonly PaintChannel[]): PaintChannel[] =>
    channels.filter((channel) => channel !== 'normal' || kind === 'blur' || kind === 'sharpen' || kind === 'warp');

/** A filter layer acting on the colour, roughness and metallic of the layers below (the channels the set has). */
export const newFilterLayer = (document: PaintDocument, kind: FilterKind): PaintLayer => {
    const channels = filterChannels(kind, (['baseColor', 'roughness', 'metallic', 'height'] as PaintChannel[]).filter((channel) => document.channels.includes(channel)));
    return {
        id: paintId('l'),
        name: FILTER_LABELS[kind],
        kind: 'filter',
        visible: true,
        channels: Object.fromEntries(channels.map((channel) => [channel, { mode: 'normal' as const, opacity: 1 }])),
        filter: { ...DEFAULT_FILTER[kind] },
        opacity: 1,
    };
};

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

/** A stored space, or undefined when it is not one. */
export const readSpace = (value: unknown): PositionSpace | undefined => {
    const raw = value as Partial<PositionSpace> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.centre) || raw.centre.length !== 3) return undefined;
    const centre = raw.centre.map((part) => finite(part, NaN));
    const extent = finite(raw.extent, NaN);
    if (centre.some((part) => !Number.isFinite(part)) || !(extent > 0)) return undefined;
    return { centre: centre as [number, number, number], extent };
};

/** Whether any fill of the layers is cast from three sides (its placement follows the set's space). */
export const castsFromThreeSides = (layers: readonly PaintLayer[]): boolean =>
    allLayers(layers).some((layer) => Object.values(layer.fill ?? {}).some((source) => (source?.kind === 'texture' || source?.kind === 'graph') && source.projection === 'triplanar'));

const unit = (value: unknown, fallback: number): number => Math.min(1, Math.max(0, finite(value, fallback)));

/** A stored filter made safe to use (its kind's defaults for anything missing). */
const readFilter = (value: unknown): FilterSettings => {
    const raw = (value ?? {}) as Partial<FilterSettings>;
    const kind = (Object.keys(FILTER_LABELS) as FilterKind[]).includes(raw.kind as FilterKind) ? raw.kind as FilterKind : 'blur';
    const base = DEFAULT_FILTER[kind];
    return {
        kind,
        radius: Math.min(0.1, Math.max(0, finite(raw.radius, base.radius))),
        amount: Math.min(64, Math.max(0, finite(raw.amount, base.amount))),
        hue: Math.min(0.5, Math.max(-0.5, finite(raw.hue, base.hue))),
        saturation: Math.min(1, Math.max(-1, finite(raw.saturation, base.saturation))),
        lightness: Math.min(1, Math.max(-1, finite(raw.lightness, base.lightness))),
        low: unit(raw.low, base.low),
        high: unit(raw.high, base.high),
        mid: Math.min(0.99, Math.max(0.01, finite(raw.mid, base.mid))),
    };
};

/** Stored layers made safe to use (unknown kinds left out, at most 256 a list and 6 folders deep). */
export const readPaintLayers = (list: unknown[], depth = 0): PaintLayer[] => list.slice(0, 256).flatMap((item) => {
    const layer = item as Partial<PaintLayer> | null;
    if (!layer || typeof layer.id !== 'string' || !['paint', 'fill', 'folder', 'filter'].includes(String(layer.kind))) return [];
    const result: PaintLayer = {
        id: layer.id,
        name: typeof layer.name === 'string' ? layer.name.slice(0, 80) : 'Layer',
        kind: layer.kind as LayerKind,
        visible: layer.visible !== false,
        channels: {},
    };
    for (const [channel, blend] of Object.entries(layer.channels ?? {})) {
        if (!(PAINT_CHANNELS as readonly string[]).includes(channel) || !blend) continue;
        result.channels[channel as PaintChannel] = { mode: (blend as ChannelBlend).mode ?? 'normal', opacity: unit((blend as ChannelBlend).opacity, 1) };
    }
    if (layer.fill) result.fill = layer.fill;
    if (layer.pictures) result.pictures = layer.pictures;
    if (layer.mask && Array.isArray(layer.mask)) result.mask = layer.mask.filter((effect) => effect && typeof effect.id === 'string');
    if (layer.from) result.from = String(layer.from).slice(0, 80);
    // Layers saved before they had an opacity of their own show fully.
    if (layer.opacity !== undefined || layer.kind === 'folder') result.opacity = unit(layer.opacity, 1);
    if (layer.kind === 'folder') {
        result.layers = depth < 6 && Array.isArray(layer.layers) ? readPaintLayers(layer.layers, depth + 1) : [];
        if (layer.blend && layer.blend !== 'normal' && (BLEND_MODES as readonly string[]).includes(layer.blend)) result.blend = layer.blend;
    }
    if (layer.kind === 'filter') result.filter = readFilter(layer.filter);
    return [result];
});

/** A stored document made safe to use. */
export const readPaintDocument = (value: unknown): PaintDocument | null => {
    const raw = value as Partial<PaintDocument> | null;
    if (!raw || typeof raw !== 'object' || typeof raw.modelId !== 'string' || !Array.isArray(raw.layers)) return null;
    const channels = Array.isArray(raw.channels) ? raw.channels.filter((channel): channel is PaintChannel => (PAINT_CHANNELS as readonly string[]).includes(channel)) : [];
    const readLayers = (list: unknown[], depth: number): PaintLayer[] => readPaintLayers(list, depth);
    const space = readSpace(raw.space);
    return {
        version: 1,
        modelId: raw.modelId,
        materialNames: Array.isArray(raw.materialNames) ? raw.materialNames.filter((name): name is string => typeof name === 'string') : [],
        size: Math.min(12, Math.max(8, Math.round(finite(raw.size, 11)))),
        udim: raw.udim === true,
        channels: channels.length ? channels : ['baseColor', 'roughness', 'metallic', 'height', 'normal'],
        layers: readLayers(raw.layers, 0),
        heightStrength: finite(raw.heightStrength, 1),
        ...(space ? { space } : {}),
        bake: raw.bake && typeof raw.bake === 'object' ? raw.bake as PaintDocument['bake'] : null,
        ...(raw.applied ? { applied: raw.applied } : {}),
        ...(raw.before && typeof raw.before === 'object' ? { before: raw.before } : {}),
    };
};
