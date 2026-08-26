
import * as THREE from 'three';

/**
 * Converts older Phong/Lambert materials to Physical/Standard materials
 * for better compatibility with HDR environments.
 */
const upgradeMaterial = (mat: THREE.Material): THREE.Material => {
  // If it's already a PBR material, just return it
  if ((mat as any).isMeshStandardMaterial || (mat as any).isMeshPhysicalMaterial) {
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
    const standardMat = upgradeMaterial(mat);
    
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

    // 5. Transparency Heuristics
    // If we have an alpha map, force transparency on
    if ((standardMat as any).alphaMap) {
        standardMat.transparent = true;
    }
    // FBX often sets transparency on opaque objects.
    // If opacity is 1 and no alpha map, force opaque to avoid depth sorting issues.
    else if (standardMat.opacity >= 1.0) {
         standardMat.transparent = false;
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
