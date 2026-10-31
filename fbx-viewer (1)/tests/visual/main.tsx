import './instrument';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { advance, useThree, type RootState } from '@react-three/fiber';
import { gpuBytes, realNow, seedChance, stepClock, virtualSeconds } from './instrument';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { SCENES, type SceneSteps, type VisualScene } from './scenes';

/**
 * The page behind scripts/rendering/run.mjs: mounts one scene at a time, steps it a fixed number of frames on a clock
 * of its own, and hands back its picture and what it cost.
 */

const FRAME_MS = 1000 / 60;
const TIMED_FRAMES = 20;
const WAIT_LIMIT_MS = 180_000;

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const StateProbe: React.FC<{ onState: (state: RootState) => void }> = ({ onState }) => {
  const state = useThree();
  useEffect(() => onState(state), [onState, state]);
  return null;
};

const finish = (state: RootState): void => {
  // Makes this frame's work happen now, so the time it took is the time it cost.
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
      }
    },
    async until(condition: () => boolean) {
      const start = realNow();
      while (!condition()) {
        if (realNow() - start > WAIT_LIMIT_MS) throw new Error('A scene waited too long on its GPU work');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
};

const capture = async (name: string) => {
  const scene: VisualScene | undefined = SCENES[name];
  if (!scene) throw new Error(`No scene called ${name}`);
  seedChance(0x2f6e2b1);
  const stage = document.getElementById('stage')!;
  const root = createRoot(stage);
  const bytesBefore = gpuBytes();
  const started = realNow();
  let latest: RootState | null = null;
  root.render(
    <AuvraCanvas surfaceId={`visual-${name}`} role="runtime" shadows dpr={1} frameloop="never" camera={scene.camera}>
      <StateProbe onState={(state) => { latest = state; }} />
      <scene.Scene />
    </AuvraCanvas>,
  );
  const steps = stepsFor(() => latest!);
  await steps.until(() => latest !== null && latest.size.width > 0);
  await nextTask();
  await steps.frames(1);
  finish(latest!);
  const loadMs = realNow() - started;

  await (scene.settle?.(steps) ?? steps.frames(scene.frames ?? 30));

  const timedFrom = realNow();
  await steps.frames(TIMED_FRAMES);
  finish(latest!);
  const frameMs = (realNow() - timedFrom) / TIMED_FRAMES;

  const state = latest! as RootState;
  // Each pass is its own render to three, and the frame is all of them.
  state.gl.info.autoReset = false;
  state.gl.info.reset();
  stepClock(FRAME_MS);
  advance(virtualSeconds());
  const png = state.gl.domElement.toDataURL('image/png');
  const { calls, triangles } = state.gl.info.render;
  const { geometries, textures } = state.gl.info.memory;
  const programs = state.gl.info.programs?.length ?? 0;
  const bytes = gpuBytes() - bytesBefore;
  root.unmount();
  // Lets the canvas and what it holds go before the next scene.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { png, numbers: { loadMs, frameMs, calls, triangles, geometries, textures, programs, gpuBytes: bytes } };
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
