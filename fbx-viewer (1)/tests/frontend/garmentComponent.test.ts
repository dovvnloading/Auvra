import * as THREE from 'three';
import { meshLodChain, meshLodReady } from '../../utils/meshLod';
import { describe, expect, it, vi } from 'vitest';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import * as windField from '../../runtime/wind';
import { createComponent } from '../../runtime/components/registry';
import type { GarmentPattern } from '../../runtime/garments/pattern';
import { GARMENT_STEP } from '../../runtime/garments/solver';

const settings = () => readGarmentSettings(createComponent('garment'));
function bone(name: string): THREE.Bone {
    const item = new THREE.Bone();
    item.name = name;
    return item;
}

describe('garment component in the level transform hierarchy', () => {
    it('authors independent pattern data on add and keeps absent-pattern scenes readable', () => {
        const first = createComponent('garment');
        const second = createComponent('garment');
        const source = first.props.pattern as GarmentPattern;
        expect(source.panels).toHaveLength(2);
        source.panels[0].name = 'Changed front';
        expect((second.props.pattern as GarmentPattern).panels[0].name).not.toBe('Changed front');
        expect(cookComponentGarment(undefined).indices).toEqual(cookComponentGarment(second.props.pattern).indices);
        expect(() => cookComponentGarment(null)).toThrow();
        expect(() => cookComponentGarment({ version: 9 })).toThrow();
    });

    it('publishes solved positions, normals, bounds and a matching fitting proxy to the mesh', () => {
        const cook = cookComponentGarment(undefined);
        const garment = new GarmentInstance(cook, 'cotton');
        const other = new GarmentInstance(cook, 'linen');
        const source = cook.positions.slice();
        const buffer = garment.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        expect(buffer.array).toBe(garment.simulation.positions);
        expect(buffer.array).not.toBe(cook.positions);
        const current = { ...settings(), color: '#ff9900', wind: 0 };
        garment.advance(GARMENT_STEP / 2, current, 'actor');
        expect(buffer.version).toBe(0);
        expect(garment.torso.position.x).toBe(0);
        garment.advance(GARMENT_STEP / 2, current, 'actor');
        expect(buffer.version).toBe(1);
        expect(garment.torso.position.x).toBeCloseTo(0.025 * Math.sin(2.2 * GARMENT_STEP), 7);
        const normal = garment.mesh.geometry.getAttribute('normal');
        expect(Array.from(normal.array).every(Number.isFinite)).toBe(true);
        expect(garment.mesh.geometry.boundingSphere!.radius).toBeGreaterThan(0);
        expect(garment.mesh.material.color.getHexString()).toBe('ff9900');
        expect(cook.positions).toEqual(source);
        expect(other.simulation.positions).toEqual(source);
        garment.advance(GARMENT_STEP, { ...current, showTorso: false }, 'actor');
        expect(garment.torso.visible).toBe(false);
        const disposals = [garment.mesh.geometry, garment.mesh.material, garment.torso.geometry, garment.torso.material]
            .map(resource => vi.spyOn(resource, 'dispose'));
        garment.dispose();
        other.dispose();
        for (const disposal of disposals) expect(disposal).toHaveBeenCalledTimes(1);
    });

    it('applies world gravity in physical units under a rotated, nonuniformly scaled hierarchy', () => {
        const mesh = cookComponentGarment({ version: 1, edgeLength: .5, seams: [], panels: [{
            id: 'p', name: 'Free swatch', grain: [1, 0], pins: [],
            placement: { origin: [3, 3, 0], u: [1, 0, 0], v: [0, 0, 1] },
            boundary: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: .2, y: 0 }, { id: 'c', x: 0, y: .2 }],
        }] });
        const garment = new GarmentInstance(mesh, 'cotton');
        const ancestor = new THREE.Group(), host = new THREE.Group();
        ancestor.scale.set(1.5, 3, .5);
        ancestor.rotation.z = .4;
        host.rotation.x = .5;
        ancestor.add(host); host.add(garment.root);
        try {
            const position = () => garment.root.localToWorld(new THREE.Vector3().fromArray(garment.simulation.positions));
            const initial = position();
            garment.advance(GARMENT_STEP, { ...settings(), animateTorso: false, wind: 0 }, 'cloth');
            const delta = position().sub(initial);
            expect(delta.x).toBeCloseTo(0, 6);
            expect(delta.y).toBeCloseTo(-9.81 * GARMENT_STEP ** 2, 6);
            expect(delta.z).toBeCloseTo(0, 6);
        } finally { garment.dispose(); }
    });

    it('samples wind near the garment when its panels are far from the fitting form', () => {
        const garment = new GarmentInstance(cookComponentGarment({ version: 1, edgeLength: .5, seams: [], panels: [{
            id: 'p', name: 'Window curtain', grain: [1, 0], pins: [],
            placement: { origin: [8, 2, 0], u: [1, 0, 0], v: [0, 1, 0] },
            boundary: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: .2, y: 0 }, { id: 'c', x: 0, y: .2 }],
        }] }), 'cotton');
        const host = new THREE.Group();
        host.position.x = 2;
        host.add(garment.root);
        const field = vi.spyOn(windField, 'windAt');
        try {
            garment.advance(GARMENT_STEP, { ...settings(), animateTorso: false, wind: 1 }, 'cloth');
            const [x, y] = field.mock.calls[0];
            expect(x).toBeCloseTo(10.1, 4);
            expect(y).toBeCloseTo(2.1, 4);
            garment.advance(1, { ...settings(), wind: 0 }, 'cloth');
            expect(garment.simulation.droppedTime).toBeCloseTo(1 - 8 * GARMENT_STEP, 10);
        } finally { field.mockRestore(); garment.dispose(); }
    });

    it('uses the cooked triangle connectivity at every pose regardless of which frame is drawn first', async () => {
        await meshLodReady;
        const cook = cookComponentGarment(undefined);
        const live = new GarmentInstance(cook, 'cotton'), cached = new GarmentInstance(cook, 'cotton');
        const config = { ...settings(), wind: 0 };
        try {
            const first = meshLodChain(live.mesh.geometry);
            for (let i = 0; i < 15; i++) live.advance(1 / 30, config, 'top');
            cached.presentCachedPose(live.simulation.positions, live.torso.position, config);
            const replay = meshLodChain(cached.mesh.geometry);
            expect(cook.indices.length / 3).toBeGreaterThan(300);
            expect(first).toHaveLength(1);
            expect(replay).toHaveLength(1);
            expect(meshLodChain(live.mesh.geometry)).toEqual(first);
            expect(first[0].geometry.index!.array).toBe(cook.indices);
            expect(replay[0].geometry.index!.array).toBe(cook.indices);
        } finally { live.dispose(); cached.dispose(); }
    });

    it('shows signed strain on cached positions with current bounds and restores the selected cloth colour', () => {
        const mesh = cookComponentGarment(undefined);
        const garment = new GarmentInstance(mesh, 'silk');
        const positions = mesh.positions.map((v, i) => i % 3 === 0 ? 1.04 * v : v);
        const center = new THREE.Vector3(0.08, 1.4, -0.02);
        const fit = { ...settings(), strainView: 'warp' as const };
        garment.presentCachedPose(positions, center, fit);
        expect(garment.simulation.time).toBe(0);
        expect(garment.mesh.material.vertexColors).toBe(true);
        expect(garment.mesh.material.color.getHexString()).toBe('ffffff');
        const color = garment.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
        expect(color.count).toBe(mesh.positions.length / 3);
        expect(color.array.every(Number.isFinite)).toBe(true);
        expect(garment.torso.position).toEqual(center);
        expect(garment.simulation.positions).toEqual(positions);
        expect(() => garment.presentCachedPose([], center, fit)).toThrow(/vertex count/);
        garment.presentCachedPose(positions, center, { ...fit, strainView: 'off', color: '#123456' });
        expect(garment.mesh.material.vertexColors).toBe(false);
        expect(garment.mesh.material.color.getHexString()).toBe('123456');
        garment.dispose();
    });

    it('releases a cached bone renamed or moved into a nested actor and binds its replacement', () => {
        const garment = new GarmentInstance(cookComponentGarment(undefined), 'cotton');
        const host = new THREE.Group(), nested = new THREE.Group(), chest = bone('Chest');
        nested.userData.levelObjectId = 'second-actor';
        host.add(garment.root, chest, nested);
        const binding = { ...settings(), followBone: 'Chest', wind: 0 };
        try {
            garment.advance(GARMENT_STEP, binding, 'actor');
            expect(garment.root.visible).toBe(true);
            chest.name = 'Old mount';
            garment.advance(GARMENT_STEP, binding, 'actor');
            expect(garment.root.visible).toBe(false);
            const next = bone('Chest');
            host.add(next);
            garment.advance(.51, binding, 'actor');
            expect(garment.root.visible).toBe(true);
            nested.add(next);
            garment.advance(GARMENT_STEP, binding, 'actor');
            expect(garment.root.visible).toBe(false);
        } finally { garment.dispose(); }
    });

    it('follows translations from its owning rig and keeps two actors using identical bone names independent', () => {
        const cook = cookComponentGarment(undefined);
        const a = new GarmentInstance(cook, 'cotton');
        const b = new GarmentInstance(cook, 'cotton');
        const host = new THREE.Group(), other = new THREE.Group();
        const nested = new THREE.Group();
        nested.userData.levelObjectId = 'nested';
        nested.add(bone('Chest'));
        host.rotation.y = 0.7;
        host.position.set(10, 5, -2);
        host.scale.setScalar(2);
        const chestA = bone('Chest'), chestB = bone('Chest');
        host.add(nested, a.root, chestA);
        other.add(b.root, chestB);
        const follow = { ...settings(), followBone: 'Chest', wind: 0 };
        a.advance(GARMENT_STEP, follow, 'a');
        b.advance(GARMENT_STEP, follow, 'b');
        chestA.position.x += 0.04;
        chestB.position.z -= 0.02;
        a.advance(GARMENT_STEP, follow, 'a');
        b.advance(GARMENT_STEP, follow, 'b');
        expect(a.torso.position.x).toBeCloseTo(0.04);
        expect(a.torso.position.z).toBeCloseTo(0);
        expect(b.torso.position.x).toBeCloseTo(0);
        expect(b.torso.position.z).toBeCloseTo(-0.02);
        host.remove(chestA);
        a.advance(GARMENT_STEP, follow, 'a');
        expect(a.root.visible).toBe(false);
        expect(b.root.visible).toBe(true);
        a.dispose();
        b.dispose();
    });
});
