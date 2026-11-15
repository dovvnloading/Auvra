import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Billboard, Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { Point } from '../../utils/autoRig/bodyMarkers';
import type { RigMarkerName, RigReading } from '../../utils/autoRig/rigBody';
import { guideLinksFor, listRigGuides, markerAt, projectGuidePoint } from '../../utils/autoRig/guideEditing';
import { beginRigGuideDrag, endRigGuideDrag, handleRigGuideKey, setRigGuidePosition, setActiveRigMarker, useRigSession } from '../../utils/autoRig/rigSession';

const GUIDE_COLORS = { Left: '#6edbd6', Right: '#c4a3fb', Center: '#ffab61' };
const NO_LINKS = [] as const;

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
  const { stage, modelId: rigging, reading, activeMarker, bothSides, frameRequest } = useRigSession();
  const shown = stage === 'placing' && rigging === modelId && !!reading;
  const camera = useThree((three) => three.camera);
  const canvas = useThree((three) => three.gl.domElement);
  const viewportWidth = useThree((three) => three.size.width);
  const viewportHeight = useThree((three) => three.size.height);
  const controls = useThree((three) => three.controls) as unknown as { enabled: boolean; target: THREE.Vector3; update: () => void } | null;
  const invalidate = useThree((three) => three.invalidate);
  const group = useRef<THREE.Group>(null);

  const [hover, setHover] = useState<RigMarkerName | null>(null);
  const stopDrag = useRef<((cancel?: boolean) => void) | null>(null);

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
    const frame = modelId + '/' + frameRequest;
    if (framedFor.current === frame || viewportWidth <= 0 || viewportHeight <= 0) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    framedFor.current = frame;
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
  }, [shown, reading, modelId, root, camera, canvas, controls, worldView, invalidate, frameRequest, viewportWidth, viewportHeight]);

  useEffect(() => {
    if (!shown) return;
    const previousTabIndex = canvas.getAttribute('tabindex');
    if (previousTabIndex === null) canvas.tabIndex = 0;
    canvas.addEventListener('keydown', handleRigGuideKey, true);
    return () => {
      stopDrag.current?.(true);
      canvas.style.cursor = '';
      canvas.removeEventListener('keydown', handleRigGuideKey, true);
      if (previousTabIndex === null) canvas.removeAttribute('tabindex');
    };
  }, [canvas, shown]);

  const size = reading ? sizeOf(reading) : 1;
  // In side view the legs overlap. Selecting a far-side guide in the list brings that side forward.
  const hiddenSide = sideOn && bothSides ? (activeMarker?.startsWith('right') ? 'left' : 'right') : null;
  const links = reading ? guideLinksFor(reading) : NO_LINKS;
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
      if (!a || !b || (hiddenSide && (from.startsWith(hiddenSide) || to.startsWith(hiddenSide)))) continue;
      places.setXYZ(drawn * 2, ...a);
      places.setXYZ(drawn * 2 + 1, ...b);
      drawn += 1;
    }
    lines.setDrawRange(0, drawn * 2);
    places.needsUpdate = true;
  }, [lines, links, reading, hiddenSide]);

  const beginDrag = (name: RigMarkerName, event: ThreeEvent<PointerEvent>): void => {
    if (event.button !== 0 || !reading || stopDrag.current) return;
    const place = markerAt(reading, name);
    if (!place) return;
    event.stopPropagation();
    canvas.focus({ preventScroll: true });
    setActiveRigMarker(name);
    beginRigGuideDrag();

    // Keep the initial grab offset. The pointer moves in the current camera plane, while the guide
    // can only move horizontally and vertically in its fitting plane, even if the artist has orbited.
    const pointerId = event.pointerId;
    const controlsEnabled = controls?.enabled ?? false;
    if (controls) controls.enabled = false;
    canvas.style.cursor = 'grabbing';
    const start = root.localToWorld(new THREE.Vector3(...place));
    const cameraPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), start);
    const grab = event.ray.intersectPlane(cameraPlane, new THREE.Vector3()) ?? start.clone();
    const raycaster = new THREE.Raycaster();
    const drag = new THREE.Vector3();
    const pointer = new THREE.Vector2();
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(((move.clientX - bounds.left) / bounds.width) * 2 - 1, -((move.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      if (!raycaster.ray.intersectPlane(cameraPlane, drag)) return;
      root.worldToLocal(drag.sub(grab).add(start));
      const [u, v] = projectGuidePoint(reading, [drag.x, drag.y, drag.z]);
      setRigGuidePosition(name, u, v);
      invalidate();
    };
    const finish = (cancel = false): void => {
      stopDrag.current = null;
      canvas.style.cursor = '';
      if (controls) controls.enabled = controlsEnabled;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
      endRigGuideDrag(cancel);
    };
    const onUp = (e: PointerEvent): void => { if (e.pointerId === pointerId) finish(); };
    const onCancel = (e: PointerEvent): void => { if (e.pointerId === pointerId) finish(true); };
    const onBlur = (): void => finish(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    stopDrag.current = finish;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
  };

  if (!shown || !reading) return null;
  const radius = size * MARKER_SIZE;
  const guides = listRigGuides(reading).filter(({ name }) => !hiddenSide || !name.startsWith(hiddenSide));
  return (
    <group ref={group}>
      <lineSegments geometry={lines} renderOrder={1000} frustumCulled={false} raycast={NOTHING}>
        <lineBasicMaterial color="#ffe0b6" depthTest={false} depthWrite={false} transparent opacity={0.65} toneMapped={false} fog={false} />
      </lineSegments>
      {guides.map(({ name, label, side, point }) => {
        const selected = activeMarker === name;
        const showLabel = selected || hover === name;
        const color = GUIDE_COLORS[side];
        return (
          <mesh
            key={name}
            position={point}
            renderOrder={1001}
            onPointerDown={(event) => beginDrag(name, event)}
            onPointerOver={(event) => { event.stopPropagation(); setHover(name); if (!stopDrag.current) canvas.style.cursor = 'grab'; }}
            onPointerOut={() => { setHover(null); if (!stopDrag.current) canvas.style.cursor = ''; }}
            onClick={(event) => event.stopPropagation()}
          >
            <sphereGeometry args={[radius, 16, 12]} />
            <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent toneMapped={false} fog={false} />
            <mesh>
              <sphereGeometry args={[radius * 1.65, 12, 8]} />
              <meshBasicMaterial visible={false} />
            </mesh>
            {selected && (
              <Billboard>
                <mesh renderOrder={1002} raycast={NOTHING}>
                  <ringGeometry args={[radius * 1.32, radius * 1.56, 36]} />
                  <meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent toneMapped={false} fog={false} />
                </mesh>
              </Billboard>
            )}
            {showLabel && (
              <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
                <span
                  className="absolute top-[-10px] whitespace-nowrap rounded border bg-black/90 px-1.5 py-0.5 text-2xs font-medium text-white"
                  style={{ ...(side === 'Right' ? { right: 14 } : { left: 14 }), borderColor: color }}
                >
                  {label}
                </span>
              </Html>
            )}
          </mesh>
        );
      })}
    </group>
  );
};
