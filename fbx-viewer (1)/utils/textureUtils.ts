
import * as THREE from 'three';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { textureSourceImage } from './textureCompression/compressTextures';

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

  const texture = foundTexture as THREE.Texture | null;
  // A compressed texture keeps the image it was made from; that is what is read here.
  const source = texture ? textureSourceImage(texture) : null;
  if (!texture || !source) return null;

  try {
    const image = source as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
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

/** The texture maps a model's materials draw with, each once, named for the first material using it. */
export const listModelTextures = (object: THREE.Object3D): { uuid: string; name: string; texture: THREE.Texture }[] => {
    const maps = new Map<string, { uuid: string; name: string; texture: THREE.Texture }>();
    object.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const material = (child as THREE.Mesh).material;
        for (const candidate of Array.isArray(material) ? material : [material]) {
            const map = (candidate as THREE.MeshStandardMaterial).map;
            if (map && !maps.has(map.uuid) && textureSourceImage(map)) {
                maps.set(map.uuid, { uuid: map.uuid, name: candidate.name || map.name || 'Untitled texture', texture: map });
            }
        }
    });
    return Array.from(maps.values());
};

/** A texture's picture as a data URL, or null when it cannot be read. */
export const textureToDataUrl = (texture: THREE.Texture): string | null => {
    const image = textureSourceImage(texture) as HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
    if (!image) return null;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
    } catch (error) {
        frontendDiagnostics.failure('texture_extract_failed', error);
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
                if (map && textureSourceImage(map)) {
                    // Avoid duplicates
                    if (!uniqueTextures.has(map.uuid)) {
                        try {
                            const image = textureSourceImage(map) as HTMLImageElement;
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
