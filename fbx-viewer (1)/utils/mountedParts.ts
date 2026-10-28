import type * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';

/**
 * MOUNTED PARTS
 *
 * Attachments and sockets are mounted on a character by whoever shows it: the editor mounts the
 * project's own objects on the model, a play session or preview mounts copies it controls (shown,
 * hidden, carried). A copy of a character must not take along what another view mounted on its
 * source, or the copy shows weapons nothing controls.
 */

const MOUNTED_PART = 'auvraMountedPart';

/** Marks an object mounted on a character (an attachment, a socket) so copies of the character leave it out. */
export const markMountedPart = (object: THREE.Object3D): void => {
    object.userData[MOUNTED_PART] = true;
};

/** Copies a character model, skeleton and all, without the parts mounted on the source. */
export const cloneCharacterModel = <T extends THREE.Object3D>(source: T): T => {
    const copy = SkeletonUtils.clone(source) as T;
    const mounted: THREE.Object3D[] = [];
    copy.traverse(node => {
        if (node !== copy && node.userData[MOUNTED_PART] === true) mounted.push(node);
    });
    // Outermost first: a part mounted inside another goes with it.
    for (const part of mounted) part.parent?.remove(part);
    return copy;
};
