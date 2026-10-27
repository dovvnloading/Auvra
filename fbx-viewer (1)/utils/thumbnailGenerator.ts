
import * as THREE from 'three';
import { captureRenderer } from '../renderer/capture';

/**
 * Generates a base64 image thumbnail through the owned capture service.
 * The synchronous signature is retained for existing model-loading callers.
 * A model whose thumbnail cannot be drawn still imports and loads without one;
 * the capture service has already reported the failure.
 */
export const generateThumbnail = (object: THREE.Object3D, width = 256, height = 256): string | undefined => {
  try {
    return captureRenderer.captureThumbnail(object, width, height);
  } catch {
    return undefined;
  }
};
