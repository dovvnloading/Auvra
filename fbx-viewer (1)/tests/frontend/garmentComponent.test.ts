import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
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
