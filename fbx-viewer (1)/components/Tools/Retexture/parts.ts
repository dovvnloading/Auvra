import * as THREE from 'three';
import { textureSourceImage } from '../../../utils/textureCompression/compressTextures';
import { frontendDiagnostics } from '../../../diagnostics/runtime';

export type PartMaterial = THREE.Material & { map?: THREE.Texture | null; color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number };

/** What can be painted on its own: the materials that draw with one texture map, or one material with none. */
export interface ModelPart {
  id: string;
  /** For people: "Shoes", where the file says "Shoesmat". */
  name: string;
  rawName: string;
  materials: PartMaterial[];
  /** The names a saved texture is recorded under on the model. */
  materialNames: string[];
  texture: THREE.Texture | null;
}

const NAME_PREFIX = /^(?:material|mat|mtl|mi|m)[_\-. ]+/i;
const NAME_SUFFIX = /[_\-. ]*(?:material|mat|mtl)$/i;
const NAME_COPY = /[._ ]\d{3}$/;

/** A material's name as a person would say it, dropping what exporters add. Falls back to the name as it is. */
export const partDisplayName = (raw: string): string => {
  const spaced = (text: string) => text.replace(/[_\-.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const stripped = spaced(raw.replace(NAME_COPY, '').replace(NAME_PREFIX, '').replace(NAME_SUFFIX, ''));
  const name = /[a-z]/i.test(stripped) ? stripped : spaced(raw);
  return name ? name[0].toUpperCase() + name.slice(1) : 'Surface';
};

const readable = (texture: THREE.Texture | null | undefined): boolean => Boolean(texture && textureSourceImage(texture));

/** A model's parts in the order it draws them. Names that come out the same are numbered. */
export const listModelParts = (object: THREE.Object3D): ModelPart[] => {
  const parts = new Map<string, ModelPart>();
  const seen = new Set<string>();
  object.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const material = (child as THREE.Mesh).material;
    for (const candidate of (Array.isArray(material) ? material : [material]) as PartMaterial[]) {
      if (seen.has(candidate.uuid)) continue;
      seen.add(candidate.uuid);
      const map = readable(candidate.map) ? candidate.map! : null;
      const id = map ? map.uuid : candidate.uuid;
      const existing = parts.get(id);
      if (existing) {
        existing.materials.push(candidate);
        if (candidate.name && !existing.materialNames.includes(candidate.name)) existing.materialNames.push(candidate.name);
        continue;
      }
      const rawName = candidate.name || map?.name || '';
      parts.set(id, {
        id,
        rawName,
        name: rawName ? partDisplayName(rawName) : 'Surface',
        materials: [candidate],
        materialNames: candidate.name ? [candidate.name] : [],
        texture: map,
      });
    }
  });
  const list = Array.from(parts.values());
  const uses = new Map<string, number>();
  for (const part of list) {
    const count = (uses.get(part.name) ?? 0) + 1;
    uses.set(part.name, count);
    if (count > 1) part.name = `${part.name} ${count}`;
  }
  return list;
};

/** The part a hit on a mesh landed on. */
export const partOfHit = <T extends ModelPart>(parts: readonly T[], mesh: THREE.Object3D, materialIndex?: number): T | null => {
  const material = (mesh as THREE.Mesh).material;
  const materials = Array.isArray(material) ? material : [material];
  const hit = materials[materialIndex ?? 0] ?? materials[0];
  return parts.find((part) => part.materials.includes(hit as PartMaterial)) ?? null;
};

const GLOW = new THREE.Color('#f08a3c');
const glowing = new WeakMap<PartMaterial, { color: THREE.Color; intensity: number }>();

/** Lights a part up in the accent colour, or stops: shows on the model which part is meant. */
export const setPartGlow = (part: ModelPart, on: boolean): void => {
  for (const material of part.materials) {
    if (!material.emissive) continue;
    const saved = glowing.get(material);
    if (on && !saved) {
      glowing.set(material, { color: material.emissive.clone(), intensity: material.emissiveIntensity ?? 1 });
      material.emissive.copy(GLOW);
      material.emissiveIntensity = 0.16;
    } else if (!on && saved) {
      material.emissive.copy(saved.color);
      material.emissiveIntensity = saved.intensity;
      glowing.delete(material);
    }
  }
};

export interface PictureSize {
  width: number;
  height: number;
}

/** A texture's picture as a data URL, no wider or taller than `maxEdge`, with the size it came out at. */
export const texturePicture = (texture: THREE.Texture, maxEdge: number, mime = 'image/png'): (PictureSize & { url: string }) | null => {
  const image = textureSourceImage(texture) as HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  if (!image?.width || !image.height) return null;
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL(mime, 0.92), width: canvas.width, height: canvas.height };
  } catch (error) {
    frontendDiagnostics.failure('texture_extract_failed', error);
    return null;
  }
};
