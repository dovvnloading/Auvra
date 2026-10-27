
import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { ProjectileManagerHandle } from './ProjectileManager';
import { SandboxEntityHandle } from './SandboxEntity';
import { usePlayerControls } from './hooks/usePlayerControls';
import { usePlayerPhysics } from './hooks/usePlayerPhysics';
import { usePlayerCombat } from './hooks/usePlayerCombat';
import { Blueprint, LevelObject } from '../../types';

const _rootTravel = new THREE.Vector3();

interface PlayerControllerProps {
    apiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>;
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>;
    modelObject: THREE.Object3D;
    enabled: boolean;
    levelObjects: LevelObject[]; // Collision source when there is no physics world
    /** The player's blueprint; its 'Walk Speed' / 'Run Speed' stats set the movement speeds. */
    blueprint?: Pick<Blueprint, 'stats'>;
    onStaminaChange?: (val: number) => void;
    onAimChange?: (isAiming: boolean) => void;
    weaponSounds?: string[]; // Array of Audio URLs
    weaponVolume?: number;
}

/**
 * Drives the player character. In a level runtime it reads the runtime's input actions and moves a
 * Rapier character controller through the physics world; in the Sandbox tab it keeps its own
 * keyboard handling and the simple kinematic movement.
 */
export const PlayerController: React.FC<PlayerControllerProps> = ({
    apiRef,
    entityRef,
    projectileManager,
    modelObject,
    enabled,
    levelObjects,
    blueprint,
    onStaminaChange,
    onAimChange,
    weaponSounds,
    weaponVolume = 1.0
}) => {
    const { camera } = useThree();

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
    const { updatePhysics, hasPhysicsWorld } = usePlayerPhysics(modelObject, camera, onStaminaChange, levelObjects, blueprint?.stats);

    // 3. Combat System
    const { updateCombat } = usePlayerCombat(
        modelObject,
        entityRef,
        projectileManager,
        weaponSounds,
        camera,
        weaponVolume
    );

    useFrame((_, delta) => {
        if (!enabled || !modelObject || !apiRef.current) return;

        // Disable controls if dead
        if (entityRef.current?.isDead()) return;

        // --- Step A: Inputs ---
        const input = getInputState();

        // Report Aim State to World (for Camera/UI)
        if (onAimChange) onAimChange(input.isAiming);

        // --- Step B: Physics & Movement ---
        // Returns localInputX/Y which are relative to Character Rotation
        // A state with root motion moves the character by the clip's own travel (taken every frame so none piles up).
        const travel = apiRef.current.consumeRootMotion?.(_rootTravel);
        const rootMotion = apiRef.current.getActiveState?.()?.rootMotion ? travel : null;
        const { isMoving, effectiveSprint, localInputX, localInputY, isAirborne } = updatePhysics(input, delta, rootMotion);

        // --- Step C: Combat ---
        updateCombat(input.isFiring, input.isAiming, camera, delta);

        // --- Step D: Animation Graph Bridge ---
        apiRef.current.setVariable('Speed', isMoving ? 1 : 0);
        apiRef.current.setVariable('InputY', localInputY);
        apiRef.current.setVariable('InputX', localInputX);
        apiRef.current.setVariable('IsSprinting', effectiveSprint);
        // With physics the jump pose follows the character leaving the ground; without, the key itself.
        apiRef.current.setVariable('IsJumping', hasPhysicsWorld ? isAirborne : input.isJumping);
        apiRef.current.setVariable('IsFiring', input.isFiring);
        apiRef.current.setVariable('IsAiming', input.isAiming);
    });

    return null;
};
