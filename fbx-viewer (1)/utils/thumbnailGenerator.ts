
import * as THREE from 'three';
import { captureRenderer } from '../renderer/capture';

/**
 * Generates a base64 image thumbnail through the owned capture service.
 * The synchronous signature is retained for existing model-loading callers.
 */
export const generateThumbnail = (object: THREE.Object3D, width = 256, height = 256): string =>
  captureRenderer.captureThumbnail(object, width, height);
