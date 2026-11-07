import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GRAPH_SEED, MaterialCookPlanner, PICTURE_SIZE, cookRequestFor, cookSignature, cookedTextureId, steppedPictureSize, type CookCache, type CookedPictures } from '../../runtime/materials/materialCooking';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { surfaceGraphForPictures } from '../../texturing/materialOutput';
import { setObjectMaterialValue, releaseSessionMaterials } from '../../utils/materialInstances';

/** A material whose pictures a texture graph makes, with a Wetness parameter. */
const crate = (): MaterialAsset => ({
    id: 'crate',
    name: 'Crate wood',
    graph: surfaceGraphForPictures({ baseColor: true }),
    pictures: { baseColor: 'baked-colour' },
    textureGraph: { graph: { nodes: [{ id: 'n', type: 'noise', params: {} }], links: [], size: { w: 10, h: 10 }, parameters: [{ name: 'Wetness', kind: 'float' }] }, values: { Wetness: 0 }, bakeSize: 10, layout: 'engine' },
});

const host = () => ({ addTextureUrl: vi.fn(), releaseTexture: vi.fn(), rebindAsset: vi.fn() });

const plannerWith = (cache: CookCache | null = null, fail = false, on: ReturnType<typeof host> | typeof materialLibrary = host()) => {
    const cooks: Array<{ values: Record<string, unknown>; seed?: number; sizeLog2?: number }> = [];
    const library = on as ReturnType<typeof host>;
    let urls = 0;
    const letGo = vi.fn();
    const planner = new MaterialCookPlanner(library, {
        cook: async (request) => {
            cooks.push({ values: { ...request.values }, seed: request.seed, sizeLog2: request.sizeLog2 });
            if (fail) throw new Error('no GPU');
            return { baseColor: new Blob(['colour']), orm: new Blob(['orm']) };
        },
    }, cache, { nextFrame: (task) => setTimeout(task, 0), urlOf: () => `blob:${++urls}`, letGo });
    return { planner, cooks, library, letGo };
};

afterEach(() => {
    materialLibrary.setPictureSource(null);
    materialLibrary.replaceAll([]);
});

describe('texture graphs cooked by the game', () => {
    it('ask for what a use sets: its graph values, seed and picture size', () => {
        const request = cookRequestFor(crate(), { Wetness: 0.7, Tint: [1, 0, 0], [GRAPH_SEED]: 4.2, [PICTURE_SIZE]: 12 });
        expect(request.values).toEqual({ Wetness: 0.7 });
        expect(request.seed).toBe(4);
        // No larger than the pictures it bakes.
        expect(request.sizeLog2).toBe(10);
        const same = cookSignature(cookRequestFor(crate(), { Wetness: 0.7, [GRAPH_SEED]: 4 }));
        expect(cookSignature(cookRequestFor(crate(), { [GRAPH_SEED]: 4, Wetness: 0.7, [PICTURE_SIZE]: 10 }))).toBe(same);
        expect(cookSignature(cookRequestFor(crate(), { Wetness: 0.7, [GRAPH_SEED]: 5 }))).not.toBe(same);
        expect(cookSignature(cookRequestFor(crate(), { Wetness: 0.8, [GRAPH_SEED]: 4 }))).not.toBe(same);
    });

    it('cook one set for uses asking alike, one at a time, the baked pictures drawn until it is ready', async () => {
        const { planner, cooks, library } = plannerWith();
        const asset = crate();
        const [a, b, c] = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
        expect(planner.pictures(asset, { parameters: { [GRAPH_SEED]: 1 } }, a)).toBeUndefined();
        expect(planner.pictures(asset, { parameters: { [GRAPH_SEED]: 1 } }, b)).toBeUndefined();
        expect(planner.pictures(asset, { parameters: { [GRAPH_SEED]: 2 } }, c)).toBeUndefined();
        await planner.settled();
        expect(cooks.map(cook => cook.seed)).toEqual([1, 2]);
        expect(library.rebindAsset).toHaveBeenCalledWith('crate');
        const key = cookSignature(cookRequestFor(asset, { [GRAPH_SEED]: 1 }));
        expect(library.addTextureUrl).toHaveBeenCalledWith(cookedTextureId(key, 'baseColor'), expect.stringMatching(/^blob:/));
        // Ready: the cooked pictures take the baked ones' place, any it did not cook kept.
        expect(planner.pictures(asset, { parameters: { [GRAPH_SEED]: 1 } }, a)).toEqual({ baseColor: cookedTextureId(key, 'baseColor'), orm: cookedTextureId(key, 'orm') });
        expect(planner.heldSets).toBe(2);
    });

    it('let a set go once no use wears it', async () => {
        const { planner, library, letGo } = plannerWith();
        const asset = crate();
        const [a, b] = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
        planner.pictures(asset, { parameters: { Wetness: 1 } }, a);
        planner.pictures(asset, { parameters: { Wetness: 1 } }, b);
        await planner.settled();
        planner.release(a);
        expect(library.releaseTexture).not.toHaveBeenCalled();
        // b moves to another value: the first set goes.
        planner.pictures(asset, { parameters: { Wetness: 0.5 } }, b);
        expect(library.releaseTexture).toHaveBeenCalledTimes(2);
        expect(letGo).toHaveBeenCalledTimes(2);
    });

    it('load a set kept from an earlier run instead of cooking it again', async () => {
        const kept = new Map<string, CookedPictures>();
        const cache: CookCache = { get: async (key) => kept.get(key) ?? null, put: async (key, pictures) => { kept.set(key, pictures); } };
        const first = plannerWith(cache);
        first.planner.pictures(crate(), { parameters: { [GRAPH_SEED]: 9 } }, new THREE.MeshStandardMaterial());
        await first.planner.settled();
        await Promise.resolve();
        expect(kept.size).toBe(1);
        const again = plannerWith(cache);
        again.planner.pictures(crate(), { parameters: { [GRAPH_SEED]: 9 } }, new THREE.MeshStandardMaterial());
        await again.planner.settled();
        expect(again.cooks).toEqual([]);
        expect(again.library.rebindAsset).toHaveBeenCalledWith('crate');
    });

    it('keep the baked pictures when a cook fails, without trying again', async () => {
        const { planner, cooks } = plannerWith(null, true);
        const material = new THREE.MeshStandardMaterial();
        planner.pictures(crate(), { parameters: {} }, material);
        await planner.settled();
        expect(planner.pictures(crate(), { parameters: {} }, material)).toBeUndefined();
        await planner.settled();
        expect(cooks).toHaveLength(1);
    });

    it('step the picture size with how large it shows, without flickering at a boundary', () => {
        expect(steppedPictureSize(undefined, 300, 7, 11)).toBe(9);
        // Up at once, down only once it shows at a quarter.
        expect(steppedPictureSize(9, 600, 7, 11)).toBe(10);
        expect(steppedPictureSize(10, 400, 7, 11)).toBe(10);
        expect(steppedPictureSize(10, 200, 7, 11)).toBe(9);
        expect(steppedPictureSize(10, 1, 7, 11)).toBe(8);
        expect(steppedPictureSize(11, 99999, 7, 11)).toBe(11);
    });

    it('draw a use with its cooked pictures through the material library, and a seed set during play cooks its own', async () => {
        const { planner } = plannerWith(null, false, materialLibrary);
        materialLibrary.replaceAll([crate()]);
        materialLibrary.setPictureSource(planner);
        const material = new THREE.MeshStandardMaterial();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
        const root = new THREE.Group().add(mesh);
        materialLibrary.assign(material, 'crate');
        const picture = () => boundMaterialGraph(mesh.material as THREE.Material)!.nodes.find(node => node.params.output === 'baseColor')?.params.texture;
        expect(picture()).toBe('baked-colour');
        await planner.settled();
        expect(String(picture())).toMatch(/^cooked:/);
        // A blueprint or script sets this object's seed: it gets a copy of its own, cooked for it.
        const made: THREE.Material[] = [];
        expect(setObjectMaterialValue(root, GRAPH_SEED, 7, made)).toBe(1);
        expect(materialLibrary.bindingOf(mesh.material as THREE.Material)?.parameters?.[GRAPH_SEED]).toBe(7);
        await planner.settled();
        expect(picture()).toBe(cookedTextureId(cookSignature(cookRequestFor(crate(), { [GRAPH_SEED]: 7 })), 'baseColor'));
        expect(setObjectMaterialValue(root, 'Wetness', 0.8, made)).toBe(1);
        expect(setObjectMaterialValue(root, 'Not a parameter', 1, made)).toBe(0);
        releaseSessionMaterials(made);
    });
});
