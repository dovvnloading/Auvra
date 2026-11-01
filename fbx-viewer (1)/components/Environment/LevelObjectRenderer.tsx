
import React, { useMemo, forwardRef, useState, useRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { Billboard, Html } from '@react-three/drei';
import { Skull, Music, Sun } from 'lucide-react';
import { LoadedModelData, LevelObject } from '../../types';
import { getComponentDefinition } from '../../runtime/components/registry';
import { cloneCharacterModel } from '../../utils/mountedParts';

/**
 * Mounts the Render of every enabled component on `object`. Place it inside the object's
 * transform group: component renders work in the owner's local space.
 */
export const LevelComponentPreviews: React.FC<{ object: LevelObject; mode?: 'editor' | 'runtime' }> = ({ object, mode = 'editor' }) => {
    const components = object.components;
    if (!components || components.length === 0) return null;
    return (
        <>
            {components.map(component => {
                if (!component.enabled) return null;
                const Render = getComponentDefinition(component.type)?.Render;
                return Render ? <Render key={component.id} object={object} component={component} mode={mode} /> : null;
            })}
        </>
    );
};

interface LevelObjectRendererProps {
    model?: LoadedModelData; // Optional for Spawners
    data: LevelObject;
    isSelected?: boolean;
    onClick?: (e: any) => void;
    castShadow?: boolean;
    receiveShadow?: boolean;
    visible?: boolean; // For runtime hiding
    /**
     * When false the object renders at its parent's origin and the caller owns the transform
     * (the editor wraps it in a group placed at the object's world transform).
     */
    applyTransform?: boolean;
}

export const LevelObjectRenderer = forwardRef<THREE.Group, LevelObjectRendererProps>(({ 
    model, 
    data, 
    isSelected, 
    onClick,
    castShadow = true,
    receiveShadow = true,
    visible = true,
    applyTransform = true
}, ref) => {
    
    const internalRef = useRef<THREE.Group>(null);
    const [hovered, setHovered] = useState(false);

    // Expose internal ref to parent
    useImperativeHandle(ref, () => internalRef.current!, []);

    const transform = applyTransform
        ? { position: data.position, rotation: data.rotation, scale: data.scale }
        : {};

    const isGizmo = data.type === 'spawn_point' || data.type === 'audio_emitter' || data.type === 'sky_sphere' || data.type === 'player_start';

    // Clone ONLY when the model definition changes.
    // This prevents re-cloning on every render frame.
    // Hooks run before any early return, so a model that loads later (or a type change)
    // never changes the hook order.
    const clone = useMemo(() => {
        if (isGizmo || !model) return null;
        // A rigged model gets its own skeleton, so one placed character can be posed (a timeline preview)
        // without posing every other copy of its model.
        let skinned = false;
        model.object.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
        const c = skinned ? cloneCharacterModel(model.object) : model.object.clone();
        // Ensure userData carries the ID for raycasting identification
        c.userData = { ...c.userData, levelObjectId: data.id };
        c.traverse((child) => {
            child.userData = { ...child.userData, levelObjectId: data.id };
            if ((child as THREE.Mesh).isMesh) {
                child.castShadow = castShadow;
                child.receiveShadow = receiveShadow;
            }
        });
        return c;
    }, [isGizmo, model, data.id, castShadow, receiveShadow]);

    // --- SHARED GIZMO RENDERER ---
    const renderGizmo = (color: string, icon: React.ReactNode, label: string) => (
        <group 
            ref={internalRef}
            {...transform}
            onClick={onClick}
            onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
            onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
            visible={visible}
        >
            {/* Expanded Hit Volume for easier selection */}
            {/* Using material visible=false ensures Raycaster hits it but it's not rendered */}
            <mesh position={[0, 0.5, 0]}>
                <boxGeometry args={[1.2, 2.5, 1.2]} />
                <meshBasicMaterial visible={false} />
            </mesh>

            {/* Visual Gizmo for Editor */}
            <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                {/* Glowing Background */}
                <mesh>
                    <circleGeometry args={[0.5, 32]} />
                    <meshBasicMaterial 
                        color={isSelected ? color : "#000000"} 
                        opacity={0.6} 
                        transparent 
                        depthTest={false}
                    />
                </mesh>
                
                {/* Border Ring */}
                <mesh>
                    <ringGeometry args={[0.48, 0.52, 32]} />
                    <meshBasicMaterial color={isSelected || hovered ? color : "#666666"} opacity={0.8} transparent depthTest={false} />
                </mesh>

                {/* HTML Icon Overlay - ALWAYS MOUNTED to prevent DOM thrashing */}
                <Html 
                    transform 
                    center 
                    style={{ pointerEvents: 'none', opacity: visible ? 1 : 0 }}
                    zIndexRange={[100, 0]}
                >
                    <div className={`
                        flex items-center justify-center
                        transition-colors duration-200
                        ${isSelected ? 'text-white' : 'text-gray-300'}
                    `} style={{ color: !isSelected ? color : undefined }}>
                        {icon}
                    </div>
                </Html>

                {/* Title (Inside Billboard to face camera) */}
                {isSelected && visible && (
                    <Html
                        position={[0, 0.8, 0]}
                        transform
                        center
                        style={{ pointerEvents: 'none' }}
                    >
                        <div className="select-none whitespace-nowrap text-sm font-semibold text-white [text-shadow:0_1px_3px_#000,0_0_2px_#000]">
                            {label}
                        </div>
                    </Html>
                )}
            </Billboard>

            {/* Ground Stick */}
            <mesh position={[0, -0.5, 0]}>
                <cylinderGeometry args={[0.02, 0.02, 1]} />
                <meshBasicMaterial color={color} opacity={0.5} transparent />
            </mesh>
            
            {/* Range Viz for Audio (If selected) */}
            {data.type === 'audio_emitter' && isSelected && data.audioConfig?.isSpatial && (
                 <mesh rotation={[-Math.PI / 2, 0, 0]}>
                     <ringGeometry args={[data.audioConfig.maxDistance - 0.1, data.audioConfig.maxDistance, 64]} />
                     <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
                 </mesh>
            )}
        </group>
    );

    // --- CASE 0: Player Start ---
    // The marker's origin is the player's feet; the arrow points along local +Z,
    // which is the facing the runtime derives from yaw (atan2(x, z)).
    if (data.type === 'player_start') {
        const color = '#22c55e';
        const accent = isSelected || hovered ? color : '#15803d';
        return (
            <group
                ref={internalRef}
                {...transform}
                onClick={onClick}
                onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
                onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
                visible={visible}
                userData={{ levelObjectId: data.id }}
            >
                {/* Hit volume covering the capsule and arrow */}
                <mesh position={[0, 0.9, 0.3]}>
                    <boxGeometry args={[1, 1.9, 1.6]} />
                    <meshBasicMaterial visible={false} />
                </mesh>

                {/* Player capsule (radius 0.35, 1.8m tall, feet at the origin) */}
                <mesh position={[0, 0.9, 0]}>
                    <capsuleGeometry args={[0.35, 1.1, 4, 12]} />
                    <meshBasicMaterial color={color} transparent opacity={isSelected ? 0.35 : 0.2} depthWrite={false} />
                </mesh>
                <mesh position={[0, 0.9, 0]}>
                    <capsuleGeometry args={[0.35, 1.1, 4, 12]} />
                    <meshBasicMaterial color={accent} wireframe transparent opacity={0.6} />
                </mesh>

                {/* Forward arrow along +Z at chest height */}
                <mesh position={[0, 1.2, 0.55]} rotation={[Math.PI / 2, 0, 0]}>
                    <cylinderGeometry args={[0.04, 0.04, 0.5, 8]} />
                    <meshBasicMaterial color={accent} />
                </mesh>
                <mesh position={[0, 1.2, 0.9]} rotation={[Math.PI / 2, 0, 0]}>
                    <coneGeometry args={[0.12, 0.25, 12]} />
                    <meshBasicMaterial color={accent} />
                </mesh>

                {/* Ground footprint */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                    <ringGeometry args={[0.4, 0.45, 32]} />
                    <meshBasicMaterial color={accent} transparent opacity={0.8} side={THREE.DoubleSide} />
                </mesh>

                {isSelected && visible && (
                    <Billboard position={[0, 2.2, 0]} follow={true} lockX={false} lockY={false} lockZ={false}>
                        <Html transform center style={{ pointerEvents: 'none' }}>
                            <div className="select-none whitespace-nowrap text-sm font-semibold text-white [text-shadow:0_1px_3px_#000,0_0_2px_#000]">
                                Player start
                            </div>
                        </Html>
                    </Billboard>
                )}
            </group>
        );
    }

    // --- CASE 1: Spawn Point ---
    if (data.type === 'spawn_point') {
        return renderGizmo("#ef4444", <Skull size={24} />, "SPAWNER");
    }

    // --- CASE 2: Audio Emitter ---
    if (data.type === 'audio_emitter') {
        return renderGizmo("#f59e0b", <Music size={24} />, "AUDIO");
    }

    // --- CASE 3: Sky Sphere ---
    if (data.type === 'sky_sphere') {
        return renderGizmo("#22d3ee", <Sun size={24} />, "SKYLIGHT");
    }

    // --- CASE 4: Empty object (a prop with no model): a small marker so it can be seen and clicked ---
    if (data.type === 'prop' && !data.modelId) {
        const color = isSelected ? '#60a5fa' : hovered ? '#e2e8f0' : '#94a3b8';
        return (
            <group
                ref={internalRef}
                {...transform}
                onClick={onClick}
                onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
                onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
                visible={visible}
                userData={{ levelObjectId: data.id }}
            >
                <mesh>
                    <sphereGeometry args={[0.45, 8, 8]} />
                    <meshBasicMaterial visible={false} />
                </mesh>
                <mesh>
                    <octahedronGeometry args={[0.3]} />
                    <meshBasicMaterial color={color} wireframe />
                </mesh>
                <axesHelper args={[0.6]} />
            </group>
        );
    }

    // --- CASE 5: Standard Mesh (Prop/Foliage) ---
    if (!clone) return null;

    return (
        <group 
            ref={internalRef}
            {...transform}
            onClick={onClick}
            visible={visible}
            userData={{ levelObjectId: data.id, modelId: data.modelId }}
        >
            <primitive object={clone} />
            
            {isSelected && (
                <boxHelper args={[clone, 0x3b82f6]} />
            )}
        </group>
    );
});

LevelObjectRenderer.displayName = 'LevelObjectRenderer';
