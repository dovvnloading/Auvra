
import * as THREE from 'three';

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
      // Cards draw in no particular order anyway, so back faces first gains nothing and costs a second draw.
      material.forceSinglePass = true;
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
