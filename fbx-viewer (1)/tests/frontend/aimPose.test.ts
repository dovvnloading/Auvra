import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimPitch, aimYaw, resolveCharacterIK, turnBoneAboutWorldAxis } from '../../components/Sandbox/CharacterIK';
import { aimFacing, TURN_IN_PLACE_END, TURN_IN_PLACE_START } from '../../components/Sandbox/hooks/usePlayerPhysics';
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

  it('turns the spine by how far the aim heads from the body, left positive, within limits', () => {
    const heading = (degrees: number) => {
      const angle = THREE.MathUtils.degToRad(degrees);
      return new THREE.Vector3(Math.sin(angle), -0.3, Math.cos(angle));
    };
    expect(aimYaw(heading(40), heading(0), 1)).toBeCloseTo(THREE.MathUtils.degToRad(40), 6);
    expect(aimYaw(heading(-30), heading(20), 0.5)).toBeCloseTo(THREE.MathUtils.degToRad(-25), 6);
    // The short way round across the back, and no further than the limit.
    expect(aimYaw(heading(170), heading(-170), 1)).toBeCloseTo(THREE.MathUtils.degToRad(-20), 6);
    expect(aimYaw(heading(150), heading(0), 1)).toBeCloseTo(THREE.MathUtils.degToRad(100), 6);
  });

  it('keeps the feet put while the aim swings a little, then turns in place until facing it', () => {
    const start = THREE.MathUtils.radToDeg(TURN_IN_PLACE_START);
    const yaw = (degrees: number) => THREE.MathUtils.degToRad(degrees);
    expect(aimFacing(0, yaw(start - 5), false, false)).toEqual({ target: null, turning: false });
    expect(aimFacing(0, yaw(start + 5), false, false)).toEqual({ target: yaw(start + 5), turning: true });
    // Once turning, it carries on until it faces the aim.
    expect(aimFacing(yaw(30), yaw(60), false, true)).toEqual({ target: yaw(60), turning: true });
    expect(aimFacing(yaw(60) - TURN_IN_PLACE_END / 2, yaw(60), false, true)).toEqual({ target: null, turning: false });
    // Moving, it faces the aim at once.
    expect(aimFacing(0, yaw(20), true, false)).toEqual({ target: yaw(20), turning: false });
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
