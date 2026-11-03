import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { boneAtScreen, skeletonBones } from '../../utils/skeletonView';

const WIDTH = 800;
const HEIGHT = 600;

/** A chain of bones up the Y axis, and a camera in front of it looking at its middle. */
const scene = () => {
  const root = new THREE.Group();
  let parent: THREE.Object3D = root;
  for (const [name, y] of [['Hips', 0], ['Chest', 0.5], ['Head', 0.5]] as const) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.y = y;
    parent.add(bone);
    parent = bone;
  }
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 0.5, 3);
  camera.lookAt(0, 0.5, 0);
  camera.updateMatrixWorld(true);
  return { root, camera, bones: skeletonBones(root) };
};

/** Where a bone shows on the screen. */
const onScreen = (bone: THREE.Object3D, camera: THREE.Camera): [number, number] => {
  const at = bone.getWorldPosition(new THREE.Vector3()).project(camera);
  return [((at.x + 1) / 2) * WIDTH, ((1 - at.y) / 2) * HEIGHT];
};

describe('picking a bone in the view', () => {
  it('finds the joint under a click', () => {
    const { bones, camera } = scene();
    for (const entry of bones) {
      const [x, y] = onScreen(entry.bone, camera);
      expect(boneAtScreen(bones, camera, x + 3, y - 3, WIDTH, HEIGHT)?.name).toBe(entry.name);
    }
  });

  it('finds nothing away from every joint', () => {
    const { bones, camera } = scene();
    expect(boneAtScreen(bones, camera, 10, 10, WIDTH, HEIGHT)).toBeNull();
  });

  it('does not pick a joint behind the camera', () => {
    const { bones, camera } = scene();
    camera.position.set(0, 0.5, -3);
    camera.lookAt(0, 0.5, -10);
    camera.updateMatrixWorld(true);
    const [x, y] = [WIDTH / 2, HEIGHT / 2];
    expect(boneAtScreen(bones, camera, x, y, WIDTH, HEIGHT)).toBeNull();
  });

  it('takes the nearer of two joints on top of each other', () => {
    const root = new THREE.Group();
    const far = new THREE.Bone();
    far.name = 'Far';
    const near = new THREE.Bone();
    near.name = 'Near';
    near.position.z = 1;
    root.add(far, near);
    root.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    expect(boneAtScreen(skeletonBones(root), camera, WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT)?.name).toBe('Near');
  });
});
