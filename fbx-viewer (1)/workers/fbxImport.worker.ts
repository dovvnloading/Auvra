/// <reference lib="webworker" />

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeOpacity } from '../utils/processing/opacityMaps';

// Despite the file name this worker converts every format whose loader parses
// synchronously (FBX and OBJ) into a GLB handoff for the renderer thread.
type ImportFormat = 'fbx' | 'obj';
type ImportRequest = { type: 'parse'; buffer: ArrayBuffer; format?: ImportFormat };
type ImportPhase = 'fbx_structure_parse' | 'model_structure_parse' | 'embedded_texture_decode' | 'runtime_asset_construction' | 'runtime_asset_transfer';
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

/**
 * glTF has no opacity map: a material's opacity lives in its base colour's alpha, so the GLB
 * handoff would drop FBXLoader's alphaMap and draw cut-out cards (hair, eyelashes) as solid quads.
 * Bake each opacity map into the alpha of a copy of the material's colour map. A material marked
 * transparent with neither an opacity map nor partial opacity draws opaque (FBX often marks them).
 */
const bakeOpacityMaps = (object: THREE.Object3D, bitmaps: ImageBitmap[]): void => {
  const baked = new Map<string, THREE.Texture>();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshPhongMaterial[]) {
      const opacity = material.alphaMap;
      const mask = opacity?.image as ImageBitmap | null | undefined;
      if (!opacity || !mask) {
        if (material.transparent && material.opacity >= 1) material.transparent = false;
        continue;
      }
      const colour = material.map;
      const key = `${colour?.uuid ?? ''}:${opacity.uuid}`;
      let texture = baked.get(key);
      if (!texture) {
        const image = colour?.image as ImageBitmap | null | undefined;
        const width = image?.width || mask.width;
        const height = image?.height || mask.height;
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) continue;
        context.drawImage(mask, 0, 0, width, height);
        const maskPixels = context.getImageData(0, 0, width, height).data;
        context.clearRect(0, 0, width, height);
        if (image) {
          context.drawImage(image, 0, 0, width, height);
        } else {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
        }
        const pixels = context.getImageData(0, 0, width, height);
        writeOpacity(pixels.data, maskPixels);
        context.putImageData(pixels, 0, 0);
        const bitmap = canvas.transferToImageBitmap();
        bitmaps.push(bitmap);
        // A clone shares its source image; the baked one gets its own.
        texture = (colour ?? opacity).clone();
        texture.source = new THREE.Source(bitmap);
        if (!colour) texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        baked.set(key, texture);
      }
      material.map = texture;
      material.alphaMap = null;
      material.transparent = true;
    }
  });
};

/**
 * OBJ carries no PBR data (its .mtl sidecar is not part of a single-file
 * import), and GLTFExporter would write OBJLoader's Phong defaults as
 * half-metallic. Hand over matte Standard materials with smooth normals
 * instead, so faces without authored normals still shade.
 */
const prepareObjMeshes = (object: THREE.Object3D): number => {
  let meshCount = 0;
  const toStandard = (material: THREE.Material): THREE.Material => {
    const phong = material as THREE.MeshPhongMaterial;
    if (!phong.isMeshPhongMaterial) return material;
    const standard = new THREE.MeshStandardMaterial({
      name: phong.name,
      color: phong.color,
      vertexColors: phong.vertexColors,
      flatShading: phong.flatShading,
      roughness: 0.8,
      metalness: 0,
    });
    phong.dispose();
    return standard;
  };
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount += 1;
    if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toStandard) : toStandard(mesh.material);
  });
  return meshCount;
};

scope.onmessage = async (event: MessageEvent<ImportRequest>) => {
  if (event.data?.type !== 'parse' || !(event.data.buffer instanceof ArrayBuffer)) return;
  const format: ImportFormat = event.data.format === 'obj' ? 'obj' : 'fbx';
  let bitmaps: ImageBitmap[] = [];
  try {
    let object: THREE.Group;
    if (format === 'obj') {
      report(0.12, 'model_structure_parse', 'parsing');
      object = new OBJLoader().parse(new TextDecoder().decode(event.data.buffer));
      if (prepareObjMeshes(object) === 0) throw new Error('The OBJ file contains no mesh geometry.');
    } else {
      report(0.12, 'fbx_structure_parse', 'parsing');
      object = new FBXLoader().parse(event.data.buffer, '');
      report(0.48, 'embedded_texture_decode', 'decoding');
      await Promise.all(pendingImages);
      bitmaps = replaceWorkerImages(object);
      bakeOpacityMaps(object, bitmaps);
    }
    report(0.64, 'runtime_asset_construction', 'constructing');
    const exported = await new GLTFExporter().parseAsync(object, {
      binary: true,
      animations: object.animations || [],
      onlyVisible: false,
      trs: false,
    });
    if (!(exported instanceof ArrayBuffer)) throw new Error(`${format.toUpperCase()} worker did not produce a binary runtime asset`);
    let itemCount = 0;
    object.traverse(() => { itemCount += 1; });
    report(0.82, 'runtime_asset_transfer', 'transferring');
    scope.postMessage({ type: 'complete', glb: exported, itemCount, clipCount: object.animations?.length ?? 0 } satisfies ImportComplete, [exported]);
  } catch (error) {
    const message = error instanceof Error ? error.message : `Background ${format.toUpperCase()} processing failed`;
    scope.postMessage({ type: 'error', message } satisfies ImportFailure);
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
    for (const url of createdUrls) URL.revokeObjectURL(url);
  }
};
