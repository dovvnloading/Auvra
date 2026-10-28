import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { LevelNavMesh } from '../../runtime/navigation';

/**
 * Draws a level's navmesh over the World Editor scene (Show navigation in the toolbar): where
 * enemies can walk as a tinted surface with its polygons outlined, and Nav Links as lines.
 */

// Just above the surface it covers.
const LIFT = 0.04;

export const NavMeshOverlay: React.FC<{ navMesh: LevelNavMesh | null }> = ({ navMesh }) => {
    const geometries = useMemo(() => {
        if (!navMesh) return null;
        const { positions, indices, edges } = navMesh.debugGeometry();
        const surface = new THREE.BufferGeometry();
        surface.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        surface.setIndex(new THREE.BufferAttribute(indices, 1));
        surface.translate(0, LIFT, 0);
        const outline = new THREE.BufferGeometry();
        outline.setAttribute('position', new THREE.BufferAttribute(edges, 3));
        outline.translate(0, LIFT * 1.5, 0);
        return { surface, outline };
    }, [navMesh]);
    useEffect(() => () => {
        geometries?.surface.dispose();
        geometries?.outline.dispose();
    }, [geometries]);
    if (!navMesh || !geometries) return null;
    return (
        <group renderOrder={10}>
            <mesh geometry={geometries.surface} raycast={() => undefined}>
                <meshBasicMaterial color="#38bdf8" transparent opacity={0.4} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} toneMapped={false} />
            </mesh>
            <lineSegments geometry={geometries.outline} raycast={() => undefined}>
                <lineBasicMaterial color="#bae6fd" transparent opacity={0.6} depthWrite={false} toneMapped={false} />
            </lineSegments>
            {navMesh.links.map((link, index) => (
                <Line key={index} points={[link.start, link.end]} color="#22d3ee" lineWidth={2} raycast={() => undefined} />
            ))}
        </group>
    );
};
