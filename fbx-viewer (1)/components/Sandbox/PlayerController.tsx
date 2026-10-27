
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { ProjectileManagerHandle } from './ProjectileManager';
import { SandboxEntityHandle } from './SandboxEntity';
import { usePlayerControls } from './hooks/usePlayerControls';
import { usePlayerPhysics } from './hooks/usePlayerPhysics';
import { usePlayerCombat } from './hooks/usePlayerCombat';
import { Blueprint, DEFAULT_UPPER_BODY_BONE, LevelObject, UpperBodySettings } from '../../types';

const _rootTravel = new THREE.Vector3();

/** The upper-body clip for this frame: the fire clip while firing, else the aim clip while aiming, else none. */
export const upperBodyClip = (settings: UpperBodySettings | undefined, firing: boolean, aiming: boolean): string | null =>
    (firing && settings?.fireClip) || (aiming && settings?.aimClip) || null;

interface PlayerControllerProps {
    apiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>;
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>;
    modelObject: THREE.Object3D;
    enabled: boolean;
    levelObjects: LevelObject[]; // Collision source when there is no physics world
    /** The player's blueprint; its 'Walk Speed' / 'Run Speed' stats set the movement speeds. */
    blueprint?: Pick<Blueprint, 'stats' | 'upperBody'>;
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

    // The upper-body clip playing now, so it starts and stops only when firing or aiming changes.
    const upperBodyPlaying = useRef<string | null>(null);

    useFrame((_, delta) => {
        if (!enabled || !modelObject || !apiRef.current) return;

        // Disable controls if dead
        if (entityRef.current?.isDead()) return;

        // --- Step A: Inputs ---
        const input = getInputState();

        // Report Aim State to World (for Camera/UI)
        if (onAimChange) onAimChange(input.isAiming);

        // Fire and aim clips play from the spine up, over whatever the legs are doing.
        const upperBody = upperBodyClip(blueprint?.upperBody, input.isFiring, input.isAiming);
        if (upperBody !== upperBodyPlaying.current) {
            upperBodyPlaying.current = upperBody;
            if (upperBody) {
                apiRef.current.playMontage?.(upperBody, {
                    maskBone: blueprint?.upperBody?.maskBone || DEFAULT_UPPER_BODY_BONE, loop: true, blendIn: 0.12,
                });
            } else {
                apiRef.current.stopMontage?.(0.2);
            }
        }

        // --- Step B: Physics & Movement ---
        // Returns localInputX/Y which are relative to Character Rotation
        // A state with root motion moves the character by the clip's own travel (taken every frame so none piles up).
        const travel = apiRef.current.consumeRootMotion?.(_rootTravel);
        const rootMotion = apiRef.current.getActiveState?.()?.rootMotion ? travel : null;
        const { isMoving, effectiveSprint, localInputX, localInputY, isAirborne, isFalling, verticalSpeed } = updatePhysics(input, delta, rootMotion);

        // --- Step C: Combat ---
        updateCombat(input.isFiring, input.isAiming, camera, delta);

        // --- Step D: Animation Graph Bridge ---
        apiRef.current.setVariable('Speed', isMoving ? 1 : 0);
        apiRef.current.setVariable('InputY', localInputY);
        apiRef.current.setVariable('InputX', localInputX);
        apiRef.current.setVariable('IsSprinting', effectiveSprint);
        // With physics the jump pose follows the character leaving the ground; without, the key itself.
        apiRef.current.setVariable('IsJumping', hasPhysicsWorld ? isAirborne : input.isJumping);
        // For jump, fall and land states: a short drop over a bump does not count as falling.
        apiRef.current.setVariable('IsGrounded', !isAirborne);
        apiRef.current.setVariable('IsFalling', isFalling);
        apiRef.current.setVariable('VerticalSpeed', verticalSpeed);
        apiRef.current.setVariable('IsFiring', input.isFiring);
        apiRef.current.setVariable('IsAiming', input.isAiming);
    });

    return null;
};
