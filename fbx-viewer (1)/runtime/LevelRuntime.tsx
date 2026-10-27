import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { SkeletonUtils } from 'three-stdlib';
import { AuvraCanvas } from '../renderer/AuvraCanvas';
import { ProfilerPanel, ProfilerProbe, useProfilerToggle } from './ProfilerOverlay';
import { levelVariables } from './levelVariables';
import { NavGridContext, useNavGrid } from './navigation';
import { usePhysicsQueries } from './physics';
import { LevelGroundColliders } from './terrainPhysics';
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
import { withWorldPose } from '../hooks/levelBlueprintNodes/world';
import { useRuntimeLevelWorld } from '../hooks/useRuntimeLevelWorld';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { AttachmentData, Blueprint, LevelComponent, LevelObject, LoadedModelData, SocketData } from '../types';
import { instantiatePrefab } from '../utils/prefabs';
import { useGameContent } from './GameContentContext';
import { gameState, useGameState } from './gameState';
import { FrameStepper, PauseActionWatcher, PauseController, SceneInspector } from './PauseController';
import { PhysicsWorld } from './physics';
import { TriggerEventsProvider } from './triggers';
import { RuntimeServicesProvider, RuntimeSpawnerProvider, type SpawnPosition, toSpawnPoint } from './RuntimeServicesContext';
import { ComponentHostContext } from './components/builtins';
import { getComponentDefinition } from './components/registry';
import { IKPlayerTargetContext } from './components/ikComponents';
import { CameraDirectorDriver } from './components/cameraComponent';
import { DialogueDriver } from './components/dialogueComponent';
import { dialogueStore, useDialogueState } from './dialogue';
import { DialogueOverlay } from './DialogueOverlay';
import { LevelStreamingContext, streamedObjects, streamedRoots, type LevelStreaming } from './levelStreaming';
import { PostProcessAllowedContext, usePostProcessClaimed } from './components/postProcess';
import type { InputState } from './input';
import { collectTimelineTargets } from './timeline/evaluate';
import { TouchControls } from './TouchControls';
import { spawnPositionAround } from './spawning';
import { NetSessionProvider } from './net/NetSessionContext';
import { NetStatus } from './net/NetStatus';
import { LocalPlayerReplicator, RemotePlayers } from './net/RemotePlayers';
import type { ComponentDefinition } from './components/types';
import { ScriptRuntime } from './scripting/ScriptRuntime';
import type { GameContent, LevelRuntimeProps, PlayerStart, RuntimeHost, RuntimeLevel, RuntimeSaveState, SaveGameData } from './types';

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

/** Levels are not arenas: AI bounds sit far beyond any authored level, so nothing is clamped to a fixed area. */
const RUNTIME_WORLD_BOUNDARY = 100_000;

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
                    const index = sState.count;
                    sState.count++;

                    onSpawn({
                        blueprintId: cfg.blueprintId,
                        position: spawnPositionAround(obj.position, index),
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
type ObjectTransformWrite = NonNullable<UseLevelBlueprintRuntimeProps['setObjectTransform']>;

type LevelLogicSystemProps = Omit<UseLevelBlueprintRuntimeProps, 'getObject' | 'setObjectTransform'> & {
    /** The session copy's actor lookup, parent links included. */
    getObject: (id: string) => LevelObject | null;
    setObjectTransform: ObjectTransformWrite;
    /** The session copy as rendered (local transforms): gameplay scripts load from its script components and read it. */
    sessionObjects: LevelObject[];
};

const LevelLogicSystem: React.FC<LevelLogicSystemProps> = ({ getObject, setObjectTransform, sessionObjects, ...props }) => {
    // The session renders inside PhysicsWorld, so Raycast and Apply Impulse nodes reach the level's bodies.
    const physics = usePhysicsQueries();
    const applyImpulse = useCallback((id: string, [x, y, z]: [number, number, number]) => {
        physics.applyImpulse(id, { x, y, z });
    }, [physics]);

    // A dynamic rigid body moves its actor without writing the session copy, so actor reads take the simulated
    // pose. A position or rotation a script wrote in this frame or the previous one still wins: the body is only
    // moved there on the physics step after the write's commit, and later nodes in the chain must see the write.
    const frame = useRef(0);
    useFrame(() => { frame.current += 1; });
    const writes = useRef(new Map<string, { position?: number; rotation?: number }>());
    const getLiveObject = useCallback((id: string): LevelObject | null => {
        const object = getObject(id);
        const pose = object ? physics.getBodyPose?.(id) : null;
        if (!object || !pose) return object;
        const live = withWorldPose(object, pose, getObject);
        const write = writes.current.get(id);
        const fresh = (writtenAt: number | undefined) => writtenAt !== undefined && frame.current - writtenAt <= 1;
        return {
            ...live,
            position: fresh(write?.position) ? object.position : live.position,
            rotation: fresh(write?.rotation) ? object.rotation : live.rotation
        };
    }, [getObject, physics]);
    const setLiveObjectTransform = useCallback<ObjectTransformWrite>((id, partial) => {
        const write = writes.current.get(id) ?? {};
        if (partial.position) write.position = frame.current;
        if (partial.rotation) write.rotation = frame.current;
        writes.current.set(id, write);
        setObjectTransform(id, partial);
    }, [setObjectTransform]);

    useLevelBlueprintRuntime({ raycast: physics.raycast, applyImpulse, ...props, getObject: getLiveObject, setObjectTransform: setLiveObjectTransform });

    // Gameplay scripts act on the world through the same session services as the blueprint's nodes.
    const { destroyActor, addNotification, host, playerEntityRef, playerApiRef } = props;
    return (
        <ScriptRuntime
            objects={sessionObjects}
            getObject={getLiveObject}
            setObjectTransform={setLiveObjectTransform}
            destroyObject={destroyActor}
            applyImpulse={applyImpulse}
            raycast={physics.raycast}
            playerEntityRef={playerEntityRef}
            playerApiRef={playerApiRef}
            openLevel={levelId => host?.openLevel(levelId)}
            print={(message, type) => addNotification({ message, type })}
        />
    );
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

// --- LEVEL HIERARCHY ---

/** How a session draws its objects: transform groups where the hierarchy or components need them, instancing elsewhere. */
interface LevelRenderPlan {
    /** Every object with its world transform (and no parent), for systems that read positions as world space. */
    worldObjects: LevelObject[];
    /** World-space objects the player's footprint push-out may use: none under a moving or physics parent. */
    playerObstacles: LevelObject[];
    /** Roots of the objects drawn as their own transform groups; nested groups are listed in groupChildren. */
    groupRoots: LevelObject[];
    groupChildren: Map<string, LevelObject[]>;
    /** Static leaf props and foliage, in world space, drawn through the instanced layers. */
    instancedFoliage: LevelObject[];
    instancedProps: LevelObject[];
    terrains: LevelObject[];
}

interface MountedComponent {
    Render: NonNullable<ComponentDefinition['Render']>;
    component: LevelComponent;
}

const mountedComponents = (obj: LevelObject): MountedComponent[] => (obj.components ?? []).flatMap(component => {
    if (!component.enabled) return [];
    const Render = getComponentDefinition(component.type)?.Render;
    return Render ? [{ Render, component }] : [];
});

const localMatrix = (obj: LevelObject): THREE.Matrix4 => new THREE.Matrix4().compose(
    new THREE.Vector3(...obj.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(obj.rotation[0], obj.rotation[1], obj.rotation[2])),
    new THREE.Vector3(...obj.scale)
);

const toWorldObject = (obj: LevelObject, world: THREE.Matrix4): LevelObject => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    world.decompose(position, quaternion, scale);
    const rotation = new THREE.Euler().setFromQuaternion(quaternion);
    return {
        ...obj,
        parentId: null,
        position: [position.x, position.y, position.z],
        rotation: [rotation.x, rotation.y, rotation.z],
        scale: [scale.x, scale.y, scale.z]
    };
};

/**
 * Splits the session's objects by how they render. Parent links follow utils/sceneGraph (a missing or
 * self parent makes a root); a corrupt cycle is broken where it is first reached. An object gets its own
 * transform group when it has components or children, or sits under an object with components (which
 * may move it); static leaves keep instancing at their world transform. World matrices are composed
 * top-down in one pass, matching sceneGraph.getWorldMatrix without its per-object walk.
 */
const planLevelRender = (objects: LevelObject[]): LevelRenderPlan => {
    const index = new Map(objects.map(obj => [obj.id, obj]));
    const childMap = new Map<string | null, LevelObject[]>();
    objects.forEach(obj => {
        const parentId = obj.parentId && obj.parentId !== obj.id && index.has(obj.parentId) ? obj.parentId : null;
        const siblings = childMap.get(parentId);
        if (siblings) siblings.push(obj);
        else childMap.set(parentId, [obj]);
    });

    const worldMatrices = new Map<string, THREE.Matrix4>();
    const treeParent = new Map<string, string | null>();
    const parents = new Set<string>();
    const dynamic = new Set<string>();
    const underBody = new Set<string>();
    // Timelines move their targets, so those need their own transform group and count as moving.
    const timelineTargets = collectTimelineTargets(objects);
    const visit = (root: LevelObject) => {
        const stack: [LevelObject, string | null][] = [[root, null]];
        while (stack.length) {
            const [obj, parentId] = stack.pop()!;
            if (worldMatrices.has(obj.id)) continue;
            const world = localMatrix(obj);
            if (parentId) {
                world.premultiply(worldMatrices.get(parentId)!);
                parents.add(parentId);
            }
            worldMatrices.set(obj.id, world);
            treeParent.set(obj.id, parentId);
            if (timelineTargets.has(obj.id) || (parentId && (underBody.has(parentId) || (index.get(parentId)?.components ?? [])
                .some(c => c.enabled !== false && ['collider', 'rigidBody', 'mover', 'rotator'].includes(c.type))))) underBody.add(obj.id);
            if (mountedComponents(obj).length || timelineTargets.has(obj.id) || (parentId && dynamic.has(parentId))) dynamic.add(obj.id);
            const children = childMap.get(obj.id);
            if (children) for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], obj.id]);
        }
    };
    (childMap.get(null) ?? []).forEach(visit);
    objects.forEach(visit);

    const hasHierarchy = objects.some(obj => treeParent.get(obj.id));
    const worldObjects = hasHierarchy
        ? objects.map(obj => (treeParent.get(obj.id) ? toWorldObject(obj, worldMatrices.get(obj.id)!) : obj))
        : objects;

    const playerObstacles = underBody.size ? worldObjects.filter((_, i) => !underBody.has(objects[i].id)) : worldObjects;
    const plan: LevelRenderPlan = { worldObjects, playerObstacles, groupRoots: [], groupChildren: new Map(), instancedFoliage: [], instancedProps: [], terrains: [] };
    objects.forEach((obj, i) => {
        const worldObject = worldObjects[i];
        if (obj.type === 'terrain') plan.terrains.push(worldObject);
        if (dynamic.has(obj.id) || parents.has(obj.id)) {
            const parentId = treeParent.get(obj.id);
            if (!parentId) plan.groupRoots.push(obj);
            else {
                const siblings = plan.groupChildren.get(parentId);
                if (siblings) siblings.push(obj);
                else plan.groupChildren.set(parentId, [obj]);
            }
        } else if (obj.type === 'foliage') plan.instancedFoliage.push(worldObject);
        else if (obj.type === 'prop') plan.instancedProps.push(worldObject);
    });
    return plan;
};

/**
 * One object drawn as its own transform group (local to its parent's group): a clone of its model,
 * its enabled components in runtime mode, and its group-drawn children.
 */
const LevelObjectNode: React.FC<{ object: LevelObject; plan: LevelRenderPlan; models: LoadedModelData[] }> = ({ object, plan, models }) => {
    const groupRef = useRef<THREE.Group>(null);
    const model = object.type === 'prop' || object.type === 'foliage' ? models.find(m => m.id === object.modelId) : undefined;
    const meshes = useMemo(() => {
        if (!model) return null;
        try {
            // Keeps the model root's own (import normalisation) transform, like the instanced layers.
            const clone = SkeletonUtils.clone(model.object);
            clone.traverse(child => {
                if ((child as THREE.Mesh).isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
            return clone;
        } catch (e) {
            frontendDiagnostics.failure('level_object_clone_failed', e);
            return null;
        }
    }, [model]);
    const components = useMemo(() => mountedComponents(object), [object]);
    const children = plan.groupChildren.get(object.id);

    return (
        <group ref={groupRef} position={object.position} rotation={object.rotation} scale={object.scale} userData={{ levelObjectId: object.id }}>
            {meshes && <primitive object={meshes} />}
            <ComponentHostContext.Provider value={groupRef}>
                {components.map(({ Render, component }) => (
                    <Render key={component.id} object={object} component={component} mode="runtime" />
                ))}
            </ComponentHostContext.Provider>
            {children?.map(child => (
                <LevelObjectNode key={child.id} object={child} plan={plan} models={models} />
            ))}
        </group>
    );
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
    saveStateRef?: React.MutableRefObject<(() => RuntimeSaveState | null) | null>;
}

/**
 * One play session of a level. Mounted under a group keyed by the session key, so a restart or a load
 * starts from a fresh runtime copy: BeginPlay, overlaps, spawner counts and spawned enemies all reset.
 */
const LevelSession: React.FC<LevelSessionProps> = ({ level, content, player, start, restore, host, sessionKey, isGameOver, paused, onGameOver, saveStateRef }) => {
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
    // Its getObject reads writes made earlier in the same frame, so one script chain can spawn, move and read an actor.
    const {
        objects: runtimeLevelObjects,
        getObject: getRuntimeObject,
        destroyObject: destroyRuntimeObject,
        setObjectTransform: setRuntimeObjectTransform,
        spawnObjects: spawnRuntimeObjects
    } = useRuntimeLevelWorld(authoredObjects);

    // --- LEVEL STREAMING ---
    // Streamed levels join the session copy like spawned prefabs; unloading removes their root objects.
    const streamedRootIds = useRef(new Map<string, string[]>());
    const levelStreaming = useMemo<LevelStreaming>(() => ({
        load: (levelId) => {
            if (streamedRootIds.current.has(levelId) || levelId === level.id) return false;
            const source = content.levelObjects?.[levelId];
            if (!source?.length) return false;
            const objects = streamedObjects(levelId, source, level.id);
            streamedRootIds.current.set(levelId, streamedRoots(objects));
            spawnRuntimeObjects(objects);
            return true;
        },
        unload: (levelId) => {
            const roots = streamedRootIds.current.get(levelId);
            if (!roots) return;
            streamedRootIds.current.delete(levelId);
            roots.forEach(id => destroyRuntimeObject(id));
        },
        isLoaded: (levelId) => streamedRootIds.current.has(levelId),
    }), [content.levelObjects, destroyRuntimeObject, level.id, spawnRuntimeObjects]);

    // Prefab documents come with the game content (the project or game pack 'prefabs' domain).
    const prefabs = content.prefabs;
    const reportedMissingPrefabs = useRef(new Set<string>());
    const spawnPrefab = useCallback((prefabId: string, position: SpawnPosition): string[] => {
        const prefab = prefabs?.find(item => item.id === prefabId);
        if (!prefab) {
            // Once per prefab, so a spawner running every frame does not flood the output.
            if (!reportedMissingPrefabs.current.has(prefabId)) {
                reportedMissingPrefabs.current.add(prefabId);
                host.print(`Spawn Prefab: this game has no prefab "${prefabId}"`, 'warning');
            }
            return [];
        }
        try {
            // Spawned prefabs join the session copy only; they are never written to the project.
            const objects = instantiatePrefab(prefab, level.id, toSpawnPoint(position));
            spawnRuntimeObjects(objects);
            return objects.map(obj => obj.id);
        } catch (e) {
            frontendDiagnostics.failure('runtime_prefab_spawn_failed', e);
            return [];
        }
    }, [host, level.id, prefabs, spawnRuntimeObjects]);

    // --- References & State ---
    const playerApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    // Level play has no single enemy instance, so 'Enemy'-targeted variable nodes resolve to nothing.
    const enemyApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const playerEntityRef = useRef<SandboxEntityHandle>(null);

    // A save records the player's transform and the authored actors gone so far (those a loaded save
    // had already removed included), which is what loading it restores.
    const runtimeObjectsRef = useRef(runtimeLevelObjects);
    runtimeObjectsRef.current = runtimeLevelObjects;
    useEffect(() => {
        if (!saveStateRef) return undefined;
        saveStateRef.current = () => {
            const body = playerEntityRef.current?.object;
            if (!body) return null;
            const position = body.getWorldPosition(new THREE.Vector3());
            const rotation = new THREE.Euler().setFromQuaternion(body.getWorldQuaternion(new THREE.Quaternion()));
            const live = new Set(runtimeObjectsRef.current.map(object => object.id));
            const destroyed = new Set(sessionRestore?.destroyedObjectIds ?? []);
            for (const object of authoredObjects) if (!live.has(object.id)) destroyed.add(object.id);
            return {
                position: [position.x, position.y, position.z],
                rotation: [rotation.x, rotation.y, rotation.z],
                destroyedObjectIds: [...destroyed],
            };
        };
        return () => { saveStateRef.current = null; };
    }, [saveStateRef, authoredObjects, sessionRestore]);
    const projectileManagerRef = useRef<ProjectileManagerHandle>(null);
    const bloodSystemRef = useRef<BloodSystemHandle>(null);

    const [isAiming, setIsAiming] = useState(false);
    const [spawnedEnemies, setSpawnedEnemies] = useState<SpawnedEnemy[]>([]);

    // Layout effect: runs before the entities' first stat reports, so it never overwrites them,
    // and before BeginPlay (a passive effect), so the level script sees this session's variables.
    const declaredVariables = level.blueprint?.variables;
    useLayoutEffect(() => {
        gameState.update({
            levelId: level.id,
            player: { health: 100, maxHealth: 100, stamina: 100, isAiming: false },
            vars: sessionRestore?.variables
        });
        // Declared variables start at their defaults; a loaded save puts its values back on top.
        levelVariables.reset(declaredVariables);
        for (const [name, value] of Object.entries(sessionRestore?.variables ?? {})) levelVariables.set(name, value);
    // Variables are read once per session; LevelSession remounts for every new session.
    }, [level.id, sessionRestore]);

    // Conversations read and write this session's level variables and end with it.
    useEffect(() => {
        dialogueStore.setHooks({
            readVariable: name => levelVariables.get(name),
            setVariable: (name, value) => { levelVariables.set(name, value); },
        });
        return () => {
            dialogueStore.setHooks(null);
            dialogueStore.reset();
        };
    }, []);
    // The player stands still and the camera holds while a conversation is open.
    const talking = useDialogueState().active !== null;

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

    // Hierarchy and components render as transform groups; gameplay systems read world-space copies.
    const renderPlan = useMemo(() => planLevelRender(runtimeLevelObjects), [runtimeLevelObjects]);
    const worldLevelObjects = renderPlan.worldObjects;
    // Enemies path around the level's static colliders; the hierarchy stays intact so moving parents are detected.
    // Mesh colliders and auto hulls bake from the model's real bounds; memoized, since a new function re-bakes the grid.
    const navShapeBounds = useCallback((object: LevelObject) => {
        const model = models.find(m => m.id === object.modelId);
        return model ? new THREE.Box3().setFromObject(model.object) : null;
    }, [models]);
    const navOptions = useMemo(() => ({ shapeBounds: navShapeBounds }), [navShapeBounds]);
    const navGrid = useNavGrid(runtimeLevelObjects, navOptions);

    // Look-at IK aimed at 'player' (level components and enemy blueprints) follows the player's model.
    const playerTargetRef = useMemo(() => ({ current: runtimePlayerModel?.object ?? null }), [runtimePlayerModel]);

    if (!runtimePlayerModel) return null;

    const controlsEnabled = !isGameOver && !paused && !talking;

    return (
        <IKPlayerTargetContext.Provider value={playerTargetRef}>
        <LevelStreamingContext.Provider value={levelStreaming}>
        <RuntimeSpawnerProvider spawnPrefab={spawnPrefab}>
            {/* --- Replaced Hardcoded Lights with SkySystem --- */}
            <SkySystem levelObjects={runtimeLevelObjects} />

            <LevelGroundColliders terrains={renderPlan.terrains} />

            <group>
                {/* Render Terrain */}
                {renderPlan.terrains.map(terrain => (
                    <TerrainObject
                        key={terrain.id}
                        data={terrain}
                        isSelected={false}
                        visible={true}
                        castShadow
                        receiveShadow
                        sculptingEnabled={false}
                        lod
                    />
                ))}

                <InstancedLevelLayer models={models} levelObjects={renderPlan.instancedFoliage} interactive={false} />
                <InstancedLevelLayer models={models} levelObjects={renderPlan.instancedProps} interactive={false} />

                {renderPlan.groupRoots.map(obj => (
                    <LevelObjectNode key={obj.id} object={obj} plan={renderPlan} models={models} />
                ))}
            </group>

            <AudioSystem
                levelObjects={worldLevelObjects}
                audioAssets={audioAssets}
                isMuted={false}
            />

            <BloodSystem ref={bloodSystemRef} />
            <ProjectileManager ref={projectileManagerRef} />

            {/* Multiplayer: this player's state goes out, other players' avatars come in (nothing without a session). */}
            <LocalPlayerReplicator playerObject={runtimePlayerModel.object} playerApiRef={playerApiRef} />
            <RemotePlayers player={player} allClips={allSceneClips} />

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

            <NavGridContext.Provider value={navGrid}>
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
                        boundarySize={RUNTIME_WORLD_BOUNDARY}
                        enabled={!isGameOver}
                        onDespawn={handleEnemyDespawn}
                        allSceneClips={allSceneClips}
                        onSpawnBlood={handleSpawnBlood}
                        onHitPlayer={handlePlayerHit}
                    />
                );
            })}
            </NavGridContext.Provider>

            <PlayerController
                apiRef={playerApiRef}
                entityRef={playerEntityRef}
                projectileManager={projectileManagerRef}
                modelObject={runtimePlayerModel.object}
                enabled={controlsEnabled}
                levelObjects={renderPlan.playerObstacles}
                onStaminaChange={handleStaminaChange}
                onAimChange={handleAimChange}
                weaponSounds={weaponSoundUrls}
                weaponVolume={player.blueprint.weaponVolume ?? 1.0}
                blueprint={player.blueprint}
            />

            <LevelLogicSystem
                blueprint={level.blueprint}
                levelObjects={worldLevelObjects}
                playerEntityRef={playerEntityRef}
                playerApiRef={playerApiRef}
                enemyApiRef={enemyApiRef}
                destroyActor={destroyRuntimeObject}
                getObject={getRuntimeObject}
                setObjectTransform={setRuntimeObjectTransform}
                sessionObjects={runtimeLevelObjects}
                addNotification={handleNotification}
                onRestart={host.restartLevel}
                onEndLevel={host.endLevel}
                host={host}
            />

            <SpawnerSystem
                levelObjects={worldLevelObjects}
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
            <DialogueDriver enabled={!isGameOver && !paused} />
            {/* After the rig: a level camera, or a blend back from one, has the last word on the view. */}
            <CameraDirectorDriver />
        </RuntimeSpawnerProvider>
        </LevelStreamingContext.Provider>
        </IKPlayerTargetContext.Provider>
    );
};

/** The runtime's own bloom, vignette and tone mapping, standing down while a level Post Process component owns the canvas. */
const DefaultPostProcess: React.FC = () => {
    if (usePostProcessClaimed()) return null;
    return (
        <EffectComposer enableNormalPass={false}>
            <Bloom luminanceThreshold={1.2} mipmapBlur intensity={0.6} />
            <Vignette eskil={false} offset={0.1} darkness={1.1} />
            {/* The composer bypasses the renderer's ACES tone mapping, so apply it as the final effect. */}
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
    );
};

/**
 * LEVEL RUNTIME
 *
 * Plays one level. Shared by play-in-editor and the standalone player: content comes from the
 * runtime content context, flow control (restart, end, open level, save, load, pause) from the host.
 */
export const LevelRuntime: React.FC<LevelRuntimeProps> = ({ level, settings, playerStart, paused, host, sessionKey, overlay, restore, playerOptions, stepRequest = 0, inspectRef, saveStateRef }) => {
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
    const profilerVisible = useProfilerToggle();
    const postProcessAllowed = settings.quality.postProcessing && highQuality;
    const [touchInput, setTouchInput] = useState<InputState | null>(null);

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
        <NetSessionProvider settings={settings.network} gameId={netGameId(settings.name)} name="Player">
        <div className="relative w-full h-full bg-black cursor-none">
            <NetStatus />
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
                <ProfilerProbe enabled={profilerVisible} />
                <SceneInspector inspectRef={inspectRef} />
                <PauseController
                    paused={paused}
                    canPause={!isGameOver}
                    sessionKey={sessionKey}
                    onRequestPause={runtimeHost.requestPause}
                />

                {/* --- GPU POST PROCESSING PIPELINE --- */}
                {/* A level Post Process component replaces the default stack; the quality setting and the fallback gate both. */}
                <PostProcessAllowedContext.Provider value={postProcessAllowed}>
                {postProcessAllowed && <DefaultPostProcess />}

                {/* Input, audio buses and player options live for the whole run; the session adds its prefab spawner. */}
                <RuntimeServicesProvider settings={settings} playerOptions={playerOptions} inputEnabled={!paused} onInput={setTouchInput}>
                    <PauseActionWatcher enabled={!paused && !isGameOver} onRequestPause={runtimeHost.requestPause} />
                    {/* Each session gets a fresh trigger bus and physics world, so no body or listener outlives it. */}
                    <TriggerEventsProvider key={sessionKey}>
                        <PhysicsWorld paused={paused}>
                            <FrameStepper paused={paused} stepRequest={stepRequest} />
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
                                    saveStateRef={saveStateRef}
                                />
                            </group>
                        </PhysicsWorld>
                    </TriggerEventsProvider>
                </RuntimeServicesProvider>
                </PostProcessAllowedContext.Provider>
            </AuvraCanvas>

            {/* On-screen joystick and buttons on touch devices; unmounted while paused so look input does not pile up. */}
            {touchInput && !paused && !isGameOver && <TouchControls input={touchInput} />}

            {overlay ?? (
                <FallbackHud
                    player={player}
                    isGameOver={isGameOver}
                    highQuality={highQuality}
                    onToggleQuality={toggleQuality}
                    host={runtimeHost}
                />
            )}
            {!paused && !isGameOver && <DialogueOverlay input={touchInput} />}
            <ProfilerPanel visible={profilerVisible} />
        </div>
        </NetSessionProvider>
    );
};

/** The game id the relay keeps rooms apart by: the game's name, lower-cased, letters and digits. */
const netGameId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'auvra-game';

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
                stats={assets.blueprint?.stats}
                behaviorTree={assets.blueprint?.behaviorTree}
            />
        </>
    );
};
