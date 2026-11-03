import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../texturing/mesh/picker';
import { allLayers, createPaintDocument, insertLayer, locateLayer, mapLayer, moveLayer, newFillLayer, newFolder, newPaintLayer, readPaintDocument } from '../../texturing/paint/paintTypes';
import { BUILTIN_GRAPHS, SMART_MASKS, SMART_MATERIALS } from '../../texturing/paint/smartLibrary';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

const plane = (uvShift = 0) => {
    const geometry = new THREE.PlaneGeometry(2, 2, 4, 4);
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + uvShift);
    const material = new THREE.MeshStandardMaterial({ name: 'Surface' });
    const mesh = new THREE.Mesh(geometry, material);
    const root = new THREE.Group();
    root.add(mesh);
    return { root, material };
};

describe('texture set layers', () => {
    it('inserts, moves into folders and back, and finds layers', () => {
        const document = createPaintDocument('model', ['Surface']);
        const base = newFillLayer(document, 'Base');
        const paint = newPaintLayer(document, 'Scratches');
        const folder = newFolder('Wear');
        let layers = insertLayer([], base, null);
        layers = insertLayer(layers, folder, base.id);
        layers = insertLayer(layers, paint, folder.id);
        expect(layers.map((layer) => layer.name)).toEqual(['Base', 'Wear', 'Scratches']);
        layers = moveLayer(layers, paint.id, folder.id, true);
        expect(layers.map((layer) => layer.name)).toEqual(['Base', 'Wear']);
        expect(locateLayer(layers, paint.id)?.parent?.id).toBe(folder.id);
        // A folder cannot go inside itself.
        expect(moveLayer(layers, folder.id, paint.id, true)).toEqual(layers);
        layers = mapLayer(layers, paint.id, (layer) => ({ ...layer, visible: false }));
        expect(allLayers(layers).find((layer) => layer.id === paint.id)?.visible).toBe(false);
        layers = mapLayer(layers, paint.id, () => null);
        expect(allLayers(layers).map((layer) => layer.name)).toEqual(['Base', 'Wear']);
    });

    it('reads stored documents safely', () => {
        expect(readPaintDocument(null)).toBeNull();
        const stored = readPaintDocument({ modelId: 'm', materialNames: ['A'], layers: [{ id: 'l', kind: 'paint', name: 'P', channels: { baseColor: { mode: 'multiply', opacity: 3 }, nonsense: {} } }, { id: 'x', kind: 'bogus' }], size: 99, udim: true });
        expect(stored?.layers).toHaveLength(1);
        expect(stored?.layers[0].channels).toEqual({ baseColor: { mode: 'multiply', opacity: 1 } });
        expect(stored?.size).toBe(12);
        expect(stored?.udim).toBe(true);
    });

    it('builds every smart material from layers whose smart masks exist', () => {
        const document = createPaintDocument('model', ['Surface']);
        for (const material of SMART_MATERIALS) {
            const folder = material.build(document);
            expect(folder.kind).toBe('folder');
            for (const layer of allLayers(folder.layers ?? [])) {
                for (const effect of layer.mask ?? []) if (effect.kind === 'generator') expect(BUILTIN_GRAPHS.has(effect.graphId!)).toBe(true);
            }
        }
        for (const mask of SMART_MASKS) expect(BUILTIN_GRAPHS.has(mask.id)).toBe(true);
    });

    it('builds smart graphs from nodes this build has', () => {
        for (const entry of BUILTIN_GRAPHS.values()) {
            for (const node of entry.graph.nodes) expect(textureNodeDefinitionByType(node.type), `${entry.name}: ${node.type}`).toBeTruthy();
            expect(entry.graph.nodes.some((node) => node.type === 'output')).toBe(true);
        }
    });
});

describe('texture set meshes', () => {
    it('keeps a surface whose coordinates run past 0..1 on one picture unless it is laid out in tiles', () => {
        // Triangles straddling u = 1: a repeated picture, not tiles.
        const straddling = plane(0.6);
        const wrapped = buildPartMesh(straddling.root, new Set([straddling.material]));
        expect(wrapped.udim).toBe(false);
        expect(wrapped.tiles).toEqual([1001]);
        // Half in each tile, none across the line: a tiled layout.
        const halves = plane(0.5);
        const tiled = buildPartMesh(halves.root, new Set([halves.material]));
        expect(tiled.udim).toBe(true);
        expect(tiled.tiles).toEqual([1001, 1002]);
        expect(buildPartMesh(halves.root, new Set([halves.material]), { udim: false }).tiles).toEqual([1001]);
    });

    it('finds the point under a ray, with its texture coordinates', () => {
        const { root, material } = plane();
        const part = buildPartMesh(root, new Set([material]));
        const hit = new SurfacePicker(part).cast(new THREE.Vector3(0.5, 0.5, 5), new THREE.Vector3(0, 0, -1));
        expect(hit).not.toBeNull();
        expect(hit!.point.z).toBeCloseTo(0);
        expect(hit!.uv.x).toBeCloseTo(0.75);
        expect(hit!.uv.y).toBeCloseTo(0.75);
        expect(part.islandCount).toBe(1);
    });
});
