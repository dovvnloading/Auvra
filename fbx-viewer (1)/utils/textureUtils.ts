
import * as THREE from 'three';
import { frontendDiagnostics } from '../diagnostics/runtime';

export interface ExtractedTexture {
    uuid: string;
    name: string; // Material Name or Map Name
    image: HTMLImageElement | HTMLCanvasElement | ImageBitmap;
    base64: string;
}

/**
 * Extracts the first found diffuse map from a model object and returns it as a base64 string.
 */
export const extractTextureFromModel = (object: THREE.Object3D): string | null => {
  let foundTexture: THREE.Texture | null = null;

  object.traverse((child) => {
    if (foundTexture) return; // Stop if found
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          if ((m as any).map) {
            foundTexture = (m as any).map;
            break;
          }
        }
      } else {
        if ((mat as any).map) {
          foundTexture = (mat as any).map;
        }
      }
    }
  });

  if (!foundTexture || !foundTexture.image) return null;

  try {
    const image = foundTexture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    
    ctx.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (e) {
    frontendDiagnostics.failure('texture_extract_failed', e);
    return null;
  }
};

/**
 * Scans the model for ALL unique textures (diffuse maps).
 * Useful for multi-material meshes.
 */
export const extractAllTexturesFromModel = (object: THREE.Object3D): ExtractedTexture[] => {
    const uniqueTextures = new Map<string, ExtractedTexture>();

    object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

            materials.forEach(mat => {
                const map = (mat as any).map as THREE.Texture;
                if (map && map.image) {
                    // Avoid duplicates
                    if (!uniqueTextures.has(map.uuid)) {
                        try {
                            const image = map.image as HTMLImageElement;
                            const canvas = document.createElement('canvas');
                            canvas.width = image.width;
                            canvas.height = image.height;
                            const ctx = canvas.getContext('2d');
                            if (ctx) {
                                ctx.drawImage(image, 0, 0);
                                const base64 = canvas.toDataURL('image/png');
                                
                                uniqueTextures.set(map.uuid, {
                                    uuid: map.uuid,
                                    name: mat.name || map.name || 'Untitled Texture',
                                    image: image,
                                    base64: base64
                                });
                            }
                        } catch(e) {
                            frontendDiagnostics.failure('material_texture_extract_failed', e);
                        }
                    }
                }
            });
        }
    });

    return Array.from(uniqueTextures.values());
};
