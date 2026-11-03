import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { AuvraCanvas } from '../../../renderer/AuvraCanvas';
import { LocalEnvironment } from '../../Scene/LocalEnvironment';
import { findRootMotionTrack, positionTrackNode } from '../../AnimationGraph/utils/rootMotion';
import type { RootTravel } from '../../../utils/clipRanges';

/** What the preview plays: shared with the editor, which moves it by hand and reads where it has got to. */
export interface ClipPlayback {
  /** Seconds into the take. */
  time: number;
  playing: boolean;
  /** The stretch it plays through, and what it does at the end of it. */
  from: number;
  to: number;
  loop: boolean;
  /** What the clip being shown takes off its root, while inside that stretch. */
  shift: RootTravel | null;
}

/** Longest step one frame takes, so a stall does not jump the clip. */
const MAX_FRAME_STEP = 0.1;
/** Share of the way the camera closes on the model each frame. */
const FOLLOW_SHARE = 0.12;

const TakePlayer: React.FC<{
  object: THREE.Object3D;
  clip: THREE.AnimationClip;
  playback: React.MutableRefObject<ClipPlayback>;
  onFrame: (time: number, playing: boolean) => void;
}> = ({ object, clip, playback, onFrame }) => {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitControlsImpl | null;
  const mixer = useMemo(() => new THREE.AnimationMixer(object), [object]);
  const action = useRef<THREE.AnimationAction | null>(null);
  const shifted = useRef<RootTravel | null>(null);
  const root = useMemo(() => {
    const track = findRootMotionTrack(clip, object);
    const name = track && positionTrackNode(track);
    return name ? THREE.PropertyBinding.findNode(object, name) as THREE.Object3D | null : null;
  }, [clip, object]);
  const scratch = useRef({ at: new THREE.Vector3(), step: new THREE.Vector3() });

  useEffect(() => {
    const played = mixer.clipAction(clip);
    played.play();
    played.paused = true;
    action.current = played;
    return () => {
      action.current = null;
      // Stopping puts the root back where it was bound.
      shifted.current = null;
      played.stop();
      mixer.uncacheAction(clip);
    };
  }, [mixer, clip]);

  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(object);
  }, [mixer, object]);

  useFrame((_state, delta) => {
    const played = action.current;
    if (!played) return;
    const play = playback.current;
    if (play.playing) {
      play.time += Math.min(delta, MAX_FRAME_STEP);
      if (play.time >= play.to) {
        if (play.loop && play.to > play.from) {
          play.time = play.from + ((play.time - play.from) % (play.to - play.from));
        } else {
          play.time = play.to;
          play.playing = false;
        }
      }
    }
    // A mixer only writes values that changed, so the shift comes off first to leave it what it wrote.
    const before = shifted.current;
    if (before?.node) before.node.position.add(before.shift);
    played.time = Math.min(play.time, clip.duration);
    mixer.update(0);
    const inside = play.time >= play.from && play.time <= play.to;
    const now = inside ? play.shift : null;
    if (now?.node) now.node.position.sub(now.shift);
    shifted.current = now?.node ? now : null;
    onFrame(play.time, play.playing);

    // The camera goes along when the root walks off.
    if (root && controls) {
      const { at, step } = scratch.current;
      root.getWorldPosition(at);
      step.set(at.x - controls.target.x, 0, at.z - controls.target.z).multiplyScalar(FOLLOW_SHARE);
      controls.target.add(step);
      camera.position.add(step);
    }
  });

  return null;
};

/** The take on the model, posed where the editor says, with a floor to read its travel against. */
export const ClipRangePreview: React.FC<{
  object: THREE.Object3D;
  clip: THREE.AnimationClip;
  playback: React.MutableRefObject<ClipPlayback>;
  onFrame: (time: number, playing: boolean) => void;
}> = ({ object, clip, playback, onFrame }) => (
  <AuvraCanvas surfaceId="preview-clip-ranges" role="preview" camera={{ position: [2.2, 1.7, 4.2], fov: 40 }} dpr={[1, 2]}>
    <color attach="background" args={['#0a0a0a']} />
    <fog attach="fog" args={['#0a0a0a', 12, 40]} />
    <LocalEnvironment />
    <ambientLight intensity={0.5} />
    <directionalLight position={[4, 6, 3]} intensity={1.5} />
    <Grid infiniteGrid cellSize={0.5} sectionSize={2.5} fadeDistance={24} sectionColor="#525252" cellColor="#262626" />
    <primitive object={object} />
    <OrbitControls makeDefault target={[0, 1, 0]} enableDamping dampingFactor={0.1} />
    <TakePlayer object={object} clip={clip} playback={playback} onFrame={onFrame} />
  </AuvraCanvas>
);

export default ClipRangePreview;
