import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_ASSET_BUDGET_BYTES, LevelAssetResidency, objectMemoryBytes } from '../../runtime/assetResidency';
import { createLevelAssetIndex, everyAssetIn } from '../../runtime/levelAssets';
import type { AssetSelection, GameContentLoader } from '../../utils/projectHydration';
import type { LevelAssetNeeds } from '../../runtime/levelAssets';
import { distanceToCell, nextActiveCells, partitionIntoCells, resolveWorldGridSettings, worldGridSettingsOf } from '../../runtime/worldGrid';
import type { LevelObject } from '../../types';

const prop = (id: string, levelId: string, modelId: string, extra: object = {}) => ({ id, levelId, modelId, name: id, type: 'prop', ...extra });

const domains = () => ({
    levels: [
        { id: 'a', name: 'Level A', blueprint: { nodes: [{ id: 'n', values: { level: 'b' } }] } },
        { id: 'b', name: 'Level B', blueprint: { nodes: [] } },
        { id: 'c', name: 'Level C', blueprint: { nodes: [] } },
    ],
    objects: [
        prop('o1', 'a', 'rock'),
        prop('o2', 'b', 'tree'),
        prop('o3', 'c', 'crate'),
    ],
    models: [
        { id: 'rock', name: 'Rock.fbx', assetId: 'x', category: 'Prop', textureOverrides: { body: 'rock-paint' } },
        { id: 'tree', name: 'Tree.fbx', assetId: 'x', category: 'Foliage' },
        { id: 'crate', name: 'Crate.fbx', assetId: 'x', category: 'Prop' },
        { id: 'hero', name: 'Hero.fbx', assetId: 'x', category: 'Character' },
        { id: 'villain', name: 'Villain.fbx', assetId: 'x', category: 'Character', clipNames: ['Villain Wave'] },
        { id: 'runs', name: 'Runs.fbx', assetId: 'x', category: 'Animation' },
        { id: 'gun', name: 'Gun.fbx', assetId: 'x', category: 'Prop' },
    ],
    textures: [{ id: 'rock-paint', name: 'rock paint', assetId: 'x' }, { id: 'unused', name: 'unused', assetId: 'x' }],
    audio: [{ id: 'bang', name: 'Bang', assetId: 'x' }, { id: 'hum', name: 'Hum', assetId: 'x' }],
    attachments: [{ id: 'hat', name: 'Hat', assetId: 'x', parentModelId: 'hero' }, { id: 'rock-moss', name: 'Moss', assetId: 'x', parentModelId: 'rock' }],
    blueprints: [
        { id: 'player', name: 'Player', type: 'Player Character', linkedModelId: 'hero' },
        { id: 'enemy', name: 'Enemy', type: 'Enemy Controller', linkedModelId: 'hero' },
        { id: 'second-enemy', name: 'Second', type: 'Enemy Controller', linkedModelId: 'gun' },
    ],
    prefabs: [{ id: 'barrel-kit', name: 'Barrels', objects: [{ id: 'p1', modelId: 'crate' }] }],
    metadata: [],
    hud: [],
});

describe('what a level needs', () => {
    it('is its own objects\' models, what they name, and what every level plays with', () => {
        const needs = createLevelAssetIndex(domains()).needsOf('a');
        expect([...needs.models].sort()).toEqual(['hero', 'rock', 'runs']);
        expect([...needs.textures]).toEqual(['rock-paint']);
        expect([...needs.attachments].sort()).toEqual(['hat', 'rock-moss']);
        expect([...needs.levels]).toEqual(['a']);
    });

    it('leaves out other levels\' assets, even a level it can open', () => {
        const needs = createLevelAssetIndex(domains()).needsOf('a');
        expect(needs.models.has('tree')).toBe(false);
        expect(needs.levels.has('b')).toBe(false);
    });

    it('includes the levels its Level Streaming volumes bring in, and what those stream in turn', () => {
        const project = domains();
        project.objects.push(prop('v1', 'a', '', { components: [{ id: 'c1', type: 'levelStreaming', enabled: true, props: { levelId: 'b' } }] }));
        project.objects.push(prop('v2', 'b', '', { components: [{ id: 'c2', type: 'levelStreaming', enabled: true, props: { levelId: 'c' } }] }));
        const needs = createLevelAssetIndex(project).needsOf('a');
        expect([...needs.levels].sort()).toEqual(['a', 'b', 'c']);
        expect(needs.models.has('tree')).toBe(true);
        expect(needs.models.has('crate')).toBe(true);
    });

    it('follows a prefab named by a spawn node to its models', () => {
        const project = domains();
        project.levels[1].blueprint.nodes.push({ id: 'spawn', values: { prefab: 'barrel-kit' } } as never);
        expect(createLevelAssetIndex(project).needsOf('b').models.has('crate')).toBe(true);
    });

    it('reads names out of a script\'s source', () => {
        const project = domains();
        project.objects.push(prop('s1', 'b', '', { components: [{ id: 'c3', type: 'script', enabled: true, props: { source: 'audio.play("Bang");\nspawn(\'Gun\');' } }] }));
        const needs = createLevelAssetIndex(project).needsOf('b');
        expect(needs.audio.has('bang')).toBe(true);
        expect(needs.audio.has('hum')).toBe(false);
        expect(needs.models.has('gun')).toBe(true);
    });

    it('brings the model that holds a clip named in a level', () => {
        const project = domains();
        project.objects.push(prop('t1', 'b', '', { components: [{ id: 'c4', type: 'timeline', enabled: true, props: { clip: 'Villain Wave' } }] }));
        expect(createLevelAssetIndex(project).needsOf('b').models.has('villain')).toBe(true);
    });

    it('brings the models of its painted foliage and of its terrain\'s grass, with a World Grid as without', () => {
        for (const grid of [false, true]) {
            const project = domains();
            project.models.push({ id: 'fern', name: 'Fern.fbx', assetId: 'x', category: 'Foliage' }, { id: 'clover', name: 'Clover.fbx', assetId: 'x', category: 'Foliage' });
            project.objects.push(
                { id: 'set', levelId: 'b', name: 'Foliage', type: 'foliage_set', modelId: '', foliageData: { types: [{ id: 'ferns', modelId: 'fern', instancemap: { assetId: 'y', count: 10 } }] } } as never,
                { id: 'ground', levelId: 'b', name: 'Ground', type: 'terrain', modelId: '', terrainData: { textureLayers: [{ id: 'meadow', grass: [{ modelId: 'clover', density: 1 }] }] } } as never,
            );
            if (grid) project.objects.push(prop('grid', 'b', '', { components: [{ id: 'g', type: 'worldGrid', enabled: true, props: {} }] }));
            const needs = createLevelAssetIndex(project).needsOf('b');
            expect(needs.models.has('fern')).toBe(true);
            expect(needs.models.has('clover')).toBe(true);
            // A tree standing on its own is the grid's to ask for, when its cell comes near.
            expect(needs.models.has('tree')).toBe(!grid);
        }
    });

    it('uses the character the game settings name', () => {
        const project = domains();
        project.metadata.push({ id: 'game-settings', settings: { playerBlueprintId: 'second-enemy' } } as never);
        expect(createLevelAssetIndex(project).needsOf('a').models.has('gun')).toBe(true);
    });

    it('survives references that go round in a circle', () => {
        const project = domains();
        project.prefabs.push({ id: 'left', name: 'Left', objects: [{ id: 'l', ref: 'right' }] } as never, { id: 'right', name: 'Right', objects: [{ id: 'r', ref: 'left' }] } as never);
        project.levels[1].blueprint.nodes.push({ id: 'spawn', values: { prefab: 'left' } } as never);
        expect(() => createLevelAssetIndex(project).needsOf('b')).not.toThrow();
    });

    it('reads an id that says what it is first, as a particle sprite\'s does', () => {
        const project = domains();
        project.objects.push(prop('f1', 'b', '', { components: [{ id: 'c5', type: 'particles', enabled: true, props: { effect: { render: { sprite: 'texture:unused' } } } }] }));
        expect(createLevelAssetIndex(project).needsOf('b').textures.has('unused')).toBe(true);
    });

    it('brings the model that holds a mirrored clip, under the name the mirrored copy gets', () => {
        const project = domains();
        (project.models[1] as Record<string, unknown>).mirroredClips = ['Sway'];
        project.objects.push(prop('t2', 'c', '', { components: [{ id: 'c6', type: 'timeline', enabled: true, props: { clip: 'Sway (Mirrored)' } }] }));
        expect(createLevelAssetIndex(project).needsOf('c').models.has('tree')).toBe(true);
    });

    it('brings every model holding a clip of that name, since the first in the project wins', () => {
        const project = domains();
        (project.models[0] as Record<string, unknown>).clipNames = ['Wave'];
        (project.models[6] as Record<string, unknown>).clipNames = ['Wave'];
        project.objects.push(prop('t3', 'c', '', { components: [{ id: 'c7', type: 'timeline', enabled: true, props: { clip: 'Wave' } }] }));
        const needs = createLevelAssetIndex(project).needsOf('c');
        expect(needs.models.has('rock')).toBe(true);
        expect(needs.models.has('gun')).toBe(true);
    });

    it('counts a character whose clips are not recorded as needed everywhere, as they may hold any clip', () => {
        const needs = createLevelAssetIndex(domains()).needsOf('c');
        // Hero records nothing and Villain records its clips, which this level does not name.
        expect(needs.models.has('hero')).toBe(true);
        expect(needs.models.has('villain')).toBe(false);
    });

    it('lists the whole project for a game that loads it all', () => {
        const everything = everyAssetIn(domains());
        expect(everything.models.size).toBe(7);
        expect([...everything.levels].sort()).toEqual(['a', 'b', 'c']);
    });

    it('still gives an unknown level what every level plays with', () => {
        const needs = createLevelAssetIndex(domains()).needsOf('missing');
        expect(needs.models.has('hero')).toBe(true);
        expect(needs.levels.size).toBe(0);
    });
});

const MB = 1024 * 1024;

const meshOf = (bytes: number): THREE.Object3D => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bytes / 4), 3));
    return new THREE.Mesh(geometry);
};

/** A loader that keeps lists as the real one does, and records what it was told to free. */
const fakeLoader = (bytesOf: (id: string) => number) => {
    const models: { id: string; object: THREE.Object3D }[] = [];
    const released: string[] = [];
    const loads: string[][] = [];
    const loader = {
        load: async (selection?: AssetSelection) => {
            const fresh = [...(selection?.models ?? [])].filter(id => !models.some(model => model.id === id));
            loads.push(fresh);
            for (const id of fresh) models.push({ id, object: meshOf(bytesOf(id)) });
        },
        release: (selection: AssetSelection) => {
            for (const id of selection.models ?? []) {
                released.push(id);
                models.splice(models.findIndex(model => model.id === id), 1);
            }
        },
        releaseAll: () => undefined,
        content: () => ({ models: [...models], attachments: [], textures: [], audioAssets: [], blueprints: [], sockets: [] }),
        objects: () => [],
        refusedModels: () => [],
    } as unknown as GameContentLoader;
    return { loader, models, released, loads };
};

const needing = (...ids: string[]): LevelAssetNeeds => ({ models: new Set(ids), textures: new Set(), audio: new Set(), attachments: new Set(), levels: new Set() });
const LEVELS: Record<string, LevelAssetNeeds> = { a: needing('rock', 'hero'), b: needing('tree', 'hero'), c: needing('crate', 'hero') };

describe('a level with a World Grid', () => {
    const gridded = () => {
        const project = domains();
        project.objects.push(prop('g', 'a', '', { components: [{ id: 'grid', type: 'worldGrid', enabled: true, props: {} }] }));
        return project;
    };

    it('leaves plain props to the grid, which asks for them as it goes', () => {
        const needs = createLevelAssetIndex(gridded()).needsOf('a');
        expect(needs.models.has('rock')).toBe(false);
        expect(needs.levels.has('a')).toBe(true);
    });

    it('still needs a plain prop\'s model when something else names it', () => {
        const project = gridded();
        project.prefabs.push({ id: 'rock-kit', name: 'Rocks', objects: [{ id: 'p', modelId: 'rock' }] });
        project.levels[0].blueprint.nodes.push({ id: 'spawn', values: { prefab: 'rock-kit' } } as never);
        expect(createLevelAssetIndex(project).needsOf('a').models.has('rock')).toBe(true);
    });

    it('needs the models of objects drawn another way: with components, parents, children or moved by a timeline', () => {
        const project = gridded();
        project.objects.push(prop('w1', 'a', 'tree', { components: [{ id: 'm', type: 'mover', enabled: true, props: {} }] }));
        project.objects.push(prop('w2', 'a', 'crate', { parentId: 'o1' }));
        project.objects.push(prop('w3', 'a', 'gun'));
        project.objects.push(prop('w4', 'a', '', { components: [{ id: 't', type: 'timeline', enabled: true, props: { timeline: { duration: 1, tracks: [{ id: 'tr', kind: 'transform', targetId: 'w3', keys: [] }] } } }] }));
        const needs = createLevelAssetIndex(project).needsOf('a');
        expect(needs.models.has('tree')).toBe(true);
        expect(needs.models.has('crate')).toBe(true);
        expect(needs.models.has('rock')).toBe(true);
    });

    it('loads all of a gridded level that another level streams in', () => {
        const project = gridded();
        project.objects.push(prop('v', 'b', '', { components: [{ id: 's', type: 'levelStreaming', enabled: true, props: { levelId: 'a' } }] }));
        expect(createLevelAssetIndex(project).needsOf('b').models.has('rock')).toBe(true);
    });

    it('names what a model the grid asks for needs: its textures and attachments', () => {
        const needs = createLevelAssetIndex(gridded()).needsOfModels(['rock']);
        expect([...needs.models]).toEqual(['rock']);
        expect([...needs.textures]).toEqual(['rock-paint']);
        expect([...needs.attachments]).toEqual(['rock-moss']);
    });
});

describe('the grid\'s cells', () => {
    const SETTINGS = { cellSize: 10, loadDistance: 15, unloadDistance: 25 };
    const at = (id: string, x: number, z: number, modelId = 'rock') => ({ ...prop(id, 'a', modelId), position: [x, 0, z] }) as unknown as LevelObject;

    it('puts an object in the cell it stands in, negative coordinates too', () => {
        const cells = partitionIntoCells([at('f', 1, 1, 'tree')], [at('p', 9, 1), at('n', -1, -1)], 10);
        expect([...cells.keys()].sort()).toEqual(['-1,-1', '0,0']);
        expect(cells.get('0,0')?.foliage.length).toBe(1);
        expect(cells.get('0,0')?.props.length).toBe(1);
        expect(cells.get('0,0')?.modelIds.sort()).toEqual(['rock', 'tree']);
    });

    it('measures to the nearest edge of a cell', () => {
        expect(distanceToCell({ x: 0, z: 0 }, 5, 5, 10)).toBe(0);
        expect(distanceToCell({ x: 2, z: 0 }, 5, 5, 10)).toBe(15);
        expect(distanceToCell({ x: 1, z: 1 }, 7, 7, 10)).toBeCloseTo(Math.hypot(3, 3));
    });

    it('loads cells as they come near and keeps them until further away, so a line walked along does not flicker', () => {
        const cells = partitionIntoCells([], [at('p', 35, 5)], 10);
        const none: ReadonlySet<string> = new Set();
        expect(nextActiveCells(cells, none, 5, 5, SETTINGS).size).toBe(0);
        const near = nextActiveCells(cells, none, 20, 5, SETTINGS);
        expect(near.has('3,0')).toBe(true);
        // Past where it loads, inside where it goes: it stays, and the set is the same one, so nothing re-renders.
        expect(nextActiveCells(cells, near, 8, 5, SETTINGS)).toBe(near);
        expect(nextActiveCells(cells, near, 0, 5, SETTINGS).size).toBe(0);
    });

    it('always keeps a cell a little past where it loads, whatever the settings say', () => {
        const settings = resolveWorldGridSettings({ props: { cellSize: 1, loadDistance: 100, unloadDistance: 50 } });
        expect(settings.cellSize).toBeGreaterThanOrEqual(4);
        expect(settings.unloadDistance).toBeGreaterThan(settings.loadDistance);
    });

    it('finds a level\'s grid only when it is enabled', () => {
        const objects = [{ components: [{ id: 'x', type: 'worldGrid', enabled: false, props: {} }] }] as never;
        expect(worldGridSettingsOf(objects)).toBeNull();
    });
});

describe('assets in memory', () => {
    it('never frees what the running level needs or the cells in play draw, to load more for the grid', async () => {
        const fake = fakeLoader(() => 40 * MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 40 * MB, 130 * MB);
        await residency.prepare('a');
        await residency.requestCellModels(needing('tree'));
        residency.setCellsInUse(new Set(['tree']));
        const loaded = await residency.requestCellModels(needing('crate'));
        expect(fake.released).toEqual([]);
        expect(loaded.map(model => model.id).sort()).toEqual(['crate', 'tree']);
        residency.setCellsInUse(new Set(['crate']));
        await residency.requestCellModels(needing('gun'));
        expect(fake.released).toEqual(['tree']);
    });

    it('drops what a grid asked for once its level has ended, so the next level is not held up', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, 100 * MB);
        await residency.prepare('a');
        const first = residency.requestCellModels(needing('crate'));
        const stale = residency.requestCellModels(needing('gun'));
        const next = residency.prepare('b');
        await Promise.all([first, stale, next]);
        const loaded = fake.loads.flat();
        expect(loaded).not.toContain('crate');
        expect(loaded).not.toContain('gun');
        expect(loaded).toContain('tree');
    });

    it('skips a model the camera has moved on from before its turn came', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, 100 * MB);
        await residency.prepare('a');
        residency.setCellsInUse(new Set(['gun']));
        await residency.requestCellModels(needing('crate'), () => residency.cellInUse('crate'));
        await residency.requestCellModels(needing('gun'), () => residency.cellInUse('gun'));
        expect(fake.models.map(model => model.id)).not.toContain('crate');
        expect(fake.models.map(model => model.id)).toContain('gun');
    });

    it('answers a grid with only the models it asked for and still has', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, 100 * MB);
        await residency.prepare('a');
        const loaded = await residency.requestCellModels(needing('crate'));
        expect(loaded.map(model => model.id)).toEqual(['crate']);
    });

    it('loads a level\'s assets once, and starting it again needs nothing', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, DEFAULT_ASSET_BUDGET_BYTES);
        expect(residency.holds('a')).toBe(false);
        await residency.prepare('a');
        expect(residency.holds('a')).toBe(true);
        await residency.prepare('a');
        expect(fake.loads[1]).toEqual([]);
    });

    it('keeps an earlier level\'s assets while there is room, so going back is quick', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, 100 * MB);
        await residency.prepare('a');
        await residency.prepare('b');
        expect(fake.released).toEqual([]);
        expect(residency.holds('a')).toBe(true);
    });

    it('reactivates A from cache without loading, pins its assets, and drops B grid work', async () => {
        const fake = fakeLoader(() => 40 * MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 40 * MB, 130 * MB);
        await residency.prepare('a');
        await residency.prepare('b');
        expect(residency.holds('a')).toBe(true);
        const loadsBefore = fake.loads.length;
        const stale = residency.requestCellModels(needing('gun'));
        residency.activateCached('a');
        await stale;
        expect(fake.loads.length).toBe(loadsBefore);
        expect(fake.models.some(model => model.id === 'gun')).toBe(false);

        await residency.requestCellModels(needing('crate'));
        expect(fake.released).toEqual(['tree']);
        expect(fake.models.map(model => model.id).sort()).toEqual(['crate', 'hero', 'rock']);
        expect(residency.holds('a')).toBe(true);
    });

    it('frees what was used longest ago to stay in budget, and never what the level needs', async () => {
        const fake = fakeLoader(() => 40 * MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 40 * MB, 130 * MB);
        await residency.prepare('a');
        await residency.prepare('b');
        await residency.prepare('c');
        expect(fake.released).toEqual(['rock']);
        expect(fake.models.map(model => model.id).sort()).toEqual(['crate', 'hero', 'tree']);
        expect(residency.holds('a')).toBe(false);
        expect(residency.holds('b')).toBe(true);
    });

    it('frees before it loads, so the old and the new are not in memory together', async () => {
        const fake = fakeLoader(() => 60 * MB);
        const order: string[] = [];
        const { load, release } = fake.loader;
        fake.loader.load = async (selection) => { order.push('load'); await load(selection); };
        fake.loader.release = (selection) => { order.push('release'); release(selection); };
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 60 * MB, 100 * MB);
        await residency.prepare('a');
        order.length = 0;
        await residency.prepare('b');
        expect(order).toEqual(['release', 'load']);
    });

    it('learns what models really take from their files, and frees for that, not for the files alone', async () => {
        // Each file is 10 MB, each loaded model 40 MB: going by files would leave the old level in memory.
        const fake = fakeLoader(() => 40 * MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 10 * MB, 100 * MB);
        await residency.prepare('a');
        await residency.prepare('b');
        expect(fake.released).toEqual(['rock']);
        expect(residency.heldBytes()).toBeLessThanOrEqual(100 * MB);
    });

    it('guesses models grow before any has been measured, as the first level may be followed by nothing else', async () => {
        const fake = fakeLoader(() => 40 * MB);
        const residency = new LevelAssetResidency(fake.loader, () => needing('crate'), () => 10 * MB, 100 * MB);
        await residency.requestCellModels(needing('tree', 'hero'));
        residency.setCellsInUse(new Set());
        // 80 MB held and one more model of about 40: something has to go, though by its file alone it would fit.
        await residency.prepare('c');
        expect(fake.released.length).toBeGreaterThan(0);
    });

    it('still gives a level everything it needs when that alone is past the budget', async () => {
        const fake = fakeLoader(() => 500 * MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => 500 * MB, 100 * MB);
        await residency.prepare('a');
        expect(fake.released).toEqual([]);
        expect(residency.holds('a')).toBe(true);
    });

    it('runs one level at a time', async () => {
        const fake = fakeLoader(() => MB);
        const residency = new LevelAssetResidency(fake.loader, id => LEVELS[id], () => MB, 100 * MB);
        await Promise.all([residency.prepare('a'), residency.prepare('b')]);
        expect(fake.loads).toEqual([['rock', 'hero'], ['tree']]);
    });

    it('counts a shared buffer once', () => {
        const group = new THREE.Group();
        const mesh = meshOf(MB) as THREE.Mesh;
        group.add(mesh, new THREE.Mesh(mesh.geometry));
        expect(objectMemoryBytes(group)).toBe(MB);
    });
});
