import * as THREE from 'three';
import { cloneCharacterModel } from './mountedParts';

interface NodePose {
    node: THREE.Object3D;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
}

/** A model cloned for the preview, with the materials and textures it owns and its starting pose. */
export interface PreviewResources {
    object: THREE.Group;
    materials: Set<THREE.Material>;
    textures: Set<THREE.Texture>;
    baseMaps: Map<THREE.Material, THREE.Texture | null>;
    /** Every node's transform as cloned, so restart and unmount can put the model back. */
    pose: NodePose[];
}

/** Clone a model for the preview without sharing mutable material state. */
export const clonePreviewResources = (source: THREE.Object3D): PreviewResources => {
    const resources: PreviewResources = {
        // Without the editor's own attachments and sockets: the preview mounts copies it controls.
        object: cloneCharacterModel(source) as THREE.Group,
        materials: new Set(),
        textures: new Set(),
        baseMaps: new Map(),
        pose: [],
    };
    resources.object.traverse((child) => {
        resources.pose.push({ node: child, position: child.position.clone(), quaternion: child.quaternion.clone(), scale: child.scale.clone() });
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const previewMaterials = sourceMaterials.map((sourceMaterial) => {
            const material = sourceMaterial.clone();
            resources.materials.add(material);
            for (const key of Object.keys(material)) {
                const value = (material as unknown as Record<string, unknown>)[key];
                if (!value || typeof value !== 'object' || !(value as THREE.Texture).isTexture) continue;
                const texture = (value as THREE.Texture).clone();
                texture.needsUpdate = true;
                resources.textures.add(texture);
                (material as unknown as Record<string, unknown>)[key] = texture;
            }
            if ('map' in material) resources.baseMaps.set(material, (material as THREE.MeshStandardMaterial).map ?? null);
            return material;
        });
        mesh.material = Array.isArray(mesh.material) ? previewMaterials : previewMaterials[0];
    });
    return resources;
};

/**
 * Puts the preview model back the way it was cloned: the root's position and rotation and every
 * descendant's transform. The root's scale belongs to the primitive's scale prop and is kept.
 */
export const restorePreviewPose = (resources: PreviewResources): void => {
    for (const { node, position, quaternion, scale } of resources.pose) {
        node.position.copy(position);
        node.quaternion.copy(quaternion);
        if (node !== resources.object) node.scale.copy(scale);
    }
};

export const disposePreviewResources = (resources: PreviewResources): void => {
    for (const material of resources.materials) material.dispose();
    for (const texture of resources.textures) texture.dispose();
    resources.materials.clear();
    resources.textures.clear();
    resources.baseMaps.clear();
    resources.pose.length = 0;
};
