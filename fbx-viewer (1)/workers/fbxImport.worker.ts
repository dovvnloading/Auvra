/// <reference lib="webworker" />

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

type ImportRequest = { type: 'parse'; buffer: ArrayBuffer };
type ImportPhase = 'fbx_structure_parse' | 'embedded_texture_decode' | 'runtime_asset_construction' | 'runtime_asset_transfer';
type ImportProgress = { type: 'progress'; progress: number; phase: ImportPhase; workerState: 'parsing' | 'decoding' | 'constructing' | 'transferring' };
type ImportComplete = { type: 'complete'; glb: ArrayBuffer; itemCount: number; clipCount: number };
type ImportFailure = { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const pendingImages: Promise<void>[] = [];
const createdUrls: string[] = [];
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob: Blob | MediaSource): string => {
  const url = createObjectURL(blob);
  createdUrls.push(url);
  return url;
};

class WorkerImage {
  width = 0;
  height = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  bitmap: ImageBitmap | null = null;
  private value = '';
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  get src(): string { return this.value; }

  set src(value: string) {
    this.value = value;
    const load = fetch(value)
      .then((response) => {
        if (!response.ok) throw new Error(`Embedded texture read failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        this.bitmap = bitmap;
        this.width = this.naturalWidth = bitmap.width;
        this.height = this.naturalHeight = bitmap.height;
        this.emit('load');
      })
      .catch(() => this.emit('error'));
    pendingImages.push(load);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) || new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string): void {
    const event = { type, target: this, currentTarget: this } as unknown as Event;
    for (const listener of this.listeners.get(type) || []) {
      if (typeof listener === 'function') listener.call(this as unknown as EventTarget, event);
      else listener.handleEvent(event);
    }
  }
}

// FBXLoader's image path assumes a Window document. The worker keeps the
// expensive FBX parse isolated and supplies only the narrow image/canvas
// primitives needed for embedded textures and the transient GLB handoff.
const workerGlobal = globalThis as unknown as Record<string, unknown>;
workerGlobal.window = globalThis;
workerGlobal.HTMLImageElement = WorkerImage;
workerGlobal.HTMLCanvasElement = OffscreenCanvas;
workerGlobal.document = {
  createElementNS: (_namespace: string, name: string) => name === 'img'
    ? new WorkerImage()
    : new OffscreenCanvas(1, 1),
  createElement: (name: string) => name === 'img'
    ? new WorkerImage()
    : new OffscreenCanvas(1, 1),
};

const report = (progress: number, phase: ImportPhase, workerState: ImportProgress['workerState']): void => {
  scope.postMessage({ type: 'progress', progress, phase, workerState } satisfies ImportProgress);
};

const replaceWorkerImages = (object: THREE.Object3D): ImageBitmap[] => {
  const bitmaps: ImageBitmap[] = [];
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (!material) return;
    for (const candidate of (Array.isArray(material) ? material : [material])) {
      for (const value of Object.values(candidate)) {
        const texture = value as THREE.Texture;
        const image = texture?.isTexture ? texture.image as WorkerImage | undefined : undefined;
        if (!(image instanceof WorkerImage)) continue;
        if (image.bitmap) {
          texture.image = image.bitmap;
          texture.needsUpdate = true;
          bitmaps.push(image.bitmap);
        } else {
          texture.image = null;
        }
      }
    }
  });
  return bitmaps;
};

scope.onmessage = async (event: MessageEvent<ImportRequest>) => {
  if (event.data?.type !== 'parse' || !(event.data.buffer instanceof ArrayBuffer)) return;
  let bitmaps: ImageBitmap[] = [];
  try {
    report(0.12, 'fbx_structure_parse', 'parsing');
    const object = new FBXLoader().parse(event.data.buffer, '');
    report(0.48, 'embedded_texture_decode', 'decoding');
    await Promise.all(pendingImages);
    bitmaps = replaceWorkerImages(object);
    report(0.64, 'runtime_asset_construction', 'constructing');
    const exported = await new GLTFExporter().parseAsync(object, {
      binary: true,
      animations: object.animations || [],
      onlyVisible: false,
      trs: false,
    });
    if (!(exported instanceof ArrayBuffer)) throw new Error('FBX worker did not produce a binary runtime asset');
    let itemCount = 0;
    object.traverse(() => { itemCount += 1; });
    report(0.82, 'runtime_asset_transfer', 'transferring');
    scope.postMessage({ type: 'complete', glb: exported, itemCount, clipCount: object.animations?.length ?? 0 } satisfies ImportComplete, [exported]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Background FBX processing failed';
    scope.postMessage({ type: 'error', message } satisfies ImportFailure);
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
    for (const url of createdUrls) URL.revokeObjectURL(url);
  }
};
