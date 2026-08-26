
import React, { useEffect, forwardRef, useImperativeHandle, useRef, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LoadedModelData, Blueprint, AttachmentData, SocketData, Hittable, Hitbox } from '../../types';
import { GraphRuntime, GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { AttachmentController } from '../Scene/AttachmentController';
import { SocketController } from '../Scene/SocketController'; // Using Visual Controller now
import { useEntityHealth } from './hooks/useEntityHealth';
import { WorldHealthBar } from './UI/WorldHealthBar';
import { useScene } from '../../context/SceneContext';

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
    onDespawn?: () => void;
    onSpawnBlood?: (position: THREE.Vector3) => void;
}

export interface SandboxEntityHandle extends Hittable {
    object: THREE.Group;
    getSocketWorldPosition: (socketNamePrefix: string) => { position: THREE.Vector3, direction: THREE.Vector3 } | null;
    triggerMuzzleFlash: () => void;
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
    color,
    isAiming = false,
    onApiReady,
    registerHittable,
    unregisterHittable,
    onHealthChange,
    onDespawn,
    onSpawnBlood
}, ref) => {
    
    const { triggerSocketFlash } = useScene();

    // --- Infrastructure ---
    const groupRef = useRef<THREE.Group>(null);
    const internalApiRef = React.useRef<GraphRuntimeAPI | undefined>(undefined);
    const socketRefs = useRef<Map<string, THREE.Object3D>>(new Map());
    const entityId = useMemo(() => crypto.randomUUID(), []);
    
    // Track initialization to prevent resetting position on re-renders
    const initializedModelId = useRef<string | null>(null);

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
    const { currentHealth, isDead, takeDamage: applyHealthDamage } = useEntityHealth({
        maxHealth,
        onHealthChange,
        graphApiRef: internalApiRef
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
        
        model.object.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                child.visible = !isAiming;
            }
        });
    }, [isAiming, model.object]);

    // --- Death & Despawn Sequence ---
    useEffect(() => {
        model.object.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach(mat => {
                    mat.opacity = 1;
                    mat.transparent = false;
                    mat.needsUpdate = true;
                });
            }
        });

        if (isDead) {
            const DEATH_ANIM_DURATION = 3000;
            const FADE_DURATION = 1500;
            
            const timer = setTimeout(() => {
                let start = performance.now();
                
                const fade = () => {
                    const elapsed = performance.now() - start;
                    const t = Math.min(1, elapsed / FADE_DURATION);
                    const alpha = 1 - t;
                    
                    model.object.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const mesh = child as THREE.Mesh;
                            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                            materials.forEach(mat => {
                                mat.transparent = true;
                                mat.opacity = alpha;
                                mat.needsUpdate = true;
                            });
                        }
                    });

                    if (t < 1) {
                        requestAnimationFrame(fade);
                    } else {
                        if (onDespawn) onDespawn();
                    }
                };
                requestAnimationFrame(fade);
            }, DEATH_ANIM_DURATION);

            return () => clearTimeout(timer);
        }
    }, [isDead, model.object, onDespawn]);

    // --- Physics / Gameplay Interface ---

    useImperativeHandle(ref, () => ({
        id: entityId,
        team,
        object: model.object,
        
        getSocketWorldPosition: (namePrefix: string) => {
            const socketData = sockets.find(s => s.name.startsWith(namePrefix));
            if (!socketData) return null;

            const socketObj = socketRefs.current.get(socketData.id);
            if (!socketObj) return null;

            const worldPos = new THREE.Vector3();
            socketObj.getWorldPosition(worldPos);

            const worldDir = new THREE.Vector3(0, 0, 1);
            worldDir.applyQuaternion(socketObj.getWorldQuaternion(new THREE.Quaternion()));

            return { position: worldPos, direction: worldDir };
        },

        triggerMuzzleFlash: () => {
            const muzzleSocket = sockets.find(s => s.name.toLowerCase().includes('muzzle'));
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
        
        isDead: () => isDead
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

            {attachments.map(att => (
                <AttachmentController 
                    key={att.id} 
                    data={att} 
                    parentObject={model.object} 
                />
            ))}
            
            {/* Replaced SocketLogicController with SocketController for Visuals */}
            {sockets.map(sock => (
                <SocketController 
                    key={sock.id}
                    data={sock}
                    parentObject={model.object}
                    onMount={(obj) => socketRefs.current.set(sock.id, obj)}
                />
            ))}

            <GraphRuntime 
                modelObject={model.object}
                graph={blueprint.animationGraph}
                allClips={allClips}
                enableInputs={false} 
                apiRef={internalApiRef}
            />
        </group>
    );
});

SandboxEntity.displayName = 'SandboxEntity';
