import type * as THREE from 'three';

/**
 * A cache token for a project picture. IDs and bit depth alone cannot tell a
 * replaced texture from the old pixels; Three's version counters also detect
 * updates to the same texture or its underlying source.
 */
const identities = new WeakMap<THREE.Texture, number>();
let nextIdentity = 1;

export const sourceTextureKey = (texture: THREE.Texture | null | undefined): string | null => {
    if (!texture) return null;
    let identity = identities.get(texture);
    if (identity === undefined) {
        identity = nextIdentity++;
        identities.set(texture, identity);
    }
    return `${identity}:${texture.version}:${texture.source?.version ?? 0}:${Number(texture.userData?.auvraDepth) || 8}`;
};
