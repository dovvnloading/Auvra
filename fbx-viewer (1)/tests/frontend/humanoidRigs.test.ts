import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { prepareAnimationClips } from '../../utils/animationBinding';
import { inferHumanoidRoles } from '../../utils/humanoidShape';
import { humanoidRole, humanoidRoles, reduceKeys } from '../../utils/retargeting';

/** Parent, offset from the parent: a figure 1.8 tall, in a T-pose, facing +Z with its left at +X. */
const FIGURE: Record<string, [string | null, [number, number, number]]> = {
  hips: [null, [0, 1, 0]],
  spine: ['hips', [0, 0.15, 0]],
  chest: ['spine', [0, 0.25, 0]],
  neck: ['chest', [0, 0.15, 0]],
  head: ['neck', [0, 0.1, 0]],
  headTop: ['head', [0, 0.2, 0]],
  shoulderL: ['chest', [0.05, 0.1, 0]],
  upperArmL: ['shoulderL', [0.12, 0, 0]],
  lowerArmL: ['upperArmL', [0.28, 0, 0]],
  handL: ['lowerArmL', [0.26, 0, 0]],
  thumbL: ['handL', [0.03, 0, 0.04]],
  thumbL2: ['thumbL', [0.03, 0, 0.01]],
  indexL: ['handL', [0.08, 0, 0.02]],
  indexL2: ['indexL', [0.03, 0, 0]],
  pinkyL: ['handL', [0.07, 0, -0.03]],
  pinkyL2: ['pinkyL', [0.03, 0, 0]],
  shoulderR: ['chest', [-0.05, 0.1, 0]],
  upperArmR: ['shoulderR', [-0.12, 0, 0]],
  lowerArmR: ['upperArmR', [-0.28, 0, 0]],
  handR: ['lowerArmR', [-0.26, 0, 0]],
  thumbR: ['handR', [-0.03, 0, 0.04]],
  thumbR2: ['thumbR', [-0.03, 0, 0.01]],
  indexR: ['handR', [-0.08, 0, 0.02]],
  indexR2: ['indexR', [-0.03, 0, 0]],
  pinkyR: ['handR', [-0.07, 0, -0.03]],
  pinkyR2: ['pinkyR', [-0.03, 0, 0]],
  upperLegL: ['hips', [0.1, -0.05, 0]],
  lowerLegL: ['upperLegL', [0, -0.45, 0]],
  footL: ['lowerLegL', [0, -0.42, 0]],
  toeL: ['footL', [0, -0.05, 0.12]],
  toeEndL: ['toeL', [0, 0, 0.06]],
  upperLegR: ['hips', [-0.1, -0.05, 0]],
  lowerLegR: ['upperLegR', [0, -0.45, 0]],
  footR: ['lowerLegR', [0, -0.42, 0]],
  toeR: ['footR', [0, -0.05, 0.12]],
  toeEndR: ['toeR', [0, 0, 0.06]],
};

/** Builds the figure with bones named by `rename`, each offset put through `move` (mirroring, scaling). */
const figure = (rename: (name: string, index: number) => string = (name) => name, move: (offset: THREE.Vector3) => THREE.Vector3 = (offset) => offset) => {
  const root = new THREE.Group();
  const made = new Map<string, THREE.Bone>();
  Object.entries(FIGURE).forEach(([name, [parent, offset]], index) => {
    const bone = new THREE.Bone();
    bone.name = rename(name, index);
    bone.position.copy(move(new THREE.Vector3(...offset)));
    (parent ? made.get(parent)! : root).add(bone);
    made.set(name, bone);
  });
  root.updateMatrixWorld(true);
  return { root, made, bones: [...made.values()] };
};

const NAMED_ROLES: Record<string, string> = {
  hips: 'Hips', spine: 'Spine', chest: 'Spine', neck: 'Neck', head: 'Head',
  shoulderL: 'LeftShoulder', upperArmL: 'LeftUpperArm', lowerArmL: 'LeftLowerArm', handL: 'LeftHand',
  shoulderR: 'RightShoulder', upperArmR: 'RightUpperArm', lowerArmR: 'RightLowerArm', handR: 'RightHand',
  upperLegL: 'LeftUpperLeg', lowerLegL: 'LeftLowerLeg', footL: 'LeftFoot', toeL: 'LeftToes',
  upperLegR: 'RightUpperLeg', lowerLegR: 'RightLowerLeg', footR: 'RightFoot', toeR: 'RightToes',
  thumbL: 'LeftThumb1', indexL: 'LeftIndex1', pinkyL: 'LeftMiddle1',
};

describe('reading a skeleton from its shape', () => {
  it('finds the parts of a figure whose bones say nothing', () => {
    const { root, made, bones } = figure((_, index) => `Bone.${String(index).padStart(3, '0')}`);
    const roles = inferHumanoidRoles(bones, root);
    for (const [name, role] of Object.entries(NAMED_ROLES)) expect([name, roles.get(made.get(name)!)]).toEqual([name, role]);
  });

  it('tells left from right on a figure facing the other way', () => {
    // Facing -Z, its left hand is at -X.
    const { root, made, bones } = figure((_, index) => `b${index}`, (offset) => offset.clone().setZ(-offset.z).setX(-offset.x));
    const roles = inferHumanoidRoles(bones, root);
    expect(roles.get(made.get('handL')!)).toBe('LeftHand');
    expect(roles.get(made.get('footR')!)).toBe('RightFoot');
  });

  it('reads an A-pose as well as a T-pose', () => {
    const { root, made, bones } = figure((_, index) => `b${index}`, (offset) => offset);
    for (const side of ['L', 'R']) made.get(`upperArm${side}`)!.rotation.z = side === 'L' ? -0.7 : 0.7;
    root.updateMatrixWorld(true);
    const roles = inferHumanoidRoles(bones, root);
    expect(roles.get(made.get('lowerArmL')!)).toBe('LeftLowerArm');
    expect(roles.get(made.get('handR')!)).toBe('RightHand');
  });

  it('finds arms and hands without any finger bones', () => {
    const { root, made } = figure((_, index) => `b${index}`);
    const noFingers = [...made.entries()].filter(([name]) => !/thumb|index|pinky/.test(name)).map(([, bone]) => bone);
    const roles = inferHumanoidRoles(noFingers, root);
    expect(roles.get(made.get('upperArmL')!)).toBe('LeftUpperArm');
    expect(roles.get(made.get('handL')!)).toBe('LeftHand');
    expect(roles.get(made.get('shoulderL')!)).toBe('LeftShoulder');
  });

  it('does not take an end bone as long as the forearm for part of the arm', () => {
    const { root, made } = figure((_, index) => `b${index}`);
    const tips = (['L', 'R'] as const).map((side) => {
      const reach = side === 'L' ? 0.3 : -0.3;
      made.get(`hand${side}`)!.position.x = reach;
      const tip = new THREE.Bone();
      tip.position.x = reach;
      made.get(`hand${side}`)!.add(tip);
      return tip;
    });
    root.updateMatrixWorld(true);
    const noFingers = [...made.entries()].filter(([name]) => !/thumb|index|pinky/.test(name)).map(([, bone]) => bone);
    const roles = inferHumanoidRoles([...noFingers, ...tips], root);
    expect(roles.get(made.get('upperArmL')!)).toBe('LeftUpperArm');
    expect(roles.get(made.get('lowerArmR')!)).toBe('RightLowerArm');
    expect(roles.get(made.get('handL')!)).toBe('LeftHand');
    expect(roles.has(tips[0])).toBe(false);
  });

  it('says nothing of a skeleton that is no figure', () => {
    const root = new THREE.Group();
    let parent: THREE.Object3D = root;
    const bones: THREE.Object3D[] = [];
    for (let i = 0; i < 12; i += 1) {
      const bone = new THREE.Bone();
      bone.position.set(0, 0.2, 0);
      parent.add(bone);
      bones.push(bone);
      parent = bone;
    }
    root.updateMatrixWorld(true);
    expect(inferHumanoidRoles(bones, root).size).toBe(0);
  });
});

describe('reading a bone from its name', () => {
  it('takes a side run into the limb at either end', () => {
    expect(humanoidRole('upperarml')).toBe('LeftUpperArm');
    expect(humanoidRole('LUpperLeg')).toBe('LeftUpperLeg');
    expect(humanoidRole('FootL')).toBe('LeftFoot');
    expect(humanoidRole('thighr')).toBe('RightUpperLeg');
    expect(humanoidRole('RForeArm')).toBe('RightLowerArm');
  });

  it('knows a few more words for the same parts', () => {
    expect(humanoidRole('Abdomen')).toBe('Spine');
    expect(humanoidRole('Fist.L')).toBe('LeftHand');
  });

  it('still reads the common schemes, and leaves helpers out', () => {
    expect(humanoidRole('mixamorig:LeftUpLeg')).toBe('LeftUpperLeg');
    expect(humanoidRole('thigh_l')).toBe('LeftUpperLeg');
    expect(humanoidRole('Bip01 L Thigh')).toBe('LeftUpperLeg');
    expect(humanoidRole('upperarm_twist_01_l')).toBeNull();
    expect(humanoidRole('PoleTarget.L')).toBeNull();
    expect(humanoidRole('Foot.L_end')).toBeNull();
  });
});

describe('what a bone is for', () => {
  it('goes by names, then shape for what the names leave out', () => {
    const { root, made, bones } = figure((name) => (name === 'hips' ? 'Hips' : name === 'upperLegL' ? 'thigh_l' : `b_${Object.keys(FIGURE).indexOf(name)}`));
    const roles = humanoidRoles(bones, root);
    expect(roles.get(made.get('hips')!)).toBe('Hips');
    expect(roles.get(made.get('upperLegL')!)).toBe('LeftUpperLeg');
    expect(roles.get(made.get('lowerArmR')!)).toBe('RightLowerArm');
  });

  it('lets the model say what a bone is, and that it is nothing', () => {
    const { root, made, bones } = figure();
    const roles = humanoidRoles(bones, root, [{ role: 'LeftHand', bone: 'thumbL' }, { role: '', bone: 'head' }]);
    expect(roles.get(made.get('thumbL')!)).toBe('LeftHand');
    // A role goes to one bone.
    expect(roles.get(made.get('handL')!)).not.toBe('LeftHand');
    expect(roles.has(made.get('head')!)).toBe(false);
  });

  it('ignores a stored bone the model no longer has', () => {
    const { root, bones } = figure();
    expect(() => humanoidRoles(bones, root, [{ role: 'Head', bone: 'nothing' }])).not.toThrow();
  });
});

describe('reducing keys', () => {
  it('drops what a straight line between its neighbours gives', () => {
    const times = new Float32Array([0, 1, 2, 3, 4]);
    const values = new Float32Array([0, 1, 2, 3, 4]);
    const reduced = reduceKeys(times, values, 1, 1e-4);
    expect([...reduced.times]).toEqual([0, 4]);
  });

  it('keeps a turn in the curve', () => {
    const times = new Float32Array([0, 1, 2, 3, 4]);
    const values = new Float32Array([0, 1, 2, 1, 0]);
    expect([...reduceKeys(times, values, 1, 1e-4).times]).toEqual([0, 2, 4]);
  });

  it('holds its tolerance across every key it drops, on every component', () => {
    const count = 200;
    const times = Float32Array.from({ length: count }, (_, i) => i / 30);
    const values = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      values[i * 2] = Math.sin(i * 0.05);
      values[i * 2 + 1] = i * 0.01;
    }
    const tolerance = 1e-3;
    const reduced = reduceKeys(times, values, 2, tolerance);
    expect(reduced.times.length).toBeLessThan(count);
    // Read back along the straight lines between the keys that stayed.
    const at = (time: number, component: number): number => {
      let segment = 0;
      while (segment < reduced.times.length - 2 && reduced.times[segment + 1] < time) segment += 1;
      const blend = (time - reduced.times[segment]) / (reduced.times[segment + 1] - reduced.times[segment]);
      return reduced.values[segment * 2 + component] + (reduced.values[(segment + 1) * 2 + component] - reduced.values[segment * 2 + component]) * blend;
    };
    for (let i = 0; i < count; i += 1) {
      expect(Math.abs(at(times[i], 0) - values[i * 2])).toBeLessThan(tolerance * 1.01);
      expect(Math.abs(at(times[i], 1) - values[i * 2 + 1])).toBeLessThan(tolerance * 1.01);
    }
  });

  it('leaves two keys alone', () => {
    const times = new Float32Array([0, 1]);
    expect(reduceKeys(times, new Float32Array([5, 5]), 1, 1)).toEqual({ times, values: new Float32Array([5, 5]) });
  });
});

/** Binds a mesh to every bone of a figure, so it counts as a rig with a bind pose. */
const bound = (rig: ReturnType<typeof figure>) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  rig.root.add(mesh);
  rig.root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(rig.bones as THREE.Bone[]));
  return mesh;
};

const walk = (sourceRoot: THREE.Object3D) => {
  // The left thigh swings forward and the knee bends over a second; the hips drop a little.
  const swing = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.8, 0, 0));
  const bend = new THREE.Quaternion().setFromEuler(new THREE.Euler(1, 0, 0));
  void sourceRoot;
  return new THREE.AnimationClip('Walk', 1, [
    new THREE.QuaternionKeyframeTrack('upperLegL.quaternion', [0, 1], [0, 0, 0, 1, ...swing.toArray()]),
    new THREE.QuaternionKeyframeTrack('lowerLegL.quaternion', [0, 1], [0, 0, 0, 1, ...bend.toArray()]),
    new THREE.VectorKeyframeTrack('hips.position', [0, 1], [0, 1, 0, 0, 0.9, 0.2]),
  ]);
};

const sample = (root: THREE.Object3D, clip: THREE.AnimationClip, time: number, bone: THREE.Object3D): THREE.Vector3 => {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(time);
  root.updateMatrixWorld(true);
  const place = root.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
  action.stop();
  mixer.uncacheRoot(root);
  root.updateMatrixWorld(true);
  return place;
};

describe('retargeting between rigs of different proportions', () => {
  it('bends the leg to put the foot where the source\'s is, scaled', () => {
    const source = figure();
    // Same hip height, but long thighs and short shins.
    const target = figure((name) => `t_${name}`, (offset) => offset);
    target.made.get('lowerLegL')!.position.y = -0.55;
    target.made.get('footL')!.position.y = -0.32;
    target.made.get('lowerLegR')!.position.y = -0.55;
    target.made.get('footR')!.position.y = -0.32;
    target.root.updateMatrixWorld(true);
    bound(target);
    const clip = walk(source.root);
    const prepared = prepareAnimationClips(target.root, source.root, [clip]);
    expect(prepared.mode).toBe('retargeted');
    const [retargeted] = prepared.clips;
    const sourceFoot = sample(source.root, clip, 1, source.made.get('footL')!);
    const targetFoot = sample(target.root, retargeted, 1, target.made.get('footL')!);
    expect(targetFoot.distanceTo(sourceFoot)).toBeLessThan(0.005);
  });

  it('keeps a leg\'s length while it does', () => {
    const source = figure();
    const target = figure((name) => `t_${name}`);
    target.made.get('lowerLegL')!.position.y = -0.55;
    target.made.get('footL')!.position.y = -0.32;
    target.root.updateMatrixWorld(true);
    bound(target);
    const [retargeted] = prepareAnimationClips(target.root, source.root, [walk(source.root)]).clips;
    const knee = sample(target.root, retargeted, 1, target.made.get('lowerLegL')!);
    const ankle = sample(target.root, retargeted, 1, target.made.get('footL')!);
    expect(knee.distanceTo(ankle)).toBeCloseTo(0.32, 3);
  });

  it('tells a foot that is not on the leg where to go', () => {
    const source = figure();
    const target = figure((name) => `t_${name}`);
    // A free foot, as IK rigs have: it hangs from the root, not the shin.
    const foot = target.made.get('footL')!;
    const place = target.root.worldToLocal(foot.getWorldPosition(new THREE.Vector3()));
    target.root.add(foot);
    foot.position.copy(place);
    target.root.updateMatrixWorld(true);
    bound(target);
    const clip = walk(source.root);
    const [retargeted] = prepareAnimationClips(target.root, source.root, [clip]).clips;
    expect(retargeted.tracks.some((track) => track.name === 't_footL.position')).toBe(true);
    const sourceFoot = sample(source.root, clip, 1, source.made.get('footL')!);
    expect(sample(target.root, retargeted, 1, foot).distanceTo(sourceFoot)).toBeLessThan(0.005);
  });

  it('samples at the clip\'s own rate', () => {
    const source = figure();
    const target = figure((name) => `t_${name}`);
    bound(target);
    const times = Array.from({ length: 61 }, (_, i) => i / 60);
    const values = times.flatMap((time) => new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(time * 40) * 0.5, 0, 0)).toArray());
    const clip = new THREE.AnimationClip('Fast', 1, [new THREE.QuaternionKeyframeTrack('upperLegL.quaternion', times, values), new THREE.VectorKeyframeTrack('hips.position', [0, 1], [0, 1, 0, 0, 1, 0])]);
    const [retargeted] = prepareAnimationClips(target.root, source.root, [clip]).clips;
    const track = retargeted.tracks.find((candidate) => candidate.name === 't_upperLegL.quaternion')!;
    // Far more keys than 30 a second could hold.
    expect(track.times.length).toBeGreaterThan(40);
  });

  it('writes no track for a bone that never leaves its rest pose', () => {
    const source = figure();
    const target = figure((name) => `t_${name}`);
    bound(target);
    const [retargeted] = prepareAnimationClips(target.root, source.root, [walk(source.root)]).clips;
    expect(retargeted.tracks.some((track) => track.name === 't_headTop.quaternion')).toBe(false);
    expect(retargeted.tracks.some((track) => track.name === 't_hips.position')).toBe(true);
  });

  it('plays a clip across rigs whose names say nothing', () => {
    const source = figure();
    const target = figure((_, index) => `Bone.${index}`);
    bound(target);
    const prepared = prepareAnimationClips(target.root, source.root, [walk(source.root)]);
    expect(prepared.mode).toBe('retargeted');
    expect(prepared.matchedBones).toBeGreaterThan(15);
  });
});
