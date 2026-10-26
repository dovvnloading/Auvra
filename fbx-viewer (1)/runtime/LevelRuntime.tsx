import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { SkeletonUtils } from 'three-stdlib';
import { AuvraCanvas } from '../renderer/AuvraCanvas';
import { InstancedLevelLayer } from '../components/Environment/InstancedLevelLayer';
import { AudioSystem } from '../components/Environment/AudioSystem';
import { SkySystem } from '../components/Environment/SkySystem';
import { TerrainObject } from '../components/Environment/Terrain/TerrainObject';
import { SandboxEntity, SandboxEntityHandle } from '../components/Sandbox/SandboxEntity';
import { PlayerController } from '../components/Sandbox/PlayerController';
import { AIController } from '../components/Sandbox/AIController';
import { CharacterCameraRig } from '../components/Sandbox/CharacterCameraRig';
import { SandboxUI } from '../components/Sandbox/SandboxUI';
import { ProjectileManager, ProjectileManagerHandle } from '../components/Sandbox/ProjectileManager';
import { BloodSystem, BloodSystemHandle } from '../components/Sandbox/BloodSystem';
import { applyMeleeHit, resolveBlueprintDamage } from '../components/Sandbox/combat';
import { GraphRuntimeAPI } from '../components/AnimationGraph/GraphRuntime';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../hooks/useLevelBlueprintRuntime';
import { useRuntimeLevelWorld } from '../hooks/useRuntimeLevelWorld';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { AttachmentData, Blueprint, LevelObject, LoadedModelData, SocketData } from '../types';
import { useGameContent } from './GameContentContext';
import { gameState, useGameState } from './gameState';
import { PauseController } from './PauseController';
import type { GameContent, LevelRuntimeProps, PlayerStart, RuntimeHost, RuntimeLevel, SaveGameData } from './types';

type Vec3 = [number, number, number];

/** A blueprint with the model, attachments and sockets it needs to spawn. */
interface ActorAssetBundle {
    model: LoadedModelData;
    blueprint: Blueprint;
    attachments: AttachmentData[];
    sockets: SocketData[];
}

interface SpawnRequest {
    blueprintId: string;
    position: Vec3;
    rotation: Vec3;
    spawnerId: string;
}

interface SpawnedEnemy extends SpawnRequest {
    instanceId: string;
}

const ORIGIN_START: PlayerStart = { position: [0, 0.5, 0], rotation: [0, 0, 0] };

const RUNTIME_GL = {
    powerPreference: 'high-performance',
    antialias: false, // Disable MSAA to allow PostProcessing (SMAA/Bloom) to work efficiently
    stencil: false,
    depth: true
} as const;

const resolveActorAssets = (content: GameContent, blueprint: Blueprint | undefined): ActorAssetBundle | null => {
    if (!blueprint || !blueprint.linkedModelId) return null;
    const model = content.models.find(m => m.id === blueprint.linkedModelId);
    if (!model) return null;
    return {
        model,
        blueprint,
        attachments: content.attachments.filter(a => a.parentModelId === model.id),
        sockets: content.sockets.filter(s => s.parentModelId === model.id)
    };
};

/** The game settings' player blueprint, falling back to the first Player Character blueprint. */
const resolvePlayerAssets = (content: GameContent, playerBlueprintId: string | null): ActorAssetBundle | null => {
    const chosen = playerBlueprintId ? content.blueprints.find(bp => bp.id === playerBlueprintId) : undefined;
    return resolveActorAssets(content, chosen ?? content.blueprints.find(bp => bp.type === 'Player Character'));
};

/** Load game position, then the host's start, then the level's Player Start, then the origin. */
const resolvePlayerStart = (level: RuntimeLevel, playerStart: PlayerStart | null, restore: SaveGameData | null | undefined): PlayerStart => {
    if (restore) return { position: restore.player.position, rotation: restore.player.rotation };
    if (playerStart) return playerStart;
    const authored = level.objects.find(obj => obj.type === 'player_start');
    return authored ? { position: authored.position, rotation: authored.rotation } : ORIGIN_START;
};

// --- INTERNAL COMPONENT: SPAWNER SYSTEM ---
const SpawnerSystem: React.FC<{
    levelObjects: LevelObject[];
    isGameOver: boolean;
    onSpawn: (data: SpawnRequest) => void;
}> = ({ levelObjects, isGameOver, onSpawn }) => {
    const spawnerState = useRef<Map<string, { timer: number, count: number }>>(new Map());

    useFrame((_state, delta) => {
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
const LevelLogicSystem: React.FC<UseLevelBlueprintRuntimeProps> = (props) => {
    useLevelBlueprintRuntime(props);
    return null;
};

/** Keeps the camera's field of view on the game settings, including changes made while playing. */
const CameraSettings: React.FC<{ fov: number }> = ({ fov }) => {
    const camera = useThree(state => state.camera);
    useEffect(() => {
        if (!(camera instanceof THREE.PerspectiveCamera) || camera.fov === fov) return;
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }, [camera, fov]);
    return null;
};

/** SandboxUI's built-in HUD, used when the host gives no overlay. Subscribes on its own so stat changes do not re-render the world. */
const FallbackHud: React.FC<{
    player: ActorAssetBundle;
    isGameOver: boolean;
    highQuality: boolean;
    onToggleQuality: () => void;
    host: RuntimeHost;
}> = ({ player, isGameOver, highQuality, onToggleQuality, host }) => {
    const stats = useGameState(state => state.player);
    return (
        <SandboxUI
            isPlaying={true}
            isGameOver={isGameOver}
            onStart={host.restartLevel}
            onStop={host.endLevel}
            playerBlueprint={player.blueprint}
            enemyBlueprint={player.blueprint}
            playerModel={player.model}
            enemyModel={undefined}
            playerStats={stats}
            isAiming={stats.isAiming}
            highQuality={highQuality}
            onToggleQuality={onToggleQuality}
        />
    );
};

interface LevelSessionProps {
    level: RuntimeLevel;
    content: GameContent;
    player: ActorAssetBundle;
    start: PlayerStart;
    restore: SaveGameData | null | undefined;
    host: RuntimeHost;
    sessionKey: number;
    isGameOver: boolean;
    paused: boolean;
    onGameOver: () => void;
}

/**
 * One play session of a level. Mounted under a group keyed by the session key, so a restart or a load
 * starts from a fresh runtime copy: BeginPlay, overlaps, spawner counts and spawned enemies all reset.
 */
const LevelSession: React.FC<LevelSessionProps> = ({ level, content, player, start, restore, host, sessionKey, isGameOver, paused, onGameOver }) => {
    const { models, audioAssets } = content;
    // Fixed for the session: a host that rebuilds these objects must not teleport the player mid-session.
    const [sessionStart] = useState(start);
    const [sessionRestore] = useState(restore);

    // A loaded game starts without the actors its save recorded as destroyed.
    const authoredObjects = useMemo(() => {
        const destroyed = new Set(sessionRestore?.destroyedObjectIds ?? []);
        return destroyed.size ? level.objects.filter(obj => !destroyed.has(obj.id)) : level.objects;
    }, [level.objects, sessionRestore]);

    // Play runs on a session copy of the level; the authored objects are never changed by gameplay.
    const {
        objects: runtimeLevelObjects,
        destroyObject: destroyRuntimeObject
    } = useRuntimeLevelWorld(authoredObjects);

    // --- References & State ---
    const playerApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    // Level play has no single enemy instance, so 'Enemy'-targeted variable nodes resolve to nothing.
    const enemyApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const playerEntityRef = useRef<SandboxEntityHandle>(null);
    const projectileManagerRef = useRef<ProjectileManagerHandle>(null);
    const bloodSystemRef = useRef<BloodSystemHandle>(null);

    const [isAiming, setIsAiming] = useState(false);
    const [spawnedEnemies, setSpawnedEnemies] = useState<SpawnedEnemy[]>([]);

    // Layout effect: runs before the entities' first stat reports, so it never overwrites them.
    useLayoutEffect(() => {
        gameState.update({
            levelId: level.id,
            player: { health: 100, maxHealth: 100, stamina: 100, isAiming: false },
            vars: sessionRestore?.variables
        });
    }, [level.id, sessionRestore]);

    // --- CALCULATE ALL SCENE CLIPS ---
    const allSceneClips = useMemo(() => models.flatMap(m => m.animations || []), [models]);

    // --- RESOLVE WEAPON AUDIO ---
    const weaponSoundUrls = useMemo(() => {
        if (!player.blueprint.weaponSounds) return [];
        return player.blueprint.weaponSounds
            .map(id => audioAssets.find(a => a.id === id)?.url)
            .filter((url): url is string => !!url);
    }, [player.blueprint, audioAssets]);

    // --- VFX HANDLERS ---
    const handleSpawnBlood = useCallback((position: THREE.Vector3) => {
        bloodSystemRef.current?.spawn(position);
    }, []);

    // --- HUD STATS ---
    // Published to the runtime game state, which skips unchanged values, so stat reports do not re-render the play tree.
    const handlePlayerHealthChange = useCallback((current: number, max: number) => {
        gameState.update({ player: { health: current, maxHealth: max } });
        if (current <= 0) onGameOver();
    }, [onGameOver]);

    const handleStaminaChange = useCallback((stamina: number) => {
        gameState.update({ player: { stamina } });
    }, []);

    const handleAimChange = useCallback((aiming: boolean) => {
        setIsAiming(aiming);
        gameState.update({ player: { isAiming: aiming } });
    }, []);

    const handlePlayerHit = useCallback((damage: number) => {
        applyMeleeHit(playerEntityRef.current, damage);
    }, []);

    // Stable, so a dead enemy's despawn timer is not restarted by unrelated re-renders.
    const handleEnemyDespawn = useCallback((instanceId: string) => {
        setSpawnedEnemies(prev => prev.filter(e => e.instanceId !== instanceId));
    }, []);

    // Blueprint Print String goes to the host's output.
    const handleNotification = useCallback((notification: { message: string; type?: 'info' | 'success' | 'warning' | 'error' }) => {
        host.print(notification.message, notification.type);
    }, [host]);

    // --- PLAYER INSTANCING ---
    const runtimePlayerModel = useMemo(() => {
        try {
            const clonedObject = SkeletonUtils.clone(player.model.object) as THREE.Group;
            clonedObject.position.set(0, 0, 0);
            clonedObject.rotation.set(0, 0, 0);
            clonedObject.scale.set(1, 1, 1);
            return { ...player.model, object: clonedObject, id: `runtime_player_${sessionKey}` };
        } catch (e) {
            frontendDiagnostics.failure('player_model_clone_failed', e);
            return null;
        }
    }, [player.model, sessionKey]);

    // --- DYNAMIC SPAWN SYSTEM ---
    const handleSpawn = useCallback((data: SpawnRequest) => {
        setSpawnedEnemies(prev => [...prev, {
            instanceId: crypto.randomUUID(),
            ...data
        }]);
    }, []);

    const resolveEnemyAssets = useCallback((blueprintId: string): ActorAssetBundle | null => (
        resolveActorAssets(content, content.blueprints.find(b => b.id === blueprintId))
    ), [content]);

    const { foliageObjects, propObjects, terrainObjects } = useMemo(() => {
        const foliage: LevelObject[] = [];
        const props: LevelObject[] = [];
        const terrains: LevelObject[] = [];
        runtimeLevelObjects.forEach(obj => {
            if (obj.type === 'foliage') foliage.push(obj);
            else if (obj.type === 'prop') props.push(obj);
            else if (obj.type === 'terrain') terrains.push(obj);
        });
        return { foliageObjects: foliage, propObjects: props, terrainObjects: terrains };
    }, [runtimeLevelObjects]);

    if (!runtimePlayerModel) return null;

    const controlsEnabled = !isGameOver && !paused;

    return (
        <>
            {/* --- Replaced Hardcoded Lights with SkySystem --- */}
            <SkySystem levelObjects={runtimeLevelObjects} />

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
                levelObjects={runtimeLevelObjects}
                audioAssets={audioAssets}
                isMuted={false}
            />

            <BloodSystem ref={bloodSystemRef} />
            <ProjectileManager ref={projectileManagerRef} />

            <SandboxEntity
                ref={playerEntityRef}
                model={runtimePlayerModel}
                blueprint={player.blueprint}
                attachments={player.attachments}
                sockets={player.sockets}
                allClips={allSceneClips}
                startPosition={sessionStart.position}
                startRotation={sessionStart.rotation}
                team="Player"
                color="#3b82f6"
                isAiming={isAiming}
                onApiReady={(api) => { playerApiRef.current = api; }}
                registerHittable={(t) => projectileManagerRef.current?.registerTarget(t)}
                unregisterHittable={(id) => projectileManagerRef.current?.unregisterTarget(id)}
                onHealthChange={handlePlayerHealthChange}
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
                        onDespawn={handleEnemyDespawn}
                        allSceneClips={allSceneClips}
                        onSpawnBlood={handleSpawnBlood}
                        onHitPlayer={handlePlayerHit}
                    />
                );
            })}

            <PlayerController
                apiRef={playerApiRef}
                entityRef={playerEntityRef}
                projectileManager={projectileManagerRef}
                modelObject={runtimePlayerModel.object}
                enabled={controlsEnabled}
                levelObjects={runtimeLevelObjects}
                onStaminaChange={handleStaminaChange}
                onAimChange={handleAimChange}
                weaponSounds={weaponSoundUrls}
                weaponVolume={player.blueprint.weaponVolume ?? 1.0}
            />

            <LevelLogicSystem
                blueprint={level.blueprint}
                levelObjects={runtimeLevelObjects}
                playerEntityRef={playerEntityRef}
                playerApiRef={playerApiRef}
                enemyApiRef={enemyApiRef}
                destroyActor={destroyRuntimeObject}
                addNotification={handleNotification}
                onRestart={host.restartLevel}
                onEndLevel={host.endLevel}
                host={host}
            />

            <SpawnerSystem
                levelObjects={runtimeLevelObjects}
                isGameOver={isGameOver}
                onSpawn={handleSpawn}
            />

            <CharacterCameraRig
                target={runtimePlayerModel.object}
                graph={player.blueprint.animationGraph}
                active={controlsEnabled}
                isAiming={isAiming}
                aimOffset={player.blueprint.aimOffset || [0.5, 4.5, 1.0]}
            />
        </>
    );
};

/**
 * LEVEL RUNTIME
 *
 * Plays one level. Shared by play-in-editor and the standalone player: content comes from the
 * runtime content context, flow control (restart, end, open level, save, load, pause) from the host.
 */
export const LevelRuntime: React.FC<LevelRuntimeProps> = ({ level, settings, playerStart, paused, host, sessionKey, overlay, restore }) => {
    const content = useGameContent();
    const player = useMemo(() => resolvePlayerAssets(content, settings.playerBlueprintId), [content, settings.playerBlueprintId]);
    const start = useMemo(() => resolvePlayerStart(level, playerStart, restore), [level, playerStart, restore]);

    // Gameplay keeps one host for the whole run, so a host that is re-created every render cannot restart the world.
    const hostRef = useRef(host);
    useLayoutEffect(() => {
        hostRef.current = host;
    }, [host]);
    const runtimeHost = useMemo<RuntimeHost>(() => ({
        print: (message, type) => hostRef.current.print(message, type),
        restartLevel: () => hostRef.current.restartLevel(),
        endLevel: () => hostRef.current.endLevel(),
        openLevel: (levelId) => hostRef.current.openLevel(levelId),
        saveGame: (slot) => hostRef.current.saveGame(slot),
        loadGame: (slot) => hostRef.current.loadGame(slot),
        requestPause: () => hostRef.current.requestPause()
    }), []);

    // Game over belongs to the session that reported it, so a new session key clears it.
    const [gameOverSession, setGameOverSession] = useState<number | null>(null);
    const isGameOver = gameOverSession === sessionKey;
    const handleGameOver = useCallback(() => setGameOverSession(sessionKey), [sessionKey]);

    // --- Rendering Quality State ---
    // highQuality: requested by the player; dprLevel: scaled down on low performance, capped by the settings.
    const [highQuality, setHighQuality] = useState(true);
    const [dprLevel, setDprLevel] = useState(1.5);
    const maxDpr = Math.max(0.5, settings.quality.maxDpr);
    const dpr = Math.min(dprLevel, maxDpr);
    const toggleQuality = useCallback(() => setHighQuality(prev => !prev), []);

    if (!player) {
        return (
            <div className="flex items-center justify-center h-full text-red-400 flex-col gap-2">
                <span className="font-bold">Player Configuration Missing</span>
                <span className="text-xs">Ensure a Player Blueprint and Linked Model exist in the project.</span>
                <button onClick={runtimeHost.endLevel} className="px-4 py-2 bg-gray-800 rounded text-white mt-4">Exit</button>
            </div>
        );
    }

    return (
        <div className="relative w-full h-full bg-black cursor-none">
            <AuvraCanvas
                surfaceId="runtime-level-game-loop"
                role="runtime"
                shadows={settings.quality.shadows}
                camera={{ fov: settings.quality.fov }}
                dpr={dpr}
                frameloop={paused ? 'never' : 'always'}
                gl={RUNTIME_GL}
            >
                {/* AUTO-FALLBACK: Monitoring FPS to adjust quality */}
                <PerformanceMonitor
                    onIncline={() => setDprLevel(2)}
                    onDecline={() => setDprLevel(1)}
                    flipflops={3}
                    onFallback={() => {
                        frontendDiagnostics.warning('renderer_quality_reduced');
                        setHighQuality(false); // Force low quality
                    }}
                />

                <CameraSettings fov={settings.quality.fov} />
                <PauseController
                    paused={paused}
                    canPause={!isGameOver}
                    sessionKey={sessionKey}
                    onRequestPause={runtimeHost.requestPause}
                />

                {/* --- GPU POST PROCESSING PIPELINE --- */}
                {settings.quality.postProcessing && highQuality && (
                    <EffectComposer enableNormalPass={false}>
                        <Bloom luminanceThreshold={1.2} mipmapBlur intensity={0.6} />
                        <Vignette eskil={false} offset={0.1} darkness={1.1} />
                        {/* The composer bypasses the renderer's ACES tone mapping, so apply it as the final effect. */}
                        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
                    </EffectComposer>
                )}

                {/* Remount = new play session (BeginPlay, overlaps, spawner counts); the canvas and its GL context stay. */}
                <group key={sessionKey}>
                    <LevelSession
                        level={level}
                        content={content}
                        player={player}
                        start={start}
                        restore={restore}
                        host={runtimeHost}
                        sessionKey={sessionKey}
                        isGameOver={isGameOver}
                        paused={paused}
                        onGameOver={handleGameOver}
                    />
                </group>
            </AuvraCanvas>

            {overlay ?? (
                <FallbackHud
                    player={player}
                    isGameOver={isGameOver}
                    highQuality={highQuality}
                    onToggleQuality={toggleQuality}
                    host={runtimeHost}
                />
            )}
        </div>
    );
};

const RuntimeEnemyController: React.FC<{
    data: SpawnedEnemy;
    assets: ActorAssetBundle;
    playerObject: THREE.Object3D;
    projectileManagerRef: React.RefObject<ProjectileManagerHandle | null>;
    boundarySize: number;
    enabled: boolean;
    onDespawn: (instanceId: string) => void;
    allSceneClips: THREE.AnimationClip[];
    onSpawnBlood: (pos: THREE.Vector3) => void;
    onHitPlayer: (damage: number) => void;
}> = ({ data, assets, playerObject, projectileManagerRef, boundarySize, enabled, onDespawn, allSceneClips, onSpawnBlood, onHitPlayer }) => {
    const apiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const entityRef = useRef<SandboxEntityHandle>(null);
    const damage = useMemo(() => resolveBlueprintDamage(assets.blueprint), [assets.blueprint]);

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
        } catch (e) {
            frontendDiagnostics.failure('enemy_model_clone_failed', e);
            return null;
        }
    }, [assets.model, data.instanceId]);

    // The AI brain only reports an attack when its impact frame lands within attack range.
    const handleAttack = useCallback(() => onHitPlayer(damage), [onHitPlayer, damage]);
    const handleDespawn = useCallback(() => onDespawn(data.instanceId), [onDespawn, data.instanceId]);

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
                onDespawn={handleDespawn}
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
