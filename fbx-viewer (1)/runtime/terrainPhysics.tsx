import React, { useMemo } from 'react';
import * as THREE from 'three';
import { HeightfieldCollider, RigidBody } from '@react-three/rapier';
import type { LevelObject } from '../types';
import { MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE, terrainSamplesPerSide } from '../utils/terrainHeightfieldCodec';
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

type HeightfieldArgs = [number, number, number[], { x: number; y: number; z: number }];

interface TerrainGrid {
    resolution: number;
    samples: number;
    /** The row-major heights when they fill the grid; null (a flat field) when they are missing or malformed. */
    heights: readonly number[] | null;
    scale: TerrainHeightfieldShape['scale'];
}

/** The terrain's grid, or null when its resolution, width or depth cannot make one. */
const terrainGrid = (terrain: LevelObject): TerrainGrid | null => {
    const data = terrain.terrainData;
    if (!data) return null;
    const resolution = Math.floor(data.resolution);
    const samples = terrainSamplesPerSide(resolution);
    if (!(resolution >= 1) || samples > MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE) return null;
    if (!(data.width > 0) || !(data.depth > 0)) return null;
    const heights = Array.isArray(data.heights) && data.heights.length === samples * samples ? data.heights : null;
    const [scaleX, scaleY, scaleZ] = terrain.scale;
    return {
        resolution,
        samples,
        heights,
        scale: { x: data.width * Math.abs(scaleX || 1), y: scaleY || 1, z: data.depth * Math.abs(scaleZ || 1) },
    };
};

/**
 * The heightfield for a terrain object, or null when its grid itself is invalid (resolution, width
 * or depth). Heights that are still loading, were never sculpted or do not fit the grid give a flat
 * field: the surface TerrainObject draws, surface placement snaps to and the player stands on.
 *
 * Terrain heights are row-major with row 0 at the far edge (-Z) and column 0 at -X, the same
 * vertex order as the rendered plane. Rapier's heightfield puts rows along Z and columns along X,
 * both from -half to +half, and stores heights column-major, so the grid is transposed.
 */
export const terrainHeightfieldShape = (terrain: LevelObject): TerrainHeightfieldShape | null => {
    const grid = terrainGrid(terrain);
    if (!grid) return null;
    const { samples, heights } = grid;
    // Zero-filled, so a terrain without usable heights is flat at its position.
    const columnMajor = new Float32Array(samples * samples);
    if (heights) {
        for (let row = 0; row < samples; row++) {
            for (let column = 0; column < samples; column++) {
                const height = heights[row * samples + column];
                columnMajor[row + column * samples] = Number.isFinite(height) ? height : 0;
            }
        }
    }
    return { rows: grid.resolution, columns: grid.resolution, heights: columnMajor, scale: grid.scale };
};

/** Lowest and highest finite height per heights array, so the ground plan does not rescan a big grid every render. */
const heightRanges = new WeakMap<readonly number[], { min: number; max: number }>();

const heightRange = (heights: readonly number[] | null): { min: number; max: number } => {
    if (!heights) return { min: 0, max: 0 };
    const cached = heightRanges.get(heights);
    if (cached) return cached;
    let min = 0;
    let max = 0;
    for (const height of heights) {
        if (!Number.isFinite(height)) continue;
        if (height < min) min = height;
        if (height > max) max = height;
    }
    const range = { min, max };
    heightRanges.set(heights, range);
    return range;
};

/**
 * The lowest world height the terrain's heightfield can reach (its bounding box turned by the
 * terrain's rotation), or null for a terrain that gets no heightfield.
 */
export const terrainLowestSurface = (terrain: LevelObject): number | null => {
    const grid = terrainGrid(terrain);
    if (!grid) return null;
    const { min, max } = heightRange(grid.heights);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...terrain.rotation));
    const corner = new THREE.Vector3();
    let lowest = Infinity;
    for (const x of [-grid.scale.x / 2, grid.scale.x / 2]) {
        for (const y of [min * grid.scale.y, max * grid.scale.y]) {
            for (const z of [-grid.scale.z / 2, grid.scale.z / 2]) {
                lowest = Math.min(lowest, corner.set(x, y, z).applyQuaternion(quaternion).y);
            }
        }
    }
    return terrain.position[1] + lowest;
};

const FLAT_GROUND_EXTENT = 4000;
const FLAT_GROUND_CELLS = 64;
/** How far below y = 0 a terrain surface may reach before the flat ground would cover it. */
const FLAT_GROUND_TOLERANCE = 1e-3;

/**
 * Ground at y = 0, 4 km across. It is a flat heightfield rather than one huge box: the character
 * controller's sweeps lose precision against a box that large, so the player sank into it and could
 * fall through after a few jumps.
 */
export const FLAT_GROUND_SHAPE: TerrainHeightfieldShape = {
    rows: FLAT_GROUND_CELLS,
    columns: FLAT_GROUND_CELLS,
    heights: new Float32Array((FLAT_GROUND_CELLS + 1) * (FLAT_GROUND_CELLS + 1)),
    scale: { x: FLAT_GROUND_EXTENT, y: 1, z: FLAT_GROUND_EXTENT },
};

/**
 * Whether the level gets the flat ground at y = 0: always without terrain, and with terrain as long
 * as no terrain reaches below it. Off the terrain the player stands at y = 0, so bodies get ground
 * there too, while the flat ground never covers a terrain surface.
 */
export const levelNeedsFlatGround = (terrains: readonly LevelObject[]): boolean =>
    terrains.every(terrain => (terrainLowestSurface(terrain) ?? Infinity) >= -FLAT_GROUND_TOLERANCE);

/**
 * Collider args for a shape, memoised per shape: args that change identity make the binding remove
 * and rebuild the collider, waking everything resting on it. The binding scales the scale object in
 * place by the collider's world scale, so each shape gets its own copy; that scale is (1, 1, 1) for
 * these unscaled bodies, so a collider rebuilt from the same args (StrictMode) leaves it unchanged.
 */
const useHeightfieldArgs = (shape: TerrainHeightfieldShape | null): HeightfieldArgs | null =>
    useMemo(() => (shape ? [shape.rows, shape.columns, shape.heights as unknown as number[], { ...shape.scale }] : null), [shape]);

const TerrainCollider: React.FC<{ terrain: LevelObject }> = ({ terrain }) => {
    const { terrainData } = terrain;
    const [scaleX, scaleY, scaleZ] = terrain.scale;
    // Keyed on what the shape reads, so a terrain object re-created with the same data keeps its collider.
    const shape = useMemo(() => terrainHeightfieldShape(terrain), [terrainData, scaleX, scaleY, scaleZ]);
    const args = useHeightfieldArgs(shape);
    if (!args) return null;
    return (
        // Unscaled body: the terrain's scale is already in the heightfield's extent.
        <RigidBody
            type="fixed"
            colliders={false}
            position={terrain.position}
            rotation={terrain.rotation}
            userData={physicsUserData(terrain.id)}
        >
            <HeightfieldCollider args={args} />
        </RigidBody>
    );
};

const FlatGroundCollider: React.FC = () => {
    const args = useHeightfieldArgs(FLAT_GROUND_SHAPE);
    if (!args) return null;
    return (
        <RigidBody type="fixed" colliders={false}>
            <HeightfieldCollider args={args} />
        </RigidBody>
    );
};

/**
 * Static ground for physics play: a heightfield per terrain, plus flat ground at y = 0 (where the
 * player has always stood off terrain) unless a terrain reaches below it. Mount inside PhysicsWorld.
 */
export const LevelGroundColliders: React.FC<{ terrains: readonly LevelObject[] }> = ({ terrains }) => {
    // Rapier bodies need a running world; without one the player falls back to terrain sampling.
    if (!usePhysicsAvailable()) return null;
    return (
        <>
            {levelNeedsFlatGround(terrains) && <FlatGroundCollider />}
            {terrains.map(terrain => <TerrainCollider key={terrain.id} terrain={terrain} />)}
        </>
    );
};
