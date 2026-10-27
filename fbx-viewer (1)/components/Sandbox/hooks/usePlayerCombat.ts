
import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { ProjectileManagerHandle } from '../ProjectileManager';
import { SandboxEntityHandle } from '../SandboxEntity';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { releaseSound, routeSoundToBus, useRuntimeMixer } from '../../../runtime/components/audioComponents';
import type { ResolvedWeapon } from '../../../runtime/weapons';

/** Seconds the first hip-fire shot of a press waits for the firing pose to come up. */
export const HIP_FIRE_DELAY = 0.1;

const _spreadAxis = new THREE.Vector3();
const _spreadTurn = new THREE.Quaternion();

/**
 * `direction` turned away by a random angle of up to `degrees`, in a random direction around it:
 * the stray of an inaccurate shot.
 */
export const spreadDirection = (direction: THREE.Vector3, degrees: number, random: () => number = Math.random): THREE.Vector3 => {
    if (!(degrees > 0)) return direction;
    _spreadAxis.set(1, 0, 0);
    if (Math.abs(direction.x) > 0.9) _spreadAxis.set(0, 1, 0);
    _spreadAxis.cross(direction).normalize();
    // Round the aim, then out from it.
    _spreadAxis.applyQuaternion(_spreadTurn.setFromAxisAngle(direction, random() * Math.PI * 2));
    return direction.applyQuaternion(_spreadTurn.setFromAxisAngle(_spreadAxis, THREE.MathUtils.degToRad(degrees) * Math.sqrt(random()))).normalize();
};

export const usePlayerCombat = (
    modelObject: THREE.Object3D,
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>,
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>,
    weaponSounds: string[] = [], // URLs
    _camera?: THREE.Camera, // For Attaching Audio Listener Context if needed
    baseVolume: number = 1.0
) => {
    // Audio Buffers Cache
    const soundBuffers = useRef<AudioBuffer[]>([]);

    // Gunshots play on the mixer's sfx bus in play (plain listener output without runtime services).
    const mixer = useRuntimeMixer();
    const mixerRef = useRef(mixer);
    mixerRef.current = mixer;
    
    // Preload sounds
    useEffect(() => {
        if (!weaponSounds || weaponSounds.length === 0) return;
        
        const loader = new THREE.AudioLoader();
        soundBuffers.current = [];

        weaponSounds.forEach(url => {
            loader.load(url, (buffer) => {
                soundBuffers.current.push(buffer);
            }, undefined, (err) => frontendDiagnostics.failure('weapon_sound_load_failed', err));
        });
        
    }, [weaponSounds]);

    // Play a random sound from the loaded buffers
    const playGunshot = (camera: THREE.Camera) => {
        if (soundBuffers.current.length === 0) return;
        
        const buffer = soundBuffers.current[Math.floor(Math.random() * soundBuffers.current.length)];
        
        // Try finding listener on camera children first
        let listener = camera.children.find(c => c.type === 'AudioListener') as THREE.AudioListener;
        
        // If not found, log warning (PlayerController should have added it)
        if (!listener) {
            frontendDiagnostics.warning('weapon_audio_listener_missing');
            return;
        }

        // CHANGE: Use Global Audio (2D) for the player's own weapon.
        // PositionalAudio attached to the muzzle creates distance attenuation (rolloff)
        // which sounds "muffled" or distant in 3rd person view (camera ~5m away).
        // 2D Audio ensures crisp, consistent feedback regardless of camera zoom.
        
        const sound = new THREE.Audio(listener);
        routeSoundToBus(sound, mixerRef.current, 'sfx');
        sound.setBuffer(buffer);
        sound.setVolume(Math.max(0, Math.min(2, baseVolume))); // Use configured volume
        
        // Optional: slight randomization of pitch for variety
        const detune = (Math.random() * 200) - 100; // +/- 100 cents
        sound.setDetune(detune);

        // One-shot: detach its gain node from the bus once the shot finishes.
        const finish = sound.onEnded.bind(sound);
        sound.onEnded = () => {
            finish();
            releaseSound(sound);
        };
        sound.play();
    };

    /**
     * Fires `shots` shots of `weapon` (the weapon state decides how many this frame), each of its
     * pellets with its damage, speed and spread. `flashWhileAiming`: the character is in view while
     * aiming (over the shoulder), so the muzzle flashes then too.
     */
    const fireShots = (weapon: ResolvedWeapon, shots: number, isAiming: boolean, camera: THREE.Camera, flashWhileAiming = false) => {
        const entity = entityRef.current;
        const manager = projectileManager.current;
        if (!entity || !manager) return;
        for (let shot = 0; shot < shots; shot += 1) {
            if ((!isAiming || flashWhileAiming) && entity.triggerMuzzleFlash) entity.triggerMuzzleFlash(weapon.muzzleSocket);
            for (let pellet = 0; pellet < weapon.pellets; pellet += 1) {
                spawnProjectile(entity, manager, modelObject, camera, isAiming, weapon);
            }
            playGunshot(camera);
        }
    };

    const spawnProjectile = (
        entity: SandboxEntityHandle, 
        manager: ProjectileManagerHandle, 
        model: THREE.Object3D,
        camera: THREE.Camera,
        isAiming: boolean,
        weapon: ResolvedWeapon
    ) => {
        let origin: THREE.Vector3;
        let direction: THREE.Vector3;

        if (isAiming) {
            // FIRE FROM CAMERA CENTER (Accurate Scope Shot)
            origin = camera.position.clone();
            // Move origin slightly forward to avoid clipping with camera near plane or self
            const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            origin.addScaledVector(camForward, 1.0); 
            direction = camForward;
        } else {
            // HIP FIRE from Muzzle
            let spawn = entity.getSocketWorldPosition(weapon.muzzleSocket || 'Muzzle');

            if (!spawn) {
                // Fallback: Fire from chest height forward
                const fallbackPos = model.position.clone().add(new THREE.Vector3(0, 1.5, 0));
                // Use model rotation
                const fallbackDir = new THREE.Vector3(0, 0, 1).applyQuaternion(model.quaternion);
                
                fallbackPos.addScaledVector(fallbackDir, 0.5);
                spawn = { position: fallbackPos, direction: fallbackDir };
            }
            origin = spawn.position;
            direction = spawn.direction;
        }

        // Aiming steadies the weapon: a quarter of its spread.
        spreadDirection(direction, isAiming ? weapon.spread / 4 : weapon.spread);
        manager.fire(origin, direction, weapon.projectileSpeed, 'Player', weapon.damage);
    };

    return { fireShots };
};
