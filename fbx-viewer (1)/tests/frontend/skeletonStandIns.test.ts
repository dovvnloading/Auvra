import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { collectOverrideTextures, drawAsPaintedTexture } from '../../utils/materialOverrides';
import { cloneCharacterModel } from '../../utils/mountedParts';
import { disposeObject } from '../../utils/processing/ModelLifecycle';
import { skinnedStandIns } from '../../utils/skeletonView';

/** A model of two skinned meshes, a second mesh over the surface of the first, and a mesh with no skin. */
const model = (): { root: THREE.Group; body: THREE.SkinnedMesh; fringe: THREE.SkinnedMesh; coat: THREE.SkinnedMesh; rigid: THREE.Mesh; bone: THREE.Bone } => {
  const bone = new THREE.Bone();
  bone.name = 'Hips';
  const root = new THREE.Group();
  root.add(bone);
  const skinned = (geometry: THREE.BufferGeometry, skeleton: THREE.Skeleton): THREE.SkinnedMesh => {
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  };
  const geometry = (): THREE.BufferGeometry => {
    const made = new THREE.BufferGeometry();
    made.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    made.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(12), 4));
    made.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    return made;
  };
  const skeleton = new THREE.Skeleton([bone]);
  const body = skinned(geometry(), skeleton);
  const fringe = skinned(body.geometry, skeleton);
  body.add(fringe);
  const coat = skinned(geometry(), new THREE.Skeleton([bone]));
  const rigid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  root.add(body, coat, rigid);
  root.position.set(1, 2, 3);
  root.updateMatrixWorld(true);
  return { root, body, fringe, coat, rigid, bone };
};

const paint = (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial();

describe('drawing over a skinned model', () => {
  it('makes one stand-in per surface, on its own skeleton and geometry', () => {
    const { root, body, coat } = model();
    const standIns = skinnedStandIns(root, paint);
    expect(standIns.map(({ mesh }) => mesh)).toEqual([body, coat]);
    for (const { mesh, standIn } of standIns) {
      expect(standIn.geometry).toBe(mesh.geometry);
      expect(standIn.skeleton).toBe(mesh.skeleton);
      expect(standIn.bindMatrix).toBe(mesh.bindMatrix);
    }
  });

  it('draws where the mesh is, wherever it is held and however the model moves', () => {
    const { root, body } = model();
    const [{ standIn }] = skinnedStandIns(root, paint);
    const holder = new THREE.Group();
    holder.position.set(50, 0, 0);
    holder.add(standIn);
    holder.updateMatrixWorld(true);
    root.position.set(-4, 0, 0);
    root.updateMatrixWorld(true);
    holder.updateMatrixWorld(true);
    expect(standIn.matrixWorld.equals(body.matrixWorld)).toBe(true);
    expect(new THREE.Vector3().setFromMatrixPosition(standIn.matrixWorld).x).toBe(-4);
  });

  it('leaves the model as it was, for everything that reads its materials', () => {
    const { root, body, fringe, coat, rigid } = model();
    const own = [body, fringe, coat, rigid].map((mesh) => mesh.material as THREE.MeshStandardMaterial);
    const override = new THREE.Texture();
    override.userData.materialOverrideTextureId = 'painted';
    override.userData.materialOverrideSlot = 'map';
    own[0].map = override;
    drawAsPaintedTexture(own[0]);
    const nodesBefore: THREE.Object3D[] = [];
    root.traverse((node) => nodesBefore.push(node));

    const standIns = skinnedStandIns(root, paint);

    expect([body, fringe, coat, rigid].map((mesh) => mesh.material)).toEqual(own);
    const nodes: THREE.Object3D[] = [];
    root.traverse((node) => nodes.push(node));
    expect(nodes).toEqual(nodesBefore);
    expect(standIns.every(({ standIn }) => standIn.parent === null)).toBe(true);
    expect(collectOverrideTextures(root).get('map:painted')).toBe(override);
    // Copies made while it is on the screen look like the model.
    const copy = cloneCharacterModel(root);
    const worn: THREE.Material[] = [];
    copy.traverse((node) => { if ((node as THREE.Mesh).isMesh) worn.push((node as THREE.Mesh).material as THREE.Material); });
    expect(worn).toEqual(expect.arrayContaining(own));
    expect(worn.length).toBe(own.length);
    // Getting rid of the model releases its own materials, not the stand-ins'.
    const released: THREE.Material[] = [];
    for (const material of own) material.addEventListener('dispose', () => released.push(material));
    const painted = standIns[0].standIn.material as THREE.Material;
    painted.addEventListener('dispose', () => released.push(painted));
    disposeObject(root);
    expect(released).toEqual(expect.arrayContaining(own));
    expect(released).not.toContain(painted);
  });

  it('sees a bone added to the mesh\'s skeleton', () => {
    const { root, body } = model();
    const [{ standIn }] = skinnedStandIns(root, paint);
    const added = new THREE.Bone();
    body.skeleton.bones.push(added);
    body.skeleton.boneInverses.push(new THREE.Matrix4());
    expect(standIn.skeleton.bones).toContain(added);
  });
});
