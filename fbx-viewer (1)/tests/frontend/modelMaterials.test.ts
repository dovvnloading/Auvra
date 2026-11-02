import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CARD_ALPHA_CUTOFF, CARD_FRINGE_KEY, splitAlphaCards } from '../../utils/processing/ModelMaterials';
import { listModelMaterials } from '../../utils/materialOverrides';
import { writeOpacity } from '../../utils/processing/opacityMaps';

describe('opacity baking', () => {
  const pixels = (...values: number[][]) => new Uint8ClampedArray(values.flat());

  it('takes the grey of a greyscale opacity map as the colour alpha', () => {
    const colour = pixels([200, 150, 100, 255], [10, 20, 30, 255]);
    writeOpacity(colour, pixels([0, 0, 0, 255], [128, 128, 128, 255]));
    expect([...colour]).toEqual([200, 150, 100, 0, 10, 20, 30, 128]);
  });

  it('takes the alpha of an opacity map that has one', () => {
    const colour = pixels([200, 150, 100, 255], [10, 20, 30, 255]);
    writeOpacity(colour, pixels([255, 255, 255, 40], [0, 0, 0, 255]));
    expect([...colour]).toEqual([200, 150, 100, 40, 10, 20, 30, 255]);
  });
});

describe('alpha cards', () => {
  const card = () => new THREE.MeshStandardMaterial({ name: 'Hair', map: new THREE.Texture(), transparent: true, depthWrite: false });
  const fringeOf = (mesh: THREE.Object3D) => mesh.children.find(child => child.userData[CARD_FRINGE_KEY]) as THREE.Mesh | undefined;

  it('draw a solid, alpha-tested body that writes depth, with the soft fringe blended over it by a copy sharing the geometry', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), card());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const root = new THREE.Group().add(mesh);
    splitAlphaCards(root);
    const body = mesh.material as THREE.MeshStandardMaterial;
    expect(body).toMatchObject({ transparent: false, depthWrite: true, alphaTest: CARD_ALPHA_CUTOFF, name: 'Hair' });
    const fringe = fringeOf(mesh)!;
    expect(fringe.geometry).toBe(mesh.geometry);
    expect(fringe.material).toMatchObject({ transparent: true, depthWrite: false, alphaTest: 0 });
    // Only the body casts shadows, shaped by its alpha.
    expect(fringe.castShadow).toBe(false);
    expect(fringe.receiveShadow).toBe(true);
    // Splitting again changes nothing.
    splitAlphaCards(root);
    expect(mesh.children.filter(child => child.userData[CARD_FRINGE_KEY])).toHaveLength(1);
  });

  it('leave glass, glows and alpha-tested cutouts as they are', () => {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture(), transparent: true, opacity: 0.4 }));
    const glow = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture(), transparent: true, blending: THREE.AdditiveBlending }));
    const cutout = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.3 }));
    const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true }));
    const root = new THREE.Group().add(glass, glow, cutout, plain);
    const before = [glass, glow, cutout, plain].map(mesh => mesh.material);
    splitAlphaCards(root);
    expect([glass, glow, cutout, plain].map(mesh => mesh.material)).toEqual(before);
    [glass, glow, cutout, plain].forEach(mesh => expect(fringeOf(mesh)).toBeUndefined());
  });

  it("follow a skinned mesh's skeleton, and draw only the card parts of a mesh with several materials", () => {
    const geometry = new THREE.BoxGeometry();
    const skin = new THREE.MeshStandardMaterial({ name: 'Skin' });
    const mesh = new THREE.SkinnedMesh(geometry, [skin, card()]);
    const bone = new THREE.Bone();
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    const root = new THREE.Group().add(mesh);
    splitAlphaCards(root);
    const fringe = fringeOf(mesh) as THREE.SkinnedMesh;
    expect(fringe.isSkinnedMesh).toBe(true);
    expect(fringe.skeleton).toBe(mesh.skeleton);
    expect(fringe.bindMatrix.equals(mesh.bindMatrix)).toBe(true);
    const [bodySkin, bodyHair] = mesh.material as THREE.Material[];
    expect(bodySkin).toBe(skin);
    expect(bodyHair).toMatchObject({ transparent: false, alphaTest: CARD_ALPHA_CUTOFF });
    const [fringeSkin, fringeHair] = fringe.material as THREE.Material[];
    expect(fringeSkin.visible).toBe(false);
    expect(fringeHair.transparent).toBe(true);
    // The material list shows the model's materials, not the fringe's stand-in.
    expect(listModelMaterials(root).map(entry => entry.name).sort()).toEqual(['Hair', 'Skin']);
  });
});
