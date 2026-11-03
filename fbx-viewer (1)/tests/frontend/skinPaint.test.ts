import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { edgesOf, weldVertices } from '../../utils/autoRig/skinWeights';
import { applySkinPaint, readModelSkin } from '../../utils/skinPaint/modelSkin';
import { SkinPaintSession, type SkinPaintHit } from '../../utils/skinPaint/paintSession';
import { decodeSkinPaint, encodeSkinPaint, NO_PAINTED_BONE, type SkinPaintFile } from '../../utils/skinPaint/skinPaintFile';
import { VertexPlaces } from '../../utils/skinPaint/vertexPlaces';
import { addBone, BONES_PER_VERTEX, NO_BONE, removeBone, shareOf, smoothedVertex, WeightMix, type VertexWeights } from '../../utils/skinPaint/weights';

const weightsOf = (...vertices: [number, number][][]): VertexWeights => {
  const weights: VertexWeights = {
    bones: new Int32Array(vertices.length * BONES_PER_VERTEX).fill(NO_BONE),
    shares: new Float32Array(vertices.length * BONES_PER_VERTEX),
  };
  vertices.forEach((list, vertex) => list.forEach(([bone, share], slot) => {
    weights.bones[vertex * BONES_PER_VERTEX + slot] = bone;
    weights.shares[vertex * BONES_PER_VERTEX + slot] = share;
  }));
  return weights;
};

const expectWhole = (weights: VertexWeights, vertex: number): void => {
  let total = 0;
  let used = 0;
  for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
    if (weights.bones[vertex * BONES_PER_VERTEX + slot] === NO_BONE) continue;
    total += weights.shares[vertex * BONES_PER_VERTEX + slot];
    used += 1;
  }
  expect(used).toBeLessThanOrEqual(BONES_PER_VERTEX);
  expect(total).toBeCloseTo(1, 5);
};

const noHeirs = (): boolean => false;

describe('changing a vertex', () => {
  it('adding moves the bone up and the others down in proportion', () => {
    const weights = weightsOf([[0, 0.6], [1, 0.4]]);
    addBone(weights, 0, 1, 0.5, new WeightMix(4));
    expect(shareOf(weights, 0, 1)).toBeCloseTo(0.7, 5);
    expect(shareOf(weights, 0, 0)).toBeCloseTo(0.3, 5);
    expectWhole(weights, 0);
  });

  it('adding a fifth bone drops the weakest, and the new one stays however small', () => {
    const weights = weightsOf([[0, 0.4], [1, 0.3], [2, 0.2], [3, 0.1]]);
    addBone(weights, 0, 4, 0.02, new WeightMix(5));
    expect(shareOf(weights, 0, 4)).toBeCloseTo(0.02 / (1 - 0.098), 3);
    expect(shareOf(weights, 0, 3)).toBe(0);
    expectWhole(weights, 0);
  });

  it('at full strength adding leaves the bone alone', () => {
    const weights = weightsOf([[0, 0.5], [1, 0.5]]);
    addBone(weights, 0, 1, 1, new WeightMix(2));
    expect(shareOf(weights, 0, 1)).toBeCloseTo(1, 5);
    expect(shareOf(weights, 0, 0)).toBe(0);
    expectWhole(weights, 0);
  });

  it('removing moves the others up in proportion, and a share too small to show goes', () => {
    const weights = weightsOf([[0, 0.5], [1, 0.3], [2, 0.2]]);
    removeBone(weights, 0, 0, 0.5, new WeightMix(3), noHeirs);
    expect(shareOf(weights, 0, 0)).toBeCloseTo(0.25, 5);
    expect(shareOf(weights, 0, 1)).toBeCloseTo(0.45, 5);
    expect(shareOf(weights, 0, 2)).toBeCloseTo(0.3, 5);
    removeBone(weights, 0, 0, 0.99, new WeightMix(3), noHeirs);
    expect(shareOf(weights, 0, 0)).toBe(0);
    expectWhole(weights, 0);
  });

  it('removing a bone that moves it alone hands over to its heirs, or stays when there are none', () => {
    const weights = weightsOf([[0, 1]]);
    removeBone(weights, 0, 0, 0.5, new WeightMix(3), noHeirs);
    expect(shareOf(weights, 0, 0)).toBeCloseTo(1, 5);
    removeBone(weights, 0, 0, 1, new WeightMix(3), (mix, _vertex, _bone, share) => {
      mix.add(2, share);
      return true;
    });
    expect(shareOf(weights, 0, 0)).toBe(0);
    expect(shareOf(weights, 0, 2)).toBeCloseTo(1, 5);
    expectWhole(weights, 0);
  });

  it('smoothing moves towards the average of the neighbours and keeps four bones', () => {
    const weights = weightsOf(
      [[0, 1]],
      [[1, 0.5], [2, 0.5]],
      [[3, 0.5], [4, 0.5]],
    );
    const out = weightsOf([]);
    smoothedVertex(weights, 0, [1, 2], 0, 2, 0.5, new WeightMix(5), out, 0);
    // Half stays, and the rest is shared by four bones, of which three can stay.
    expect(shareOf(out, 0, 0)).toBeCloseTo(0.5 / 0.875, 5);
    expect(out.bones.filter((bone) => bone !== NO_BONE).length).toBe(BONES_PER_VERTEX);
    expectWhole(out, 0);
    // What was read stays as it was.
    expect(shareOf(weights, 0, 0)).toBe(1);
  });
});

describe('finding places', () => {
  it('counts points closer than the tolerance as one, across a cell boundary too', () => {
    const places = new VertexPlaces(0.01);
    const cellEdge = 0.08;
    const first = places.add(cellEdge - 0.002, 0, 0);
    expect(places.find(cellEdge + 0.002, 0, 0)).toBe(first);
    expect(places.find(cellEdge + 0.02, 0, 0)).toBe(-1);
  });

  it('welds what bindSkin welds, however it is rounded', () => {
    const part = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1 + 1e-5, 0, 0]), indices: null };
    const { ids, first } = weldVertices([part], 1e-3);
    expect(first.length).toBe(2);
    expect(ids[0][1]).toBe(ids[0][2]);
    expect(edgesOf([part], ids, first.length).links.length).toBe(0 + 6);
  });
});

describe('the painted weights file', () => {
  it('reads back what was written', () => {
    const paint = {
      boneNames: ['Hips', 'Ünï'],
      places: new Float32Array([1, 2, 3]),
      bones: Uint16Array.from([1, 0, NO_PAINTED_BONE, NO_PAINTED_BONE]),
      shares: new Float32Array([0.75, 0.25, 0, 0]),
    };
    const file = encodeSkinPaint(paint);
    expect(file.count).toBe(1);
    const read = decodeSkinPaint(file.bytes);
    expect(read.boneNames).toEqual(paint.boneNames);
    expect([...read.places]).toEqual([...paint.places]);
    expect([...read.bones]).toEqual([...paint.bones]);
    expect([...read.shares]).toEqual([...paint.shares]);
  });

  it('refuses what is not one', () => {
    expect(() => decodeSkinPaint(new Uint8Array(4))).toThrow();
    expect(() => decodeSkinPaint(new Uint8Array(20))).toThrow();
    const file = encodeSkinPaint({ boneNames: [], places: new Float32Array(3), bones: new Uint16Array(4), shares: new Float32Array(4) });
    expect(() => decodeSkinPaint(file.bytes.slice(0, file.bytes.length - 4))).toThrow();
  });
});

/** A strip along x from 0 to 3, split at x = 1 by a texture seam and at x = 2 between two meshes. */
const stripModel = (): { root: THREE.Group; bones: THREE.Bone[]; meshes: THREE.SkinnedMesh[] } => {
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const arm = new THREE.Bone();
  arm.name = 'Arm';
  arm.position.x = 2;
  hips.add(arm);
  const tip = new THREE.Bone();
  tip.name = 'Tip';
  tip.position.x = 1;
  arm.add(tip);
  const root = new THREE.Group();
  root.add(hips);
  const skeleton = (): THREE.Skeleton => new THREE.Skeleton([hips, arm], [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(-2, 0, 0)]);
  // Two by two quads, the row at x = 1 twice over.
  const near = new THREE.BufferGeometry();
  near.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0,
    1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 1, 0,
  ]), 3));
  near.setIndex([0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7]);
  near.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(8 * 4), 4));
  near.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(Array.from({ length: 8 }, () => [1, 0, 0, 0]).flat()), 4));
  const far = new THREE.BufferGeometry();
  far.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    2, 0, 0, 2, 1, 0, 3, 0, 0, 3, 1, 0,
  ]), 3));
  far.setIndex([0, 2, 1, 1, 2, 3]);
  far.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(4 * 4), 4));
  far.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat()), 4));
  const meshes = [near, far].map((geometry) => {
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.bind(skeleton(), new THREE.Matrix4());
    root.add(mesh);
    return mesh;
  });
  root.updateMatrixWorld(true);
  return { root, bones: [hips, arm, tip], meshes };
};

const shareAt = (mesh: THREE.SkinnedMesh, vertex: number, boneName: string): number => {
  const joints = mesh.geometry.getAttribute('skinIndex');
  const shares = mesh.geometry.getAttribute('skinWeight');
  let total = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    if (mesh.skeleton.bones[joints.getComponent(vertex, slot)]?.name === boneName) total += shares.getComponent(vertex, slot);
  }
  return total;
};

const rayDown = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));

const dabAt = (session: SkinPaintSession, x: number, y: number, radius: number, mode: 'add' | 'remove' | 'smooth', bone: string, strength = 1): void => {
  session.updatePose();
  const hit = session.hitAt(rayDown(x, y)) as SkinPaintHit;
  expect(hit).not.toBeNull();
  session.beginStroke();
  session.dab(hit, radius, mode, bone, strength);
  session.endStroke();
};

describe('painting a model', () => {
  it('finds the model under the brush as it stands in its pose', () => {
    const { root, bones } = stripModel();
    const session = new SkinPaintSession(root);
    session.updatePose();
    expect(session.hitAt(rayDown(0.5, 0.5))?.point.z).toBeCloseTo(0, 5);
    expect(session.hitAt(rayDown(5, 0.5))).toBeNull();
    bones[0].position.y = 10;
    root.updateMatrixWorld(true);
    session.updatePose();
    expect(session.hitAt(rayDown(0.5, 0.5))).toBeNull();
    expect(session.hitAt(rayDown(0.5, 10.5))?.point.y).toBeCloseTo(10.5, 5);
  });

  it('keeps vertices at one place in step across a seam and between meshes', () => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    expect(session.placeCount).toBe(8);
    dabAt(session, 1, 0.5, 2, 'add', 'Arm');
    // Both copies of the row at the seam.
    expect(shareAt(meshes[0], 2, 'Arm')).toBeGreaterThan(0);
    expect(shareAt(meshes[0], 2, 'Arm')).toBe(shareAt(meshes[0], 4, 'Arm'));
    // The row at x = 2 in the near mesh and in the far one.
    expect(shareAt(meshes[0], 6, 'Arm')).toBeGreaterThan(0);
    expect(shareAt(meshes[0], 6, 'Arm')).toBeCloseTo(shareAt(meshes[1], 0, 'Arm'), 6);
    // Further away nothing.
    expect(shareAt(meshes[1], 2, 'Arm')).toBe(0);
  });

  it('every vertex it touches stays whole, in add, remove and smooth', () => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    dabAt(session, 1, 0.5, 1.5, 'add', 'Arm', 0.7);
    dabAt(session, 1.5, 0.5, 1.5, 'remove', 'Hips', 0.4);
    dabAt(session, 2, 0.5, 2, 'smooth', 'Arm', 0.8);
    for (const mesh of meshes) {
      const shares = mesh.geometry.getAttribute('skinWeight');
      for (let vertex = 0; vertex < shares.count; vertex += 1) {
        let total = 0;
        for (let slot = 0; slot < 4; slot += 1) total += shares.getComponent(vertex, slot);
        expect(total).toBeCloseTo(1, 5);
      }
    }
  });

  it('a mesh given a bone it did not have keeps its vertices where they stood', () => {
    const { root, bones, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    session.updatePose();
    const before = session.surface.slice();
    expect(meshes[0].skeleton.bones.includes(bones[2])).toBe(false);
    dabAt(session, 1, 0.5, 2, 'add', 'Tip');
    expect(meshes[0].skeleton.bones.includes(bones[2])).toBe(true);
    expect(meshes[0].skeleton.boneInverses.length).toBe(meshes[0].skeleton.bones.length);
    expect(meshes[0].skeleton.boneMatrices?.length).toBeGreaterThanOrEqual(3 * 16);
    session.updatePose();
    session.surface.forEach((value, index) => expect(value).toBeCloseTo(before[index], 4));
    // And follows it when it moves.
    bones[2].position.y += 3;
    root.updateMatrixWorld(true);
    session.updatePose();
    expect(session.surface.some((value, index) => Math.abs(value - before[index]) > 0.5)).toBe(true);
  });

  it('what the brush leaves as it was is not painted', () => {
    const { root } = stripModel();
    const session = new SkinPaintSession(root);
    // Nothing here follows the arm, so there is nothing to take away.
    dabAt(session, 1, 0.5, 1, 'remove', 'Arm');
    expect(session.getStatus().painted).toBe(0);
    expect(session.getStatus().canUndo).toBe(false);
    // All of it follows the hips already.
    dabAt(session, 1, 0.5, 1, 'add', 'Hips');
    expect(session.getStatus().painted).toBe(0);
    // And it is all one bone, so evening it out changes nothing.
    dabAt(session, 1, 0.5, 1, 'smooth', 'Hips');
    expect(session.getStatus().painted).toBe(0);
    expect(session.getStatus().canUndo).toBe(false);
  });

  it('undo waits for the stroke under way', () => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    dabAt(session, 1, 0.5, 1, 'add', 'Arm', 0.5);
    const first = shareAt(meshes[0], 2, 'Arm');
    session.updatePose();
    session.beginStroke();
    session.dab(session.hitAt(rayDown(1, 0.5)) as SkinPaintHit, 1, 'add', 'Arm', 0.5);
    session.undo();
    expect(shareAt(meshes[0], 2, 'Arm')).toBeGreaterThan(first);
    session.endStroke();
    session.undo();
    expect(shareAt(meshes[0], 2, 'Arm')).toBeCloseTo(first, 6);
  });

  it('a stroke is one step to undo and redo', () => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    expect(session.getStatus().painted).toBe(0);
    session.updatePose();
    session.beginStroke();
    const hit = session.hitAt(rayDown(1, 0.5)) as SkinPaintHit;
    session.dab(hit, 1, 'add', 'Arm', 0.5);
    session.dab(hit, 1, 'add', 'Arm', 0.5);
    session.endStroke();
    const painted = shareAt(meshes[0], 2, 'Arm');
    expect(painted).toBeGreaterThan(0);
    expect(session.getStatus().painted).toBeGreaterThan(0);
    expect(session.getStatus().canUndo).toBe(true);
    session.undo();
    expect(shareAt(meshes[0], 2, 'Arm')).toBe(0);
    expect(session.getStatus().painted).toBe(0);
    expect(session.getStatus().canRedo).toBe(true);
    session.redo();
    expect(shareAt(meshes[0], 2, 'Arm')).toBeCloseTo(painted, 6);
    expect(session.getStatus().canRedo).toBe(false);
  });

  it('puts back what the file said, as one step to undo', () => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    dabAt(session, 1, 0.5, 2, 'add', 'Arm');
    const painted = shareAt(meshes[0], 2, 'Arm');
    session.putBack();
    expect(shareAt(meshes[0], 2, 'Arm')).toBe(0);
    expect(shareAt(meshes[0], 2, 'Hips')).toBe(1);
    expect(session.getStatus().painted).toBe(0);
    session.undo();
    expect(shareAt(meshes[0], 2, 'Arm')).toBeCloseTo(painted, 6);
  });

  it('saves one at a time, and the last save holds the newest paint', async () => {
    const { root } = stripModel();
    const session = new SkinPaintSession(root);
    const saved: (SkinPaintFile | null)[] = [];
    let release: () => void = () => undefined;
    session.setSaver(async (encode) => {
      await new Promise<void>((resolve) => { release = resolve; });
      saved.push(encode());
    });
    dabAt(session, 1, 0.5, 1, 'add', 'Arm');
    dabAt(session, 2, 0.5, 1, 'add', 'Arm');
    expect(session.getStatus().saving).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve));
    release();
    await session.flush();
    expect(saved.length).toBe(2);
    expect(saved[1]?.count).toBe(session.getStatus().painted);
    session.putBack();
    release();
    await new Promise((resolve) => setTimeout(resolve));
    release();
    await session.flush();
    expect(saved[saved.length - 1]).toBeNull();
  });
});

describe('painted weights on a freshly loaded model', () => {
  const paintedFile = (): { file: SkinPaintFile; share: number } => {
    const { root, meshes } = stripModel();
    const session = new SkinPaintSession(root);
    let file: SkinPaintFile | null = null;
    session.setSaver(async (encode) => { file = encode(); });
    dabAt(session, 1, 0.5, 2, 'add', 'Tip');
    return { file: file!, share: shareAt(meshes[0], 2, 'Tip') };
  };

  it('go back on every vertex standing where they were painted, on any skeleton list', () => {
    const { file, share } = paintedFile();
    const { root, meshes } = stripModel();
    const found = applySkinPaint(root, decodeSkinPaint(file.bytes));
    expect(found).toBe(file.count);
    expect(shareAt(meshes[0], 2, 'Tip')).toBeCloseTo(share, 6);
    expect(shareAt(meshes[0], 4, 'Tip')).toBeCloseTo(share, 6);
    expect(shareAt(meshes[1], 0, 'Tip')).toBeGreaterThan(0);
  });

  it('a session opened afterwards knows what is painted and can put it back', () => {
    const { file } = paintedFile();
    const { root, meshes } = stripModel();
    applySkinPaint(root, decodeSkinPaint(file.bytes), { keepFileWeights: true });
    const session = new SkinPaintSession(root);
    expect(session.getStatus().painted).toBe(file.count);
    session.putBack();
    expect(shareAt(meshes[0], 2, 'Tip')).toBe(0);
    expect(shareAt(meshes[0], 2, 'Hips')).toBe(1);
  });

  it('leave what no longer matches alone, and shares of a missing bone go to the others', () => {
    const paint = {
      boneNames: ['Hips', 'Gone'],
      places: new Float32Array([1, 0, 0, 50, 50, 50]),
      bones: Uint16Array.from([0, 1, NO_PAINTED_BONE, NO_PAINTED_BONE, 0, NO_PAINTED_BONE, NO_PAINTED_BONE, NO_PAINTED_BONE]),
      shares: new Float32Array([0.5, 0.5, 0, 0, 1, 0, 0, 0]),
    };
    const { root, meshes } = stripModel();
    expect(applySkinPaint(root, paint)).toBe(1);
    expect(shareAt(meshes[0], 2, 'Hips')).toBeCloseTo(1, 6);
  });

  it('places in meshes of different spaces are found through a bone they share', () => {
    const { root, meshes } = stripModel();
    // The far mesh's geometry moved two along, and its bind matrices say so.
    const far = meshes[1];
    const position = far.geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex += 1) position.setX(vertex, position.getX(vertex) - 2);
    far.skeleton.boneInverses.forEach((inverse) => inverse.multiply(new THREE.Matrix4().makeTranslation(2, 0, 0)));
    const skin = readModelSkin(root);
    const farPart = skin.parts.find((part) => part.mesh === far)!;
    expect(farPart.rest[0]).toBeCloseTo(2, 5);
    const session = new SkinPaintSession(root);
    expect(session.placeCount).toBe(8);
  });
});
