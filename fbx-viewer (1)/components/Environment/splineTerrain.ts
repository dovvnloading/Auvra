import * as THREE from 'three';
import type { LevelObject } from '../../types';
import type { Spline } from '../../runtime/splines';
import { createSplineFrame } from '../../runtime/splines';
import { terrainSamplesPerSide } from '../../utils/terrainHeightfieldCodec';
import { TERRAIN_SPLAT_CHANNELS, createDefaultTerrainSplat } from './Terrain/terrainSplatCodec';

/**
 * TERRAIN ALONG A SPLINE
 *
 * Shapes the terrain under a spline as a road or a river bed needs it: Flatten brings every sample
 * within half the width of the curve to the curve's height (less a depth, to sink a river), and
 * blends back to the terrain over the falloff on either side; Paint blends a texture layer in over
 * the same footprint. The width follows each point's width scale, so a road that widens at a
 * junction flattens wider there. Terrain rotation is not applied, as the terrain's own heightfield
 * does not apply it (runtime/terrainPhysics.ts).
 */

export interface SplineTerrainBrush {
    /** Full width of the flat (or painted) strip, metres. */
    width: number;
    /** Metres over which it blends back to the terrain on each side. */
    falloff: number;
    /** Metres below the curve the strip is set (Flatten only). */
    depth: number;
}

export const DEFAULT_SPLINE_TERRAIN_BRUSH: SplineTerrainBrush = { width: 6, falloff: 4, depth: 0 };

interface PathPoint {
    x: number;
    y: number;
    z: number;
    halfWidth: number;
}

/** The curve in world space, a step at most `step` long, with half the strip width at each point. */
export const splineWorldPath = (spline: Spline, matrix: THREE.Matrix4, width: number, step: number): PathPoint[] => {
    if (!(spline.length > 0)) return [];
    const count = Math.min(100000, Math.max(2, Math.ceil(spline.length / Math.max(step, 0.01)) + 1));
    const frame = createSplineFrame();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    // Width is measured across the ground: the object's horizontal scale.
    const objectWidth = (Math.abs(scale.x) + Math.abs(scale.z)) / 2;
    const path: PathPoint[] = [];
    for (let i = 0; i < count; i++) {
        spline.frameAt((spline.length * i) / (count - 1), frame);
        position.copy(frame.position).applyMatrix4(matrix);
        path.push({ x: position.x, y: position.y, z: position.z, halfWidth: (width / 2) * frame.scale.x * objectWidth });
    }
    return path;
};

interface TerrainGrid {
    samples: number;
    resolution: number;
    sizeX: number;
    sizeZ: number;
    scaleY: number;
    origin: [number, number, number];
}

const terrainGrid = (terrain: LevelObject): TerrainGrid | null => {
    const data = terrain.terrainData;
    if (!data || !(data.resolution >= 1) || !(data.width > 0) || !(data.depth > 0)) return null;
    const resolution = Math.floor(data.resolution);
    return {
        samples: terrainSamplesPerSide(resolution),
        resolution,
        sizeX: data.width * Math.abs(terrain.scale[0] || 1),
        sizeZ: data.depth * Math.abs(terrain.scale[2] || 1),
        scaleY: terrain.scale[1] || 1,
        origin: terrain.position,
    };
};

/**
 * For each terrain sample near the path: how much the strip covers it (1 inside half the width,
 * easing to 0 over the falloff) and the path's height there. Samples it does not reach are left out.
 */
const footprint = (grid: TerrainGrid, path: readonly PathPoint[], falloff: number): { weight: Float32Array; height: Float32Array } | null => {
    const { samples, resolution, sizeX, sizeZ, origin } = grid;
    const cellX = sizeX / resolution;
    const cellZ = sizeZ / resolution;
    const total = samples * samples;
    const best = new Float32Array(total).fill(Infinity);
    const weight = new Float32Array(total);
    const height = new Float32Array(total);
    let touched = false;
    for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const reach = Math.max(a.halfWidth, b.halfWidth) + falloff;
        const minColumn = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - origin[0]) / cellX + resolution / 2));
        const maxColumn = Math.min(samples - 1, Math.ceil((Math.max(a.x, b.x) + reach - origin[0]) / cellX + resolution / 2));
        const minRow = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - origin[2]) / cellZ + resolution / 2));
        const maxRow = Math.min(samples - 1, Math.ceil((Math.max(a.z, b.z) + reach - origin[2]) / cellZ + resolution / 2));
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        for (let row = minRow; row <= maxRow; row++) {
            const z = origin[2] + (row / resolution - 0.5) * sizeZ;
            for (let column = minColumn; column <= maxColumn; column++) {
                const x = origin[0] + (column / resolution - 0.5) * sizeX;
                const u = lengthSq > 1e-12 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
                const px = a.x + dx * u - x;
                const pz = a.z + dz * u - z;
                const distance = Math.sqrt(px * px + pz * pz);
                const halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * u;
                // Measured past the strip's edge, so a wide stretch is not overtaken by a narrow one nearby.
                const beyond = distance - halfWidth;
                const index = row * samples + column;
                if (beyond >= best[index]) continue;
                best[index] = beyond;
                const t = falloff > 0 ? Math.min(1, Math.max(0, beyond / falloff)) : (beyond > 0 ? 1 : 0);
                weight[index] = beyond <= 0 ? 1 : 1 - t * t * (3 - 2 * t);
                height[index] = a.y + (b.y - a.y) * u;
                touched = true;
            }
        }
    }
    return touched ? { weight, height } : null;
};

const pathStep = (grid: TerrainGrid) => Math.min(grid.sizeX / grid.resolution, grid.sizeZ / grid.resolution, 1) / 2;

/** The terrain's heights flattened under the spline, or null when the strip misses it (or its heights are still loading). */
export const flattenTerrainAlongSpline = (terrain: LevelObject, spline: Spline, matrix: THREE.Matrix4, brush: SplineTerrainBrush): number[] | null => {
    const grid = terrainGrid(terrain);
    if (!grid || (terrain.terrainData?.heightfield && !(terrain.terrainData.heights?.length))) return null;
    const path = splineWorldPath(spline, matrix, brush.width, pathStep(grid));
    const covered = footprint(grid, path, Math.max(0, brush.falloff));
    if (!covered) return null;
    const stored = terrain.terrainData?.heights;
    const heights = stored && stored.length === grid.samples * grid.samples ? stored.slice() : new Array<number>(grid.samples * grid.samples).fill(0);
    for (let i = 0; i < heights.length; i++) {
        const w = covered.weight[i];
        if (w <= 0) continue;
        const target = (covered.height[i] - brush.depth - grid.origin[1]) / grid.scaleY;
        const current = Number.isFinite(heights[i]) ? heights[i] : 0;
        heights[i] = current + (target - current) * w;
    }
    return heights;
};

/** The terrain's splat weights with `layer` painted under the spline, or null when the strip misses it. */
export const paintTerrainAlongSpline = (terrain: LevelObject, spline: Spline, matrix: THREE.Matrix4, brush: SplineTerrainBrush, layer: number): number[] | null => {
    const grid = terrainGrid(terrain);
    if (!grid || layer < 0 || layer >= TERRAIN_SPLAT_CHANNELS) return null;
    const data = terrain.terrainData;
    if (data?.splatmap && !(data.splat?.length)) return null;
    const path = splineWorldPath(spline, matrix, brush.width, pathStep(grid));
    const covered = footprint(grid, path, Math.max(0, brush.falloff));
    if (!covered) return null;
    const length = grid.samples * grid.samples * TERRAIN_SPLAT_CHANNELS;
    const weights = data?.splat && data.splat.length === length ? data.splat.slice() : Array.from(createDefaultTerrainSplat(grid.samples, grid.samples));
    const blended = [0, 0, 0, 0];
    for (let i = 0; i < grid.samples * grid.samples; i++) {
        const amount = covered.weight[i];
        if (amount <= 0) continue;
        const base = i * TERRAIN_SPLAT_CHANNELS;
        let sum = 0;
        for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c++) sum += weights[base + c];
        let rounded = 0;
        for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c++) {
            const share = sum > 0 ? weights[base + c] / sum : (c === 0 ? 1 : 0);
            blended[c] = Math.round((share * (1 - amount) + (c === layer ? amount : 0)) * 255);
            rounded += blended[c];
        }
        // Rounding can leave a unit off 255: the painted layer takes it.
        blended[layer] = Math.min(255, Math.max(0, blended[layer] + 255 - rounded));
        for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c++) weights[base + c] = blended[c];
    }
    return weights;
};

/** Each point's height set to the terrain under it (in the spline's space), where a terrain is under it. */
export const pointHeightsOnTerrain = (
    points: readonly [number, number, number][],
    matrix: THREE.Matrix4,
    surfaceHeight: (x: number, z: number) => number | null,
): ([number, number, number] | null)[] => {
    const inverse = matrix.clone().invert();
    const world = new THREE.Vector3();
    return points.map((point) => {
        world.set(...point).applyMatrix4(matrix);
        const height = surfaceHeight(world.x, world.z);
        if (height === null) return null;
        world.y = height;
        return world.applyMatrix4(inverse).toArray() as [number, number, number];
    });
};
