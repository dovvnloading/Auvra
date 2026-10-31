import React, { useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { HeightfieldCollider, RigidBody } from '@react-three/rapier';
import type { RapierCollider } from '@react-three/rapier';
import type { LevelObject, TextureData } from '../types';
import { MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE, terrainSamplesPerSide } from '../utils/terrainHeightfieldCodec';
import { useGameContent } from './GameContentContext';
import { physicsUserData, usePhysicsAvailable } from './physicsQueries';
import { surfaceFromName, tagSurface, type SurfaceKind, type SurfaceTag } from './surfaces';

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

/**
 * The terrain's surface height under a world point (bilinear between grid samples), or null off its
 * footprint or for a terrain that gets no heightfield. Like the heightfield (terrainHeightfieldShape),
 * the footprint and heights take the terrain's scale, and heights that are missing, still loading or
 * do not fit the grid give a flat surface at the terrain's own height. The terrain's rotation is not
 * applied.
 */
export const terrainSurfaceHeight = (worldX: number, worldZ: number, terrain: LevelObject): number | null => {
    const grid = terrainGrid(terrain);
    if (!grid) return null;
    const { resolution, samples, heights, scale } = grid;
    // Column 0 at -X and row 0 at the far (-Z) edge, as the rendered plane and the heightfield have them.
    const u = (worldX - terrain.position[0]) / scale.x + 0.5;
    const v = (worldZ - terrain.position[2]) / scale.z + 0.5;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
    if (!heights) return terrain.position[1];

    const gridX = u * resolution;
    const gridY = v * resolution;
    const c0 = Math.min(Math.floor(gridX), resolution - 1);
    const r0 = Math.min(Math.floor(gridY), resolution - 1);
    const tx = gridX - c0;
    const ty = gridY - r0;
    const at = (row: number, column: number) => {
        const height = heights[row * samples + column];
        return Number.isFinite(height) ? height : 0;
    };
    const near = at(r0, c0) * (1 - tx) + at(r0, c0 + 1) * tx;
    const far = at(r0 + 1, c0) * (1 - tx) + at(r0 + 1, c0 + 1) * tx;
    return terrain.position[1] + (near * (1 - ty) + far * ty) * scale.y;
};

/**
 * The ground a terrain is made of under a world point: the painted layer with the most weight at the
 * nearest grid sample, each layer's surface named by its texture (a 'Grass' or 'gravel_01' texture);
 * `base` off the terrain, unpainted, or for a layer whose texture names none.
 */
export const terrainSurfaceAt = (
    terrain: LevelObject,
    layers: readonly (SurfaceKind | null)[],
    base: SurfaceKind,
    worldX: number,
    worldZ: number,
): SurfaceKind => {
    const grid = terrainGrid(terrain);
    const splat = terrain.terrainData?.splat;
    if (!grid || !splat || splat.length !== grid.samples * grid.samples * 4 || layers.length === 0) return base;
    const u = (worldX - terrain.position[0]) / grid.scale.x + 0.5;
    const v = (worldZ - terrain.position[2]) / grid.scale.z + 0.5;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return base;
    const at = (Math.round(v * grid.resolution) * grid.samples + Math.round(u * grid.resolution)) * 4;
    let layer = 0;
    for (let channel = 1; channel < Math.min(4, layers.length); channel++) {
        if (splat[at + channel] > splat[at + layer]) layer = channel;
    }
    return layers[layer] ?? base;
};

/** A terrain's surface tag: its texture's surface, and its painted layers' by point. */
export const terrainSurfaceTag = (terrain: LevelObject, textures: readonly Pick<TextureData, 'id' | 'name'>[]): SurfaceTag => {
    const nameOf = (id: string | undefined) => (id ? textures.find(texture => texture.id === id)?.name : undefined);
    const base = surfaceFromName(nameOf(terrain.terrainData?.textureId)) ?? surfaceFromName(terrain.name) ?? 'default';
    const layers = (terrain.terrainData?.textureLayers ?? []).map(layer => surfaceFromName(nameOf(layer.textureId)));
    return layers.some(Boolean)
        ? { kind: base, at: (x, z) => terrainSurfaceAt(terrain, layers, base, x, z) }
        : { kind: base };
};

const FLAT_GROUND_EXTENT = 4000;
const FLAT_GROUND_CELLS = 64;
/** How far below y = 0 a terrain surface may reach before the flat ground drops below it. */
const FLAT_GROUND_TOLERANCE = 1e-3;
/** How far under the lowest terrain point the flat ground sits once a terrain reaches below y = 0. */
export const FLAT_GROUND_CLEARANCE = 0.01;

/**
 * Flat ground 4 km across, at flatGroundHeight. It is a flat heightfield rather than one huge box:
 * the character controller's sweeps lose precision against a box that large, so the player sank into
 * it and could fall through after a few jumps.
 */
export const FLAT_GROUND_SHAPE: TerrainHeightfieldShape = {
    rows: FLAT_GROUND_CELLS,
    columns: FLAT_GROUND_CELLS,
    heights: new Float32Array((FLAT_GROUND_CELLS + 1) * (FLAT_GROUND_CELLS + 1)),
    scale: { x: FLAT_GROUND_EXTENT, y: 1, z: FLAT_GROUND_EXTENT },
};

/**
 * Where the level's flat ground lies, for bodies and for the player alike: y = 0 (where the player has
 * always stood off terrain) unless a terrain reaches below it, then just under the lowest terrain
 * point. Every level has it, so whatever leaves the terrain lands somewhere, and it never covers a
 * terrain surface. Objects that are not terrains, or get no heightfield, do not move it.
 */
export const flatGroundHeight = (terrains: readonly LevelObject[]): number => {
    let lowest = 0;
    for (const terrain of terrains) {
        const surface = terrainLowestSurface(terrain);
        if (surface !== null && Number.isFinite(surface) && surface < lowest) lowest = surface;
    }
    return lowest >= -FLAT_GROUND_TOLERANCE ? 0 : lowest - FLAT_GROUND_CLEARANCE;
};

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
    // What it is made of, for tyres: tagged on the collider rather than rebuilding it.
    const { textures } = useGameContent();
    const surface = useMemo(() => terrainSurfaceTag(terrain, textures), [terrain, textures]);
    const tag = useCallback((collider: RapierCollider | null) => {
        if (collider) tagSurface(collider as RapierCollider & { userData?: unknown }, surface);
    }, [surface]);
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
            <HeightfieldCollider ref={tag} args={args} />
        </RigidBody>
    );
};

const FlatGroundCollider: React.FC<{ height: number }> = ({ height }) => {
    const args = useHeightfieldArgs(FLAT_GROUND_SHAPE);
    if (!args) return null;
    return (
        // A changed height moves the body; the collider args stay, so it is not rebuilt.
        <RigidBody type="fixed" colliders={false} position={[0, height, 0]}>
            <HeightfieldCollider args={args} />
        </RigidBody>
    );
};

/**
 * Static ground for physics play: a heightfield per terrain, plus the flat ground at flatGroundHeight
 * (y = 0, where the player has always stood off terrain, or just under the lowest terrain). Mount
 * inside PhysicsWorld.
 */
export const LevelGroundColliders: React.FC<{ terrains: readonly LevelObject[] }> = ({ terrains }) => {
    // Rapier bodies need a running world; without one the player falls back to terrain sampling.
    if (!usePhysicsAvailable()) return null;
    return (
        <>
            <FlatGroundCollider height={flatGroundHeight(terrains)} />
            {terrains.map(terrain => <TerrainCollider key={terrain.id} terrain={terrain} />)}
        </>
    );
};
