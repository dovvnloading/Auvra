
import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { AnimationGraphData } from '../../types';

interface CharacterCameraRigProps {
    target: THREE.Object3D;
    graph?: AnimationGraphData;
    offset?: [number, number, number]; // Standard 3rd person pivot offset
    active: boolean;
    isAiming: boolean;
    aimOffset?: [number, number, number]; // Offset for Scope Mode
}

// Reusable math objects
const _targetWorldPos = new THREE.Vector3();
const _finalPos = new THREE.Vector3();
const _lookAtPos = new THREE.Vector3();
const _dummyVec = new THREE.Vector3();

export const CharacterCameraRig: React.FC<CharacterCameraRigProps> = ({ 
    target, 
    graph,
    offset = [0, 4.5, 0], 
    active,
    isAiming,
    aimOffset = [0.5, 4.5, 1.0] 
}) => {
    const { camera, gl } = useThree();
    
    // Config
    const mouseSensitivity = 0.002;
    const minPitch = 0.1;
    const maxPitch = Math.PI - 0.2;

    // Resolve Camera Distance from Graph
    const defaultDistance = useMemo(() => {
        if (!graph) return 6.0; 
        const variable = graph.variables.find(v => v.name === 'CameraDistance');
        return (variable && typeof variable.value === 'number') ? variable.value : 6.0;
    }, [graph]);

    // Internal State
    const state = useRef({
        theta: Math.PI,    // Yaw
        phi: Math.PI / 2.5,  // Pitch
        aimFactor: 0,      // 0 to 1 blending
        currentDistance: defaultDistance
    });

    // Input Handling
    useEffect(() => {
        const domElement = gl.domElement;

        const onMouseMove = (e: MouseEvent) => {
            if (!active || document.pointerLockElement !== domElement) return;

            // Dampen sensitivity when aiming for precision
            const sensitivity = isAiming ? mouseSensitivity * 0.3 : mouseSensitivity;

            state.current.theta -= e.movementX * sensitivity;
            state.current.phi -= e.movementY * sensitivity;

            // Clamp vertical rotation
            state.current.phi = Math.max(minPitch, Math.min(maxPitch, state.current.phi));
        };

        const onClick = () => {
            if (active) domElement.requestPointerLock();
        };

        const onWheel = (e: WheelEvent) => {
            if (!active || isAiming) return;
            state.current.currentDistance += e.deltaY * 0.005;
            state.current.currentDistance = Math.max(2.0, Math.min(15.0, state.current.currentDistance));
        };

        document.addEventListener('mousemove', onMouseMove);
        domElement.addEventListener('click', onClick);
        domElement.addEventListener('wheel', onWheel, { passive: true });

        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            domElement.removeEventListener('click', onClick);
            domElement.removeEventListener('wheel', onWheel);
        };
    }, [active, gl, isAiming]);

    // Sync distance when graph changes (optional)
    useEffect(() => {
        state.current.currentDistance = defaultDistance;
    }, [defaultDistance]);

    // Frame Loop - Standard Priority
    useFrame((_, delta) => {
        if (!target) return;

        // 1. Interpolate Aim Factor (Smooth transition between modes)
        const targetAimFactor = isAiming ? 1.0 : 0.0;
        state.current.aimFactor = THREE.MathUtils.lerp(state.current.aimFactor, targetAimFactor, delta * 15);

        // 2. Get Stable Target Position
        target.getWorldPosition(_targetWorldPos);
        
        // 3. Calculate 3rd Person View (Orbit)
        // Pivot is centered on character + offset
        const pivotY = _targetWorldPos.y + offset[1];
        const pivotX = _targetWorldPos.x;
        const pivotZ = _targetWorldPos.z;

        const sinPhi = Math.sin(state.current.phi);
        const cosPhi = Math.cos(state.current.phi);
        const sinTheta = Math.sin(state.current.theta);
        const cosTheta = Math.cos(state.current.theta);

        // Standard Orbit Position
        const orbitDist = state.current.currentDistance;
        const orbitX = pivotX + orbitDist * sinPhi * sinTheta;
        const orbitY = pivotY + orbitDist * cosPhi;
        const orbitZ = pivotZ + orbitDist * sinPhi * cosTheta;

        // 4. Calculate Aim View (Scope)
        // Position is offset relative to character, rotated by camera angle
        // Essentially placing the camera "at the shoulder" looking forward
        
        // Forward vector based on camera angles
        const fwdX = sinTheta; // Using theta directly for simplified forward direction on XZ
        const fwdZ = cosTheta;
        const rightX = cosTheta;
        const rightZ = -sinTheta;

        // Aim Position: Start at Head
        const aimX = pivotX 
            + (rightX * aimOffset[0]) // Shift Right
            - (fwdX * aimOffset[2]);  // Shift Forward/Back
        
        const aimY = _targetWorldPos.y + aimOffset[1]; // Height
        
        const aimZ = pivotZ 
            + (rightZ * aimOffset[0]) // Shift Right
            - (fwdZ * aimOffset[2]);  // Shift Forward/Back

        // 5. Blend Positions
        // If aimFactor is 0, use orbit. If 1, use aim.
        _finalPos.set(orbitX, orbitY, orbitZ).lerp(new THREE.Vector3(aimX, aimY, aimZ), state.current.aimFactor);

        // 6. Look At Point
        // In 3rd person: Look at Pivot
        // In Aim: Look forward from camera position (infinite target) OR keep looking at pivot offset
        // To prevent disorientation, we look at a point projected forward from the pivot
        
        // Look Pivot
        _lookAtPos.set(pivotX, pivotY, pivotZ);
        
        // When aiming, we want the camera orientation to be controlled purely by theta/phi
        // We can simulate this by looking at a point on the sphere surface defined by theta/phi
        const lookTargetDist = 100;
        const lookX = _finalPos.x - (lookTargetDist * sinPhi * sinTheta);
        const lookY = _finalPos.y - (lookTargetDist * cosPhi);
        const lookZ = _finalPos.z - (lookTargetDist * sinPhi * cosTheta);
        
        // Blend look targets? 
        // Actually, standard Orbit lookAt is center.
        // FPS lookAt is "forward".
        // Let's blend the lookAt target.
        
        const orbitLookAt = new THREE.Vector3(pivotX, pivotY, pivotZ);
        const aimLookAt = new THREE.Vector3(lookX, lookY, lookZ);
        
        // Critical: As we transition to Aim, we switch from "Looking AT character" to "Looking OUT from character"
        _lookAtPos.copy(orbitLookAt).lerp(aimLookAt, state.current.aimFactor);

        // 7. Apply to Camera
        camera.position.copy(_finalPos);
        camera.lookAt(_lookAtPos);
    });

    return null;
};
