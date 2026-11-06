import { BUILTIN_PREFIX } from './smartLibrary';
import { CHANNEL_IS_COLOR, insertLayer, newFillLayer, paintId, type FillSource, type MaskEffect, type PaintChannel, type PaintDocument, type PaintLayer } from './paintTypes';

/**
 * PAINTING WITH WHOLE MATERIALS
 *
 * A material is laid on with the brush as a fill layer (every channel of it the set has) under a black
 * painted mask: painting the mask white shows the material through the stroke, in all its channels at
 * once. The materials offered: plain sets of values (below), the brush's own values, a picture, a texture
 * graph, or a smart material.
 */

export interface MaterialPreset {
    id: string;
    name: string;
    group: 'Metals' | 'Other surfaces';
    /** sRGB, within measured ranges: metals 0.7-1, everything else 0.12-0.94. */
    baseColor: [number, number, number];
    /** One roughness, or a range it wanders over across the surface. */
    roughness: number | [number, number];
    metallic: number;
    /** A little raised (above 0.5) or sunk, where it is laid. */
    height?: number;
}

export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
    { id: 'steel', name: 'Steel', group: 'Metals', baseColor: [0.77, 0.78, 0.78], roughness: [0.25, 0.4], metallic: 1 },
    { id: 'aluminium', name: 'Aluminium', group: 'Metals', baseColor: [0.91, 0.92, 0.92], roughness: [0.3, 0.45], metallic: 1 },
    { id: 'gold', name: 'Gold', group: 'Metals', baseColor: [1, 0.85, 0.57], roughness: [0.18, 0.32], metallic: 1 },
    { id: 'copper', name: 'Copper', group: 'Metals', baseColor: [0.98, 0.82, 0.76], roughness: [0.22, 0.42], metallic: 1 },
    { id: 'brass', name: 'Brass', group: 'Metals', baseColor: [0.89, 0.79, 0.45], roughness: [0.25, 0.45], metallic: 1 },
    { id: 'rubber', name: 'Black rubber', group: 'Other surfaces', baseColor: [0.14, 0.14, 0.14], roughness: 0.9, metallic: 0 },
    { id: 'plastic', name: 'Matte plastic', group: 'Other surfaces', baseColor: [0.5, 0.5, 0.5], roughness: [0.55, 0.7], metallic: 0 },
    { id: 'redPaint', name: 'Glossy red paint', group: 'Other surfaces', baseColor: [0.6, 0.12, 0.12], roughness: [0.18, 0.3], metallic: 0 },
    { id: 'wood', name: 'Plain wood', group: 'Other surfaces', baseColor: [0.55, 0.4, 0.26], roughness: [0.55, 0.72], metallic: 0 },
    { id: 'concrete', name: 'Concrete', group: 'Other surfaces', baseColor: [0.52, 0.51, 0.49], roughness: 0.9, metallic: 0 },
    { id: 'mud', name: 'Dried mud', group: 'Other surfaces', baseColor: [0.36, 0.29, 0.22], roughness: 0.95, metallic: 0, height: 0.55 },
    { id: 'rust', name: 'Rust', group: 'Other surfaces', baseColor: [0.45, 0.23, 0.12], roughness: 0.9, metallic: 0, height: 0.56 },
];

const gray = (v: number): [number, number, number] => [v, v, v];

/** Only the sources for channels the set has. */
const fillsFor = (document: PaintDocument, fills: Partial<Record<PaintChannel, FillSource>>): Partial<Record<PaintChannel, FillSource>> =>
    Object.fromEntries(Object.entries(fills).filter(([channel]) => document.channels.includes(channel as PaintChannel)));

/** A fill layer covering the surface with a preset material. */
export const presetLayer = (document: PaintDocument, preset: MaterialPreset): PaintLayer => {
    const roughness: FillSource = typeof preset.roughness === 'number'
        ? { kind: 'value', value: gray(preset.roughness) }
        : { kind: 'graph', graphId: `${BUILTIN_PREFIX}surfaceBreakup`, output: 'roughness', values: { low: preset.roughness[0], high: preset.roughness[1] } };
    return {
        ...newFillLayer(document, preset.name, fillsFor(document, {
            baseColor: { kind: 'value', value: [...preset.baseColor] as [number, number, number] },
            roughness,
            metallic: { kind: 'value', value: gray(preset.metallic) },
            ...(preset.height !== undefined ? { height: { kind: 'value', value: gray(preset.height) } as FillSource } : {}),
        })),
        from: preset.name,
    };
};

/** A fill layer of the brush's own values, in the channels it paints (a flat normal, for the normal). */
export const brushMaterialLayer = (document: PaintDocument, brush: { channels: readonly PaintChannel[]; values: Record<PaintChannel, [number, number, number]> }): PaintLayer => {
    const fills: Partial<Record<PaintChannel, FillSource>> = {};
    for (const channel of brush.channels) {
        const value = channel === 'normal' ? [0.5, 0.5, 1] as [number, number, number] : brush.values[channel];
        fills[channel] = { kind: 'value', value: CHANNEL_IS_COLOR[channel] ? [...value] as [number, number, number] : gray(value[0]) };
    }
    return newFillLayer(document, 'Brush colours', fillsFor(document, fills));
};

/** A fill layer of a picture's colours, cast from three sides so it runs on across UV seams. */
export const pictureMaterialLayer = (document: PaintDocument, textureId: string, name: string): PaintLayer => ({
    ...newFillLayer(document, name, fillsFor(document, { baseColor: { kind: 'texture', textureId, projection: 'triplanar', scale: 4, rotation: 0, sharpness: 4 } })),
    from: name,
});

/**
 * The layer under a black painted mask, last in its mask so it limits whatever the mask already shows:
 * nothing shows until it is painted.
 */
export const withPaintedMask = (layer: PaintLayer): { layer: PaintLayer; effectId: string } => {
    const effect: MaskEffect = { id: paintId('m'), kind: 'paint', enabled: true, blend: 'multiply', opacity: 1, value: 0 };
    return { layer: { ...layer, mask: [...(layer.mask ?? []), effect] }, effectId: effect.id };
};

/**
 * The document with `layer` added above `above` (or on top) under a black painted mask, ready to be
 * painted in. The mask's picture must be started (PaintStack.startMaskPicture, black) before the
 * document is used.
 */
export const paintWithMaterial = (document: PaintDocument, layer: PaintLayer, above: string | null): { document: PaintDocument; layerId: string; effectId: string } => {
    const masked = withPaintedMask(layer);
    return { document: { ...document, layers: insertLayer(document.layers, masked.layer, above) }, layerId: layer.id, effectId: masked.effectId };
};
