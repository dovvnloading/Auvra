import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mirrorModelClips, prepareAnimationClips } from '../../utils/animationBinding';
import { isPartCopy, originalBone } from '../../utils/partCopies';

/** Name, parent, offset: a small humanoid. */
const HUMANOID: [string, string | null, [number, number, number]][] = [
  ['Hips', null, [0, 1, 0]], ['Spine', 'Hips', [0, 0.2, 0]], ['Neck', 'Spine', [0, 0.4, 0]], ['Head', 'Neck', [0, 0.1, 0]],
  ['LeftArm', 'Spine', [0.2, 0.35, 0]], ['LeftForeArm', 'LeftArm', [0.3, 0, 0]], ['RightArm', 'Spine', [-0.2, 0.35, 0]], ['RightForeArm', 'RightArm', [-0.3, 0, 0]],
  ['LeftUpLeg', 'Hips', [0.1, -0.1, 0]], ['LeftLeg', 'LeftUpLeg', [0, -0.45, 0]], ['RightUpLeg', 'Hips', [-0.1, -0.1, 0]], ['RightLeg', 'RightUpLeg', [0, -0.45, 0]],
];

const skeleton = (prefix: string) => {
  const root = new THREE.Group();
  const byName = new Map<string, THREE.Bone>();
  for (const [name, parent, offset] of HUMANOID) {
    const bone = new THREE.Bone();
    bone.name = prefix + name;
    bone.position.set(...offset);
    (parent ? byName.get(parent)! : root).add(bone);
    byName.set(name, bone);
  }
  root.updateMatrixWorld(true);
  return { root, byName };
};

/** A character split into a body and eyes, as Mixamo's are: the body is bound to a copy of the head. */
const splitCharacter = () => {
  const { root, byName } = skeleton('mixamorig');
  const head = byName.get('Head')!;
  const headCopy = new THREE.Bone();
  headCopy.name = 'mixamorigHead_1';
  head.add(headCopy);
  root.updateMatrixWorld(true);
  const body = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  body.name = 'Body';
  root.add(body);
  body.bind(new THREE.Skeleton([...[...byName.values()].filter(bone => bone !== head), headCopy]));
  const eyes = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  eyes.name = 'Eyes';
  root.add(eyes);
  eyes.bind(new THREE.Skeleton([byName.get('Neck')!, head]));
  return { root, head, headCopy };
};

describe('parts\' copies of shared bones', () => {
  it('are told from real bones by their number and their lack of offset', () => {
    const { head, headCopy } = splitCharacter();
    expect(isPartCopy(headCopy)).toBe(true);
    expect(originalBone(headCopy)).toBe(head);
    expect(isPartCopy(head)).toBe(false);
    // A numbered joint that sits away from its parent is a real bone.
    const tail = new THREE.Bone();
    tail.name = 'mixamorigHead_2';
    tail.position.set(0, 0.1, 0);
    head.add(tail);
    expect(isPartCopy(tail)).toBe(false);
  });

  it('take no tracks of a clip retargeted from another rig: the original bone turns and every part follows', () => {
    const target = splitCharacter();
    const source = skeleton('');
    const nod = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    const clip = new THREE.AnimationClip('Nod', 1, [
      new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, ...nod.toArray()]),
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const prepared = prepareAnimationClips(target.root, source.root, [clip]);
    expect(prepared.mode).toBe('retargeted');
    const names = prepared.clips[0].tracks.map(track => track.name);
    expect(names).toContain('mixamorigHead.quaternion');
    expect(names.some(name => /_\d+\./.test(name))).toBe(false);
  });

  it('keep the hips where the rig has them on a model scaled on import, so a clip does not throw it off', () => {
    const target = splitCharacter();
    // Imported models are scaled to a size; the skeleton's bind is in its own units.
    target.root.scale.setScalar(0.01);
    target.root.updateMatrixWorld(true);
    const source = skeleton('');
    const clip = new THREE.AnimationClip('Flinch', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, -0.1]),
      new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const [flinch] = prepareAnimationClips(target.root, source.root, [clip]).clips;
    const hips = flinch.tracks.find(track => track.name === 'mixamorigHips.position')!;
    // The rig's hips stand 1 high; the clip starts them there and moves them 0.1 back.
    expect(hips.values[1]).toBeCloseTo(1, 3);
    expect(Math.abs(hips.values[hips.values.length - 1] - hips.values[2])).toBeCloseTo(0.1, 3);
  });

  it('take no tracks of a mirrored clip either', () => {
    const target = splitCharacter();
    const clip = new THREE.AnimationClip('Look', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigHead.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.2, 0, 0.98]),
      new THREE.QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0.2, 0.98]),
    ]);
    const [mirrored] = mirrorModelClips(target.root, [clip], ['Look']);
    const names = mirrored.tracks.map(track => track.name);
    expect(names).toContain('mixamorigHead.quaternion');
    expect(names.some(name => /_\d+\./.test(name))).toBe(false);
  });
});

describe('finding a bone by its plain name', () => {
  it('skips parts\' copies: Spine1 is the spine\'s second bone, not a copy of the first', async () => {
    const { findBone } = await import('../../runtime/ik');
    const { root, byName } = skeleton('mixamorig');
    const spine = byName.get('Spine')!;
    const copy = new THREE.Bone();
    copy.name = 'mixamorigSpine_1';
    spine.add(copy);
    const spine1 = new THREE.Bone();
    spine1.name = 'mixamorigSpine1';
    spine1.position.set(0, 0.1, 0);
    spine.add(spine1);
    expect(findBone(root, 'Spine1')).toBe(spine1);
    expect(findBone(root, 'mixamorigSpine_1')).toBe(copy);
  });
});
