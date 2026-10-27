
import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { ProjectileManagerHandle } from './ProjectileManager';
import { SandboxEntityHandle } from './SandboxEntity';
import { usePlayerControls } from './hooks/usePlayerControls';
import { usePlayerPhysics } from './hooks/usePlayerPhysics';
import { HIP_FIRE_DELAY, usePlayerCombat } from './hooks/usePlayerCombat';
import { Blueprint, DEFAULT_UPPER_BODY_BONE, LevelObject, UpperBodySettings } from '../../types';
import { createWeaponState, resolveWeapons, stepWeapons, type ResolvedWeapon } from '../../runtime/weapons';
import type { PlayerWeaponStatus } from '../../runtime/gameState';

const _rootTravel = new THREE.Vector3();

type WeaponClips = Pick<ResolvedWeapon, 'fireClip' | 'aimClip' | 'reloadClip'>;

/**
 * The upper-body clip for this frame: the reload clip while reloading, else the fire clip while
 * firing, else the aim clip while aiming, else none. The held weapon's clips come before the
 * blueprint's.
 */
export const upperBodyClip = (
    settings: UpperBodySettings | undefined,
    firing: boolean,
    aiming: boolean,
    weapon?: WeaponClips,
    reloading = false,
): string | null => {
    if (reloading && weapon?.reloadClip) return weapon.reloadClip;
    if (firing && !reloading) {
        const fire = weapon?.fireClip || settings?.fireClip;
        if (fire) return fire;
    }
    return (aiming && (weapon?.aimClip || settings?.aimClip)) || null;
};

interface PlayerControllerProps {
    apiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>;
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>;
    modelObject: THREE.Object3D;
    enabled: boolean;
    levelObjects: LevelObject[]; // Collision source when there is no physics world
    /** The player's blueprint; its 'Walk Speed' / 'Run Speed' stats set the movement speeds. */
    blueprint?: Pick<Blueprint, 'stats' | 'upperBody' | 'weapons' | 'aimView'>;
    onStaminaChange?: (val: number) => void;
    onAimChange?: (isAiming: boolean) => void;
    /** The held weapon and its ammunition, each time any of it changes. */
    onWeaponChange?: (status: PlayerWeaponStatus) => void;
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
    onWeaponChange,
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
    const { fireShots } = usePlayerCombat(
        modelObject,
        entityRef,
        projectileManager,
        weaponSounds,
        camera,
        weaponVolume
    );

    // The blueprint's weapons and what each has left; a blueprint without any fires the default weapon.
    const weapons = useMemo(() => resolveWeapons(blueprint?.weapons), [blueprint?.weapons]);
    const weaponState = useRef(createWeaponState(weapons));
    useEffect(() => { weaponState.current = createWeaponState(weapons); }, [weapons]);
    const weaponReport = useRef({ held: -1, status: '' });

    /** Shows the held weapon on the character and reports its ammunition, when either changed. */
    const reportWeapon = (held: number, weapon: ResolvedWeapon | undefined, reloading: boolean) => {
        const report = weaponReport.current;
        if (held !== report.held) {
            report.held = held;
            entityRef.current?.holdWeapon?.(held);
        }
        if (!weapon || !onWeaponChange) return;
        const ammo = weaponState.current.ammo[held];
        const status: PlayerWeaponStatus = {
            weapon: weapon.name, ammo: ammo?.loaded ?? 0, magazine: weapon.magazine, reserve: ammo?.reserve ?? -1, reloading,
        };
        const key = `${held}|${status.ammo}|${status.reserve}|${reloading}`;
        if (key === report.status) return;
        report.status = key;
        onWeaponChange(status);
    };

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

        // Weapons: switching, reloading and how many shots this frame fires. Aimed shots go at once;
        // the first hip-fire shot of a press waits for the firing pose.
        const weaponStep = stepWeapons(weaponState.current, weapons, {
            firing: input.isFiring,
            firePressed: input.firePressed,
            reloadPressed: input.reloadPressed,
            nextWeaponPressed: input.nextWeaponPressed,
            firstShotDelay: input.isAiming ? 0 : HIP_FIRE_DELAY,
        }, delta);
        const held = weaponState.current.active;
        const weapon = weapons[held];
        const reloading = weaponState.current.reloading > 0;
        reportWeapon(held, weapon, reloading);

        // Fire, aim and reload clips play from the spine up, over whatever the legs are doing.
        const upperBody = upperBodyClip(blueprint?.upperBody, input.isFiring, input.isAiming, weapon, reloading);
        if (upperBody !== upperBodyPlaying.current || weaponStep.reloadStarted) {
            upperBodyPlaying.current = upperBody;
            if (upperBody) {
                // A reload plays once; fire and aim clips loop while their button is held.
                const once = reloading && upperBody === weapon?.reloadClip;
                apiRef.current.playMontage?.(upperBody, {
                    maskBone: blueprint?.upperBody?.maskBone || DEFAULT_UPPER_BODY_BONE, loop: !once, blendIn: 0.12,
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
        // Over the shoulder the character is in view while aiming, so its muzzle flashes then too.
        if (weapon && weaponStep.shots > 0) fireShots(weapon, weaponStep.shots, input.isAiming, camera, blueprint?.aimView === 'shoulder');

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
        apiRef.current.setVariable('IsFiring', input.isFiring && !reloading);
        apiRef.current.setVariable('IsAiming', input.isAiming);
        apiRef.current.setVariable('IsReloading', reloading);
    });


    return null;
};
