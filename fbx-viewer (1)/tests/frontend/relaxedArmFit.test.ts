import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { expect, it } from 'vitest';
import { readBody } from '../../utils/autoRig/bodyMarkers';
import { trianglesOf, type RigPrimitive } from '../../utils/autoRig/riggedGlb';

it('finds shoulders and elbows when sleeves touch the torso in the Outpost character’s relaxed pose', () => {
  const bytes = readFileSync('../Auvra/project/templates/outpost/assets/ranger.fbx');
  const source = new FBXLoader().parse(Uint8Array.from(bytes).buffer, '');
  source.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  const parts: Pick<RigPrimitive, 'positions' | 'indices'>[] = [];
  source.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry;
    const positions = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).toArray(positions, vertex * 3);
    }
    parts.push({ positions, indices: geometry.index ? Uint32Array.from(geometry.index.array) : null });
  });
  // Only posed triangles enter the fitter. The authored skeleton is a held-out reference.
  const fit = readBody(trianglesOf(parts))!;
  const height = fit.extents.headTop[1] - fit.extents.floor;
  for (const [marker, bone] of [
    ['leftShoulder', 'LeftArm'], ['rightShoulder', 'RightArm'],
    ['leftElbow', 'LeftForeArm'], ['rightElbow', 'RightForeArm'],
  ] as const) {
    const reference = source.getObjectByName(bone)!.getWorldPosition(point);
    const error = reference.distanceTo(new THREE.Vector3(...fit.markers[marker]));
    expect(error / height, marker).toBeLessThan(0.04);
  }
}, 30000);
