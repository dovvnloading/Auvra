import * as THREE from 'three';

interface PaintedGeometry {
  geometry: THREE.BufferGeometry;
  original?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  colors: THREE.BufferAttribute;
  skeleton: THREE.Skeleton;
}
interface WeightDisplay {
  material: THREE.MeshBasicMaterial;
  originals: Map<THREE.Mesh, THREE.Mesh['material']>;
  parts: PaintedGeometry[];
}

// The viewer and session share responsibility for teardown: a session can end before React unmounts.
const displays = new WeakMap<THREE.Object3D, WeightDisplay>();
const NEUTRAL = new THREE.Color('#333847');
const COOL = new THREE.Color('#0d40d9');
const MID = new THREE.Color('#1ad966');
const HOT = new THREE.Color('#f2261a');

const startDisplay = (root: THREE.Object3D): WeightDisplay => {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false, fog: false });
  const originals = new Map<THREE.Mesh, THREE.Mesh['material']>();
  const parts: PaintedGeometry[] = [];
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry;
    if (!seen.has(geometry)) {
      seen.add(geometry);
      const original = geometry.getAttribute('color');
      const count = geometry.getAttribute('position').count;
      const colors = new THREE.Uint8BufferAttribute(new Uint8Array(count * 3), 3, true);
      colors.setUsage(THREE.DynamicDrawUsage);
      parts.push({ geometry, original, colors, skeleton: mesh.skeleton });
      if (original) geometry.dispose(); // Release its old color buffer before replacing the attribute.
      geometry.setAttribute('color', colors);
    }
    originals.set(mesh, mesh.material);
    mesh.material = material;
  });
  const display = { material, originals, parts };
  displays.set(root, display);
  return display;
};

/** Colors the isolated review mesh with standard vertex attributes supported by both editor renderers. */
export const showPreviewWeights = (root: THREE.Object3D, boneName: string): void => {
  const { parts } = displays.get(root) ?? startDisplay(root);
  const color = new THREE.Color();
  for (const { geometry, colors, skeleton } of parts) {
    const joints = geometry.getAttribute('skinIndex');
    const weights = geometry.getAttribute('skinWeight');
    const index = skeleton.bones.findIndex(bone => bone.name === boneName);
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      let weight = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        if (joints.getComponent(vertex, slot) === index) weight += weights.getComponent(vertex, slot);
      }
      if (weight < 0.004) color.copy(NEUTRAL);
      else if (weight < 0.5) color.lerpColors(COOL, MID, weight * 2);
      else color.lerpColors(MID, HOT, (weight - 0.5) * 2);
      colors.setXYZ(vertex, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }
};

/** Restore the preview's own materials so normal model cleanup can release all its textures. */
export const clearPreviewWeights = (root: THREE.Object3D): void => {
  const display = displays.get(root);
  if (!display) return;
  for (const [mesh, previous] of display.originals) mesh.material = previous;
  for (const { geometry, original } of display.parts) {
    geometry.dispose(); // Drop the color buffer while it is still attached.
    if (original) geometry.setAttribute('color', original);
    else geometry.deleteAttribute('color');
  }
  display.material.dispose();
  displays.delete(root);
};
