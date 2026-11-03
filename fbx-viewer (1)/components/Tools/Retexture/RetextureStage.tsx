import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Center, Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { AuvraCanvas } from '../../../renderer/AuvraCanvas';
import { LocalEnvironment } from '../../Scene/LocalEnvironment';
import { partOfHit, setPartGlow } from './parts';
import type { SessionPart } from './retextureSession';

export type StageLighting = 'studio' | 'daylight' | 'flat';

const LIGHTING: Record<StageLighting, { environment: number; ambient: number; lights: { from: [number, number, number]; intensity: number; color: string }[] }> = {
  studio: {
    environment: 0.55,
    ambient: 0.4,
    lights: [
      { from: [4, 6, 5], intensity: 2.2, color: '#fff3e4' },
      { from: [-5, 3, 2], intensity: 0.8, color: '#dde7ff' },
      { from: [0, 4, -6], intensity: 1.2, color: '#ffffff' },
    ],
  },
  daylight: {
    environment: 0.9,
    ambient: 0.55,
    lights: [{ from: [6, 10, 3], intensity: 2.6, color: '#fff6ea' }],
  },
  // For judging colour alone: no light picks out one side.
  flat: { environment: 0.4, ambient: 1.9, lights: [] },
};

/** Parts with this many triangles between them are not hit-tested on every mouse move, only on a click. */
const HOVER_TRIANGLE_LIMIT = 300_000;
const HOVER_INTERVAL_MS = 90;
const CLICK_DRIFT_PIXELS = 4;

const countTriangles = (object: THREE.Object3D): number => {
  let total = 0;
  object.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!(child as THREE.Mesh).isMesh || !geometry) return;
    total += (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return total;
};

/** Draws the model twice, split at a line: the left as it was, the right with what is being tried on. */
const ComparePass: React.FC<{ split: number; drawBefore: () => void; drawAfter: () => void }> = ({ split, drawBefore, drawAfter }) => {
  const latest = useRef({ split, drawBefore, drawAfter });
  latest.current = { split, drawBefore, drawAfter };
  useFrame(({ gl, scene, camera, size }) => {
    const now = latest.current;
    const line = Math.round(size.width * now.split);
    gl.setScissorTest(true);
    now.drawBefore();
    gl.setScissor(0, 0, line, size.height);
    gl.render(scene, camera);
    now.drawAfter();
    gl.setScissor(line, 0, size.width - line, size.height);
    gl.render(scene, camera);
    gl.setScissorTest(false);
  }, 1);
  useEffect(() => () => latest.current.drawAfter(), []);
  return null;
};

/** Says which part is under the mouse, without getting in the way of a drag. */
const PartHover: React.FC<{ object: THREE.Object3D; parts: readonly SessionPart[]; onHover: (part: SessionPart | null, x: number, y: number) => void }> = ({ object, parts, onHover }) => {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    if (parts.length < 2 || countTriangles(object) > HOVER_TRIANGLE_LIMIT) return undefined;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const element = gl.domElement;
    let last = 0;
    const onMove = (event: PointerEvent) => {
      if (event.buttons) { onHover(null, 0, 0); return; }
      const now = performance.now();
      if (now - last < HOVER_INTERVAL_MS) return;
      last = now;
      const box = element.getBoundingClientRect();
      pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(object, true)[0];
      onHover(hit ? partOfHit(parts, hit.object, hit.face?.materialIndex) : null, event.clientX - box.left, event.clientY - box.top);
    };
    const onLeave = () => onHover(null, 0, 0);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
    };
  }, [camera, gl, object, onHover, parts]);
  return null;
};

/** A light aimed at the stage, sized to the model. The first of a rig casts the shadow on the floor. */
const StageLight: React.FC<{ from: readonly [number, number, number]; intensity: number; color: string; unit: number; casts: boolean }> = ({ from, intensity, color, unit, casts }) => {
  const light = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    const shadow = light.current?.shadow;
    if (!shadow) return;
    const camera = shadow.camera;
    camera.left = camera.bottom = -unit * 1.4;
    camera.right = camera.top = unit * 1.4;
    camera.near = unit * 0.1;
    camera.far = unit * 6;
    camera.updateProjectionMatrix();
    shadow.needsUpdate = true;
  }, [unit]);
  const reach = unit / Math.hypot(...from) * 2.6;
  return (
    <directionalLight
      ref={light}
      position={[from[0] * reach, from[1] * reach, from[2] * reach]}
      intensity={intensity}
      color={color}
      castShadow={casts}
      shadow-mapSize={[2048, 2048]}
      shadow-radius={7}
      shadow-bias={-0.0004}
    />
  );
};

/** A three-quarter view from the front and a little above, as a model is usually shown. */
const VIEW_DIRECTION = new THREE.Vector3(0.45, 0.3, 1).normalize();
const FRAME_MARGIN = 1.06;

/** How far along the view direction the camera must stand for a box this size to fill the view and no more. */
const fittingDistance = (size: THREE.Vector3, fov: number, aspect: number): number => {
  const right = new THREE.Vector3(0, 1, 0).cross(VIEW_DIRECTION).normalize();
  const up = new THREE.Vector3().crossVectors(VIEW_DIRECTION, right);
  const halfTan = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const corner = new THREE.Vector3();
  let distance = 0;
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    corner.set(size.x * x, size.y * y, size.z * z);
    const toward = corner.dot(VIEW_DIRECTION);
    distance = Math.max(distance, Math.abs(corner.dot(up)) / halfTan + toward, Math.abs(corner.dot(right)) / (halfTan * aspect) + toward);
  }
  return distance * FRAME_MARGIN;
};

/** Fits the whole model in view, on each new model and whenever `signal` changes. */
const FrameModel: React.FC<{ size: THREE.Vector3; signal: number }> = ({ size, signal }) => {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const aspect = useThree((state) => state.viewport.aspect);
  const framedFor = useRef('');
  useLayoutEffect(() => {
    if (!controls) return;
    const key = `${size.toArray().join()}:${signal}`;
    if (framedFor.current === key) return;
    framedFor.current = key;
    const distance = fittingDistance(size, camera.fov, aspect);
    const center = new THREE.Vector3(0, size.y / 2, 0);
    camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
    camera.near = distance / 200;
    camera.far = distance * 40;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }, [aspect, camera, controls, signal, size]);
  return null;
};

export interface RetextureStageProps {
  modelId: string;
  object: THREE.Object3D;
  parts: readonly SessionPart[];
  /** A part to pick out on the model, as its row is pointed at. */
  glowPart: SessionPart | null;
  onPickPart: (part: SessionPart) => void;
  lighting: StageLighting;
  floor: boolean;
  turntable: boolean;
  frameSignal: number;
  compare: { split: number; drawBefore: () => void; drawAfter: () => void } | null;
}

/** The model on a lit stage with a floor, in a view that frames it whatever its size. */
export const RetextureStage: React.FC<RetextureStageProps> = ({ modelId, object, parts, glowPart, onPickPart, lighting, floor, turntable, frameSignal, compare }) => {
  const [size, setSize] = useState(() => new THREE.Vector3(1, 1, 1));
  const unit = Math.max(size.x, size.y, size.z) || 1;
  const [hovered, setHovered] = useState<{ part: SessionPart; x: number; y: number } | null>(null);
  const rig = LIGHTING[lighting];

  // The floor shadow needs the model to cast one, here only: it also appears in other views that manage their own.
  useEffect(() => {
    const restore: (() => void)[] = [];
    object.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || child.castShadow) return;
      child.castShadow = true;
      restore.push(() => { child.castShadow = false; });
    });
    return () => restore.forEach((undo) => undo());
  }, [object]);

  const glowing = hovered?.part ?? glowPart;
  useEffect(() => {
    if (!glowing) return undefined;
    setPartGlow(glowing, true);
    return () => setPartGlow(glowing, false);
  }, [glowing]);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > CLICK_DRIFT_PIXELS) return;
    event.stopPropagation();
    const part = partOfHit(parts, event.object, event.face?.materialIndex);
    if (part) onPickPart(part);
  };

  const handleHover = React.useCallback((part: SessionPart | null, x: number, y: number) => setHovered(part ? { part, x, y } : null), []);

  return (
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_62%,#6d6f74_0%,#505257_42%,#2b2c30_100%)]">
      <AuvraCanvas surfaceId="preview-retexture-editor" role="preview" shadows="soft" camera={{ position: [2, 1.6, 4], fov: 32 }} className="absolute inset-0">
        <LocalEnvironment intensity={rig.environment} />
        {/* The environment map lights only standard materials; imported models are often Phong. */}
        <ambientLight intensity={rig.ambient} />
        {rig.lights.map((light, index) => <StageLight key={light.from.join()} from={light.from} intensity={light.intensity} color={light.color} unit={unit} casts={floor && index === 0} />)}

        <Center key={modelId} top cacheKey={modelId} onCentered={({ width, height, depth }) => setSize(new THREE.Vector3(width, height, depth))}>
          <primitive object={object} onClick={handleClick} />
        </Center>
        <FrameModel size={size} signal={frameSignal} />

        {floor && (
          <>
            <Grid
              args={[unit * 24, unit * 24]}
              cellSize={unit / 12}
              cellThickness={0.6}
              cellColor="#5d5f64"
              sectionSize={unit / 3}
              sectionThickness={0.9}
              sectionColor="#74767c"
              fadeDistance={unit * 6}
              fadeStrength={1.8}
              side={THREE.DoubleSide}
            />
            <mesh rotation-x={-Math.PI / 2} position-y={unit * 0.001} receiveShadow>
              <planeGeometry args={[unit * 12, unit * 12]} />
              <shadowMaterial transparent opacity={0.42} />
            </mesh>
          </>
        )}

        <OrbitControls makeDefault enableDamping autoRotate={turntable} autoRotateSpeed={1.1} minPolarAngle={0} maxPolarAngle={Math.PI / 2.02} />
        <PartHover object={object} parts={parts} onHover={handleHover} />
        {compare && <ComparePass split={compare.split} drawBefore={compare.drawBefore} drawAfter={compare.drawAfter} />}
      </AuvraCanvas>
      {hovered && (
        <div style={{ left: hovered.x + 14, top: hovered.y + 14 }} className="pointer-events-none absolute z-10 rounded bg-ground/90 px-1.5 py-0.5 text-2xs text-ink">
          {hovered.part.name}
        </div>
      )}
    </div>
  );
};
