import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { gustFactor, stepWind, weatherWindAt, windAt, windUniforms, windZones, zoneWindAt, type WindZoneState } from '../../runtime/wind';
import { NO_WEATHER, WEATHER_PRESETS } from '../../runtime/weather';
import { ClothSimulation, pinnedAt, CLOTH_STEP, type ClothSettings } from '../../runtime/cloth';
import { SpringBones, springBoneMatcher, DEFAULT_SPRING_BONES } from '../../runtime/springBones';
import { isWeatherPatched, patchWindSurfaces, swayOfMaterial } from '../../runtime/weatherSurfaces';
import { CLOTH_DEFAULTS, readClothSettings, readSpringSettings, readWindSway, readWindZone } from '../../runtime/components/windComponents';
import type { LevelComponent } from '../../types';

const component = (type: string, props: Record<string, unknown>): LevelComponent => ({ id: type, type, enabled: true, props });

describe('the wind', () => {
    afterEach(() => windZones.clear());

    it('blows with the weather, gusting about its speed, and is still without it', () => {
        const out = { x: 0, y: 0, z: 0 };
        expect(weatherWindAt(NO_WEATHER, 0, 0, 0, 1, out)).toEqual({ x: 0, y: 0, z: 0 });
        const weather = { ...WEATHER_PRESETS.cloudy, wind: 10, windDirection: 90 };
        let total = 0;
        let lowest = Infinity, highest = 0;
        for (let t = 0; t < 120; t += 0.5) {
            weatherWindAt(weather, 3, 1, -2, t, out);
            // Blowing toward +X.
            expect(out.x).toBeGreaterThan(0);
            const speed = Math.hypot(out.x, out.z);
            total += speed;
            lowest = Math.min(lowest, speed);
            highest = Math.max(highest, speed);
        }
        expect(total / 240).toBeGreaterThan(7);
        expect(total / 240).toBeLessThan(12);
        expect(highest - lowest).toBeGreaterThan(3);
        for (let t = 0; t < 60; t += 0.7) {
            expect(gustFactor(t)).toBeGreaterThan(0.3);
            expect(gustFactor(t)).toBeLessThan(1.5);
        }
    });

    it('adds wind zones where they reach: one way, or out from a middle, fading at the edge', () => {
        const out = { x: 0, y: 0, z: 0 };
        const fan: WindZoneState = { shape: 'directional', x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, strength: 10, radius: 5, turbulence: 0 };
        expect(zoneWindAt(fan, 0, 0, 1, 0, out).z).toBeCloseTo(9.6);
        expect(zoneWindAt(fan, 0, 0, 6, 0, out).z).toBe(0);
        const blast: WindZoneState = { ...fan, shape: 'radial', radius: 4 };
        zoneWindAt(blast, 2, 0, 0, 0, out);
        expect(out.x).toBeCloseTo(7.5);
        expect(out.z).toBeCloseTo(0);
        windZones.set('fan', fan);
        windAt(0, 0, 1, 0, out, NO_WEATHER);
        expect(out.z).toBeCloseTo(9.6);
        windZones.remove('fan');
        windAt(0, 0, 1, 0, out, NO_WEATHER);
        expect(out.z).toBe(0);
    });

    it('tells swaying surfaces its direction and strength', () => {
        stepWind(0.5, { ...WEATHER_PRESETS.storm, windDirection: 0 });
        expect(windUniforms.uWindDirection.value[0]).toBeCloseTo(0);
        expect(windUniforms.uWindDirection.value[1]).toBeCloseTo(1);
        expect(windUniforms.uWindStrength.value).toBeGreaterThan(5);
        stepWind(0.5, NO_WEATHER);
        expect(windUniforms.uWindStrength.value).toBe(0);
    });
});

describe('foliage sway', () => {
    it('knows leaves, grass and woody parts by their materials', () => {
        expect(swayOfMaterial('Leaves')).toEqual({ sway: 1, flutter: 1 });
        expect(swayOfMaterial('tall_grass_02')).toEqual({ sway: 1, flutter: 1 });
        expect(swayOfMaterial('Bark')).toEqual({ sway: 0.35, flutter: 0 });
        expect(swayOfMaterial('Wood')).toBeNull();
        expect(swayOfMaterial(undefined)).toBeNull();
    });

    it("sways a tree's materials as one plant, and lets a Wind Sway set or stop it", () => {
        const tree = new THREE.Group();
        tree.userData.levelObjectId = 'tree';
        const leaves = new THREE.MeshStandardMaterial({ name: 'Leaves' });
        const bark = new THREE.MeshStandardMaterial({ name: 'Bark' });
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 4).translate(0, 2, 0), bark);
        const crown = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4).translate(0, 5, 0), leaves);
        tree.add(trunk, crown);
        const scene = new THREE.Scene();
        scene.add(tree);
        expect(patchWindSurfaces(scene)).toBe(2);
        expect(isWeatherPatched(leaves)).toBe(true);
        expect(leaves.userData.windSway).toEqual({ sway: 1, flutter: 1 });
        // Bottom and height of the whole tree, in each mesh's space.
        expect(leaves.userData.windShape.bottom).toBeCloseTo(0);
        expect(leaves.userData.windShape.height).toBeCloseTo(7);
        expect(bark.userData.windShape.height).toBeCloseTo(7);
        const key = leaves.customProgramCacheKey();
        expect(key).toContain('wind');
        expect(patchWindSurfaces(scene)).toBe(0);

        tree.userData.windSway = null;
        expect(patchWindSurfaces(scene)).toBe(2);
        expect(leaves.userData.windSway).toBeNull();
        expect(leaves.customProgramCacheKey()).not.toContain('wind');

        const rock = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Stone' }));
        rock.userData.windSway = { sway: 0.5, flutter: 0 };
        scene.add(rock);
        expect(patchWindSurfaces(scene)).toBe(1);
        expect((rock.material as THREE.Material).userData.windSway).toEqual({ sway: 0.5, flutter: 0 });
    });
});

describe('cloth', () => {
    const settings = (overrides: Partial<ClothSettings> = {}): ClothSettings => ({
        width: 2, height: 1, resolution: 12, pin: 'top', stiffness: 0.9, bend: 0.3, damping: 0.2, weight: 0.3, wind: 1, thickness: 0.02, ...overrides,
    });
    const identity = new THREE.Matrix4().elements;
    const run = (cloth: ClothSimulation, seconds: number, matrix = identity, wind: ((x: number, y: number, z: number, out: { x: number; y: number; z: number }) => { x: number; y: number; z: number }) | null = null, colliders = [] as { x: number; y: number; z: number; height: number; radius: number }[], ground: number | null = null) => {
        for (let t = 0; t < seconds; t += 1 / 60) cloth.step(1 / 60, matrix, wind, colliders, ground);
    };
    const point = (cloth: ClothSimulation, row: number, column: number) =>
        new THREE.Vector3().fromArray(cloth.positions, (row * cloth.columns + column) * 3);

    it('lays out a grid of square cells pinned where asked', () => {
        const cloth = new ClothSimulation(settings());
        expect(cloth.columns).toBe(12);
        expect(cloth.rows).toBe(6);
        expect(cloth.indices.length).toBe((cloth.columns - 1) * (cloth.rows - 1) * 6);
        expect(pinnedAt('left', 3, 0, 6, 12)).toBe(true);
        expect(pinnedAt('topCorners', 0, 5, 6, 12)).toBe(false);
        expect(pinnedAt('corners', 5, 11, 6, 12)).toBe(true);
        expect(pinnedAt('none', 0, 0, 6, 12)).toBe(false);
    });

    it('hangs from its pins without stretching, held where the object is', () => {
        const cloth = new ClothSimulation(settings({ pin: 'topCorners' }));
        const matrix = new THREE.Matrix4().makeTranslation(5, 3, 0).elements;
        run(cloth, 4, matrix);
        expect(point(cloth, 0, 0).toArray().map(v => +v.toFixed(3))).toEqual([4, 3, 0]);
        expect(point(cloth, 0, cloth.columns - 1).x).toBeCloseTo(6);
        // The middle of the top edge sags between the corners; nothing falls away.
        expect(point(cloth, 0, 5).y).toBeLessThan(3);
        for (let i = 0; i < cloth.count; i++) expect(cloth.positions[i * 3 + 1]).toBeGreaterThan(1);
        const bottom = point(cloth, cloth.rows - 1, 5);
        expect(bottom.y).toBeLessThan(2.2);
        expect(bottom.y).toBeGreaterThan(1.3);
    });

    it('flies in the wind like a flag', () => {
        const cloth = new ClothSimulation(settings({ pin: 'left' }));
        const breeze = (_x: number, _y: number, _z: number, out: { x: number; y: number; z: number }) => { out.x = 8; out.y = 0; out.z = 1; return out; };
        run(cloth, 5, identity, breeze);
        const tip = point(cloth, 2, cloth.columns - 1);
        // Out downwind of the pole, held up rather than hanging straight down.
        expect(tip.x).toBeGreaterThan(0.6);
        const still = new ClothSimulation(settings({ pin: 'left' }));
        run(still, 5);
        expect(point(still, 2, still.columns - 1).x).toBeLessThan(tip.x);
    });

    it('rests against a character and the ground', () => {
        const cloth = new ClothSimulation(settings({ pin: 'top', width: 2, height: 2 }));
        const capsule = { x: 0, y: -2.5, z: 0.15, height: 2, radius: 0.35 };
        run(cloth, 3, identity, null, [capsule], -1.5);
        for (let i = 0; i < cloth.count; i++) {
            const p = new THREE.Vector3().fromArray(cloth.positions, i * 3);
            expect(p.y).toBeGreaterThanOrEqual(-1.5 + 0.02 - 1e-3);
            const cy = Math.min(capsule.y + capsule.height - capsule.radius, Math.max(capsule.y + capsule.radius, p.y));
            expect(Math.hypot(p.x - capsule.x, p.y - cy, p.z - capsule.z)).toBeGreaterThan(capsule.radius - 0.02);
        }
    });

    it('steps at a fixed rate whatever the frame time', () => {
        const a = new ClothSimulation(settings());
        const b = new ClothSimulation(settings());
        for (let i = 0; i < 90; i++) a.step(CLOTH_STEP, identity, null, [], null);
        for (let i = 0; i < 45; i++) b.step(CLOTH_STEP * 2, identity, null, [], null);
        expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    });
});

describe('spring bones', () => {
    const chain = (count = 6) => {
        const root = new THREE.Group();
        const anchor = new THREE.Bone();
        anchor.name = 'Head';
        root.add(anchor);
        let parent: THREE.Object3D = anchor;
        const bones: THREE.Bone[] = [];
        for (let i = 0; i < count; i++) {
            const bone = new THREE.Bone();
            bone.name = `Hair_${i}`;
            if (i > 0) bone.position.set(0, -0.25, 0);
            parent.add(bone);
            bones.push(bone);
            parent = bone;
        }
        root.updateMatrixWorld(true);
        return { root, anchor, bones };
    };
    const springs = { stiffness: 1.5, damping: 0.4, gravity: 6, wind: 0.4 };
    const tipOf = (bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3());

    it('finds the chains by name, below matching bones', () => {
        const { root } = chain();
        expect(new SpringBones(root, springBoneMatcher('hair')).count).toBe(6);
        expect(new SpringBones(root, springBoneMatcher('tail, rope')).count).toBe(0);
        expect(springBoneMatcher(DEFAULT_SPRING_BONES)('Ponytail_02')).toBe(true);
        expect(springBoneMatcher(DEFAULT_SPRING_BONES)('mixamorig:Spine')).toBe(false);
    });

    it('hangs still with nothing moving it, and leans evenly downwind without curling over', () => {
        const { root, bones } = chain();
        const solver = new SpringBones(root, springBoneMatcher('hair'));
        for (let i = 0; i < 240; i++) solver.update(1 / 60, springs, null);
        root.updateMatrixWorld(true);
        expect(tipOf(bones[5]).x).toBeCloseTo(0, 3);
        const breeze = (_x: number, _y: number, _z: number, out: { x: number; y: number; z: number }) => { out.x = 7; out.y = 0; out.z = 0; return out; };
        for (let i = 0; i < 300; i++) solver.update(1 / 60, springs, breeze);
        root.updateMatrixWorld(true);
        const xs = bones.map(bone => tipOf(bone).x);
        const ys = bones.map(bone => tipOf(bone).y);
        for (let i = 1; i < xs.length; i++) {
            expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-3);
            expect(ys[i]).toBeLessThan(ys[i - 1]);
        }
        expect(xs[5]).toBeGreaterThan(0.05);
    });

    it('swings behind when what it hangs from moves, then settles, and can be put back', () => {
        const { root, anchor, bones } = chain();
        const solver = new SpringBones(root, springBoneMatcher('hair'));
        solver.update(1 / 60, springs, null);
        anchor.position.x = 1;
        root.updateMatrixWorld(true);
        solver.update(1 / 60, springs, null);
        root.updateMatrixWorld(true);
        // The end lags behind the move.
        expect(tipOf(bones[5]).x).toBeLessThan(0.9);
        for (let i = 0; i < 400; i++) solver.update(1 / 60, springs, null);
        root.updateMatrixWorld(true);
        expect(tipOf(bones[5]).x).toBeCloseTo(1, 2);
        solver.restore();
        expect(bones.every(bone => bone.quaternion.equals(new THREE.Quaternion()))).toBe(true);
    });
});

describe('the components', () => {
    it('read their settings with defaults and limits', () => {
        expect(readClothSettings(component('cloth', {}))).toEqual({ ...CLOTH_DEFAULTS });
        const cloth = readClothSettings(component('cloth', { resolution: 400, pin: 'sideways', width: -1, color: 'blue' }));
        expect([cloth.resolution, cloth.pin, cloth.width, cloth.color]).toEqual([40, CLOTH_DEFAULTS.pin, 0.05, CLOTH_DEFAULTS.color]);
        expect(readWindZone(component('windZone', { shape: 'radial', strength: 500 }))).toEqual({ shape: 'radial', strength: 100, radius: 6, turbulence: 0.4 });
        expect(readWindSway(component('windSway', { sway: 0 }))).toEqual({ sway: 0, flutter: 0.5 });
        expect(readSpringSettings(component('springBones', { bones: '  ' })).bones).toBe(DEFAULT_SPRING_BONES);
    });
});
