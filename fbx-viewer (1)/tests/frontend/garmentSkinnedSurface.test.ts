import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { createSleevelessTop } from '../../runtime/garments/pattern';
import { SkinnedSurfaceBinding } from '../../runtime/garments/skinnedSurface';
import { GARMENT_STEP } from '../../runtime/garments/solver';

function rig(name = 'Body') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-.4, 0, 0, .4, 0, 0, 0, .8, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0,0,0,0, 1,0,0,0, 0,1,0,0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, .5,.5,0,0], 4));
    geometry.setIndex([0, 1, 2]);
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,.2], 3)];
    const body = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const root = new THREE.Bone(), joint = new THREE.Bone();
    root.add(joint);
    body.name = name;
    body.add(root);
    const host = new THREE.Group();
    host.add(body);
    body.bind(new THREE.Skeleton([root, joint]));
    return { host, body, joint };
}

describe('sample an owning skinned collision surface', () => {
    it('samples morphs and individual bone influences in owner-local metres under a rotated, translated and scaled actor', () => {
        const { host, body, joint } = rig();
        const group = new THREE.Group();
        host.add(group);
        host.position.set(17, -2, 8);
        host.rotation.y = .71;
        host.scale.set(2, 1.5, 3);
        const binding = new SkinnedSurfaceBinding();
        expect(binding.capture(group, 'actor', 'Body', GARMENT_STEP)).toBe(true);
        const first = binding.tick(1)!;
        expect(Array.from(first.previousPositions)).toEqual(Array.from(first.positions));
        expect(first.positions[0]).toBeCloseTo(-.4);
        expect(first.positions[4]).toBeCloseTo(0);
        expect(first.positions[7]).toBeCloseTo(.8);
        binding.accept();
        joint.position.z = .2;
        body.morphTargetInfluences![0] = .5;
        expect(binding.capture(group, 'actor', 'Body', 2 * GARMENT_STEP)).toBe(true);
        const half = binding.tick(.5)!;
        expect(half.positions[2]).toBeCloseTo(0);
        expect(half.positions[5]).toBeCloseTo(.1);
        expect(half.positions[8]).toBeCloseTo(.1); // 50% second-bone displacement + morph, halfway.
        expect(half.previousPositions[5]).toBeCloseTo(0);
        binding.accept();
        const end = binding.tick(1)!;
        expect(end.positions[5]).toBeCloseTo(.2);
        expect(end.positions[8]).toBeCloseTo(.2);
        expect(end.previousPositions[5]).toBeCloseTo(.1);
    });

    it('preserves outward winding and resets sweep history when a rig is reflected', () => {
        const { host, body } = rig();
        const group = new THREE.Group(), binding = new SkinnedSurfaceBinding();
        host.add(group);
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        binding.tick(1);
        binding.accept();
        body.scale.x = -1;
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        const sample = binding.tick(1)!;
        expect(Array.from(sample.indices)).toEqual([0, 2, 1]);
        expect(sample.previousPositions).toEqual(sample.positions);
        const [a,b,c] = Array.from(sample.indices, i => new THREE.Vector3().fromArray(sample.positions, 3*i));
        expect(b.sub(a).cross(c.sub(a)).z).toBeGreaterThan(0);
    });

    it('keeps accepted tick history across render frames that take no simulation step', () => {
        const { host, joint } = rig();
        const group = new THREE.Group(), binding = new SkinnedSurfaceBinding();
        host.add(group);
        binding.capture(group, 'actor', 'Body', GARMENT_STEP);
        binding.tick(1);
        binding.accept();
        joint.position.z = .1;
        binding.capture(group, 'actor', 'Body', GARMENT_STEP / 2);
        joint.position.z = .2;
        binding.capture(group, 'actor', 'Body', GARMENT_STEP / 2);
        const end = binding.tick(1)!;
        expect(end.previousPositions[5]).toBeCloseTo(0);
        expect(end.positions[5]).toBeCloseTo(.2);
        // A rejected candidate never becomes the next tick's starting surface.
        expect(binding.tick(.5)!.previousPositions[5]).toBeCloseTo(0);
    });

    it('skips nested actors, flags duplicate names and retries a replaced proxy without a stale sweep', () => {
        const first = rig(), second = rig(), group = new THREE.Group();
        second.host.userData.levelObjectId = 'other';
        first.host.add(second.host, group);
        const binding = new SkinnedSurfaceBinding();
        expect(binding.capture(group, 'actor', 'Body', GARMENT_STEP)).toBe(true);
        first.host.remove(first.body);
        expect(binding.capture(group, 'actor', 'Body', GARMENT_STEP)).toBe(false);
        expect(binding.issue).toBe('missing');
        first.host.add(first.body);
        second.host.userData.levelObjectId = 'actor';
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(false);
        expect(binding.issue).toBe('ambiguous');
        second.host.userData.levelObjectId = 'other';
        first.joint.position.z = .48;
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        const resumed = binding.tick(1)!;
        expect(resumed.positions[5]).toBeCloseTo(.48);
        expect(resumed.previousPositions[5]).toBeCloseTo(.48);
    });

    it('revalidates exact name, unique ownership and replacement even after a successful binding', () => {
        const first = rig(), second = rig(), group = new THREE.Group(), binding = new SkinnedSurfaceBinding();
        first.host.add(group);
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        binding.tick(1);
        binding.accept();
        first.body.name = 'Old';
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(false);
        expect(binding.issue).toBe('missing');
        first.body.name = 'Body';
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        first.host.add(second.host);
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(false);
        expect(binding.issue).toBe('ambiguous');
        second.host.userData.levelObjectId = 'nested';
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        second.host.add(first.body);
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(false);
        expect(binding.issue).toBe('missing');
    });

    it('refreshes a detached bone on an external armature before sampling its deformed vertices', () => {
        const { host, body, joint } = rig(), group = new THREE.Group(), scene = new THREE.Group();
        const armature = new THREE.Group();
        scene.add(host, armature);
        host.add(group);
        const rootBone = body.skeleton.bones[0];
        armature.add(rootBone);
        body.bindMode = THREE.DetachedBindMode;
        scene.updateMatrixWorld(true);
        const binding = new SkinnedSurfaceBinding();
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        binding.tick(1);
        binding.accept();
        joint.position.z = .24;
        expect(binding.capture(group, 'actor', 'Body', 1)).toBe(true);
        expect(binding.tick(1)!.positions[5]).toBeCloseTo(.24, 6);
    });

    it('suspends unsupported proxy data instead of drawing the fitting torso', () => {
        const { host, body } = rig();
        const settings = readGarmentSettings({ id: 'g', type: 'garment', enabled: true, props: { collisionMesh: 'Body', wind: 0 } });
        const garment = new GarmentInstance(cookComponentGarment(createSleevelessTop()), 'cotton');
        host.add(garment.root);
        body.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(4097 * 3), 3));
        garment.advance(GARMENT_STEP, settings, 'actor');
        expect(garment.root.visible).toBe(false);
        expect(garment.torso.visible).toBe(false);
        expect(garment.simulation.time).toBe(0);
        garment.dispose();
    });

    it('replaces the fitting capsule with the moving skinned plane in the real simulation', () => {
        const { host, body } = rig();
        // A wide (+Z-facing) simple proxy at front panel height. Both skeleton and mesh move together.
        body.scale.set(2, 1.6, 1);
        body.position.set(0, .8, .08);
        const garment = new GarmentInstance(cookComponentGarment(undefined), 'cotton');
        host.add(garment.root);
        const settings = readGarmentSettings({ type: 'garment', id: 'g', enabled: true, props: { wind: 0, collisionMesh: 'Body' } });
        garment.advance(GARMENT_STEP, settings, 'actor');
        body.position.z = .15;
        garment.advance(GARMENT_STEP, settings, 'actor');
        expect(garment.root.visible).toBe(true);
        expect(garment.torso.visible).toBe(false);
        expect(garment.simulation.time).toBeCloseTo(2 * GARMENT_STEP);
        expect(garment.simulation.avatarContactStats?.testedFeatures).toBeGreaterThan(0);
        expect(garment.simulation.avatarContactStats?.corrections).toBeGreaterThan(0);
        garment.dispose();
    });
});
