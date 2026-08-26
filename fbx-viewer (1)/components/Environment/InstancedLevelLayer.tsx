
import React, { useMemo, useLayoutEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';

interface InstancedLevelLayerProps {
    models: LoadedModelData[];
    levelObjects: LevelObject[];
    onSelect?: (id: string) => void;
    interactive?: boolean;
}

// Data structure for a single mesh part found within an FBX hierarchy
interface MeshPart {
    key: string;
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    relativeMatrix: THREE.Matrix4; // Transform relative to the model root
}

const InstancedModelGroup: React.FC<{
    model: LoadedModelData;
    instances: LevelObject[];
    onSelect?: (id: string) => void;
    interactive: boolean;
}> = ({ model, instances, onSelect, interactive }) => {
    
    // 1. Decompose the model into renderable parts (Geometries + Materials)
    const parts = useMemo(() => {
        const meshParts: MeshPart[] = [];
        const root = model.object;
        
        root.updateMatrix();
        root.updateMatrixWorld(true);

        const rootInverse = root.matrixWorld.clone().invert();
        const rootLocal = root.matrix.clone(); // Capture the normalization scale/offset

        root.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                
                // 1. Calculate transform of mesh relative to the Root's origin
                const relativeToRoot = mesh.matrixWorld.clone().premultiply(rootInverse);

                // 2. Combine with the Root's own local transform (Normalization)
                const bakedMatrix = relativeToRoot.premultiply(rootLocal);

                meshParts.push({
                    key: mesh.uuid,
                    geometry: mesh.geometry,
                    material: mesh.material,
                    relativeMatrix: bakedMatrix
                });
            }
        });
        return meshParts;
    }, [model]);

    return (
        <group>
            {parts.map(part => (
                <PartInstancer 
                    key={part.key} 
                    part={part} 
                    instances={instances} 
                    onSelect={onSelect}
                    interactive={interactive}
                />
            ))}
        </group>
    );
};

const PartInstancer: React.FC<{
    part: MeshPart;
    instances: LevelObject[];
    onSelect?: (id: string) => void;
    interactive: boolean;
}> = ({ part, instances, onSelect, interactive }) => {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const [hoveredInstanceId, setHoveredInstanceId] = useState<number | null>(null);

    // Reusable math objects
    const dummy = useMemo(() => new THREE.Object3D(), []);
    const instanceMat = useMemo(() => new THREE.Matrix4(), []);
    const hoverMatrix = useMemo(() => new THREE.Matrix4(), []);

    // 2. Update Matrices
    useLayoutEffect(() => {
        if (!meshRef.current) return;

        instances.forEach((data, i) => {
            // A. Setup the World Transform
            dummy.position.set(data.position[0], data.position[1], data.position[2]);
            dummy.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
            dummy.scale.set(data.scale[0], data.scale[1], data.scale[2]);
            dummy.updateMatrix();

            // B. Multiply by Part Offset
            instanceMat.multiplyMatrices(dummy.matrix, part.relativeMatrix);

            meshRef.current!.setMatrixAt(i, instanceMat);
        });

        meshRef.current.instanceMatrix.needsUpdate = true;
    }, [instances, part.relativeMatrix]);

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        if (!interactive || !onSelect) return;
        e.stopPropagation();
        if (e.instanceId !== undefined && instances[e.instanceId]) {
            onSelect(instances[e.instanceId].id);
        }
    };

    // Callback to update highlight mesh transform immediately upon mount/hover change
    const setHighlightRef = useCallback((node: THREE.Mesh | null) => {
        if (node && meshRef.current && hoveredInstanceId !== null) {
            meshRef.current.getMatrixAt(hoveredInstanceId, hoverMatrix);
            node.matrix.copy(hoverMatrix);
        }
    }, [hoveredInstanceId, hoverMatrix]);

    return (
        <>
            <instancedMesh
                ref={meshRef}
                args={[part.geometry, part.material, instances.length]}
                castShadow
                receiveShadow
                // Only bind events if interactive
                onClick={interactive ? handleClick : undefined}
                onPointerOver={interactive ? (e) => { e.stopPropagation(); setHoveredInstanceId(e.instanceId!); } : undefined}
                onPointerOut={interactive ? (e) => { e.stopPropagation(); setHoveredInstanceId(null); } : undefined}
                // If not interactive, ignore pointer events completely for raycasting optimization
                pointerEvents={interactive ? undefined : 'none'} 
            />

            {/* Highlight Overlay */}
            {interactive && hoveredInstanceId !== null && (
                <mesh 
                    ref={setHighlightRef}
                    geometry={part.geometry} 
                    matrixAutoUpdate={false}
                >
                    <meshBasicMaterial 
                        color="#a5f3fc" 
                        wireframe 
                        depthTest={false} 
                        depthWrite={false} 
                        transparent 
                        opacity={0.6} 
                    />
                </mesh>
            )}
        </>
    );
};

export const InstancedLevelLayer: React.FC<InstancedLevelLayerProps> = ({ models, levelObjects, onSelect, interactive = true }) => {
    
    // Group LevelObjects by Model ID
    const groups = useMemo(() => {
        const map = new Map<string, LevelObject[]>();
        
        if (levelObjects) {
            levelObjects.forEach(obj => {
                if (!map.has(obj.modelId)) {
                    map.set(obj.modelId, []);
                }
                map.get(obj.modelId)!.push(obj);
            });
        }

        return map;
    }, [levelObjects]);

    return (
        <group>
            {Array.from(groups.entries()).map(([modelId, instances]) => {
                const model = models.find(m => m.id === modelId);
                if (!model) return null;

                return (
                    <InstancedModelGroup 
                        key={modelId} 
                        model={model} 
                        instances={instances}
                        onSelect={onSelect}
                        interactive={interactive}
                    />
                );
            })}
        </group>
    );
};
