import React, { useEffect } from 'react';
import * as THREE from 'three';
import { AttachmentData } from '../../types';

interface AttachmentControllerProps { 
  data: AttachmentData; 
  parentObject: THREE.Group; 
}

export const AttachmentController: React.FC<AttachmentControllerProps> = ({ data, parentObject }) => {
    
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
            if (data.object.parent !== targetBone) {
                targetBone.add(data.object);
            }
        }
        
        return () => {
            // Clean up: Remove from bone when unmounting (e.g. switching views)
            if (data.object.parent) {
                data.object.parent.remove(data.object);
            }
        };
    }, [data.boneName, parentObject, data.object]);

    useEffect(() => {
        data.object.position.set(...data.position);
        
        const [rx, ry, rz] = data.rotation;
        data.object.rotation.set(
            THREE.MathUtils.degToRad(rx),
            THREE.MathUtils.degToRad(ry),
            THREE.MathUtils.degToRad(rz)
        );
        
        data.object.scale.set(...data.scale);
        data.object.updateMatrix();
    }, [data.position, data.rotation, data.scale, data.object]);

    return null;
};