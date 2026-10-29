
import * as THREE from 'three';

/**
 * Converts older Phong/Lambert materials to Physical/Standard materials
 * for better compatibility with HDR environments.
 */
/**
 * FBX exporters (Blender among them) write a white emissive colour with zero strength.
 * Imports round-trip through glTF before this step, which drops the zero strength, so a
 * mapless, near-white emissive is treated as an export artifact on every material type.
 */
const sanitizeEmissive = (mat: THREE.MeshStandardMaterial) => {
  if (mat.emissiveMap) return;
  const { r, g, b } = mat.emissive;
  if (mat.emissiveIntensity === 0 || (r > 0.9 && g > 0.9 && b > 0.9)) {
    mat.emissive.set(0x000000);
  }
};

const upgradeMaterial = (mat: THREE.Material): THREE.Material => {
  // If it's already a PBR material, keep it but still drop exporter emissive artifacts
  if ((mat as any).isMeshStandardMaterial || (mat as any).isMeshPhysicalMaterial) {
    sanitizeEmissive(mat as THREE.MeshStandardMaterial);
    return mat;
  }

  // Create a new Standard material preserving maps and colors
  const newMat = new THREE.MeshStandardMaterial();
  const oldMat = mat as THREE.MeshPhongMaterial;

  newMat.name = oldMat.name;
  newMat.color.copy(oldMat.color);
  newMat.map = oldMat.map;
  newMat.lightMap = oldMat.lightMap;
  newMat.aoMap = oldMat.aoMap;
  
  // --- FIX 1: Preserve Alpha Map (Crucial for Eyes/Lashes) ---
  newMat.alphaMap = (oldMat as any).alphaMap;
  
  // --- FIX 2: Handle Emissive Blowout ---
  // FBX often imports with Emissive = White but no Emissive Map, resulting in a solid white glowing mesh.
  // We only keep the emissive color if there is an actual emissive map, or if the color is not pure white default.
  if (oldMat.emissiveMap) {
      newMat.emissive.copy(oldMat.emissive);
      newMat.emissiveMap = oldMat.emissiveMap;
      newMat.emissiveIntensity = oldMat.emissiveIntensity;
  } else {
      // If pure white emissive with no map, it's likely an export artifact. Reset to black.
      if (oldMat.emissive.r > 0.9 && oldMat.emissive.g > 0.9 && oldMat.emissive.b > 0.9) {
          newMat.emissive.set(0x000000);
      } else {
          newMat.emissive.copy(oldMat.emissive);
      }
  }
  
  if (oldMat.normalMap) {
    newMat.normalMap = oldMat.normalMap;
    newMat.normalScale.copy(oldMat.normalScale);
  }

  // Rough approximation of shininess to roughness
  if ('shininess' in oldMat) {
    const shininess = (oldMat as any).shininess;
    newMat.roughness = Math.max(0, Math.min(1, 1 - (shininess / 100)));
  } else {
    newMat.roughness = 0.5;
  }
  
  newMat.metalness = 0.1; // Default to non-metallic for safety

  // Apply side and other flags
  newMat.side = oldMat.side !== undefined ? oldMat.side : THREE.DoubleSide;
  newMat.transparent = oldMat.transparent;
  newMat.opacity = oldMat.opacity;
  newMat.alphaTest = oldMat.alphaTest;
  
  // --- FIX 3: Preserve Vertex Colors if enabled ---
  newMat.vertexColors = oldMat.vertexColors;

  return newMat;
};

/**
 * Process a single material to ensure correct color space and rendering settings.
 */
const processMaterial = (mat: THREE.Material): THREE.Material => {
    // 1. Upgrade Material to Standard for better HDR lighting response
    const standardMat = upgradeMaterial(mat) as THREE.MeshStandardMaterial;
    
    // 2. Fix Texture Encoding
    if ((standardMat as any).map) {
      (standardMat as any).map.colorSpace = THREE.SRGBColorSpace;
    }
    if ((standardMat as any).emissiveMap) {
      (standardMat as any).emissiveMap.colorSpace = THREE.SRGBColorSpace;
    }

    // 3. Environment Map Intensity
    (standardMat as any).envMapIntensity = 1.0;

    // 4. Geometry/Side Fixes
    standardMat.side = THREE.DoubleSide;

    // 5. Transparency
    // An alpha map makes it transparent. FBX and OBJ arrive through the import worker's GLB handoff,
    // which has already baked opacity maps into the colour map's alpha and made opaque what has no
    // opacity, so a transparent material here with full opacity is drawn through its colour map.
    if ((standardMat as any).alphaMap) {
        standardMat.transparent = true;
    }

    // 6. Ensure Base Color is not tinting Texture incorrectly
    // If map exists, ensure color isn't black
    if ((standardMat as any).map && standardMat.color.getHex() === 0x000000) {
        standardMat.color.setHex(0xffffff);
    }

    return standardMat;
};

/**
 * Optimizes the loaded model:
 * 1. Enables shadows
 * 2. Fixes texture color spaces
 * 3. Upgrades materials to PBR
 * 4. Fixes common transparency issues
 */
export const optimizeModelMaterials = (group: THREE.Group) => {
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(processMaterial);
      } else {
        mesh.material = processMaterial(mesh.material);
      }
    }
  });
};

/**
 * ALPHA CARDS
 *
 * Hair, lashes and leaves are usually cards: flat strips drawn see-through by their texture's alpha.
 * Blended like glass, a mesh of many cards draws them in no particular order and leaves nothing in the
 * depth buffer, so inner cards show through outer ones, what is behind shows through, and the screen
 * effects that read depth (haze, light shafts, motion blur, screen lighting) treat the hair as whatever
 * is behind it. So a card material is drawn in two passes: its solid body (alpha at or above
 * CARD_ALPHA_CUTOFF) alpha-tested like an opaque surface, which writes depth and casts card-shaped
 * shadows; then its soft fringe, blended over the body by a copy of the mesh that shares its geometry
 * (and skeleton).
 */

/** Alpha at or above this is a card's solid body; below it, its fringe. */
export const CARD_ALPHA_CUTOFF = 0.5;
/** userData flag on the copy of a mesh that draws its cards' fringe. */
export const CARD_FRINGE_KEY = 'alphaCardFringe';

/** A card: see-through by its texture's alpha at full opacity and blended normally (not glass, not a glow). */
export const isAlphaCard = (material: THREE.Material): boolean => {
  const m = material as THREE.MeshPhysicalMaterial;
  return m.transparent && m.opacity >= 1 && m.alphaTest === 0 && m.blending === THREE.NormalBlending
    && !!(m.map || m.alphaMap) && !((m.transmission ?? 0) > 0);
};

/** Draws the card materials of every mesh under `root` as a solid body and a blended fringe (see above). */
export const splitAlphaCards = (root: THREE.Object3D): void => {
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.userData[CARD_FRINGE_KEY]) return;
    // Already split: its fringe is a child.
    if (mesh.children.some(child => child.userData[CARD_FRINGE_KEY])) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some(isAlphaCard)) meshes.push(mesh);
  });
  const bodies = new Map<THREE.Material, THREE.Material>();
  const bodyOf = (material: THREE.Material): THREE.Material => {
    let body = bodies.get(material);
    if (!body) {
      body = material.clone();
      body.transparent = false;
      body.depthWrite = true;
      body.alphaTest = CARD_ALPHA_CUTOFF;
      bodies.set(material, body);
    }
    return body;
  };
  for (const mesh of meshes) {
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    // The fringe draws only the cards; other parts of a many-material mesh draw nothing in it.
    let nothing: THREE.Material | null = null;
    const fringeMaterials = list.map((material) => {
      if (!isAlphaCard(material)) {
        if (!nothing) {
          nothing = new THREE.MeshBasicMaterial({ visible: false });
          nothing.userData[CARD_FRINGE_KEY] = true;
        }
        return nothing;
      }
      material.depthWrite = false;
      return material;
    });
    mesh.material = Array.isArray(original) ? list.map(material => (isAlphaCard(material) ? bodyOf(material) : material)) : bodyOf(original);
    const fringeMaterial = Array.isArray(original) ? fringeMaterials : fringeMaterials[0];
    let fringe: THREE.Mesh;
    const skinned = mesh as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      const copy = new THREE.SkinnedMesh(mesh.geometry, fringeMaterial);
      copy.bindMode = skinned.bindMode;
      copy.bind(skinned.skeleton, skinned.bindMatrix);
      fringe = copy;
    } else {
      fringe = new THREE.Mesh(mesh.geometry, fringeMaterial);
    }
    // Blend shapes move both together.
    fringe.morphTargetInfluences = mesh.morphTargetInfluences;
    fringe.morphTargetDictionary = mesh.morphTargetDictionary;
    fringe.name = `${mesh.name} fringe`;
    fringe.castShadow = false;
    fringe.receiveShadow = mesh.receiveShadow;
    fringe.frustumCulled = mesh.frustumCulled;
    fringe.userData[CARD_FRINGE_KEY] = true;
    mesh.add(fringe);
  }
};
