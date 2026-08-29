
import React, { useRef, useLayoutEffect, useMemo, forwardRef, useImperativeHandle, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { LevelObject } from '../../../types';
import { SculptSettings } from '../types';

interface TerrainObjectProps {
    data: LevelObject;
    isSelected: boolean;
    visible: boolean;
    receiveShadow?: boolean;
    castShadow?: boolean;
    onClick?: (e: any) => void;
    // Sculpting Props
    sculptingEnabled?: boolean;
    sculptSettings?: SculptSettings;
    onHeightUpdate?: (id: string, heights: number[]) => void;
}

export const TerrainObject = forwardRef<THREE.Group, TerrainObjectProps>(({
    data,
    isSelected,
    visible,
    receiveShadow,
    castShadow,
    onClick,
    sculptingEnabled,
    sculptSettings,
    onHeightUpdate
}, ref) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const groupRef = useRef<THREE.Group>(null);
    const geometryRef = useRef<THREE.PlaneGeometry>(null);
    
    // Sculpting State
    const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null);
    const isSculpting = useRef(false);

    useImperativeHandle(ref, () => groupRef.current!, []);

    const { resolution, width, depth, heights } = data.terrainData || { resolution: 64, width: 100, depth: 100, heights: [] };

    // --- Material ---
    const material = useMemo(() => new THREE.MeshStandardMaterial({
        color: '#555555',
        roughness: 0.9,
        metalness: 0.1,
        flatShading: true,
        side: THREE.DoubleSide,
        vertexColors: false
    }), []);

    // --- Geometry Init ---
    useLayoutEffect(() => {
        if (!geometryRef.current) return;
        
        const geom = geometryRef.current;
        const posAttr = geom.attributes.position;
        
        if (heights && heights.length > 0) {
            if (heights.length !== posAttr.count) {
                // If resolution changed, mismatch might occur briefly. Safe to ignore or reset.
                return;
            }
            
            for (let i = 0; i < posAttr.count; i++) {
                posAttr.setZ(i, heights[i]);
            }
            posAttr.needsUpdate = true;
            geom.computeVertexNormals();
            geom.computeBoundingSphere();
        }
    }, [heights, resolution, width, depth]);

    // --- Sculpting Logic ---
    const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
        if (!sculptingEnabled || !sculptSettings || !meshRef.current || !geometryRef.current) return;
        
        // Always stop propagation in sculpt mode to prevent selecting objects behind terrain
        e.stopPropagation();
        
        // Update Brush Visual
        setHoverPoint(e.point.clone());

        // Perform Sculpt
        if (isSculpting.current) {
            applySculpt(e.point);
        }
    };

    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        if (!sculptingEnabled) {
            if(onClick) onClick(e);
            return;
        }
        
        // Only allow Left Click (0) for sculpting. Middle (1) and Right (2) should fall through for camera controls.
        if (e.button !== 0) return;

        e.stopPropagation();
        // R3F automatically captures pointer on the target mesh
        isSculpting.current = true;
        
        // Initial sculpt on click
        if (sculptSettings) {
            applySculpt(e.point);
        }
    };

    const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
        if (isSculpting.current) {
            isSculpting.current = false;
            
            // Commit changes to global state
            if (geometryRef.current && onHeightUpdate) {
                const posAttr = geometryRef.current.attributes.position;
                const newHeights: number[] = [];
                for(let i=0; i<posAttr.count; i++) {
                    newHeights.push(posAttr.getZ(i));
                }
                onHeightUpdate(data.id, newHeights);
            }
        }
    };

    const handlePointerOut = () => {
        setHoverPoint(null);
        if (isSculpting.current) {
            // End sculpt if we drag off the mesh entirely (failsafe)
            // Ideally pointer capture prevents this, but good to have.
            // We DON'T set isSculpting false here because R3F pointer capture keeps events firing on this mesh
            // even if mouse is outside, which is what we want. 
            // So we only hide the cursor.
        }
    };

    const applySculpt = (worldPoint: THREE.Vector3) => {
        const mesh = meshRef.current;
        const geom = geometryRef.current;
        if (!mesh || !geom || !sculptSettings) return;

        mesh.worldToLocal(worldPoint); // Modifies worldPoint in place to be local

        const posAttr = geom.attributes.position;
        const count = posAttr.count;
        
        // Retrieve settings
        const { radius, strength, tool, flattenHeight } = sculptSettings;
        
        // Adjust radius for local space scaling (average of X/Y scale since plane is X/Y in local)
        const avgScale = (mesh.scale.x + mesh.scale.y) / 2; 
        const localRadius = radius / avgScale;
        const radiusSq = localRadius * localRadius;
        
        // Power factor for smoothness
        const effectStrength = strength * 0.5;

        let modified = false;

        for (let i = 0; i < count; i++) {
            const x = posAttr.getX(i);
            const y = posAttr.getY(i); // Local Y is vertical on the plane geometry before rotation
            
            // Calc distance in 2D plane
            const dx = x - worldPoint.x;
            const dy = y - worldPoint.y;
            const distSq = dx*dx + dy*dy;

            if (distSq < radiusSq) {
                const dist = Math.sqrt(distSq);
                // Smooth falloff: (1 - r^2)^2 or Cosine falloff
                const falloff = Math.pow(1 - (dist / localRadius), 2); 
                const influence = falloff * effectStrength;

                const currentZ = posAttr.getZ(i); // Z is the displacement/height
                let newZ = currentZ;

                switch (tool) {
                    case 'raise':
                        newZ += influence;
                        break;
                    case 'lower':
                        newZ -= influence;
                        break;
                    case 'flatten':
                        // Lerp towards target height
                        newZ = THREE.MathUtils.lerp(currentZ, flattenHeight, influence * 0.5);
                        break;
                    case 'smooth':
                        // Simple smooth: Move towards average of neighbors (approximated by moving towards 0 relative to brush center or keeping inertia)
                        // Better simple smooth: Average current with pre-stroke average? 
                        // For now, just dampening peaks:
                        newZ = THREE.MathUtils.lerp(currentZ, currentZ * 0.9, influence);
                        break;
                }

                if (newZ !== currentZ) {
                    posAttr.setZ(i, newZ);
                    modified = true;
                }
            }
        }

        if (modified) {
            posAttr.needsUpdate = true;
            geom.computeVertexNormals();
            geom.computeBoundingSphere();
        }
    };

    // --- Cursor Color ---
    const cursorColor = useMemo(() => {
        if (!sculptSettings) return '#ffffff';
        switch(sculptSettings.tool) {
            case 'raise': return '#4ade80';
            case 'lower': return '#ef4444';
            case 'flatten': return '#3b82f6';
            case 'smooth': return '#f59e0b';
            default: return '#ffffff';
        }
    }, [sculptSettings?.tool]);

    return (
        <group 
            ref={groupRef}
            position={data.position} 
            rotation={data.rotation} 
            scale={data.scale}
            visible={visible}
            userData={{ levelObjectId: data.id, isTerrain: true }}
        >
            <mesh 
                ref={meshRef} 
                rotation={[-Math.PI / 2, 0, 0]} // Rotate to face up
                receiveShadow={receiveShadow}
                castShadow={castShadow}
                material={material}
                onPointerMove={handlePointerMove}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerOut={handlePointerOut}
                userData={{ levelObjectId: data.id, isTerrain: true }}
            >
                <planeGeometry 
                    ref={geometryRef} 
                    args={[width, depth, resolution, resolution]} 
                />
            </mesh>
            
            {/* Sculpt Brush Cursor - Rendered in WORLD space relative to group, or projected? 
                Actually, simpler to put it in the scene. 
                But putting it here makes it follow the terrain object transforms easily.
            */}
            {sculptingEnabled && hoverPoint && sculptSettings && (
                <mesh 
                    position={[hoverPoint.x - data.position[0], hoverPoint.y - data.position[1] + 0.1, hoverPoint.z - data.position[2]]} 
                    rotation={[-Math.PI / 2, 0, 0]}
                    // Undo the terrain rotation for the cursor to stay flat relative to world up?
                    // No, we want it flat on the ground. The Terrain Mesh is rotated -90 X. 
                    // So its local system has Z up. 
                    // We need to match.
                >
                    <ringGeometry args={[sculptSettings.radius - 0.2, sculptSettings.radius, 64]} />
                    <meshBasicMaterial color={cursorColor} transparent opacity={0.8} depthTest={false} depthWrite={false} toneMapped={false} />
                </mesh>
            )}

            {/* Selection Grid Overlay */}
            {isSelected && !sculptingEnabled && (
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => undefined}>
                    <planeGeometry args={[width, depth, resolution, resolution]} />
                    <meshBasicMaterial color="#3b82f6" wireframe transparent opacity={0.15} depthTest={false} />
                </mesh>
            )}
        </group>
    );
});

TerrainObject.displayName = 'TerrainObject';
