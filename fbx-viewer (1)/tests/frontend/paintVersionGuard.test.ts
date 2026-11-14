import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PaintSession, samePaintSessionOwner } from '../../components/Texturing/Paint/paintSession';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import { projectService } from '../../utils/projectService';
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

describe('Paint pending-write project generation fencing', () => {
    it('does not save into a new project, a rehydrated material library or a newer editor session', () => {
        const captured = { projectId: 'a', libraryGeneration: 1, editorGeneration: 6 };
        expect(samePaintSessionOwner(captured, { ...captured })).toBe(true);
        expect(samePaintSessionOwner(captured, { ...captured, projectId: 'b' })).toBe(false);
        expect(samePaintSessionOwner(captured, { ...captured, libraryGeneration: 2 })).toBe(false);
        expect(samePaintSessionOwner(captured, { ...captured, editorGeneration: 7 })).toBe(false);
    });
});

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

    it('rejects a lossy editor open before uploading pictures or replacing the saved set', async () => {
        const asset = { id: 'authored', name: 'Coated metal', graph: createMaterialGraph(), paint: { ...source, version: 1 } };
        const saved = JSON.stringify(asset);
        const list = vi.spyOn(materialLibrary, 'list').mockReturnValue([asset]);
        const upsert = vi.spyOn(materialLibrary, 'upsert');
        const write = vi.spyOn(projectService, 'applyChanges');
        const host = { storeTexture: vi.fn(), discardTextures: vi.fn(), texture: vi.fn(), textureEntry: vi.fn(),
            setMaterialOverrides: vi.fn(), materialOverrides: vi.fn() };
        try {
            await expect(PaintSession.open({ ...target, modelName: 'Prop', partName: 'Rubber', object: new THREE.Group(), materials: [] }, host))
                .rejects.toThrow('Coated metal" uses unsupported channel "coat"');
            expect(write).not.toHaveBeenCalled();
            expect(upsert).not.toHaveBeenCalled();
            expect(host.storeTexture).not.toHaveBeenCalled();
            expect(JSON.stringify(asset)).toBe(saved);
        } finally {
            write.mockRestore();
            upsert.mockRestore();
            list.mockRestore();
        }
    });

    it('reopens a legacy multi-tile layer with its original normal blend and picture IDs', () => {
        const paint = { modelId: 'prop', materialNames: ['Rubber'], channels: ['normal', 'height'], size: 11, udim: true,
            layers: [{ id: 'detail', name: 'Detail', kind: 'paint', visible: true,
                channels: { normal: { mode: 'normalCombine', opacity: 0.45 } },
                pictures: { normal: { '1001': { assetId: 'normal-a' }, '1002': { assetId: 'normal-b' } } } }],
            before: { height: { '1001': { assetId: 'height' } } }, heightStrength: 0.3, bake: null };
        const expected = { ...paint, version: 1 };
        expect(incompatiblePaintSetFor([{ id: 'v1', name: 'Finish', paint }], target)).toBeNull();
        const first = readPaintDocument(paint);
        expect(first).toEqual(expected);
        expect(readPaintDocument(JSON.parse(JSON.stringify(first)))).toEqual(expected);
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

    it.each([
        { channels: ['roughness', 'coat'] },
        { before: { coat: { '1002': { assetId: 'original' } } } },
        { layers: [{ channels: { coat: { mode: 'normal' } } }] },
        { layers: [{ kind: 'folder', layers: [{ pictures: { coat: { '1002': { assetId: 'stroke' } } } }] }] },
        { layers: [{ fill: { coat: { kind: 'value', value: [1, 1, 1] } } }] },
        { layers: [{ fill: { metallic: { kind: 'below', channel: 'coat' } } }] },
        { layers: [{ mask: [{ kind: 'below', channel: 'coat' }] }] },
    ])('protects unrepresentable channel data before v1 normalization', (fields) => {
        for (const version of [1, undefined]) {
            const paint = { ...source, version, channels: ['roughness'], layers: [], ...fields };
            const before = JSON.stringify(paint);
            const assets = [{ id: 'metal', name: 'Metal finish', paint }];
            expect(incompatiblePaintSetFor(assets, target)).toEqual({ id: 'metal', name: 'Metal finish', channel: 'coat' });
            expect(incompatiblePaintSetFor(assets, { ...target, modelId: 'other' })).toBeNull();
            expect(JSON.stringify(paint)).toBe(before);
        }
    });

    it('accepts custom graph parameters and bake-map names outside channel slots', () => {
        const paint = { ...source, channels: ['roughness'], layers: [{ fill: { roughness: {
            kind: 'graph', graphId: 'coat', output: 'coat', values: { coat: 0.8 },
        } } }], bake: { maps: { curvature: {} } } };
        expect(incompatiblePaintSetFor([{ id: 'v1', name: 'Finish', paint }], target)).toBeNull();
    });

    it('does not block ordinary current paint sets, absent paint or unrelated metadata', () => {
        const assets = [
            { id: 'missing', name: 'No paint' },
            { id: 'current', name: 'Current paint', paint: { ...source, channels: ['roughness'], layers: [], version: 1 } },
            { id: 'legacy', name: 'Old paint', paint: { ...source, channels: ['roughness'], layers: [] } },
            { id: 'meta', name: 'Tool metadata', paint: { version: 9, settings: true } },
        ];
        expect(incompatiblePaintSetFor(assets, target)).toBeNull();
    });
});
