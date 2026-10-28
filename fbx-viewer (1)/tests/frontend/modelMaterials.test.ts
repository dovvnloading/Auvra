import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { optimizeModelMaterials } from '../../utils/processing/ModelMaterials';
import { writeOpacity } from '../../utils/processing/opacityMaps';

const meshWith = (material: THREE.Material) => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  group.add(mesh);
  optimizeModelMaterials(group);
  return mesh.material as THREE.MeshStandardMaterial;
};

describe('model material optimization', () => {
  it('drops the white emissive exporters write on standard materials (glTF round trip)', () => {
    const material = meshWith(new THREE.MeshStandardMaterial({ color: 0xcccccc, emissive: 0xffffff }));
    expect(material.emissive.getHex()).toBe(0x000000);
  });

  it('drops emissive colour whose strength is zero', () => {
    const material = meshWith(new THREE.MeshStandardMaterial({ emissive: 0x4080ff, emissiveIntensity: 0 }));
    expect(material.emissive.getHex()).toBe(0x000000);
  });

  it('keeps real emissive colour and emissive maps', () => {
    expect(meshWith(new THREE.MeshStandardMaterial({ emissive: 0xff2000 })).emissive.getHex()).toBe(0xff2000);
    const map = new THREE.Texture();
    const mapped = meshWith(new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveMap: map }));
    expect(mapped.emissive.getHex()).toBe(0xffffff);
  });

  it('keeps a material drawn through the alpha of its colour map transparent (an FBX opacity map baked for glTF)', () => {
    const material = meshWith(new THREE.MeshStandardMaterial({ map: new THREE.Texture(), transparent: true, depthWrite: false }));
    expect(material.transparent).toBe(true);
  });
});

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
