import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { RigIkGoal } from '../../components/Scene/RigIkGoal';
import { setRigIkGoal } from '../../utils/autoRig/rigSession';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
const canvas = document.createElement('canvas');
const orbit = { enabled: true };
const invalidate = vi.fn();
let frame: (() => void) | undefined;
vi.mock('@react-three/fiber', () => ({
  useThree: (select: (value: object) => unknown) => select({ scene, camera, gl: { domElement: canvas }, controls: orbit, invalidate }),
  useFrame: (callback: () => void) => { frame = callback; },
}));
vi.mock('../../utils/autoRig/rigSession', () => ({ setRigIkGoal: vi.fn() }));

// The real control raycasts its screen-projected handles without a WebGL renderer.
describe('IK translate gizmo', () => {
  afterEach(() => { scene.clear(); orbit.enabled = true; vi.clearAllMocks(); });

  it('translates an axis by pointer input and releases orbit controls on drag interruption', () => {
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const model = new THREE.Group();
    model.scale.setScalar(2);
    scene.add(model);
    const view = render(<RigIkGoal model={model} limb="leftHand" point={[0, 0, 0]} />);
    const gizmo = scene.children.find(child => 'isTransformControls' in child);
    expect(gizmo).toBeDefined();
    frame?.();
    scene.updateMatrixWorld(true);
    const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1 });
    let x = 400;
    for (; x < 600; x += 2) {
      move(x, 300);
      if (Reflect.get(gizmo!, 'axis') === 'X') break;
    }
    expect(x).toBeLessThan(600);
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: x, clientY: 300, pointerType: 'mouse', pointerId: 1 });
    expect(orbit.enabled).toBe(false);
    act(() => { fireEvent.pointerMove(document, { button: -1, buttons: 1, clientX: x + 35, clientY: 300, pointerType: 'mouse', pointerId: 1 }); });
    const latest = vi.mocked(setRigIkGoal).mock.lastCall;
    expect(latest?.[0]).toBe('leftHand');
    expect(latest?.[1][0]).toBeGreaterThan(0);
    expect(latest?.[1][1]).toBeCloseTo(0);
    expect(latest?.[1][2]).toBeCloseTo(0);
    fireEvent.pointerCancel(document, { pointerId: 1 });
    expect(orbit.enabled).toBe(true);
    view.unmount();
    expect(scene.children).toEqual([model]);
  });
});
