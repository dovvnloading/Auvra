import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { deleteMaterialQuestion, materialUses } from '../../components/Materials/materialDeletion';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import type { LevelObject } from '../../types';

const graph = () => normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) }], links: [] });

const models = [
    { id: 'crate', name: 'Crate', materialOverrides: { Body: { materialId: 'bricks', parameters: [{ name: 'Tint', value: [1, 0, 0] }] } } },
    { id: 'wall', name: 'Wall', materialOverrides: { Face: { materialId: 'bricks' }, Trim: { roughness: 0.3 } } },
    { id: 'barrel', name: 'Barrel', materialOverrides: { Body: { materialId: 'rust' } } },
];
const objects = [
    { components: [{ id: 'd1', type: 'decal', enabled: true, props: { materialId: 'bricks' } }] },
    { components: [{ id: 'd2', type: 'decal', enabled: true, props: { textureId: 'logo' } }] },
] as unknown as LevelObject[];

afterEach(() => materialLibrary.replaceAll([]));

describe('deleting a material asset', () => {
    it('names what uses it before it goes', () => {
        const uses = materialUses('bricks', models, objects);
        expect(uses.models.map(model => model.name)).toEqual(['Crate', 'Wall']);
        expect(uses.decals).toBe(1);
        expect(deleteMaterialQuestion('Bricks', uses)).toEqual({
            title: 'Delete "Bricks"?',
            message: 'It is used by 2 models (Crate and Wall) and a decal, which go back to their own materials. You can undo this.',
        });
        expect(deleteMaterialQuestion('Spare', materialUses('spare', models, objects)).message).toBe('Nothing uses it. You can undo this.');
        const many = materialUses('bricks', [...models, ...['A', 'B', 'C'].map(name => ({ id: name, name, materialOverrides: { X: { materialId: 'bricks' } } }))], []);
        expect(deleteMaterialQuestion('Bricks', many).message).toContain('5 models (Crate, Wall, A and 2 more)');
    });

    it('keeps the models\' overrides as they were, so an undo puts every one back', () => {
        const uses = materialUses('bricks', models, objects);
        // What deleting does to them (db.deleteMaterialAsset) does not reach what was kept.
        delete (models[0].materialOverrides.Body as { materialId?: string }).materialId;
        expect(uses.models[0].overrides).toEqual({ Body: { materialId: 'bricks', parameters: [{ name: 'Tint', value: [1, 0, 0] }] } });
        expect(uses.models[1].overrides).toEqual({ Face: { materialId: 'bricks' }, Trim: { roughness: 0.3 } });
    });

    it('can be undone: the asset comes back and its materials are shaded by it again', () => {
        const asset = { id: 'bricks', name: 'Bricks', graph: graph() };
        materialLibrary.replaceAll([asset]);
        const material = new THREE.MeshStandardMaterial();
        materialLibrary.assign(material, 'bricks');
        materialLibrary.remove('bricks');
        expect(boundMaterialGraph(material)).toBeNull();
        materialLibrary.upsert(asset);
        materialLibrary.assign(material, 'bricks');
        expect(boundMaterialGraph(material)).not.toBeNull();
    });
});
