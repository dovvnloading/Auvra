
import React, { useState, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { CharacterCameraRig } from './CharacterCameraRig';
import { SandboxEnvironment } from './SandboxEnvironment';
import { ProjectileManager, ProjectileManagerHandle } from './ProjectileManager';
import { SandboxEntity, SandboxEntityHandle } from './SandboxEntity';
import { PlayerController } from './PlayerController';
import { AIController } from './AIController';
import { AudioSystem } from '../Environment/AudioSystem'; // Import AudioSystem
import { Canvas } from '@react-three/fiber'; // Required for type safety implicitly or if reused
import { BloodSystem, BloodSystemHandle } from './BloodSystem';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { useSandboxConfiguration, SandboxConfiguration } from './hooks/useSandboxConfiguration';
import { useScene } from '../../context/SceneContext'; // Import context to access audioAssets

interface SandboxWorldProps {
    config: SandboxConfiguration;
    isPlaying: boolean;
    boundarySize: number;
    // Refs passed from parent for state coordination
    playerApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    enemyApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    playerEntityRef: React.RefObject<SandboxEntityHandle>;
    enemyEntityRef: React.RefObject<SandboxEntityHandle>;
    projectileManagerRef: React.RefObject<ProjectileManagerHandle>;
    onPlayerHealthChange: (current: number, max: number) => void;
    onStaminaChange: (val: number) => void;
    
    // Props passed down from UI for calibration
    aimOffset?: [number, number, number];
    onAimStateChange?: (isAiming: boolean) => void;
}

export const SandboxWorld: React.FC<SandboxWorldProps> = ({
    config,
    isPlaying,
    boundarySize,
    playerApiRef,
    enemyApiRef,
    playerEntityRef,
    enemyEntityRef,
    projectileManagerRef,
    onPlayerHealthChange,
    onStaminaChange,
    aimOffset = [0.5, 4.5, 1.0],
    onAimStateChange
}) => {
    const { 
        playerModel, enemyModel, 
        playerBlueprint, enemyBlueprint,
        playerAttachments, enemyAttachments,
        playerSockets, enemySockets,
        allClips 
    } = config;

    // Access global assets and level objects for audio
    const { audioAssets, levelObjects } = useScene(); 

    const [isAiming, setIsAiming] = useState(false);
    const [enemyDespawned, setEnemyDespawned] = useState(false);
    
    // VFX Systems
    const bloodSystemRef = useRef<BloodSystemHandle>(null);

    // Calculate Enemy Damage based on Blueprint
    const enemyDamage = useMemo(() => {
        if (!enemyBlueprint) return 10;
        const stat = enemyBlueprint.stats.find(s => s.name === 'Damage');
        return stat ? stat.value : 10;
    }, [enemyBlueprint]);

    // Resolve Weapon Sound URLs from Blueprint IDs
    const weaponSoundUrls = useMemo(() => {
        if (!playerBlueprint || !playerBlueprint.weaponSounds) return [];
        return playerBlueprint.weaponSounds
            .map(id => audioAssets.find(a => a.id === id)?.url)
            .filter((url): url is string => !!url);
    }, [playerBlueprint, audioAssets]);

    const handleEnemyAttack = () => {
        if (playerEntityRef.current) {
            // Rough estimation for melee hit point (center of player)
            const playerPos = playerModel?.object.position.clone() || new THREE.Vector3();
            playerPos.y += 1.5; 
            playerEntityRef.current.takeDamage(enemyDamage, playerPos);
        }
    };

    const handleSpawnBlood = (position: THREE.Vector3) => {
        if (bloodSystemRef.current) {
            bloodSystemRef.current.spawn(position);
        }
    };

    // Update parent about aim state changes
    const handleAimChange = (aiming: boolean) => {
        setIsAiming(aiming);
        if (onAimStateChange) onAimStateChange(aiming);
    };

    // Safety check for TS, though parent handles isValid
    if (!playerModel || !playerBlueprint) return null;

    return (
        <>
            {/* Camera */}
            <CharacterCameraRig 
                target={playerModel.object} 
                graph={playerBlueprint.animationGraph}
                active={isPlaying}
                isAiming={isAiming}
                aimOffset={aimOffset}
            />

            {/* Environment */}
            <SandboxEnvironment boundarySize={boundarySize} />

            {/* Audio System */}
            <AudioSystem 
                levelObjects={levelObjects} 
                audioAssets={audioAssets} 
                isMuted={false}
            />

            {/* VFX Systems */}
            <ProjectileManager ref={projectileManagerRef} />
            <BloodSystem ref={bloodSystemRef} />

            {/* Entities */}
            <SandboxEntity 
                ref={playerEntityRef}
                model={playerModel}
                blueprint={playerBlueprint}
                attachments={playerAttachments}
                sockets={playerSockets}
                allClips={allClips}
                startPosition={[-3, 0, 3]}
                startRotation={[0, Math.PI / 4, 0]}
                team="Player"
                color="#3b82f6"
                isAiming={isAiming}
                onApiReady={(api) => { playerApiRef.current = api; }}
                registerHittable={(t) => projectileManagerRef.current?.registerTarget(t)}
                unregisterHittable={(id) => projectileManagerRef.current?.unregisterTarget(id)}
                onHealthChange={onPlayerHealthChange}
                onSpawnBlood={handleSpawnBlood}
            />

            {/* In SANDBOX Mode, we render one specific enemy for testing */}
            {!enemyDespawned && enemyModel && enemyBlueprint && (
                <SandboxEntity 
                    ref={enemyEntityRef}
                    model={enemyModel}
                    blueprint={enemyBlueprint}
                    attachments={enemyAttachments}
                    sockets={enemySockets}
                    allClips={allClips}
                    startPosition={[3, 0, -3]}
                    startRotation={[0, -Math.PI / 4, 0]}
                    team="Enemy"
                    color="#ef4444"
                    onApiReady={(api) => { enemyApiRef.current = api; }}
                    registerHittable={(t) => projectileManagerRef.current?.registerTarget(t)}
                    unregisterHittable={(id) => projectileManagerRef.current?.unregisterTarget(id)}
                    onDespawn={() => setEnemyDespawned(true)}
                    onSpawnBlood={handleSpawnBlood}
                />
            )}

            {/* Logic Controllers (Only active when playing) */}
            {isPlaying && (
                <>
                    <PlayerController 
                        apiRef={playerApiRef}
                        entityRef={playerEntityRef as React.MutableRefObject<SandboxEntityHandle | null>}
                        projectileManager={projectileManagerRef as React.MutableRefObject<ProjectileManagerHandle | null>}
                        modelObject={playerModel.object}
                        enabled={true}
                        onStaminaChange={onStaminaChange}
                        onAimChange={handleAimChange}
                        weaponSounds={weaponSoundUrls}
                        weaponVolume={playerBlueprint.weaponVolume ?? 1.0}
                    />
                    
                    {/* AI Controller (Only runs if enemy is not despawned) */}
                    {!enemyDespawned && enemyModel && (
                        <AIController 
                            enemyApi={enemyApiRef}
                            enemyObject={enemyModel.object}
                            targetObject={playerModel.object}
                            boundarySize={boundarySize}
                            enabled={true}
                            onDealDamage={handleEnemyAttack}
                        />
                    )}
                </>
            )}
        </>
    );
};
