
import React from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData } from '../../../types';

// Units per second (the former 0.05 per frame at 60 fps).
const MOVE_SPEED = 3;
const RUN_MULTIPLIER = 2.5;
// Clamp long frames (tab switches, hitches) so preview movement never teleports.
const MAX_FRAME_DELTA = 0.1;

export const useGraphLocomotion = (
    modelObject: THREE.Group,
    graph: AnimationGraphData,
    variablesRef: React.MutableRefObject<Record<string, number | boolean>>,
    driveLocomotion: boolean = true
) => {

    useFrame((_state, delta) => {
        // When a controller owns the character transform, the graph only
        // drives animation; translating here too would double the movement.
        if (!driveLocomotion || !modelObject) return;
        const step = MOVE_SPEED * Math.min(Math.max(delta, 0), MAX_FRAME_DELTA);

        // Helper to safely get variables regardless of case
        const getVar = (name: string, def: any) => {
            const v = graph.variables.find(v => v.name.toLowerCase() === name.toLowerCase());
            return v ? (variablesRef.current[v.id] ?? def) : def;
        };

        const inputX = getVar('inputx', 0) as number;
        const inputY = getVar('inputy', 0) as number;
        const isSprinting = getVar('issprinting', false) as boolean;

        const moveVec = new THREE.Vector3(0, 0, 0);
        
        // Basic Locomotion Logic
        // In a real engine, this would use a CharacterController with collision
        if (inputY !== 0) moveVec.z += inputY * step;
        // FIX: Corrected axis direction. +X is Right. InputX=1 should move Right.
        if (inputX !== 0) moveVec.x += inputX * step;

        // FIX: Prevent sprinting when moving backwards (InputY < 0)
        // Only apply multiplier if we are moving, and not moving backwards.
        if (isSprinting && inputY >= 0 && (inputX !== 0 || inputY !== 0)) {
            moveVec.multiplyScalar(RUN_MULTIPLIER);
        }

        // Apply translation relative to current orientation
        modelObject.translateX(moveVec.x);
        modelObject.translateZ(moveVec.z);
    });
};
