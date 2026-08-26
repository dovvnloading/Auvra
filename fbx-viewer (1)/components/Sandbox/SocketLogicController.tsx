
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SocketData } from '../../types';

interface SocketLogicControllerProps { 
    data: SocketData; 
    parentObject: THREE.Group;
    onMount: (obj: THREE.Object3D) => void;
}

export const SocketLogicController: React.FC<SocketLogicControllerProps> = ({ data, parentObject, onMount }) => {
    const objRef = useRef<THREE.Group>(null);

    useEffect(() => {
        if (objRef.current) onMount(objRef.current);
    }, [onMount]);

    useEffect(() => {
        let targetBone: THREE.Object3D | undefined;
        if (data.boneName) targetBone = parentObject.getObjectByName(data.boneName);
        if (!targetBone) targetBone = parentObject;
        
        if (targetBone && objRef.current && objRef.current.parent !== targetBone) {
            targetBone.add(objRef.current);
        }
        
        return () => {
            if (objRef.current?.parent) objRef.current.parent.remove(objRef.current);
        };
    }, [data.boneName, parentObject]);

    useEffect(() => {
        if (objRef.current) {
            objRef.current.position.set(...data.position);
            objRef.current.rotation.set(
                THREE.MathUtils.degToRad(data.rotation[0]),
                THREE.MathUtils.degToRad(data.rotation[1]),
                THREE.MathUtils.degToRad(data.rotation[2])
            );
            objRef.current.scale.set(...data.scale);
            objRef.current.updateMatrix();
        }
    }, [data.position, data.rotation, data.scale]);

    return <group ref={objRef} />;
};
