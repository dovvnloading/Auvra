import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { MarkerName, Point } from '../../utils/autoRig/bodyMarkers';
import type { FourLegMarkerName } from '../../utils/autoRig/fourLegReading';
import type { RigMarkerName, RigReading } from '../../utils/autoRig/rigBody';
import { moveRigMarker, setActiveRigMarker, useRigSession } from '../../utils/autoRig/rigSession';

const MARKER_COLOR = '#ff9a3d';
const ACTIVE_COLOR = '#ffffff';
const LINE_COLOR = '#ff9a3d';

/** What a person's marker is called on screen. */
const PERSON_LABEL: Record<MarkerName, string> = {
  chin: 'Chin',
  groin: 'Groin',
  leftShoulder: 'Shoulder',
  rightShoulder: 'Shoulder',
  leftElbow: 'Elbow',
  rightElbow: 'Elbow',
  leftWrist: 'Wrist',
  rightWrist: 'Wrist',
  leftKnee: 'Knee',
  rightKnee: 'Knee',
  leftAnkle: 'Ankle',
  rightAnkle: 'Ankle',
};

/** What an animal's marker is called on screen. */
const FOUR_LEG_LABEL: Record<FourLegMarkerName, string> = {
  nose: 'Nose',
  head: 'Head',
  neck: 'Neck',
  hips: 'Hips',
  leftShoulder: 'Shoulder',
  rightShoulder: 'Shoulder',
  leftElbow: 'Elbow',
  rightElbow: 'Elbow',
  leftWrist: 'Wrist',
  rightWrist: 'Wrist',
  leftFrontPaw: 'Paw',
  rightFrontPaw: 'Paw',
  leftHip: 'Hip',
  rightHip: 'Hip',
  leftKnee: 'Knee',
  rightKnee: 'Knee',
  leftHock: 'Hock',
  rightHock: 'Hock',
  leftHindPaw: 'Paw',
  rightHindPaw: 'Paw',
  tailBase: 'Tail',
  tailTip: 'Tail tip',
};

/** Markers joined by lines, to show the skeleton they make. */
const PERSON_LINKS: readonly [MarkerName, MarkerName][] = [
  ['chin', 'groin'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'rightShoulder'],
  ['groin', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['groin', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];

const FOUR_LEG_LINKS: readonly [FourLegMarkerName, FourLegMarkerName][] = [
  ['nose', 'head'], ['head', 'neck'], ['neck', 'hips'], ['hips', 'tailBase'], ['tailBase', 'tailTip'],
  ['neck', 'leftShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['leftWrist', 'leftFrontPaw'],
  ['neck', 'rightShoulder'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['rightWrist', 'rightFrontPaw'],
  ['hips', 'leftHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftHock'], ['leftHock', 'leftHindPaw'],
  ['hips', 'rightHip'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightHock'], ['rightHock', 'rightHindPaw'],
];

const markerAt = (reading: RigReading, name: RigMarkerName): Point | undefined => (reading.markers as unknown as Record<string, Point | undefined>)[name];

/** A marker's size against the body. */
const MARKER_SIZE = 0.013;
/** The viewport fills with the body to this share of its height or width. */
const VIEW_FILL = 0.8;

const NOTHING = (): void => undefined;

/** Every place a reading has marked out, for framing the body. */
const placesOf = (reading: RigReading): Point[] => {
  const markers = Object.values(reading.markers) as Point[];
  if (reading.kind === 'fourLegs') {
    const { leftFrontToe, rightFrontToe, leftHindToe, rightHindToe } = reading.extents;
    return [...markers, leftFrontToe, rightFrontToe, leftHindToe, rightHindToe];
  }
  const { headTop, leftHandTip, rightHandTip, leftToe, rightToe } = reading.extents;
  return [...markers, headTop, leftHandTip, rightHandTip, leftToe, rightToe];
};

/** How big the body is: its height, or an animal's length if that is more. */
const sizeOf = (reading: RigReading): number => {
  if (reading.kind === 'person') return reading.extents.headTop[1] - reading.extents.floor;
  const { nose, hips } = reading.markers;
  const top = placesOf(reading).reduce((highest, place) => Math.max(highest, place[1]), -Infinity);
  return Math.max(top - reading.extents.floor, Math.hypot(nose[0] - hips[0], nose[2] - hips[2]));
};

/** How much of the canvas, from its top, is not hidden by panels over it, in pixels. */
const shownHeightOf = (canvas: HTMLCanvasElement): number => {
  const bounds = canvas.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  for (let y = bounds.top + bounds.height - 1; y > bounds.top + bounds.height / 4; y -= 8) {
    const element = document.elementFromPoint(x, y);
    if (element === canvas || (element && !element.closest('button, [class*="bg-"]') && element.contains(canvas))) return y - bounds.top;
  }
  return bounds.height;
};

/**
 * The markers of a model being given a skeleton: one to drag onto each joint. A person is seen from the
 * front and an animal from its side, with what is on the far side left out while both sides move
 * together. They are dragged in a plane square to that view, and drawn over the model so none is ever
 * lost in it.
 */
export const RigMarkers: React.FC<{ modelId: string; root: THREE.Object3D }> = ({ modelId, root }) => {
  const { stage, modelId: rigging, reading, activeMarker, bothSides } = useRigSession();
  const shown = stage === 'placing' && rigging === modelId && reading;
  const camera = useThree((three) => three.camera);
  const canvas = useThree((three) => three.gl.domElement);
  const controls = useThree((three) => three.controls) as unknown as { enabled: boolean; target: THREE.Vector3; update: () => void } | null;
  const invalidate = useThree((three) => three.invalidate);
  const group = useRef<THREE.Group>(null);

  // The markers sit beside the model, so they share its place.
  useFrame(() => {
    if (!group.current) return;
    group.current.position.copy(root.position);
    group.current.quaternion.copy(root.quaternion);
    group.current.scale.copy(root.scale);
  });

  const facing = reading?.facing;
  const sideOn = reading?.kind === 'fourLegs';
  // The way the body is looked at from: its front, or an animal's left side.
  const worldView = useMemo(() => {
    if (!facing) return new THREE.Vector3(0, 0, 1);
    root.updateWorldMatrix(true, false);
    const [fx, fz] = facing;
    return (sideOn ? new THREE.Vector3(fz, 0, -fx) : new THREE.Vector3(fx, 0, fz)).transformDirection(root.matrixWorld);
  }, [facing, sideOn, root]);

  // On starting, the camera goes in front of the body with all of it in view.
  const framedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || !reading) {
      framedFor.current = null;
      return;
    }
    if (framedFor.current === modelId) return;
    framedFor.current = modelId;
    root.updateWorldMatrix(true, false);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, worldView).normalize();
    const floor = root.localToWorld(new THREE.Vector3(...(reading.kind === 'fourLegs' ? reading.markers.hips : reading.markers.groin))).setY(0);
    floor.y = root.localToWorld(new THREE.Vector3(0, reading.extents.floor, 0)).y;
    // All of the mesh goes in view, ears and blades too, and every marker with it.
    const box = new THREE.Box3().setFromObject(root);
    const corners = [box.min, box.max].flatMap((a) => [box.min, box.max].flatMap((b) => [box.min, box.max].map((c) => new THREE.Vector3(a.x, b.y, c.z))));
    let high = floor.y;
    let lowAcross = Infinity;
    let highAcross = -Infinity;
    let nearest = 0;
    for (const world of [...corners, ...placesOf(reading).map((place) => root.localToWorld(new THREE.Vector3(...place)))]) {
      high = Math.max(high, world.y);
      const across = world.dot(right);
      lowAcross = Math.min(lowAcross, across);
      highAcross = Math.max(highAcross, across);
      nearest = Math.max(nearest, world.clone().sub(floor).dot(worldView));
    }
    const bounds = canvas.getBoundingClientRect();
    const shownShare = shownHeightOf(canvas) / bounds.height;
    const tangent = Math.tan(THREE.MathUtils.degToRad(((camera as THREE.PerspectiveCamera).fov ?? 50) / 2));
    const toFitHeight = (high - floor.y) / VIEW_FILL / shownShare / 2 / tangent;
    const toFitWidth = (highAcross - lowAcross) / VIEW_FILL / Math.max(0.1, bounds.width / bounds.height) / 2 / tangent;
    // What reaches towards the camera looks bigger: the fit is for the part of the body nearest it.
    const distance = Math.max(toFitHeight, toFitWidth) + nearest;
    // The middle of the body goes in the middle of what can be seen, above the middle of the canvas.
    const raised = (1 - shownShare) * distance * tangent;
    const middle = floor.clone().addScaledVector(right, (lowAcross + highAcross) / 2 - floor.dot(right));
    middle.y = (floor.y + high) / 2 - raised;
    camera.position.copy(middle).addScaledVector(worldView, distance);
    camera.lookAt(middle);
    if (controls) {
      controls.target.copy(middle);
      controls.update();
    }
    invalidate();
  }, [shown, reading, modelId, root, camera, canvas, controls, worldView, invalidate]);

  const size = reading ? sizeOf(reading) : 1;

  // An animal seen side on has its other side right behind this one: it moves with it, so it is left out.
  const farHidden = sideOn && bothSides;
  const links = useMemo(() => (sideOn ? FOUR_LEG_LINKS : PERSON_LINKS) as readonly [RigMarkerName, RigMarkerName][], [sideOn]);
  const lines = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(links.length * 6), 3));
    return geometry;
  }, [links]);
  useEffect(() => () => lines.dispose(), [lines]);
  useEffect(() => {
    if (!reading) return;
    const places = lines.getAttribute('position') as THREE.BufferAttribute;
    let drawn = 0;
    for (const [from, to] of links) {
      const a = markerAt(reading, from);
      const b = markerAt(reading, to);
      if (!a || !b || (farHidden && (from.startsWith('right') || to.startsWith('right')))) continue;
      places.setXYZ(drawn * 2, ...a);
      places.setXYZ(drawn * 2 + 1, ...b);
      drawn += 1;
    }
    lines.setDrawRange(0, drawn * 2);
    places.needsUpdate = true;
  }, [lines, links, reading, farHidden]);

  // Dragging a marker: the pointer's ray meets the plane through the marker, square to the view of the body.
  const dragging = useRef<RigMarkerName | null>(null);
  const beginDrag = (name: RigMarkerName, event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    dragging.current = name;
    setActiveRigMarker(name);
    if (controls) controls.enabled = false;
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    const pointer = new THREE.Vector2();
    const onMove = (move: PointerEvent): void => {
      const current = dragging.current;
      const place = current && reading ? markerAt(reading, current) : undefined;
      if (!current || !place) return;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(((move.clientX - bounds.left) / bounds.width) * 2 - 1, -((move.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      root.updateWorldMatrix(true, false);
      const at = root.localToWorld(new THREE.Vector3(...place));
      plane.setFromNormalAndCoplanarPoint(worldView, at);
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      root.worldToLocal(hit);
      moveRigMarker(current, [hit.x, hit.y, hit.z] as Point);
      invalidate();
    };
    const onUp = (): void => {
      dragging.current = null;
      setActiveRigMarker(null);
      if (controls) controls.enabled = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!shown || !reading) return null;
  const radius = size * MARKER_SIZE;
  const labels = (sideOn ? FOUR_LEG_LABEL : PERSON_LABEL) as Record<string, string>;
  const names = (Object.keys(labels) as RigMarkerName[]).filter((name) => markerAt(reading, name) && !(farHidden && name.startsWith('right')));
  return (
    <group ref={group}>
      <lineSegments geometry={lines} renderOrder={1000} frustumCulled={false} raycast={NOTHING}>
        <lineBasicMaterial color={LINE_COLOR} depthTest={false} transparent opacity={0.7} toneMapped={false} fog={false} />
      </lineSegments>
      {names.map((name) => {
        const active = activeMarker === name;
        const isRight = name.startsWith('right');
        const label = labels[name];
        return (
          <mesh
            key={name}
            position={markerAt(reading, name)}
            renderOrder={1001}
            onPointerDown={(event) => beginDrag(name, event)}
            onPointerOver={(event) => { event.stopPropagation(); if (!dragging.current) setActiveRigMarker(name); canvas.style.cursor = 'grab'; }}
            onPointerOut={() => { if (!dragging.current) setActiveRigMarker(null); canvas.style.cursor = ''; }}
            onClick={(event) => event.stopPropagation()}
          >
            <sphereGeometry args={[radius, 16, 12]} />
            <meshBasicMaterial color={active ? ACTIVE_COLOR : MARKER_COLOR} depthTest={false} transparent toneMapped={false} fog={false} />
            <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <span
                className={`absolute whitespace-nowrap rounded bg-black/60 px-1 py-px text-2xs ${active ? 'text-white' : 'text-ink-2'}`}
                style={{ ...(isRight ? { right: 8 } : { left: 8 }), top: sideOn ? -8 : label === 'Elbow' ? 6 : label === 'Shoulder' || label === 'Wrist' ? -24 : -8 }}
              >
                {label}
              </span>
            </Html>
          </mesh>
        );
      })}
    </group>
  );
};
