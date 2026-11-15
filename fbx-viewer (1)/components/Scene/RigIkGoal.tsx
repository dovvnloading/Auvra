import type React from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { TransformControls } from 'three-stdlib';
import * as THREE from 'three';
import type { Point } from '../../utils/autoRig/bodyMarkers';
import type { RigIkLimb } from '../../utils/autoRig/reviewIk';
import { setRigIkGoal } from '../../utils/autoRig/rigSession';

interface GizmoEvents {
  change: {};
  mouseDown: {};
  mouseUp: {};
  objectChange: {};
}

/** A world-space translate gizmo with a model-local target, independent of the posed skeleton. */
export const RigIkGoal: React.FC<{ model: THREE.Object3D; limb: RigIkLimb; point: Point }> = ({ model, limb, point }) => {
  const scene = useThree(state => state.scene);
  const camera = useThree(state => state.camera);
  const canvas = useThree(state => state.gl.domElement);
  const orbit = useThree(state => state.controls) as { enabled: boolean } | null;
  const invalidate = useThree(state => state.invalidate);
  const proxy = useMemo(() => new THREE.Group(), []);
  const dragging = useRef(false);
  const [generation, mountNewGizmo] = useState(0);

  useFrame(() => {
    if (dragging.current) return;
    scene.worldToLocal(model.localToWorld(proxy.position.fromArray(point)));
    proxy.updateMatrixWorld(true);
  }, -0.5);

  useLayoutEffect(() => {
    const gizmo = new TransformControls(camera, canvas);
    const events = gizmo as unknown as THREE.EventDispatcher<GizmoEvents>;
    gizmo.attach(proxy);
    gizmo.setMode('translate');
    gizmo.setSpace('world');
    gizmo.setSize(0.65);
    scene.add(proxy, gizmo);
    const vector = new THREE.Vector3();
    let orbitWasEnabled = false;
    const oldTouchAction = canvas.style.touchAction;

    const begin = () => {
      dragging.current = true;
      if (orbit) { orbitWasEnabled = orbit.enabled; orbit.enabled = false; }
    };
    const end = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (orbit) orbit.enabled = orbitWasEnabled;
      canvas.style.touchAction = oldTouchAction;
    };
    const move = () => {
      if (!dragging.current) return;
      model.worldToLocal(proxy.getWorldPosition(vector));
      setRigIkGoal(limb, [vector.x, vector.y, vector.z]);
    };
    // A lost pointer never fires TransformControls' normal mouseUp. Disposing the old gizmo
    // releases its document listeners and the drag plane before accepting another gesture.
    const interrupt = () => {
      if (!dragging.current) return;
      end();
      mountNewGizmo(value => value + 1);
    };
    const redraw = () => invalidate();
    events.addEventListener('mouseDown', begin);
    events.addEventListener('mouseUp', end);
    events.addEventListener('objectChange', move);
    events.addEventListener('change', redraw);
    window.addEventListener('blur', interrupt);
    canvas.ownerDocument.addEventListener('pointercancel', interrupt);
    invalidate();
    return () => {
      end();
      window.removeEventListener('blur', interrupt);
      canvas.ownerDocument.removeEventListener('pointercancel', interrupt);
      events.removeEventListener('mouseDown', begin);
      events.removeEventListener('mouseUp', end);
      events.removeEventListener('objectChange', move);
      events.removeEventListener('change', redraw);
      gizmo.detach();
      proxy.removeFromParent();
      gizmo.removeFromParent();
      gizmo.dispose();
      canvas.style.touchAction = oldTouchAction;
      invalidate();
    };
  }, [camera, canvas, scene, model, limb, orbit, proxy, invalidate, generation]);
  return null;
};
