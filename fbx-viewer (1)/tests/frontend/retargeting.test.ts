import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { humanoidRole, matchHumanoidBones, retargetHumanoidClip } from '../../utils/retargeting';

describe('humanoidRole', () => {
  it('reads the same roles from Mixamo, Unreal, Rigify, Biped and plain names', () => {
    const schemes: Record<string, string[]> = {
      Hips: ['mixamorig:Hips', 'pelvis', 'DEF-pelvis', 'Bip01 Pelvis', 'Hips'],
      LeftUpperArm: ['mixamorigLeftArm', 'upperarm_l', 'DEF-upper_arm.L', 'Bip01 L UpperArm', 'LeftUpperArm'],
      LeftLowerArm: ['mixamorigLeftForeArm', 'lowerarm_l', 'DEF-forearm.L', 'Bip01 L Forearm', 'LeftLowerArm'],
      RightUpperLeg: ['mixamorigRightUpLeg', 'thigh_r', 'DEF-thigh.R', 'Bip01 R Thigh', 'RightThigh'],
      RightLowerLeg: ['mixamorigRightLeg', 'calf_r', 'DEF-shin.R', 'Bip01 R Calf', 'RightShin'],
      LeftFoot: ['mixamorigLeftFoot', 'foot_l', 'DEF-foot.L', 'Bip01 L Foot', 'LeftFoot'],
      LeftToes: ['mixamorigLeftToeBase', 'ball_l', 'DEF-toe.L', 'Bip01 L Toe0', 'LeftToes'],
      LeftShoulder: ['mixamorigLeftShoulder', 'clavicle_l', 'DEF-shoulder.L', 'Bip01 L Clavicle', 'LeftShoulder'],
      Head: ['mixamorigHead', 'head', 'DEF-head', 'Bip01 Head', 'Head'],
      LeftIndex2: ['mixamorigLeftHandIndex2', 'index_02_l', 'DEF-f_index.02.L'],
    };
    for (const [role, names] of Object.entries(schemes)) {
      for (const name of names) expect([name, humanoidRole(name)]).toEqual([name, role]);
    }
  });

  it('gives end, twist and IK helper bones no role', () => {
    for (const name of ['mixamorigHeadTop_End', 'upperarm_twist_01_l', 'ik_foot_l', 'Bip01 HeadNub', 'root']) {
      expect([name, humanoidRole(name)]).toEqual([name, null]);
    }
  });
});

/** A chain hips -> spine -> chest -> left arm, with each bone's rest rotation as given. */
const rig = (names: [string, string, string, string], rest: THREE.Quaternion[]) => {
  const root = new THREE.Group();
  const bones = names.map((name, index) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.quaternion.copy(rest[index]);
    bone.position.set(index === 3 ? 0.2 : 0, index === 0 ? 1 : 0.3, 0);
    return bone;
  });
  root.add(bones[0]);
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);
  bones[2].add(bones[3]);
  root.updateMatrixWorld(true);
  return { root, bones };
};

describe('retargetHumanoidClip', () => {
  it('turns a target bone the way its source bone turned, though their rest axes differ', () => {
    const identity = new THREE.Quaternion();
    // The source arm rests turned 90 degrees about Z; the target's rests turned about X.
    const sourceArmRest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const targetArmRest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3);
    const source = rig(['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine2', 'mixamorigLeftArm'], [identity, identity, identity, sourceArmRest]);
    const target = rig(['pelvis', 'spine_01', 'spine_03', 'upperarm_l'], [identity, identity, identity, targetArmRest]);

    // The source raises its arm: 40 degrees about Y in world space, on top of its rest pose.
    const raise = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(40));
    const raised = raise.clone().multiply(sourceArmRest);
    const clip = new THREE.AnimationClip('Raise', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [...sourceArmRest.toArray(), ...raised.toArray()]),
    ]);

    const pairs = matchHumanoidBones(target.bones, source.bones, target.root, source.root);
    expect(pairs.get(target.bones[3])).toBe(source.bones[3]);
    expect(pairs.get(target.bones[2])).toBe(source.bones[2]);
    const result = retargetHumanoidClip(target, source, clip, pairs, target.bones[0]);

    // Play the result on the target: the arm's world rotation is the same turn applied to its own rest.
    const mixer = new THREE.AnimationMixer(target.root);
    const action = mixer.clipAction(result);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(1);
    target.root.updateMatrixWorld(true);
    const expected = raise.clone().multiply(targetArmRest);
    const actual = target.bones[3].getWorldQuaternion(new THREE.Quaternion());
    expect(Math.abs(actual.dot(expected))).toBeCloseTo(1, 5);
  });

  it('lines an A-pose target up with a T-pose source, then turns it with the source', () => {
    /** Hips, spine, chest, upper arm and forearm, all resting unrotated; the forearm offset sets the arm's rest direction. */
    const arm = (names: string[], forearm: THREE.Vector3) => {
      const root = new THREE.Group();
      const offsets = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0.2, 0, 0), forearm];
      const bones = names.map((name, index) => {
        const bone = new THREE.Bone();
        bone.name = name;
        bone.position.copy(offsets[index]);
        return bone;
      });
      root.add(bones[0]);
      bones.slice(1).forEach((bone, index) => bones[index].add(bone));
      root.updateMatrixWorld(true);
      return { root, bones };
    };
    const source = arm(['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine2', 'mixamorigLeftArm', 'mixamorigLeftForeArm'], new THREE.Vector3(0.3, 0, 0));
    const target = arm(['pelvis', 'spine_01', 'spine_03', 'upperarm_l', 'lowerarm_l'], new THREE.Vector3(0.15, -0.26, 0));

    // The source lifts its straight-out arm 30 degrees about Z.
    const lift = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6);
    const clip = new THREE.AnimationClip('Lift', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, 0, 1, ...lift.toArray()]),
    ]);
    const pairs = matchHumanoidBones(target.bones, source.bones, target.root, source.root);
    const result = retargetHumanoidClip(target, source, clip, pairs, target.bones[0]);

    const mixer = new THREE.AnimationMixer(target.root);
    const action = mixer.clipAction(result);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const armDirection = () => {
      target.root.updateMatrixWorld(true);
      return target.bones[4].getWorldPosition(new THREE.Vector3()).sub(target.bones[3].getWorldPosition(new THREE.Vector3())).normalize();
    };
    // At the source's rest the target arm points straight out too, not down where its own rest has it.
    mixer.setTime(0);
    expect(armDirection().distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-4);
    mixer.setTime(1);
    expect(armDirection().distanceTo(new THREE.Vector3(1, 0, 0).applyQuaternion(lift))).toBeLessThan(1e-4);
  });

  it('scales the hips travel by the rigs\' hip heights', () => {
    const identity = new THREE.Quaternion();
    const source = rig(['Hips', 'Spine', 'Chest', 'LeftArm'], [identity, identity, identity, identity]);
    const target = rig(['pelvis', 'spine_01', 'spine_02', 'upperarm_l'], [identity, identity, identity, identity]);
    source.bones[0].position.y = 100; // centimetres
    source.root.updateMatrixWorld(true);
    const clip = new THREE.AnimationClip('Step', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 100, 0, 0, 100, 50]),
    ]);
    const pairs = matchHumanoidBones(target.bones, source.bones, target.root, source.root);
    const result = retargetHumanoidClip(target, source, clip, pairs, target.bones[0]);
    const hips = result.tracks.find(track => track.name === 'pelvis.position')!;
    // 50 cm forward on a 100 cm hip height is half a hip height on the 1-unit target.
    expect(Array.from(hips.values.slice(-3)).map(v => Number(v.toFixed(4)))).toEqual([0, 1, 0.5]);
  });
});
