import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { boneNamesUnder, findBone, maskClip } from '../../components/AnimationGraph/utils/boneMask';
import { MontagePlayer } from '../../components/AnimationGraph/utils/montage';

// Binary fractions keep the clip times exact, so the fades land on exact frames.
const DT = 1 / 32;
const BONES = ['mixamorigHips', 'mixamorigSpine', 'mixamorigChest', 'mixamorigLeftArm', 'mixamorigLeftHand', 'mixamorigLeftLeg'];

const makeRig = () => {
  const root = new THREE.Group();
  root.name = 'Character';
  const bone = (name: string, parent: THREE.Object3D) => {
    const created = new THREE.Bone();
    created.name = name;
    parent.add(created);
    return created;
  };
  const hips = bone('mixamorigHips', root);
  const spine = bone('mixamorigSpine', hips);
  const chest = bone('mixamorigChest', spine);
  const arm = bone('mixamorigLeftArm', chest);
  const hand = bone('mixamorigLeftHand', arm);
  const leg = bone('mixamorigLeftLeg', hips);
  return { root, hips, spine, chest, arm, hand, leg };
};

/** Holds every bone at `offset`. Positions blend linearly, so a bone's position reads back each clip's share. */
const poseClip = (name: string, offset: [number, number, number], duration = 1) => new THREE.AnimationClip(
  name,
  duration,
  BONES.map(bone => new THREE.VectorKeyframeTrack(`${bone}.position`, [0, duration], [...offset, ...offset])),
);

const makeScene = () => {
  const rig = makeRig();
  const mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(poseClip('Idle', [0, 0, 0])).play();
  const player = new MontagePlayer(mixer, rig.root);
  const frame = (count = 1) => {
    for (let i = 0; i < count; i++) {
      player.update(DT);
      mixer.update(DT);
    }
  };
  return { ...rig, mixer, player, frame };
};

describe('bone masks', () => {
  it('collects a bone and its descendants, tolerant of mixamorig prefixes and case', () => {
    const { root } = makeRig();
    const upperBody = ['mixamorigSpine', 'mixamorigChest', 'mixamorigLeftArm', 'mixamorigLeftHand'];
    expect([...boneNamesUnder(root, 'Spine')].sort()).toEqual([...upperBody].sort());
    expect([...boneNamesUnder(root, 'mixamorig:spine')].sort()).toEqual([...upperBody].sort());
    expect([...boneNamesUnder(root, 'mixamorig1:LEFTARM')].sort()).toEqual(['mixamorigLeftArm', 'mixamorigLeftHand']);
    expect(boneNamesUnder(root, 'Tail').size).toBe(0);
    expect(findBone(root, 'mixamorigChest')?.name).toBe('mixamorigChest');
  });

  it('finds bones of a skeleton bound under the root', () => {
    const root = new THREE.Group();
    const head = new THREE.Bone();
    head.name = 'mixamorig:Head';
    const jaw = new THREE.Bone();
    jaw.name = 'mixamorig:Jaw';
    head.add(jaw);
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.skeleton = new THREE.Skeleton([head, jaw]);
    root.add(mesh);
    expect([...boneNamesUnder(root, 'head')].sort()).toEqual(['mixamorig:Head', 'mixamorig:Jaw']);
  });

  it('keeps copies of only the masked tracks, matching node names with or without the prefix', () => {
    const { root } = makeRig();
    const track = (name: string) => new THREE.QuaternionKeyframeTrack(name, [0], [0, 0, 0, 1]);
    const clip = new THREE.AnimationClip('Wave', 2, [
      track('mixamorigSpine.quaternion'),
      track('Chest.quaternion'),
      track('mixamorigLeftLeg.quaternion'),
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0], [0, 1, 0]),
      track('.bones[mixamorigLeftHand].quaternion'),
    ]);
    const masked = maskClip(clip, boneNamesUnder(root, 'Spine'));
    expect(masked.tracks.map(kept => kept.name)).toEqual([
      'mixamorigSpine.quaternion',
      'Chest.quaternion',
      '.bones[mixamorigLeftHand].quaternion',
    ]);
    expect(masked.name).toBe('Wave');
    expect(masked.duration).toBe(2);
    expect(masked.tracks[0]).not.toBe(clip.tracks[0]);
    expect(Array.from(masked.tracks[0].values)).toEqual([0, 0, 0, 1]);
    expect(clip.tracks).toHaveLength(5);
    expect(maskClip(clip, new Set(['mixamorigLeftLeg']), 'Kick').name).toBe('Kick');
  });
});

describe('montage player', () => {
  it('fades a masked montage in and out over the base pose and ends once', () => {
    const { spine, hand, hips, leg, mixer, player, frame } = makeScene();
    const onEnd = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { maskBone: 'Spine', blendIn: 1 / 16, blendOut: 1 / 4, onEnd });
    expect(player.isPlaying()).toBe(true);
    expect(player.weight()).toBe(0);

    const shares: number[] = [];
    for (let i = 0; i < 31; i++) {
      frame();
      shares.push(player.weight());
      expect(spine.position.x).toBeCloseTo(player.weight(), 3);
      expect(hand.position.x).toBeCloseTo(player.weight(), 3);
      expect(hips.position.x).toBe(0);
      expect(leg.position.x).toBe(0);
    }
    // In over the first 2 frames, held, then out over the last 8 of the 32-frame clip.
    expect(shares[0]).toBe(0.5);
    expect(shares[1]).toBe(1);
    expect(shares[23]).toBe(1);
    expect(shares[27]).toBe(0.5);
    expect(shares[30]).toBe(0.125);
    expect(onEnd).not.toHaveBeenCalled();

    frame();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(player.isPlaying()).toBe(false);
    expect(player.weight()).toBe(0);
    expect(spine.position.x).toBe(0);
    expect(mixer.stats.actions.total).toBe(1);

    frame(10);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('overrides bone rotations rather than averaging them with the base', () => {
    const { root, spine, leg } = makeRig();
    const rotation = (name: string, angle: number) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
      return new THREE.AnimationClip(name, 1, BONES.map(bone => new THREE.QuaternionKeyframeTrack(
        `${bone}.quaternion`, [0, 1], [...q.toArray(), ...q.toArray()],
      )));
    };
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(rotation('Idle', 0)).play();
    const player = new MontagePlayer(mixer, root);
    const angle = (bone: THREE.Bone) => 2 * Math.acos(Math.min(1, Math.abs(bone.quaternion.w)));
    player.play(rotation('Wave', Math.PI / 2), { maskBone: 'Spine', blendIn: 1 / 16 });
    player.update(DT);
    mixer.update(DT);
    expect(angle(spine)).toBeCloseTo(Math.PI / 4, 3);
    player.update(DT);
    mixer.update(DT);
    expect(angle(spine)).toBeCloseTo(Math.PI / 2, 3);
    expect(angle(leg)).toBe(0);
  });

  it('plays on the whole body without a mask bone', () => {
    const { hips, leg, hand, player, frame } = makeScene();
    player.play(poseClip('Wave', [1, 0, 0]), { blendIn: 0 });
    frame();
    [hips, leg, hand].forEach(bone => expect(bone.position.x).toBeCloseTo(1, 3));
  });

  it('crossfades into an interrupting montage, keeping every bone at its exact share', () => {
    const { spine, arm, hand, leg, mixer, player, frame } = makeScene();
    const endA = vi.fn();
    const endB = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { maskBone: 'Spine', blendIn: 0, onEnd: endA });
    frame();
    expect(spine.position.x).toBeCloseTo(1, 3);

    player.play(poseClip('Point', [0, 1, 0]), { maskBone: 'LeftArm', blendIn: 1 / 16, onEnd: endB });
    frame();
    // Halfway the arm is split evenly with nothing left to the base, while the spine, played
    // only by the first montage, fades out at the same pace.
    expect(arm.position.x).toBeCloseTo(0.5, 3);
    expect(arm.position.y).toBeCloseTo(0.5, 3);
    expect(hand.position.x + hand.position.y).toBeCloseTo(1, 3);
    expect(spine.position.x).toBeCloseTo(0.5, 3);
    expect(spine.position.y).toBe(0);
    expect(leg.position.x + leg.position.y).toBe(0);
    expect(endA).not.toHaveBeenCalled();

    frame();
    expect(endA).toHaveBeenCalledTimes(1);
    expect(endA).toHaveBeenCalledWith(true);
    expect(spine.position.x).toBe(0);
    expect(arm.position.x).toBe(0);
    expect(arm.position.y).toBeCloseTo(1, 3);
    expect(player.isPlaying()).toBe(true);
    expect(player.weight()).toBe(1);
    expect(endB).not.toHaveBeenCalled();
    expect(mixer.stats.actions.total).toBe(2);
  });

  it('keeps exact shares when a crossfade is interrupted again', () => {
    const { spine, arm, leg, mixer, player, frame } = makeScene();
    const ends = [vi.fn(), vi.fn(), vi.fn()];
    player.play(poseClip('Idle2', [1, 0, 0]), { blendIn: 0, onEnd: ends[0] });
    frame();
    player.play(poseClip('Wave', [0, 1, 0]), { maskBone: 'Spine', blendIn: 1 / 8, onEnd: ends[1] });
    frame(2);
    player.play(poseClip('Point', [0, 0, 1]), { maskBone: 'LeftArm', blendIn: 1 / 16, onEnd: ends[2] });
    frame();
    expect(arm.position.x).toBeCloseTo(0.25, 3);
    expect(arm.position.y).toBeCloseTo(0.25, 3);
    expect(arm.position.z).toBeCloseTo(0.5, 3);
    expect(spine.position.x).toBeCloseTo(0.25, 3);
    expect(spine.position.y).toBeCloseTo(0.25, 3);
    expect(spine.position.z).toBe(0);
    expect(leg.position.x).toBeCloseTo(0.25, 3);

    frame();
    expect(ends[0]).toHaveBeenCalledWith(true);
    expect(ends[1]).toHaveBeenCalledWith(true);
    expect(ends[2]).not.toHaveBeenCalled();
    expect(arm.position.z).toBeCloseTo(1, 3);
    expect(spine.position.length() + leg.position.length()).toBe(0);
    expect(mixer.stats.actions.total).toBe(2);
  });

  it('caches the masked clip per clip and mask bone, and plays a restarted clip as its own instance', () => {
    const { spine, mixer, player, frame } = makeScene();
    const clone = vi.spyOn(THREE.KeyframeTrack.prototype, 'clone');
    const wave = poseClip('Wave', [1, 0, 0]);
    const first = vi.fn();
    player.play(wave, { maskBone: 'Spine', blendIn: 0, onEnd: first });
    expect(clone).toHaveBeenCalledTimes(4);
    frame();

    player.play(wave, { maskBone: 'Spine', blendIn: 1 / 16 });
    expect(clone).toHaveBeenCalledTimes(4);
    expect(mixer.stats.actions.total).toBe(3);
    frame();
    expect(spine.position.x).toBeCloseTo(1, 3);
    frame();
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(true);
    expect(mixer.stats.actions.total).toBe(2);

    player.play(wave, { maskBone: 'LeftArm', blendIn: 0 });
    expect(clone).toHaveBeenCalledTimes(6);
  });

  it('stops with a fade-out and reports the montage as interrupted', () => {
    const { spine, mixer, player, frame } = makeScene();
    const onEnd = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { loop: true, blendIn: 0, onEnd });
    frame(80);
    expect(player.isPlaying()).toBe(true);
    expect(spine.position.x).toBeCloseTo(1, 3);

    player.stop(1 / 16);
    expect(player.isPlaying()).toBe(false);
    frame();
    expect(spine.position.x).toBeCloseTo(0.5, 3);
    expect(onEnd).not.toHaveBeenCalled();
    frame();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(spine.position.x).toBe(0);
    expect(mixer.stats.actions.total).toBe(1);

    const again = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { blendIn: 0, onEnd: again });
    frame();
    player.stop(0);
    frame();
    expect(spine.position.x).toBe(0);
    expect(again).toHaveBeenCalledTimes(1);
    expect(again).toHaveBeenCalledWith(true);
  });

  it('scales the timing by the rate and plays a negative rate backwards', () => {
    const { spine, player, frame } = makeScene();
    const onEnd = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { rate: 2, blendIn: 0, blendOut: 1 / 4, onEnd });
    frame(12);
    // Three quarters played at double speed: 0.125 s left of the 0.25 s fade-out.
    expect(player.weight()).toBe(0.5);
    frame(3);
    expect(onEnd).not.toHaveBeenCalled();
    frame();
    expect(onEnd).toHaveBeenCalledWith(false);

    const ramp = new THREE.AnimationClip('Ramp', 1, [
      new THREE.VectorKeyframeTrack('mixamorigSpine.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
    player.play(ramp, { rate: -1, blendIn: 0, blendOut: 0 });
    frame();
    expect(spine.position.x).toBeCloseTo(31 / 32, 3);
    frame(30);
    expect(spine.position.x).toBeCloseTo(1 / 32, 3);
    expect(player.isPlaying()).toBe(true);
    frame();
    expect(player.isPlaying()).toBe(false);
  });

  it('lets onEnd start the next montage', () => {
    const { spine, player, frame } = makeScene();
    const bow = poseClip('Bow', [0, 1, 0]);
    player.play(poseClip('Wave', [1, 0, 0], 1 / 4), {
      blendIn: 0,
      blendOut: 0,
      onEnd: () => player.play(bow, { blendIn: 0 }),
    });
    frame(8);
    expect(player.isPlaying()).toBe(true);
    expect(spine.position.x).toBe(0);
    expect(spine.position.y).toBeCloseTo(1, 3);
  });

  it('only sets weights and leaves updating to the mixer', () => {
    const { spine, mixer, player } = makeScene();
    const update = vi.spyOn(mixer, 'update');
    player.play(poseClip('Wave', [1, 0, 0]), { blendIn: 1 / 16 });
    player.update(DT);
    expect(player.weight()).toBe(0.5);
    player.update(DT);
    expect(player.weight()).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(spine.position.x).toBe(0);
  });

  it('leaves the pose alone when the mask bone matches nothing, but still ends', () => {
    const { spine, leg, player, frame } = makeScene();
    const onEnd = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0], 1 / 4), { maskBone: 'Tail', blendIn: 0, onEnd });
    frame();
    expect(spine.position.x + leg.position.x).toBe(0);
    frame(7);
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it('disposes its actions without calling onEnd', () => {
    const { spine, mixer, player, frame } = makeScene();
    const onEnd = vi.fn();
    player.play(poseClip('Wave', [1, 0, 0]), { maskBone: 'Spine', blendIn: 0, onEnd });
    frame();
    player.dispose();
    expect(player.isPlaying()).toBe(false);
    expect(mixer.stats.actions.total).toBe(1);
    frame();
    expect(spine.position.x).toBe(0);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('mesh-space montages', () => {
  const UP = new THREE.Vector3(0, 1, 0);
  const SIDE = new THREE.Vector3(1, 0, 0);
  const turn = (axis: THREE.Vector3, degrees: number) => new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
  const hold = (bone: string, rotation: THREE.Quaternion) => new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [...rotation.toArray(), ...rotation.toArray()]);
  // The legs' clip turns and tips the hips (a strafe); the aim clip turns them the other way and the spine back.
  const strafeHips = turn(UP, 40).multiply(turn(SIDE, 12));
  const aimHips = turn(UP, -30);
  const aimSpine = turn(UP, 25).multiply(turn(SIDE, -8));
  const aimChest = turn(SIDE, 5);
  const setup = (meshSpaceRotation: boolean) => {
    const rig = makeRig();
    const mixer = new THREE.AnimationMixer(rig.root);
    const identity = new THREE.Quaternion();
    mixer.clipAction(new THREE.AnimationClip('Strafe', 1, [hold('mixamorigHips', strafeHips), hold('mixamorigSpine', identity), hold('mixamorigChest', identity)])).play();
    const player = new MontagePlayer(mixer, rig.root);
    const aim = new THREE.AnimationClip('Aim', 1, [hold('mixamorigHips', aimHips), hold('mixamorigSpine', aimSpine), hold('mixamorigChest', aimChest)]);
    player.play(aim, { maskBone: 'Spine', loop: true, blendIn: 0, meshSpaceRotation });
    player.update(DT);
    mixer.update(DT);
    player.applyMeshSpaceRotation();
    rig.root.updateMatrixWorld(true);
    return rig;
  };

  it('keeps the upper body turned as the clip turns it relative to the character, whatever the legs do with the hips', () => {
    const { hips, chest } = setup(true);
    const asClipped = aimHips.clone().multiply(aimSpine).multiply(aimChest);
    expect(chest.getWorldQuaternion(new THREE.Quaternion()).angleTo(asClipped)).toBeLessThan(1e-3);
    expect(hips.quaternion.angleTo(strafeHips)).toBeLessThan(1e-3);
  });

  it('turns the upper body with the hips without it', () => {
    const { chest } = setup(false);
    const onTheHips = strafeHips.clone().multiply(aimSpine).multiply(aimChest);
    expect(chest.getWorldQuaternion(new THREE.Quaternion()).angleTo(onTheHips)).toBeLessThan(1e-3);
  });
});

describe('montage slots and root turns', () => {
  it('plays montages of different slots side by side, each interrupting only its own slot', () => {
    const { hips, chest, leg, player, frame } = makeScene();
    let aimEnded = false;
    player.play(poseClip('Aim', [2, 0, 0]), { maskBone: 'Spine', loop: true, blendIn: 0, onEnd: () => { aimEnded = true; } });
    // A turn on the legs: the hips and below, without the spine.
    player.play(poseClip('Turn', [0, 3, 0]), { maskBone: 'Hips', excludeBone: 'Spine', loop: true, slot: 'turn', blendIn: 0 });
    frame(4);
    expect(aimEnded).toBe(false);
    expect(player.isPlaying()).toBe(true);
    expect(player.isPlaying('turn')).toBe(true);
    expect(chest.position.x).toBeCloseTo(2, 3);
    expect(chest.position.y).toBeCloseTo(0, 3);
    expect(hips.position.y).toBeCloseTo(3, 3);
    expect(leg.position.y).toBeCloseTo(3, 3);
    // Stopping one slot leaves the other playing.
    player.stop(0, 'turn');
    frame(1);
    expect(player.isPlaying('turn')).toBe(false);
    expect(player.isPlaying()).toBe(true);
    expect(chest.position.x).toBeCloseTo(2, 3);
    expect(leg.position.y).toBeCloseTo(0, 3);
  });

  const turnClip = (axis: THREE.Vector3) => new THREE.AnimationClip('Turn Left', 1, [
    new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 0.5, 1], [
      ...new THREE.Quaternion().toArray(),
      ...new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 4).toArray(),
      ...new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2).toArray(),
    ]),
  ]);

  it('takes the turn of the root bone out of the pose and reports it for the character to turn by', () => {
    const { hips, player, frame } = makeScene();
    player.play(turnClip(new THREE.Vector3(0, 1, 0)), { maskBone: 'Hips', rootYaw: true, slot: 'turn', blendIn: 0 });
    frame(16);
    expect(player.consumeRootYaw()).toBeCloseTo(Math.PI / 4, 3);
    expect(player.consumeRootYaw()).toBe(0);
    expect(hips.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-3);
    frame(8);
    expect(player.consumeRootYaw()).toBeCloseTo(Math.PI / 8, 3);
  });

  it('reads the turn about the up of the character whatever frame the root bone hangs in', () => {
    const rig = makeRig();
    // An FBX armature turned to stand a Z-up rig upright: its Z is the character's up.
    const armature = new THREE.Group();
    armature.rotation.x = -Math.PI / 2;
    rig.root.remove(rig.hips);
    armature.add(rig.hips);
    rig.root.add(armature);
    const mixer = new THREE.AnimationMixer(rig.root);
    const player = new MontagePlayer(mixer, rig.root);
    player.play(turnClip(new THREE.Vector3(0, 0, 1)), { maskBone: 'Hips', rootYaw: true, blendIn: 0 });
    for (let i = 0; i < 32; i++) { player.update(DT); mixer.update(DT); }
    expect(player.consumeRootYaw()).toBeCloseTo(Math.PI / 2, 2);
  });
});

describe('additive montages', () => {
  it('adds a clip\'s motion from its first frame on top of a montage that keeps playing', () => {
    const { hips, player, frame } = makeScene();
    // An upper-body loop holds every bone at x = 2.
    player.play(poseClip('Aim', [2, 0, 0]), { loop: true, blendIn: 0 });
    // A flinch moves from y = 5 to y = 6 over its second: as additive motion that is +0 to +1 in y.
    const flinch = new THREE.AnimationClip('Flinch', 1, BONES.map(bone => new THREE.VectorKeyframeTrack(`${bone}.position`, [0, 1], [0, 5, 0, 0, 6, 0])));
    player.play(flinch, { additive: true, blendIn: 0, blendOut: 0 });
    frame(16);
    expect(player.isPlaying()).toBe(true);
    expect(hips.position.x).toBeCloseTo(2, 3);
    expect(hips.position.y).toBeCloseTo(0.5, 3);
    // The flinch ends; the loop it played over is still at full weight.
    frame(24);
    expect(hips.position.x).toBeCloseTo(2, 3);
    expect(hips.position.y).toBeCloseTo(0, 3);
    expect(flinch.blendMode).toBe(THREE.NormalAnimationBlendMode);
  });

  it('takes the share each listed bone gives its subtree, the deepest listed bone winning', () => {
    const { hips, chest, hand, leg, player, frame } = makeScene();
    // A flinch from y = 5 to y = 6 over its second: +0 to +1 in y as additive motion.
    const flinch = new THREE.AnimationClip('Flinch', 1, BONES.map(bone => new THREE.VectorKeyframeTrack(`${bone}.position`, [0, 1], [0, 5, 0, 0, 6, 0])));
    player.play(flinch, { additive: true, blendIn: 0, blendOut: 0, boneWeights: [{ bone: 'Spine', weight: 0.25 }, { bone: 'LeftHand', weight: 0 }] });
    frame(16);
    expect(hips.position.y).toBeCloseTo(0.5, 3);
    expect(leg.position.y).toBeCloseTo(0.5, 3);
    expect(chest.position.y).toBeCloseTo(0.125, 3);
    expect(hand.position.y).toBeCloseTo(0, 3);
  });
});
