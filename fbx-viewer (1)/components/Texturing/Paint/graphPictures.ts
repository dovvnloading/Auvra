import * as THREE from 'three';
import { deepPictures } from '../deepPictures';

/**
 * The texture lookup a set's fill graphs (and their previews) read pictures through: 16-bit and
 * floating-point pictures at their own depth once read (deepPictures), the project's textures meanwhile
 * and for 8-bit ones. On a model whose textures are laid bottom row first, a deep picture (laid top row
 * first) is used through a copy laid the same way, so a Bitmap stands the same way up at any depth.
 */
export const graphPictureLookup = (base: (textureId: string) => THREE.Texture | null, flipY: boolean): { lookup: (textureId: string) => THREE.Texture | null; dispose: () => void } => {
    const deep = deepPictures.lookup(base);
    const turned = new Map<THREE.Texture, THREE.Texture>();
    return {
        lookup: (textureId) => {
            const texture = deep(textureId);
            if (!texture || !flipY || texture.flipY || !(Number(texture.userData?.auvraDepth) > 8)) return texture;
            let copy = turned.get(texture);
            if (!copy) {
                copy = texture.clone();
                copy.flipY = true;
                copy.needsUpdate = true;
                turned.set(texture, copy);
            }
            return copy;
        },
        dispose: () => {
            for (const copy of turned.values()) copy.dispose();
            turned.clear();
        },
    };
};
