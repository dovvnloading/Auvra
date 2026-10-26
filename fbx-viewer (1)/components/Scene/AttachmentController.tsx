import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
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

export const AttachmentController: React.FC<AttachmentControllerProps> = ({ data, parentObject, cloneForInstance = false }) => {
    const attachment = useMemo<THREE.Object3D>(
        () => (cloneForInstance ? SkeletonUtils.clone(data.object) : data.object),
        [cloneForInstance, data.object]
    );

    useEffect(() => {
        let targetBone: THREE.Object3D | undefined;

        if (data.boneName) {
            targetBone = parentObject.getObjectByName(data.boneName);
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

        return () => {
            // Clean up: Remove from bone when unmounting (e.g. switching views).
            // In instance mode only this mount's clone is touched.
            if (attachment.parent) {
                attachment.parent.remove(attachment);
            }
            if (cloneForInstance) {
                disposeInstanceClone(attachment);
            }
        };
    }, [data.boneName, parentObject, attachment, cloneForInstance]);

    useEffect(() => {
        attachment.position.set(...data.position);

        const [rx, ry, rz] = data.rotation;
        attachment.rotation.set(
            THREE.MathUtils.degToRad(rx),
            THREE.MathUtils.degToRad(ry),
            THREE.MathUtils.degToRad(rz)
        );

        attachment.scale.set(...data.scale);
        attachment.updateMatrix();
    }, [data.position, data.rotation, data.scale, attachment]);

    return null;
};
