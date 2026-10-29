import * as THREE from 'three';
import { EffectAttribute } from 'postprocessing';
import { afterEach, describe, expect, it } from 'vitest';
import { publishSkyLight, skyLight } from '../../runtime/daylight';
import {
  AUTO_EXPOSURE_REFERENCE, AutoExposureEffect, COLOR_LOOKS, LightShaftsEffect, MotionBlurEffect, SunHazeEffect, WhiteBalanceEffect,
  applyLook, lookTexture, whiteBalance,
} from '../../runtime/postEffects';

/*
 * The screen effects' CPU side: what they hand their shaders each frame from the camera and the sky, and
 * the colour maths of white balance and looks. The shaders themselves run in the engine.
 */

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A renderer that records the targets drawn into and draws nothing. */
const fakeRenderer = () => {
  const drawn: unknown[] = [];
  let current: unknown = 'screen';
  const renderer = {
    getRenderTarget: () => current,
    setRenderTarget: (target: unknown) => { current = target; },
    render: () => { drawn.push(current); },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, drawn, current: () => current };
};

const cameraLooking = (direction: THREE.Vector3) => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(camera.position.clone().add(direction));
  camera.updateMatrixWorld();
  return camera;
};

const uniform = (effect: { uniforms: Map<string, THREE.Uniform> }, name: string) => effect.uniforms.get(name)!.value;

afterEach(() => {
  publishSkyLight({ x: 0.3, y: 0.9, z: 0.3 }, { r: 1, g: 1, b: 1 }, 0, 0, { r: 0, g: 0, b: 0 });
});

describe('sky light', () => {
  it('publishes a unit sun direction and keeps bad numbers out', () => {
    publishSkyLight({ x: 0, y: 3, z: 4 }, { r: 1, g: 0.8, b: 0.6 }, 2.5, 0.02, { r: 0.5, g: 0.6, b: 0.7 });
    expect(skyLight.sun.y).toBeCloseTo(0.6);
    expect(skyLight.sun.z).toBeCloseTo(0.8);
    expect(skyLight).toMatchObject({ sunColor: [1, 0.8, 0.6], sunStrength: 2.5, fogDensity: 0.02, fogColor: [0.5, 0.6, 0.7] });

    publishSkyLight({ x: 0, y: 0, z: 0 }, { r: 1, g: 1, b: 1 }, Number.NaN, -1, { r: 0, g: 0, b: 0 });
    expect(skyLight.sunStrength).toBe(0);
    expect(skyLight.fogDensity).toBe(0);
    expect(Number.isFinite(skyLight.sun.x)).toBe(true);
  });
});

describe('auto exposure', () => {
  it('leaves a clear midday as authored, with bounded adaptation and compensation in stops', () => {
    const effect = new AutoExposureEffect();
    expect(uniform(effect, 'reference')).toBe(AUTO_EXPOSURE_REFERENCE);
    // Glare dims a little; the dark is lifted, but not out of the night.
    expect(uniform(effect, 'minExposure')).toBeGreaterThanOrEqual(0.5);
    expect(uniform(effect, 'maxExposure')).toBeLessThanOrEqual(3);
    expect(uniform(effect, 'compensation')).toBe(1);

    effect.set({ compensation: 1, minExposure: 0.25 });
    expect(uniform(effect, 'compensation')).toBe(2);
    expect(uniform(effect, 'minExposure')).toBe(0.25);
    effect.set({ compensation: -2 });
    expect(uniform(effect, 'compensation')).toBe(0.25);
    effect.dispose();
  });

  it('measures and adapts on the GPU, leaving the renderer where it was and handing the result over', () => {
    const effect = new AutoExposureEffect();
    const { renderer, drawn, current } = fakeRenderer();
    const input = new THREE.WebGLRenderTarget(8, 8);
    effect.update(renderer, input, 1 / 60);
    // Log luminance, three reductions to one pixel, one adaptation step.
    expect(drawn).toHaveLength(5);
    expect(current()).toBe('screen');
    const first = uniform(effect, 'adapted');
    expect(first).toBeInstanceOf(THREE.Texture);
    // The adapted value ping-pongs, so each frame eases from the last.
    effect.update(renderer, input, 1 / 60);
    expect(uniform(effect, 'adapted')).not.toBe(first);
    effect.dispose();
    input.dispose();
  });
});

describe('motion blur', () => {
  it('starts still, then hands its velocity pass the camera\'s previous view', () => {
    const camera = cameraLooking(new THREE.Vector3(0, 0, -1));
    const effect = new MotionBlurEffect(camera, 0.5);
    // The blur pass reads no depth itself, so it can sit anywhere in the stack.
    expect(effect.getAttributes() & EffectAttribute.CONVOLUTION).toBeTruthy();
    expect(effect.getFragmentShader()).not.toMatch(/mainImage\([^)]*depth/);

    const { renderer, drawn } = fakeRenderer();
    effect.update(renderer);
    // No depth yet and no previous frame: nothing moves and nothing is drawn.
    expect(uniform(effect, 'active')).toBe(0);
    expect(drawn).toHaveLength(0);

    effect.setDepthTexture(new THREE.DepthTexture(4, 4));
    effect.update(renderer);
    expect(uniform(effect, 'active')).toBe(1);
    expect(drawn).toHaveLength(1);

    // Turning the camera: the previous view handed over is the one before the turn.
    const viewBefore = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    camera.lookAt(new THREE.Vector3(1, 2, 0));
    camera.updateMatrixWorld();
    effect.update(renderer);
    const velocity = (effect as unknown as { velocityPass: { material: THREE.ShaderMaterial } }).velocityPass.material.uniforms;
    expect((velocity.previousViewProjection.value as THREE.Matrix4).equals(viewBefore)).toBe(true);
    effect.strength = 0.2;
    expect(velocity.strength.value).toBe(0.2);
    effect.dispose();
  });
});

describe('light shafts', () => {
  it('shine only toward a sun that is up and in view', () => {
    publishSkyLight({ x: 0, y: 0.3, z: -1 }, { r: 1, g: 0.9, b: 0.7 }, 3, 0.01, { r: 1, g: 1, b: 1 });
    const { renderer, drawn } = fakeRenderer();
    const input = new THREE.WebGLRenderTarget(8, 8);

    const facing = new LightShaftsEffect(cameraLooking(new THREE.Vector3(0, 0.2, -1)), 0.5);
    facing.setDepthTexture(new THREE.DepthTexture(4, 4));
    facing.update(renderer, input);
    expect(uniform(facing, 'intensity')).toBeCloseTo(0.5, 1);
    expect(drawn).toHaveLength(2);
    expect((uniform(facing, 'tint') as THREE.Color).toArray()).toEqual([1, 0.9, 0.7]);

    // Behind the camera: nothing is drawn.
    const away = new LightShaftsEffect(cameraLooking(new THREE.Vector3(0, 0, 1)), 0.5);
    away.setDepthTexture(new THREE.DepthTexture(4, 4));
    away.update(renderer, input);
    expect(uniform(away, 'intensity')).toBe(0);
    expect(drawn).toHaveLength(2);

    // Below the horizon: none either.
    publishSkyLight({ x: 0, y: -0.2, z: -1 }, { r: 1, g: 0.9, b: 0.7 }, 3, 0.01, { r: 1, g: 1, b: 1 });
    facing.update(renderer, input);
    expect(uniform(facing, 'intensity')).toBe(0);
    for (const effect of [facing, away]) effect.dispose();
    input.dispose();
  });
});

describe('sunlit haze', () => {
  it('takes the sky\'s sun and fog each frame and fades out with the sun', () => {
    const camera = cameraLooking(new THREE.Vector3(0, 0, -1));
    const effect = new SunHazeEffect(camera, 0.5);
    publishSkyLight({ x: 0, y: 0.5, z: -1 }, { r: 1, g: 0.8, b: 0.6 }, 2, 0.015, { r: 0.7, g: 0.7, b: 0.8 });
    effect.update();
    expect(uniform(effect, 'fogDensity')).toBe(0.015);
    expect((uniform(effect, 'sunColor') as THREE.Color).toArray()).toEqual([2, 1.6, 1.2]);
    expect((uniform(effect, 'cameraWorld') as THREE.Matrix4).equals(camera.matrixWorld)).toBe(true);

    publishSkyLight({ x: 0, y: -0.5, z: -1 }, { r: 1, g: 0.8, b: 0.6 }, 2, 0.015, { r: 0.7, g: 0.7, b: 0.8 });
    effect.update();
    expect((uniform(effect, 'sunColor') as THREE.Color).toArray()).toEqual([0, 0, 0]);
    effect.intensity = 0.2;
    expect(uniform(effect, 'intensity')).toBe(0.2);
    effect.dispose();
  });
});

describe('white balance', () => {
  it('warms, cools and tints without changing brightness', () => {
    expect(whiteBalance(0, 0)).toEqual([1, 1, 1]);
    const warm = whiteBalance(0.5, 0);
    const cool = whiteBalance(-0.5, 0);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    expect(whiteBalance(0, 0.5)[1]).toBeLessThan(1);
    for (const balance of [warm, cool, whiteBalance(0.3, -0.8), whiteBalance(-1, 1)]) expect(luminance(balance)).toBeCloseTo(1, 6);

    const effect = new WhiteBalanceEffect();
    effect.set(0.5, 0);
    expect((uniform(effect, 'balance') as THREE.Vector3).toArray()).toEqual(warm);
    effect.dispose();
  });
});

describe('looks', () => {
  const grey: [number, number, number] = [0.5, 0.5, 0.5];

  it('keeps every look within display range and none as it was', () => {
    expect(applyLook('none', 0.2, 0.4, 0.9)).toEqual([0.2, 0.4, 0.9]);
    for (const look of COLOR_LOOKS) {
      for (const colour of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.1, 0.6, 0.9]] as [number, number, number][]) {
        for (const channel of applyLook(look, ...colour)) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('gives each look its character', () => {
    const [wr, , wb] = applyLook('warm', ...grey);
    expect(wr).toBeGreaterThan(wb);
    const [cr, , cb] = applyLook('cool', ...grey);
    expect(cb).toBeGreaterThan(cr);
    // Teal shadows, orange highlights.
    const shadow = applyLook('cinematic', 0.15, 0.15, 0.15);
    const highlight = applyLook('cinematic', 0.8, 0.8, 0.8);
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    expect(highlight[0]).toBeGreaterThan(highlight[2]);
    // Noir has no colour left; bleach keeps a little.
    const [nr, ng, nb] = applyLook('noir', 0.9, 0.2, 0.1);
    expect(nr).toBe(ng);
    expect(ng).toBe(nb);
    const bleach = applyLook('bleach', 0.9, 0.2, 0.1);
    expect(bleach[0] - bleach[2]).toBeGreaterThan(0);
    expect(bleach[0] - bleach[2]).toBeLessThan(0.8);
    // Vintage lifts the blacks; night is blue.
    expect(Math.min(...applyLook('vintage', 0, 0, 0))).toBeGreaterThan(0.03);
    const night = applyLook('night', ...grey);
    expect(night[2]).toBeGreaterThan(night[0]);
  });

  it('bakes each look once into a 32-cube lookup texture', () => {
    const texture = lookTexture('warm');
    expect(lookTexture('warm')).toBe(texture);
    expect(texture.image.width).toBe(32);
    expect(texture.image.depth).toBe(32);
    const data = texture.image.data as Float32Array;
    // The corner for pure white holds what the look makes of white.
    const white = (32 ** 3 - 1) * 4;
    expect(Array.from(data.slice(white, white + 3))).toEqual(applyLook('warm', 1, 1, 1).map(v => Math.fround(v)));
    expect(lookTexture('noir')).not.toBe(texture);
  });
});
