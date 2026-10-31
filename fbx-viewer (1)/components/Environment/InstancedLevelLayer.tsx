
import React, { useContext, useMemo, useLayoutEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { LoadedModelData, LevelObject } from '../../types';
import { isGpuRenderer } from '../../renderer/gpu/frame';
import { materialGraphOffsetsVertices } from '../../runtime/materials/graphMaterial';
import { OCCLUSION_MIN_TRIANGLES, type OcclusionSet } from '../../runtime/occlusionCulling';
import { OcclusionCullingContext } from '../../runtime/OcclusionCullingLayer';
import { cullViewFor, gateInstanceDraws, INSTANCE_NEEDS, seenBounds, seenTriangles, sortPlacedInstances, SPHERE_FLOATS, UNDRAWN_LAYER, writeSortedInstances, type CullView, type PlacedInstances } from '../../utils/instanceCulling';
import { meshLodChain, type MeshLodLevel } from '../../utils/meshLod';
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
/** The same for meshes whose instances change places from frame to frame (see utils/instanceCulling.ts). */
const CULLED_STATIC_LIGHTING = { staticLighting: true, shuffledInstances: true };

const soleLevels = new WeakMap<THREE.BufferGeometry, MeshLodLevel[]>();

/** The level of a part with no simpler versions to draw: itself, the same array every time. */
const soleLevel = (geometry: THREE.BufferGeometry): MeshLodLevel[] => {
    let levels = soleLevels.get(geometry);
    if (!levels) {
        levels = [{ geometry, error: 0, triangles: Math.floor((geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3) }];
        soleLevels.set(geometry, levels);
    }
    return levels;
};

const offsetsVertices = (material: MeshPart['material']): boolean =>
    Array.isArray(material) ? material.some(materialGraphOffsetsVertices) : materialGraphOffsetsVertices(material);

const InstancedModelGroup: React.FC<{
    model: LoadedModelData;
    instances: LevelObject[];
    onSelect?: (id: string, event: ThreeEvent<MouseEvent>) => void;
    interactive: boolean;
} & InstanceSelectionProps> = ({ model, instances, onSelect, interactive, hiddenIds, selectedIds }) => {
    const lodReady = useMeshLodReady();
    const lodAllowed = useContext(MeshLodContext);
    const gpuDrawn = useThree(state => isGpuRenderer(state.gl));

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
                // In play the instances draw at the detail their size on the screen calls for, and only
                // as a view needs them, even with one level to draw; the editor keeps one mesh per part, so
                // its instance ids stay the objects' for picking, and only that mesh shows the selection.
                // The GPU renderer culls each instance and picks its level itself: one mesh holds the whole set.
                const chain = !gpuDrawn && !interactive && lodReady && lodAllowed ? meshLodChain(part.geometry) : null;
                const levels = gpuDrawn ? null : chain && chain.length > 1 ? chain : !interactive && !selectedIds?.size ? soleLevel(part.geometry) : null;
                if (levels) {
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

/**
 * A part's instances drawn at their detail levels: one instanced mesh per level, the instances
 * sorted into them by how large each shows on the screen (chooseLodLevel) and by what the view needs
 * of them (utils/instanceCulling.ts), every few frames or as soon as the camera calls for it. One more
 * mesh holds the whole set, in order and never drawn, for what reads instances rather than draws them.
 */
const LodPartInstancer: React.FC<{
    part: MeshPart;
    levels: MeshLodLevel[];
    instances: LevelObject[];
    hiddenIds?: ReadonlySet<string>;
}> = ({ part, levels, instances, hiddenIds }) => {
    const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
    const whole = useRef<THREE.InstancedMesh | null>(null);
    // Each instance's world matrix, the sphere around its bounds and its scale; the hidden are left out.
    const placed = useMemo((): PlacedInstances => {
        const dummy = new THREE.Object3D();
        const matrix = new THREE.Matrix4();
        const centre = new THREE.Vector3();
        const base = levels[0].geometry;
        if (!base.boundingSphere) base.computeBoundingSphere();
        const shown = hiddenIds ? instances.filter(data => !hiddenIds.has(data.id)) : instances;
        const matrices = new Float32Array(shown.length * 16);
        const spheres = new Float32Array(shown.length * SPHERE_FLOATS);
        shown.forEach((data, index) => {
            dummy.position.set(data.position[0], data.position[1], data.position[2]);
            dummy.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
            dummy.scale.set(data.scale[0], data.scale[1], data.scale[2]);
            dummy.updateMatrix();
            matrix.multiplyMatrices(dummy.matrix, part.relativeMatrix).toArray(matrices, index * 16);
            centre.copy(base.boundingSphere!.center).applyMatrix4(matrix);
            const scale = matrix.getMaxScaleOnAxis();
            const at = index * SPHERE_FLOATS;
            spheres[at] = centre.x;
            spheres[at + 1] = centre.y;
            spheres[at + 2] = centre.z;
            spheres[at + 3] = base.boundingSphere!.radius * scale;
            spheres[at + 4] = scale;
        });
        return { count: shown.length, matrices, spheres };
    }, [instances, hiddenIds, part.relativeMatrix, levels]);
    // The slot each instance was last sorted into (-1: not yet sorted), and how many are in each.
    const assigned = useMemo(() => new Int8Array(placed.count).fill(-1), [placed]);
    const tally = useMemo(() => new Int32Array(levels.length * INSTANCE_NEEDS), [levels]);
    // What the set in the meshes was last sorted for, and what the camera's queries say of it.
    const sorted = useRef<{ placed: PlacedInstances | null; view: CullView | null; version: number; occlusion: OcclusionSet | null }>({ placed: null, view: null, version: 0, occlusion: null }).current;
    const occlusion = useContext(OcclusionCullingContext);

    useLayoutEffect(() => {
        if (!occlusion) return;
        const set = occlusion.add();
        sorted.occlusion = set;
        // Its box comes from a sort.
        sorted.placed = null;
        return () => {
            occlusion.remove(set);
            sorted.occlusion = null;
        };
    }, [occlusion, sorted]);

    useLayoutEffect(() => {
        const mesh = whole.current;
        if (!mesh) return;
        (mesh.instanceMatrix.array as Float32Array).set(placed.matrices);
        mesh.count = placed.count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.boundingSphere = null;
    }, [placed]);

    useFrame(({ camera, scene, size, gl }) => {
        const view = cullViewFor(camera, gl.shadowMap.enabled ? scene : null, gl.info.render.frame, size.height, LOD_UPDATE_INTERVAL);
        const firstSort = sorted.placed !== placed;
        if (!firstSort && sorted.view === view && sorted.version === view.version) return;
        sorted.placed = placed;
        sorted.view = view;
        sorted.version = view.version;
        // What a graph offsets can show from anywhere, so such a part is not culled by its bounds.
        const keepAll = offsetsVertices(part.material);
        const changed = sortPlacedInstances(placed, levels, view, keepAll, assigned, tally);
        writeSortedInstances(placed, assigned, tally, firstSort ? ~0 : changed, meshes.current);
        if (occlusion && sorted.occlusion && (firstSort || changed)) {
            occlusion.setDrawn(sorted.occlusion, seenBounds(placed, assigned), keepAll || seenTriangles(levels, tally) < OCCLUSION_MIN_TRIANGLES);
        }
    });

    return (
        <>
            {levels.map((level, index) => (
                <instancedMesh
                    key={index}
                    ref={(mesh) => {
                        meshes.current[index] = mesh;
                        if (!mesh) return;
                        gateInstanceDraws(mesh, index, tally, sorted);
                        // Nothing draws until the first sort places the instances.
                        if (sorted.placed !== placed) mesh.count = 0;
                    }}
                    args={[level.geometry, part.material, Math.max(1, instances.length)]}
                    castShadow
                    receiveShadow
                    raycast={noRaycast}
                    // Instanced objects never move, so baked lighting sees them as level geometry.
                    userData={CULLED_STATIC_LIGHTING}
                />
            ))}
            {/* The whole set for rays and decals: it holds still as the view turns, and no camera draws its layer. */}
            <instancedMesh
                ref={(mesh) => {
                    whole.current = mesh;
                    mesh?.layers.set(UNDRAWN_LAYER);
                }}
                args={[levels[0].geometry, part.material, Math.max(1, instances.length)]}
                castShadow
                raycast={noRaycast}
                userData={STATIC_LIGHTING}
            />
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
