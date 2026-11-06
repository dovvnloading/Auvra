import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DECAL_COMPONENT, DECAL_DEFAULTS, DecalProjector, resolveDecalSettings } from '../../runtime/components/decalComponent';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';

afterEach(() => materialLibrary.replaceAll([]));

describe('a decal\'s whole material', () => {
    it('reads its surface values, made safe, and keeps old colour decals as they were', () => {
        expect(resolveDecalSettings({ textureId: 'logo', color: '#ff0000' })).toMatchObject({
            textureId: 'logo', color: '#ff0000', normalTextureId: '', roughness: 1, metalness: 0, emissive: '#000000', emissiveIntensity: 1, materialId: '',
        });
        expect(resolveDecalSettings({ roughness: 3, metalness: -1, emissive: 'red', emissiveIntensity: 500, materialId: ' rust ', normalTextureId: 'dents' }))
            .toMatchObject({ roughness: 1, metalness: 0, emissive: DECAL_DEFAULTS.emissive, emissiveIntensity: 20, materialId: 'rust', normalTextureId: 'dents' });
    });

    it('lists its normal map, surface values and material in the inspector', () => {
        const keys = DECAL_COMPONENT.props.map(prop => [prop.key, prop.type]);
        expect(keys).toEqual(expect.arrayContaining([['normalTextureId', 'texture'], ['roughness', 'number'], ['metalness', 'number'], ['emissive', 'color'], ['emissiveIntensity', 'number'], ['materialId', 'material']]));
    });

    it('draws its own normal map, roughness, metalness and glow', () => {
        const projector = new DecalProjector();
        projector.setSurface(0.3, 0.8, '#00ff00', 4);
        const normal = new THREE.Texture();
        projector.setNormalMap(normal);
        const material = projector.mesh.material;
        expect([material.roughness, material.metalness, material.emissiveIntensity]).toEqual([0.3, 0.8, 4]);
        expect(material.emissive.getHexString()).toBe('00ff00');
        expect(material.normalMap).toBe(normal);
        projector.dispose();
    });

    it('can draw a material asset instead, still lying over the surface, and let go of it', () => {
        materialLibrary.replaceAll([{ id: 'rust', name: 'Rust', graph: normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: { ...defaultParams(OUTPUT_NODE_TYPE), roughness: 0.9 } }], links: [] }) }]);
        const projector = new DecalProjector();
        const material = projector.mesh.material;
        projector.setMaterialAsset('rust');
        expect(boundMaterialGraph(material)).not.toBeNull();
        expect(material.depthWrite).toBe(false);
        expect(material.polygonOffset).toBe(true);
        expect(material.polygonOffsetFactor).toBe(-4);
        projector.setMaterialAsset(null);
        expect(boundMaterialGraph(material)).toBeNull();
        projector.setMaterialAsset('rust');
        projector.dispose();
        expect(materialLibrary.bindingOf(material)).toBeUndefined();
    });
});
