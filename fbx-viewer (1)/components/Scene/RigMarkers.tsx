import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { MarkerName, Point } from '../../utils/autoRig/bodyMarkers';
import { moveRigMarker, setActiveRigMarker, useRigSession } from '../../utils/autoRig/rigSession';

const MARKER_COLOR = '#ff9a3d';
const ACTIVE_COLOR = '#ffffff';
const LINE_COLOR = '#ff9a3d';

/** What a marker is called on screen. */
const MARKER_LABEL: Record<MarkerName, string> = {
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

const MARKERS = Object.keys(MARKER_LABEL) as MarkerName[];

/** Markers joined by lines, to show the skeleton they make. */
const LINKS: readonly [MarkerName, MarkerName][] = [
  ['chin', 'groin'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'rightShoulder'],
  ['groin', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['groin', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];

/** A marker's size against the body's height. */
const MARKER_SIZE = 0.013;
/** The viewport fills with the body to this share of its height. */
const FRONT_VIEW_FILL = 0.8;

const NOTHING = (): void => undefined;

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
 * The markers of a model being given a skeleton: one to drag onto each joint. They are dragged in
 * a plane square to the way the body faces, and drawn over the model so none is ever lost in it.
 */
export const RigMarkers: React.FC<{ modelId: string; root: THREE.Object3D }> = ({ modelId, root }) => {
  const { stage, modelId: rigging, reading, activeMarker } = useRigSession();
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
  const worldFacing = useMemo(() => {
    if (!facing) return new THREE.Vector3(0, 0, 1);
    root.updateWorldMatrix(true, false);
    return new THREE.Vector3(facing[0], 0, facing[1]).transformDirection(root.matrixWorld);
  }, [facing, root]);

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
    const floor = root.localToWorld(new THREE.Vector3(reading.markers.groin[0], reading.extents.floor, reading.markers.groin[2]));
    const top = root.localToWorld(new THREE.Vector3(...reading.extents.headTop));
    const height = top.distanceTo(floor);
    const bounds = canvas.getBoundingClientRect();
    const shownShare = shownHeightOf(canvas) / bounds.height;
    const tangent = Math.tan(THREE.MathUtils.degToRad(((camera as THREE.PerspectiveCamera).fov ?? 50) / 2));
    const distance = height / FRONT_VIEW_FILL / shownShare / 2 / tangent;
    // The middle of the body goes in the middle of what can be seen, above the middle of the canvas.
    const raised = (1 - shownShare) * distance * tangent;
    const middle = floor.clone().add(top).multiplyScalar(0.5);
    middle.y -= raised;
    camera.position.copy(middle).addScaledVector(worldFacing, distance);
    camera.lookAt(middle);
    if (controls) {
      controls.target.copy(middle);
      controls.update();
    }
    invalidate();
  }, [shown, reading, modelId, root, camera, controls, worldFacing, invalidate]);

  // Markers can go while the pointer is on one.
  useEffect(() => () => { canvas.style.cursor = ''; }, [canvas, shown]);

  const height = reading ? reading.extents.headTop[1] - reading.extents.floor : 1;

  const lines = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINKS.length * 6), 3));
    return geometry;
  }, []);
  useEffect(() => () => lines.dispose(), [lines]);
  useEffect(() => {
    if (!reading) return;
    const places = lines.getAttribute('position') as THREE.BufferAttribute;
    LINKS.forEach(([from, to], index) => {
      places.setXYZ(index * 2, ...reading.markers[from]);
      places.setXYZ(index * 2 + 1, ...reading.markers[to]);
    });
    places.needsUpdate = true;
  }, [lines, reading]);

  // Dragging a marker: the pointer's ray meets the plane through the marker, square to the way the body faces.
  const dragging = useRef<MarkerName | null>(null);
  const beginDrag = (name: MarkerName, event: ThreeEvent<PointerEvent>): void => {
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
      const markers = reading?.markers;
      if (!current || !markers) return;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(((move.clientX - bounds.left) / bounds.width) * 2 - 1, -((move.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      root.updateWorldMatrix(true, false);
      const at = root.localToWorld(new THREE.Vector3(...markers[current]));
      plane.setFromNormalAndCoplanarPoint(worldFacing, at);
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
  const radius = height * MARKER_SIZE;
  return (
    <group ref={group}>
      <lineSegments geometry={lines} renderOrder={1000} frustumCulled={false} raycast={NOTHING}>
        <lineBasicMaterial color={LINE_COLOR} depthTest={false} transparent opacity={0.7} toneMapped={false} fog={false} />
      </lineSegments>
      {MARKERS.map((name) => {
        const active = activeMarker === name;
        const isRight = name.startsWith('right');
        return (
          <mesh
            key={name}
            position={reading.markers[name]}
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
                style={{ ...(isRight ? { right: 8 } : { left: 8 }), top: MARKER_LABEL[name] === 'Elbow' ? 6 : MARKER_LABEL[name] === 'Shoulder' || MARKER_LABEL[name] === 'Wrist' ? -24 : -8 }}
              >
                {MARKER_LABEL[name]}
              </span>
            </Html>
          </mesh>
        );
      })}
    </group>
  );
};
