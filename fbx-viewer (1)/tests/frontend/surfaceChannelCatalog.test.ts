import { describe, expect, it } from 'vitest';
import { PHYSICAL_FEATURE_OUTPUTS } from '../../runtime/materials/materialGraph';
import { CHANNEL_DEFAULT, CHANNEL_IS_COLOR, CHANNEL_LABELS, PAINT_CHANNELS, createPaintDocument, readPaintDocument } from '../../texturing/paint/paintTypes';
import { pictureKey, picturePrecision } from '../../texturing/paint/paintStack';
import {
    PAINT_V1_CHANNEL_CATALOG, PROPOSED_PHYSICAL_CHANNELS,
    SURFACE_CHANNEL_CONTRACT_VERSION, physicalChannelPlan,
} from '../../texturing/surfaceChannelCatalog';

describe('M0 physical surface channel compatibility contract', () => {
    it('mirrors every existing paint channel without changing order, names, defaults or RGB meaning', () => {
        expect(SURFACE_CHANNEL_CONTRACT_VERSION).toBe(1);
        expect(PAINT_CHANNELS).toEqual(['baseColor', 'roughness', 'metallic', 'height', 'normal', 'emissive', 'opacity']);
        expect(Object.keys(PAINT_V1_CHANNEL_CATALOG)).toEqual(PAINT_CHANNELS);
        for (const key of PAINT_CHANNELS) {
            const spec = PAINT_V1_CHANNEL_CATALOG[key];
            expect(spec.key).toBe(key);
            expect(spec.label).toBe(CHANNEL_LABELS[key]);
            expect(spec.defaultValue).toEqual(CHANNEL_DEFAULT[key]);
            expect(spec.rgb).toBe(CHANNEL_IS_COLOR[key]);
            expect(spec.storage).toBe('paint-v1');
            expect(physicalChannelPlan(key)).toBe('paint-v1');
        }
        expect(PAINT_V1_CHANNEL_CATALOG.metallic.materialInput).toBe('metalness');
        expect(PAINT_V1_CHANNEL_CATALOG.height.materialInput).toBeNull();
        expect(PAINT_V1_CHANNEL_CATALOG.normal).toMatchObject({
            role: 'normal', valueKind: 'tangentNormal', rgb: true, defaultValue: [0.5, 0.5, 1],
        });
        expect(PAINT_V1_CHANNEL_CATALOG.roughness).toMatchObject({ role: 'data', valueKind: 'scalar' });
    });

    it('locks paint defaults, roles, sparse component precision and GLB packing independently of the source tables', () => {
        const expected = [
            ['baseColor', [0.5, 0.5, 0.5], 'colour', 8, 'baseColorTexture.rgb'],
            ['roughness', [0.6, 0.6, 0.6], 'data', 8, 'metallicRoughnessTexture.g'],
            ['metallic', [0, 0, 0], 'data', 8, 'metallicRoughnessTexture.b'],
            ['height', [0.5, 0.5, 0.5], 'data', 16, null],
            ['normal', [0.5, 0.5, 1], 'normal', 16, 'normalTexture.rgb'],
            ['emissive', [0, 0, 0], 'colour', 8, 'emissiveTexture.rgb'],
            ['opacity', [1, 1, 1], 'data', 8, 'baseColorTexture.a'],
        ];
        expect(Object.values(PAINT_V1_CHANNEL_CATALOG).map(channel => [
            channel.key, channel.defaultValue, channel.role, channel.paintBits, channel.gltfTexture,
        ])).toEqual(expected);
        for (const channel of Object.values(PAINT_V1_CHANNEL_CATALOG)) {
            expect(channel.paintBits).toBe(picturePrecision(pictureKey('layer', channel.key)));
            expect(Object.isFrozen(channel)).toBe(true);
            expect(Object.isFrozen(channel.defaultValue)).toBe(true);
        }
        expect(Object.isFrozen(PAINT_V1_CHANNEL_CATALOG)).toBe(true);
        expect(Object.isFrozen(PROPOSED_PHYSICAL_CHANNELS)).toBe(true);
        expect(PROPOSED_PHYSICAL_CHANNELS.every(channel => Object.isFrozen(channel))).toBe(true);
    });

    it('labels proposed shader channels but never enables them in PaintDocument v1', () => {
        const currentKeys = new Set(PAINT_CHANNELS as readonly string[]);
        const proposedKeys: ReadonlySet<string> = new Set(PROPOSED_PHYSICAL_CHANNELS.map((channel) => channel.key));
        expect(proposedKeys.size).toBe(PROPOSED_PHYSICAL_CHANNELS.length);
        expect(proposedKeys).toEqual(new Set(Object.values(PHYSICAL_FEATURE_OUTPUTS).flat()));
        for (const channel of PROPOSED_PHYSICAL_CHANNELS) {
            expect(currentKeys.has(channel.key)).toBe(false);
            expect(physicalChannelPlan(channel.key)).toBe('planned');
            expect(PHYSICAL_FEATURE_OUTPUTS[channel.feature]).toContain(channel.key);
        }
        expect(physicalChannelPlan('unknownChannel')).toBe('unknown');

        const before = createPaintDocument('model', ['painted']);
        expect(before.version).toBe(1);
        expect(before.channels).toEqual(['baseColor', 'roughness', 'metallic', 'height', 'normal']);
        const saved = readPaintDocument(JSON.parse(JSON.stringify(before)));
        expect(saved).toEqual(before);
        expect(saved?.channels.some((key) => proposedKeys.has(key))).toBe(false);
    });
});
