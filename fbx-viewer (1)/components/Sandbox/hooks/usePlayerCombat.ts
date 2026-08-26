
import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { ProjectileManagerHandle } from '../ProjectileManager';
import { SandboxEntityHandle } from '../SandboxEntity';

interface CombatConfig {
    FIRE_RATE: number;
    FIRE_DELAY: number;
    PLAYER_DAMAGE: number;
}

const DEFAULT_CONFIG: CombatConfig = {
    FIRE_RATE: 0.15,
    FIRE_DELAY: 0.1, // Reduced for snappier feel
    PLAYER_DAMAGE: 10
};

export const usePlayerCombat = (
    modelObject: THREE.Object3D,
    entityRef: React.MutableRefObject<SandboxEntityHandle | null>,
    projectileManager: React.MutableRefObject<ProjectileManagerHandle | null>,
    weaponSounds: string[] = [], // URLs
    camera?: THREE.Camera, // For Attaching Audio Listener Context if needed
    baseVolume: number = 1.0
) => {
    const fireCooldown = useRef(0);
    const firingWarmup = useRef(0);
    const wasFiring = useRef(false);
    
    // Audio Buffers Cache
    const soundBuffers = useRef<THREE.AudioBuffer[]>([]);
    
    // Preload sounds
    useEffect(() => {
        if (!weaponSounds || weaponSounds.length === 0) return;
        
        const loader = new THREE.AudioLoader();
        soundBuffers.current = [];

        weaponSounds.forEach(url => {
            loader.load(url, (buffer) => {
                soundBuffers.current.push(buffer);
            }, undefined, (err) => console.error("Failed to load weapon sound", err));
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
            console.warn("AudioListener missing on camera. Gunshot audio failed.");
            return;
        }

        // CHANGE: Use Global Audio (2D) for the player's own weapon.
        // PositionalAudio attached to the muzzle creates distance attenuation (rolloff)
        // which sounds "muffled" or distant in 3rd person view (camera ~5m away).
        // 2D Audio ensures crisp, consistent feedback regardless of camera zoom.
        
        const sound = new THREE.Audio(listener);
        sound.setBuffer(buffer);
        sound.setVolume(Math.max(0, Math.min(2, baseVolume))); // Use configured volume
        
        // Optional: slight randomization of pitch for variety
        const detune = (Math.random() * 200) - 100; // +/- 100 cents
        sound.setDetune(detune);

        sound.play();
    };

    const updateCombat = (isFiring: boolean, isAiming: boolean, camera: THREE.Camera, delta: number) => {
        const { FIRE_RATE, FIRE_DELAY, PLAYER_DAMAGE } = DEFAULT_CONFIG;

        if (isFiring) {
            // Edge Detection: If triggers was just pressed
            if (!wasFiring.current) {
                // If aiming, shoot instantly. If hip firing, slight delay for animation
                firingWarmup.current = isAiming ? 0 : FIRE_DELAY; 
                fireCooldown.current = 0; 
            }

            if (firingWarmup.current > 0) {
                // Wait for animation to transition
                firingWarmup.current -= delta;
            } else {
                // Animation ready, process shots
                if (fireCooldown.current > 0) fireCooldown.current -= delta;

                if (fireCooldown.current <= 0) {
                    fireCooldown.current = FIRE_RATE;
                    
                    // Attempt to fire
                    if (entityRef.current && projectileManager.current) {
                        spawnProjectile(entityRef.current, projectileManager.current, modelObject, camera, isAiming, PLAYER_DAMAGE);
                        playGunshot(camera);
                    }
                }
            }
        }

        wasFiring.current = isFiring;
    };

    const spawnProjectile = (
        entity: SandboxEntityHandle, 
        manager: ProjectileManagerHandle, 
        model: THREE.Object3D,
        camera: THREE.Camera,
        isAiming: boolean,
        damage: number
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
            let spawn = entity.getSocketWorldPosition('Muzzle');
            
            // Trigger Visual Flash (Only in Hip Fire, or if visible)
            if (entity.triggerMuzzleFlash) {
                entity.triggerMuzzleFlash();
            }
            
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

        manager.fire(
            origin, 
            direction, 
            60, // Faster projectile for aim mode feel
            'Player', 
            damage
        );
    };

    return { updateCombat };
};
