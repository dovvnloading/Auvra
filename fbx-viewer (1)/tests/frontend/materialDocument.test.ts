import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    MATERIAL_PICTURE_NODE_TYPE,
    OUTPUT_NODE_TYPE,
    compileMaterialGraph,
    defaultParams,
    normalizeMaterialGraph,
    readsMaterialPictures,
    textureSlot,
    withMaterialPictures,
} from '../../runtime/materials/materialGraph';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialAssetDocument, materialLibrary, readMaterialAsset } from '../../runtime/materials/materialLibrary';
import { materialGraphForTextures, rewriteMaterialPictures, surfaceGraphForPictures } from '../../texturing/materialOutput';

const plainGraph = () => normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: { ...defaultParams(OUTPUT_NODE_TYPE), roughness: 0.4 } }], links: [] });
const made = { baseColor: 'tex-albedo', normal: 'tex-normal', orm: 'tex-orm', height: 'tex-height' };

afterEach(() => materialLibrary.replaceAll([]));

describe('a material document from before pictures were kept by name', () => {
    it('loads a plain shader graph as it was, with no pictures', () => {
        const document = { id: 'm', name: 'Plain', graph: plainGraph(), textureIds: [] };
        const asset = readMaterialAsset(document)!;
        expect(asset.pictures).toBeUndefined();
        expect(asset.graph).toEqual(document.graph);
        expect(materialAssetDocument(asset)).toEqual(document);
    });

    it('takes a texture graph\'s last made pictures as its pictures, keeping the graph and the texture graph', () => {
        const graph = normalizeMaterialGraph(materialGraphForTextures(made));
        const textureGraph = { graph: { nodes: [] }, values: {}, bakeSize: 1024, baked: { textures: made, signature: 's', size: 1024, at: 1 } };
        const asset = readMaterialAsset({ id: 'm', name: 'Rock', graph, textureGraph, textureIds: Object.values(made) })!;
        expect(asset.pictures).toEqual(made);
        expect(asset.graph).toEqual(graph);
        expect(asset.textureGraph).toEqual(textureGraph);
        const stored = materialAssetDocument(asset);
        expect(stored.pictures).toEqual(made);
        expect(new Set(stored.textureIds)).toEqual(new Set(Object.values(made)));
        // Read again, nothing changes.
        expect(materialAssetDocument(readMaterialAsset(stored)!)).toEqual(stored);
    });

    it('takes a painting\'s applied pictures as its pictures', () => {
        const paint = { layers: [], applied: { textures: { baseColor: 'tex-painted', roughness: 'tex-rough' }, at: 2 } };
        const asset = readMaterialAsset({ id: 'm', name: 'Painted', graph: plainGraph(), paint, textureIds: [] })!;
        expect(asset.pictures).toEqual({ baseColor: 'tex-painted', roughness: 'tex-rough' });
        expect(asset.paint).toEqual(paint);
    });

    it('keeps pictures it already has, dropping names that are not pictures', () => {
        const asset = readMaterialAsset({ id: 'm', name: 'M', graph: plainGraph(), pictures: { baseColor: 'a', shine: 'b', normal: '' }, textureGraph: { baked: { textures: { baseColor: 'older' } } } })!;
        expect(asset.pictures).toEqual({ baseColor: 'a' });
    });
});

describe('a material\'s pictures read by name', () => {
    it('are read by Material Picture nodes, and by Parallax from its height picture', () => {
        const graph = normalizeMaterialGraph(surfaceGraphForPictures(made));
        expect(readsMaterialPictures(graph)).toBe(true);
        const pictures = graph.nodes.filter(node => node.type === MATERIAL_PICTURE_NODE_TYPE);
        expect(pictures.map(node => node.params.output).sort()).toEqual(['baseColor', 'normal', 'orm']);
        expect(graph.nodes.find(node => node.type === 'parallax')?.params.heightFrom).toBe('height');
        expect(graph.links).toContainEqual({ fromNode: 'normal', fromOutput: 'normal', toNode: 'output', toInput: 'normal' });
        expect(textureSlot(pictures.find(node => node.params.output === 'normal')!)).toBe('normal');
        expect(textureSlot(pictures.find(node => node.params.output === 'orm')!)).toBe('data');
        // Filled in when drawn: each with its picture's texture.
        const filled = withMaterialPictures(graph, made);
        expect(filled.nodes.find(node => node.id === 'baseColor')?.params.texture).toBe('tex-albedo');
        expect(filled.nodes.find(node => node.type === 'parallax')?.params.texture).toBe('tex-height');
        expect(withMaterialPictures(filled, made)).toBe(filled);
        expect(compileMaterialGraph(filled).uniforms.some(uniform => uniform.nodeId === 'baseColor' && uniform.param === 'texture')).toBe(true);
    });

    it('reach a material shaded by the asset, and a change of pictures alone draws the new ones', () => {
        const graph = normalizeMaterialGraph(surfaceGraphForPictures({ baseColor: 'tex-a' }));
        materialLibrary.replaceAll([{ id: 'rock', name: 'Rock', graph, pictures: { baseColor: 'tex-a' } }]);
        const material = new THREE.MeshStandardMaterial();
        materialLibrary.assign(material, 'rock');
        const readTexture = () => boundMaterialGraph(material)!.nodes.find(node => node.id === 'baseColor')!.params.texture;
        expect(readTexture()).toBe('tex-a');
        materialLibrary.upsert({ id: 'rock', name: 'Rock', graph, pictures: { baseColor: 'tex-b' } });
        expect(readTexture()).toBe('tex-b');
    });
});

describe('making a material\'s pictures again', () => {
    it('changes only its pictures, so a surface graph edited by hand keeps its edits', () => {
        const generated = normalizeMaterialGraph(surfaceGraphForPictures(made));
        const edited = { ...generated, nodes: generated.nodes.map(node => (node.type === OUTPUT_NODE_TYPE ? { ...node, params: { ...node.params, emissiveStrength: 4 } } : node)) };
        const next = { baseColor: 'tex-albedo-2', normal: 'tex-normal-2', orm: 'tex-orm-2', height: 'tex-height-2' };
        const rewritten = rewriteMaterialPictures({ graph: edited, pictures: made }, next);
        expect(rewritten.graph).toBe(edited);
        expect(rewritten.pictures).toEqual(next);
    });

    it('builds the surface again for an older graph, or when the set of pictures changes', () => {
        const older = normalizeMaterialGraph(materialGraphForTextures(made));
        expect(readsMaterialPictures(rewriteMaterialPictures({ graph: older, pictures: made }, made).graph)).toBe(true);
        const generated = normalizeMaterialGraph(surfaceGraphForPictures({ baseColor: 'a' }));
        const grown = rewriteMaterialPictures({ graph: generated, pictures: { baseColor: 'a' } }, { baseColor: 'a', normal: 'n' });
        expect(grown.graph).not.toBe(generated);
        expect(grown.graph.nodes.some(node => node.params.output === 'normal')).toBe(true);
    });
});
