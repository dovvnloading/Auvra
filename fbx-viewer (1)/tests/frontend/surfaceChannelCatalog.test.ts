import { describe, expect, it } from 'vitest';
import { PHYSICAL_FEATURE_OUTPUTS } from '../../runtime/materials/materialGraph';
import { CHANNEL_DEFAULT, CHANNEL_IS_COLOR, CHANNEL_LABELS, PAINT_CHANNELS, createPaintDocument, readPaintDocument } from '../../texturing/paint/paintTypes';
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

    it('labels proposed shader channels but never enables them in PaintDocument v1', () => {
        const currentKeys = new Set(PAINT_CHANNELS as readonly string[]);
        const proposedKeys: ReadonlySet<string> = new Set(PROPOSED_PHYSICAL_CHANNELS.map((channel) => channel.key));
        expect(proposedKeys.size).toBe(PROPOSED_PHYSICAL_CHANNELS.length);
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
