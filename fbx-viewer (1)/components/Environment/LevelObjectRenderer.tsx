
import React, { useMemo, forwardRef, useState, useRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { Billboard, Text, Html } from '@react-three/drei';
import { Skull, Music, Sun } from 'lucide-react';
import { LoadedModelData, LevelObject } from '../../types';

interface LevelObjectRendererProps {
    model?: LoadedModelData; // Optional for Spawners
    data: LevelObject;
    isSelected?: boolean;
    onClick?: (e: any) => void;
    castShadow?: boolean;
    receiveShadow?: boolean;
    visible?: boolean; // For runtime hiding
}

export const LevelObjectRenderer = forwardRef<THREE.Group, LevelObjectRendererProps>(({ 
    model, 
    data, 
    isSelected, 
    onClick,
    castShadow = true,
    receiveShadow = true,
    visible = true
}, ref) => {
    
    const internalRef = useRef<THREE.Group>(null);
    const [hovered, setHovered] = useState(false);

    // Expose internal ref to parent
    useImperativeHandle(ref, () => internalRef.current!, []);

    // --- SHARED GIZMO RENDERER ---
    const renderGizmo = (color: string, icon: React.ReactNode, label: string) => (
        <group 
            ref={internalRef}
            position={data.position}
            rotation={data.rotation}
            scale={data.scale}
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
                    <Text 
                        position={[0, 0.8, 0]} 
                        fontSize={0.2} 
                        color="white" 
                        anchorX="center" 
                        anchorY="middle"
                        outlineWidth={0.02}
                        outlineColor="#000000"
                    >
                        {label}
                    </Text>
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

    // --- CASE 4: Standard Mesh (Prop/Foliage) ---
    if (!model) return null;

    // Clone ONLY when the model definition changes.
    // This prevents re-cloning on every render frame.
    const clone = useMemo(() => {
        const c = model.object.clone();
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
    }, [model, data.id, castShadow, receiveShadow]);

    return (
        <group 
            ref={internalRef}
            position={data.position}
            rotation={data.rotation}
            scale={data.scale}
            onClick={onClick}
            visible={visible}
        >
            <primitive object={clone} />
            
            {isSelected && (
                <boxHelper args={[clone, 0x3b82f6]} />
            )}
        </group>
    );
});

LevelObjectRenderer.displayName = 'LevelObjectRenderer';
