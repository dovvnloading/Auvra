import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { contractPaintedCopies, expandPaintedCopies, isPaintedCopy, paintedCopyGraph } from '../../utils/paintedCopies';
import { materialGraphSettings } from '../../runtime/materials/materialGraph';
import { bindMaterialGraph, boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialAssetDocument, materialLibrary, readMaterialAsset, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { applyMaterialOverrides, withoutPaintedBaseMaps } from '../../utils/materialOverrides';

const fragmentOf = (material: THREE.Material) => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader.fragmentShader;
};

let ids = 0;
const nextId = () => `copy-${++ids}`;

afterEach(() => materialLibrary.replaceAll([]));

describe('a painted copy\'s surface', () => {
    it('is the painted picture over the model\'s own maps, cut out where see-through, from both sides', () => {
        const settings = materialGraphSettings(paintedCopyGraph());
        expect(settings).toMatchObject({ keepOwnMaps: true, blendMode: 'masked', twoSided: true });
    });

    it('keeps the material\'s own normal, roughness, metalness and emission maps, changing only its colour', () => {
        const normalMap = new THREE.Texture();
        const roughnessMap = new THREE.Texture();
        const helmet = new THREE.MeshStandardMaterial({ normalMap, roughnessMap, metalnessMap: new THREE.Texture(), emissiveMap: new THREE.Texture() });
        bindMaterialGraph(helmet, paintedCopyGraph());
        expect(helmet.normalMap).toBe(normalMap);
        expect(helmet.roughnessMap).toBe(roughnessMap);
        const fragment = fragmentOf(helmet);
        // three's own code reads them: their chunks are left in place.
        for (const chunk of ['roughnessmap_fragment', 'metalnessmap_fragment', 'normal_fragment_maps', 'emissivemap_fragment']) expect(fragment).toContain(`#include <${chunk}>`);
        expect(fragment).toMatch(/diffuseColor\.rgb = mg_painted_out_rgb_\d+;/);
        // Without the setting the graph draws everything itself.
        const plain = new THREE.MeshStandardMaterial({ normalMap });
        const graph = paintedCopyGraph();
        bindMaterialGraph(plain, { ...graph, nodes: graph.nodes.map(node => (node.id === 'output' ? { ...node, params: { ...node.params, ownMaps: false } } : node)) });
        expect(plain.normalMap).toBeNull();
        expect(fragmentOf(plain)).not.toContain('#include <roughnessmap_fragment>');
    });
});

describe('painted base maps kept as painted copies', () => {
    it('become a copy the model owns, its override pointing at it', () => {
        const { overrides, upserts, removals } = contractPaintedCopies('helmet', {
            Visor: { mapTextureId: 'tex-painted', paintedMap: true, roughness: 0.4 },
            Body: { mapTextureId: 'tex-plain' },
        }, [], nextId);
        expect(upserts).toHaveLength(1);
        const copy = upserts[0];
        expect(copy).toMatchObject({ name: 'Painted Visor', owner: { modelId: 'helmet', material: 'Visor' }, pictures: { baseColor: 'tex-painted' } });
        expect(isPaintedCopy(copy)).toBe(true);
        expect(overrides).toEqual({ Visor: { roughness: 0.4, materialId: copy.id }, Body: { mapTextureId: 'tex-plain' } });
        expect(removals).toEqual([]);
        // Stored and read back, nothing is lost.
        expect(readMaterialAsset(materialAssetDocument(copy))).toEqual(copy);
    });

    it('reuse the material\'s copy for a new picture, and save nothing when nothing changed', () => {
        const first = contractPaintedCopies('helmet', { Visor: { mapTextureId: 'a', paintedMap: true } }, [], nextId).upserts[0];
        const again = contractPaintedCopies('helmet', { Visor: { mapTextureId: 'b', paintedMap: true } }, [first], nextId);
        expect(again.upserts.map(copy => [copy.id, copy.pictures?.baseColor])).toEqual([[first.id, 'b']]);
        expect(contractPaintedCopies('helmet', { Visor: { mapTextureId: 'a', paintedMap: true } }, [first], nextId).upserts).toEqual([]);
    });

    it('are shown back as painted base maps for Material Overrides and Retexture, round the trip unchanged', () => {
        const stored = contractPaintedCopies('helmet', { Visor: { mapTextureId: 'tex-painted', paintedMap: true, roughness: 0.4 } }, [], nextId);
        const lookup = (id: string) => stored.upserts.find(copy => copy.id === id);
        const shown = expandPaintedCopies(stored.overrides, lookup);
        expect(shown).toEqual({ Visor: { roughness: 0.4, mapTextureId: 'tex-painted', paintedMap: true } });
        expect(contractPaintedCopies('helmet', shown, stored.upserts, nextId).overrides).toEqual(stored.overrides);
        // A shared material asset is not a copy: it stays as it is.
        expect(expandPaintedCopies({ Body: { materialId: 'bricks' } }, () => ({ id: 'bricks', name: 'Bricks', graph: paintedCopyGraph() }))).toEqual({ Body: { materialId: 'bricks' } });
    });

    it('are dropped by Reset Textures: the painted maps come off and the model\'s copies go', () => {
        const stored = contractPaintedCopies('helmet', { Visor: { mapTextureId: 'p', paintedMap: true }, Body: { roughness: 0.2 } }, [], nextId);
        const others: MaterialAsset = { id: 'other', name: 'Painted Lid', graph: paintedCopyGraph(), owner: { modelId: 'crate', material: 'Lid' } };
        const lookup = (id: string) => stored.upserts.find(copy => copy.id === id);
        const reset = withoutPaintedBaseMaps(expandPaintedCopies(stored.overrides, lookup));
        const after = contractPaintedCopies('helmet', reset, [...stored.upserts, others], nextId);
        expect(after.overrides).toEqual({ Body: { roughness: 0.2 } });
        expect(after.removals).toEqual([stored.upserts[0].id]);
    });

    it('draw on the model through its override, its own normal map kept', () => {
        const stored = contractPaintedCopies('helmet', { Visor: { mapTextureId: 'tex-painted', paintedMap: true } }, [], nextId);
        materialLibrary.replaceAll(stored.upserts);
        const normalMap = new THREE.Texture();
        const visor = new THREE.MeshStandardMaterial({ name: 'Visor', normalMap });
        applyMaterialOverrides(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), visor)), stored.overrides);
        const graph = boundMaterialGraph(visor)!;
        expect(graph.nodes.find(node => node.id === 'painted')?.params.texture).toBe('tex-painted');
        expect(visor.normalMap).toBe(normalMap);
    });
});
