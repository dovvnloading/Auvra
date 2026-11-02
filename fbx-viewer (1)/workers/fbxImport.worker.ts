/// <reference lib="webworker" />

import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { buildImportedGlb, type DecodeImage, type DecodeLegacyImage } from '../utils/fbxImport/importedModel';
import { instantiateImporter, runNativeImport, type ModelFileReport, type NativeImportOptions } from '../utils/fbxImport/nativeImporter';

// Despite the file name this worker converts every format the native importer reads (FBX and OBJ)
// into a GLB handoff for the renderer thread, and describes such a file for the import dialog.
type ImportFormat = 'fbx' | 'obj';
export type ModelConvertOptions = Pick<NativeImportOptions, 'animation' | 'morphTargets' | 'tangents' | 'recomputeNormals' | 'skin' | 'meshes' | 'sampleRate' | 'keyThreshold' | 'smoothingAngle'>;
type ImportRequest =
  | { type: 'parse'; buffer: ArrayBuffer; format?: ImportFormat; name?: string; options?: ModelConvertOptions }
  | { type: 'inspect'; buffer: ArrayBuffer; format?: ImportFormat; name?: string };
type ImportPhase = 'fbx_structure_parse' | 'model_structure_parse' | 'embedded_texture_decode' | 'runtime_asset_construction' | 'runtime_asset_transfer';
type ImportProgress = { type: 'progress'; progress: number; phase: ImportPhase; workerState: 'parsing' | 'decoding' | 'constructing' | 'transferring' };
type ImportComplete = { type: 'complete'; glb: ArrayBuffer; itemCount: number; clipCount: number; missingTextures: string[]; metresPerUnit: number | null; report: ModelFileReport };
type InspectComplete = { type: 'inspected'; report: ModelFileReport };
type ImportFailure = { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

const report = (progress: number, phase: ImportPhase, workerState: ImportProgress['workerState']): void => {
  scope.postMessage({ type: 'progress', progress, phase, workerState } satisfies ImportProgress);
};

const IMPORTER_URL = new URL('../vendor/fbxImporter/fbxImporter.wasm', import.meta.url);

const loadImporter = async () => {
  const response = await fetch(IMPORTER_URL);
  if (!response.ok) throw new Error(`The model importer could not be loaded (${response.status}).`);
  return instantiateImporter(await WebAssembly.compile(await response.arrayBuffer()));
};

/** An image's pixels with straight alpha, as far as a 2D canvas keeps it. */
const decodeImage: DecodeImage = async (bytes, mimeType) => {
  const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No canvas to read an image with.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
};

/** Formats a browser cannot read but art tools still write. */
const decodeLegacyImage: DecodeLegacyImage = (bytes, kind) => {
  const buffer = bytes.slice().buffer;
  try {
    const decoded = kind === 'tga' ? new TGALoader().parse(buffer) : kind === 'tiff' ? new TIFFLoader().parse(buffer) : null;
    const { data, width, height } = (decoded ?? {}) as { data?: Uint8Array; width?: number; height?: number };
    return data && width && height ? { data, width, height } : null;
  } catch {
    return null;
  }
};

scope.onmessage = async (event: MessageEvent<ImportRequest>) => {
  const request = event.data;
  if ((request?.type !== 'parse' && request?.type !== 'inspect') || !(request.buffer instanceof ArrayBuffer)) return;
  const format: ImportFormat = request.format === 'obj' ? 'obj' : 'fbx';
  try {
    if (format === 'obj') report(0.12, 'model_structure_parse', 'parsing');
    else report(0.12, 'fbx_structure_parse', 'parsing');
    const importer = await loadImporter();
    const fileName = request.name || `model.${format}`;
    if (request.type === 'inspect') {
      const native = runNativeImport(importer, request.buffer, fileName, { inspect: true, obj: format === 'obj' });
      const inspected = native.report;
      native.close();
      scope.postMessage({ type: 'inspected', report: inspected } satisfies InspectComplete);
      return;
    }
    const native = runNativeImport(importer, request.buffer, fileName, { ...request.options, obj: format === 'obj' });
    if (format === 'obj' && native.report.triangles === 0) throw new Error('The OBJ file contains no mesh geometry.');
    report(0.48, 'embedded_texture_decode', 'decoding');
    report(0.64, 'runtime_asset_construction', 'constructing');
    const built = await buildImportedGlb(native, { decode: decodeImage, decodeLegacy: decodeLegacyImage });
    const itemCount = native.document.nodes.length;
    native.close();
    report(0.82, 'runtime_asset_transfer', 'transferring');
    const metresPerUnit = built.report.metresPerUnit > 0 ? built.report.metresPerUnit : null;
    scope.postMessage({
      type: 'complete', glb: built.glb, itemCount, clipCount: built.report.clips.length, missingTextures: built.missingTextures, metresPerUnit, report: built.report,
    } satisfies ImportComplete, [built.glb]);
  } catch (error) {
    const message = error instanceof Error ? error.message : `Background ${format.toUpperCase()} processing failed`;
    scope.postMessage({ type: 'error', message } satisfies ImportFailure);
  }
};
