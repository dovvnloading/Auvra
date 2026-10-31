import * as THREE from 'three';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The local environment owns the map it captures, because the renderer's own conversion of a captured cube cannot
 * be freed. The look is checked by comparing the screens that use it.
 */

const harness = vi.hoisted(() => ({
  gl: {},
  scene: null as unknown as THREE.Scene,
  captured: [] as Array<{ target: { texture: object; dispose: ReturnType<typeof vi.fn> }; night: boolean }>,
}));

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { gl: object; scene: THREE.Scene }) => unknown) => selector({ gl: harness.gl, scene: harness.scene }),
}));

vi.mock('../../components/Scene/localEnvironmentCapture', async (original) => ({
  ...(await original<typeof import('../../components/Scene/localEnvironmentCapture')>()),
  captureLocalEnvironment: (_gl: object, night: boolean) => {
    const target = { texture: { night }, dispose: vi.fn() };
    harness.captured.push({ target, night });
    return target;
  },
}));

import { LocalEnvironment } from '../../components/Scene/LocalEnvironment';
import { localLightPanels } from '../../components/Scene/localEnvironmentCapture';

beforeEach(() => {
  harness.scene = new THREE.Scene();
  harness.captured = [];
});

describe('local environment', () => {
  it('lights the scene from the map it captured', () => {
    render(<LocalEnvironment intensity={0.5} />);
    expect(harness.captured).toHaveLength(1);
    expect(harness.scene.environment).toBe(harness.captured[0].target.texture);
    expect(harness.scene.environmentIntensity).toBe(0.5);
  });

  it('frees the map and puts the scene back when it goes', () => {
    const before = new THREE.Texture();
    harness.scene.environment = before;
    harness.scene.environmentIntensity = 2;
    const view = render(<LocalEnvironment />);
    view.unmount();
    expect(harness.captured[0].target.dispose).toHaveBeenCalledTimes(1);
    expect(harness.scene.environment).toBe(before);
    expect(harness.scene.environmentIntensity).toBe(2);
  });

  it('leaves an environment something else set since', () => {
    const view = render(<LocalEnvironment />);
    const sky = new THREE.Texture();
    harness.scene.environment = sky;
    view.unmount();
    expect(harness.captured[0].target.dispose).toHaveBeenCalledTimes(1);
    expect(harness.scene.environment).toBe(sky);
  });

  it('captures again for the night rig, freeing the day one', () => {
    const view = render(<LocalEnvironment />);
    view.rerender(<LocalEnvironment night />);
    expect(harness.captured.map(capture => capture.night)).toEqual([false, true]);
    expect(harness.captured[0].target.dispose).toHaveBeenCalledTimes(1);
    expect(harness.scene.environment).toBe(harness.captured[1].target.texture);
    view.unmount();
    expect(harness.captured[1].target.dispose).toHaveBeenCalledTimes(1);
  });

  it('changes brightness without capturing again', () => {
    const view = render(<LocalEnvironment intensity={0.5} />);
    view.rerender(<LocalEnvironment intensity={1} />);
    expect(harness.captured).toHaveLength(1);
    expect(harness.scene.environmentIntensity).toBe(1);
    view.unmount();
  });

  it('keeps the rig the editor has always been lit by', () => {
    expect(localLightPanels(false).map(panel => panel.intensity)).toEqual([1.4, 0.8, 0.35]);
    expect(localLightPanels(true).map(panel => panel.intensity)).toEqual([0.6, 0.8, 0.35]);
    expect(localLightPanels(false)[0]).toMatchObject({ color: '#fff4dc', position: [4, 6, 3], scale: [5, 5] });
    expect(localLightPanels(true)[0].color).toBe('#5271a8');
  });
});
