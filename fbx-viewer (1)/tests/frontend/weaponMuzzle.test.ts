import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { findWeaponMuzzle, weaponMuzzleSocket } from '../../runtime/weaponMuzzle';
import { generatedMuzzleSocketName, resolveWeapon } from '../../runtime/weapons';
import { aimMuzzleAt } from '../../components/Sandbox/CharacterIK';

/** A rifle along X: a thin barrel out to -1, a bulky stock at +1 and a grip hanging under the middle. */
const rifle = () => {
  const group = new THREE.Group();
  const part = (size: [number, number, number], at: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.set(...at);
    group.add(mesh);
  };
  part([1.2, 0.06, 0.06], [-0.4, 0.1, 0]); // barrel, -1 to 0.2
  part([0.6, 0.3, 0.12], [0.7, 0, 0]); // stock, 0.4 to 1
  part([0.1, 0.3, 0.08], [0.2, -0.2, 0]); // grip
  group.updateMatrixWorld(true);
  return group;
};

describe('weapon muzzle from the model', () => {
  it('finds the slimmer end of the longest extent, at the middle of that end', () => {
    const muzzle = findWeaponMuzzle(rifle())!;
    expect(muzzle.direction).toEqual([-1, 0, 0]);
    expect(muzzle.point[0]).toBeCloseTo(-1, 5);
    expect(muzzle.point[1]).toBeCloseTo(0.1, 5);
    expect(muzzle.point[2]).toBeCloseTo(0, 5);
  });

  it('takes the end away from the grip when the weapon has one', () => {
    // A grip at the far end makes the other end the muzzle, whatever its shape.
    expect(findWeaponMuzzle(rifle(), [-0.9, 0, 0])!.direction).toEqual([1, 0, 0]);
    expect(findWeaponMuzzle(rifle(), [0.2, -0.2, 0])!.direction).toEqual([-1, 0, 0]);
  });

  it('reads the model in its own frame, wherever it is placed', () => {
    const model = rifle();
    const parent = new THREE.Group();
    parent.position.set(5, 2, -3);
    parent.rotation.set(0.4, 1.1, -0.2);
    parent.add(model);
    model.scale.setScalar(30);
    expect(findWeaponMuzzle(model)!.point[0]).toBeCloseTo(-1, 5);
  });

  it('puts a socket at the muzzle on the holding bone, its +Z along the barrel, for a weapon with no socket', () => {
    const attachment = {
      object: rifle(), parentModelId: 'model', boneName: 'mixamorigRightHand',
      position: [1, 2, 3] as [number, number, number], rotation: [0, 90, 0] as [number, number, number], scale: [10, 10, 10] as [number, number, number],
    };
    const socket = weaponMuzzleSocket({ id: 'mg', muzzleSocket: null }, attachment)!;
    expect(socket.name).toBe(generatedMuzzleSocketName('mg'));
    expect(socket.boneName).toBe('mixamorigRightHand');
    // The muzzle (-1, 0.1, 0) scaled by 10 and turned 90 degrees about Y lands at (0, 1, 10), then offset.
    expect(socket.position[0]).toBeCloseTo(1, 4);
    expect(socket.position[1]).toBeCloseTo(3, 4);
    expect(socket.position[2]).toBeCloseTo(13, 4);
    const forward = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...socket.rotation.map(value => THREE.MathUtils.degToRad(value)) as [number, number, number]));
    // The barrel (-X) turned 90 degrees about Y points along +Z.
    expect(forward.z).toBeCloseTo(1, 4);
    expect(socket.flashConfig?.enabled).toBe(true);
    // A muzzle point set by hand wins over the one read from the model.
    expect(weaponMuzzleSocket({ id: 'mg', muzzleSocket: null, muzzlePoint: [0, 0, 0] }, attachment)!.position).toEqual([1, 2, 3]);
    // A weapon with its own socket, or no model, gets none.
    expect(weaponMuzzleSocket({ id: 'mg', muzzleSocket: 'Muzzle' }, attachment)).toBeNull();
    expect(weaponMuzzleSocket({ id: 'mg', muzzleSocket: null }, null)).toBeNull();
  });

  it('fires a weapon with a model but no socket from the generated one', () => {
    const base = { id: 'mg', name: 'MG', fireMode: 'auto', fireRate: 10, damage: 1, magazine: 0, reserve: -1, reloadSeconds: 1, spread: 0, pellets: 1, projectileSpeed: 50, startsOwned: true } as const;
    expect(resolveWeapon({ ...base, attachmentId: 'att' }).muzzleSocket).toBe(generatedMuzzleSocketName('mg'));
    expect(resolveWeapon({ ...base, attachmentId: 'att', muzzleSocket: 'Muzzle MG' }).muzzleSocket).toBe('Muzzle MG');
    expect(resolveWeapon({ ...base }).muzzleSocket).toBeNull();
  });
});

describe('barrel onto the crosshair', () => {
  /** Hips, a three-bone spine, and a muzzle out in front of the chest pointing a little off to the side. */
  const rig = () => {
    const hips = new THREE.Bone();
    const spine = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
    hips.add(spine[0]);
    spine[0].add(spine[1]);
    spine[1].add(spine[2]);
    spine.slice(1).forEach(bone => bone.position.set(0, 0.2, 0));
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.2, 0.3, 0.8);
    muzzle.rotation.y = THREE.MathUtils.degToRad(-10);
    spine[2].add(muzzle);
    hips.updateMatrixWorld(true);
    return { spine, muzzle };
  };
  const barrelOnto = (muzzle: THREE.Object3D, target: THREE.Vector3) => {
    muzzle.updateWorldMatrix(true, false);
    const at = muzzle.getWorldPosition(new THREE.Vector3());
    const barrel = new THREE.Vector3(0, 0, 1).transformDirection(muzzle.matrixWorld);
    return THREE.MathUtils.radToDeg(barrel.angleTo(target.clone().sub(at)));
  };

  it('turns the spine so the barrel points at the target', () => {
    const { spine, muzzle } = rig();
    const target = new THREE.Vector3(3, 2.5, 20);
    expect(barrelOnto(muzzle, target)).toBeGreaterThan(10);
    aimMuzzleAt(spine, muzzle, target, true, 1);
    expect(barrelOnto(muzzle, target)).toBeLessThan(0.5);
  });

  it('only turns about world up without pitch, and no further than its limit', () => {
    const { spine, muzzle } = rig();
    const target = new THREE.Vector3(3, 6, 20);
    aimMuzzleAt(spine, muzzle, target, false, 1);
    muzzle.updateWorldMatrix(true, false);
    const at = muzzle.getWorldPosition(new THREE.Vector3());
    const barrel = new THREE.Vector3(0, 0, 1).transformDirection(muzzle.matrixWorld);
    const toTarget = target.clone().sub(at);
    expect(Math.abs(Math.atan2(barrel.x, barrel.z) - Math.atan2(toTarget.x, toTarget.z))).toBeLessThan(1e-3);
    expect(barrel.y).toBeCloseTo(0, 5);
    // A target behind turns it at most 30 degrees.
    const { spine: other, muzzle: back } = rig();
    const before = new THREE.Vector3(0, 0, 1).transformDirection(back.matrixWorld);
    aimMuzzleAt(other, back, new THREE.Vector3(0, 0, -20), false, 1);
    const after = new THREE.Vector3(0, 0, 1).transformDirection(back.matrixWorld);
    expect(THREE.MathUtils.radToDeg(before.angleTo(after))).toBeLessThanOrEqual(30.001);
  });
});
