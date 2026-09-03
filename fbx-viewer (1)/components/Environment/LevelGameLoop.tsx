
import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { Environment, PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { SkeletonUtils } from 'three-stdlib';
import { useScene } from '../../context/SceneContext';
import { InstancedLevelLayer } from './InstancedLevelLayer';
import { AudioSystem } from './AudioSystem';
import { SkySystem } from './SkySystem'; // Added Import
import { SandboxEntity, SandboxEntityHandle } from '../Sandbox/SandboxEntity';
import { PlayerController } from '../Sandbox/PlayerController';
import { AIController } from '../Sandbox/AIController';
import { CharacterCameraRig } from '../Sandbox/CharacterCameraRig';
import { SandboxUI } from '../Sandbox/SandboxUI';
import { ProjectileManager, ProjectileManagerHandle } from '../Sandbox/ProjectileManager';
import { BloodSystem, BloodSystemHandle } from '../Sandbox/BloodSystem';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { useSandboxConfiguration } from '../Sandbox/hooks/useSandboxConfiguration';
import { useNotification } from '../../context/NotificationContext';
import { useLevelBlueprintRuntime } from '../../hooks/useLevelBlueprintRuntime';
import { LevelObject, LoadedModelData, Blueprint, AttachmentData, SocketData } from '../../types';
import { TerrainObject } from './Terrain/TerrainObject';
import { frontendDiagnostics } from '../../diagnostics/runtime';

interface LevelGameLoopProps {
    onExit: () => void;
    spawnPosition?: THREE.Vector3;
}

// Helper to bundle all necessary assets for a specific enemy type
interface EnemyAssetBundle {
    model: LoadedModelData;
    blueprint: Blueprint;
    attachments: AttachmentData[];
    sockets: SocketData[];
}

// --- INTERNAL COMPONENT: SPAWNER SYSTEM ---
const SpawnerSystem: React.FC<{
    levelObjects: LevelObject[];
    isGameOver: boolean;
    onSpawn: (data: { blueprintId: string; position: [number, number, number]; rotation: [number, number, number]; spawnerId: string }) => void;
}> = ({ levelObjects, isGameOver, onSpawn }) => {
    const spawnerState = useRef<Map<string, { timer: number, count: number }>>(new Map());

    useFrame((state, delta) => {
        if (isGameOver) return;

        levelObjects.forEach(obj => {
            if (obj.type === 'spawn_point' && obj.spawnConfig) {
                const cfg = obj.spawnConfig;
                if (!cfg.blueprintId) return;

                if (!spawnerState.current.has(obj.id)) {
                    spawnerState.current.set(obj.id, { timer: 0, count: 0 });
                }

                const sState = spawnerState.current.get(obj.id)!;

                if (cfg.maxSpawns > 0 && sState.count >= cfg.maxSpawns) return;

                sState.timer += delta;

                if (sState.timer >= cfg.interval) {
                    sState.timer = 0;
                    sState.count++;

                    onSpawn({
                        blueprintId: cfg.blueprintId,
                        position: obj.position,
                        rotation: obj.rotation,
                        spawnerId: obj.id
                    });
                }
            }
        });
    });

    return null;
};

// --- INTERNAL COMPONENT: LOGIC SYSTEM ---
const LevelLogicSystem: React.FC<any> = (props) => {
    useLevelBlueprintRuntime(props);
    return null;
};

/**
 * LEVEL GAME LOOP
 */
export const LevelGameLoop: React.FC<LevelGameLoopProps> = ({ onExit, spawnPosition }) => {
    const { levelObjects, models, activeLevelBlueprint, removeLevelObject, blueprints, attachments, sockets, audioAssets } = useScene();
    const { addNotification } = useNotification();
    
    // Config
    const config = useSandboxConfiguration();
    const { 
        playerModel, playerBlueprint, 
        playerAttachments, playerSockets, 
        allClips 
    } = config;

    // --- References & State ---
    const playerApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const playerEntityRef = useRef<SandboxEntityHandle>(null);
    const projectileManagerRef = useRef<ProjectileManagerHandle>(null);
    const bloodSystemRef = useRef<BloodSystemHandle>(null);

    const [playerStats, setPlayerStats] = useState({ health: 100, maxHealth: 100, stamina: 100 });
    const [isAiming, setIsAiming] = useState(false);
    const [restartKey, setRestartKey] = useState(0);
    const [isGameOver, setIsGameOver] = useState(false);

    // --- Rendering Quality State ---
    // highQuality: requested by user. 
    // dpr: actual device pixel ratio (scaled down on low perf).
    const [highQuality, setHighQuality] = useState(true);
    const [dpr, setDpr] = useState(1.5); 

    // --- CALCULATE ALL SCENE CLIPS ---
    const allSceneClips = useMemo(() => {
        return models.flatMap(m => m.animations || []);
    }, [models]);

    // --- RESOLVE WEAPON AUDIO ---
    const weaponSoundUrls = useMemo(() => {
        if (!playerBlueprint || !playerBlueprint.weaponSounds) return [];
        return playerBlueprint.weaponSounds
            .map(id => audioAssets.find(a => a.id === id)?.url)
            .filter((url): url is string => !!url);
    }, [playerBlueprint, audioAssets]);

    // --- VFX HANDLERS ---
    const handleSpawnBlood = useCallback((position: THREE.Vector3) => {
        bloodSystemRef.current?.spawn(position);
    }, []);

    // --- PLAYER INSTANCING ---
    const runtimePlayerModel = useMemo(() => {
        if (!playerModel || !playerModel.object) return null;
        try {
            const clonedObject = SkeletonUtils.clone(playerModel.object) as THREE.Group;
            clonedObject.position.set(0,0,0);
            clonedObject.rotation.set(0,0,0);
            clonedObject.scale.set(1,1,1);
            return { ...playerModel, object: clonedObject, id: `runtime_player_${restartKey}` };
        } catch(e) {
            frontendDiagnostics.failure('player_model_clone_failed', e);
            return null;
        }
    }, [playerModel, restartKey]);

    // --- DYNAMIC SPAWN SYSTEM ---
    const [spawnedEnemies, setSpawnedEnemies] = useState<{
        instanceId: string;
        blueprintId: string;
        position: [number, number, number];
        rotation: [number, number, number];
        spawnerId: string;
    }[]>([]);

    const handleSpawn = useCallback((data: { blueprintId: string; position: [number, number, number]; rotation: [number, number, number]; spawnerId: string }) => {
        setSpawnedEnemies(prev => [...prev, {
            instanceId: crypto.randomUUID(),
            ...data
        }]);
    }, []);

    const resolveEnemyAssets = useCallback((blueprintId: string): EnemyAssetBundle | null => {
        const bp = blueprints.find(b => b.id === blueprintId);
        if (!bp || !bp.linkedModelId) return null;
        const model = models.find(m => m.id === bp.linkedModelId);
        if (!model) return null;
        return {
            model,
            blueprint: bp,
            attachments: attachments.filter(a => a.parentModelId === model.id),
            sockets: sockets.filter(s => s.parentModelId === model.id)
        };
    }, [blueprints, models, attachments, sockets]);

    const startPos = useMemo(() => 
        spawnPosition ? [spawnPosition.x, 0.5, spawnPosition.z] as [number, number, number] : [0, 0.5, 0] as [number, number, number], 
    [spawnPosition]);

    const { foliageObjects, propObjects, terrainObjects } = useMemo(() => {
        const foliage: any[] = [];
        const props: any[] = [];
        const terrains: any[] = [];
        levelObjects.forEach(obj => {
            if (obj.type === 'foliage') foliage.push(obj);
            else if (obj.type === 'prop') props.push(obj);
            else if (obj.type === 'terrain') terrains.push(obj);
        });
        return { foliageObjects: foliage, propObjects: props, terrainObjects: terrains };
    }, [levelObjects]);

    const handleRestart = useCallback(() => {
        setIsGameOver(false);
        setIsAiming(false);
        setPlayerStats(prev => ({ ...prev, health: 100, stamina: 100 }));
        setSpawnedEnemies([]); 
        setRestartKey(prev => prev + 1);
        setTimeout(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.requestPointerLock();
        }, 100);
    }, []);

    useEffect(() => {
        if (playerStats.health <= 0 && !isGameOver) {
            setIsGameOver(true);
            document.exitPointerLock(); 
        }
    }, [playerStats.health, isGameOver]);

    useEffect(() => {
        const timer = setTimeout(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.requestPointerLock();
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (isGameOver) return;
                document.exitPointerLock();
                onExit();
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [onExit, isGameOver]);

    if (!runtimePlayerModel || !playerBlueprint) {
        return (
            <div className="flex items-center justify-center h-full text-red-400 flex-col gap-2">
                <span className="font-bold">Player Configuration Missing</span>
                <span className="text-xs">Ensure a Player Blueprint and Linked Model exist in the project.</span>
                <button onClick={onExit} className="px-4 py-2 bg-gray-800 rounded text-white mt-4">Back to Editor</button>
            </div>
        );
    }

    return (
        <div className="relative w-full h-full bg-black cursor-none">
            <AuvraCanvas
                surfaceId="runtime-level-game-loop"
                role="runtime"
                shadows 
                camera={{ fov: 60 }} 
                dpr={dpr} // Dynamic DPI scaling based on performance
                key={restartKey}
                gl={{ 
                    powerPreference: 'high-performance', 
                    antialias: false, // Disable MSAA to allow PostProcessing (SMAA/Bloom) to work efficiently
                    stencil: false,
                    depth: true
                }}
            >
                {/* AUTO-FALLBACK: Monitoring FPS to adjust quality */}
                <PerformanceMonitor 
                    onIncline={() => setDpr(2)} 
                    onDecline={() => setDpr(1)} 
                    flipflops={3} 
                    onFallback={() => {
                        frontendDiagnostics.warning('renderer_quality_reduced');
                        setHighQuality(false); // Force low quality
                    }}
                />

                {/* --- Replaced Hardcoded Lights with SkySystem --- */}
                <SkySystem levelObjects={levelObjects} />

                {/* --- GPU POST PROCESSING PIPELINE --- */}
                {highQuality && (
                    <EffectComposer enableNormalPass={false}>
                        <Bloom luminanceThreshold={1.2} mipmapBlur intensity={0.6} />
                        <Vignette eskil={false} offset={0.1} darkness={1.1} />
                        {/* Additional effects like ToneMapping, Noise, or SMAA can be added here */}
                    </EffectComposer>
                )}

                <group>
                    {/* Render Terrain */}
                    {terrainObjects.map(terrain => (
                        <TerrainObject 
                            key={terrain.id} 
                            data={terrain} 
                            isSelected={false} 
                            visible={true}
                            castShadow
                            receiveShadow
                            sculptingEnabled={false}
                        />
                    ))}

                    <InstancedLevelLayer models={models} levelObjects={foliageObjects} interactive={false} />
                    <InstancedLevelLayer models={models} levelObjects={propObjects} interactive={false} />
                </group>

                <AudioSystem 
                    levelObjects={levelObjects} 
                    audioAssets={audioAssets}
                    isMuted={false} 
                />

                <BloodSystem ref={bloodSystemRef} />
                <ProjectileManager ref={projectileManagerRef} />

                <SandboxEntity 
                    ref={playerEntityRef}
                    model={runtimePlayerModel}
                    blueprint={playerBlueprint}
                    attachments={playerAttachments}
                    sockets={playerSockets}
                    allClips={allClips} 
                    startPosition={startPos}
                    startRotation={[0, 0, 0]}
                    team="Player"
                    color="#3b82f6"
                    isAiming={isAiming}
                    onApiReady={(api) => { playerApiRef.current = api; }}
                    registerHittable={(t) => projectileManagerRef.current?.registerTarget(t)}
                    unregisterHittable={(id) => projectileManagerRef.current?.unregisterTarget(id)}
                    onHealthChange={(current, max) => setPlayerStats(prev => ({ ...prev, health: current, maxHealth: max }))}
                    onSpawnBlood={handleSpawnBlood}
                />

                {spawnedEnemies.map((enemyData) => {
                    const assets = resolveEnemyAssets(enemyData.blueprintId);
                    if (!assets) return null;

                    return (
                        <RuntimeEnemyController 
                            key={enemyData.instanceId}
                            data={enemyData}
                            assets={assets}
                            playerObject={runtimePlayerModel.object}
                            projectileManagerRef={projectileManagerRef}
                            boundarySize={50}
                            enabled={!isGameOver}
                            onDespawn={() => setSpawnedEnemies(prev => prev.filter(e => e.instanceId !== enemyData.instanceId))}
                            allSceneClips={allSceneClips} 
                            onSpawnBlood={handleSpawnBlood}
                        />
                    );
                })}

                <PlayerController 
                    apiRef={playerApiRef}
                    entityRef={playerEntityRef}
                    projectileManager={projectileManagerRef}
                    modelObject={runtimePlayerModel.object}
                    enabled={!isGameOver}
                    onStaminaChange={(val) => setPlayerStats(prev => ({ ...prev, stamina: val }))}
                    onAimChange={setIsAiming}
                    weaponSounds={weaponSoundUrls}
                    weaponVolume={playerBlueprint.weaponVolume ?? 1.0}
                />
                
                <LevelLogicSystem 
                    blueprint={activeLevelBlueprint}
                    levelObjects={levelObjects}
                    playerEntityRef={playerEntityRef}
                    playerApiRef={playerApiRef}
                    enemyApiRef={{ current: undefined } as any}
                    removeLevelObject={removeLevelObject}
                    addNotification={addNotification}
                    onRestart={handleRestart}
                    onEndLevel={onExit}
                />

                <SpawnerSystem 
                    levelObjects={levelObjects}
                    isGameOver={isGameOver}
                    onSpawn={handleSpawn}
                />

                <CharacterCameraRig 
                    target={runtimePlayerModel.object} 
                    graph={playerBlueprint.animationGraph}
                    active={!isGameOver}
                    isAiming={isAiming}
                    aimOffset={playerBlueprint.aimOffset || [0.5, 4.5, 1.0]}
                />
            </AuvraCanvas>

            <SandboxUI 
                isPlaying={true}
                isGameOver={isGameOver}
                onStart={handleRestart}
                onStop={onExit}
                playerBlueprint={playerBlueprint}
                enemyBlueprint={playerBlueprint} 
                playerModel={playerModel} 
                enemyModel={undefined} 
                playerStats={playerStats}
                isAiming={isAiming}
                highQuality={highQuality}
                onToggleQuality={() => setHighQuality(!highQuality)}
            />
        </div>
    );
};

const RuntimeEnemyController: React.FC<{
    data: any;
    assets: EnemyAssetBundle;
    playerObject: THREE.Object3D;
    projectileManagerRef: React.RefObject<ProjectileManagerHandle | null>;
    boundarySize: number;
    enabled: boolean;
    onDespawn: () => void;
    allSceneClips: THREE.AnimationClip[];
    onSpawnBlood: (pos: THREE.Vector3) => void;
}> = ({ data, assets, playerObject, projectileManagerRef, boundarySize, enabled, onDespawn, allSceneClips, onSpawnBlood }) => {
    const apiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const entityRef = useRef<SandboxEntityHandle>(null);

    const instanceModel = useMemo(() => {
        try {
            const clonedObject = SkeletonUtils.clone(assets.model.object) as THREE.Group;
            clonedObject.position.set(0, 0, 0);
            clonedObject.rotation.set(0, 0, 0);
            clonedObject.scale.set(1, 1, 1);
            return {
                ...assets.model,
                id: `instance_${data.instanceId}_${assets.model.id}`,
                object: clonedObject
            };
        } catch(e) {
            frontendDiagnostics.failure('enemy_model_clone_failed', e);
            return null;
        }
    }, [assets.model, data.instanceId]);

    const handleAttack = () => {
        if (entityRef.current) {
            const dist = entityRef.current.object.position.distanceTo(playerObject.position);
            if (dist < 2.5) { }
        }
    };

    if (!instanceModel) return null;

    return (
        <>
            <SandboxEntity 
                ref={entityRef}
                model={instanceModel}
                blueprint={assets.blueprint}
                attachments={assets.attachments}
                sockets={assets.sockets}
                allClips={allSceneClips} 
                startPosition={data.position}
                startRotation={data.rotation}
                team="Enemy"
                color="#ef4444"
                onApiReady={(api) => { apiRef.current = api; }}
                registerHittable={(t) => projectileManagerRef.current?.registerTarget(t)}
                unregisterHittable={(id) => projectileManagerRef.current?.unregisterTarget(id)}
                onDespawn={onDespawn}
                onSpawnBlood={onSpawnBlood}
            />
            
            <AIController 
                enemyApi={apiRef}
                enemyObject={instanceModel.object}
                targetObject={playerObject}
                boundarySize={boundarySize}
                enabled={enabled}
                onDealDamage={handleAttack}
            />
        </>
    );
};
