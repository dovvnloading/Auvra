import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTPUT_NODE_TYPE, createMaterialGraph } from '../../runtime/materials/materialGraph';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { applyMaterialOverrides, convertsForAsset } from '../../utils/materialOverrides';

const keeping = () => {
    const graph = createMaterialGraph();
    return { ...graph, nodes: graph.nodes.map(node => (node.type === OUTPUT_NODE_TYPE ? { ...node, params: { ...node.params, ownMaps: true } } : node)) };
};

afterEach(() => materialLibrary.replaceAll([]));

describe('unlit and Phong materials converted to take a material asset', () => {
    it('swap for a standard copy keeping colour, map and emission, which takes the asset', () => {
        materialLibrary.replaceAll([{ id: 'converted', name: 'Sign (converted)', graph: keeping() }]);
        const map = new THREE.Texture();
        const phong = new THREE.MeshPhongMaterial({ name: 'Sign', color: new THREE.Color(0.2, 0.4, 0.6), map, emissive: new THREE.Color(1, 0, 0), shininess: 80 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), phong);
        const root = new THREE.Group().add(mesh);
        expect(convertsForAsset(phong)).toBe(true);
        applyMaterialOverrides(root, { Sign: { materialId: 'converted' } });
        const copy = mesh.material as unknown as THREE.MeshStandardMaterial;
        expect(copy).not.toBe(phong);
        expect(copy.isMeshStandardMaterial).toBe(true);
        expect(copy.name).toBe('Sign');
        expect(copy.color.toArray()).toEqual([0.2, 0.4, 0.6]);
        expect(copy.map).toBe(map);
        expect(copy.emissive.toArray()).toEqual([1, 0, 0]);
        expect(boundMaterialGraph(copy)).not.toBeNull();
        // Applied again, the same copy; without the asset, its own material back.
        applyMaterialOverrides(root, { Sign: { materialId: 'converted' } });
        expect(mesh.material).toBe(copy);
        applyMaterialOverrides(root, {});
        expect(mesh.material).toBe(phong);
    });

    it('leave unlit materials without an asset as they are', () => {
        const basic = new THREE.MeshBasicMaterial({ name: 'Glow' });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), basic);
        applyMaterialOverrides(new THREE.Group().add(mesh), { Glow: { color: '#ff0000' } });
        expect(mesh.material).toBe(basic);
    });
});
