import './instrument';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { advance, useThree, type RootState } from '@react-three/fiber';
import { gpuBytes, realNow, resetClock, seedChance, stepClock, virtualSeconds, webGpuBytes, webGpuWaiting } from './instrument';
import { AuvraCanvas, readRequestedRendererBackend } from '../../renderer/AuvraCanvas';
import { sourceEditPixels } from './sourceEditPixels';
import { deviceLossPixels } from './deviceLossPixels';
import { acceptSoftwareAdapter, acquireGpuCore, releaseIdleGpuCore } from '../../renderer/gpu/device';
import { isGpuRenderer } from '../../renderer/gpu/frame';
import type { GpuRenderer } from '../../renderer/gpu/GpuRenderer';
import { SCENES, type SceneSteps, type VisualScene } from './scenes';
import { textureGraphScene } from './textureGraphScene';
import { textureGpu } from '../../texturing/gpu/textureGpu';
import { webgpuTexturing, type WgpuDevice } from '../../texturing/gpu/webgpuTexturing';
import { checkMaterialCompression, readMaterialTexture } from './materialCompression';

/**
 * The page behind scripts/rendering/run.mjs: mounts one scene at a time, steps it a fixed number of frames on a clock
 * of its own, and hands back its picture and what it cost. `?renderer=webgl2` or `?renderer=webgpu` says which renderer
 * draws; on WebGPU each frame also waits for what the renderer started in the background (pipelines, read-backs, the
 * cluster worker), so what a frame sees does not depend on how fast the machine is.
 */

const FRAME_MS = 1000 / 60;
const TIMED_FRAMES = 20;
const WAIT_LIMIT_MS = 180_000;

const onWebGpu = readRequestedRendererBackend() === 'webgpu';
const renderer = onWebGpu ? 'webgpu' : 'webgl2';
// The machines that take these pictures have only a software GPU.
if (onWebGpu) acceptSoftwareAdapter();

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const StateProbe: React.FC<{ onState: (state: RootState) => void }> = ({ onState }) => {
  const state = useThree();
  useEffect(() => onState(state), [onState, state]);
  return null;
};

const until = async (condition: () => boolean) => {
  const start = realNow();
  while (!condition()) {
    if (realNow() - start > WAIT_LIMIT_MS) throw new Error('A scene waited too long on its GPU work');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const settled = () => until(() => webGpuWaiting() === 0);

const finish = async (state: RootState): Promise<void> => {
  // Makes this frame's work happen now, so the time it took is the time it cost.
  if (isGpuRenderer(state.gl)) {
    const { core } = state.gl as unknown as GpuRenderer;
    try {
      await core.device.queue.onSubmittedWorkDone();
    } catch (error) {
      // A lost device fails everything after it: what it said when it went is the useful part.
      const lost = await Promise.race([core.lost, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
      throw new Error(`The WebGPU device stopped (${lost ? `${lost.reason}: ${lost.message}` : String(error)})`);
    }
    return;
  }
  state.gl.getContext().readPixels(0, 0, 1, 1, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE, new Uint8Array(4));
};

const stepsFor = (state: () => RootState): SceneSteps => {
  const step = () => {
    stepClock(FRAME_MS);
    advance(virtualSeconds());
  };
  return {
    state,
    async frames(count: number) {
      for (let frame = 0; frame < count; frame++) {
        step();
        await nextTask();
        if (onWebGpu) await settled();
      }
    },
    until,
  };
};

// Sample the actual cooking context after the screenshot and timed frames, before the device is released.
const materialCompression = async (state: RootState) => {
  if (isGpuRenderer(state.gl)) {
    const { device, adapter } = state.gl.core;
    const gpu = webgpuTexturing(device as unknown as WgpuDevice);
    const info = adapter.info;
    return { backend: 'webgpu', vendor: info?.vendor || null, renderer: info?.description || null,
      architecture: info?.architecture || null, device: info?.device || null,
      formats: await checkMaterialCompression('webgpu', feature => device.features.has(feature),
        (_format, texture) => readMaterialTexture(gpu, texture)) };
  }
  const gpu = textureGpu();
  const gl = gpu.renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return { backend: 'webgl2', vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    formats: await checkMaterialCompression('webgl2', feature => Boolean(gl.getExtension(feature)),
      (_format, texture) => readMaterialTexture(gpu, texture)) };
};

const capture = async (name: string) => {
  const scene: VisualScene | undefined = SCENES[name];
  if (!scene) throw new Error(`No scene called ${name}`);
  seedChance(0x2f6e2b1);
  // A WebGPU scene starts on a device of its own (below) at the same moment, so its picture is the same whatever ran
  // before it: the traced light's noise follows the clock.
  if (onWebGpu) resetClock();
  const stage = document.getElementById('stage')!;
  const root = createRoot(stage);
  const started = realNow();
  let latest: RootState | null = null;
  root.render(
    <AuvraCanvas surfaceId={`visual-${name}`} role="runtime" backend={renderer} shadows dpr={1} frameloop="never" camera={scene.camera}>
      <StateProbe onState={(state) => { latest = state; }} />
      <scene.Scene />
    </AuvraCanvas>,
  );
  const steps = stepsFor(() => latest!);
  await steps.until(() => latest !== null && latest.size.width > 0);
  // A renderer that could not start leaves the canvas to the other one, which would be a picture of the wrong thing.
  if (isGpuRenderer(latest!.gl) !== onWebGpu) {
    const why = onWebGpu ? ` (${(await acquireGpuCore()).reason ?? 'its frames failed'})` : '';
    throw new Error(`${name} was not drawn on ${renderer}${why}`);
  }
  await nextTask();
  await steps.frames(1);
  await finish(latest!);
  const loadMs = realNow() - started;

  await (scene.settle?.(steps) ?? steps.frames(scene.frames ?? 30));

  const timedFrom = realNow();
  await steps.frames(TIMED_FRAMES);
  await finish(latest!);
  const frameMs = (realNow() - timedFrom) / TIMED_FRAMES;

  const state = latest! as RootState;
  // Each pass is its own render to three, and the frame is all of them.
  state.gl.info.autoReset = false;
  state.gl.info.reset();
  stepClock(FRAME_MS);
  advance(virtualSeconds());
  // Read in the same task as the frame: a WebGPU canvas shows its picture only until the task ends.
  const png = state.gl.domElement.toDataURL('image/png');
  // WebGPU draws from lists the GPU makes, so what it drew is not known here.
  const { calls, triangles } = onWebGpu ? { calls: null, triangles: null } : state.gl.info.render;
  const { geometries, textures } = state.gl.info.memory;
  const programs = state.gl.info.programs?.length ?? 0;
  const bytes = onWebGpu ? webGpuBytes() : gpuBytes(state.gl.getContext() as WebGL2RenderingContext);
  const cookBenchmark = name === 'texture-graph' ? textureGraphScene.benchmark : null;
  const standardCook = name === 'texture-graph' ? textureGraphScene.cook : null;
  const cookProblem = name === 'texture-graph' ? textureGraphScene.problem : null;
  const bc1Parity = name === 'texture-graph' && onWebGpu ? textureGraphScene.bc1Parity : null;
  const verifyTextures = name === 'texture-graph' && !new URLSearchParams(window.location.search).has('textureBench');
  const compression = verifyTextures ? await materialCompression(state) : null;
  const sourceEdit = verifyTextures ? await sourceEditPixels(isGpuRenderer(state.gl)
    ? webgpuTexturing(state.gl.core.device as unknown as WgpuDevice) : textureGpu()) : null;
  if (onWebGpu) await settled();
  root.unmount();
  // Lets the canvas and what it holds go before the next scene.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Each scene starts on a device of its own: what one leaves on the device would otherwise show in the next one's picture.
  if (onWebGpu) {
    const released = realNow();
    while (!(await releaseIdleGpuCore())) {
      if (realNow() - released > 10_000) throw new Error(`${name} still held the WebGPU device after it was taken down`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const deviceLoss = onWebGpu && verifyTextures
    ? await deviceLossPixels() : null;
  return { png, numbers: { ...(deviceLoss ? { deviceLoss } : {}), loadMs, frameMs, calls, triangles, geometries, textures, programs, gpuBytes: bytes,
    ...(cookBenchmark ? { textureCook: cookBenchmark, textureCookProblem: cookProblem } : {}),
    ...(standardCook ? { graphCook: standardCook } : {}),
    ...(bc1Parity ? { bc1Parity } : {}),
    ...(compression ? { materialCompression: compression } : {}),
    ...(sourceEdit ? { sourceEdit } : {}),
  } };
};

const toPixels = async (url: string): Promise<ImageData> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
};

/** Compares two pictures: how many pixels differ by more than `tolerance`, by how much, and a picture of where. */
const compare = async (actualUrl: string, referenceUrl: string, tolerance: number) => {
  const [actual, reference] = await Promise.all([toPixels(actualUrl), toPixels(referenceUrl)]);
  if (actual.width !== reference.width || actual.height !== reference.height) return { sameSize: false, share: 1, mean: 255, worst: 255, diff: '' };
  const canvas = document.createElement('canvas');
  canvas.width = actual.width;
  canvas.height = actual.height;
  const context = canvas.getContext('2d')!;
  const diff = context.createImageData(actual.width, actual.height);
  let differing = 0;
  let sum = 0;
  let worst = 0;
  for (let at = 0; at < actual.data.length; at += 4) {
    const delta = Math.max(Math.abs(actual.data[at] - reference.data[at]), Math.abs(actual.data[at + 1] - reference.data[at + 1]), Math.abs(actual.data[at + 2] - reference.data[at + 2]));
    sum += delta;
    worst = Math.max(worst, delta);
    if (delta > tolerance) differing++;
    diff.data[at] = delta > tolerance ? 255 : delta * 8;
    diff.data[at + 1] = delta > tolerance ? 0 : delta * 8;
    diff.data[at + 2] = delta > tolerance ? 64 : delta * 8;
    diff.data[at + 3] = 255;
  }
  context.putImageData(diff, 0, 0);
  const pixels = actual.width * actual.height;
  return { sameSize: true, share: differing / pixels, mean: sum / pixels, worst, diff: canvas.toDataURL('image/png') };
};

(window as unknown as { auvraVisual: unknown }).auvraVisual = { names: Object.keys(SCENES), capture, compare };
