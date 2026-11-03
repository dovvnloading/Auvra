import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { skinPaintSession, type SkinPaintHit } from '../../utils/skinPaint/paintSession';
import { setSkeletonView, type SkinBrushMode } from '../../utils/skeletonView';

const NOTHING = (): void => undefined;

/** Touches along a stroke are this share of the brush's radius apart. */
const TOUCH_SPACING = 0.25;

const FACING_VIEW = new THREE.Vector3(0, 0, 1);

/** Shift does the opposite of the brush chosen. */
const strokeMode = (mode: Exclude<SkinBrushMode, 'off'>, opposite: boolean): Exclude<SkinBrushMode, 'off'> => {
  if (!opposite || mode === 'smooth') return mode;
  return mode === 'add' ? 'remove' : 'add';
};

/**
 * The brush over the model in the view: a ring on the surface under the pointer that says which bones
 * move that spot, and strokes that change the picked bone's weights. A press off the model, or any
 * press with Alt held, is still the camera's.
 */
export const SkinPaintBrush: React.FC<{ root: THREE.Object3D; boneName: string; mode: Exclude<SkinBrushMode, 'off'>; size: number; strength: number }> = ({ root, boneName, mode, size, strength }) => {
  const session = useMemo(() => skinPaintSession(root), [root]);
  const camera = useThree((three) => three.camera);
  const canvas = useThree((three) => three.gl.domElement);
  const controls = useThree((three) => three.controls) as unknown as { enabled: boolean } | null;

  const latest = useRef({ boneName, mode, size, strength });
  latest.current = { boneName, mode, size, strength };

  /** The pointer's place while over the canvas. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const stroke = useRef<{ x: number; y: number; opposite: boolean; spacing: number } | null>(null);
  const brush = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Group>(null);
  const label = useRef<HTMLDivElement>(null);

  const radius = (): number => (latest.current.size / 100) * session.size * 0.5;

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const screen = useMemo(() => new THREE.Vector2(), []);
  const hitAt = (x: number, y: number): SkinPaintHit | null => {
    const bounds = canvas.getBoundingClientRect();
    screen.set(((x - bounds.left) / bounds.width) * 2 - 1, -((y - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(screen, camera);
    return session.hitAt(raycaster.ray);
  };

  /** Pixels on the screen one world unit covers at a place. */
  const pixelsPerUnit = (at: THREE.Vector3): number => {
    const view = camera as THREE.PerspectiveCamera;
    if (!view.isPerspectiveCamera) return 1;
    const height = canvas.getBoundingClientRect().height;
    return height / (2 * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2) * Math.max(camera.position.distanceTo(at), 1e-6));
  };

  useEffect(() => {
    const touchAt = (x: number, y: number): void => {
      const current = stroke.current;
      if (!current) return;
      const hit = hitAt(x, y);
      if (!hit) return;
      const { boneName: bone, mode: chosen, strength: amount } = latest.current;
      session.dab(hit, radius(), strokeMode(chosen, current.opposite), bone, amount / 100);
      current.spacing = Math.max(1, radius() * TOUCH_SPACING * pixelsPerUnit(hit.point));
    };

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.altKey || stroke.current) return;
      session.updatePose();
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit) return;
      // Before the camera's own handler, so it does not turn with the stroke.
      if (controls) controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      // Ctrl-click asks which bone moves this spot most, and paints nothing.
      if (event.ctrlKey) {
        const strongest = session.influencesAt(hit.nearest)[0];
        if (strongest) setSkeletonView({ selectedBone: strongest.name });
        return;
      }
      session.beginStroke();
      stroke.current = { x: event.clientX, y: event.clientY, opposite: event.shiftKey, spacing: 1 };
      touchAt(event.clientX, event.clientY);
    };

    const onMove = (event: PointerEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const current = stroke.current;
      if (!current) return;
      // Evenly spaced touches, however the pointer's events happened to fall.
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      let left = Math.hypot(dx, dy);
      if (left === 0) return;
      const stepX = dx / left;
      const stepY = dy / left;
      while (left >= current.spacing) {
        const step = current.spacing;
        current.x += stepX * step;
        current.y += stepY * step;
        left -= step;
        touchAt(current.x, current.y);
      }
    };

    const onUp = (event: PointerEvent): void => {
      if (controls) controls.enabled = true;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!stroke.current) return;
      stroke.current = null;
      session.endStroke();
    };

    const onLeave = (): void => {
      if (!stroke.current) pointer.current = null;
    };

    // While a stroke holds the camera back, the camera does not keep the browser's menu away either.
    const onMenu = (event: MouseEvent): void => {
      if (stroke.current) event.preventDefault();
    };

    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('contextmenu', onMenu);
    return () => {
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', onMenu);
      canvas.style.cursor = '';
      if (controls) controls.enabled = true;
      if (stroke.current) {
        stroke.current = null;
        session.endStroke();
      }
    };
  }, [camera, canvas, controls, session]);

  const normal = useMemo(() => new THREE.Vector3(), []);
  const shownText = useRef('');
  useFrame(() => {
    session.updatePose();
    const group = brush.current;
    if (!group) return;
    const at = pointer.current;
    const hit = at ? hitAt(at.x, at.y) : null;
    group.visible = Boolean(hit);
    canvas.style.cursor = hit ? 'crosshair' : '';
    if (label.current) label.current.style.display = hit ? '' : 'none';
    if (!hit) return;
    group.position.copy(hit.point);
    group.quaternion.setFromUnitVectors(FACING_VIEW, normal.copy(hit.normal));
    const reach = radius();
    ring.current?.scale.setScalar(reach);
    if (label.current) {
      label.current.style.left = `${Math.round(reach * pixelsPerUnit(hit.point)) + 10}px`;
      const text = session.influencesAt(hit.nearest).map(({ name, share }) => `${name === latest.current.boneName ? '● ' : ''}${name} ${Math.round(share * 100)}%`).join('\n');
      if (text !== shownText.current) {
        shownText.current = text;
        label.current.textContent = text;
      }
    }
  });

  return (
    <group ref={brush} visible={false}>
      <group ref={ring}>
        <mesh renderOrder={1002} frustumCulled={false} raycast={NOTHING}>
          <ringGeometry args={[0.97, 1, 64]} />
          <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} depthTest={false} transparent opacity={0.95} toneMapped={false} fog={false} />
        </mesh>
        <mesh renderOrder={1001} frustumCulled={false} raycast={NOTHING}>
          <ringGeometry args={[1, 1.03, 64]} />
          <meshBasicMaterial color="#000000" side={THREE.DoubleSide} depthTest={false} transparent opacity={0.5} toneMapped={false} fog={false} />
        </mesh>
      </group>
      <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div ref={label} className="absolute -top-2 whitespace-pre rounded bg-black/60 px-1 py-px text-2xs leading-4 text-white" style={{ display: 'none' }} />
      </Html>
    </group>
  );
};
