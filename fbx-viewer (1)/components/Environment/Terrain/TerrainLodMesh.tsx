import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { chooseChunkLevel, chunkBounds, chunkIndices, chunkLayout, MAX_LOD_LEVEL, skirtGeometryData, type TerrainChunk } from './terrainChunks';

interface ChunkRender {
    chunk: TerrainChunk;
    geometry: THREE.BufferGeometry;
    /** One index buffer per level, built on first use. */
    indices: (THREE.BufferAttribute | null)[];
    skirt: THREE.BufferGeometry;
    level: number | null;
    /** Chunk centre in the plane's local space. */
    centre: THREE.Vector3;
}

interface TerrainLodMeshProps {
    /** The full-resolution terrain geometry whose vertices every chunk shares. */
    source: THREE.BufferGeometry;
    segments: number;
    /** Changes whenever the heights do, so bounds and skirts are rebuilt. */
    version: unknown;
    material: THREE.Material;
    castShadow?: boolean;
    receiveShadow?: boolean;
}

const _cameraLocal = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/**
 * Draws a terrain as chunks whose vertex density drops with camera distance (terrainChunks.ts). Must
 * sit where the full-resolution mesh would (same rotation), as a sibling of it.
 */
export const TerrainLodMesh: React.FC<TerrainLodMeshProps> = ({ source, segments, version, material, castShadow, receiveShadow }) => {
    const groupRef = useRef<THREE.Group>(null);
    const chunks = useMemo<ChunkRender[]>(() => chunkLayout(segments).map(chunk => {
        const geometry = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'uv'] as const) {
            const attribute = source.getAttribute(name);
            if (attribute) geometry.setAttribute(name, attribute);
        }
        return { chunk, geometry, indices: new Array(MAX_LOD_LEVEL + 1).fill(null), skirt: new THREE.BufferGeometry(), level: null, centre: new THREE.Vector3() };
    }), [source, segments]);

    useEffect(() => () => chunks.forEach(render => {
        render.geometry.dispose();
        render.skirt.dispose();
    }), [chunks]);

    // Spacing of full-resolution vertices, for the distance at which a chunk first coarsens.
    const nearDistance = useMemo(() => {
        const box = source.boundingBox ?? (source.computeBoundingBox(), source.boundingBox);
        const size = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y) : 100;
        return Math.max(1, (size / Math.max(1, segments)) * 48);
    }, [source, segments, version]);

    const setLevel = (render: ChunkRender, level: number) => {
        if (render.level === level) return;
        render.level = level;
        render.indices[level] ??= new THREE.BufferAttribute(chunkIndices(segments, render.chunk, level), 1);
        render.geometry.setIndex(render.indices[level]);
        const positions = source.getAttribute('position');
        const normals = source.getAttribute('normal');
        if (!positions) return;
        const depth = Math.max(0.5, nearDistance / 24);
        const skirt = skirtGeometryData(positions.array as ArrayLike<number>, (normals?.array as ArrayLike<number>) ?? null, segments, render.chunk, level, depth);
        render.skirt.setAttribute('position', new THREE.BufferAttribute(skirt.positions, 3));
        render.skirt.setAttribute('normal', new THREE.BufferAttribute(skirt.normals, 3));
        render.skirt.setIndex(new THREE.BufferAttribute(skirt.indices, 1));
        render.skirt.computeBoundingSphere();
    };

    // Heights changed: new bounds for culling, and skirts follow the new edges.
    useEffect(() => {
        const positions = source.getAttribute('position');
        if (!positions) return;
        for (const render of chunks) {
            const { min, max } = chunkBounds(positions.array as ArrayLike<number>, segments, render.chunk);
            const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
            render.geometry.boundingBox = box;
            render.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
            box.getCenter(render.centre);
            const level = render.level;
            render.level = null;
            setLevel(render, level ?? MAX_LOD_LEVEL);
        }
    }, [chunks, source, segments, version]);

    useFrame(({ camera }) => {
        const group = groupRef.current;
        if (!group) return;
        group.updateWorldMatrix(true, false);
        _cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse.copy(group.matrixWorld).invert());
        for (const render of chunks) {
            setLevel(render, chooseChunkLevel(_cameraLocal.distanceTo(render.centre), nearDistance, render.level));
        }
    });

    return (
        <group ref={groupRef}>
            {chunks.map(render => (
                <React.Fragment key={`${render.chunk.cx}:${render.chunk.cy}`}>
                    <mesh geometry={render.geometry} material={material} castShadow={castShadow} receiveShadow={receiveShadow} raycast={() => null} />
                    <mesh geometry={render.skirt} material={material} receiveShadow={receiveShadow} raycast={() => null} />
                </React.Fragment>
            ))}
        </group>
    );
};
