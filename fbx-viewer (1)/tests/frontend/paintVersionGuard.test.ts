import { describe, expect, it } from 'vitest';
import {
    incompatiblePaintSetFor, readPaintDocument, unsupportedPaintVersion,
} from '../../texturing/paint/paintTypes';

/** Minimal authored data: future channels must not be dropped by a v1 round-trip. */
const source = {
    modelId: 'prop',
    materialNames: ['Metal', 'Rubber'],
    size: 11,
    channels: ['baseColor', 'coat'],
    layers: [
        { id: 'l1', name: 'Future coat', kind: 'paint', channels: { coat: { mode: 'normal', opacity: 1 } } },
    ],
};

const target = { modelId: 'prop', materialNames: ['Rubber'] };

describe('paint format version compatibility', () => {
    it('still reads legacy versionless and explicit v1 documents', () => {
        const v1 = { ...source, channels: ['baseColor'], layers: [], version: 1 };
        const legacy = { ...v1, version: undefined };
        expect(readPaintDocument(v1)?.version).toBe(1);
        expect(readPaintDocument(legacy)?.version).toBe(1);
        expect(unsupportedPaintVersion(legacy)).toBeNull();
        expect(unsupportedPaintVersion(v1)).toBeNull();
    });

    it('refuses future or invalid explicit versions without discarding their channels', () => {
        for (const version of [2, 3, '2', 0, null, -1]) {
            const doc = { ...source, version };
            const savedBefore = JSON.stringify(doc);
            expect(unsupportedPaintVersion(doc)).toEqual({ version });
            expect(readPaintDocument(doc)).toBeNull();
            expect(JSON.stringify(doc)).toBe(savedBefore);
        }
    });

    it('matches only an existing incompatible set for the same model/material', () => {
        const assets = [
            { id: 'preset', name: 'Preset metadata', paint: { version: 8, kind: 'preset' } },
            { id: 'other-model', name: 'Different model', paint: { ...source, modelId: 'other', version: 3 } },
            { id: 'other-surface', name: 'Another material', paint: { ...source, materialNames: ['Glass'], version: 2 } },
            { id: 'actual', name: 'Coated surface', paint: { ...source, version: 2 } },
        ];
        expect(incompatiblePaintSetFor(assets, target)).toEqual({
            id: 'actual', name: 'Coated surface', version: 2,
        });
        expect(incompatiblePaintSetFor(assets, { ...target, modelId: 'missing' })).toBeNull();
        expect(incompatiblePaintSetFor(assets, { ...target, materialNames: ['Wood'] })).toBeNull();
    });

    it('does not block ordinary current paint sets, absent paint or unrelated metadata', () => {
        const assets = [
            { id: 'missing', name: 'No paint' },
            { id: 'current', name: 'Current paint', paint: { ...source, version: 1 } },
            { id: 'legacy', name: 'Old paint', paint: { ...source } },
            { id: 'meta', name: 'Tool metadata', paint: { version: 9, settings: true } },
        ];
        expect(incompatiblePaintSetFor(assets, target)).toBeNull();
    });
});
