import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mirrorModelClips, prepareAnimationClips } from '../../utils/animationBinding';

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

/** A character split into a body and eyes, as Mixamo's are: only the eyes are bound to the head. */
const splitCharacter = () => {
  const { root, byName } = skeleton('mixamorig');
  const head = byName.get('Head')!;
  const body = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  body.name = 'Body';
  root.add(body);
  body.bind(new THREE.Skeleton([...byName.values()].filter((bone) => bone !== head)));
  const eyes = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  eyes.name = 'Eyes';
  root.add(eyes);
  eyes.bind(new THREE.Skeleton([byName.get('Neck')!, head]));
  return { root, head };
};

describe('characters split into parts', () => {
  it('get tracks for the bones of every part, the head here being only the eyes\'', () => {
    const target = splitCharacter();
    const source = skeleton('');
    const nod = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    const clip = new THREE.AnimationClip('Nod', 1, [
      new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, ...nod.toArray()]),
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const prepared = prepareAnimationClips(target.root, source.root, [clip]);
    expect(prepared.mode).toBe('retargeted');
    expect(prepared.clips[0].tracks.map((track) => track.name)).toContain('mixamorigHead.quaternion');
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
    const hips = flinch.tracks.find((track) => track.name === 'mixamorigHips.position')!;
    // The rig's hips stand 1 high; the clip starts them there and moves them 0.1 back.
    expect(hips.values[1]).toBeCloseTo(1, 3);
    expect(Math.abs(hips.values[hips.values.length - 1] - hips.values[2])).toBeCloseTo(0.1, 3);
  });

  it('mirror clips across the bones of every part too', () => {
    const target = splitCharacter();
    const clip = new THREE.AnimationClip('Look', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigHead.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.2, 0, 0.98]),
      new THREE.QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0.2, 0.98]),
    ]);
    const [mirrored] = mirrorModelClips(target.root, [clip], ['Look']);
    expect(mirrored.tracks.map((track) => track.name)).toContain('mixamorigHead.quaternion');
  });
});

describe('finding a bone by its plain name', () => {
  it('tells Spine1 from Spine', async () => {
    const { findBone } = await import('../../runtime/ik');
    const { root, byName } = skeleton('mixamorig');
    const spine1 = new THREE.Bone();
    spine1.name = 'mixamorigSpine1';
    spine1.position.set(0, 0.1, 0);
    byName.get('Spine')!.add(spine1);
    expect(findBone(root, 'Spine1')).toBe(spine1);
    expect(findBone(root, 'Spine')).toBe(byName.get('Spine'));
  });
});
