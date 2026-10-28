import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { resolveCarry, weaponPlacements } from '../../runtime/weapons';
import { cloneCharacterModel, markMountedPart } from '../../utils/mountedParts';
import type { WeaponSettings } from '../../types';

const holster = { boneName: 'RightUpLeg', position: [20, 40, 10] as [number, number, number], rotation: [0, 90, -90] as [number, number, number] };
const sidearm: WeaponSettings = { id: 'p', name: 'Pistol', attachmentId: 'pistol-model', carry: holster };
const spare: WeaponSettings = { id: 'm', name: 'Machine Pistol', attachmentId: 'mp-model', startsOwned: false, carry: { ...holster, boneName: 'LeftUpLeg' } };
const knife: WeaponSettings = { id: 'k', name: 'Knife', attachmentId: 'knife-model' };

describe('weapon carry placements', () => {
  it('puts the held weapon in the hand while in use and at its carry placement at rest', () => {
    const weapons = [sidearm, spare];
    expect(weaponPlacements(weapons, { held: 0, ready: true, owned: [true, false] }).get('pistol-model')).toBe('hand');
    expect(weaponPlacements(weapons, { held: 0, ready: false, owned: [true, false] }).get('pistol-model')).toEqual(holster);
  });

  it('shows carried weapons that are not held at their placements and hides the rest', () => {
    const weapons = [sidearm, spare, knife];
    const notCarried = weaponPlacements(weapons, { held: 0, ready: true, owned: [true, false, true] });
    expect([notCarried.get('mp-model'), notCarried.get('knife-model')]).toEqual(['hidden', 'hidden']);
    const carried = weaponPlacements(weapons, { held: 2, ready: false, owned: [true, true, true] });
    expect(carried.get('mp-model')).toMatchObject({ boneName: 'LeftUpLeg' });
    expect(carried.get('pistol-model')).toEqual(holster);
    // No carry placement: the held weapon stays in the hand even at rest.
    expect(carried.get('knife-model')).toBe('hand');
  });

  it('keeps carry placements with a bone and finite offsets only', () => {
    expect(resolveCarry({ boneName: '  ', position: [0, 0, 0], rotation: [0, 0, 0] })).toBeNull();
    expect(resolveCarry({ boneName: ' Spine2 ', position: [1, Number.NaN, 3] as [number, number, number], rotation: [0, 0, 0] }))
      .toEqual({ boneName: 'Spine2', position: [0, 0, 0], rotation: [0, 0, 0] });
  });
});

describe('copies of a character', () => {
  it('leave out the parts other views mounted on the source', () => {
    const root = new THREE.Group();
    const hand = new THREE.Bone();
    hand.name = 'RightHand';
    root.add(hand);
    const gun = new THREE.Mesh();
    markMountedPart(gun);
    const ring = new THREE.Mesh();
    hand.add(gun, ring);

    const copy = cloneCharacterModel(root);
    const copiedHand = copy.getObjectByName('RightHand')!;
    expect(copiedHand.children).toHaveLength(1);
    expect(copiedHand.children[0].userData.auvraMountedPart).toBeUndefined();
    // The source keeps what is mounted on it.
    expect(hand.children).toHaveLength(2);
  });
});
