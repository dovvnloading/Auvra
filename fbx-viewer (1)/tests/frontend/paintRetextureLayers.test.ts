import { describe, expect, it } from 'vitest';
import { retextureLayer, retextureNamePrefix, retextureResults } from '../../components/Texturing/Paint/retextureLayers';
import { createPaintDocument } from '../../texturing/paint/paintTypes';

const set = { modelName: 'Helmet.glb', partName: 'Visor', materialNames: ['Visor', 'Glass'] };
const textures = [
    { id: 't1', name: 'Helmet.glb Visor - rusty steel' },
    { id: 't1n', name: 'Helmet.glb Visor - rusty steel normal' },
    { id: 't1r', name: 'Helmet.glb Visor - rusty steel roughness' },
    { id: 't2', name: 'Helmet.glb Visor - gold leaf' },
    { id: 'other', name: 'Helmet.glb Strap - leather' },
];

describe('Retexture results as layers', () => {
    it('find the result the set wears, through its painted copy or an older painted base map, and those kept for it', () => {
        const copy = { owner: { modelId: 'm', material: 'Visor' }, pictures: { baseColor: 't2' } };
        const results = retextureResults(set, { Visor: { materialId: 'copy', normalTextureId: 'n9' }, Glass: { mapTextureId: 'legacy', paintedMap: true } }, (id) => (id === 'copy' ? copy : undefined), textures);
        expect(results.map((result) => result.key)).toEqual(['worn:t2', 'worn:legacy', 'kept:t1']);
        expect(results[0]).toMatchObject({ name: 'Worn now: gold leaf', textures: { baseColor: 't2', normal: 'n9' } });
        // A kept result brings its surface maps; other sets' are left out.
        expect(results[2]).toMatchObject({ name: 'rusty steel', textures: { baseColor: 't1', normal: 't1n', roughness: 't1r' } });
        expect(retextureNamePrefix('My  model', 'Body:1')).toBe('My model Body 1 - ');
        // A material drawn by a material asset that is not a painted copy wears no result.
        expect(retextureResults(set, { Visor: { materialId: 'shared' } }, () => ({ pictures: { baseColor: 'x' } }), []).length).toBe(0);
    });

    it('come in as a fill along the UVs on the channels the set paints', () => {
        const document = createPaintDocument('m', ['Visor'], 10);
        const layer = retextureLayer(document, { key: 'kept:t1', name: 'rusty steel', textures: { baseColor: 't1', normal: 't1n', roughness: 't1r' } });
        expect(layer.kind).toBe('fill');
        expect(layer.name).toBe('Retexture: rusty steel');
        expect(layer.fill?.baseColor).toMatchObject({ kind: 'texture', textureId: 't1', projection: 'uv', scale: 1 });
        expect(Object.keys(layer.fill ?? {}).sort()).toEqual(['baseColor', 'normal', 'roughness'].filter((channel) => document.channels.includes(channel as never)).sort());
    });
});
