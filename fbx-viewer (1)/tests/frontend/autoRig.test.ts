import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { readBody, turnAboutY, turnSoupAboutY, type Point } from '../../utils/autoRig/bodyMarkers';
import { bodySkeleton, fourLegSkeleton } from '../../utils/autoRig/bodySkeleton';
import { looksFourLegged, readFourLegs } from '../../utils/autoRig/fourLegReading';
import { readFingers } from '../../utils/autoRig/handReading';
import { buildRiggedGlb, trianglesOf, type GltfJson, type RigPrimitive } from '../../utils/autoRig/riggedGlb';
import { readModelConventions } from '../../utils/modelConventions';
import { readAnyBody, readAs, rigBody, standardFourLegReading, standardReading } from '../../utils/autoRig/rigBody';
import { bindSkin } from '../../utils/autoRig/skinWeights';
import { voxelize } from '../../utils/autoRig/voxels';
import { humanoidRole } from '../../utils/retargeting';

/** Corners of a box as triangles, each face split in pieces no bigger than `step`, so skin has vertices all over. */
const box = (min: Point, max: Point, step = 0.05): number[] => {
  const out: number[] = [];
  const quad = (at: (u: number, v: number) => Point, width: number, height: number): void => {
    const us = Math.max(1, Math.ceil(width / step));
    const vs = Math.max(1, Math.ceil(height / step));
    for (let u = 0; u < us; u += 1) {
      for (let v = 0; v < vs; v += 1) {
        const a = at(u / us, v / vs);
        const b = at((u + 1) / us, v / vs);
        const c = at((u + 1) / us, (v + 1) / vs);
        const d = at(u / us, (v + 1) / vs);
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  };
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  quad((u, v) => [x0 + u * dx, y0 + v * dy, z0], dx, dy);
  quad((u, v) => [x0 + u * dx, y0 + v * dy, z1], dx, dy);
  quad((u, v) => [x0, y0 + u * dy, z0 + v * dz], dy, dz);
  quad((u, v) => [x1, y0 + u * dy, z0 + v * dz], dy, dz);
  quad((u, v) => [x0 + u * dx, y0, z0 + v * dz], dx, dz);
  quad((u, v) => [x0 + u * dx, y1, z0 + v * dz], dx, dz);
  return out;
};

/** A figure 1.8 tall, in a T-pose, facing +Z with its left at +X. */
const FIGURE: [Point, Point][] = [
  // Head, neck, chest and belly, hips.
  [[-0.09, 1.58, -0.1], [0.09, 1.8, 0.1]],
  [[-0.05, 1.48, -0.05], [0.05, 1.58, 0.05]],
  [[-0.17, 1.1, -0.11], [0.17, 1.48, 0.11]],
  [[-0.16, 0.86, -0.11], [0.16, 1.1, 0.11]],
  // Arms out to the sides: upper, lower, wrist and hand. They start inside the chest.
  [[0.14, 1.36, -0.05], [0.42, 1.46, 0.05]],
  [[0.42, 1.37, -0.04], [0.65, 1.45, 0.04]],
  [[0.65, 1.39, -0.025], [0.69, 1.43, 0.025]],
  [[0.69, 1.37, -0.05], [0.82, 1.45, 0.05]],
  [[-0.42, 1.36, -0.05], [-0.14, 1.46, 0.05]],
  [[-0.65, 1.37, -0.04], [-0.42, 1.45, 0.04]],
  [[-0.69, 1.39, -0.025], [-0.65, 1.43, 0.025]],
  [[-0.82, 1.37, -0.05], [-0.69, 1.45, 0.05]],
  // Legs and feet, reaching forward.
  [[0.03, 0.1, -0.07], [0.15, 0.88, 0.07]],
  [[0.03, 0, -0.08], [0.15, 0.1, 0.2]],
  [[-0.15, 0.1, -0.07], [-0.03, 0.88, 0.07]],
  [[-0.15, 0, -0.08], [-0.03, 0.1, 0.2]],
];

const figure = (): Float32Array => Float32Array.from(FIGURE.flatMap(([min, max]) => box(min, max)));

/** What a test that rigs a whole body may take on a slow machine, in milliseconds. */
const RIGGING_TIME = 60000;

const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('turning a mesh into a solid body', () => {
  it('fills the inside, not just the skin', () => {
    const grid = voxelize(Float32Array.from(box([0, 0, 0], [1, 1, 1], 0.2)), 32)!;
    const middle = Math.floor(grid.nx / 2) + Math.floor(grid.ny / 2) * grid.nx + Math.floor(grid.nz / 2) * grid.nx * grid.ny;
    expect(grid.solid[middle]).toBe(1);
    expect(grid.surface[middle]).toBe(0);
  });

  it('closes a small hole in the skin', () => {
    // A box with one face's corner missing still has an inside.
    const whole = box([0, 0, 0], [1, 1, 1], 0.1);
    const holed = Float32Array.from(whole.slice(18));
    const grid = voxelize(holed, 32)!;
    const middle = Math.floor(grid.nx / 2) + Math.floor(grid.ny / 2) * grid.nx + Math.floor(grid.nz / 2) * grid.nx * grid.ny;
    expect(grid.solid[middle]).toBe(1);
  });
});

describe('reading a body from its mesh', () => {
  it('finds the joints of a figure standing with its arms out', () => {
    const reading = readBody(figure())!;
    expect(reading).not.toBeNull();
    expect(reading.facing).toEqual([0, 1]);
    const { markers, extents } = reading;
    expect(extents.headTop[1]).toBeCloseTo(1.8, 1);
    expect(extents.floor).toBeCloseTo(0, 1);
    // Left is at +X, on both sides of the body.
    expect(markers.leftWrist[0]).toBeGreaterThan(0.5);
    expect(markers.rightWrist[0]).toBeLessThan(-0.5);
    // The shoulders meet the chest, the wrists sit in their narrow place, and the arms are level.
    expect(Math.abs(markers.leftShoulder[0])).toBeLessThan(0.24);
    expect(markers.leftWrist[0]).toBeGreaterThan(0.6);
    expect(markers.leftWrist[0]).toBeLessThan(0.72);
    expect(markers.leftElbow[1]).toBeCloseTo(1.41, 1);
    // The chin in the neck, the crotch where the legs meet, a knee halfway up the leg.
    expect(markers.chin[1]).toBeGreaterThan(1.48);
    expect(markers.chin[1]).toBeLessThan(1.62);
    expect(markers.groin[1]).toBeGreaterThan(0.8);
    expect(markers.groin[1]).toBeLessThan(0.95);
    expect(markers.leftKnee[1]).toBeGreaterThan(0.45);
    expect(markers.leftKnee[1]).toBeLessThan(0.6);
    expect(markers.leftAnkle[1]).toBeLessThan(0.2);
    // Toes are ahead of the ankle.
    expect(extents.leftToe[2]).toBeGreaterThan(markers.leftAnkle[2] + 0.05);
  });

  it('reads a figure facing another way, and answers in the mesh\'s space', () => {
    // Turned a quarter, it faces +X.
    const sin = -1;
    const cos = 0;
    const turned = turnSoupAboutY(figure(), sin, cos);
    const reading = readBody(turned)!;
    expect(reading).not.toBeNull();
    const straight = readBody(figure())!;
    expect(Math.abs(reading.facing[0])).toBeCloseTo(1);
    expect(reading.facing[1]).toBeCloseTo(0);
    const expected = turnAboutY(straight.markers.leftWrist, sin, cos);
    expect(distance(reading.markers.leftWrist, expected)).toBeLessThan(0.1);
  });

  it('says nothing of a mesh that is no person', () => {
    expect(readBody(Float32Array.from(box([-1, 0, -0.02], [1, 1.5, 0.02])))).toBeNull();
  });

  it('gives something to start from for a mesh that is no person', () => {
    const reading = standardReading(Float32Array.from(box([-1, 0, -0.02], [1, 1.5, 0.02])))!;
    expect(reading.extents.headTop[1]).toBeCloseTo(1.5);
    expect(reading.markers.leftKnee[1]).toBeLessThan(reading.markers.groin[1]);
    expect(reading.markers.leftElbow[0]).toBeGreaterThan(reading.markers.leftShoulder[0]);
  });
});

/** A figure 1.6 tall, hunched forward with its long arms hanging to the floor and its legs grown together up to the shins. */
const HUNCHED: [Point, Point][] = [
  // Head well forward of the hips, a back stepping forward as it rises, and hips.
  [[-0.1, 1.42, 0.3], [0.1, 1.6, 0.5]],
  [[-0.2, 1.2, 0.1], [0.2, 1.44, 0.34]],
  [[-0.2, 1.0, 0.0], [0.2, 1.2, 0.22]],
  [[-0.19, 0.8, -0.1], [0.19, 1.0, 0.14]],
  // Arms out past the body, running down to hands on the floor. They start inside the shoulders.
  [[0.18, 1.2, 0.14], [0.3, 1.36, 0.28]],
  [[0.26, 0.85, 0.16], [0.36, 1.22, 0.26]],
  [[0.3, 0.45, 0.17], [0.4, 0.87, 0.25]],
  [[0.33, 0.12, 0.18], [0.39, 0.47, 0.24]],
  [[0.3, 0, 0.14], [0.44, 0.14, 0.34]],
  [[-0.3, 1.2, 0.14], [-0.18, 1.36, 0.28]],
  [[-0.36, 0.85, 0.16], [-0.26, 1.22, 0.26]],
  [[-0.4, 0.45, 0.17], [-0.3, 0.87, 0.25]],
  [[-0.39, 0.12, 0.18], [-0.33, 0.47, 0.24]],
  [[-0.44, 0, 0.14], [-0.3, 0.14, 0.34]],
  // Legs and feet.
  [[0.03, 0.1, -0.07], [0.16, 0.82, 0.07]],
  [[0.03, 0, -0.1], [0.17, 0.1, 0.2]],
  [[-0.16, 0.1, -0.07], [-0.03, 0.82, 0.07]],
  [[-0.17, 0, -0.1], [-0.03, 0.1, 0.2]],
];

/** The T-pose figure with spikes all over: on its shoulders, its back and its chest, and a blade running on from one hand. */
const SPIKED: [Point, Point][] = [
  ...FIGURE,
  [[0.2, 1.46, -0.02], [0.24, 1.72, 0.02]],
  [[-0.24, 1.46, -0.02], [-0.2, 1.72, 0.02]],
  [[-0.02, 1.3, -0.3], [0.02, 1.34, -0.1]],
  [[-0.02, 1.2, 0.1], [0.02, 1.24, 0.3]],
  [[0.82, 1.4, -0.015], [1.3, 1.42, 0.015]],
];

const figureOf = (boxes: readonly [Point, Point][]): Float32Array => Float32Array.from(boxes.flatMap(([min, max]) => box(min, max)));

describe('reading a figure that is not standing straight', () => {
  it('reads a hunched figure with its hands on the floor', () => {
    const reading = readBody(figureOf(HUNCHED))!;
    expect(reading).not.toBeNull();
    expect(reading.facing).toEqual([0, 1]);
    const { markers, extents } = reading;
    // The hands on the floor are not taken for feet: the legs are the ones under the hips.
    expect(Math.abs(markers.leftAnkle[0])).toBeLessThan(0.2);
    expect(markers.leftAnkle[1]).toBeLessThan(0.2);
    expect(markers.leftWrist[0]).toBeGreaterThan(0.25);
    expect(markers.leftWrist[1]).toBeLessThan(0.75);
    expect(extents.leftHandTip[1]).toBeLessThan(0.2);
    // The shoulders are up at the top of the arms, and well forward of the feet with the rest of the chest.
    expect(markers.leftShoulder[1]).toBeGreaterThan(0.95);
    expect(markers.leftShoulder[2]).toBeGreaterThan(0.1);
    expect(markers.chin[2]).toBeGreaterThan(0.2);
    expect(markers.groin[1]).toBeLessThan(1);
  });

  it('runs the spine along the curve of the back', () => {
    const reading = readBody(figureOf(HUNCHED))!;
    const joints = bodySkeleton(reading.markers, reading.extents);
    const at = (name: string) => joints.find((joint) => joint.name === name)!.position;
    // Each joint up the back is further forward than the last.
    expect(at('Spine1')[2]).toBeGreaterThan(at('Hips')[2]);
    expect(at('Neck')[2]).toBeGreaterThan(at('Spine1')[2]);
    joints.forEach((joint, index) => expect(joint.parent).toBeLessThan(index));
  });

  it('is not put off by spikes, and a blade held in a hand does not stretch the arm', () => {
    const reading = readBody(figureOf(SPIKED))!;
    expect(reading).not.toBeNull();
    const plain = readBody(figure())!;
    // The head and the arms are found where they are without the spikes.
    expect(distance(reading.extents.headTop, plain.extents.headTop)).toBeLessThan(0.05);
    expect(distance(reading.markers.leftWrist, plain.markers.leftWrist)).toBeLessThan(0.08);
    expect(distance(reading.markers.leftShoulder, plain.markers.leftShoulder)).toBeLessThan(0.08);
    expect(reading.extents.leftHandTip[0]).toBeLessThan(0.95);
  });

  it('reads legs grown together right down to the feet', () => {
    const grown = FIGURE.map(([min, max]): [Point, Point] => (min[1] < 0.5 && Math.abs(min[0]) < 0.2 ? [[min[0] < 0 ? min[0] : 0, min[1], min[2]], [max[0] > 0 ? max[0] : 0, max[1], max[2]]] : [min, max]));
    const reading = readBody(figureOf(grown))!;
    expect(reading).not.toBeNull();
    expect(reading.markers.leftKnee[0]).toBeGreaterThan(0.03);
    expect(reading.markers.rightKnee[0]).toBeLessThan(-0.03);
  });
});

/** An animal 1 tall and 1.7 long, its head towards +Z and its left at +X. */
const ANIMAL: [Point, Point][] = [
  // Trunk, neck rising to a head with a muzzle, and a thin tail going back and down.
  [[-0.14, 0.5, -0.45], [0.14, 0.85, 0.35]],
  [[-0.08, 0.72, 0.3], [0.08, 0.95, 0.5]],
  [[-0.09, 0.85, 0.45], [0.09, 1, 0.66]],
  [[-0.05, 0.85, 0.66], [0.05, 0.93, 0.85]],
  [[-0.025, 0.65, -0.6], [0.025, 0.75, -0.42]],
  [[-0.02, 0.45, -0.78], [0.02, 0.67, -0.58]],
  // Front legs, straight, with paws reaching forward.
  [[0.06, 0.1, 0.17], [0.14, 0.55, 0.27]],
  [[0.06, 0, 0.17], [0.14, 0.1, 0.34]],
  [[-0.14, 0.1, 0.17], [-0.06, 0.55, 0.27]],
  [[-0.14, 0, 0.17], [-0.06, 0.1, 0.34]],
  // Hind legs: a thigh coming forward, a shin going back to the hock, and on down to a paw.
  [[0.06, 0.4, -0.32], [0.14, 0.58, -0.2]],
  [[0.06, 0.25, -0.42], [0.14, 0.42, -0.26]],
  [[0.06, 0.1, -0.42], [0.14, 0.27, -0.32]],
  [[0.06, 0, -0.42], [0.14, 0.1, -0.25]],
  [[-0.14, 0.4, -0.32], [-0.06, 0.58, -0.2]],
  [[-0.14, 0.25, -0.42], [-0.06, 0.42, -0.26]],
  [[-0.14, 0.1, -0.42], [-0.06, 0.27, -0.32]],
  [[-0.14, 0, -0.42], [-0.06, 0.1, -0.25]],
];

describe('reading an animal on four legs', () => {
  const soup = figureOf(ANIMAL);
  const reading = readFourLegs(soup)!;

  it('finds the joints of a body running along the ground', () => {
    expect(reading).not.toBeNull();
    expect(reading.kind).toBe('fourLegs');
    expect(reading.facing).toEqual([0, 1]);
    const { markers, extents } = reading;
    expect(markers.nose[2]).toBeGreaterThan(0.78);
    expect(markers.head[2]).toBeGreaterThan(0.35);
    expect(markers.head[2]).toBeLessThan(markers.nose[2]);
    expect(markers.hips[2]).toBeLessThan(0);
    // Left is at +X. Legs run down from the trunk to the floor, each in its own place.
    expect(markers.leftFrontPaw[0]).toBeGreaterThan(0.05);
    expect(markers.rightFrontPaw[0]).toBeLessThan(-0.05);
    expect(markers.leftFrontPaw[2]).toBeGreaterThan(0.1);
    expect(markers.leftHindPaw[2]).toBeLessThan(-0.2);
    expect(markers.leftElbow[1]).toBeGreaterThan(markers.leftWrist[1]);
    expect(markers.leftWrist[1]).toBeGreaterThan(markers.leftFrontPaw[1]);
    expect(markers.leftShoulder[1]).toBeGreaterThan(markers.leftElbow[1]);
    expect(markers.leftHip[1]).toBeGreaterThan(markers.leftKnee[1]);
    expect(markers.leftKnee[1]).toBeGreaterThan(markers.leftHock[1]);
    // The hock is behind the line from the knee to the paw.
    expect(markers.leftHock[2]).toBeLessThan(Math.max(markers.leftKnee[2], markers.leftHindPaw[2]));
    expect(extents.floor).toBeCloseTo(0, 1);
    // The tail is found.
    expect(markers.tailTip![2]).toBeLessThan(-0.6);
    expect(markers.tailBase![2]).toBeGreaterThan(markers.tailTip![2]);
  });

  it('reads the same body turned to face any way, head and tail the right way round', () => {
    const backwards = readFourLegs(turnSoupAboutY(soup, 0, -1))!;
    expect(backwards.facing).toEqual([0, -1]);
    expect(backwards.markers.nose[2]).toBeLessThan(-0.78);
    // Its left is still its own left, now at -X.
    expect(backwards.markers.leftFrontPaw[0]).toBeLessThan(-0.05);
    const sin = Math.sin(0.6);
    const cos = Math.cos(0.6);
    const turned = readFourLegs(turnSoupAboutY(soup, sin, cos))!;
    expect(turned.markers.tailTip).toBeDefined();
    const expected = turnAboutY(reading.markers.nose, sin, cos);
    expect(distance(turned.markers.nose, expected)).toBeLessThan(0.08);
  });

  it('can be told which way it faces', () => {
    const told = readFourLegs(soup, [0, -1]);
    if (told) expect(told.facing).toEqual([0, -1]);
  });

  it('says nothing of a mesh that is no animal', () => {
    expect(readFourLegs(Float32Array.from(box([-1, 0, -0.02], [1, 1.5, 0.02])))).toBeNull();
  });

  it('gives something to start from for a mesh that is no animal, along its length', () => {
    const start = standardFourLegReading(Float32Array.from(box([-0.2, 0, -1], [0.2, 1, 1], 0.2)))!;
    expect(start.kind).toBe('fourLegs');
    expect(start.facing).toEqual([0, 1]);
    expect(start.markers.nose[2]).toBeGreaterThan(start.markers.hips[2]);
    expect(start.markers.leftElbow[1]).toBeGreaterThan(start.markers.leftWrist[1]);
    expect(start.markers.leftElbow[0]).toBeGreaterThan(start.markers.rightElbow[0]);
  });

  it('tells which kind of body a mesh looks like', () => {
    expect(looksFourLegged(soup)).toBe(true);
    expect(looksFourLegged(figure())).toBe(false);
    expect(looksFourLegged(figureOf(HUNCHED))).toBe(false);
    expect(readAnyBody(soup).reading?.kind).toBe('fourLegs');
    expect(readAnyBody(figure()).reading?.kind).toBe('person');
    // Asked to read it as the other kind, it starts from that kind's proportions, and says so.
    const asPerson = readAs(soup, 'person');
    expect(asPerson.reading?.kind).toBe('person');
    expect(asPerson.guessed).toBe(true);
  });
});

describe('the skeleton fitted to an animal', () => {
  const soup = figureOf(ANIMAL);
  const reading = readFourLegs(soup)!;
  const joints = fourLegSkeleton(reading.markers, reading.extents);
  const names = joints.map((joint) => joint.name);

  it('names its bones so clips find their way to it: hind legs as legs, front legs as arms', () => {
    const roles = new Set(joints.map((joint) => humanoidRole(joint.name)));
    for (const role of ['Hips', 'Spine', 'Neck', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'LeftMiddle1', 'RightUpperArm', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightFoot']) {
      expect([role, roles.has(role)]).toEqual([role, true]);
    }
    expect(humanoidRole('Tail1')).toBeNull();
    expect(names).toEqual(expect.arrayContaining(['Tail', 'Tail1', 'Tail2', 'Tail3', 'Tail_End', 'Neck1']));
  });

  it('reads rigs that say which end of the body a leg is at', () => {
    expect(humanoidRole('front_thigh.L')).toBe('LeftUpperArm');
    expect(humanoidRole('front_shin.R')).toBe('RightLowerArm');
    expect(humanoidRole('front_foot.L')).toBe('LeftHand');
    expect(humanoidRole('front_toe.L')).toBe('LeftMiddle1');
    expect(humanoidRole('thigh.L')).toBe('LeftUpperLeg');
    expect(humanoidRole('RearLeftThigh')).toBe('LeftUpperLeg');
    expect(humanoidRole('HindLeg_R')).toBe('RightUpperLeg');
    expect(humanoidRole('back_foot_L')).toBe('LeftFoot');
    expect(humanoidRole('ForeLeg.R')).toBe('RightUpperArm');
    // A person's bones stay a person's.
    expect(humanoidRole('mixamorig:LeftForeArm')).toBe('LeftLowerArm');
    expect(humanoidRole('LeftFoot')).toBe('LeftFoot');
    expect(humanoidRole('Back')).toBe('Spine');
  });

  it('lists parents before children, with one root, and can leave the tail out', () => {
    joints.forEach((joint, index) => expect(joint.parent).toBeLessThan(index));
    expect(joints.filter((joint) => joint.parent < 0).map((joint) => joint.name)).toEqual(['Hips']);
    const tailless = fourLegSkeleton(reading.markers, reading.extents, false);
    expect(tailless.some((joint) => joint.name.startsWith('Tail'))).toBe(false);
  });

  it('runs each bone along itself, with a leg leaning forward as a person\'s does', () => {
    const axis = (name: string, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(new THREE.Quaternion(...joints.find((joint) => joint.name === name)!.rotation));
    joints.forEach((joint, index) => {
      const child = joints.find((other) => other.parent === index);
      if (!child) return;
      const along = new THREE.Vector3(...child.position).sub(new THREE.Vector3(...joint.position)).normalize();
      expect(axis(joint.name, 0, 1, 0).dot(along)).toBeCloseTo(1, 4);
    });
    expect(axis('LeftForeArm', 0, 0, 1).z).toBeGreaterThan(0.8);
    expect(axis('RightLeg', 0, 0, 1).z).toBeGreaterThan(0.5);
    joints.forEach((joint) => expect(new THREE.Quaternion(...joint.rotation).length()).toBeCloseTo(1, 4));
  });

  it('gives each part of the body to its own bones, from the same binding as a person', () => {
    const part = { positions: soup, indices: null };
    const { joints: rigged, weights: [weights] } = rigBody(soup, [part], reading, []);
    const influencesAt = (x: number, y: number, z: number): string[] => {
      let best = 0;
      let bestDistance = Infinity;
      for (let vertex = 0; vertex < soup.length / 3; vertex += 1) {
        const gap = (soup[vertex * 3] - x) ** 2 + (soup[vertex * 3 + 1] - y) ** 2 + (soup[vertex * 3 + 2] - z) ** 2;
        if (gap < bestDistance) {
          bestDistance = gap;
          best = vertex;
        }
      }
      const list: [string, number][] = [];
      for (let slot = 0; slot < 4; slot += 1) if (weights.weights[best * 4 + slot] > 0) list.push([rigged[weights.joints[best * 4 + slot]].name, weights.weights[best * 4 + slot]]);
      return list.sort((a, b) => b[1] - a[1]).map(([name]) => name);
    };
    expect(influencesAt(0.1, 0.3, 0.27)[0]).toMatch(/Left(ForeArm|Hand)/);
    expect(influencesAt(-0.1, 0.3, 0.27)[0]).toMatch(/Right(ForeArm|Hand)/);
    expect(influencesAt(0.1, 0.3, -0.42)[0]).toMatch(/Left(Leg|Foot)/);
    expect(influencesAt(0, 0.5, -0.72)[0]).toMatch(/Tail/);
    expect(influencesAt(0, 0.9, 0.75)[0]).toBe('Head');
    expect(influencesAt(0.1, 0.3, 0.27).some((name) => name.startsWith('Right'))).toBe(false);
  }, RIGGING_TIME);

  it('keeps a leg marker moved side on in the middle of the leg, and a paw\'s toes with it', () => {
    const moved: Point = [0.13, reading.markers.leftWrist[1] + 0.03, reading.markers.leftWrist[2]];
    const part = { positions: soup, indices: null };
    const { joints: rigged } = rigBody(soup, [part], { ...reading, markers: { ...reading.markers, leftWrist: moved } }, ['leftWrist', 'groin'], undefined, reading.markers);
    const hand = rigged.find((joint) => joint.name === 'LeftHand')!;
    expect(hand.position[1]).toBeCloseTo(moved[1], 5);
    expect(hand.position[0]).toBeCloseTo(0.1, 1);
  }, RIGGING_TIME);

  it('turns the skeleton back to the mesh\'s own space, and writes a file that rests where the mesh was', async () => {
    const sin = Math.sin(0.6);
    const cos = Math.cos(0.6);
    const turned = turnSoupAboutY(soup, sin, cos);
    const turnedReading = readFourLegs(turned)!;
    const { joints: rigged, weights } = rigBody(turned, [{ positions: turned, indices: null }], turnedReading, []);
    expect(distance(rigged.find((joint) => joint.name === 'Hips')!.position, turnedReading.markers.hips)).toBeLessThan(1e-4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(turned, 3));
    const primitive: RigPrimitive = { node: 0, mesh: 0, primitive: 0, geometry, matrix: new THREE.Matrix4(), positions: turned, indices: null };
    const json: GltfJson = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Body', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
    const glb = buildRiggedGlb({ json, viewBytes: () => new Uint8Array(0), metresPerUnit: 1 }, [primitive], rigged, weights);
    const loaded = await new GLTFLoader().parseAsync(glb, '');
    let mesh: THREE.SkinnedMesh | null = null;
    loaded.scene.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh;
    });
    const skinned = mesh as unknown as THREE.SkinnedMesh;
    loaded.scene.updateMatrixWorld(true);
    skinned.skeleton.update();
    const point = new THREE.Vector3();
    const count = turned.length / 3;
    for (let vertex = 0; vertex < count; vertex += Math.ceil(count / 300)) {
      point.fromBufferAttribute(skinned.geometry.getAttribute('position'), vertex);
      skinned.applyBoneTransform(vertex, point);
      point.applyMatrix4(skinned.matrixWorld);
      expect(point.x).toBeCloseTo(turned[vertex * 3], 3);
      expect(point.y).toBeCloseTo(turned[vertex * 3 + 1], 3);
      expect(point.z).toBeCloseTo(turned[vertex * 3 + 2], 3);
    }
  }, RIGGING_TIME);
});

describe('the skeleton fitted to a body', () => {
  const reading = readBody(figure())!;
  const joints = bodySkeleton(reading.markers, reading.extents);

  it('names its bones so they read as a person\'s', () => {
    const roles = new Set(joints.map((joint) => humanoidRole(joint.name)));
    for (const role of ['Hips', 'Spine', 'Neck', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightFoot', 'LeftToes']) {
      expect([role, roles.has(role)]).toEqual([role, true]);
    }
  });

  it('lists parents before children, with one root', () => {
    joints.forEach((joint, index) => expect(joint.parent).toBeLessThan(index));
    expect(joints.filter((joint) => joint.parent < 0).map((joint) => joint.name)).toEqual(['Hips']);
  });

  it('runs each bone\'s Y along it, and turns arms and legs the way rigs do', () => {
    const at = (name: string) => joints.find((joint) => joint.name === name)!;
    const axis = (name: string, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(new THREE.Quaternion(...at(name).rotation));
    joints.forEach((joint, index) => {
      const child = joints.find((other) => other.parent === index);
      if (!child) return;
      const along = new THREE.Vector3(...child.position).sub(new THREE.Vector3(...joint.position)).normalize();
      expect(axis(joint.name, 0, 1, 0).dot(along)).toBeCloseTo(1, 4);
    });
    // Z: down on an arm, forward on a leg, up on a toe.
    expect(axis('LeftArm', 0, 0, 1).y).toBeLessThan(-0.9);
    expect(axis('RightForeArm', 0, 0, 1).y).toBeLessThan(-0.9);
    expect(axis('LeftUpLeg', 0, 0, 1).z).toBeGreaterThan(0.9);
    expect(axis('LeftToeBase', 0, 0, 1).y).toBeGreaterThan(0.9);
    // A turn with a mirror in it would not be a turn.
    joints.forEach((joint) => expect(new THREE.Quaternion(...joint.rotation).length()).toBeCloseTo(1, 4));
  });
});

/** A part of a mesh with a vertex at every corner. */
const partOf = (soup: Float32Array) => ({ positions: soup, indices: null });

describe('skin weights', () => {
  const reading = readBody(figure())!;
  const joints = bodySkeleton(reading.markers, reading.extents);
  const soup = figure();
  const [weights] = bindSkin(soup, joints, [partOf(soup)]);
  const nameOf = (index: number) => joints[index].name;

  /** The bones moving the vertex nearest a place, strongest first. */
  const influencesAt = (x: number, y: number, z: number): [string, number][] => {
    let best = 0;
    let bestDistance = Infinity;
    for (let vertex = 0; vertex < soup.length / 3; vertex += 1) {
      const gap = (soup[vertex * 3] - x) ** 2 + (soup[vertex * 3 + 1] - y) ** 2 + (soup[vertex * 3 + 2] - z) ** 2;
      if (gap < bestDistance) {
        bestDistance = gap;
        best = vertex;
      }
    }
    const out: [string, number][] = [];
    for (let slot = 0; slot < 4; slot += 1) {
      if (weights.weights[best * 4 + slot] > 0) out.push([nameOf(weights.joints[best * 4 + slot]), weights.weights[best * 4 + slot]]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  };

  it('adds up to one on every vertex, on real bones', () => {
    for (let vertex = 0; vertex < soup.length / 3; vertex += 1) {
      let total = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        total += weights.weights[vertex * 4 + slot];
        if (weights.weights[vertex * 4 + slot] > 0) expect(joints[weights.joints[vertex * 4 + slot]].skins).toBe(true);
      }
      expect(total).toBeCloseTo(1, 4);
    }
  });

  it('gives each limb to its own bones', () => {
    expect(influencesAt(0.76, 1.45, 0.05)[0][0]).toBe('LeftHand');
    expect(influencesAt(-0.76, 1.45, 0.05)[0][0]).toBe('RightHand');
    expect(influencesAt(0.09, 0.3, 0.07)[0][0]).toBe('LeftLeg');
    expect(influencesAt(0.09, 0.02, 0.2).map(([name]) => name)).toContain('LeftToeBase');
    expect(influencesAt(0, 1.75, 0.1)[0][0]).toBe('Head');
  });

  it('keeps one side from moving the other', () => {
    const left = influencesAt(0.09, 0.5, 0.07).map(([name]) => name);
    expect(left.some((name) => name.startsWith('Right'))).toBe(false);
  });

  it('does not lift the chest with the arm beside it', () => {
    // Skin on the chest's side, below the arm: the arm's bones should barely move it.
    const influences = influencesAt(0.17, 1.2, 0.11);
    const arm = influences.filter(([name]) => /LeftArm|LeftForeArm/.test(name)).reduce((sum, [, share]) => sum + share, 0);
    expect(arm).toBeLessThan(0.15);
  });

  it('binds a loose piece to the bones nearest it', () => {
    // A belt floating clear of the body.
    const belt = Float32Array.from(box([-0.2, 0.95, 0.14], [0.2, 1, 0.16], 0.05));
    const whole = new Float32Array(soup.length + belt.length);
    whole.set(soup);
    whole.set(belt, soup.length);
    const [, beltWeights] = bindSkin(whole, joints, [partOf(soup), partOf(belt)]);
    const moved = new Set<string>();
    for (let vertex = 0; vertex < belt.length / 3; vertex += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        if (beltWeights.weights[vertex * 4 + slot] > 0.3) moved.add(nameOf(beltWeights.joints[vertex * 4 + slot]));
      }
    }
    expect([...moved].some((name) => /Hips|Spine/.test(name))).toBe(true);
  }, RIGGING_TIME);
});

describe('fingers', () => {
  /** An arm held out with a palm, as long as the hand takes it, in `pieces`. */
  const handWith = (pieces: [Point, Point][]): Float32Array => Float32Array.from([
    ...box([0, -0.03, -0.03], [0.1, 0.03, 0.03], 0.01),
    ...pieces.flatMap(([min, max]) => box(min, max, 0.005)),
  ]);
  const WRIST: Point = [0.1, 0, 0];
  const TIP: Point = [0.28, 0, 0];

  it('shares a mitten out across its width, index towards the front', () => {
    const fingers = readFingers(handWith([[[0.1, -0.015, -0.05], [0.28, 0.015, 0.05]]]), WRIST, TIP)!;
    expect(fingers.map((finger) => finger.name)).toEqual(['Index', 'Middle', 'Ring', 'Pinky']);
    const across = fingers.map((finger) => finger.joints[0][2]);
    expect([...across].sort((a, b) => b - a)).toEqual(across);
    expect(across[0]).toBeGreaterThan(0.02);
    expect(across[3]).toBeLessThan(-0.02);
    for (const finger of fingers) {
      // From about halfway along the hand to its end, in the middle of its thickness.
      expect(finger.joints[0][0]).toBeGreaterThan(0.18);
      expect(finger.joints[0][0]).toBeLessThan(0.23);
      expect(finger.joints[3][0]).toBeGreaterThan(0.26);
      expect(Math.abs(finger.joints[1][1])).toBeLessThan(0.005);
    }
  });

  it('finds a thumb standing out from the hand', () => {
    const thumb: [Point, Point] = [[0.12, -0.012, 0.05], [0.17, 0.012, 0.09]];
    const fingers = readFingers(handWith([[[0.1, -0.015, -0.05], [0.28, 0.015, 0.05]], thumb]), WRIST, TIP)!;
    expect(fingers[0].name).toBe('Thumb');
    expect(fingers[0].joints[3][2]).toBeGreaterThan(0.08);
    expect(fingers).toHaveLength(5);
  });

  it('follows fingers that stand apart, each to its own length', () => {
    const fingers = readFingers(handWith([
      [[0.1, -0.015, -0.05], [0.19, 0.015, 0.05]],
      [[0.19, -0.01, 0.033], [0.27, 0.01, 0.05]],
      [[0.19, -0.01, 0.008], [0.28, 0.01, 0.025]],
      [[0.19, -0.01, -0.025], [0.27, 0.01, -0.008]],
      [[0.19, -0.01, -0.05], [0.24, 0.01, -0.033]],
    ]), WRIST, TIP)!;
    expect(fingers.map((finger) => finger.name)).toEqual(['Index', 'Middle', 'Ring', 'Pinky']);
    expect(fingers[0].joints[3][2]).toBeCloseTo(0.04, 1);
    expect(fingers[3].joints[3][0]).toBeLessThan(0.25);
    expect(fingers[1].joints[3][0]).toBeGreaterThan(0.26);
  });

  it('leaves a stump with nothing to read as one bone', () => {
    expect(readFingers(handWith([]), [0.5, 0, 0], [0.6, 0, 0])).toBeNull();
  });

  describe('on a rigged body', () => {
    const soup = figure();
    const reading = readBody(soup)!;
    const { joints, weights } = rigBody(soup, [partOf(soup)], reading, []);
    const [part] = weights;
    const influenced = (x: number, y: number, z: number): string[] => {
      let best = 0;
      let bestDistance = Infinity;
      for (let vertex = 0; vertex < soup.length / 3; vertex += 1) {
        const gap = (soup[vertex * 3] - x) ** 2 + (soup[vertex * 3 + 1] - y) ** 2 + (soup[vertex * 3 + 2] - z) ** 2;
        if (gap < bestDistance) {
          bestDistance = gap;
          best = vertex;
        }
      }
      const names: string[] = [];
      for (let slot = 0; slot < 4; slot += 1) if (part.weights[best * 4 + slot] > 0) names.push(joints[part.joints[best * 4 + slot]].name);
      return names;
    };

    it('names them so they read as fingers, and ends each on a joint that moves nothing', () => {
      expect(humanoidRole('LeftHandIndex1')).toBe('LeftIndex1');
      for (const name of ['LeftHandIndex1', 'LeftHandPinky3', 'RightHandMiddle2']) {
        const joint = joints.find((candidate) => candidate.name === name)!;
        expect(joint.skins).toBe(true);
        expect(joint.handOf).toBeDefined();
      }
      expect(joints.find((joint) => joint.name === 'LeftHandIndex4')!.skins).toBe(false);
    });

    it('gives the end of the hand to the fingers, and nothing behind the wrist', () => {
      expect(influenced(0.82, 1.41, 0.04).some((name) => /LeftHand(Index|Middle)/.test(name))).toBe(true);
      expect(influenced(0.82, 1.41, -0.04).some((name) => /LeftHand(Ring|Pinky)/.test(name))).toBe(true);
      expect(influenced(0.6, 1.45, 0.04).some((name) => /LeftHand[A-Z]/.test(name))).toBe(false);
      expect(influenced(0.82, 1.41, 0.04).some((name) => name.startsWith('Right'))).toBe(false);
    });

    it('can leave them out', () => {
      const { joints: plain } = rigBody(soup, [partOf(soup)], reading, [], undefined, undefined, false);
      expect(plain.some((joint) => joint.handOf !== undefined)).toBe(false);
    }, RIGGING_TIME);
  });
});

describe('placing the markers by hand', () => {
  it('keeps a moved marker in the middle of the limb, at its new place', () => {
    const soup = figure();
    const reading = readBody(soup)!;
    const moved: Point = [reading.markers.leftElbow[0] + 0.03, reading.markers.leftElbow[1], 0.04];
    const { joints } = rigBody(soup, [partOf(soup)], { ...reading, markers: { ...reading.markers, leftElbow: moved } }, ['leftElbow', 'leftFrontPaw'], undefined, reading.markers, false);
    const elbow = joints.find((joint) => joint.name === 'LeftForeArm')!;
    expect(elbow.position[0]).toBeCloseTo(moved[0], 5);
    // Dropped towards the front of the arm, it goes back to the middle.
    expect(Math.abs(elbow.position[2])).toBeLessThan(0.02);
  }, RIGGING_TIME);

  it('has toes follow a moved ankle and the hand tip turn with a moved forearm', () => {
    const soup = figure();
    const reading = readBody(soup)!;
    const { markers } = reading;
    const ankle: Point = [markers.leftAnkle[0] + 0.05, markers.leftAnkle[1], markers.leftAnkle[2]];
    // The wrist drops straight below the elbow, so the hand should now hang down.
    const wrist: Point = [markers.leftElbow[0], markers.leftElbow[1] - 0.25, markers.leftWrist[2]];
    const { joints } = rigBody(soup, [partOf(soup)], { ...reading, markers: { ...markers, leftAnkle: ankle, leftWrist: wrist } }, ['leftAnkle', 'leftWrist'], undefined, markers, false);
    const place = (name: string) => joints.find((joint) => joint.name === name)!.position;
    expect(place('LeftToe_End')[0] - place('LeftFoot')[0]).toBeCloseTo(reading.extents.leftToe[0] - markers.leftAnkle[0], 2);
    const hand = new THREE.Vector3(...place('LeftHandTip_End')).sub(new THREE.Vector3(...place('LeftHand')));
    expect(hand.y).toBeLessThan(-0.05);
    expect(Math.abs(hand.x)).toBeLessThan(Math.abs(hand.y));
  }, RIGGING_TIME);

  it('turns the skeleton back to the mesh\'s own space', () => {
    const sin = -1;
    const cos = 0;
    const soup = turnSoupAboutY(figure(), sin, cos);
    const reading = readBody(soup)!;
    const { joints } = rigBody(soup, [partOf(soup)], reading, [], undefined, undefined, false);
    const hand = new THREE.Vector3(...joints.find((joint) => joint.name === 'LeftHand')!.position);
    const expected = new THREE.Vector3(...reading.markers.leftWrist);
    expect(hand.distanceTo(expected)).toBeLessThan(1e-4);
    // Y still runs along the arm.
    const elbow = joints.find((joint) => joint.name === 'LeftForeArm')!;
    const along = hand.clone().sub(new THREE.Vector3(...elbow.position)).normalize();
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...elbow.rotation)).dot(along)).toBeCloseTo(1, 4);
  }, RIGGING_TIME);
});

describe('writing the rigged file', () => {
  /** A source with one mesh on a node moved and scaled, an image, and an animation that will not survive. */
  const sourceOf = (positions: Float32Array) => {
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const json: GltfJson = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0], extras: { uvOriginTopLeft: true } }],
      nodes: [{ name: 'Body', mesh: 0, translation: [0, 0.5, 0], scale: [1, 1, 1] }],
      meshes: [{ name: 'BodyMesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ name: 'Skin' }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: imageBytes.byteLength }],
      animations: [{ channels: [], samplers: [] }],
      extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_materials_unlit'],
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    const matrix = new THREE.Matrix4().makeTranslation(0, 0.5, 0);
    const baked = positions.slice();
    for (let i = 1; i < baked.length; i += 3) baked[i] += 0.5;
    const primitive: RigPrimitive = { node: 0, mesh: 0, primitive: 0, geometry, matrix, positions: baked, indices: null };
    return { source: { json, viewBytes: () => imageBytes, metresPerUnit: 0.5 }, primitive, imageBytes };
  };

  const glbParts = (glb: ArrayBuffer): { json: GltfJson; binary: Uint8Array } => {
    const view = new DataView(glb);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as GltfJson;
    return { json, binary: new Uint8Array(glb, 28 + jsonLength, view.getUint32(20 + jsonLength, true)) };
  };

  const rigged = (() => {
    const body = figure();
    const { source, primitive, imageBytes } = sourceOf(body.map((value, index) => (index % 3 === 1 ? value - 0.5 : value)));
    const reading = readBody(primitive.positions)!;
    const { joints, weights } = rigBody(trianglesOf([primitive]), [primitive], reading, []);
    const shape = { name: 'UCX_Body', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]) };
    return { glb: buildRiggedGlb(source, [primitive], joints, weights, [shape]), joints, imageBytes, primitive, shape };
  })();

  it('keeps the rest of the document, and drops what no longer holds', () => {
    const { json, binary } = glbParts(rigged.glb);
    // The model's unit goes along, for its root to keep its scale.
    expect(json.scenes![0].extras).toEqual({ uvOriginTopLeft: true, sourceMetresPerUnit: 0.5 });
    expect(json.materials).toEqual([{ name: 'Skin' }]);
    expect(json.animations).toBeUndefined();
    expect(json.extensionsUsed).toEqual(['KHR_materials_unlit']);
    expect(json.nodes![0].mesh).toBeUndefined();
    // An empty keeps no name its mesh has taken with it: a loader would number the mesh's.
    expect(json.nodes![0].name).toBeUndefined();
    // The image comes through byte for byte.
    const view = json.bufferViews![json.images![0].bufferView!];
    expect([...binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)]).toEqual([...rigged.imageBytes]);
  });

  it('loads as a skinned mesh that rests exactly where the mesh was, in the model\'s own units', async () => {
    const loaded = await new GLTFLoader().parseAsync(rigged.glb, '');
    let mesh: THREE.SkinnedMesh | null = null;
    loaded.scene.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh;
    });
    expect(mesh).not.toBeNull();
    const skinned = mesh as unknown as THREE.SkinnedMesh;
    expect(skinned.skeleton.bones.map((bone) => bone.name)).toEqual(rigged.joints.map((joint) => joint.name));
    loaded.scene.updateMatrixWorld(true);
    skinned.skeleton.update();
    const point = new THREE.Vector3();
    const count = rigged.primitive.positions.length / 3;
    for (let vertex = 0; vertex < count; vertex += Math.ceil(count / 500)) {
      point.fromBufferAttribute(skinned.geometry.getAttribute('position'), vertex);
      skinned.applyBoneTransform(vertex, point);
      point.applyMatrix4(skinned.matrixWorld);
      expect(point.x).toBeCloseTo(rigged.primitive.positions[vertex * 3], 3);
      expect(point.y).toBeCloseTo(rigged.primitive.positions[vertex * 3 + 1], 3);
      expect(point.z).toBeCloseTo(rigged.primitive.positions[vertex * 3 + 2], 3);
    }
    expect(loaded.scene.userData.sourceMetresPerUnit).toBe(0.5);
  });

  it('carries the model\'s collision shapes along, under their own names and unskinned', async () => {
    const loaded = await new GLTFLoader().parseAsync(rigged.glb, '');
    const shape = loaded.scene.getObjectByName('UCX_Body') as THREE.Mesh;
    expect(shape.isMesh).toBe(true);
    expect((shape as THREE.Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh).toBeFalsy();
    expect(Array.from(shape.geometry.getAttribute('position').array)).toEqual(Array.from(rigged.shape.positions));
    const hulls = readModelConventions(loaded.scene);
    expect(hulls.hulls).toHaveLength(1);
    expect(hulls.shapes).toEqual([shape]);
  });
});
