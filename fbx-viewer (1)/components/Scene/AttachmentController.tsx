import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { markMountedPart } from '../../utils/mountedParts';
import { AttachmentData } from '../../types';

interface AttachmentControllerProps {
  data: AttachmentData;
  parentObject: THREE.Group;
  /**
   * When true, this mount parents its own clone of `data.object` instead of
   * the shared object, so several entities sharing one attachment each show
   * it. Defaults to false (editor behavior: the shared object is reparented).
   */
  cloneForInstance?: boolean;
  /** Kept on its bone but not drawn, such as a weapon the character is not holding. */
  hidden?: boolean;
  /** Puts the attachment on another bone with other offsets, such as a weapon carried on the back; its scale stays. */
  placement?: AttachmentPlacement | null;
}

export interface AttachmentPlacement {
  boneName: string;
  position: [number, number, number];
  /** Degrees, as the attachment's own rotation. */
  rotation: [number, number, number];
}

// Clones share geometry and materials with the source attachment, so only the
// per-clone skeleton bone textures are released here.
const disposeInstanceClone = (object: THREE.Object3D) => {
    object.traverse((child) => {
        if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
            (child as THREE.SkinnedMesh).skeleton?.dispose();
        }
    });
};

export const AttachmentController: React.FC<AttachmentControllerProps> = ({ data, parentObject, cloneForInstance = false, hidden = false, placement = null }) => {
    const attachment = useMemo<THREE.Object3D>(() => {
        const object = cloneForInstance ? SkeletonUtils.clone(data.object) : data.object;
        markMountedPart(object);
        return object;
    }, [cloneForInstance, data.object]);
    const boneName = placement?.boneName ?? data.boneName;
    const [px, py, pz] = placement?.position ?? data.position;
    const [rx, ry, rz] = placement?.rotation ?? data.rotation;

    // Clean up: remove from the bone when unmounting (e.g. switching views). In instance mode
    // only this mount's clone is touched. Moving to another bone never disposes it.
    useEffect(() => () => {
        if (attachment.parent) {
            attachment.parent.remove(attachment);
        }
        if (cloneForInstance) {
            disposeInstanceClone(attachment);
        }
    }, [attachment, cloneForInstance]);

    useEffect(() => {
        let targetBone: THREE.Object3D | undefined;

        if (boneName) {
            targetBone = parentObject.getObjectByName(boneName);
        }

        // FIX: Removed fallback recursive search for arbitrary bones.
        // If the specific bone isn't found, we attach to the parent object root.
        // This prevents brittle behavior where attachments would snap to random joints
        // on meshes that don't match the expected skeleton.
        if (!targetBone) {
             targetBone = parentObject;
        }

        if (targetBone) {
            // Check if already attached to avoid re-parenting issues or conflicts
            if (attachment.parent !== targetBone) {
                targetBone.add(attachment);
            }
        }
    }, [boneName, parentObject, attachment]);

    useEffect(() => {
        attachment.position.set(px, py, pz);
        attachment.rotation.set(
            THREE.MathUtils.degToRad(rx),
            THREE.MathUtils.degToRad(ry),
            THREE.MathUtils.degToRad(rz)
        );

        attachment.scale.set(...data.scale);
        attachment.updateMatrix();
    }, [px, py, pz, rx, ry, rz, data.scale, attachment]);

    useEffect(() => {
        attachment.visible = !hidden;
    }, [attachment, hidden]);

    return null;
};
