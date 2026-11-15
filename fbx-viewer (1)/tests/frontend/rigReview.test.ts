import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { RigJoint } from '../../utils/autoRig/bodySkeleton';
import { standardReading } from '../../utils/autoRig/rigBody';
import { clearPreviewWeights, showPreviewWeights } from '../../utils/autoRig/previewWeights';
import { inspectRig, poseRigReview } from '../../utils/autoRig/rigReview';
import {
  cancelRig, completeRigSave, finishRig, getRigPreview, previewRig, reviewedRigFile, reviseRig, startRig, syncRigTarget,
} from '../../utils/autoRig/rigSession';
import { writeGlb } from '../../utils/gltfContainer';
import type { AutoRigRequest, AutoRigResponse } from '../../workers/autoRig.worker';

const positions = new Float32Array([0, 0, 0, 0, 1, 0, 0, 2, 0.2]);
const joints: RigJoint[] = [
  { name: 'Hips', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0, 1], skins: true },
  { name: 'LeftForeArm', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0, 1], skins: true },
];
const skin = () => ({
  joints: Uint16Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]),
  weights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
});

describe('checking a bind before preview and export', () => {
  it('measures the actual number of positive influences and weighted vertices', () => {
    const weights = skin();
    weights.joints[5] = 1;
    weights.weights.set([0.75, 0.25], 4);
    expect(inspectRig(joints, [{ positions }], [weights], 2)).toEqual({
      vertices: 3, joints: 2, primitives: 1, maxInfluences: 2, boneNames: ['Hips', 'LeftForeArm'],
    });
    expect(() => inspectRig(joints, [{ positions }], [weights], 1)).toThrow(/binding limits/);
  });

  it('rejects malformed hierarchy, transforms, indices and weights', () => {
    const check = (changed: ReturnType<typeof skin>) => inspectRig(joints, [{ positions }], [changed], 4);
    const badIndex = skin();
    badIndex.joints[8] = 2;
    expect(() => check(badIndex)).toThrow(/invalid skin weight/);
    const badWeight = skin();
    for (const value of [0, 0.8, NaN, -1]) {
      badWeight.weights[8] = value;
      expect(() => check(badWeight)).toThrow();
    }
    expect(() => inspectRig([...joints].reverse(), [{ positions }], [skin()], 4)).toThrow(/hierarchy/);
    expect(() => inspectRig([{ ...joints[0], rotation: [0, 0, 0, 0] }], [{ positions }], [skin()], 4)).toThrow(/transform/);
    expect(() => inspectRig(joints, [{ positions }], [], 4)).toThrow(/incomplete|complete/);
  });
});

const source = () => {
  const glb = writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Body', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 2, 0.2] }],
  }, new Uint8Array(positions.buffer));
  return new File([glb], 'Body.glb', { type: 'model/gltf-binary' });
};

class ReviewWorker {
  static count = 0;
  static holdBind = false;
  static terminated = 0;
  onmessage: ((event: { data: AutoRigResponse }) => void) | null = null;
  postMessage(request: AutoRigRequest): void {
    if (request.type === 'rig') ReviewWorker.count += 1;
    if (request.type === 'rig' && ReviewWorker.holdBind) return;
    const data: AutoRigResponse = request.type === 'read'
      ? { type: 'read', reading: standardReading(request.triangles), guessed: true }
      : { type: 'rigged', joints, weights: [skin()] };
    queueMicrotask(() => this.onmessage?.({ data }));
  }
  terminate(): void { ReviewWorker.terminated += 1; }
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:rig-review' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  ReviewWorker.count = 0;
  ReviewWorker.holdBind = false;
  ReviewWorker.terminated = 0;
  vi.stubGlobal('Worker', ReviewWorker);
});
afterEach(() => { cancelRig(); vi.unstubAllGlobals(); });

describe('reviewing the exported GLB', () => {
  it('poses only the bound preview, restores rest exactly and retries the identical file', async () => {
    const original = new THREE.Group();
    await startRig('body', original, source());
    expect(await finishRig('Body.glb', original)).toBeNull();
    await previewRig('Body.glb', original);
    const preview = getRigPreview('body', original)!;
    expect(preview).toBeDefined();
    const root = preview.model.object;
    const mesh = root.getObjectByName('Body') as THREE.SkinnedMesh;
    const vertex = (index: number) => {
      root.updateMatrixWorld(true);
      return mesh.getVertexPosition(index, new THREE.Vector3());
    };
    const rest = vertex(2);
    const fixed = vertex(0);
    poseRigReview(preview.bones, 'person', 'flex', 1);
    expect(vertex(2).distanceTo(rest)).toBeGreaterThan(0.5);
    expect(vertex(0).distanceTo(fixed)).toBeLessThan(1e-6);
    poseRigReview(preview.bones, 'person', 'rest', 1);
    expect(vertex(2).distanceTo(rest)).toBeLessThan(1e-6);
    poseRigReview(preview.bones, 'person', 'joint', 0.5, { name: 'LeftForeArm', axis: 'z', angle: 90 });
    expect(vertex(2).x).toBeCloseTo(-Math.SQRT1_2);
    expect(original.children).toHaveLength(0);

    const textured = mesh.material;
    showPreviewWeights(root, 'LeftForeArm');
    const colors = mesh.geometry.getAttribute('color');
    expect(colors.getX(2)).toBeGreaterThan(colors.getX(0)); // Only the moved vertex is fully weighted.
    showPreviewWeights(root, 'Hips');
    expect(mesh.geometry.getAttribute('color')).toBe(colors);
    expect(colors.getX(0)).toBeGreaterThan(colors.getX(2));
    clearPreviewWeights(root);
    expect(mesh.material).toBe(textured);
    expect(mesh.geometry.getAttribute('color')).toBeUndefined();

    const file = reviewedRigFile(original)!;
    expect(await finishRig('Body.glb', original)).toBe(file);
    completeRigSave(file, false, 'Disk full');
    expect(reviewedRigFile(original)).toBe(file);
    expect(await finishRig('Body.glb', original)).toBe(file);
    completeRigSave(file, true);
    expect(getRigPreview('body', original)).toBeUndefined();
    expect(ReviewWorker.count).toBe(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('discards a superseded bind and ignores its late save callback', async () => {
    const original = new THREE.Group();
    await startRig('body', original, source());
    await previewRig('Body.glb', original);
    const stale = reviewedRigFile(original)!;
    const first = getRigPreview('body', original)!;
    const firstMesh = first.model.object.getObjectByName('Body') as THREE.SkinnedMesh;
    const dispose = vi.spyOn(firstMesh.skeleton, 'dispose');
    reviseRig();
    expect(reviewedRigFile(original)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledOnce();
    await previewRig('Body.glb', original);
    const second = await finishRig('Body.glb', original);
    expect(second).not.toBe(stale);
    completeRigSave(stale, true);
    expect(getRigPreview('body', original)?.file).toBe(second);
  });

  it('settles an in-flight bind when selection changes and releases its worker', async () => {
    const original = new THREE.Group();
    await startRig('body', original, source());
    ReviewWorker.holdBind = true;
    const pending = previewRig('Body.glb', original);
    expect(ReviewWorker.count).toBe(1);
    syncRigTarget('body', new THREE.Group());
    await pending;
    expect(ReviewWorker.terminated).toBe(1);
    expect(reviewedRigFile(original)).toBeNull();
  });
});
