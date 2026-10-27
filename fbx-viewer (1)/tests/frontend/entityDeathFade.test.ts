import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { takeFadeMaterials } from '../../components/Sandbox/SandboxEntity';

const body = (material: THREE.Material | THREE.Material[]) => {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  return root;
};

describe('takeFadeMaterials', () => {
  it('fades copies, so other entities of the same model and the library model stay visible', () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#808080' });
    const dying = body(shared);
    const alive = body(shared);

    const fade = takeFadeMaterials(dying);
    for (const material of fade.materials) material.opacity = 0;

    expect(fade.materials).toHaveLength(1);
    expect(fade.materials[0]).not.toBe(shared);
    expect(fade.materials[0].transparent).toBe(true);
    expect((dying.children[0] as THREE.Mesh).material).toBe(fade.materials[0]);
    expect((alive.children[0] as THREE.Mesh).material).toBe(shared);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
  });

  it('copies every material of a multi-material mesh and restore puts the originals back', () => {
    const first = new THREE.MeshStandardMaterial();
    const second = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
    const root = body([first, second]);
    const mesh = root.children[0] as THREE.Mesh;

    const fade = takeFadeMaterials(root);
    expect(fade.materials).toHaveLength(2);
    expect(fade.materials[1].opacity).toBe(0.5);
    expect(mesh.material).toEqual(fade.materials);

    fade.restore();
    expect(mesh.material).toEqual([first, second]);
    expect(second.opacity).toBe(0.5);
    expect(second.transparent).toBe(true);
  });
});
