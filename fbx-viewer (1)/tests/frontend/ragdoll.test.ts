import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildRagdollPlan, createRagdoll, RAGDOLL_COLLISION_GROUPS } from '../../runtime/ragdoll';
import { loadRuntimeRapier } from './rapierRuntime';

/** A T-posed Mixamo-style skeleton standing on the origin (about 1.8 units tall). */
const humanoid = (): { root: THREE.Group; bones: Record<string, THREE.Bone> } => {
  const root = new THREE.Group();
  const bones: Record<string, THREE.Bone> = {};
  const add = (name: string, parent: THREE.Object3D, position: [number, number, number]) => {
    const bone = new THREE.Bone();
    bone.name = `mixamorig:${name}`;
    bone.position.set(...position);
    parent.add(bone);
    bones[name] = bone;
    return bone;
  };
  const hips = add('Hips', root, [0, 1, 0]);
  const spine = add('Spine', hips, [0, 0.15, 0]);
  const neck = add('Neck', spine, [0, 0.4, 0]);
  add('Head', neck, [0, 0.1, 0]);
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    const arm = add(`${side}Arm`, spine, [0.2 * sign, 0.35, 0]);
    const fore = add(`${side}ForeArm`, arm, [0.28 * sign, 0, 0]);
    add(`${side}Hand`, fore, [0.25 * sign, 0, 0]);
    const thigh = add(`${side}UpLeg`, hips, [0.1 * sign, -0.05, 0]);
    const shin = add(`${side}Leg`, thigh, [0, -0.45, 0]);
    add(`${side}Foot`, shin, [0, -0.45, 0]);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
};

describe('ragdoll plan', () => {
  it('lays out every humanoid segment with positive capsule sizes and parents before children', () => {
    const { root, bones } = humanoid();
    const plan = buildRagdollPlan(root)!;
    expect(plan.segments.map(segment => segment.name)).toEqual([
      'pelvis', 'chest', 'head', 'upperArmL', 'lowerArmL', 'upperArmR', 'lowerArmR', 'thighL', 'shinL', 'thighR', 'shinR',
    ]);
    for (const segment of plan.segments) {
      expect(segment.radius).toBeGreaterThan(0);
      expect(segment.halfHeight).toBeGreaterThanOrEqual(0);
    }
    const thigh = plan.segments.find(segment => segment.name === 'thighL')!;
    expect(thigh.bone).toBe(bones.LeftUpLeg);
    expect(thigh.tip).toBe(bones.LeftLeg);
    expect(thigh.parent).toBe('pelvis');
    expect(thigh.halfHeight * 2 + thigh.radius * 2).toBeCloseTo(0.45, 5);
  });

  it('is null for a model without legs', () => {
    const root = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    root.add(hips);
    expect(buildRagdollPlan(root)).toBeNull();
  });
});

describe('ragdoll physics', () => {
  it('falls under gravity on its own, its parts not colliding with each other, and the bones follow the bodies', async () => {
    const rapier = await loadRuntimeRapier();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const ground = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(rapier.ColliderDesc.cuboid(20, 0.5, 20), ground);

    const { root, bones } = humanoid();
    const ragdoll = createRagdoll(world, rapier, buildRagdollPlan(root)!);
    expect(ragdoll.bodies.size).toBe(11);
    world.forEachCollider(collider => {
      if (collider.parent()?.handle !== ground.handle) expect(collider.collisionGroups()).toBe(RAGDOLL_COLLISION_GROUPS);
    });

    const headStart = bones.Head.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < 180; i++) {
      world.step();
      ragdoll.step();
    }
    const head = bones.Head.getWorldPosition(new THREE.Vector3());
    // The body collapsed onto the ground and stays above it.
    expect(head.y).toBeLessThan(headStart.y - 0.5);
    expect(head.y).toBeGreaterThan(-0.2);
    // Bone lengths are kept: the shin still ends 0.45 from the knee.
    const knee = bones.LeftLeg.getWorldPosition(new THREE.Vector3());
    const foot = bones.LeftFoot.getWorldPosition(new THREE.Vector3());
    expect(knee.distanceTo(foot)).toBeCloseTo(0.45, 3);
    // The pelvis bone sits where its body is.
    const pelvis = ragdoll.bodies.get('pelvis')!.translation();
    const hips = bones.Hips.getWorldPosition(new THREE.Vector3());
    expect(hips.distanceTo(new THREE.Vector3(pelvis.x, pelvis.y, pelvis.z))).toBeLessThan(0.2);

    ragdoll.dispose();
    let remaining = 0;
    world.forEachRigidBody(() => { remaining++; });
    expect(remaining).toBe(1);
    world.free();
  });
});
