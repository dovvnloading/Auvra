
import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { ProjectileManagerHandle } from './ProjectileManager';
import { SandboxEntityHandle } from './SandboxEntity';
import { usePlayerControls } from './hooks/usePlayerControls';
import { usePlayerPhysics } from './hooks/usePlayerPhysics';
import { usePlayerCombat } from './hooks/usePlayerCombat';
import { useScene } from '../../context/SceneContext';

interface PlayerControllerProps { 
    apiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>;
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>;
    modelObject: THREE.Object3D;
    enabled: boolean;
    onStaminaChange?: (val: number) => void;
    onAimChange?: (isAiming: boolean) => void;
    weaponSounds?: string[]; // Array of Audio URLs
    weaponVolume?: number;
}

export const PlayerController: React.FC<PlayerControllerProps> = ({ 
    apiRef, 
    entityRef,
    projectileManager,
    modelObject,
    enabled,
    onStaminaChange,
    onAimChange,
    weaponSounds,
    weaponVolume = 1.0
}) => {
    const { camera } = useThree();
    
    // Access scene level objects for collision
    const { levelObjects } = useScene(); 

    // --- AUDIO LISTENER INIT ---
    // Critical: Ensure the camera has "ears" so we can hear the gunshots.
    useEffect(() => {
        if (!camera) return;
        
        // Check if listener already exists (e.g. added by AudioSystem)
        const existingListener = camera.children.find(c => c.type === 'AudioListener');
        
        if (!existingListener) {
            const listener = new THREE.AudioListener();
            camera.add(listener);
            
            return () => {
                camera.remove(listener);
            };
        }
    }, [camera]);

    // 1. Input System
    const { getInputState } = usePlayerControls(enabled);

    // 2. Physics & Locomotion System
    const { updatePhysics } = usePlayerPhysics(modelObject, camera, onStaminaChange, levelObjects);

    // 3. Combat System
    const { updateCombat } = usePlayerCombat(
        modelObject, 
        entityRef, 
        projectileManager, 
        weaponSounds, 
        camera,
        weaponVolume
    );

    useFrame((state, delta) => {
        if (!enabled || !modelObject || !apiRef.current) return;
        
        // Disable controls if dead
        if (entityRef.current?.isDead()) return;

        // --- Step A: Inputs ---
        const input = getInputState();

        // Report Aim State to World (for Camera/UI)
        if (onAimChange) onAimChange(input.isAiming);

        // --- Step B: Physics & Movement ---
        // Returns localInputX/Y which are relative to Character Rotation
        const { isMoving, effectiveSprint, localInputX, localInputY } = updatePhysics(input, delta);

        // --- Step C: Combat ---
        updateCombat(input.isFiring, input.isAiming, camera, delta);

        // --- Step D: Animation Graph Bridge ---
        apiRef.current.setVariable('Speed', isMoving ? 1 : 0);
        apiRef.current.setVariable('InputY', localInputY); 
        apiRef.current.setVariable('InputX', localInputX); 
        apiRef.current.setVariable('IsSprinting', effectiveSprint);
        apiRef.current.setVariable('IsJumping', input.isJumping);
        apiRef.current.setVariable('IsFiring', input.isFiring);
        apiRef.current.setVariable('IsAiming', input.isAiming);
    });

    return null;
};
