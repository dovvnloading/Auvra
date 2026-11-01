import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRenderBundle, renderView } from '../../components/Environment/renderBundle';

const bytesOf = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

type Part = { offset: number; length: number };

/** The bundle as a renderer reads it: each mesh's corners, as they were sent. */
const readBundle = async () => {
  const built = await buildRenderBundle();
  if (!built) throw new Error('nothing was gathered');
  const bytes = await bytesOf(built.bundle);
  const headerLength = new DataView(bytes).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 12, headerLength)));
  const floats = (part: Part) => Array.from(new Float32Array(bytes.slice(12 + headerLength + part.offset, 12 + headerLength + part.offset + part.length)));
  return { header, floats };
};

const triangle = () => new THREE.BufferGeometry()
  .setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 1], 3))
  .setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3))
  .setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));

const view = (...objects: THREE.Object3D[]) => {
  const scene = new THREE.Scene();
  scene.add(...objects);
  renderView.scene = scene;
  renderView.camera = new THREE.PerspectiveCamera();
};

afterEach(() => {
  renderView.scene = null;
  renderView.camera = null;
});

describe('gathering the view for a render', () => {
  it('turns a posed character\'s surface with its bones, not only its corners', async () => {
    const geometry = triangle();
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    const bone = new THREE.Bone();
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    // A quarter turn about Z takes the surface's +X normal to +Y.
    bone.rotation.z = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    view(mesh);

    const { header, floats } = await readBundle();
    const normals = floats(header.meshes[0].normals);
    const positions = floats(header.meshes[0].positions);
    // The second corner, at +Y in the bind pose, has moved to -X.
    expect(positions[3]).toBeCloseTo(-1);
    expect(positions[4]).toBeCloseTo(0);
    for (let corner = 0; corner < 3; corner += 1) {
      expect(normals[corner * 3]).toBeCloseTo(0);
      expect(normals[corner * 3 + 1]).toBeCloseTo(1);
      expect(normals[corner * 3 + 2]).toBeCloseTo(0);
    }
  });

  it('leaves a surface that has no bones as it is', async () => {
    const mesh = new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial());
    mesh.rotation.z = Math.PI / 2;
    view(mesh);

    const { header, floats } = await readBundle();
    const normals = floats(header.meshes[0].normals);
    expect(normals[0]).toBeCloseTo(0);
    expect(normals[1]).toBeCloseTo(1);
  });

  it('stands a decal off its surface further than a ray steps through it, in a level of any size', async () => {
    const sizes = [100, 4000];
    for (const size of sizes) {
      const ground = new THREE.Mesh(new THREE.BoxGeometry(size, 1, 1), new THREE.MeshStandardMaterial());
      const decal = new THREE.Mesh(triangle(), new THREE.MeshStandardMaterial({ polygonOffset: true }));
      view(ground, decal);

      const { header, floats } = await readBundle();
      const lifted = floats(header.meshes[1].positions)[0];
      // A ray passing through a clear part of it moves on by 2e-5 of the level's size.
      expect(lifted).toBeGreaterThan(2e-5 * size);
      expect(lifted).toBeLessThan(1e-4 * size);
    }
  });
});
