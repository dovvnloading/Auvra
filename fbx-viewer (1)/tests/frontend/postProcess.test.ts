import React from 'react';
import * as THREE from 'three';
import { ToneMappingMode } from 'postprocessing';
import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POST_PROCESS_COMPONENT,
  POST_PROCESS_DEFAULTS,
  PostProcessAllowedContext,
  claimPostProcess,
  createToneMappingOverride,
  getPostProcessOwner,
  resolvePostProcessSettings,
  subscribePostProcessOwner,
  useActivePostProcess,
  usePostProcessClaimed,
} from '../../runtime/components/postProcess';
import type { LevelComponent, LevelObject } from '../../types';

/*
 * The stack rendered against stand-ins: @react-three/fiber supplies a fake renderer and camera and a
 * frame loop the test steps; @react-three/postprocessing records the composers mounted and the
 * effects each was given, in order.
 */

interface RecordedEffect { name: string; key: string | null; props: Record<string, unknown> }

const harness = vi.hoisted(() => ({
  gl: { toneMapping: 0, toneMappingExposure: 1 },
  camera: { uuid: 'camera-a' },
  frames: new Set<() => void>(),
  mountedComposers: 0,
  lastComposer: null as { multisampling?: number; effects: RecordedEffect[] } | null,
}));

vi.mock('@react-three/fiber', async () => {
  const R = await import('react');
  return {
    useThree: (selector: (state: { gl: unknown; camera: unknown }) => unknown) => selector({ gl: harness.gl, camera: harness.camera }),
    useFrame: (callback: () => void) => {
      const latest = R.useRef(callback);
      latest.current = callback;
      R.useEffect(() => {
        const run = () => latest.current();
        harness.frames.add(run);
        return () => { harness.frames.delete(run); };
      }, []);
    },
  };
});

vi.mock('@react-three/postprocessing', async () => {
  const R = await import('react');
  const effect = (name: string) => {
    const Effect = () => null;
    Effect.displayName = name;
    return Effect;
  };
  return {
    EffectComposer: ({ children, multisampling }: { children: React.ReactNode; multisampling?: number }) => {
      R.useEffect(() => {
        harness.mountedComposers++;
        return () => { harness.mountedComposers--; };
      }, []);
      harness.lastComposer = {
        multisampling,
        effects: R.Children.toArray(children).map(child => {
          const element = child as React.ReactElement<Record<string, unknown>>;
          const type = element.type as { displayName?: string; name?: string };
          return { name: type.displayName ?? type.name ?? '?', key: element.key, props: element.props };
        }),
      };
      return R.createElement(R.Fragment, null, children);
    },
    Bloom: effect('Bloom'),
    BrightnessContrast: effect('BrightnessContrast'),
    ChromaticAberration: effect('ChromaticAberration'),
    DepthOfField: effect('DepthOfField'),
    HueSaturation: effect('HueSaturation'),
    N8AO: effect('N8AO'),
    Noise: effect('Noise'),
    SMAA: effect('SMAA'),
    ToneMapping: effect('ToneMapping'),
    Vignette: effect('Vignette'),
  };
});

const defaults = () => Object.fromEntries(POST_PROCESS_COMPONENT.props.map(prop => [prop.key, prop.default]));

const componentWith = (props: Record<string, unknown>, id = 'post'): LevelComponent => ({ id, type: 'postProcess', enabled: true, props });

const owner = (id: string) => ({ id, name: id }) as LevelObject;

const stackElement = (component: LevelComponent, objectId = 'volume') =>
  React.createElement(POST_PROCESS_COMPONENT.Render!, { object: owner(objectId), component, mode: 'runtime' });

const step = () => act(() => { for (const frame of [...harness.frames]) frame(); });

const effectNames = () => harness.lastComposer?.effects.map(effect => effect.name);

const effectProps = (name: string) => harness.lastComposer?.effects.find(effect => effect.name === name)?.props;

beforeEach(() => {
  harness.gl = { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 };
  harness.camera = { uuid: 'camera-a' };
  harness.frames.clear();
  harness.mountedComposers = 0;
  harness.lastComposer = null;
});

describe('post process settings', () => {
  it('declares a global component whose defaults resolve to a subtle lit-scene stack', () => {
    expect(POST_PROCESS_COMPONENT.type).toBe('postProcess');
    expect(POST_PROCESS_COMPONENT.label).toBe('Post Process');
    expect(typeof POST_PROCESS_COMPONENT.Render).toBe('function');
    expect(POST_PROCESS_COMPONENT.props.map(prop => prop.key)).toEqual([
      'bloom', 'bloomIntensity', 'bloomThreshold', 'ambientOcclusion', 'aoIntensity', 'aoRadius', 'toneMapping', 'exposure',
      'autoExposure', 'exposureCompensation', 'adaptationSpeed', 'lightShafts', 'lightShaftsIntensity', 'sunHaze', 'sunHazeIntensity',
      'motionBlur', 'motionBlurStrength', 'vignette', 'vignetteDarkness', 'depthOfField', 'focusDistance', 'bokehScale',
      'saturation', 'contrast', 'brightness', 'temperature', 'tint', 'look', 'lookStrength', 'filmGrain', 'chromaticAberration',
      'antialias',
    ]);
    for (const prop of POST_PROCESS_COMPONENT.props) {
      if (prop.type === 'select') expect(prop.options?.map(option => option.value)).toContain(prop.default);
      if (prop.type === 'number') {
        expect(prop.default as number).toBeGreaterThanOrEqual(prop.min!);
        expect(prop.default as number).toBeLessThanOrEqual(prop.max!);
      }
    }
    const select = (key: string) => POST_PROCESS_COMPONENT.props.find(prop => prop.key === key)?.options?.map(option => option.value);
    expect(select('toneMapping')).toEqual(['aces', 'agx', 'reinhard', 'neutral', 'none']);
    expect(select('antialias')).toEqual(['smaa', 'none']);
    expect(select('look')).toEqual(['none', 'warm', 'cool', 'cinematic', 'bleach', 'noir', 'vintage', 'night']);

    expect(resolvePostProcessSettings(componentWith(defaults()))).toEqual(POST_PROCESS_DEFAULTS);
    expect(POST_PROCESS_DEFAULTS).toMatchObject({
      bloom: true, ambientOcclusion: true, toneMapping: 'aces', exposure: 1, depthOfField: false, antialias: 'smaa',
      saturation: 0, contrast: 0, brightness: 0,
      // The eye adapts and the sun lights the air by default; the camera's own effects are opt-in.
      autoExposure: true, exposureCompensation: 0, lightShafts: true, sunHaze: true, motionBlur: false,
      temperature: 0, tint: 0, look: 'none', filmGrain: 0, chromaticAberration: 0,
    });
    expect(POST_PROCESS_DEFAULTS.bloomIntensity).toBeLessThan(1);
    expect(POST_PROCESS_DEFAULTS.bloomThreshold).toBeGreaterThanOrEqual(1);
    // A component saved before any of its props existed reads as the defaults.
    expect(resolvePostProcessSettings(componentWith({}))).toEqual(POST_PROCESS_DEFAULTS);
  });

  it('keeps valid values and clamps every number to its range', () => {
    const kept = resolvePostProcessSettings(componentWith({
      bloom: false, bloomIntensity: 1.5, ambientOcclusion: false, aoRadius: 3, toneMapping: 'agx', exposure: 1.4,
      vignette: false, depthOfField: true, focusDistance: 4, saturation: -0.3, contrast: 0.2, brightness: 0.1, antialias: 'none',
    }));
    expect(kept).toMatchObject({
      bloom: false, bloomIntensity: 1.5, ambientOcclusion: false, aoRadius: 3, toneMapping: 'agx', exposure: 1.4,
      vignette: false, depthOfField: true, focusDistance: 4, saturation: -0.3, contrast: 0.2, brightness: 0.1, antialias: 'none',
    });

    for (const prop of POST_PROCESS_COMPONENT.props.filter(candidate => candidate.type === 'number')) {
      const high = resolvePostProcessSettings(componentWith({ [prop.key]: 1e9 })) as unknown as Record<string, unknown>;
      const low = resolvePostProcessSettings(componentWith({ [prop.key]: -1e9 })) as unknown as Record<string, unknown>;
      expect(high[prop.key]).toBe(prop.max);
      expect(low[prop.key]).toBe(prop.min);
    }
    expect(resolvePostProcessSettings(componentWith({ exposure: 0, aoRadius: 0, focusDistance: -2 }))).toMatchObject({
      exposure: 0.05, aoRadius: 0.05, focusDistance: 0.1,
    });
    expect(resolvePostProcessSettings(componentWith({ saturation: 4, contrast: -4, brightness: 2 }))).toMatchObject({
      saturation: 1, contrast: -1, brightness: 1,
    });
  });

  it('falls back on values of the wrong type', () => {
    const settings = resolvePostProcessSettings(componentWith({
      bloom: 'yes', bloomIntensity: '2', bloomThreshold: Number.NaN, ambientOcclusion: 1, aoIntensity: null, aoRadius: [2],
      toneMapping: 'ACES', exposure: Number.POSITIVE_INFINITY, vignette: null, vignetteDarkness: { value: 1 },
      depthOfField: 'true', focusDistance: undefined, bokehScale: true, saturation: '0.5', contrast: Number.NEGATIVE_INFINITY,
      brightness: {}, antialias: 'fxaa', autoExposure: 'no', lightShafts: 0, motionBlur: 'on', look: 'sepia',
      temperature: '0.5', lookStrength: Number.NaN, filmGrain: [0.2],
    }));
    expect(settings).toEqual(POST_PROCESS_DEFAULTS);
    expect(resolvePostProcessSettings(componentWith({ toneMapping: 3, antialias: true })).toneMapping).toBe('aces');
    // A corrupt save without a props object at all.
    expect(resolvePostProcessSettings({ id: 'bad', type: 'postProcess', enabled: true, props: null } as unknown as LevelComponent))
      .toEqual(POST_PROCESS_DEFAULTS);
  });
});

describe('post process ownership', () => {
  it('gives each canvas to its oldest claim and hands it on when that claim releases', () => {
    const canvas = {};
    const other = {};
    const first = {};
    const second = {};
    const third = {};
    const listener = vi.fn();
    const unsubscribe = subscribePostProcessOwner(listener);

    expect(getPostProcessOwner(canvas)).toBeNull();
    const releaseFirst = claimPostProcess(canvas, first);
    const releaseSecond = claimPostProcess(canvas, second);
    const releaseThird = claimPostProcess(canvas, third);
    const releaseOther = claimPostProcess(other, second);
    expect(getPostProcessOwner(canvas)).toBe(first);
    // Each canvas (renderer) has its own owner.
    expect(getPostProcessOwner(other)).toBe(second);
    expect(listener).toHaveBeenCalledTimes(4);

    // A waiting claim leaving does not change the owner.
    releaseSecond();
    expect(getPostProcessOwner(canvas)).toBe(first);
    releaseFirst();
    expect(getPostProcessOwner(canvas)).toBe(third);
    // Releasing twice is harmless and does not drop the new owner.
    releaseFirst();
    expect(getPostProcessOwner(canvas)).toBe(third);
    releaseThird();
    expect(getPostProcessOwner(canvas)).toBeNull();
    expect(getPostProcessOwner(other)).toBe(second);
    releaseOther();
    expect(getPostProcessOwner(other)).toBeNull();

    unsubscribe();
    claimPostProcess(canvas, first)();
    expect(listener).toHaveBeenCalledTimes(8);
  });

  it('lets one hook own the canvas at a time and only while enabled', () => {
    const a = renderHook(() => useActivePostProcess(true));
    const b = renderHook(() => useActivePostProcess(true));
    const disabled = renderHook(() => useActivePostProcess(false));
    const claimed = renderHook(() => usePostProcessClaimed());
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(false);
    expect(disabled.result.current).toBe(false);
    expect(claimed.result.current).toBe(true);

    a.unmount();
    expect(b.result.current).toBe(true);
    b.unmount();
    expect(disabled.result.current).toBe(false);
    expect(claimed.result.current).toBe(false);
    expect(getPostProcessOwner(harness.gl)).toBeNull();
  });

  it('mounts one composer however many objects carry an enabled component', () => {
    const first = render(stackElement(componentWith(defaults(), 'a'), 'a'));
    const second = render(stackElement(componentWith({ ...defaults(), bloom: false }, 'b'), 'b'));
    expect(harness.mountedComposers).toBe(1);
    expect(effectNames()).toContain('Bloom');

    // The next object in line takes over, with its own settings.
    first.unmount();
    expect(harness.mountedComposers).toBe(1);
    expect(effectNames()).not.toContain('Bloom');
    second.unmount();
    expect(harness.mountedComposers).toBe(0);
  });

  it('stays off when post-processing is not allowed', () => {
    const view = render(React.createElement(PostProcessAllowedContext.Provider, { value: false }, stackElement(componentWith(defaults()))));
    expect(harness.mountedComposers).toBe(0);
    expect(getPostProcessOwner(harness.gl)).toBeNull();
    view.rerender(React.createElement(PostProcessAllowedContext.Provider, { value: true }, stackElement(componentWith(defaults()))));
    expect(harness.mountedComposers).toBe(1);
    view.unmount();
  });
});

describe('post process stack', () => {
  it('builds the default stack in pipeline order with single-sampled buffers', () => {
    const view = render(stackElement(componentWith(defaults())));
    expect(effectNames()).toEqual(['SunHaze', 'N8AO', 'LightShafts', 'AutoExposure', 'Bloom', 'ToneMapping', 'Vignette', 'SMAA']);
    expect(effectProps('SunHaze')).toMatchObject({ intensity: POST_PROCESS_DEFAULTS.sunHazeIntensity });
    expect(effectProps('LightShafts')).toMatchObject({ intensity: POST_PROCESS_DEFAULTS.lightShaftsIntensity });
    expect(effectProps('AutoExposure')).toMatchObject({ compensation: 0, speed: 1 });
    expect(harness.lastComposer?.multisampling).toBe(0);
    expect(effectProps('ToneMapping')).toMatchObject({ mode: ToneMappingMode.ACES_FILMIC });
    expect(effectProps('N8AO')).toMatchObject({ intensity: POST_PROCESS_DEFAULTS.aoIntensity, aoRadius: POST_PROCESS_DEFAULTS.aoRadius });
    expect(effectProps('Bloom')).toMatchObject({
      mipmapBlur: true, intensity: POST_PROCESS_DEFAULTS.bloomIntensity, luminanceThreshold: POST_PROCESS_DEFAULTS.bloomThreshold,
    });
    view.unmount();
  });

  it('adds depth of field and grading only when they change the image', () => {
    const view = render(stackElement(componentWith({
      ...defaults(), depthOfField: true, focusDistance: 6, bokehScale: 3, saturation: -0.5, contrast: 0.25, brightness: 0,
    })));
    expect(effectNames()).toEqual([
      'SunHaze', 'N8AO', 'DepthOfField', 'LightShafts', 'AutoExposure', 'Bloom', 'ToneMapping', 'HueSaturation', 'BrightnessContrast',
      'Vignette', 'SMAA',
    ]);
    expect(effectProps('DepthOfField')).toMatchObject({ worldFocusDistance: 6, bokehScale: 3 });
    expect(effectProps('HueSaturation')).toMatchObject({ saturation: -0.5 });
    expect(effectProps('BrightnessContrast')).toMatchObject({ contrast: 0.25, brightness: 0 });

    view.rerender(stackElement(componentWith({
      ...defaults(), bloom: false, ambientOcclusion: false, vignette: false, antialias: 'none', toneMapping: 'none',
      sunHaze: false, lightShafts: false, autoExposure: false,
    })));
    // Tone mapping always ends the HDR part; None is a linear clamp that still applies exposure.
    expect(effectNames()).toEqual(['ToneMapping']);
    expect(effectProps('ToneMapping')).toMatchObject({ mode: ToneMappingMode.LINEAR });
    view.unmount();
  });

  it('adds the camera effects and colour work only when they change the image', () => {
    const view = render(stackElement(componentWith({
      ...defaults(), motionBlur: true, motionBlurStrength: 0.8, exposureCompensation: -1, adaptationSpeed: 2,
      temperature: 0.4, tint: -0.1, look: 'cinematic', lookStrength: 0.6, filmGrain: 0.5, chromaticAberration: 0.5,
    })));
    expect(effectNames()).toEqual([
      'SunHaze', 'N8AO', 'LightShafts', 'MotionBlur', 'AutoExposure', 'WhiteBalance', 'Bloom', 'ToneMapping', 'Look', 'Vignette',
      'ChromaticAberration', 'Noise', 'SMAA',
    ]);
    expect(effectProps('MotionBlur')).toMatchObject({ strength: 0.8 });
    expect(effectProps('AutoExposure')).toMatchObject({ compensation: -1, speed: 2 });
    expect(effectProps('WhiteBalance')).toMatchObject({ temperature: 0.4, tint: -0.1 });
    expect(effectProps('Look')).toMatchObject({ look: 'cinematic', strength: 0.6 });
    expect(effectProps('Noise')).toMatchObject({ opacity: 0.3 });

    // A look at no strength, and no grain or fringes, leave nothing in the stack.
    view.rerender(stackElement(componentWith({ ...defaults(), look: 'noir', lookStrength: 0 })));
    expect(effectNames()).not.toContain('Look');
    expect(effectNames()).not.toContain('Noise');
    expect(effectNames()).not.toContain('ChromaticAberration');
    expect(effectNames()).not.toContain('WhiteBalance');
    view.unmount();
  });

  it('maps each tone mapping choice to its postprocessing curve', () => {
    const expected: Record<string, ToneMappingMode> = {
      aces: ToneMappingMode.ACES_FILMIC, agx: ToneMappingMode.AGX, reinhard: ToneMappingMode.REINHARD,
      neutral: ToneMappingMode.NEUTRAL, none: ToneMappingMode.LINEAR,
    };
    const view = render(stackElement(componentWith(defaults())));
    for (const [choice, mode] of Object.entries(expected)) {
      view.rerender(stackElement(componentWith({ ...defaults(), toneMapping: choice })));
      expect(effectProps('ToneMapping')).toMatchObject({ mode });
    }
    view.unmount();
  });

  it('rebuilds occlusion for a new default camera', () => {
    const view = render(stackElement(componentWith(defaults())));
    const occlusion = () => harness.lastComposer?.effects.find(effect => effect.name === 'N8AO');
    const before = occlusion();
    harness.camera = { uuid: 'camera-b' };
    view.rerender(stackElement(componentWith({ ...defaults(), aoIntensity: 3 })));
    const after = occlusion();
    expect(before?.name).toBe('N8AO');
    expect(after?.name).toBe('N8AO');
    expect(after?.key).not.toBe(before?.key);
    expect(after?.props.intensity).toBe(3);
    view.unmount();
  });
});

describe('renderer tone mapping', () => {
  it('switches the renderer curve off while applied and puts back the latest own setting', () => {
    const gl = { toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping, toneMappingExposure: 1 };
    const override = createToneMappingOverride(gl);
    override.apply(1.5);
    expect(gl).toEqual({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1.5 });

    // An exposure edit is the stack's own, not the renderer's.
    override.apply(2);
    expect(gl.toneMappingExposure).toBe(2);

    // R3F re-applying the canvas gl props between frames is undone and remembered.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 0.8;
    override.apply(2);
    expect(gl).toEqual({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 2 });

    override.restore();
    expect(gl).toEqual({ toneMapping: THREE.AgXToneMapping, toneMappingExposure: 0.8 });
  });

  it('restores the Auvra convention when another composer had already switched the renderer off', () => {
    const gl = { toneMapping: THREE.NoToneMapping as THREE.ToneMapping, toneMappingExposure: 1 };
    const override = createToneMappingOverride(gl);
    override.apply(1.2);
    override.restore();
    expect(gl).toEqual({ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 });
  });

  it('holds the renderer off every frame while the stack is mounted and restores it on unmount', () => {
    const view = render(stackElement(componentWith({ ...defaults(), exposure: 1.3 })));
    step();
    expect(harness.gl).toEqual({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1.3 });

    harness.gl.toneMapping = THREE.ACESFilmicToneMapping;
    harness.gl.toneMappingExposure = 1;
    step();
    expect(harness.gl).toEqual({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1.3 });

    view.rerender(stackElement(componentWith({ ...defaults(), exposure: 0.7 })));
    step();
    expect(harness.gl.toneMappingExposure).toBe(0.7);

    view.unmount();
    expect(harness.gl).toEqual({ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 });
    expect(harness.frames.size).toBe(0);
  });
});
