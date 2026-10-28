
import React, { useContext, useMemo, useLayoutEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';
import { chooseLodLevel, lodPixelsPerUnit, meshLodChain, type MeshLodLevel } from '../../utils/meshLod';
import { LOD_UPDATE_INTERVAL, MeshLodContext, useMeshLodReady } from '../Scene/useMeshLod';

interface InstancedLevelLayerProps {
    models: LoadedModelData[];
    /** Objects to draw. Their position/rotation/scale are used as world transforms. */
    levelObjects: LevelObject[];
    onSelect?: (id: string, event: ThreeEvent<MouseEvent>) => void;
    interactive?: boolean;
    /** Objects drawn somewhere else (the editor's selection proxies); their instances collapse to nothing. */
    hiddenIds?: ReadonlySet<string>;
    /** Objects drawn with the selection highlight. */
    selectedIds?: ReadonlySet<string>;
}

// Data structure for a single mesh part found within an FBX hierarchy
interface MeshPart {
    key: string;
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    relativeMatrix: THREE.Matrix4; // Transform relative to the model root
}

interface InstanceSelectionProps {
    hiddenIds?: ReadonlySet<string>;
    selectedIds?: ReadonlySet<string>;
}

// Shared by every selection overlay; never disposed with a mesh because it is passed through args.
const SELECTION_MATERIAL = new THREE.MeshBasicMaterial({
    color: '#3b82f6',
    wireframe: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.6,
    toneMapped: false
});

const noRaycast = () => undefined;
/** Marks the instanced meshes as level geometry for baked lighting (see runtime/lighting/bakedLighting.ts). */
const STATIC_LIGHTING = { staticLighting: true };

const InstancedModelGroup: React.FC<{
    model: LoadedModelData;
    instances: LevelObject[];
    onSelect?: (id: string, event: ThreeEvent<MouseEvent>) => void;
    interactive: boolean;
} & InstanceSelectionProps> = ({ model, instances, onSelect, interactive, hiddenIds, selectedIds }) => {
    const lodReady = useMeshLodReady();
    const lodAllowed = useContext(MeshLodContext);

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
            {parts.map((part) => {
                // In play the instances draw at the detail their size on the screen calls for; the
                // editor keeps one mesh per part, so its instance ids stay the objects' for picking.
                const levels = !interactive && lodReady && lodAllowed ? meshLodChain(part.geometry) : null;
                if (levels && levels.length > 1) {
                    return <LodPartInstancer key={part.key} part={part} levels={levels} instances={instances} hiddenIds={hiddenIds} />;
                }
                return (
                <PartInstancer
                    key={part.key}
                    part={part}
                    instances={instances}
                    onSelect={onSelect}
                    interactive={interactive}
                    hiddenIds={hiddenIds}
                    selectedIds={selectedIds}
                />
                );
            })}
        </group>
    );
};

const _lodCamera = new THREE.Vector3();

/**
 * A part's instances drawn at their detail levels: one instanced mesh per level, the instances
 * sorted into them by how large each shows on the screen (chooseLodLevel), every few frames.
 */
const LodPartInstancer: React.FC<{
    part: MeshPart;
    levels: MeshLodLevel[];
    instances: LevelObject[];
    hiddenIds?: ReadonlySet<string>;
}> = ({ part, levels, instances, hiddenIds }) => {
    const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
    const frame = useRef(0);
    // Each instance's world matrix, the middle of its bounds and its scale; null when hidden.
    const placed = useMemo(() => {
        const dummy = new THREE.Object3D();
        const base = levels[0].geometry;
        if (!base.boundingSphere) base.computeBoundingSphere();
        return instances.map((data) => {
            if (hiddenIds?.has(data.id)) return null;
            dummy.position.set(data.position[0], data.position[1], data.position[2]);
            dummy.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
            dummy.scale.set(data.scale[0], data.scale[1], data.scale[2]);
            dummy.updateMatrix();
            const matrix = new THREE.Matrix4().multiplyMatrices(dummy.matrix, part.relativeMatrix);
            return { matrix, centre: base.boundingSphere!.center.clone().applyMatrix4(matrix), scale: matrix.getMaxScaleOnAxis() };
        });
    }, [instances, hiddenIds, part.relativeMatrix, levels]);
    // The level each instance was last drawn at (-1: not yet sorted).
    const assigned = useMemo(() => new Int8Array(placed.length).fill(-1), [placed]);

    useFrame(({ camera, size }) => {
        const firstSort = assigned.length > 0 && assigned[0] === -1;
        if (!firstSort && frame.current++ % LOD_UPDATE_INTERVAL !== 0) return;
        const pixelsPerUnit = lodPixelsPerUnit(camera, size.height);
        camera.getWorldPosition(_lodCamera);
        let changed = firstSort;
        placed.forEach((instance, index) => {
            const level = instance ? chooseLodLevel(levels, instance.scale, instance.centre.distanceTo(_lodCamera), pixelsPerUnit) : -2;
            if (assigned[index] !== level) {
                assigned[index] = level;
                changed = true;
            }
        });
        if (!changed) return;
        const counts = levels.map(() => 0);
        placed.forEach((instance, index) => {
            const level = assigned[index];
            const mesh = meshes.current[level];
            if (!instance || level < 0 || !mesh) return;
            mesh.setMatrixAt(counts[level]++, instance.matrix);
        });
        meshes.current.forEach((mesh, level) => {
            if (!mesh) return;
            mesh.count = counts[level];
            mesh.instanceMatrix.needsUpdate = true;
            // The bounds follow the instances now drawn, so the whole set is culled correctly.
            mesh.boundingSphere = null;
            if (mesh.count) mesh.computeBoundingSphere();
        });
    });

    return (
        <>
            {levels.map((level, index) => (
                <instancedMesh
                    key={index}
                    ref={(mesh) => {
                        meshes.current[index] = mesh;
                        // Nothing draws until the first sort places the instances.
                        if (mesh && assigned.length && assigned[0] === -1) mesh.count = 0;
                    }}
                    args={[level.geometry, part.material, Math.max(1, instances.length)]}
                    castShadow
                    receiveShadow
                    raycast={noRaycast}
                    // Instanced objects never move, so baked lighting sees them as level geometry.
                    userData={STATIC_LIGHTING}
                />
            ))}
        </>
    );
};

const PartInstancer: React.FC<{
    part: MeshPart;
    instances: LevelObject[];
    onSelect?: (id: string, event: ThreeEvent<MouseEvent>) => void;
    interactive: boolean;
} & InstanceSelectionProps> = ({ part, instances, onSelect, interactive, hiddenIds, selectedIds }) => {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const selectionRef = useRef<THREE.InstancedMesh>(null);
    const [hoveredInstanceId, setHoveredInstanceId] = useState<number | null>(null);

    // Reusable math objects
    const dummy = useMemo(() => new THREE.Object3D(), []);
    const instanceMat = useMemo(() => new THREE.Matrix4(), []);
    const hoverMatrix = useMemo(() => new THREE.Matrix4(), []);
    const selectionMat = useMemo(() => new THREE.Matrix4(), []);

    // Instances that get the selection overlay (hidden ones are highlighted by whoever draws them).
    const selectedIndices = useMemo(() => {
        const indices: number[] = [];
        if (!selectedIds || selectedIds.size === 0) return indices;
        instances.forEach((data, i) => {
            if (selectedIds.has(data.id) && !hiddenIds?.has(data.id)) indices.push(i);
        });
        return indices;
    }, [instances, selectedIds, hiddenIds]);

    // 2. Update Matrices
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) return;

        instances.forEach((data, i) => {
            // A. Setup the World Transform (a hidden instance keeps its place but has no size)
            dummy.position.set(data.position[0], data.position[1], data.position[2]);
            dummy.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
            if (hiddenIds?.has(data.id)) dummy.scale.set(0, 0, 0);
            else dummy.scale.set(data.scale[0], data.scale[1], data.scale[2]);
            dummy.updateMatrix();

            // B. Multiply by Part Offset
            instanceMat.multiplyMatrices(dummy.matrix, part.relativeMatrix);

            mesh.setMatrixAt(i, instanceMat);
        });

        mesh.instanceMatrix.needsUpdate = true;
        // Bounds are computed once and cached; drop them so moved instances are not culled or missed by raycasts.
        mesh.boundingSphere = null;
        mesh.boundingBox = null;
    }, [instances, part.relativeMatrix, hiddenIds]);

    // 3. Selection overlay follows the instance matrices written above.
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlay = selectionRef.current;
        if (!mesh || !overlay) return;
        selectedIndices.forEach((index, slot) => {
            mesh.getMatrixAt(index, selectionMat);
            overlay.setMatrixAt(slot, selectionMat);
        });
        overlay.instanceMatrix.needsUpdate = true;
    }, [selectedIndices, instances, part.relativeMatrix, hiddenIds]);

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        if (!interactive || !onSelect) return;
        e.stopPropagation();
        if (e.instanceId !== undefined && instances[e.instanceId]) {
            onSelect(instances[e.instanceId].id, e);
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
                userData={STATIC_LIGHTING}
                // Only bind events if interactive
                onClick={interactive ? handleClick : undefined}
                onPointerOver={interactive ? (e) => { e.stopPropagation(); setHoveredInstanceId(e.instanceId!); } : undefined}
                onPointerOut={interactive ? (e) => { e.stopPropagation(); setHoveredInstanceId(null); } : undefined}
                // If not interactive, skip raycasting entirely.  R3F exposes
                // this through the Object3D raycast hook rather than a DOM
                // pointerEvents prop.
                raycast={interactive ? undefined : () => undefined}
            />

            {/* Selection Overlay (one instance per selected object of this part) */}
            {selectedIndices.length > 0 && (
                <instancedMesh
                    ref={selectionRef}
                    args={[part.geometry, SELECTION_MATERIAL, selectedIndices.length]}
                    frustumCulled={false}
                    renderOrder={1}
                    raycast={noRaycast}
                />
            )}

            {/* Highlight Overlay */}
            {interactive && hoveredInstanceId !== null && (
                <mesh
                    ref={setHighlightRef}
                    geometry={part.geometry}
                    matrixAutoUpdate={false}
                    raycast={() => undefined}
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

export const InstancedLevelLayer: React.FC<InstancedLevelLayerProps> = ({ models, levelObjects, onSelect, interactive = true, hiddenIds, selectedIds }) => {

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
                        hiddenIds={hiddenIds}
                        selectedIds={selectedIds}
                    />
                );
            })}
        </group>
    );
};
