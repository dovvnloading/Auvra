import { CHANNEL_DEFAULT, CHANNEL_IS_COLOR, CHANNEL_LABELS, PAINT_CHANNELS, type PaintChannel } from './paint/paintTypes';
import { PHYSICAL_FEATURE_OUTPUTS } from '../runtime/materials/materialGraph';

/**
 * SURFACE CHANNEL CONTRACT — M0
 *
 * This is a read-only compatibility catalog, NOT a second paint document schema.
 * PaintDocument v1, the existing PAINT_CHANNELS order, pixel storage and all seven
 * channel defaults remain authoritative. Future physical channels are proposals
 * until M2 explicitly adds authoring, rendering, baking, migration and export.
 */
export const SURFACE_CHANNEL_CONTRACT_VERSION = 1;

export type SurfaceValueKind = 'scalar' | 'colour' | 'tangentNormal';
export type SurfaceDataRole = 'colour' | 'data' | 'normal';
export type SurfaceUnit = 'normalized' | 'dimensionless' | 'degrees' | 'nanometres' | 'scene-units';
export type GltfPaintTextureRole =
    | 'baseColorTexture.rgb' | 'baseColorTexture.a'
    | 'metallicRoughnessTexture.g' | 'metallicRoughnessTexture.b'
    | 'normalTexture.rgb' | 'emissiveTexture.rgb';

export interface PaintV1ChannelDescriptor {
    readonly key: PaintChannel;
    readonly label: string;
    readonly valueKind: SurfaceValueKind;
    readonly role: SurfaceDataRole;
    /** Values as current paint layers store them; do not convert at this layer. */
    readonly defaultValue: readonly [number, number, number];
    /** True for channels whose pixel representation is RGB, including tangent normals. */
    readonly rgb: boolean;
    /** Bits per component in the editable sparse paint picture. */
    readonly paintBits: 8 | 16;
    /** Destination in the painted GLB. Null denotes a channel without a direct glTF slot. */
    readonly gltfTexture: GltfPaintTextureRole | null;
    /** Existing material output socket, if directly representable without a special operation. */
    readonly materialInput: string | null;
    readonly storage: 'paint-v1';
}

/** A channel's connection to the shader output, not its texture-file naming. Height is separate (parallax). */
const MATERIAL_INPUT_OF: Record<PaintChannel, string | null> = {
    baseColor: 'baseColor',
    roughness: 'roughness',
    metallic: 'metalness',
    height: null,
    normal: 'normal',
    emissive: 'emissive',
    opacity: 'opacity',
};

const VALUE_KIND_OF: Record<PaintChannel, SurfaceValueKind> = {
    baseColor: 'colour',
    roughness: 'scalar',
    metallic: 'scalar',
    height: 'scalar',
    normal: 'tangentNormal',
    emissive: 'colour',
    opacity: 'scalar',
};

/**
 * A typed, indexed view over the existing paint constants. It mirrors the old
 * values, not the other way around, so this addition cannot migrate a document.
 */
const descriptorOf = (key: PaintChannel, paintBits: 8 | 16, gltfTexture: GltfPaintTextureRole | null): PaintV1ChannelDescriptor => Object.freeze({
    key,
    label: CHANNEL_LABELS[key],
    valueKind: VALUE_KIND_OF[key],
    role: key === 'normal' ? 'normal' : CHANNEL_IS_COLOR[key] ? 'colour' : 'data',
    defaultValue: Object.freeze([...CHANNEL_DEFAULT[key]] as [number, number, number]),
    rgb: CHANNEL_IS_COLOR[key],
    paintBits,
    gltfTexture,
    materialInput: MATERIAL_INPUT_OF[key],
    storage: 'paint-v1',
});

export const PAINT_V1_CHANNEL_CATALOG: Readonly<Record<PaintChannel, PaintV1ChannelDescriptor>> = Object.freeze({
    baseColor: descriptorOf('baseColor', 8, 'baseColorTexture.rgb'),
    roughness: descriptorOf('roughness', 8, 'metallicRoughnessTexture.g'),
    metallic: descriptorOf('metallic', 8, 'metallicRoughnessTexture.b'),
    height: descriptorOf('height', 16, null),
    normal: descriptorOf('normal', 16, 'normalTexture.rgb'),
    emissive: descriptorOf('emissive', 8, 'emissiveTexture.rgb'),
    opacity: descriptorOf('opacity', 8, 'baseColorTexture.a'),
});

/**
 * The contract for M2 design work, deliberately NOT included in PAINT_CHANNELS.
 * None of these keys may be stored in PaintDocument v1 by this catalog.
 */
export const PROPOSED_PHYSICAL_CHANNELS = Object.freeze([
    { key: 'specularWeight', kind: 'scalar', unit: 'normalized', feature: 'specular' },
    { key: 'specularColor', kind: 'colour', unit: 'normalized', feature: 'specular' },
    { key: 'ior', kind: 'scalar', unit: 'dimensionless', feature: 'specular' },
    { key: 'coat', kind: 'scalar', unit: 'normalized', feature: 'coat' },
    { key: 'coatRoughness', kind: 'scalar', unit: 'normalized', feature: 'coat' },
    { key: 'coatColor', kind: 'colour', unit: 'normalized', feature: 'coat' },
    { key: 'coatNormal', kind: 'tangentNormal', unit: 'normalized', feature: 'coat' },
    { key: 'sheenColor', kind: 'colour', unit: 'normalized', feature: 'sheen' },
    { key: 'sheenRoughness', kind: 'scalar', unit: 'normalized', feature: 'sheen' },
    { key: 'anisotropy', kind: 'scalar', unit: 'normalized', feature: 'anisotropy' },
    { key: 'anisotropyRotation', kind: 'scalar', unit: 'degrees', feature: 'anisotropy' },
    { key: 'thinFilm', kind: 'scalar', unit: 'normalized', feature: 'thinFilm' },
    { key: 'thinFilmThickness', kind: 'scalar', unit: 'nanometres', feature: 'thinFilm' },
    { key: 'transmission', kind: 'scalar', unit: 'normalized', feature: 'transmission' },
    { key: 'thickness', kind: 'scalar', unit: 'scene-units', feature: 'transmission' },
    { key: 'attenuationColor', kind: 'colour', unit: 'normalized', feature: 'transmission' },
    { key: 'attenuationDistance', kind: 'scalar', unit: 'scene-units', feature: 'transmission' },
    { key: 'dispersion', kind: 'scalar', unit: 'dimensionless', feature: 'dispersion' },
    { key: 'flakeDensity', kind: 'scalar', unit: 'normalized', feature: 'flakes' },
    { key: 'flakeSize', kind: 'scalar', unit: 'scene-units', feature: 'flakes' },
    { key: 'flakeColor', kind: 'colour', unit: 'normalized', feature: 'flakes' },
] as const satisfies readonly {
    key: string; kind: SurfaceValueKind; unit: SurfaceUnit; feature: keyof typeof PHYSICAL_FEATURE_OUTPUTS;
}[]);
for (const descriptor of PROPOSED_PHYSICAL_CHANNELS) Object.freeze(descriptor);

export type ProposedPhysicalChannel = typeof PROPOSED_PHYSICAL_CHANNELS[number]['key'];

/**
 * A design-time inspection helper, not a runtime registration mechanism.
 * A key is only marked "planned" until the entire paint/renderer/export
 * pipeline has been implemented and gated separately.
 */
export const physicalChannelPlan = (key: string): 'paint-v1' | 'planned' | 'unknown' =>
    (PAINT_CHANNELS as readonly string[]).includes(key)
        ? 'paint-v1'
        : PROPOSED_PHYSICAL_CHANNELS.some((channel) => channel.key === key) ? 'planned' : 'unknown';
