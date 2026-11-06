import { describe, expect, it, vi } from 'vitest';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import { unknownNodeTypes } from '../../texturing/graph/document';
import type { GraphResolver } from '../../texturing/graph/registry';
import { MATERIAL_PRESETS, paintWithMaterial, presetLayer } from '../../texturing/paint/materialPresets';
import { allLayers, createPaintDocument, newFillLayer, newFilterLayer, newFolder, newPaintLayer, readPaintDocument, type PaintLayer } from '../../texturing/paint/paintTypes';
import { BUILTIN_GRAPHS, SMART_MATERIALS, generatorEffect } from '../../texturing/paint/smartLibrary';
import {
    instantiateSmartMaterial,
    isSmartMaterialAsset,
    readSmartMaterial,
    saveSmartMaterial,
    smartMaskGraph,
    smartMaterialFrom,
    smartMaterialGraph,
    type SmartMaterialStore,
} from '../../texturing/paint/smartMaterials';

const document = createPaintDocument('model', ['Body'], 9);
const resolve: GraphResolver = (id) => BUILTIN_GRAPHS.get(id);

/** A folder with what travels (a fill under a smart mask, a filter) and what does not (a paint layer, a painted mask, the set's own pictures). */
const mixedFolder = (): PaintLayer => {
    const painted = { ...newPaintLayer(document, 'Strokes'), pictures: { baseColor: { '1001': { assetId: 'stroke-picture' } } } };
    const worn = {
        ...newFillLayer(document, 'Paint', { baseColor: { kind: 'value', value: [0.3, 0.4, 0.2] } }),
        mask: [...generatorEffect('builtin:edgeWear', { amount: 0.4 }), { id: 'mask-paint', kind: 'paint', enabled: true, blend: 'multiply', opacity: 1, value: 0, pictures: { '1001': { assetId: 'mask-picture' } } }],
    } as PaintLayer;
    const before = newFillLayer(document, 'What it wears now', { baseColor: { kind: 'current' }, roughness: { kind: 'value', value: [0.7, 0.7, 0.7] } });
    return newFolder('Worn paint', [painted, worn, before, newFilterLayer(document, 'blur')]);
};

const memoryStore = () => {
    const assets = new Map<string, MaterialAsset>();
    const store: SmartMaterialStore & { assets: typeof assets } = {
        assets,
        upsert: vi.fn((asset: MaterialAsset) => { assets.set(asset.id, asset); }),
        remove: vi.fn((id: string) => { assets.delete(id); }),
        persist: vi.fn(async () => undefined),
    };
    return store;
};

describe('saving smart materials', () => {
    it('keeps what travels and counts what belongs to the texture set', () => {
        const folder = mixedFolder();
        const { layer, leftOut } = smartMaterialFrom(folder);
        expect(leftOut).toEqual({ paintLayers: 1, paintedMasks: 1, ownPictures: 1 });
        expect(layer?.kind).toBe('folder');
        const inner = layer!.layers!;
        expect(inner.map((item) => item.kind)).toEqual(['fill', 'fill', 'filter']);
        expect(inner[0].mask?.map((effect) => effect.kind)).toEqual(['generator']);
        expect(Object.keys(inner[1].channels)).toEqual(['roughness']);
        expect(inner[1].fill?.baseColor).toBeUndefined();
        expect(JSON.stringify(layer)).not.toMatch(/stroke-picture|mask-picture/);
        // The layer itself is left as it was.
        expect(folder.layers![1].mask).toHaveLength(2);
    });

    it('keeps nothing of a lone paint layer', () => {
        expect(smartMaterialFrom(newPaintLayer(document)).layer).toBeNull();
    });

    it('saves into the project as an asset never taken for a painted set', async () => {
        const store = memoryStore();
        const { asset, leftOut } = await saveSmartMaterial(mixedFolder(), '  Chipped paint  ', store);
        expect(leftOut.paintLayers).toBe(1);
        expect(asset.name).toBe('Chipped paint');
        expect(store.upsert).toHaveBeenCalledWith(asset);
        expect(store.persist).toHaveBeenCalledWith(asset);
        expect(isSmartMaterialAsset(asset)).toBe(true);
        expect(readPaintDocument(asset.paint)).toBeNull();
        const saved = readSmartMaterial(structuredClone(asset.paint));
        expect(saved?.layer.name).toBe('Chipped paint');
        expect(allLayers(saved!.layer.layers ?? []).map((item) => item.name)).toEqual(['Paint', 'What it wears now', 'Blur']);
        expect(isSmartMaterialAsset({ paint: { modelId: 'model', layers: [] } })).toBe(false);
    });

    it('takes the asset back out when the project will not keep it', async () => {
        const store = memoryStore();
        store.persist = vi.fn(async () => { throw new Error('No project is open.'); });
        await expect(saveSmartMaterial(mixedFolder(), 'Chipped', store)).rejects.toThrow('No project is open.');
        expect(store.remove).toHaveBeenCalledTimes(1);
        expect(store.assets.size).toBe(0);
    });

    it('saves nothing when nothing can be kept', async () => {
        const store = memoryStore();
        await expect(saveSmartMaterial(newPaintLayer(document), 'Strokes', store)).rejects.toThrow(/paint layers and painted masks/);
        expect(store.upsert).not.toHaveBeenCalled();
    });

    it('puts a saved one to use with fresh ids and only the channels the set has', () => {
        const { layer } = smartMaterialFrom(mixedFolder());
        const narrow = { ...document, channels: ['baseColor', 'normal'] as typeof document.channels };
        const first = instantiateSmartMaterial(layer!, narrow, 'Chipped');
        const second = instantiateSmartMaterial(layer!, narrow, 'Chipped');
        const ids = (item: PaintLayer) => [item, ...allLayers(item.layers ?? [])].flatMap((inner) => [inner.id, ...(inner.mask ?? []).map((effect) => effect.id)]);
        const all = [...ids(layer!), ...ids(first), ...ids(second)];
        expect(new Set(all).size).toBe(all.length);
        expect(first.name).toBe('Chipped');
        expect(first.from).toBe('Chipped');
        for (const item of allLayers(first.layers ?? [])) {
            for (const channel of Object.keys(item.channels)) expect(narrow.channels).toContain(channel);
            for (const channel of Object.keys(item.fill ?? {})) expect(narrow.channels).toContain(channel);
        }
    });
});

describe('smart materials as texture graphs', () => {
    it('builds a graph with an output for every channel, every wire joining real nodes', () => {
        for (const material of SMART_MATERIALS) {
            const graph = smartMaterialGraph(material.build(document), resolve);
            const ids = new Set(graph.nodes.map((node) => node.id));
            for (const link of graph.links) {
                expect(ids.has(link.from)).toBe(true);
                expect(ids.has(link.to)).toBe(true);
            }
            const outputs = graph.nodes.filter((node) => node.type === 'output').map((node) => node.params.channel);
            expect(outputs).toContain('baseColor');
            expect(new Set(outputs).size).toBe(outputs.length);
            expect(unknownNodeTypes(graph)).toEqual([]);
            // Every output is fed.
            for (const node of graph.nodes.filter((candidate) => candidate.type === 'output')) expect(graph.links.some((link) => link.to === node.id)).toBe(true);
            const names = graph.parameters.map((parameter) => parameter.name);
            expect(new Set(names).size).toBe(names.length);
        }
    });

    it('carries a smart mask\'s settings into the copy\'s parameters', () => {
        const worn = { ...newFillLayer(document, 'Paint', { baseColor: { kind: 'value', value: [0.3, 0.4, 0.2] } }), mask: generatorEffect('builtin:edgeWear', { amount: 0.3 }) };
        const graph = smartMaterialGraph(worn, resolve);
        const wear = graph.parameters.find((parameter) => parameter.name === 'amount');
        expect(wear?.default).toBe(0.3);
        expect(wear?.label).toBe('Paint: Wear');
        const mask = smartMaskGraph(BUILTIN_GRAPHS.get('builtin:edgeWear')!.graph, { amount: 0.8 });
        expect(mask.parameters.find((parameter) => parameter.name === 'amount')?.default).toBe(0.8);
        expect(BUILTIN_GRAPHS.get('builtin:edgeWear')!.graph.parameters.find((parameter) => parameter.name === 'amount')?.default).toBe(0.55);
    });
});

describe('painting with a material', () => {
    it('adds the material under a black painted mask, last in its mask', () => {
        const base = { ...document, layers: [newFillLayer(document, 'Base')] };
        const masked = { ...presetLayer(base, MATERIAL_PRESETS[0]), mask: generatorEffect('builtin:dust') };
        const made = paintWithMaterial(base, masked, base.layers[0].id);
        expect(made.document.layers.map((item) => item.id)).toEqual([base.layers[0].id, made.layerId]);
        const added = made.document.layers[1];
        const last = added.mask![added.mask!.length - 1];
        expect(last).toMatchObject({ id: made.effectId, kind: 'paint', blend: 'multiply', value: 0, enabled: true });
        expect(added.mask!.slice(0, -1).map((effect) => effect.kind)).toEqual(['generator']);
    });

    it('lays a preset on only the channels the set has', () => {
        const noMetal = { ...document, channels: ['baseColor', 'roughness', 'height'] as typeof document.channels };
        const steel = presetLayer(noMetal, MATERIAL_PRESETS.find((preset) => preset.id === 'steel')!);
        expect(Object.keys(steel.channels).sort()).toEqual(['baseColor', 'roughness']);
        expect(steel.fill?.roughness?.kind).toBe('graph');
        const mud = presetLayer(noMetal, MATERIAL_PRESETS.find((preset) => preset.id === 'mud')!);
        expect(Object.keys(mud.channels).sort()).toEqual(['baseColor', 'height', 'roughness']);
    });
});
