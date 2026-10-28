import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LevelObject } from '../../types';
import {
    applyLightVolume,
    BAKED_LIGHTING_UNIFORMS,
    bakeSignature,
    decodeLightVolume,
    DEFAULT_BAKED_LIGHTING_SETTINGS,
    encodeLightVolume,
    fillInvalidProbes,
    isStaticLightingLight,
    isStaticLightingMesh,
    LIGHT_VOLUME_HEADER_BYTES,
    lightVolumeEnabled,
    lightVolumeFor,
    planProbeGrid,
    readBakedProbeVolume,
    resolveBakedLightingSettings,
    setSceneLightVolume,
    SH_FLOATS_PER_PROBE,
    staticLightingObjectIds,
    type LightVolume,
} from '../../runtime/lighting/bakedLighting';

const object = (id: string, changes: Partial<LevelObject> = {}): LevelObject => ({
    id, levelId: 'level', modelId: 'model', name: id, type: 'prop',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...changes,
});

const volume = (counts: [number, number, number] = [2, 2, 2], intensity = 1): LightVolume => ({
    origin: new THREE.Vector3(-1, 0, -1),
    spacing: 2,
    counts,
    sh: new Float32Array(counts[0] * counts[1] * counts[2] * SH_FLOATS_PER_PROBE).fill(0.5),
    intensity,
});

describe('baked lighting settings', () => {
    it('fills in defaults and keeps values within their limits', () => {
        expect(resolveBakedLightingSettings(undefined)).toEqual(DEFAULT_BAKED_LIGHTING_SETTINGS);
        expect(resolveBakedLightingSettings({ spacing: 0.1, bounces: 2.6, intensity: 9 })).toEqual({ spacing: 0.5, bounces: 3, intensity: 4 });
        expect(resolveBakedLightingSettings({ spacing: Number.NaN })).toEqual(DEFAULT_BAKED_LIGHTING_SETTINGS);
    });

    it('reads a stored volume and refuses a malformed one', () => {
        const stored = { assetId: 'abc', origin: [0, 1, 2], spacing: 2, counts: [3, 2, 4], bakedAt: 'now', signature: 'sig' };
        expect(readBakedProbeVolume(stored)).toEqual({ ...stored, encoding: 'sh1-float32le' });
        expect(readBakedProbeVolume({ ...stored, counts: [0, 2, 2] })).toBeNull();
        expect(readBakedProbeVolume({ ...stored, counts: [256, 256, 2] })).toBeNull();
        expect(readBakedProbeVolume({ ...stored, origin: [0, Number.NaN, 0] })).toBeNull();
        expect(readBakedProbeVolume({ ...stored, spacing: 0 })).toBeNull();
        expect(readBakedProbeVolume({ ...stored, assetId: '' })).toBeNull();
        expect(readBakedProbeVolume(null)).toBeNull();
    });
});

describe('light volume asset', () => {
    it('round-trips the probes through the binary layout', () => {
        const counts: [number, number, number] = [2, 1, 3];
        const sh = Float32Array.from({ length: 6 * SH_FLOATS_PER_PROBE }, (_, index) => index / 7 - 3);
        const bytes = encodeLightVolume(sh, counts);
        expect(bytes.byteLength).toBe(LIGHT_VOLUME_HEADER_BYTES + sh.length * 4);
        expect(String.fromCharCode(...bytes.slice(0, 8))).toBe('AUVRALV1');
        const decoded = decodeLightVolume(bytes.buffer);
        expect(decoded.counts).toEqual(counts);
        expect(Array.from(decoded.sh)).toEqual(Array.from(sh));
    });

    it('refuses data that does not match its dimensions', () => {
        expect(() => encodeLightVolume(new Float32Array(5), [1, 1, 1])).toThrow();
        const bytes = encodeLightVolume(new Float32Array(SH_FLOATS_PER_PROBE), [1, 1, 1]);
        expect(() => decodeLightVolume(bytes.buffer.slice(0, bytes.byteLength - 4))).toThrow();
        const wrongMagic = bytes.slice();
        wrongMagic[0] = 0;
        expect(() => decodeLightVolume(wrongMagic.buffer)).toThrow();
    });
});

describe('probe grid', () => {
    it('covers the bounds at the requested spacing', () => {
        const grid = planProbeGrid(new THREE.Box3(new THREE.Vector3(-5, 0, -3), new THREE.Vector3(5, 4, 3)), 2);
        expect(grid.spacing).toBe(2);
        expect(grid.counts).toEqual([6, 3, 4]);
        // Centred over the bounds where the probes do not fill them exactly.
        expect(grid.origin.x).toBeCloseTo(-5);
        expect(grid.origin.z).toBeCloseTo(-3);
        expect(grid.origin.y).toBeCloseTo(0.25);
    });

    it('widens the spacing to stay within the probe limit', () => {
        const grid = planProbeGrid(new THREE.Box3(new THREE.Vector3(-500, 0, -500), new THREE.Vector3(500, 10, 500)), 1, 4096);
        expect(grid.counts[0] * grid.counts[1] * grid.counts[2]).toBeLessThanOrEqual(4096);
        expect(grid.spacing).toBeGreaterThan(1);
    });

    it('places one probe for empty bounds', () => {
        expect(planProbeGrid(new THREE.Box3(), 2).counts).toEqual([1, 1, 1]);
    });
});

describe('probes inside geometry', () => {
    it('take the average light of their valid neighbours, spreading outward', () => {
        const counts: [number, number, number] = [3, 1, 1];
        const sh = new Float32Array(3 * SH_FLOATS_PER_PROBE);
        sh.fill(4, 0, SH_FLOATS_PER_PROBE);
        fillInvalidProbes(sh, Uint8Array.from([1, 0, 0]), counts);
        expect(Array.from(sh.slice(SH_FLOATS_PER_PROBE))).toEqual(new Array(2 * SH_FLOATS_PER_PROBE).fill(4));
    });

    it('leave the data alone when no probe is valid', () => {
        const sh = new Float32Array(SH_FLOATS_PER_PROBE).fill(1);
        fillInvalidProbes(sh, new Uint8Array(1), [1, 1, 1]);
        expect(Array.from(sh)).toEqual(new Array(SH_FLOATS_PER_PROBE).fill(1));
    });
});

describe('what a bake sees', () => {
    const levelObjects = [
        object('crate'),
        object('tree', { type: 'foliage' }),
        object('ground', { type: 'terrain', modelId: '' }),
        object('lift', { components: [{ id: 'm', type: 'mover', enabled: true, props: {} }] }),
        object('on-lift', { parentId: 'lift' }),
        object('barrel', { components: [{ id: 'b', type: 'rigidBody', enabled: true, props: { type: 'dynamic' } }] }),
        object('wall', { components: [{ id: 'w', type: 'rigidBody', enabled: true, props: { type: 'fixed' } }] }),
        object('spawn', { type: 'spawn_point' }),
        object('sky', { type: 'sky_sphere', modelId: '' }),
    ];

    it('takes the props, foliage and terrain that never move', () => {
        expect([...staticLightingObjectIds(levelObjects)].sort()).toEqual(['crate', 'ground', 'tree', 'wall']);
    });

    it('draws lit, unskinned meshes of static objects or instanced layers', () => {
        const ids = staticLightingObjectIds(levelObjects);
        const group = (id: string) => Object.assign(new THREE.Group(), { userData: { levelObjectId: id } });
        const lit = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        const crate = group('crate').add(lit());
        const lift = group('lift').add(lit());
        expect(isStaticLightingMesh(crate.children[0], ids)).toBe(true);
        expect(isStaticLightingMesh(lift.children[0], ids)).toBe(false);
        // Editor markers are unlit; characters are skinned; scene helpers belong to no object.
        expect(isStaticLightingMesh(group('crate').add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())).children[0], ids)).toBe(false);
        expect(isStaticLightingMesh(lit(), ids)).toBe(false);
        const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial(), 2);
        instanced.userData.staticLighting = true;
        expect(isStaticLightingMesh(instanced, ids)).toBe(true);
    });

    it('bakes the scene lights and those of static objects, not a light that moves', () => {
        const ids = staticLightingObjectIds(levelObjects);
        expect(isStaticLightingLight(new THREE.HemisphereLight(), ids)).toBe(true);
        const lamp = new THREE.PointLight();
        Object.assign(new THREE.Group(), { userData: { levelObjectId: 'wall' } }).add(lamp);
        expect(isStaticLightingLight(lamp, ids)).toBe(true);
        const torch = new THREE.PointLight();
        Object.assign(new THREE.Group(), { userData: { levelObjectId: 'lift' } }).add(torch);
        expect(isStaticLightingLight(torch, ids)).toBe(false);
    });

    it('changes its signature when what it saw changes, and only then', () => {
        const settings = DEFAULT_BAKED_LIGHTING_SETTINGS;
        const before = bakeSignature(levelObjects, settings);
        expect(bakeSignature([...levelObjects].reverse(), settings)).toBe(before);
        expect(bakeSignature(levelObjects, { ...settings, intensity: 3 })).toBe(before);
        // A moving object, or a spawn point, is not part of the bake.
        const moved = levelObjects.map(item => (item.id === 'lift' || item.id === 'spawn' ? { ...item, position: [9, 9, 9] as [number, number, number] } : item));
        expect(bakeSignature(moved, settings)).toBe(before);
        const pushed = levelObjects.map(item => (item.id === 'crate' ? { ...item, position: [1, 0, 0] as [number, number, number] } : item));
        expect(bakeSignature(pushed, settings)).not.toBe(before);
        expect(bakeSignature(levelObjects, { ...settings, spacing: 4 })).not.toBe(before);
    });
});

describe('drawing with a volume', () => {
    it('teaches every lit material the volume and shares its uniforms', () => {
        expect(THREE.ShaderChunk.lights_pars_begin).toContain('bakedGiIrradiance');
        expect(THREE.ShaderChunk.lights_fragment_maps).toContain('bakedGiBlend');
        for (const name of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
            const copy = THREE.UniformsUtils.clone(THREE.ShaderLib[name].uniforms);
            expect(copy.bakedGiSh0.value).toBe(BAKED_LIGHTING_UNIFORMS.bakedGiSh0.value);
            expect(copy.bakedGiParams.value).toBe(BAKED_LIGHTING_UNIFORMS.bakedGiParams.value);
        }
    });

    it('draws each scene with the last volume given to it, or none', () => {
        const scene = new THREE.Scene();
        const other = new THREE.Scene();
        const level = volume([2, 2, 2], 1.5);
        const releaseLevel = setSceneLightVolume(scene, level);
        scene.onBeforeRender(undefined as never, scene, new THREE.Camera(), null as never, undefined as never, undefined as never);
        expect(lightVolumeEnabled()).toBe(true);
        expect(BAKED_LIGHTING_UNIFORMS.bakedGiParams.value.x).toBe(1.5);
        expect(BAKED_LIGHTING_UNIFORMS.bakedGiExtent.value.toArray()).toEqual([2, 2, 2]);
        expect(BAKED_LIGHTING_UNIFORMS.bakedGiSh0.value.image.width).toBe(2);
        applyLightVolume(other);
        expect(lightVolumeEnabled()).toBe(false);

        // A bake stacks none, then its bounces, over the level's own; taking them back restores it.
        const releaseNone = setSceneLightVolume(scene, null);
        expect(lightVolumeFor(scene)).toBeNull();
        const bounce = volume([3, 1, 1]);
        const releaseBounce = setSceneLightVolume(scene, bounce);
        releaseNone();
        applyLightVolume(scene);
        expect(BAKED_LIGHTING_UNIFORMS.bakedGiSh0.value.image.width).toBe(3);
        releaseBounce();
        expect(lightVolumeFor(scene)).toBe(level);
        releaseLevel();
        expect(lightVolumeFor(scene)).toBeNull();
    });
});
