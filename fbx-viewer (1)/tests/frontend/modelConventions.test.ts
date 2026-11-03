import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { gltfReport } from '../../utils/fbxImport/gltfReport';
import { hullMasses } from '../../runtime/components/physicsComponents';
import { modelTriangles } from '../../runtime/navGeometry';
import { AUTHORED_COLLISION_KEY, AUTHORED_SOCKETS_KEY, authoredHullsUnder, takeModelConventions, type AuthoredHull, type AuthoredSocket } from '../../utils/modelConventions';

const meshNamed = (name: string, position: [number, number, number] = [0, 0, 0], size = 1): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
  mesh.name = name;
  mesh.position.set(...position);
  return mesh;
};

const namesIn = (root: THREE.Object3D): string[] => {
  const names: string[] = [];
  root.traverse((node) => { if (node !== root) names.push(node.name); });
  return names;
};

describe('what names say in a model file', () => {
  it('takes collision shapes out of what is drawn and keeps them as hulls in the root\'s space', () => {
    const root = new THREE.Group();
    root.add(meshNamed('Crate'), meshNamed('UCX_Crate_00', [2, 0, 0]), meshNamed('UBX_Crate_01', [0, 2, 0]), meshNamed('USP_ball', [0, 0, 2]), meshNamed('UCP_pole'));
    const found = takeModelConventions(root);
    expect(found.hulls).toBe(4);
    expect(namesIn(root)).toEqual(['Crate']);
    const hulls = root.userData[AUTHORED_COLLISION_KEY] as AuthoredHull[];
    expect(hulls).toHaveLength(4);
    // A unit box two along X: its corners run from 1.5 to 2.5.
    const xs = hulls[0].points.filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(1.5);
    expect(Math.max(...xs)).toBeCloseTo(2.5);
  });

  it('leaves a name that only starts the same way alone', () => {
    const root = new THREE.Group();
    root.add(meshNamed('UCXylophone'), meshNamed('SOCKETS'), meshNamed('Boots_LODGE'), meshNamed('usp_slide'), meshNamed('socket_wrench'));
    expect(takeModelConventions(root)).toEqual({ hulls: 0, sockets: 0, detailLevelsLeftOut: 0, hiddenLeftOut: 0 });
    expect(namesIn(root)).toEqual(['UCXylophone', 'SOCKETS', 'Boots_LODGE', 'usp_slide', 'socket_wrench']);
  });

  it('never takes a bone', () => {
    const root = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'UCX_Spine';
    root.add(bone);
    takeModelConventions(root);
    expect(namesIn(root)).toEqual(['UCX_Spine']);
  });

  it('reads a socket at its place against the bone above it', () => {
    const root = new THREE.Group();
    const hand = new THREE.Bone();
    hand.name = 'Hand';
    hand.position.set(1, 0, 0);
    hand.rotation.z = Math.PI / 2;
    root.add(hand);
    const muzzle = new THREE.Group();
    muzzle.name = 'SOCKET_Muzzle';
    muzzle.position.set(0, 0.5, 0);
    muzzle.rotation.x = 0.25;
    muzzle.scale.setScalar(2);
    hand.add(muzzle);
    expect(takeModelConventions(root).sockets).toBe(1);
    expect(namesIn(root)).toEqual(['Hand']);
    const [socket] = root.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[];
    expect(socket.name).toBe('Muzzle');
    expect(socket.boneName).toBe('Hand');
    expect(socket.position[1]).toBeCloseTo(0.5);
    // In degrees, as sockets keep their rotation.
    expect(socket.rotation[0]).toBeCloseTo(THREE.MathUtils.radToDeg(0.25));
    // A place and a direction: what a file scales it by is no size of its own.
    expect(socket.scale).toEqual([1, 1, 1]);
  });

  it('keeps a mirrored socket, whose scale the project would refuse', () => {
    const root = new THREE.Group();
    const socket = new THREE.Group();
    socket.name = 'SOCKET_Left';
    socket.position.set(1, 0, 0);
    socket.scale.set(-1, 1, 1);
    root.add(socket);
    takeModelConventions(root);
    const [read] = root.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[];
    expect(read.scale).toEqual([1, 1, 1]);
    expect(read.position).toEqual([1, 0, 0]);
  });

  it('keeps the name a file gave a socket, not the one tidied for animation', () => {
    const root = new THREE.Group();
    const socket = new THREE.Group();
    socket.name = 'SOCKET_Hand001';
    socket.userData.name = 'SOCKET_Hand.001';
    root.add(socket);
    takeModelConventions(root);
    expect((root.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[])[0].name).toBe('Hand.001');
  });

  it('has a socket follow a moving node above it, and only a moving one', () => {
    const root = new THREE.Group();
    const barrel = new THREE.Group();
    barrel.name = 'Barrel';
    barrel.position.set(0, 2, 0);
    const socket = new THREE.Group();
    socket.name = 'SOCKET_Muzzle';
    socket.position.set(0, 1, 0);
    barrel.add(socket);
    root.add(barrel);
    const still = root.clone();
    takeModelConventions(still);
    expect((still.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[])[0]).toMatchObject({ boneName: '', position: [0, 3, 0] });
    const spin = new THREE.AnimationClip('Spin', 1, [new THREE.QuaternionKeyframeTrack('Barrel.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
    takeModelConventions(root, [spin]);
    expect((root.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[])[0]).toMatchObject({ boneName: 'Barrel', position: [0, 1, 0] });
  });

  it('reads a socket under no bone against the model', () => {
    const root = new THREE.Group();
    const socket = new THREE.Group();
    socket.name = 'SOCKET_Top';
    socket.position.set(0, 3, 0);
    root.add(socket);
    takeModelConventions(root);
    const [read] = root.userData[AUTHORED_SOCKETS_KEY] as AuthoredSocket[];
    expect(read.boneName).toBe('');
    expect(read.position).toEqual([0, 3, 0]);
  });

  it('keeps only the finest of a chain of detail levels', () => {
    const root = new THREE.Group();
    root.add(meshNamed('Chair_LOD2'), meshNamed('Chair_LOD0'), meshNamed('Chair_LOD1'), meshNamed('Table_LOD0'));
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(2);
    expect(namesIn(root).sort()).toEqual(['Chair_LOD0', 'Table_LOD0']);
  });

  it('takes the mesh with the plain name as the finest of its levels', () => {
    const root = new THREE.Group();
    root.add(meshNamed('Crate'), meshNamed('Crate_LOD1'), meshNamed('Crate_LOD2'));
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(2);
    expect(namesIn(root)).toEqual(['Crate']);
  });

  it('keeps a lone level with nothing finer beside it', () => {
    const root = new THREE.Group();
    const empty = new THREE.Group();
    empty.name = 'Crate';
    root.add(empty, meshNamed('Crate_LOD1'), meshNamed('Wheel_LOD1'));
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(0);
    expect(namesIn(root)).toEqual(['Crate', 'Crate_LOD1', 'Wheel_LOD1']);
  });

  it('does not take copies of a mesh for its levels, as Blender numbers them', () => {
    const root = new THREE.Group();
    for (const [tidied, name] of [['Wheel_LOD0', 'Wheel_LOD0'], ['Wheel_LOD0001', 'Wheel_LOD0.001'], ['Wheel_LOD0002', 'Wheel_LOD0.002']]) {
      const mesh = meshNamed(tidied);
      mesh.userData.name = name;
      root.add(mesh);
    }
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(0);
    expect(namesIn(root)).toEqual(['Wheel_LOD0', 'Wheel_LOD0001', 'Wheel_LOD0002']);
  });

  it('keeps the chains of separate parents apart', () => {
    const root = new THREE.Group();
    for (const side of ['Left', 'Right']) {
      const group = new THREE.Group();
      group.name = side;
      group.add(meshNamed('Handle_LOD0'), meshNamed('Handle_LOD1'));
      root.add(group);
    }
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(2);
    expect(namesIn(root)).toEqual(['Left', 'Handle_LOD0', 'Right', 'Handle_LOD0']);
  });

  it('keeps the first child of a file\'s detail group', () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.name = 'Chair';
    group.userData.lodGroup = { relative: true, distances: [0, 10] };
    group.add(meshNamed('Near'), meshNamed('Far'));
    root.add(group);
    expect(takeModelConventions(root).detailLevelsLeftOut).toBe(1);
    expect(namesIn(root)).toEqual(['Chair', 'Near']);
  });

  it('leaves out a mesh hidden in the art tool', () => {
    const root = new THREE.Group();
    const helper = meshNamed('Helper');
    helper.userData.hidden = true;
    root.add(meshNamed('Body'), helper);
    expect(takeModelConventions(root).hiddenLeftOut).toBe(1);
    expect(namesIn(root)).toEqual(['Body']);
  });

  it('keeps hidden meshes when nothing else would be left to draw', () => {
    const root = new THREE.Group();
    const only = meshNamed('Body');
    only.userData.hidden = true;
    root.add(only);
    expect(takeModelConventions(root).hiddenLeftOut).toBe(0);
    expect(namesIn(root)).toEqual(['Body']);
  });

  it('leaves out a hidden mesh under a hidden group when something else is drawn', () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.name = 'Helpers';
    group.userData.hidden = true;
    const inner = meshNamed('Helper');
    inner.userData.hidden = true;
    group.add(inner);
    root.add(meshNamed('Body'), group);
    expect(takeModelConventions(root).hiddenLeftOut).toBeGreaterThan(0);
    expect(namesIn(root)).toEqual(['Body']);
  });

  it('keeps collision shapes drawn when nothing else would be left to draw, and they still collide', () => {
    const root = new THREE.Group();
    root.add(meshNamed('USP_Slide'), meshNamed('USP_Frame', [0, 1, 0]));
    expect(takeModelConventions(root).hulls).toBe(2);
    expect(namesIn(root)).toEqual(['USP_Slide', 'USP_Frame']);
  });

  it('reads a hidden collision shape all the same, as artists hide those', () => {
    const root = new THREE.Group();
    const hull = meshNamed('UCX_Body');
    hull.userData.hidden = true;
    root.add(meshNamed('Body'), hull);
    expect(takeModelConventions(root)).toMatchObject({ hulls: 1, hiddenLeftOut: 0 });
  });

  it('reads collision shapes kept in a hidden group', () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.name = 'Collision';
    group.userData.hidden = true;
    group.add(meshNamed('UCX_Body'));
    root.add(meshNamed('Body'), group);
    expect(takeModelConventions(root)).toMatchObject({ hulls: 1, hiddenLeftOut: 1 });
    expect(namesIn(root)).toEqual(['Body']);
  });

  it('gives hulls to physics in the space of the object they are under, and skips what it is told to', () => {
    const model = new THREE.Group();
    model.scale.setScalar(0.01);
    model.add(meshNamed('UCX_A', [100, 0, 0], 100));
    takeModelConventions(model);
    const host = new THREE.Group();
    host.position.set(5, 0, 0);
    host.add(model);
    const copy = model.clone();
    copy.userData = JSON.parse(JSON.stringify(model.userData));
    host.remove(model);
    host.add(copy);
    host.updateMatrixWorld(true);
    const [hull] = authoredHullsUnder(host, () => false);
    expect(Math.max(...Array.from(hull).filter((_, index) => index % 3 === 0))).toBeCloseTo(1.5);
    expect(authoredHullsUnder(host, () => true)).toEqual([]);
    // The model itself can be asked, as well as what holds it.
    expect(authoredHullsUnder(copy, () => false)).toHaveLength(1);
    // And for its shapes in the space of what holds it, as navigation does.
    const toParent = new THREE.Matrix4().copy(host.matrixWorld).invert();
    const [placed] = authoredHullsUnder(copy, () => false, toParent);
    expect(Math.max(...Array.from(placed).filter((_, index) => index % 3 === 0))).toBeCloseTo(1.5);
  });
});

describe('what navigation makes of them', () => {
  it('hands navigation the file\'s shapes, in the space the model is placed in', () => {
    const model = new THREE.Group();
    model.scale.setScalar(0.5);
    model.add(meshNamed('Body'), meshNamed('UCX_A', [4, 0, 0]));
    takeModelConventions(model);
    const host = new THREE.Group();
    host.position.set(10, 0, 0);
    host.add(model);
    host.updateMatrixWorld(true);
    const content = modelTriangles(model)!;
    expect(content.hulls).toHaveLength(1);
    const xs = Array.from(content.hulls![0]).filter((_, index) => index % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(2.25);
  });

  it('shares a body\'s mass by the room each shape takes', () => {
    const box = (size: number): Float32Array => new Float32Array([0, 0, 0, size, size, size]);
    const [large, small] = hullMasses([box(1), box(0.1)], 10) as number[];
    expect(large + small).toBeCloseTo(10);
    expect(small).toBeLessThan(0.05);
    expect(hullMasses([box(1)], undefined)).toEqual([undefined]);
  });
});

describe('what a glTF file is said to hold', () => {
  it('counts collision shapes and sockets by name, as the importer does for its formats', () => {
    const report = gltfReport({
      asset: { version: '2.0' },
      nodes: [{ name: 'UCX_A' }, { name: 'UBX_B' }, { name: 'SOCKET_C' }, { name: 'Other' }],
    } as Parameters<typeof gltfReport>[0]);
    expect(report.collisionMeshes).toBe(2);
    expect(report.sockets).toBe(1);
  });

  it('measures what comes in, not what names leave out', () => {
    const accessors = [
      { count: 3, min: [0, 0, 0], max: [1, 1, 1] },
      { count: 3, min: [50, 50, 50], max: [60, 60, 60] },
    ];
    const meshes = [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }];
    const report = gltfReport({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1, 2, 3] }],
      nodes: [{ name: 'Crate', mesh: 0 }, { name: 'UCX_Crate', mesh: 1 }, { name: 'Crate_LOD1', mesh: 1 }, { name: 'Other_LOD1', mesh: 0 }],
      meshes,
      accessors,
    } as Parameters<typeof gltfReport>[0]);
    expect(report.boundsMax).toEqual([1, 1, 1]);
    expect(report.meshes).toBe(4);
    // A file with nothing else is measured whole.
    const whole = gltfReport({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'UCX_Only', mesh: 1 }],
      meshes,
      accessors,
    } as Parameters<typeof gltfReport>[0]);
    expect(whole.boundsMax).toEqual([60, 60, 60]);
  });
});
