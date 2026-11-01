import * as THREE from 'three';
import { textureSourceFlipY, textureSourceImage } from '../../../utils/textureCompression/compressTextures';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { overrideTextureFlipY } from '../../../utils/materialOverrides';

export type PartMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
  metalnessMap?: THREE.Texture | null;
  roughness?: number;
  metalness?: number;
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
};

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

/** A little beyond each triangle, as a texture is read from between its pixels and from smaller copies of itself. */
const USED_AREA_MARGIN_PX = 3;

const fillTriangle = (used: Uint8Array, width: number, height: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
  const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const top = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  const sign = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0 ? -1 : 1;
  for (let y = top; y <= bottom; y += 1) {
    const py = y + 0.5;
    const row = y * width;
    for (let x = left; x <= right; x += 1) {
      const px = x + 0.5;
      if (sign * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= 0
        && sign * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) >= 0
        && sign * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) >= 0) used[row + x] = 255;
    }
  }
  // A sliver can fall between pixel centres.
  const ix = Math.floor(ax);
  const iy = Math.floor(ay);
  if (ix >= 0 && ix < width && iy >= 0 && iy < height) used[iy * width + ix] = 255;
};

const grownByOne = (area: Uint8Array, width: number, height: number): Uint8Array => {
  const grown = area.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      if (!area[at]) continue;
      if (x > 0) grown[at - 1] = 255;
      if (x < width - 1) grown[at + 1] = 255;
      if (y > 0) grown[at - width] = 255;
      if (y < height - 1) grown[at + width] = 255;
    }
  }
  return grown;
};

/**
 * Hands `visit` each of a part's triangles where it lies on the map, as three corners from 0 to 1 across. False where it
 * has no one place there: without UVs, or with a map that repeats across them.
 */
const eachTriangleOnMap = (object: THREE.Object3D, part: ModelPart, visit: (corner: readonly number[]) => void): boolean => {
  let found = false;
  let repeats = false;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || repeats) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!materials.some((material) => part.materials.includes(material as PartMaterial))) return;
    const uv = mesh.geometry?.getAttribute('uv');
    if (!uv) { repeats = true; return; }
    const index = mesh.geometry.index;
    const count = index ? index.count : uv.count;
    const groups = Array.isArray(mesh.material) && mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    const corner = [0, 0, 0, 0, 0, 0];
    for (const group of groups) {
      if (!part.materials.includes(materials[group.materialIndex ?? 0] as PartMaterial)) continue;
      const end = Math.min(group.start + group.count, count);
      for (let at = group.start; at + 2 < end; at += 3) {
        for (let which = 0; which < 3; which += 1) {
          const vertex = index ? index.getX(at + which) : at + which;
          const u = uv.getX(vertex);
          const v = uv.getY(vertex);
          if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) { repeats = true; return; }
          corner[which * 2] = u;
          corner[which * 2 + 1] = v;
        }
        visit(corner);
        found = true;
      }
    }
  });
  return found && !repeats;
};

/**
 * Which pixels of a part's map the model draws, as a byte per pixel, or null where that cannot be told: without UVs,
 * or with a map that repeats across them, where any pixel may be in use. Filled here rather than on a canvas, as a
 * scanned or generated model can have millions of triangles.
 */
export const usedAreaOfPart = (object: THREE.Object3D, part: ModelPart, width: number, height: number): Uint8Array | null => {
  // The way round the picture of a map is, which the texture itself cannot say: a compressed one is flipped in advance.
  const flipY = overrideTextureFlipY(object);
  let used = new Uint8Array(width * height);
  const onMap = eachTriangleOnMap(object, part, ([au, av, bu, bv, cu, cv]) => {
    fillTriangle(used, width, height, au * width, (flipY ? 1 - av : av) * height, bu * width, (flipY ? 1 - bv : bv) * height, cu * width, (flipY ? 1 - cv : cv) * height);
  });
  if (!onMap) return null;
  for (let step = 0; step < USED_AREA_MARGIN_PX; step += 1) used = grownByOne(used, width, height);
  return used;
};

const LAYOUT_CHECK_EDGE = 256;
/** At this many layers over, faces share a map rather than being laid out across it, as a box's do. A mirrored model comes to two. */
const SHARED_MAP_LAYERS = 3;

/**
 * Whether a part's map is laid out across its object, each place on one having a place on the other. Such a map can only be
 * painted through the object, where a picture spread over it comes out as scraps. Where faces share one map, or it repeats,
 * the map is a picture of a surface.
 */
export const mapIsLaidOutOverObject = (object: THREE.Object3D, part: ModelPart): boolean => {
  const used = usedAreaOfPart(object, part, LAYOUT_CHECK_EDGE, LAYOUT_CHECK_EDGE);
  if (!used) return false;
  let covered = 0;
  for (let at = 0; at < used.length; at += 1) if (used[at]) covered += 1;
  let area = 0;
  eachTriangleOnMap(object, part, ([au, av, bu, bv, cu, cv]) => { area += Math.abs((bu - au) * (cv - av) - (bv - av) * (cu - au)) / 2; });
  return area * used.length < SHARED_MAP_LAYERS * covered;
};

export interface PictureSize {
  width: number;
  height: number;
}

/**
 * A texture's picture as a data URL, no wider or taller than `maxEdge`, with the size it came out at. With `flipY`, it comes
 * out the way up a texture with that `flipY` is read, whichever way up it was made: an imported map and one saved on the
 * same model can differ, and what is worked out from one has to line up with the other.
 */
export const texturePicture = (texture: THREE.Texture, maxEdge: number, mime = 'image/png', flipY?: boolean): (PictureSize & { url: string }) | null => {
  const image = textureSourceImage(texture) as HTMLImageElement | HTMLCanvasElement | ImageBitmap | null;
  if (!image?.width || !image.height) return null;
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    if (flipY !== undefined && flipY !== textureSourceFlipY(texture)) {
      context.translate(0, canvas.height);
      context.scale(1, -1);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL(mime, 0.92), width: canvas.width, height: canvas.height };
  } catch (error) {
    frontendDiagnostics.failure('texture_extract_failed', error);
    return null;
  }
};
