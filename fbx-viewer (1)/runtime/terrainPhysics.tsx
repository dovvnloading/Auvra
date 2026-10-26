import React, { useMemo } from 'react';
import { CuboidCollider, HeightfieldCollider, RigidBody } from '@react-three/rapier';
import type { LevelObject } from '../types';
import { isTerrainHeightfieldPending, terrainSamplesPerSide } from '../utils/terrainHeightfieldCodec';
import { physicsUserData, usePhysicsAvailable } from './physics';

/** Rapier heightfield arguments for a terrain, in the terrain object's own space. */
export interface TerrainHeightfieldShape {
    /** Cells along Z (rows) and X (columns); the grid has one more sample per side. */
    rows: number;
    columns: number;
    /** Column-major heights, as Rapier expects. */
    heights: Float32Array;
    /** Full extent along X and Z, and the height multiplier along Y. */
    scale: { x: number; y: number; z: number };
}

/**
 * The heightfield for a terrain object, or null while its heights are not loaded.
 *
 * Terrain heights are row-major with row 0 at the far edge (-Z) and column 0 at -X, the same
 * vertex order as the rendered plane. Rapier's heightfield puts rows along Z and columns along X,
 * both from -half to +half, and stores heights column-major, so the grid is transposed.
 */
export const terrainHeightfieldShape = (terrain: LevelObject): TerrainHeightfieldShape | null => {
    const data = terrain.terrainData;
    if (!data || isTerrainHeightfieldPending(data)) return null;
    const resolution = Math.floor(data.resolution);
    const samples = terrainSamplesPerSide(resolution);
    const heights = data.heights;
    if (!(resolution >= 1) || !Array.isArray(heights) || heights.length !== samples * samples) return null;
    if (!(data.width > 0) || !(data.depth > 0)) return null;
    const columnMajor = new Float32Array(samples * samples);
    for (let row = 0; row < samples; row++) {
        for (let column = 0; column < samples; column++) {
            const height = heights[row * samples + column];
            columnMajor[row + column * samples] = Number.isFinite(height) ? height : 0;
        }
    }
    const [scaleX, scaleY, scaleZ] = terrain.scale;
    return {
        rows: resolution,
        columns: resolution,
        heights: columnMajor,
        scale: { x: data.width * Math.abs(scaleX || 1), y: scaleY || 1, z: data.depth * Math.abs(scaleZ || 1) },
    };
};

/** Half extent of the ground slab used when a level has no terrain. */
const GROUND_HALF_EXTENT = 2000;

const TerrainCollider: React.FC<{ terrain: LevelObject }> = ({ terrain }) => {
    const shape = useMemo(() => terrainHeightfieldShape(terrain), [terrain]);
    if (!shape) return null;
    return (
        // Unscaled body: the terrain's scale is already in the heightfield's extent.
        <RigidBody
            type="fixed"
            colliders={false}
            position={terrain.position}
            rotation={terrain.rotation}
            userData={physicsUserData(terrain.id)}
        >
            <HeightfieldCollider
                // A fresh scale object each time: the binding scales it in place.
                args={[shape.rows, shape.columns, shape.heights as unknown as number[], { ...shape.scale }]}
            />
        </RigidBody>
    );
};

/**
 * Static ground for physics play: a heightfield per terrain, or a flat slab at y = 0 for levels
 * without terrain (where the player has always stood). Mount inside PhysicsWorld.
 */
export const LevelGroundColliders: React.FC<{ terrains: readonly LevelObject[] }> = ({ terrains }) => {
    // Rapier bodies need a running world; without one the player falls back to terrain sampling.
    if (!usePhysicsAvailable()) return null;
    if (!terrains.length) {
        return (
            <RigidBody type="fixed" colliders={false}>
                <CuboidCollider args={[GROUND_HALF_EXTENT, 0.5, GROUND_HALF_EXTENT]} position={[0, -0.5, 0]} />
            </RigidBody>
        );
    }
    return (
        <>
            {terrains.map(terrain => <TerrainCollider key={terrain.id} terrain={terrain} />)}
        </>
    );
};
