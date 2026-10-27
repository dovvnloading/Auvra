import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimPitch, resolveCharacterIK, turnBoneAboutWorldAxis } from '../../components/Sandbox/CharacterIK';
import { aimCameraOffset, DEFAULT_AIM_OFFSETS } from '../../types';

describe('aim view and aim pose', () => {
  it('aims from the eyes by default and from behind the shoulder when asked', () => {
    expect(aimCameraOffset({})).toEqual(DEFAULT_AIM_OFFSETS.scope);
    expect(aimCameraOffset({ aimView: 'shoulder' })).toEqual(DEFAULT_AIM_OFFSETS.shoulder);
    expect(DEFAULT_AIM_OFFSETS.shoulder[2]).toBeLessThan(0);
    // An offset set by hand wins over the view's default.
    expect(aimCameraOffset({ aimView: 'shoulder', aimOffset: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it('leans by the camera pitch, up positive, within limits', () => {
    const up30 = new THREE.Vector3(0, Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6));
    expect(aimPitch(up30, 1)).toBeCloseTo(Math.PI / 6, 6);
    expect(aimPitch(up30, 0.5)).toBeCloseTo(Math.PI / 12, 6);
    expect(aimPitch(new THREE.Vector3(0, -1, 0), 1)).toBeCloseTo(-THREE.MathUtils.degToRad(60), 6);
    expect(resolveCharacterIK({ aimPitch: true }).aimPitch).toBe(true);
    expect(resolveCharacterIK(undefined).aimPitch).toBe(false);
  });

  it('turns a bone about a world axis under a turned parent', () => {
    const parent = new THREE.Object3D();
    parent.rotation.y = Math.PI / 2;
    const bone = new THREE.Object3D();
    bone.position.set(0, 1, 0);
    parent.add(bone);
    const tip = new THREE.Object3D();
    tip.position.set(0, 1, 0);
    bone.add(tip);
    parent.updateMatrixWorld(true);
    // A quarter turn about world +X tips the bone's upward tip toward +Z.
    turnBoneAboutWorldAxis(bone, new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const tipWorld = tip.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()));
    expect(tipWorld.x).toBeCloseTo(0, 6);
    expect(tipWorld.y).toBeCloseTo(0, 6);
    expect(tipWorld.z).toBeCloseTo(1, 6);
  });
});
