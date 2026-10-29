import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { fractureMesh, fractureVolume, MAX_FRACTURE_PIECES, type FractureSource } from '../../runtime/fracture';
import { DebrisWorld, DEBRIS_FADE, pieceGeometry, type DebrisPhysics } from '../../runtime/debris';
import {
    combat, destructibles, explode, explosionFalloff, provideCombat, type DestructibleHandle, type Vec3,
} from '../../runtime/destructibles';
import { impactKind } from '../../runtime/impactEffects';
import {
    cachedFracture, destructibleSource, DESTRUCTIBLE_DEFAULTS, interiorMaterial, readDestructibleSettings,
} from '../../runtime/components/destructibleComponent';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { brokenEventMatches } from '../../hooks/useLevelBlueprintRuntime';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { parseScriptCommand, scriptDestructibleStates } from '../../runtime/scripting/ScriptRuntime';
import { createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';
import type { ScriptSnapshot } from '../../runtime/scripting/protocol';
import type { LevelComponent, LogicNode } from '../../types';

vi.mock('../../components/Scripting/ScriptInspector', () => ({ ScriptInspector: () => null }));
vi.mock('../../runtime/particleSprites', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/particleSprites')>()),
    builtinSpriteTexture: () => new THREE.Texture(),
}));

const sourceOf = (geometry: THREE.BufferGeometry, slots?: (triangle: number) => number): FractureSource => {
    const count = geometry.getAttribute('position').count;
    const indices = Uint32Array.from(geometry.index ? (geometry.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i));
    const materials = new Uint16Array(indices.length / 3);
    if (slots) for (let t = 0; t < materials.length; t++) materials[t] = slots(t);
    return {
        positions: Float32Array.from(geometry.getAttribute('position').array as ArrayLike<number>),
        normals: Float32Array.from(geometry.getAttribute('normal').array as ArrayLike<number>),
        uvs: Float32Array.from(geometry.getAttribute('uv').array as ArrayLike<number>),
        indices,
        materials,
    };
};

/** Areas of a fracture's triangles: the model's own surface and the cut faces. */
const areas = (result: ReturnType<typeof fractureMesh>) => {
    let outside = 0;
    let inside = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const piece of result.pieces) {
        for (const group of piece.groups) {
            for (let v = group.start; v < group.start + group.count; v += 3) {
                a.fromArray(piece.positions, v * 3);
                b.fromArray(piece.positions, (v + 1) * 3);
                c.fromArray(piece.positions, (v + 2) * 3);
                const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
                if (group.material === result.interiorSlot) inside += area;
                else outside += area;
            }
        }
    }
    return { outside, inside };
};

describe('fracture', () => {
    it('breaks a box into pieces that fill it exactly and share out its surface', () => {
        const result = fractureMesh(sourceOf(new THREE.BoxGeometry(2, 1, 0.5)), { pieces: 16, seed: 3 });
        expect(result.pieces.length).toBe(16);
        expect(result.interiorSlot).toBe(1);
        expect(fractureVolume(result)).toBeCloseTo(1, 4);
        const { outside, inside } = areas(result);
        expect(outside).toBeCloseTo(7, 3);
        expect(inside).toBeGreaterThan(1);
        for (const piece of result.pieces) {
            expect(piece.volume).toBeGreaterThan(0);
            expect(piece.hull.length / 3).toBeGreaterThanOrEqual(4);
            expect(piece.positions.length / 3).toBe(piece.normals.length / 3);
            expect(piece.uvs.length / 2).toBe(piece.positions.length / 3);
            // About its own centre, which lies inside the box.
            expect(Math.abs(piece.centre[0])).toBeLessThanOrEqual(1);
            expect(Math.abs(piece.centre[1])).toBeLessThanOrEqual(0.5);
        }
    });

    it('keeps the round shape of a cylinder, its normals and its materials', () => {
        const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 2, 24);
        const sides = cylinder.groups[0].count / 3;
        const result = fractureMesh(sourceOf(cylinder, t => (t < sides ? 0 : 1)), { pieces: 12, seed: 5 });
        // A 24-sided prism's volume.
        expect(fractureVolume(result)).toBeCloseTo(12 * 0.25 * Math.sin((2 * Math.PI) / 24) * 2, 3);
        expect(result.interiorSlot).toBe(2);
        const slots = new Set(result.pieces.flatMap(piece => piece.groups.map(group => group.material)));
        expect([...slots].sort()).toEqual([0, 1, 2]);
        // Side normals stay horizontal and unit length.
        const piece = result.pieces.find(p => p.groups.some(g => g.material === 0))!;
        const group = piece.groups.find(g => g.material === 0)!;
        const n = new THREE.Vector3().fromArray(piece.normals, group.start * 3);
        expect(n.length()).toBeCloseTo(1);
        expect(Math.abs(n.y)).toBeLessThan(1e-4);
    });

    it('is the same for the same seed and different for another', () => {
        const box = sourceOf(new THREE.BoxGeometry(1, 1, 1));
        const a = fractureMesh(box, { pieces: 8, seed: 7 });
        const b = fractureMesh(box, { pieces: 8, seed: 7 });
        const c = fractureMesh(box, { pieces: 8, seed: 8 });
        expect(a.pieces.map(p => p.centre)).toEqual(b.pieces.map(p => p.centre));
        expect(a.pieces.map(p => p.centre)).not.toEqual(c.pieces.map(p => p.centre));
    });

    it('breaks a flat pane, keeps piece counts in range, and gives nothing for no triangles', () => {
        const pane = fractureMesh(sourceOf(new THREE.PlaneGeometry(2, 2)), { pieces: 10, seed: 2 });
        expect(pane.pieces.length).toBe(10);
        expect(areas(pane).outside).toBeCloseTo(4, 3);
        expect(fractureMesh(sourceOf(new THREE.BoxGeometry()), { pieces: 1000 }).pieces.length).toBeLessThanOrEqual(MAX_FRACTURE_PIECES);
        expect(fractureMesh(sourceOf(new THREE.BoxGeometry()), { pieces: 1 }).pieces.length).toBe(2);
        const empty: FractureSource = { positions: new Float32Array(), normals: null, uvs: null, indices: new Uint32Array(), materials: new Uint16Array() };
        expect(fractureMesh(empty, { pieces: 8 }).pieces).toEqual([]);
    });

    it('stays quick on a dense, hollow model', () => {
        const start = performance.now();
        const result = fractureMesh(sourceOf(new THREE.TorusKnotGeometry(1, 0.3, 160, 24)), { pieces: 16, seed: 1 });
        expect(result.pieces.length).toBe(16);
        expect(performance.now() - start).toBeLessThan(2000);
    });
});

describe('debris', () => {
    const stubPhysics = () => {
        const bodies = new Map<number, { position: THREE.Vector3; mass: number; velocity: Vec3; hull: Float32Array }>();
        let next = 0;
        const physics: DebrisPhysics = {
            spawn: (hull, position, _rotation, velocity, _spin, mass) => {
                const id = next++;
                bodies.set(id, { position: new THREE.Vector3(position.x, position.y, position.z), mass, velocity: { ...velocity }, hull });
                return id;
            },
            pose: (body, position) => {
                const found = bodies.get(body as number);
                if (!found) return false;
                position.copy(found.position);
                return true;
            },
            remove: body => { bodies.delete(body as number); },
        };
        return { physics, bodies };
    };

    const random = () => 0.5;

    it('puts pieces where they were in the object, scaled, weighed by volume, flying apart', () => {
        const { physics, bodies } = stubPhysics();
        const world = new DebrisWorld(physics, 600, random);
        const result = fractureMesh(sourceOf(new THREE.BoxGeometry(1, 1, 1)), { pieces: 6, seed: 4 });
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(10, 2, 0), new THREE.Quaternion(), new THREE.Vector3(2, 2, 2));
        const count = world.spawn(result, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()], matrix, {
            density: 1000, life: 5, scatter: 3, hit: null, direction: null, push: 0,
        });
        expect(count).toBe(6);
        expect(world.count).toBe(6);
        // An 8 m³ box at 1000 kg/m³.
        const total = [...bodies.values()].reduce((sum, body) => sum + body.mass, 0);
        expect(total).toBeCloseTo(8000, 0);
        for (const body of bodies.values()) {
            expect(Math.abs(body.position.x - 10)).toBeLessThanOrEqual(1);
            expect(Math.abs(body.position.y - 2)).toBeLessThanOrEqual(1);
            // Outward from the middle.
            const outward = new THREE.Vector3(body.position.x - 10, body.position.y - 2, body.position.z);
            expect(outward.dot(new THREE.Vector3(body.velocity.x, body.velocity.y, body.velocity.z))).toBeGreaterThan(0);
            for (let i = 0; i < body.hull.length; i++) expect(Math.abs(body.hull[i])).toBeLessThanOrEqual(2.0001);
        }
    });

    it('throws the pieces nearest a hit hardest, away from it', () => {
        const { physics, bodies } = stubPhysics();
        const world = new DebrisWorld(physics, 600, random);
        const result = fractureMesh(sourceOf(new THREE.BoxGeometry(4, 1, 1)), { pieces: 8, seed: 2 });
        world.spawn(result, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()], new THREE.Matrix4(), {
            density: 500, life: 0, scatter: 0, hit: { x: -2, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, push: 10,
        });
        const sorted = [...bodies.values()].sort((a, b) => a.position.x - b.position.x);
        const speed = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
        expect(speed(sorted[0].velocity)).toBeGreaterThan(speed(sorted[sorted.length - 1].velocity));
        expect(sorted[0].velocity.x).toBeGreaterThan(0);
    });

    it('shrinks pieces away after their life, keeps them without one, and drops the oldest past the cap', () => {
        const { physics, bodies } = stubPhysics();
        const world = new DebrisWorld(physics, 10, random);
        const result = fractureMesh(sourceOf(new THREE.BoxGeometry()), { pieces: 6, seed: 1 });
        const options = { density: 500, life: 1, scatter: 1, hit: null, direction: null, push: 0 };
        const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
        world.spawn(result, materials, new THREE.Matrix4(), options);
        world.spawn(result, materials, new THREE.Matrix4(), options);
        expect(world.count).toBe(10);
        expect(bodies.size).toBe(10);
        world.update(1.25);
        expect(world.object.children.some(mesh => mesh.scale.x < 1)).toBe(true);
        world.update(DEBRIS_FADE + 0.2);
        expect(world.count).toBe(0);
        expect(bodies.size).toBe(0);
        world.spawn(result, materials, new THREE.Matrix4(), { ...options, life: 0 });
        world.update(1000);
        expect(world.count).toBe(6);
        world.clear();
        expect(world.count).toBe(0);
    });

    it('bakes the scale into a piece and keeps its normals unit length', () => {
        const piece = fractureMesh(sourceOf(new THREE.BoxGeometry()), { pieces: 4, seed: 9 }).pieces[0];
        const geometry = pieceGeometry(piece, new THREE.Vector3(3, 1, 0.5));
        const position = geometry.getAttribute('position');
        expect(position.getX(0)).toBeCloseTo(piece.positions[0] * 3);
        expect(position.getZ(0)).toBeCloseTo(piece.positions[2] * 0.5);
        const normal = geometry.getAttribute('normal');
        for (let i = 0; i < normal.count; i++) expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1);
        expect(geometry.groups.length).toBe(piece.groups.length);
    });
});

describe('destructibles and explosions', () => {
    afterEach(() => destructibles.clear());

    const handle = (objectId: string, centre: Vec3, health = 100): DestructibleHandle & { hits: number[] } => {
        let hp = health;
        let broken = false;
        const hits: number[] = [];
        return {
            objectId, hits,
            centre: () => centre,
            radius: () => 1,
            health: () => hp,
            maxHealth: () => health,
            broken: () => broken,
            damage: amount => {
                hits.push(amount);
                hp = Math.max(0, hp - amount);
                if (hp > 0 || broken) return false;
                broken = true;
                return true;
            },
            breakApart: () => (broken ? false : (broken = true)),
        };
    };

    it('falls off from all at the centre to none at the edge', () => {
        expect(explosionFalloff(0, 10)).toBe(1);
        expect(explosionFalloff(5, 10)).toBeCloseTo(0.75);
        expect(explosionFalloff(10, 10)).toBe(0);
        expect(explosionFalloff(1, 0)).toBe(0);
    });

    it('registers breakable objects, finds those in reach and tells listeners when one breaks', () => {
        const near = handle('near', { x: 1, y: 0, z: 0 });
        const far = handle('far', { x: 30, y: 0, z: 0 });
        const removeNear = destructibles.register(near);
        destructibles.register(far);
        expect(destructibles.get('near')).toBe(near);
        expect(destructibles.get(null)).toBeNull();
        expect(destructibles.within({ x: 0, y: 0, z: 0 }, 5).map(found => found.handle.objectId)).toEqual(['near']);
        const heard: string[] = [];
        const stop = destructibles.onBroken(id => heard.push(id));
        destructibles.reportBroken('near');
        stop();
        destructibles.reportBroken('far');
        expect(heard).toEqual(['near']);
        removeNear();
        expect(destructibles.get('near')).toBeNull();
    });

    it('hurts characters and breakables in reach, less further out, then throws loose bodies', () => {
        const calls: string[] = [];
        const withdraw = provideCombat({
            explosionEffect: () => { calls.push('effect'); },
            damageCharacters: (_c, radius, damage) => { calls.push(`characters ${radius} ${damage}`); return 2; },
            pushBodies: (_c, _r, speed) => { calls.push(`push ${speed}`); return 5; },
        });
        const close = handle('close', { x: 1, y: 0, z: 0 }, 50);
        const middling = handle('middling', { x: 5, y: 0, z: 0 }, 500);
        destructibles.register(close);
        destructibles.register(middling);
        const result = explode({ centre: { x: 0, y: 0, z: 0 }, radius: 8, damage: 100, force: 12 });
        expect(result).toEqual({ characters: 2, bodies: 5, broken: 1 });
        expect(calls).toEqual(['effect', 'characters 8 100', 'push 12']);
        expect(close.broken()).toBe(true);
        expect(middling.hits[0]).toBeLessThan(close.hits[0]);
        withdraw();
        expect(combat().damageCharacters({ x: 0, y: 0, z: 0 }, 1, 1)).toBe(0);
    });

    it('lets each provider withdraw only its own services', () => {
        const a = provideCombat({ damageCharacters: () => 7 });
        const b = provideCombat({ pushBodies: () => 3 });
        a();
        expect(combat().damageCharacters({ x: 0, y: 0, z: 0 }, 1, 1)).toBe(0);
        expect(combat().pushBodies({ x: 0, y: 0, z: 0 }, 1, 1)).toBe(3);
        b();
    });

    it('chooses sparks, dust or a splash by surface', () => {
        expect(impactKind('metal')).toBe('sparks');
        expect(impactKind('concrete')).toBe('sparks');
        expect(impactKind('wood')).toBe('dust');
        expect(impactKind('dirt')).toBe('dust');
        expect(impactKind('water')).toBe('splash');
    });
});

describe('the Destructible component', () => {
    const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'd', type: 'destructible', enabled: true, props });

    it('reads its settings with defaults and limits', () => {
        expect(readDestructibleSettings(component({}))).toEqual(DESTRUCTIBLE_DEFAULTS);
        const odd = readDestructibleSettings(component({ pieces: 500, health: -3, interiorColor: 'red', breakSpeed: 'fast', preview: 'yes' }));
        expect([odd.pieces, odd.health, odd.interiorColor, odd.breakSpeed, odd.preview]).toEqual([MAX_FRACTURE_PIECES, 0, DESTRUCTIBLE_DEFAULTS.interiorColor, DESTRUCTIBLE_DEFAULTS.breakSpeed, false]);
    });

    it("reads a model's meshes, materials and bounds in the object's space, and shares one fracture between copies", () => {
        const host = new THREE.Group();
        host.position.set(5, 0, 0);
        host.scale.set(3, 3, 3);
        const wood = new THREE.MeshStandardMaterial({ name: 'Wood' });
        const metal = new THREE.MeshStandardMaterial({ name: 'Metal' });
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wood);
        box.position.set(0, 0.5, 0);
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), metal);
        handle.position.set(0.6, 0.5, 0);
        host.add(box, handle);
        const source = destructibleSource(host, 'crate')!;
        expect(source.materials).toEqual([wood, metal]);
        expect(source.min.toArray().map(v => +v.toFixed(3))).toEqual([-0.5, 0, -0.5]);
        expect(source.max.x).toBeCloseTo(0.7);
        expect(new Set(source.source.materials)).toEqual(new Set([0, 1]));
        const first = cachedFracture(source, 8, 1);
        expect(cachedFracture(destructibleSource(host, 'crate')!, 8, 1)).toBe(first);
        expect(cachedFracture(source, 9, 1)).not.toBe(first);
        const inside = interiorMaterial(source.materials, '#336699');
        expect(inside.color.getHexString()).toBe(new THREE.Color('#336699').getHexString());
    });
});

describe('destruction in level and gameplay scripts', () => {
    const run = (type: WorldNodeType, inputs: Record<string, unknown>, extra: Partial<WorldNodeServices>) => {
        const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
        const node: FlowNode = {
            id: type, type,
            inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
            outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
            data: { ...definition.data },
        };
        const nodeState: Record<string, unknown> = {};
        const services: WorldNodeServices = {
            spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
            applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
            vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
        };
        WORLD_NODE_EXECUTORS[type]!(node, {
            evaluate: name => (name in inputs ? inputs[name] : node.data?.[`default_${name}`] ?? null),
            fire: () => undefined,
            schedule: () => undefined,
            nodeState,
            services,
        });
        return (pin: string) => flowNodeOutputValue(nodeState, pin);
    };

    it('explodes, breaks, damages and reads breakable objects from the level script', () => {
        const explodeService = vi.fn(() => ({ characters: 3, broken: 2 }));
        const blast = run('Explode', { 'Position X': 1, 'Position Y': 2, 'Position Z': 3, Radius: 900, Damage: 50, Force: 500 }, { explode: explodeService });
        expect(explodeService).toHaveBeenCalledWith([1, 2, 3], 500, 50, 100);
        expect([blast('Characters Hit'), blast('Objects Broken')]).toEqual([3, 2]);
        const breakObject = vi.fn(() => true);
        expect(run('BreakObject', { Actor: 'wall' }, { breakObject })('Broken')).toBe(true);
        expect(breakObject).toHaveBeenCalledWith('wall');
        const damageObject = vi.fn(() => false);
        expect(run('DamageObject', { Actor: 'wall', Amount: 30 }, { damageObject })('Broken')).toBe(false);
        expect(damageObject).toHaveBeenCalledWith('wall', 30);
        const health = run('GetObjectHealth', { Actor: 'wall' }, { objectHealth: () => ({ health: 70, maxHealth: 100, broken: false }) });
        expect([health('Destructible'), health('Health'), health('Max Health'), health('Broken')]).toEqual([true, 70, 100, false]);
        expect(run('GetObjectHealth', { Actor: 'tree' }, { objectHealth: () => null })('Destructible')).toBe(false);
    });

    it('runs an Object Broken event for its object, or any', () => {
        const node = (actorId: string) => ({ id: 'e', type: 'Event', name: 'Event ObjectBroken', inputs: [], outputs: [], data: { actorId }, position: { x: 0, y: 0 } }) as unknown as LogicNode;
        expect(brokenEventMatches(node(''), 'wall')).toBe(true);
        expect(brokenEventMatches(node('wall'), 'wall')).toBe(true);
        expect(brokenEventMatches(node('wall'), 'crate')).toBe(false);
    });

    it('lets gameplay scripts read and break them, through validated commands', () => {
        destructibles.register({
            objectId: 'gate', centre: () => ({ x: 0, y: 0, z: 0 }), radius: () => 1, health: () => 40, maxHealth: () => 100,
            broken: () => false, damage: () => false, breakApart: () => true,
        });
        expect(scriptDestructibleStates()).toEqual({ gate: { health: 40, maxHealth: 100, broken: false } });
        destructibles.clear();
        expect(scriptDestructibleStates()).toBeUndefined();

        const snapshot = (frame: number): ScriptSnapshot => ({
            frame, time: 0, delta: 0.1, objects: [{ id: 'gate', name: 'gate', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
            player: null, input: {}, variables: {}, events: [], raycasts: {}, net: { connected: false, isHost: true, selfId: null, peers: [] },
            destructibles: { gate: { health: 40, maxHealth: 100, broken: false } },
        });
        expect(isScriptSnapshot(snapshot(0))).toBe(true);
        expect(isScriptSnapshot({ ...snapshot(0), destructibles: { gate: { health: 'low' } } })).toBe(false);
        const host = createScriptHost();
        host.load([{
            id: 's', objectId: 'gate',
            source: "function onUpdate(ctx) { if (ctx.objectHealth('gate').health < 50) { ctx.damageObject('gate', 10); ctx.breakObject('gate'); ctx.explode([1, 0, 2], 900, 40); } }",
        }], source => source, snapshot(0));
        const commands = host.frame(snapshot(1)).filter(command => ['explode', 'breakObject', 'damageObject'].includes(command.type));
        expect(commands).toEqual([
            { type: 'damageObject', objectId: 'gate', amount: 10 },
            { type: 'breakObject', objectId: 'gate' },
            { type: 'explode', position: [1, 0, 2], radius: 500, damage: 40, force: 12 },
        ]);
        expect(parseScriptCommand({ type: 'explode', position: [0, 0, 0], radius: 5, damage: 10, force: 3 })).toEqual({ type: 'explode', position: [0, 0, 0], radius: 5, damage: 10, force: 3 });
        expect(parseScriptCommand({ type: 'explode', position: [0, 0], radius: 5, damage: 10, force: 3 })).toBeNull();
        expect(parseScriptCommand({ type: 'explode', position: [0, 0, 0], radius: 5000, damage: 10, force: 3 })).toBeNull();
        expect(parseScriptCommand({ type: 'damageObject', objectId: 'gate', amount: -1 })).toBeNull();
        expect(parseScriptCommand({ type: 'breakObject', objectId: '' })).toBeNull();
    });
});
