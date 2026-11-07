import type { PictureFormat } from './pictureFiles';

/**
 * EXPORT TEMPLATES
 *
 * How a painted set's pictures are written out for a target: each picture's file name (with tokens),
 * what goes in each of its channels (a component of one of the set's maps, or a fixed value), the file
 * kind and bit depth, the normal map's convention, whether the padding past the islands is kept, and
 * the sizes written. Starting templates cover the usual targets; templates made in the project are kept
 * there to be shared.
 *
 * Tokens in names: $set (the texture set), $model, $tile (the UDIM tile, as 1001), $size (pixels across).
 */

/** The set's maps a template's pictures are made from. */
export type ExportSource = 'baseColor' | 'normal' | 'roughness' | 'metallic' | 'height' | 'emissive' | 'opacity' | 'ambientOcclusion';

export const EXPORT_SOURCE_LABELS: Record<ExportSource, string> = {
    baseColor: 'Base colour', normal: 'Normal', roughness: 'Roughness', metallic: 'Metallic', height: 'Height', emissive: 'Emissive', opacity: 'Opacity', ambientOcclusion: 'Ambient occlusion',
};

/** One channel of a picture: a component (0 red ... 3 alpha) of a map, or a value. */
export type ChannelSource = { from: ExportSource; component: 0 | 1 | 2 | 3 } | { value: number };

export interface ExportPicture {
    /** The file name without its extension, with tokens. */
    name: string;
    /** One channel (grey), three (colour) or four (colour and alpha). */
    channels: ChannelSource[];
}

export interface ExportTemplate {
    id: string;
    name: string;
    pictures: ExportPicture[];
    format: PictureFormat;
    normal: 'openGl' | 'directX';
    /** Keep the padding past the islands (else it is black). */
    padding: boolean;
    /** Sizes written (powers of two); none: the set's own. */
    sizes: number[];
    builtIn?: boolean;
}

const map = (from: ExportSource, component: 0 | 1 | 2 | 3 = 0): ChannelSource => ({ from, component });
const rgb = (from: ExportSource): ChannelSource[] => [map(from, 0), map(from, 1), map(from, 2)];

export const BUILT_IN_TEMPLATES: readonly ExportTemplate[] = [
    {
        id: 'builtin:gltf', name: 'glTF (web)', builtIn: true, format: 'png8', normal: 'openGl', padding: true, sizes: [],
        pictures: [
            { name: '$set_baseColor', channels: [...rgb('baseColor'), map('opacity')] },
            // glTF reads occlusion from red, roughness from green and metallic from blue.
            { name: '$set_occlusionRoughnessMetallic', channels: [map('ambientOcclusion'), map('roughness'), map('metallic')] },
            { name: '$set_normal', channels: rgb('normal') },
            { name: '$set_emissive', channels: rgb('emissive') },
        ],
    },
    {
        id: 'builtin:orm', name: 'Packed ORM', builtIn: true, format: 'png8', normal: 'directX', padding: true, sizes: [],
        pictures: [
            { name: '$set_BaseColor', channels: rgb('baseColor') },
            { name: '$set_ORM', channels: [map('ambientOcclusion'), map('roughness'), map('metallic')] },
            { name: '$set_Normal', channels: rgb('normal') },
            { name: '$set_Height', channels: [map('height')] },
        ],
    },
    {
        id: 'builtin:channels', name: 'One picture per channel', builtIn: true, format: 'png16', normal: 'openGl', padding: true, sizes: [],
        pictures: [
            { name: '$set_BaseColor', channels: rgb('baseColor') },
            { name: '$set_Normal', channels: rgb('normal') },
            { name: '$set_Roughness', channels: [map('roughness')] },
            { name: '$set_Metallic', channels: [map('metallic')] },
            { name: '$set_Height', channels: [map('height')] },
            { name: '$set_AmbientOcclusion', channels: [map('ambientOcclusion')] },
            { name: '$set_Emissive', channels: rgb('emissive') },
            { name: '$set_Opacity', channels: [map('opacity')] },
        ],
    },
];

/** A file name with its tokens filled in, kept to letters, digits, dashes, dots and underscores. */
export const fileName = (pattern: string, tokens: { set: string; model: string; tile: number; size: number }): string => pattern
    .replace(/\$set/g, tokens.set)
    .replace(/\$model/g, tokens.model)
    .replace(/\$tile/g, String(tokens.tile))
    .replace(/\$size/g, String(tokens.size))
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'picture';

/**
 * How a picture is put together on the GPU: the maps it reads (at most four, each once), and for each of
 * its channels which of them (and which component) or which value.
 */
export const planPicture = (picture: ExportPicture): { sources: ExportSource[]; channels: Array<{ slot: number; component: number } | { value: number }> } => {
    const sources: ExportSource[] = [];
    const channels = picture.channels.slice(0, 4).map((channel) => {
        if ('value' in channel) return { value: Math.min(1, Math.max(0, channel.value)) };
        let slot = sources.indexOf(channel.from);
        if (slot < 0 && sources.length < 4) { sources.push(channel.from); slot = sources.length - 1; }
        return slot < 0 ? { value: 0 } : { slot, component: channel.component };
    });
    return { sources, channels };
};

/** Whether a picture holds the normal map's green (flipped for DirectX). */
export const holdsNormalGreen = (channel: ChannelSource): boolean => !('value' in channel) && channel.from === 'normal' && channel.component === 1;

const SOURCES = Object.keys(EXPORT_SOURCE_LABELS) as ExportSource[];
const FORMATS: readonly PictureFormat[] = ['png8', 'png16', 'tga', 'tiff8', 'tiff16', 'tiff32', 'exr16', 'exr32'];

/** Templates read back from the project, made safe (pictures with unknown maps or no channels left out). */
export const readTemplates = (value: unknown): ExportTemplate[] => {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap((item): ExportTemplate[] => {
        const raw = item as Partial<ExportTemplate> | null;
        if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.pictures)) return [];
        const pictures = raw.pictures.slice(0, 32).flatMap((picture): ExportPicture[] => {
            if (!picture || typeof picture.name !== 'string' || !Array.isArray(picture.channels)) return [];
            const channels = picture.channels.slice(0, 4).flatMap((channel): ChannelSource[] => {
                if (channel && typeof (channel as { value?: unknown }).value === 'number') return [{ value: Math.min(1, Math.max(0, (channel as { value: number }).value)) }];
                const source = channel as { from?: unknown; component?: unknown };
                return SOURCES.includes(source?.from as ExportSource) && [0, 1, 2, 3].includes(source.component as number) ? [{ from: source.from as ExportSource, component: source.component as 0 | 1 | 2 | 3 }] : [];
            });
            // A picture with a channel that does not read is left out whole, not shifted.
            const whole = channels.length === Math.min(4, picture.channels.length);
            return whole && (channels.length === 1 || channels.length === 3 || channels.length === 4) ? [{ name: picture.name.slice(0, 120), channels }] : [];
        });
        if (!pictures.length) return [];
        return [{
            id: raw.id.slice(0, 64),
            name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : 'Template',
            pictures,
            format: FORMATS.includes(raw.format as PictureFormat) ? raw.format as PictureFormat : 'png8',
            normal: raw.normal === 'directX' ? 'directX' : 'openGl',
            padding: raw.padding !== false,
            sizes: Array.isArray(raw.sizes) ? raw.sizes.filter((size) => Number.isInteger(size) && size >= 7 && size <= 13).slice(0, 6) : [],
        }];
    });
};

/** Whether a material asset is where the project keeps its export templates (never a material). */
export const isExportTemplatesAsset = (asset: { paint?: Record<string, unknown> }): boolean => Array.isArray(asset.paint?.exportTemplates);
