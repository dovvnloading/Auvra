
import React, { useEffect, forwardRef, useImperativeHandle, useRef, useMemo, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { LoadedModelData, Blueprint, AttachmentData, SocketData, Hittable, Hitbox, DEFAULT_UPPER_BODY_BONE } from '../../types';
import { GraphRuntime, GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { PLAYER_PHYSICS_ID } from '../../runtime/physics';
import { CharacterIK, heldWeaponGrip } from './CharacterIK';
import { CharacterRagdoll } from './CharacterRagdoll';
import { AttachmentController } from '../Scene/AttachmentController';
import { SocketController, resolveSocketFlashTextureUrl } from '../Scene/SocketController'; // Using Visual Controller now
import { DEFAULT_HIT_REACT_AIMED, useEntityHealth } from './hooks/useEntityHealth';
import type { MontageBoneWeight } from '../AnimationGraph/utils/montage';
import { WorldHealthBar } from './UI/WorldHealthBar';
import { useGameContent } from '../../runtime/GameContentContext';
import { ownClipsFirst } from '../../utils/animationBinding';
import { generatedMuzzleSocketName, weaponMoveClips, weaponPlacements, type WeaponPose } from '../../runtime/weapons';
import { weaponMuzzleSocket } from '../../runtime/weaponMuzzle';
import { weaponLocomotionGraph } from '../AnimationGraph/utils/clipMatching';

/** Seconds the death animation plays before the body starts fading. */
const DEATH_ANIM_DURATION = 3;
/** Seconds the body takes to fade out before despawning. */
const FADE_DURATION = 1.5;
/** Largest frame step the death sequence accepts, so a resumed or backgrounded tab does not skip it. */
const MAX_DEATH_STEP = 0.1;

interface FadeMaterials {
    /** The copies to fade. */
    materials: THREE.Material[];
    /** Puts the original materials back and frees the copies. */
    restore: () => void;
}

interface DeathSequence {
    elapsed: number;
    /** Taken when the body starts fading. */
    fade: FadeMaterials | null;
    despawned: boolean;
}

/**
 * Gives every mesh under `object` its own transparent copy of its materials to fade. The originals
 * are shared with the model in the library and with every other entity of the same model, so
 * fading them would hide all of those too.
 */
export const takeFadeMaterials = (object: THREE.Object3D): FadeMaterials => {
    const materials: THREE.Material[] = [];
    const meshes: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const copy = (material: THREE.Material) => {
            const faded = material.clone();
            faded.transparent = true;
            materials.push(faded);
            return faded;
        };
        meshes.push([mesh, mesh.material]);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
    });
    return {
        materials,
        restore: () => {
            for (const [mesh, original] of meshes) mesh.material = original;
            for (const material of materials) material.dispose();
        },
    };
};

interface SandboxEntityProps {
    model: LoadedModelData;
    blueprint: Blueprint;
    attachments: AttachmentData[];
    sockets: SocketData[];
    allClips: THREE.AnimationClip[];
    startPosition: [number, number, number];
    startRotation: [number, number, number];
    team: 'Player' | 'Enemy';
    color: string;
    isAiming?: boolean;
    onApiReady?: (api: GraphRuntimeAPI) => void;
    registerHittable?: (hittable: Hittable) => void;
    unregisterHittable?: (id: string) => void;
    onHealthChange?: (current: number, max: number) => void;
    /** Health to start with, as a loaded save left it; full when left out. */
    initialHealth?: number;
    onDespawn?: () => void;
    onSpawnBlood?: (position: THREE.Vector3) => void;
    /** Another peer's avatar in a multiplayer game: driven by the network, not this player. */
    remote?: boolean;
}

export interface SandboxEntityHandle extends Hittable {
    object: THREE.Group;
    getSocketWorldPosition: (socketNamePrefix: string) => { position: THREE.Vector3, direction: THREE.Vector3 } | null;
    /** Flashes the socket whose name starts with `socketName`, else the first muzzle socket. */
    triggerMuzzleFlash: (socketName?: string | null) => void;
    /** Restores up to `amount` health; false when dead or already full. */
    heal: (amount: number) => boolean;
    /**
     * Places the blueprint's weapon models for a pose: the held one in the hand while in use, at its
     * carry placement otherwise; other carried weapons at theirs; the rest hidden.
     */
    setWeaponPose: (pose: WeaponPose) => void;
}

export const SandboxEntity = forwardRef<SandboxEntityHandle, SandboxEntityProps>(({
    model,
    blueprint,
    attachments,
    sockets,
    allClips,
    startPosition,
    startRotation,
    team,
    isAiming = false,
    onApiReady,
    registerHittable,
    unregisterHittable,
    onHealthChange,
    initialHealth,
    onDespawn,
    onSpawnBlood,
    remote = false
}, ref) => {

    const { textures } = useGameContent();

    // Where each weapon's model goes; until the controller reports, the first carried weapon is held at rest.
    const [weaponPose, setWeaponPose] = useState<WeaponPose>(() => {
        const owned = (blueprint.weapons ?? []).map(weapon => weapon.startsOwned !== false);
        return { held: owned.indexOf(true), ready: false, owned };
    });
    const weaponPlacementsById = useMemo(() => weaponPlacements(blueprint.weapons ?? [], weaponPose), [blueprint.weapons, weaponPose]);

    // --- Muzzle Flash (entity-local, one tick counter per socket) ---
    const [flashTicks, setFlashTicks] = useState<Record<string, number>>({});
    const triggerSocketFlash = useCallback((socketId: string) => {
        setFlashTicks(prev => ({ ...prev, [socketId]: (prev[socketId] ?? 0) + 1 }));
    }, []);

    // --- Infrastructure ---
    const groupRef = useRef<THREE.Group>(null);
    const internalApiRef = React.useRef<GraphRuntimeAPI | undefined>(undefined);
    const socketRefs = useRef<Map<string, THREE.Object3D>>(new Map());
    const entityId = useMemo(() => crypto.randomUUID(), []);
    
    // Track initialization to prevent resetting position on re-renders
    const initializedModelId = useRef<string | null>(null);

    // A clip name another model shares resolves to this model's own clip.
    const clips = useMemo(() => ownClipsFirst(model.animations, allClips), [model.animations, allClips]);

    // The held weapon's own locomotion (a rifle's or a pistol's) plays in place of the graph's.
    const heldWeapon = (blueprint.weapons ?? [])[weaponPose.held] ?? null;
    const animationGraph = useMemo(
        () => weaponLocomotionGraph(blueprint.animationGraph, weaponMoveClips(heldWeapon), new Set(clips.map(clip => clip.name))),
        [blueprint.animationGraph, heldWeapon, clips],
    );
    // Weapons with a model but no muzzle socket fire from one the engine places at the model's muzzle.
    const allSockets = useMemo(() => [
        ...sockets,
        ...(blueprint.weapons ?? []).flatMap((weapon) => {
            const socket = weaponMuzzleSocket(weapon, attachments.find(item => item.id === weapon.attachmentId));
            return socket ? [socket] : [];
        }),
    ], [sockets, blueprint.weapons, attachments]);
    // The held weapon's muzzle, which the aim points at the crosshair.
    const heldMuzzleName = heldWeapon
        ? heldWeapon.muzzleSocket?.trim() || (heldWeapon.attachmentId ? generatedMuzzleSocketName(heldWeapon.id) : null)
        : null;
    const heldMuzzleId = heldMuzzleName ? allSockets.find(socket => socket.name.startsWith(heldMuzzleName))?.id ?? null : null;
    const heldMuzzle = useCallback(() => (heldMuzzleId ? socketRefs.current.get(heldMuzzleId) ?? null : null), [heldMuzzleId]);

    // The other hand on the held weapon, while it is in the hands and not being reloaded.
    const heldAttachmentId = heldWeapon?.attachmentId ?? null;
    const heldInHands = !!heldAttachmentId && weaponPlacementsById.get(heldAttachmentId) === 'hand';
    const heldAttachment = heldInHands ? attachments.find(item => item.id === heldAttachmentId) ?? null : null;
    const supportGrip = useMemo(
        () => (weaponPose.reloading ? null : heldWeaponGrip(heldWeapon, heldAttachment)),
        [heldAttachment, heldWeapon, weaponPose.reloading],
    );

    // --- Configuration ---
    const maxHealth = useMemo(() => {
        const stat = blueprint.stats.find(s => s.name === 'Health');
        return stat ? stat.value : 100;
    }, [blueprint]);

    const meshScale = blueprint.meshScale || 1.0;
    const baseScale = model.initialScale || [1, 1, 1];
    const finalScale = useMemo(() => 
        [baseScale[0] * meshScale, baseScale[1] * meshScale, baseScale[2] * meshScale] as [number, number, number], 
    [baseScale, meshScale]);

    // Capture the normalized Y offset (floor correction) to prevent sinking
    const normalizedYOffset = useRef(model.object.position.y).current;

    // Combine start position with intrinsic normalization offset
    const effectivePosition: [number, number, number] = useMemo(() => [
        startPosition[0],
        startPosition[1] + normalizedYOffset,
        startPosition[2]
    ], [startPosition, normalizedYOffset]);

    // Measure bounding box to place Health Bar correctly
    const [localHealthBarY, setLocalHealthBarY] = useState(5.0);

    useEffect(() => {
        if (!model.object) return;
        
        // Compute Local Bounding Box (unscaled, unrotated relative to root)
        const clone = model.object.clone();
        clone.position.set(0,0,0);
        clone.rotation.set(0,0,0);
        clone.scale.set(1,1,1);
        
        clone.updateMatrixWorld(true);
        
        const box = new THREE.Box3().setFromObject(clone);
        const height = box.max.y - box.min.y;
        
        // Calculate target height with padding
        let targetY = box.max.y + (height * 0.15); 
        
        if (height < 0.5 || isNaN(targetY)) {
             const scaleY = finalScale[1] || 1;
             targetY = 6.0 / scaleY; 
        }

        setLocalHealthBarY(targetY);
        clone.clear();
    }, [model.object, finalScale]);

    // --- Physics Initialization ---
    useEffect(() => {
        if (model.object && initializedModelId.current !== model.id) {
            model.object.position.set(...effectivePosition);
            model.object.rotation.set(startRotation[0], startRotation[1], startRotation[2]);
            model.object.updateMatrixWorld();
            
            initializedModelId.current = model.id;
        }
    }, [model.object, model.id, effectivePosition, startRotation]);

    // --- Logic Hooks ---
    // While its weapon is held ready, a hit rocks the body but barely moves the upper body holding the weapon.
    const hitReactWeights = useRef<MontageBoneWeight[] | null>(null);
    const upperBodyBone = blueprint.upperBody?.maskBone || DEFAULT_UPPER_BODY_BONE;
    useEffect(() => {
        hitReactWeights.current = heldWeapon && weaponPose.ready
            ? [{ bone: upperBodyBone, weight: blueprint.hitReactAimed ?? DEFAULT_HIT_REACT_AIMED }]
            : null;
    }, [heldWeapon, weaponPose.ready, upperBodyBone, blueprint.hitReactAimed]);
    const { currentHealth, isDead, takeDamage: applyHealthDamage, heal } = useEntityHealth({
        maxHealth,
        initialHealth,
        onHealthChange,
        graphApiRef: internalApiRef,
        hitReactClip: blueprint.hitReactClip,
        hitReactWeights,
    });

    // --- Stats to Runtime Sync ---
    useEffect(() => {
        if (internalApiRef.current) {
            internalApiRef.current.setVariable('Health', currentHealth);
            internalApiRef.current.setVariable('MaxHealth', maxHealth);
        }
    }, [currentHealth, maxHealth]);

    // --- Mesh Visibility Handling (Scope Mode) ---
    useEffect(() => {
        if (!model.object) return;
        
        // Over-the-shoulder aiming keeps the character in view; the scope looks out of its eyes.
        const hidden = isAiming && (blueprint.aimView ?? 'scope') === 'scope';
        model.object.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                child.visible = !hidden;
            }
        });
    }, [isAiming, model.object, blueprint.aimView]);

    // --- Death & Despawn Sequence ---
    // Driven by the frame loop (not wall-clock timers) so pausing the game pauses it.
    const onDespawnRef = useRef(onDespawn);
    onDespawnRef.current = onDespawn;
    const deathSequence = useRef<DeathSequence | null>(null);

    useEffect(() => {
        const sequence: DeathSequence | null = isDead ? { elapsed: 0, fade: null, despawned: false } : null;
        deathSequence.current = sequence;
        // Revived, restarted or removed: the model gets its own materials back.
        return () => sequence?.fade?.restore();
    }, [isDead, model.object]);

    useFrame((_, delta) => {
        const sequence = deathSequence.current;
        if (!sequence || sequence.despawned) return;

        sequence.elapsed += Math.min(delta, MAX_DEATH_STEP);
        if (sequence.elapsed < DEATH_ANIM_DURATION) return;

        sequence.fade ??= takeFadeMaterials(model.object);

        const t = Math.min(1, (sequence.elapsed - DEATH_ANIM_DURATION) / FADE_DURATION);
        const alpha = 1 - t;
        sequence.fade.materials.forEach(mat => {
            mat.opacity = alpha;
        });

        if (t >= 1) {
            sequence.despawned = true;
            onDespawnRef.current?.();
        }
    });

    // --- Physics / Gameplay Interface ---

    useImperativeHandle(ref, () => ({
        id: entityId,
        team,
        object: model.object,
        
        getSocketWorldPosition: (namePrefix: string) => {
            const socketData = allSockets.find(s => s.name.startsWith(namePrefix));
            if (!socketData) return null;

            const socketObj = socketRefs.current.get(socketData.id);
            if (!socketObj) return null;

            const worldPos = new THREE.Vector3();
            socketObj.getWorldPosition(worldPos);

            const worldDir = new THREE.Vector3(0, 0, 1);
            worldDir.applyQuaternion(socketObj.getWorldQuaternion(new THREE.Quaternion()));

            return { position: worldPos, direction: worldDir };
        },

        triggerMuzzleFlash: (socketName) => {
            const muzzleSocket = socketName
                ? allSockets.find(s => s.name.startsWith(socketName))
                : allSockets.find(s => s.name.toLowerCase().includes('muzzle'));
            if (muzzleSocket) {
                triggerSocketFlash(muzzleSocket.id);
            }
        },
        
        getHitbox: (): Hitbox => {
            const pos = new THREE.Vector3();
            if (model.object) model.object.getWorldPosition(pos);
            
            return {
                center: pos,
                radius: 1.0 * meshScale,
                height: 5.0 * meshScale
            };
        },
        
        takeDamage: (amount: number, point: THREE.Vector3) => {
            if (isDead) return;
            applyHealthDamage(amount);
            if (onSpawnBlood) {
                onSpawnBlood(point);
            }
        },
        
        isDead: () => isDead,

        heal,

        setWeaponPose: (pose: WeaponPose) => setWeaponPose(previous => (
            previous.held === pose.held && previous.ready === pose.ready && !!previous.reloading === !!pose.reloading
                && previous.owned.length=== pose.owned.length && previous.owned.every((owned, index) => owned === pose.owned[index])
                ? previous
                : pose
        )),
    }));

    // --- Lifecycle ---

    useEffect(() => {
        if (registerHittable && unregisterHittable) {
            const handle: Hittable = {
                id: entityId,
                team,
                getHitbox: () => {
                    const pos = new THREE.Vector3();
                    if (model.object) model.object.getWorldPosition(pos);
                    return { center: pos, radius: 1.0 * meshScale, height: 5.0 * meshScale };
                },
                takeDamage: (amount, point) => {
                    if (isDead) return;
                    applyHealthDamage(amount);
                    if (onSpawnBlood) onSpawnBlood(point);
                },
                isDead: () => isDead
            };
            
            registerHittable(handle);
            return () => unregisterHittable(entityId);
        }
    }, [registerHittable, unregisterHittable, entityId, team, model.object, meshScale, isDead, applyHealthDamage, onSpawnBlood]);

    useEffect(() => {
        if (internalApiRef.current && onApiReady) {
            onApiReady(internalApiRef.current);
        }
    });

    return (
        <group ref={groupRef}>
            <primitive 
                object={model.object} 
                scale={finalScale}
            >
                <WorldHealthBar 
                    current={currentHealth}
                    max={maxHealth}
                    visible={team === 'Enemy' && !isDead}
                    heightOffset={localHealthBarY}
                    scale={1.0} 
                />
            </primitive>

            {attachments.map(att => {
                const placement = weaponPlacementsById.get(att.id);
                return (
                    <AttachmentController
                        key={att.id}
                        data={att}
                        parentObject={model.object}
                        cloneForInstance
                        hidden={placement === 'hidden'}
                        placement={placement && typeof placement === 'object' ? placement : null}
                    />
                );
            })}

            {/* Replaced SocketLogicController with SocketController for Visuals */}
            {allSockets.map(sock => (
                <SocketController
                    key={sock.id}
                    data={sock}
                    parentObject={model.object}
                    onMount={(obj) => socketRefs.current.set(sock.id, obj)}
                    flashTrigger={flashTicks[sock.id] ?? 0}
                    flashTextureUrl={resolveSocketFlashTextureUrl(sock, textures)}
                    runtime
                />
            ))}

            <GraphRuntime
                modelObject={model.object}
                graph={animationGraph}
                allClips={clips}
                enableInputs={false}
                driveLocomotion={false}
                apiRef={internalApiRef}
                eventSource={remote ? `remote:${entityId}` : team === 'Player' ? 'player' : entityId}
                lod={remote || team !== 'Player'}
            />
            <CharacterIK model={model.object} settings={blueprint.ik} physicsId={team === 'Player' && !remote ? PLAYER_PHYSICS_ID : undefined} aiming={isAiming} supportGrip={supportGrip} muzzle={heldMuzzle} />
            {/* Enemies fall as ragdolls; the player's death ends the game, and its capsule would fight the bodies. */}
            {isDead && team === 'Enemy' && <CharacterRagdoll model={model.object} />}
        </group>
    );
});

SandboxEntity.displayName = 'SandboxEntity';
