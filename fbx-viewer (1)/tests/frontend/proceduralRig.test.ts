import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RIG_CONSTRAINT, ProceduralRig, readRigConstraints, twistAbout, type RigConstraint } from '../../runtime/proceduralRig';

/*
 * The procedural rig on a small chain of bones: aim within a limit, copy and offset rotations, limits,
 * lag that follows late and settles, and twist spread from another bone.
 */

const chain = () => {
  const root = new THREE.Bone();
  root.name = 'root';
  const neck = new THREE.Bone();
  neck.name = 'neck';
  neck.position.set(0, 1, 0);
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.set(0, 0.3, 0);
  root.add(neck);
  neck.add(head);
  root.updateWorldMatrix(true, true);
  const bones = new Map([root, neck, head].map(bone => [bone.name, bone]));
  return { root, neck, head, find: (name: string) => bones.get(name) ?? null };
};

const constraint = (overrides: Partial<RigConstraint>): RigConstraint => ({ ...DEFAULT_RIG_CONSTRAINT, ...overrides });
const forwardOf = (bone: THREE.Object3D) => new THREE.Vector3(0, 0, 1).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));

describe('rig constraints', () => {
  it('read from props, in range, at most 32', () => {
    const read = readRigConstraints({ constraints: [{ kind: 'warp', weight: 4, maxAngle: -1, axis: 'w', target: { kind: 'object', id: 7 } }, ...Array.from({ length: 40 }, () => ({}))] });
    expect(read).toHaveLength(32);
    expect(read[0]).toMatchObject({ kind: 'aim', weight: 1, maxAngle: 0, axis: 'z', target: { kind: 'camera' } });
    expect(readRigConstraints({})).toEqual([]);
  });

  it('aims an axis at the target, never further than its limit, and as much as its weight', () => {
    const { head, find } = chain();
    const rig = new ProceduralRig([constraint({ bone: 'head', axis: 'z', maxAngle: 90 })]);
    const target = new THREE.Vector3(5, 1.3, 0);
    rig.apply(find, () => target, 1 / 60);
    head.updateWorldMatrix(true, false);
    expect(forwardOf(head).angleTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-4);

    const limited = chain();
    new ProceduralRig([constraint({ bone: 'head', maxAngle: 30 })]).apply(limited.find, () => target, 1 / 60);
    limited.head.updateWorldMatrix(true, false);
    expect(forwardOf(limited.head).angleTo(new THREE.Vector3(0, 0, 1)) / (Math.PI / 180)).toBeCloseTo(30, 3);

    const half = chain();
    new ProceduralRig([constraint({ bone: 'head', weight: 0.5, maxAngle: 90 })]).apply(half.find, () => target, 1 / 60);
    half.head.updateWorldMatrix(true, false);
    expect(forwardOf(half.head).angleTo(new THREE.Vector3(0, 0, 1)) / (Math.PI / 180)).toBeCloseTo(45, 3);

    // A head the animation tips down turns to a target at its side without rolling (its sideways axis stays level).
    const tipped = chain();
    tipped.head.rotation.x = 0.5;
    tipped.root.updateWorldMatrix(true, true);
    new ProceduralRig([constraint({ bone: 'head', maxAngle: 120 })]).apply(tipped.find, () => target, 1 / 60);
    tipped.head.updateWorldMatrix(true, false);
    expect(forwardOf(tipped.head).angleTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-4);
    const sideways = new THREE.Vector3(1, 0, 0).applyQuaternion(tipped.head.getWorldQuaternion(new THREE.Quaternion()));
    expect(Math.abs(sideways.y)).toBeLessThan(1e-4);

    // No target this frame: the aim rests.
    const resting = chain();
    new ProceduralRig([constraint({ bone: 'head' })]).apply(resting.find, () => null, 1 / 60);
    expect(resting.head.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('copies, offsets and limits rotations', () => {
    const { neck, head, find } = chain();
    neck.quaternion.setFromEuler(new THREE.Euler(0.2, 0.4, 0, 'XYZ'));
    new ProceduralRig([constraint({ kind: 'copyRotation', bone: 'head', source: 'neck', axes: [false, true, false] })]).apply(find, () => null, 0);
    const copied = new THREE.Euler().setFromQuaternion(head.quaternion, 'XYZ');
    expect(copied.x).toBeCloseTo(0);
    expect(copied.y).toBeCloseTo(0.4);

    new ProceduralRig([constraint({ kind: 'offset', bone: 'head', angles: [0, 0, 30] })]).apply(find, () => null, 0);
    expect(new THREE.Euler().setFromQuaternion(head.quaternion, 'XYZ').z).toBeCloseTo(30 * Math.PI / 180, 4);

    head.quaternion.setFromEuler(new THREE.Euler(1, -1, 0.1, 'XYZ'));
    new ProceduralRig([constraint({ kind: 'limit', bone: 'head', angles: [-20, -20, -20], max: [20, 20, 20] })]).apply(find, () => null, 0);
    const limited = new THREE.Euler().setFromQuaternion(head.quaternion, 'XYZ');
    for (const value of [limited.x, limited.y]) expect(Math.abs(value)).toBeLessThanOrEqual(20 * Math.PI / 180 + 1e-4);
    expect(limited.z).toBeCloseTo(0.1, 3);
  });

  it('lags behind a sudden turn, then settles on it', () => {
    const { head, find } = chain();
    const rig = new ProceduralRig([constraint({ kind: 'lag', bone: 'head', stiffness: 8, bounce: 0.2 })]);
    rig.apply(find, () => null, 1 / 60);
    const turned = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1, 0));
    const angles: number[] = [];
    for (let i = 0; i < 180; i++) {
      head.quaternion.copy(turned);
      rig.apply(find, () => null, 1 / 60);
      angles.push(head.quaternion.angleTo(turned));
    }
    expect(angles[0]).toBeGreaterThan(0.8);
    expect(angles[20]).toBeLessThan(angles[0]);
    expect(angles[179]).toBeLessThan(0.01);
  });

  it('spreads a share of another bone twist about an axis', () => {
    const { neck, head, find } = chain();
    neck.quaternion.setFromEuler(new THREE.Euler(0.5, 0.8, 0, 'XYZ'));
    const twist = twistAbout(neck.quaternion, new THREE.Vector3(0, 1, 0));
    // The twist is about the axis alone.
    expect(Math.abs(twist.x) + Math.abs(twist.z)).toBeLessThan(1e-9);
    new ProceduralRig([constraint({ kind: 'twist', bone: 'head', source: 'neck', axis: 'y', weight: 0.5 })]).apply(find, () => null, 0);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(head.quaternion.w)));
    expect(angle).toBeCloseTo((2 * Math.acos(Math.abs(twist.w))) / 2, 4);
  });
});
