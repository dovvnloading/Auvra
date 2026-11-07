import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../texturing/mesh/picker';
import { allLayers, castsFromThreeSides, createPaintDocument, insertLayer, locateLayer, mapLayer, moveLayer, newFillLayer, newFolder, newPaintLayer, readPaintDocument } from '../../texturing/paint/paintTypes';
import { BAKE_FIX_KEYS, BEFORE, halfFloatTexture, pictureKey, pictureOwner, pictureOwners, picturePrecision } from '../../texturing/paint/paintStack';
import { encodePng16, readPng16, readPng16Half } from '../../texturing/png';
import { historyBytes, trimmedHistory, type HistoryEntry } from '../../texturing/paint/strokes';
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
        expect(stored?.before).toBeUndefined();
    });

    it('keeps what the surface wore before, carried onto its own layout tile by tile', () => {
        const stored = readPaintDocument({ modelId: 'm', materialNames: ['A'], layers: [], udim: true, before: { baseColor: { 1001: { assetId: 'a' }, 1002: { assetId: 'b' } }, emissive: { 1002: { assetId: 'c' } } } });
        expect(stored?.before?.baseColor).toEqual({ 1001: { assetId: 'a' }, 1002: { assetId: 'b' } });
        expect(stored?.before?.emissive?.['1002']).toEqual({ assetId: 'c' });
    });

    it('keeps the space 3D placement is measured in, and drops one that is not a space', () => {
        const kept = readPaintDocument({ modelId: 'm', layers: [], space: { centre: [1, 2, 3], extent: 4 } });
        expect(kept?.space).toEqual({ centre: [1, 2, 3], extent: 4 });
        expect(readPaintDocument({ modelId: 'm', layers: [], space: { centre: [1, 2], extent: 4 } })?.space).toBeUndefined();
        expect(readPaintDocument({ modelId: 'm', layers: [], space: { centre: [1, 2, 3], extent: 0 } })?.space).toBeUndefined();
        // Bakes made before versions were kept read as they are (and so as older bakes).
        expect(readPaintDocument({ modelId: 'm', layers: [], bake: { settings: {}, maps: {}, at: 1 } })?.bake?.version).toBeUndefined();
    });

    it('tells whether any fill is cast from three sides, folders included', () => {
        const document = createPaintDocument('model', ['Surface']);
        const plain = newFillLayer(document, 'Plain');
        const cast = newFillLayer(document, 'Cast', { baseColor: { kind: 'texture', textureId: 't', projection: 'triplanar', scale: 4, rotation: 0, sharpness: 4 } });
        expect(castsFromThreeSides([plain])).toBe(false);
        expect(castsFromThreeSides([plain, newFolder('Wear', [cast])])).toBe(true);
    });

    it('finds whose pictures a set and its undo steps still use', () => {
        const document = createPaintDocument('model', ['Surface']);
        const paint = { ...newPaintLayer(document, 'Scratches'), mask: [{ id: 'mask1', kind: 'paint' as const, enabled: true, blend: 'replace' as const, opacity: 1 }] };
        const owners = pictureOwners([{ ...document, layers: [newFolder('Wear', [paint])] }]);
        expect(owners.has(paint.id)).toBe(true);
        expect(owners.has('mask1')).toBe(true);
        expect(owners.has(BEFORE)).toBe(true);
        expect(pictureOwner(pictureKey(paint.id, 'height'))).toBe(paint.id);
        expect(pictureOwner(pictureKey('mask1'))).toBe('mask1');
        expect(picturePrecision(pictureKey(paint.id, 'height'))).toBe(16);
        expect(picturePrecision(pictureKey(paint.id, 'normal'))).toBe(16);
        expect(picturePrecision(pictureKey(paint.id, 'baseColor'))).toBe(8);
        expect(picturePrecision(pictureKey('mask1'))).toBe(8);
    });

    it('keeps undo within its step count and its memory, oldest first, never the newest step', () => {
        const step = (label: string, bytes: number, half = false): HistoryEntry => ({
            label,
            pixels: [{ key: 'l:baseColor', tile: 1001, rects: [{ x: 0, y: 0, width: 1, height: 1, before: half ? new Uint16Array(bytes / 2) : new Uint8Array(bytes), after: null }] }],
        });
        const past = [step('a', 40), step('b', 40, true), step('c', 40)];
        expect(historyBytes(past[1])).toBe(40);
        const labels = (entries: HistoryEntry[]) => entries.map((entry) => entry.label);
        expect(labels(trimmedHistory(past, [], 80, 1000))).toEqual(['a', 'b', 'c']);
        expect(labels(trimmedHistory(past, [], 2, 1000))).toEqual(['b', 'c']);
        expect(labels(trimmedHistory(past, [], 80, 100))).toEqual(['b', 'c']);
        // Steps that can be redone hold pixels too.
        expect(labels(trimmedHistory(past, [step('redo', 60)], 80, 100))).toEqual(['c']);
        // A step larger than the whole allowance is still kept when it is the newest.
        expect(labels(trimmedHistory([...past, step('huge', 500)], [], 80, 100))).toEqual(['huge']);
        // Steps that only change the layers hold no pixels.
        expect(labels(trimmedHistory([{ label: 'Rename layer' }, ...past], [], 80, 120))).toEqual(['Rename layer', 'a', 'b', 'c']);
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

describe('kept pictures', () => {
    it('open 16-bit pictures as half floats with the values they had, a grey one with one value a pixel', async () => {
        // The test page's Blob cannot be read as a stream; Node's can, as a browser's can.
        const pageBlob = globalThis.Blob;
        globalThis.Blob = NodeBlob as unknown as typeof Blob;
        try {
            const grey = new Uint16Array(4 * 4).map((_, i) => (i * 4099) % 65536);
            const colour = new Uint16Array(4 * 4 * 4).map((_, i) => (i * 7919) % 65536);
            for (const [samples, channels] of [[grey, 1], [colour, 4]] as const) {
                const png = await encodePng16(samples, 4, 4, channels);
                const texture = halfFloatTexture(await readPng16Half(png));
                expect(texture.type).toBe(THREE.HalfFloatType);
                expect(texture.format).toBe(channels === 1 ? THREE.RedFormat : THREE.RGBAFormat);
                const halves = texture.image.data as Uint16Array;
                const floats = (await readPng16(png)).data;
                // Half the bytes of 32-bit floats for colour; an eighth for grey (one value a pixel, not four).
                expect(halves.byteLength * (channels === 1 ? 8 : 2)).toBe(floats.byteLength);
                for (let p = 0; p < 16; p++) {
                    for (let c = 0; c < channels; c++) {
                        const was = floats[p * 4 + c];
                        expect(Math.abs(THREE.DataUtils.fromHalfFloat(halves[p * channels + c]) - was)).toBeLessThanOrEqual(was / 2048 + 1e-7);
                    }
                }
                texture.dispose();
            }
        } finally {
            globalThis.Blob = pageBlob;
        }
    });
});

describe('bake fixes', () => {
    it('are kept with the set whatever its layers, and read back from it', () => {
        const document = createPaintDocument('model', ['Surface']);
        const owners = pictureOwners([document]);
        expect(owners.has(BAKE_FIX_KEYS.skew)).toBe(true);
        expect(owners.has(BAKE_FIX_KEYS.cage)).toBe(true);
        const kept = readPaintDocument({ ...document, bakeFixes: { skew: { '1001': { assetId: 'skew-picture' } } } });
        expect(kept?.bakeFixes?.skew?.['1001'].assetId).toBe('skew-picture');
        expect(readPaintDocument(document)?.bakeFixes).toBeUndefined();
    });
});
