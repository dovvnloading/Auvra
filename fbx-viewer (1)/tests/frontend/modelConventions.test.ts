import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { gltfReport } from '../../utils/fbxImport/gltfReport';
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
    root.add(meshNamed('Crate'), meshNamed('UCX_Crate_00', [2, 0, 0]), meshNamed('UBX_Crate_01', [0, 2, 0]), meshNamed('usp_ball', [0, 0, 2]), meshNamed('UCP_pole'));
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
    root.add(meshNamed('UCXylophone'), meshNamed('SOCKETS'), meshNamed('Boots_LODGE'));
    expect(takeModelConventions(root)).toEqual({ hulls: 0, sockets: 0, detailLevelsLeftOut: 0, hiddenLeftOut: 0 });
    expect(namesIn(root)).toEqual(['UCXylophone', 'SOCKETS', 'Boots_LODGE']);
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
    expect(socket.scale[0]).toBeCloseTo(2);
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
});
