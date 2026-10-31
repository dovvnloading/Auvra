import type * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shares the corners of every mesh under `root` that has none shared yet, which is what the
 * simplifier collapses. A mesh of many materials welds too: its groups stay in the same order over
 * the new indices, where its GLB export would otherwise give it an identity index and no detail
 * levels. A geometry several meshes use stays shared.
 */
export const weldMeshes = (root: THREE.Object3D): void => {
  const welded = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.geometry.index) return;
    let geometry = welded.get(mesh.geometry);
    if (!geometry) {
      geometry = mergeVertices(mesh.geometry);
      welded.set(mesh.geometry, geometry);
    }
    mesh.geometry = geometry;
  });
  for (const geometry of welded.keys()) geometry.dispose();
};
