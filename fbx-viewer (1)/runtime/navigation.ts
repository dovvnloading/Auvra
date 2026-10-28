import { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LevelComponent, LevelObject } from '../types';

/**
 * Navigation without a navmesh dependency ("navmesh-lite").
 *
 * buildNavGrid bakes a walkable grid over the level: every cell samples the
 * ground (terrain heightfields, else the y = 0 floor the player also falls
 * back to), is rejected when the ground is steeper than the slope limit, and
 * is blocked where a static obstacle, inflated by the agent radius, covers it.
 * Obstacles are enabled non-trigger 'collider' components (box, sphere,
 * capsule; mesh colliders and fixed auto-hull bodies use options.shapeBounds
 * when given) and, for props with a model but no colliders, the same circle
 * footprint the player's collision uses (props without a model, such as
 * lights, are not solid). Objects that move (mover/rotator components, or a
 * non-fixed rigidBody on the object or an ancestor) are not baked.
 *
 * Box collider tops agents can stand on (platforms, ramps, stairs) are baked
 * as raised walkable cells at their surface height, stacked bottom-up, and
 * kept the agent radius back from their ledges. Neighbouring cells connect
 * only where the step between their surfaces is at most maxStepHeight (plus
 * the rise a walkable slope makes over the run), so a platform without a ramp
 * or stairs up to it is a region of its own.
 *
 * findPath runs A* over those links (8-connected, no corner cutting) and
 * smooths the result by string pulling against grid line of sight. Walkable
 * cells are labelled into connected regions at build time, so an unreachable
 * target is rejected without searching.
 */

export interface NavPoint {
    x: number;
    y?: number;
    z: number;
}

export interface NavBounds {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

export interface NavGridOptions {
    /** Cell edge in metres (default 0.5). Grown automatically when the bounds would exceed maxCells. */
    cellSize?: number;
    /** Obstacles are inflated by this radius (default 0.4). */
    agentRadius?: number;
    /** Obstacles whose bottom is at least this far above the ground are walked under (default 1.8). */
    agentHeight?: number;
    /** Steepest walkable ground in degrees (default 40). */
    maxSlopeDegrees?: number;
    /**
     * Tallest step between neighbouring surfaces (the ground, collider tops); obstacles whose top is at
     * most this far above the surface are stepped over (default 0.35).
     */
    maxStepHeight?: number;
    /** Area to cover; defaults to the terrains and obstacles, plus padding, and at least +/-minHalfExtent. */
    bounds?: NavBounds;
    /** Margin added around the computed bounds (default 2). */
    padding?: number;
    /** The computed bounds always cover [-minHalfExtent, minHalfExtent] on X and Z (default 50, the AI arena). */
    minHalfExtent?: number;
    /** Upper limit on the cell count (default 512 * 512). */
    maxCells?: number;
    /** Footprint radius of a prop without a collider; null leaves it out. Defaults to the player's max(scale.x, scale.z) / 2. */
    propRadius?: (object: LevelObject, worldScale: THREE.Vector3) => number | null;
    /**
     * Object-local bounds of the geometry physics builds a 'mesh' collider or a fixed rigid body's
     * automatic hull from (the loaded model, import normalisation included); null when unknown.
     * Without it those objects fall back to the prop footprint circle.
     */
    shapeBounds?: (object: LevelObject) => THREE.Box3 | null;
}

export interface NavGrid {
    /** World X/Z of the min corner of cell (0, 0). Cell (column, row) has index row * columns + column. */
    originX: number;
    originZ: number;
    cellSize: number;
    columns: number;
    rows: number;
    /** 1 where an agent can stand. */
    walkable: Uint8Array;
    /** Surface height at each cell centre: the ground, or the collider top an agent stands on there. */
    heights: Float32Array;
    /** 1 where the surface is a collider top (platform, ramp, stairs) more than maxStepHeight above the ground under it. */
    raised: Uint8Array;
    /**
     * Steps an agent can take from each cell, one bit per neighbour: bits 0-3 for (column, row) offsets
     * (+1, 0), (-1, 0), (0, +1), (0, -1), bits 4-7 for the diagonals (+1, +1), (+1, -1), (-1, +1), (-1, -1).
     * Set where both cells are walkable and the step between their surfaces is climbable; a diagonal
     * also needs both orthogonal steps around it (no corner cutting).
     */
    links: Uint8Array;
    /** Connected walkable region of each cell (through orthogonal links); -1 when blocked. */
    regions: Int32Array;
    agentRadius: number;
    /** Tallest climb between neighbouring surfaces; obstacles at most this far above a surface were stepped over when baking. */
    maxStepHeight: number;
}

export interface FindPathOptions {
    /** When the target cannot be reached, return a path to the reachable cell closest to it instead of null. */
    partial?: boolean;
    /** String-pull the cell path into straight segments (default true). */
    smooth?: boolean;
    /** How far from/to may be moved to reach a walkable cell (default max(1, agentRadius + 1.5 cells)). */
    maxSnapDistance?: number;
    /** Cap on A* node expansions; exceeding it returns null (default: the cell count). */
    maxIterations?: number;
}

export interface NavPathResult {
    /** Waypoints from the start position to the end; y is the surface height (the endpoints keep their own y). */
    points: THREE.Vector3[];
    /** False when the path stops at the closest reachable point (partial). */
    reachable: boolean;
}

const DEFAULTS = {
    cellSize: 0.5,
    agentRadius: 0.4,
    agentHeight: 1.8,
    maxSlopeDegrees: 40,
    maxStepHeight: 0.35,
    padding: 2,
    minHalfExtent: 50,
    maxCells: 512 * 512,
};

// TerrainObject's defaults when a terrain object carries no terrainData.
const DEFAULT_TERRAIN = { resolution: 64, width: 100, depth: 100 };
const DYNAMIC_COMPONENT_TYPES: ReadonlySet<string> = new Set(['mover', 'rotator']);
// Smallest collider dimension physics builds (physicsComponents MIN_EXTENT).
const MIN_COLLIDER_EXTENT = 0.01;
const SQRT2 = Math.SQRT2;
// A collider top must rise this far above the surface below to replace it (a floor slab flush with the ground does not).
const SURFACE_EPSILON = 1e-3;
// Surface samples per cell length when a step between two cell centres is checked for stair treads narrower than a cell.
const STAIR_SAMPLES_PER_CELL = 4;
// Neighbour offsets (the NavGrid.links bit order): four orthogonal steps, then four diagonals.
const STEP_COLUMN = [1, -1, 0, 0, 1, 1, -1, -1];
const STEP_ROW = [0, 0, 1, -1, 1, -1, 1, -1];
const columnStep = (dc: number): number => (dc > 0 ? 0 : 1);
const rowStep = (dr: number): number => (dr > 0 ? 2 : 3);
const diagonalStep = (dc: number, dr: number): number => 4 + (dc > 0 ? 0 : 2) + (dr > 0 ? 0 : 1);
// Where an obstacle that does not cover a cell centre is sampled around it: 8 directions at half and full radius.
const RING_SAMPLES: Array<[number, number]> = [];
for (const scale of [0.5, 1]) {
    for (let i = 0; i < 8; i++) RING_SAMPLES.push([Math.cos((i * Math.PI) / 4) * scale, Math.sin((i * Math.PI) / 4) * scale]);
}

// ---------------------------------------------------------------------------
// Scene sampling
// ---------------------------------------------------------------------------

type WorldMatrixResolver = (id: string) => THREE.Matrix4;

/** World matrices with parent chains resolved once per object (same convention as utils/sceneGraph). */
const createWorldMatrixResolver = (index: ReadonlyMap<string, LevelObject>): WorldMatrixResolver => {
    const cache = new Map<string, THREE.Matrix4>();
    const resolving = new Set<string>();
    const resolve = (id: string): THREE.Matrix4 => {
        const cached = cache.get(id);
        if (cached) return cached;
        const object = index.get(id);
        const world = new THREE.Matrix4();
        if (!object) return world;
        const [px, py, pz] = object.position;
        const [rx, ry, rz] = object.rotation;
        const [sx, sy, sz] = object.scale;
        world.compose(
            new THREE.Vector3(px, py, pz),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
            new THREE.Vector3(sx, sy, sz),
        );
        const parentId = object.parentId;
        if (parentId && parentId !== id && index.has(parentId) && !resolving.has(id)) {
            resolving.add(id);
            world.premultiply(resolve(parentId));
            resolving.delete(id);
        }
        cache.set(id, world);
        return world;
    };
    return resolve;
};

const enabledComponents = (object: LevelObject): LevelComponent[] =>
    (object.components ?? []).filter(component => component.enabled !== false);

const isDynamicComponent = (component: LevelComponent): boolean => {
    if (DYNAMIC_COMPONENT_TYPES.has(component.type)) return true;
    // A rigid body is static only when it is explicitly fixed (Rapier bodies default to dynamic).
    return component.type === 'rigidBody' && component.props?.type !== 'fixed';
};

/** True when the object or one of its ancestors moves at runtime. */
const isDynamicObject = (object: LevelObject, index: ReadonlyMap<string, LevelObject>): boolean => {
    const visited = new Set<string>();
    let current: LevelObject | undefined = object;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (enabledComponents(current).some(isDynamicComponent)) return true;
        const parentId: string | null | undefined = current.parentId;
        current = parentId ? index.get(parentId) : undefined;
    }
    return false;
};

const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const vectorProp = (value: unknown, fallback: [number, number, number]): THREE.Vector3 => {
    if (Array.isArray(value)) {
        return new THREE.Vector3(finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2]));
    }
    if (value && typeof value === 'object') {
        const v = value as { x?: unknown; y?: unknown; z?: unknown };
        return new THREE.Vector3(finite(v.x, fallback[0]), finite(v.y, fallback[1]), finite(v.z, fallback[2]));
    }
    return new THREE.Vector3(...fallback);
};

interface TerrainSampler {
    bounds: NavBounds;
    /** World ground height at (x, z), or null when the point is off this terrain. */
    sample: (x: number, z: number) => number | null;
}

const boundsOfPoints = (points: THREE.Vector3[]): NavBounds => {
    const bounds: NavBounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    for (const point of points) {
        bounds.minX = Math.min(bounds.minX, point.x);
        bounds.maxX = Math.max(bounds.maxX, point.x);
        bounds.minZ = Math.min(bounds.minZ, point.z);
        bounds.maxZ = Math.max(bounds.maxZ, point.z);
    }
    return bounds;
};

/**
 * Samples a terrain like the player's ground snapping: bilinear over the
 * heightfield, which TerrainObject renders as a PlaneGeometry rotated -90
 * degrees about X (object-local z = -plane y, row 0 at plane y = +depth/2).
 * Terrains are assumed upright (rotated about Y only).
 */
const createTerrainSampler = (terrain: LevelObject, matrix: THREE.Matrix4): TerrainSampler | null => {
    const { resolution, width, depth } = terrain.terrainData ?? DEFAULT_TERRAIN;
    const segments = Math.floor(resolution);
    if (!(width > 0) || !(depth > 0) || segments < 1) return null;
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    const stride = segments + 1;
    const raw = terrain.terrainData?.heights;
    // Like TerrainObject, heights that do not describe the grid leave the terrain flat.
    const heights = raw && raw.length === stride * stride ? raw : null;
    const inverse = matrix.clone().invert();
    const halfW = width / 2;
    const halfD = depth / 2;
    const point = new THREE.Vector3();
    const height = (index: number): number => finite(heights?.[index], 0);

    const sample = (x: number, z: number): number | null => {
        point.set(x, 0, z).applyMatrix4(inverse);
        const localX = point.x;
        const localZ = point.z;
        const planeY = -localZ;
        if (localX < -halfW || localX > halfW || planeY < -halfD || planeY > halfD) return null;
        let h = 0;
        if (heights) {
            const gridX = ((localX + halfW) / width) * segments;
            const gridY = (1 - (planeY + halfD) / depth) * segments;
            const c0 = Math.min(Math.max(Math.floor(gridX), 0), segments);
            const r0 = Math.min(Math.max(Math.floor(gridY), 0), segments);
            const c1 = Math.min(c0 + 1, segments);
            const r1 = Math.min(r0 + 1, segments);
            const tx = gridX - c0;
            const ty = gridY - r0;
            const h0 = height(r0 * stride + c0) * (1 - tx) + height(r0 * stride + c1) * tx;
            const h1 = height(r1 * stride + c0) * (1 - tx) + height(r1 * stride + c1) * tx;
            h = h0 * (1 - ty) + h1 * ty;
        }
        return point.set(localX, h, localZ).applyMatrix4(matrix).y;
    };

    const corners = [
        new THREE.Vector3(-halfW, 0, -halfD),
        new THREE.Vector3(halfW, 0, -halfD),
        new THREE.Vector3(-halfW, 0, halfD),
        new THREE.Vector3(halfW, 0, halfD),
    ].map(corner => corner.applyMatrix4(matrix));
    return { bounds: boundsOfPoints(corners), sample };
};

/** Where a vertical line crosses an obstacle. */
interface VerticalSpan {
    bottom: number;
    top: number;
    /** Tangent of the slope of the face the line leaves through at the top (Infinity for a vertical face). */
    slope: number;
}

interface Obstacle {
    bounds: NavBounds;
    minY: number;
    maxY: number;
    /** True when an agent of `radius` standing at (x, z) overlaps the obstacle's footprint. */
    covers: (x: number, z: number, radius: number) => boolean;
    /** Boxes: writes the vertical line through (x, z)'s crossing of the obstacle to `out`; false when it misses. */
    span?: (x: number, z: number, out: VerticalSpan) => boolean;
    /** True when agents can stand on its top (box colliders), which then bakes as raised walkable cells. */
    standable?: boolean;
}

const circleObstacle = (centerX: number, centerZ: number, radius: number, minY: number, maxY: number): Obstacle => ({
    bounds: { minX: centerX - radius, maxX: centerX + radius, minZ: centerZ - radius, maxZ: centerZ + radius },
    minY,
    maxY,
    covers: (x, z, agentRadius) => {
        const reach = radius + agentRadius;
        const dx = x - centerX;
        const dz = z - centerZ;
        return dx * dx + dz * dz <= reach * reach;
    },
});

/** A capsule: every point within `radius` of the world segment a..b. Its footprint is that segment's XZ shadow, grown by radius. */
const segmentObstacle = (a: THREE.Vector3, b: THREE.Vector3, radius: number): Obstacle => {
    const segX = b.x - a.x;
    const segZ = b.z - a.z;
    const lengthSq = segX * segX + segZ * segZ;
    return {
        bounds: {
            minX: Math.min(a.x, b.x) - radius,
            maxX: Math.max(a.x, b.x) + radius,
            minZ: Math.min(a.z, b.z) - radius,
            maxZ: Math.max(a.z, b.z) + radius,
        },
        // Conservative: the whole capsule's vertical span, although it is thinner toward its ends.
        minY: Math.min(a.y, b.y) - radius,
        maxY: Math.max(a.y, b.y) + radius,
        covers: (x, z, agentRadius) => {
            const t = lengthSq > 1e-12 ? THREE.MathUtils.clamp(((x - a.x) * segX + (z - a.z) * segZ) / lengthSq, 0, 1) : 0;
            const dx = x - (a.x + segX * t);
            const dz = z - (a.z + segZ * t);
            const reach = radius + agentRadius;
            return dx * dx + dz * dz <= reach * reach;
        },
    };
};

const boxObstacle = (matrix: THREE.Matrix4, center: THREE.Vector3, half: THREE.Vector3, standable = false): Obstacle | null => {
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
        corners.push(new THREE.Vector3(
            center.x + (i & 1 ? half.x : -half.x),
            center.y + (i & 2 ? half.y : -half.y),
            center.z + (i & 4 ? half.z : -half.z),
        ).applyMatrix4(matrix));
    }
    const minY = Math.min(...corners.map(corner => corner.y));
    const maxY = Math.max(...corners.map(corner => corner.y));
    const midY = (minY + maxY) / 2;
    const inverse = matrix.clone().invert();
    const axisScale = new THREE.Vector3().setFromMatrixScale(matrix);
    const local = new THREE.Vector3();
    const e = inverse.elements;
    const lo = [center.x - half.x, center.y - half.y, center.z - half.z];
    const hi = [center.x + half.x, center.y + half.y, center.z + half.z];
    return {
        bounds: boundsOfPoints(corners),
        minY,
        maxY,
        covers: (x, z, agentRadius) => {
            local.set(x, midY, z).applyMatrix4(inverse);
            return Math.abs(local.x - center.x) <= half.x + agentRadius / Math.max(axisScale.x, 1e-6)
                && Math.abs(local.z - center.z) <= half.z + agentRadius / Math.max(axisScale.z, 1e-6);
        },
        span: (x, z, out) => {
            // In box space the world line (x, y, z) is origin + y * direction, so clipping it to each
            // axis slab bounds the world heights where it enters and leaves the box.
            let enter = -Infinity;
            let exit = Infinity;
            let exitAxis = -1;
            for (let axis = 0; axis < 3; axis++) {
                const origin = e[axis] * x + e[8 + axis] * z + e[12 + axis];
                const direction = e[4 + axis];
                if (Math.abs(direction) < 1e-12) {
                    if (origin < lo[axis] || origin > hi[axis]) return false;
                    continue;
                }
                const a = (lo[axis] - origin) / direction;
                const b = (hi[axis] - origin) / direction;
                if (Math.min(a, b) > enter) enter = Math.min(a, b);
                if (Math.max(a, b) < exit) {
                    exit = Math.max(a, b);
                    exitAxis = axis;
                }
            }
            if (exitAxis < 0 || enter > exit) return false;
            // Normals transform by the inverse transpose, so the exit face's normal is that row of the inverse.
            const up = Math.abs(e[4 + exitAxis]);
            out.bottom = enter;
            out.top = exit;
            out.slope = up > 1e-12 ? Math.hypot(e[exitAxis], e[8 + exitAxis]) / up : Infinity;
            return true;
        },
        standable,
    };
};

/**
 * The obstacle's vertical extent near (x, z) (within `radius`), written to `out`: exact where it
 * covers the point, else the hull of samples around it, else (no span, or no sample hits) its whole height.
 */
const extentNear = (obstacle: Obstacle, x: number, z: number, radius: number, out: VerticalSpan): void => {
    const span = obstacle.span;
    if (span) {
        if (span(x, z, out)) return;
        let bottom = Infinity;
        let top = -Infinity;
        for (const [dx, dz] of RING_SAMPLES) {
            if (!span(x + dx * radius, z + dz * radius, out)) continue;
            bottom = Math.min(bottom, out.bottom);
            top = Math.max(top, out.top);
        }
        if (top >= bottom) {
            out.bottom = bottom;
            out.top = top;
            return;
        }
    }
    out.bottom = obstacle.minY;
    out.top = obstacle.maxY;
};

const colliderObstacle = (component: LevelComponent, matrix: THREE.Matrix4): Obstacle | null => {
    const props = component.props ?? {};
    const shape = typeof props.shape === 'string' ? props.shape : 'box';
    const offset = vectorProp(props.offset, [0, 0, 0]);
    if (shape === 'box') {
        const size = vectorProp(props.size, [1, 1, 1]);
        return boxObstacle(matrix, offset, new THREE.Vector3(Math.abs(size.x) / 2, Math.abs(size.y) / 2, Math.abs(size.z) / 2), true);
    }
    if (shape === 'sphere') {
        const scale = new THREE.Vector3().setFromMatrixScale(matrix);
        const radius = Math.abs(finite(props.radius, 0.5));
        const center = offset.clone().applyMatrix4(matrix);
        const worldRadius = radius * Math.max(scale.x, scale.z);
        const worldHalfHeight = radius * scale.y;
        return circleObstacle(center.x, center.z, worldRadius, center.y - worldHalfHeight, center.y + worldHalfHeight);
    }
    if (shape === 'capsule') {
        // Like physics (resolveColliderSettings / capsuleHalfHeight): height is the full length, caps
        // included, along the object's local Y, so the capsule rotates with the object.
        const radius = Math.max(MIN_COLLIDER_EXTENT, finite(props.radius, 0.5));
        const height = Math.max(MIN_COLLIDER_EXTENT, finite(props.height, 2));
        const halfSegment = Math.max(0, height / 2 - radius);
        const scale = new THREE.Vector3().setFromMatrixScale(matrix);
        const a = new THREE.Vector3(offset.x, offset.y + halfSegment, offset.z).applyMatrix4(matrix);
        const b = new THREE.Vector3(offset.x, offset.y - halfSegment, offset.z).applyMatrix4(matrix);
        return segmentObstacle(a, b, radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)));
    }
    return null; // 'mesh' and unknown shapes use shapeBounds or the prop footprint
};

const defaultPropRadius = (_object: LevelObject, worldScale: THREE.Vector3): number =>
    Math.max(Math.abs(worldScale.x), Math.abs(worldScale.z)) * 0.5;

/** A box around the object's physics geometry (from shapeBounds), shifted by the collider offset. */
const shapeObstacle = (
    object: LevelObject,
    matrix: THREE.Matrix4,
    offset: THREE.Vector3,
    shapeBounds: NavGridOptions['shapeBounds'],
): Obstacle | null => {
    const box = shapeBounds?.(object);
    if (!box || box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3()).add(offset);
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    if (![center.x, center.y, center.z, half.x, half.y, half.z].every(Number.isFinite)) return null;
    return boxObstacle(matrix, center, half);
};

/**
 * True when collectObstacles can bake something for the object (ignoring whether it moves): a
 * non-trigger collider, a rigid body with no colliders (physics gives it an automatic hull), or the
 * player's legacy footprint, which only props with a model have (usePlayerPhysics isLegacySolidProp).
 */
const mayBlock = (object: LevelObject): boolean => {
    if (object.type === 'terrain' || object.type === 'sky_sphere') return false;
    const components = enabledComponents(object);
    const colliders = components.filter(component => component.type === 'collider');
    if (colliders.length > 0) return colliders.some(collider => collider.props?.isTrigger !== true);
    if (components.some(component => component.type === 'rigidBody')) return true;
    // A pickup is walked into, not around.
    return object.type === 'prop' && !!object.modelId && !components.some(component => component.type === 'pickup');
};

const collectObstacles = (
    levelObjects: readonly LevelObject[],
    index: ReadonlyMap<string, LevelObject>,
    worldMatrix: WorldMatrixResolver,
    propRadius: (object: LevelObject, worldScale: THREE.Vector3) => number | null,
    shapeBounds: NavGridOptions['shapeBounds'],
): Obstacle[] => {
    const obstacles: Obstacle[] = [];
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const noOffset = new THREE.Vector3();
    for (const object of levelObjects) {
        if (!mayBlock(object) || isDynamicObject(object, index)) continue;
        const components = enabledComponents(object);
        const colliders = components.filter(component => component.type === 'collider');
        const matrix = worldMatrix(object.id);
        let needsFootprint = colliders.length === 0;
        if (needsFootprint && components.some(component => component.type === 'rigidBody')) {
            // A fixed rigid body without colliders: physics wraps the object's meshes in a hull.
            const hull = shapeObstacle(object, matrix, noOffset, shapeBounds);
            if (hull) {
                obstacles.push(hull);
                continue;
            }
        }
        for (const collider of colliders) {
            if (collider.props?.isTrigger === true) continue;
            const obstacle = colliderObstacle(collider, matrix)
                ?? (collider.props?.shape === 'mesh' ? shapeObstacle(object, matrix, vectorProp(collider.props.offset, [0, 0, 0]), shapeBounds) : null);
            if (obstacle) obstacles.push(obstacle);
            else needsFootprint = true;
        }
        // Without a model there is nothing solid to fall back on (lights and other empty props).
        if (!needsFootprint || !object.modelId) continue;
        matrix.decompose(position, quaternion, scale);
        const radius = propRadius(object, scale);
        if (radius === null || !(radius > 0)) continue;
        // Without collider data the prop's height is unknown, so it blocks at every height.
        obstacles.push(circleObstacle(position.x, position.z, radius, -Infinity, Infinity));
    }
    return obstacles;
};

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

const unionBounds = (target: NavBounds, other: NavBounds): void => {
    target.minX = Math.min(target.minX, other.minX);
    target.minZ = Math.min(target.minZ, other.minZ);
    target.maxX = Math.max(target.maxX, other.maxX);
    target.maxZ = Math.max(target.maxZ, other.maxZ);
};

/** Connected components of walkable cells through orthogonal links (links are symmetric). */
const labelRegions = (walkable: Uint8Array, links: Uint8Array, columns: number): Int32Array => {
    const regions = new Int32Array(walkable.length).fill(-1);
    const queue = new Int32Array(walkable.length);
    let region = 0;
    for (let seed = 0; seed < walkable.length; seed++) {
        if (!walkable[seed] || regions[seed] !== -1) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = seed;
        regions[seed] = region;
        while (head < tail) {
            const cell = queue[head++];
            const cellLinks = links[cell];
            for (let k = 0; k < 4; k++) {
                if (((cellLinks >> k) & 1) === 0) continue;
                const next = cell + STEP_ROW[k] * columns + STEP_COLUMN[k];
                if (regions[next] === -1) {
                    regions[next] = region;
                    queue[tail++] = next;
                }
            }
        }
        region++;
    }
    return regions;
};

/** Bake the walkable grid for a level. Pass objects with their hierarchy (parentId) intact or as world-space copies. */
export function buildNavGrid(levelObjects: readonly LevelObject[], options: NavGridOptions = {}): NavGrid {
    const agentRadius = Math.max(0, finite(options.agentRadius, DEFAULTS.agentRadius));
    const agentHeight = Math.max(0, finite(options.agentHeight, DEFAULTS.agentHeight));
    const maxStepHeight = Math.max(0, finite(options.maxStepHeight, DEFAULTS.maxStepHeight));
    const maxSlope = Math.tan(THREE.MathUtils.degToRad(THREE.MathUtils.clamp(finite(options.maxSlopeDegrees, DEFAULTS.maxSlopeDegrees), 0, 89.9)));
    const maxCells = Math.max(1, Math.floor(finite(options.maxCells, DEFAULTS.maxCells)));

    const index = new Map<string, LevelObject>();
    for (const object of levelObjects) index.set(object.id, object);
    const worldMatrix = createWorldMatrixResolver(index);

    const terrains: TerrainSampler[] = [];
    for (const object of levelObjects) {
        if (object.type !== 'terrain') continue;
        const sampler = createTerrainSampler(object, worldMatrix(object.id));
        if (sampler) terrains.push(sampler);
    }
    const obstacles = collectObstacles(levelObjects, index, worldMatrix, options.propRadius ?? defaultPropRadius, options.shapeBounds);

    let bounds: NavBounds;
    if (options.bounds) {
        bounds = { ...options.bounds };
    } else {
        const half = Math.max(0, finite(options.minHalfExtent, DEFAULTS.minHalfExtent));
        const padding = Math.max(0, finite(options.padding, DEFAULTS.padding));
        bounds = { minX: -half, minZ: -half, maxX: half, maxZ: half };
        terrains.forEach(terrain => unionBounds(bounds, terrain.bounds));
        // Without terrain the ground is y = 0, so an obstacle that is always stepped over or walked
        // under (a floor slab, say) blocks nothing and must not stretch the grid and coarsen its cells.
        // A raised top agents can stand on counts even when it is out of reach from the ground.
        obstacles.forEach(obstacle => {
            if (terrains.length > 0 || (obstacle.maxY > maxStepHeight && (obstacle.minY < agentHeight || obstacle.standable))) {
                unionBounds(bounds, obstacle.bounds);
            }
        });
        bounds.minX -= padding;
        bounds.minZ -= padding;
        bounds.maxX += padding;
        bounds.maxZ += padding;
    }
    const width = Math.max(bounds.maxX - bounds.minX, 1e-3);
    const depth = Math.max(bounds.maxZ - bounds.minZ, 1e-3);
    let cellSize = Math.max(finite(options.cellSize, DEFAULTS.cellSize), 0.05);
    if ((width * depth) / (cellSize * cellSize) > maxCells) cellSize = Math.sqrt((width * depth) / maxCells);
    const columns = Math.max(1, Math.ceil(width / cellSize));
    const rows = Math.max(1, Math.ceil(depth / cellSize));
    const originX = bounds.minX;
    const originZ = bounds.minZ;
    const cellCount = columns * rows;

    const groundHeight = (x: number, z: number): number => {
        let best: number | null = null;
        for (const terrain of terrains) {
            const h = terrain.sample(x, z);
            if (h !== null && (best === null || h > best)) best = h;
        }
        return best ?? 0;
    };

    // Ground at cell corners; each cell takes their mean as its height and their gradient as its slope.
    const cornerStride = columns + 1;
    const corners = new Float32Array(cornerStride * (rows + 1));
    for (let row = 0; row <= rows; row++) {
        for (let column = 0; column <= columns; column++) {
            corners[row * cornerStride + column] = terrains.length > 0
                ? groundHeight(originX + column * cellSize, originZ + row * cellSize)
                : 0;
        }
    }

    const walkable = new Uint8Array(cellCount);
    const heights = new Float32Array(cellCount);
    // Tangent of each cell's surface slope.
    const slopes = new Float32Array(cellCount);
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const h00 = corners[row * cornerStride + column];
            const h10 = corners[row * cornerStride + column + 1];
            const h01 = corners[(row + 1) * cornerStride + column];
            const h11 = corners[(row + 1) * cornerStride + column + 1];
            const cell = row * columns + column;
            heights[cell] = (h00 + h10 + h01 + h11) / 4;
            const gradX = (h10 + h11 - h00 - h01) / (2 * cellSize);
            const gradZ = (h01 + h11 - h00 - h10) / (2 * cellSize);
            const slope = Math.hypot(gradX, gradZ);
            slopes[cell] = slope;
            walkable[cell] = slope <= maxSlope ? 1 : 0;
        }
    }
    const groundHeights = heights.slice();

    const centerX = (column: number): number => originX + (column + 0.5) * cellSize;
    const centerZ = (row: number): number => originZ + (row + 0.5) * cellSize;
    const visitCells = (area: NavBounds, margin: number, visit: (cell: number, x: number, z: number) => void): void => {
        const c0 = Math.max(0, Math.floor((area.minX - margin - originX) / cellSize));
        const c1 = Math.min(columns - 1, Math.floor((area.maxX + margin - originX) / cellSize));
        const r0 = Math.max(0, Math.floor((area.minZ - margin - originZ) / cellSize));
        const r1 = Math.min(rows - 1, Math.floor((area.maxZ + margin - originZ) / cellSize));
        for (let row = r0; row <= r1; row++) {
            for (let column = c0; column <= c1; column++) visit(row * columns + column, centerX(column), centerZ(row));
        }
    };

    // Collider tops agents stand on, stacked bottom-up: a walkable top replaces the surface below it
    // where its collider leaves no headroom over that surface (so agents walk under high ones).
    const standable = obstacles.filter(obstacle => obstacle.standable && obstacle.span).sort((a, b) => a.minY - b.minY);
    const span: VerticalSpan = { bottom: 0, top: 0, slope: 0 };
    const stacksOnto = (surface: number): boolean =>
        span.slope <= maxSlope && span.top > surface + SURFACE_EPSILON && span.bottom < surface + agentHeight;
    const onTop = new Uint8Array(cellCount);
    for (const obstacle of standable) {
        visitCells(obstacle.bounds, 0, (cell, x, z) => {
            if (!obstacle.span!(x, z, span) || !stacksOnto(heights[cell])) return;
            heights[cell] = span.top;
            slopes[cell] = span.slope;
            walkable[cell] = 1;
            onTop[cell] = 1;
        });
    }
    // The same stacking at any point, for steps between cell centres.
    const surfaceAt = (x: number, z: number): number => {
        let surface = terrains.length > 0 ? groundHeight(x, z) : 0;
        for (const obstacle of standable) {
            const { minX, minZ, maxX, maxZ } = obstacle.bounds;
            if (x < minX || x > maxX || z < minZ || z > maxZ || !obstacle.span!(x, z, span)) continue;
            if (stacksOnto(surface)) surface = span.top;
        }
        return surface;
    };

    // Obstacles are rasterized by testing cell centres. Inflating them by at least half a cell
    // diagonal keeps a thin wall from falling between centres once large bounds coarsen the cells;
    // at the default 0.5 m cell this is just the agent radius. An obstacle blocks a cell when, near
    // it, the obstacle rises more than a step above the cell's surface without headroom beneath.
    const rasterRadius = Math.max(agentRadius, cellSize * Math.SQRT1_2);
    const extent: VerticalSpan = { bottom: 0, top: 0, slope: 0 };
    for (const obstacle of obstacles) {
        visitCells(obstacle.bounds, rasterRadius, (cell, x, z) => {
            if (!walkable[cell]) return;
            const surface = heights[cell];
            if (obstacle.maxY <= surface + maxStepHeight || obstacle.minY >= surface + agentHeight) return;
            if (!obstacle.covers(x, z, rasterRadius)) return;
            extentNear(obstacle, x, z, rasterRadius, extent);
            if (extent.top <= surface + maxStepHeight || extent.bottom >= surface + agentHeight) return;
            walkable[cell] = 0;
        });
    }

    // Whether an agent can step between the surfaces of neighbouring cells: at most maxStepHeight up
    // or down, plus the rise walkable slopes on either side make over the run (ramps). Two ground
    // cells lie on one continuous heightfield, which the slope limit already covers.
    const diagonalRun = cellSize * SQRT2;
    const climbable = (a: number, b: number, run: number): boolean => {
        if (!onTop[a] && !onTop[b]) return true;
        const slopeA = Math.min(slopes[a], maxSlope);
        const slopeB = Math.min(slopes[b], maxSlope);
        if (Math.abs(heights[b] - heights[a]) <= maxStepHeight + (run * (slopeA + slopeB)) / 2) return true;
        // Stair treads narrower than a cell: walk the surface between the centres in short steps.
        const pieces = Math.ceil((run / cellSize) * STAIR_SAMPLES_PER_CELL);
        const limit = maxStepHeight + (run / pieces) * Math.max(slopeA, slopeB);
        const columnA = a % columns;
        const columnB = b % columns;
        const ax = centerX(columnA);
        const az = centerZ((a - columnA) / columns);
        const bx = centerX(columnB);
        const bz = centerZ((b - columnB) / columns);
        let previous = heights[a];
        for (let i = 1; i <= pieces; i++) {
            const t = i / pieces;
            const height = i === pieces ? heights[b] : surfaceAt(ax + (bx - ax) * t, az + (bz - az) * t);
            if (Math.abs(height - previous) > limit) return false;
            previous = height;
        }
        return true;
    };
    const climbs = new Uint8Array(cellCount);
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const cell = row * columns + column;
            if (!walkable[cell]) continue;
            for (let k = 0; k < 8; k++) {
                const nextColumn = column + STEP_COLUMN[k];
                const nextRow = row + STEP_ROW[k];
                if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
                if (climbable(cell, nextRow * columns + nextColumn, k >= 4 ? diagonalRun : cellSize)) climbs[cell] |= 1 << k;
            }
        }
    }

    // Ledges: where a collider top drops by more than a step (to the ground around a platform, say),
    // agents keep the raster radius back from the edge, as the inflated obstacles keep them off walls
    // on the low side. The edge is taken to run along the side (or through the corner) the two cells share.
    const eroded = new Uint8Array(cellCount);
    const half = cellSize / 2;
    const reach = Math.ceil(rasterRadius / cellSize) + 1;
    const radiusSq = rasterRadius * rasterRadius;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const cell = row * columns + column;
            if (!walkable[cell] || !onTop[cell]) continue;
            for (let k = 0; k < 8; k++) {
                const dc = STEP_COLUMN[k];
                const dr = STEP_ROW[k];
                const nextColumn = column + dc;
                const nextRow = row + dr;
                if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
                const next = nextRow * columns + nextColumn;
                if ((climbs[cell] >> k) & 1 || heights[next] >= heights[cell]) continue;
                const edgeX = centerX(column) + dc * half;
                const edgeZ = centerZ(row) + dr * half;
                const edgeHalfX = dc === 0 ? half : 0;
                const edgeHalfZ = dr === 0 ? half : 0;
                const above = heights[next] + maxStepHeight;
                for (let r = Math.max(0, row - reach); r <= Math.min(rows - 1, row + reach); r++) {
                    for (let c = Math.max(0, column - reach); c <= Math.min(columns - 1, column + reach); c++) {
                        const near = r * columns + c;
                        if (eroded[near] || !walkable[near] || !onTop[near] || heights[near] <= above) continue;
                        const qx = Math.max(Math.abs(centerX(c) - edgeX) - edgeHalfX, 0);
                        const qz = Math.max(Math.abs(centerZ(r) - edgeZ) - edgeHalfZ, 0);
                        if (qx * qx + qz * qz <= radiusSq) eroded[near] = 1;
                    }
                }
            }
        }
    }
    for (let cell = 0; cell < cellCount; cell++) {
        if (eroded[cell]) walkable[cell] = 0;
    }

    // Links between walkable neighbours that can be climbed; diagonals need both orthogonal steps too.
    const links = new Uint8Array(cellCount);
    for (let cell = 0; cell < cellCount; cell++) {
        if (!walkable[cell]) continue;
        for (let k = 0; k < 4; k++) {
            if (((climbs[cell] >> k) & 1) && walkable[cell + STEP_ROW[k] * columns + STEP_COLUMN[k]]) links[cell] |= 1 << k;
        }
    }
    for (let cell = 0; cell < cellCount; cell++) {
        if (!walkable[cell]) continue;
        for (let k = 4; k < 8; k++) {
            const dc = STEP_COLUMN[k];
            const dr = STEP_ROW[k];
            const alongColumn = columnStep(dc);
            const alongRow = rowStep(dr);
            if (((climbs[cell] >> k) & 1) === 0 || ((links[cell] >> alongColumn) & 1) === 0 || ((links[cell] >> alongRow) & 1) === 0) continue;
            if ((links[cell + dc] >> alongRow) & 1 && (links[cell + dr * columns] >> alongColumn) & 1) links[cell] |= 1 << k;
        }
    }

    const raised = new Uint8Array(cellCount);
    for (let cell = 0; cell < cellCount; cell++) {
        if (onTop[cell] && heights[cell] - groundHeights[cell] > maxStepHeight) raised[cell] = 1;
    }

    return {
        originX,
        originZ,
        cellSize,
        columns,
        rows,
        walkable,
        heights,
        raised,
        links,
        regions: labelRegions(walkable, links, columns),
        agentRadius,
        maxStepHeight,
    };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const cellIndexAt = (grid: NavGrid, x: number, z: number): number => {
    const column = Math.floor((x - grid.originX) / grid.cellSize);
    const row = Math.floor((z - grid.originZ) / grid.cellSize);
    if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return -1;
    return row * grid.columns + column;
};

const cellCenter = (grid: NavGrid, cell: number): THREE.Vector3 => {
    const column = cell % grid.columns;
    const row = (cell - column) / grid.columns;
    return new THREE.Vector3(
        grid.originX + (column + 0.5) * grid.cellSize,
        grid.heights[cell],
        grid.originZ + (row + 0.5) * grid.cellSize,
    );
};

/** True when (x, z) lies on a walkable cell. */
export function isWalkable(grid: NavGrid, x: number, z: number): boolean {
    const cell = cellIndexAt(grid, x, z);
    return cell >= 0 && grid.walkable[cell] === 1;
}

/**
 * Whether a point planPath cannot reach is really shut off at ground level (a closed pen), rather
 * than out of the grid's reach: off the grid is unbaked open ground; a point on a raised collider
 * top (a platform, ramp or stairs with no walkable way up) may still be reached by climbing or
 * jumping; and a point more than a step above a blocked cell stands on something the grid bakes as
 * solid. A point without y is taken to be on the ground.
 */
export function isWalledOff(grid: NavGrid, point: NavPoint): boolean {
    const cell = cellIndexAt(grid, point.x, point.z);
    if (cell < 0) return false;
    if (point.y === undefined) return true;
    // Below a raised top the point is at ground level beside or under it.
    if (grid.raised[cell] === 1) return point.y < grid.heights[cell] - grid.maxStepHeight;
    return grid.walkable[cell] === 1 || point.y - grid.heights[cell] <= grid.maxStepHeight;
}

/**
 * How far a point is off a cell's surface vertically, for snapping. Within a step of the surface it
 * is on it; further below it is not (under or beside a raised top), which weighs heavily; further
 * above (jumping, falling) weighs lightly.
 */
const surfaceGap = (grid: NavGrid, cell: number, y: number | undefined): number => {
    if (y === undefined) return 0;
    const below = grid.heights[cell] - grid.maxStepHeight - y;
    if (below > 0) return below * 2;
    const above = y - grid.heights[cell] - grid.maxStepHeight;
    return above > 0 ? above * 0.25 : 0;
};

/**
 * The walkable cell nearest the point within maxDistance (in XZ; the surface gap weighs in when the
 * point has a y), preferring `region` when any cell of it is in range; -1 when none.
 */
const nearestWalkableCell = (grid: NavGrid, point: NavPoint, maxDistance: number, region = -1): number => {
    const { x, y, z } = point;
    const own = cellIndexAt(grid, x, z);
    if (own >= 0 && grid.walkable[own] && (region < 0 || grid.regions[own] === region) && surfaceGap(grid, own, y) === 0) return own;
    const { cellSize, columns, rows, originX, originZ } = grid;
    const reach = Math.ceil(maxDistance / cellSize);
    const centerColumn = Math.floor((x - originX) / cellSize);
    const centerRow = Math.floor((z - originZ) / cellSize);
    let best = -1;
    let bestDistance = Infinity;
    let bestAny = -1;
    let bestAnyDistance = Infinity;
    const limit = maxDistance * maxDistance;
    for (let row = Math.max(0, centerRow - reach); row <= Math.min(rows - 1, centerRow + reach); row++) {
        for (let column = Math.max(0, centerColumn - reach); column <= Math.min(columns - 1, centerColumn + reach); column++) {
            const cell = row * columns + column;
            if (!grid.walkable[cell]) continue;
            const dx = originX + (column + 0.5) * cellSize - x;
            const dz = originZ + (row + 0.5) * cellSize - z;
            const flat = dx * dx + dz * dz;
            if (flat > limit) continue;
            const gap = surfaceGap(grid, cell, y);
            const distance = flat + gap * gap;
            if (distance < bestAnyDistance) {
                bestAnyDistance = distance;
                bestAny = cell;
            }
            if (region >= 0 && grid.regions[cell] === region && distance < bestDistance) {
                bestDistance = distance;
                best = cell;
            }
        }
    }
    return best >= 0 ? best : bestAny;
};

const closestCellInRegion = (grid: NavGrid, region: number, x: number, z: number): number => {
    let best = -1;
    let bestDistance = Infinity;
    for (let cell = 0; cell < grid.regions.length; cell++) {
        if (grid.regions[cell] !== region) continue;
        const column = cell % grid.columns;
        const row = (cell - column) / grid.columns;
        const dx = grid.originX + (column + 0.5) * grid.cellSize - x;
        const dz = grid.originZ + (row + 0.5) * grid.cellSize - z;
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = cell;
        }
    }
    return best;
};

const walkableCell = (grid: NavGrid, column: number, row: number): boolean =>
    column >= 0 && row >= 0 && column < grid.columns && row < grid.rows && grid.walkable[row * grid.columns + column] === 1;

/**
 * True when the straight segment a -> b crosses only walkable cells, each linked to the one before
 * (no ledges or tall steps; corner crossings need the diagonal link, so both side cells as well).
 */
export function hasLineOfSight(grid: NavGrid, a: NavPoint, b: NavPoint): boolean {
    const { cellSize, originX, originZ, columns, links } = grid;
    const x0 = (a.x - originX) / cellSize;
    const z0 = (a.z - originZ) / cellSize;
    const x1 = (b.x - originX) / cellSize;
    const z1 = (b.z - originZ) / cellSize;
    let column = Math.floor(x0);
    let row = Math.floor(z0);
    if (!walkableCell(grid, column, row)) return false;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepColumn = Math.sign(dx);
    const stepRow = Math.sign(dz);
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx > 0 ? (column + 1 - x0) * tDeltaX : dx < 0 ? (x0 - column) * tDeltaX : Infinity;
    let tMaxZ = dz > 0 ? (row + 1 - z0) * tDeltaZ : dz < 0 ? (z0 - row) * tDeltaZ : Infinity;
    // Walk every cell the segment enters, stopping once the next crossing lies beyond its end (t = 1).
    let steps = Math.abs(Math.floor(x1) - column) + Math.abs(Math.floor(z1) - row) + 2;
    while (Math.min(tMaxX, tMaxZ) < 1 - 1e-9 && steps-- > 0) {
        const cellLinks = links[row * columns + column];
        if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
            if (((cellLinks >> diagonalStep(stepColumn, stepRow)) & 1) === 0) return false;
            column += stepColumn;
            row += stepRow;
            tMaxX += tDeltaX;
            tMaxZ += tDeltaZ;
        } else if (tMaxX < tMaxZ) {
            if (((cellLinks >> columnStep(stepColumn)) & 1) === 0) return false;
            column += stepColumn;
            tMaxX += tDeltaX;
        } else {
            if (((cellLinks >> rowStep(stepRow)) & 1) === 0) return false;
            row += stepRow;
            tMaxZ += tDeltaZ;
        }
    }
    return steps >= 0; // Running out of steps means the walk lost the segment: no sight.
}

interface SearchScratch {
    generation: number;
    opened: Uint32Array;
    closed: Uint32Array;
    cost: Float64Array;
    parent: Int32Array;
    /** Binary min-heap of (cell, f) entries; stale entries are skipped when popped. */
    heapCells: Int32Array;
    heapKeys: Float64Array;
}

// Search buffers live with their grid so repeated queries do not reallocate.
const scratchByGrid = new WeakMap<NavGrid, SearchScratch>();

const scratchFor = (grid: NavGrid): SearchScratch => {
    const count = grid.columns * grid.rows;
    let scratch = scratchByGrid.get(grid);
    if (!scratch || scratch.opened.length !== count) {
        scratch = {
            generation: 0,
            opened: new Uint32Array(count),
            closed: new Uint32Array(count),
            cost: new Float64Array(count),
            parent: new Int32Array(count),
            heapCells: new Int32Array(1024),
            heapKeys: new Float64Array(1024),
        };
        scratchByGrid.set(grid, scratch);
    }
    scratch.generation++;
    if (scratch.generation >= 0xffffffff) {
        scratch.opened.fill(0);
        scratch.closed.fill(0);
        scratch.generation = 1;
    }
    return scratch;
};

// A hair over 1 breaks f-ties toward the goal, which saves most expansions on open ground.
const HEURISTIC_WEIGHT = 1.001;

/** A* over cell links; returns the cell chain start..goal, or null when the goal is not found within maxIterations. */
const searchCells = (grid: NavGrid, start: number, goal: number, maxIterations: number): number[] | null => {
    const { columns, cellSize, heights, links } = grid;
    const scratch = scratchFor(grid);
    const { generation, opened, closed, cost, parent } = scratch;
    let heapCells = scratch.heapCells;
    let heapKeys = scratch.heapKeys;
    let heapSize = 0;
    const goalColumn = goal % columns;
    const goalRow = (goal - goalColumn) / columns;
    const diagonal = cellSize * SQRT2;
    const heuristic = (column: number, row: number): number => {
        const dx = column > goalColumn ? column - goalColumn : goalColumn - column;
        const dz = row > goalRow ? row - goalRow : goalRow - row;
        return (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx) * cellSize * HEURISTIC_WEIGHT;
    };
    const push = (cell: number, key: number) => {
        if (heapSize === heapCells.length) {
            const grownCells = new Int32Array(heapSize * 2);
            const grownKeys = new Float64Array(heapSize * 2);
            grownCells.set(heapCells);
            grownKeys.set(heapKeys);
            heapCells = scratch.heapCells = grownCells;
            heapKeys = scratch.heapKeys = grownKeys;
        }
        let i = heapSize++;
        while (i > 0) {
            const up = (i - 1) >> 1;
            if (heapKeys[up] <= key) break;
            heapCells[i] = heapCells[up];
            heapKeys[i] = heapKeys[up];
            i = up;
        }
        heapCells[i] = cell;
        heapKeys[i] = key;
    };
    const pop = (): number => {
        const top = heapCells[0];
        const lastCell = heapCells[--heapSize];
        const lastKey = heapKeys[heapSize];
        let i = 0;
        for (;;) {
            const left = i * 2 + 1;
            if (left >= heapSize) break;
            const right = left + 1;
            const child = right < heapSize && heapKeys[right] < heapKeys[left] ? right : left;
            if (heapKeys[child] >= lastKey) break;
            heapCells[i] = heapCells[child];
            heapKeys[i] = heapKeys[child];
            i = child;
        }
        heapCells[i] = lastCell;
        heapKeys[i] = lastKey;
        return top;
    };

    opened[start] = generation;
    cost[start] = 0;
    parent[start] = -1;
    push(start, 0);
    let iterations = 0;
    while (heapSize > 0) {
        const cell = pop();
        if (closed[cell] === generation) continue;
        closed[cell] = generation;
        if (cell === goal) {
            const chain: number[] = [];
            for (let at = goal; at !== -1; at = parent[at]) chain.push(at);
            return chain.reverse();
        }
        if (++iterations > maxIterations) return null;
        const column = cell % columns;
        const row = (cell - column) / columns;
        const cellCost = cost[cell];
        const cellHeight = heights[cell];
        const cellLinks = links[cell];
        for (let k = 0; k < 8; k++) {
            // Links cover walkability, climbable steps and corner cutting (a diagonal needs both orthogonal steps).
            if (((cellLinks >> k) & 1) === 0) continue;
            const dc = STEP_COLUMN[k];
            const dr = STEP_ROW[k];
            const nextColumn = column + dc;
            const nextRow = row + dr;
            const next = cell + dr * columns + dc;
            if (closed[next] === generation) continue;
            const run = k >= 4 ? diagonal : cellSize;
            const rise = heights[next] - cellHeight;
            const nextCost = cellCost + (rise === 0 ? run : Math.sqrt(run * run + rise * rise));
            if (opened[next] !== generation || nextCost < cost[next]) {
                opened[next] = generation;
                cost[next] = nextCost;
                parent[next] = cell;
                push(next, nextCost + heuristic(nextColumn, nextRow));
            }
        }
    }
    return null;
};

/** Greedy string pulling: from each anchor, skip ahead while the grid has line of sight. */
const smoothPath = (grid: NavGrid, points: THREE.Vector3[]): THREE.Vector3[] => {
    if (points.length <= 2) return points;
    const result = [points[0]];
    let anchor = 0;
    while (anchor < points.length - 1) {
        let next = anchor + 1;
        while (next + 1 < points.length && hasLineOfSight(grid, points[anchor], points[next + 1])) next++;
        result.push(points[next]);
        anchor = next;
    }
    return result;
};

/**
 * Plan a path and report whether it reaches the target. With `partial`, an
 * unreachable target yields a path to the closest reachable point; null only
 * when no walkable cell is near the start.
 */
export function planPath(grid: NavGrid, from: NavPoint, to: NavPoint, options: FindPathOptions = {}): NavPathResult | null {
    const snap = finite(options.maxSnapDistance, Math.max(1, grid.agentRadius + grid.cellSize * 1.5));
    const start = nearestWalkableCell(grid, from, snap);
    if (start < 0) return null;
    const region = grid.regions[start];
    let goal = nearestWalkableCell(grid, to, snap, region);
    const reachable = goal >= 0 && grid.regions[goal] === region;
    if (!reachable) {
        if (!options.partial) return null;
        goal = closestCellInRegion(grid, region, to.x, to.z);
        if (goal < 0) return null;
    }
    const cells = searchCells(grid, start, goal, finite(options.maxIterations, grid.columns * grid.rows));
    if (!cells) return null;

    const startPoint = new THREE.Vector3(from.x, from.y ?? grid.heights[start], from.z);
    const points: THREE.Vector3[] = [startPoint];
    // A start snapped off a blocked cell walks to the cell centre first.
    if (cellIndexAt(grid, from.x, from.z) !== start) points.push(cellCenter(grid, start));
    for (let i = 1; i < cells.length - 1; i++) points.push(cellCenter(grid, cells[i]));
    const endsOnTarget = reachable && cellIndexAt(grid, to.x, to.z) === goal;
    const endPoint = endsOnTarget ? new THREE.Vector3(to.x, to.y ?? grid.heights[goal], to.z) : cellCenter(grid, goal);
    if (!endPoint.equals(points[points.length - 1])) points.push(endPoint);

    if (options.smooth === false) return { points, reachable };
    // Never smooth across the snapped start: the actual start may sit inside an inflated obstacle.
    const snappedStart = points.length > 2 && cellIndexAt(grid, from.x, from.z) !== start;
    const smoothed = snappedStart ? [points[0], ...smoothPath(grid, points.slice(1))] : smoothPath(grid, points);
    return { points: smoothed, reachable };
}

/**
 * Waypoints from `from` to `to` (first point is the start), or null when the
 * target is unreachable. Pass { partial: true } to stop at the closest
 * reachable point instead.
 */
export function findPath(grid: NavGrid, from: NavPoint, to: NavPoint, options: FindPathOptions = {}): THREE.Vector3[] | null {
    return planPath(grid, from, to, options)?.points ?? null;
}

/** Index of the waypoint an agent at `position` should steer toward, skipping those within reachRadius (XZ). */
export function advanceWaypoint(path: readonly NavPoint[], index: number, position: NavPoint, reachRadius: number): number {
    if (path.length === 0) return 0;
    let current = Math.min(Math.max(1, index), path.length - 1);
    const reach = reachRadius * reachRadius;
    while (current < path.length - 1) {
        const dx = path[current].x - position.x;
        const dz = path[current].z - position.z;
        if (dx * dx + dz * dz > reach) break;
        current++;
    }
    return current;
}

// ---------------------------------------------------------------------------
// React wiring
// ---------------------------------------------------------------------------

/** The level's nav grid for AI under it (useAILocomotion reads it); null keeps straight-line steering. */
export const NavGridContext = createContext<NavGrid | null>(null);

export const useNavGridContext = (): NavGrid | null => useContext(NavGridContext);

const heightsTokens = new WeakMap<object, number>();
let nextHeightsToken = 1;

const heightsToken = (heights: readonly number[] | undefined): number => {
    if (!heights) return 0;
    let token = heightsTokens.get(heights);
    if (token === undefined) {
        token = nextHeightsToken++;
        heightsTokens.set(heights, token);
    }
    return token;
};

/**
 * A key that changes only when something the nav grid bakes changes: terrains, static objects that
 * can block (see collectObstacles), and the ancestors their world transforms come from. Objects
 * that are never baked (lights, spawn points, movers and other dynamic objects) do not affect it.
 */
export function navGridSignature(levelObjects: readonly LevelObject[]): string {
    const index = new Map<string, LevelObject>();
    for (const object of levelObjects) index.set(object.id, object);
    const baked = new Set<string>();
    for (const object of levelObjects) {
        if (object.type !== 'terrain' && (!mayBlock(object) || isDynamicObject(object, index))) continue;
        let current: LevelObject | undefined = object;
        while (current && !baked.has(current.id)) {
            baked.add(current.id);
            const parentId: string | null | undefined = current.parentId;
            current = parentId ? index.get(parentId) : undefined;
        }
    }
    const parts: string[] = [];
    for (const object of levelObjects) {
        if (!baked.has(object.id)) continue;
        const terrain = object.terrainData;
        parts.push([
            object.id,
            object.type,
            object.modelId,
            object.parentId ?? '',
            object.position.join(','),
            object.rotation.join(','),
            object.scale.join(','),
            object.components?.length ? JSON.stringify(object.components) : '',
            terrain ? `${terrain.resolution}:${terrain.width}:${terrain.depth}:${heightsToken(terrain.heights)}` : '',
        ].join('|'));
    }
    return parts.join(';');
}

/** Shortest time between re-bakes while baked objects keep changing (a script moving a platform every frame, bursts of spawns). */
export const NAV_REBAKE_INTERVAL_MS = 500;

interface BakedNavGrid {
    key: string | null;
    propRadius: NavGridOptions['propRadius'];
    shapeBounds: NavGridOptions['shapeBounds'];
    grid: NavGrid | null;
    bakedAt: number;
}

/**
 * Bake the nav grid for these level objects, and re-bake it when something it bakes changes. The
 * first grid is baked during render; later re-bakes run outside render, at most once every
 * NAV_REBAKE_INTERVAL_MS, and until then agents keep the previous grid (and their paths).
 */
export function useNavGrid(levelObjects: readonly LevelObject[] | null | undefined, options?: NavGridOptions): NavGrid | null {
    // levelObjects/options are keyed by signature and options key, so identity churn alone does not re-bake.
    const key = levelObjects ? `${navGridSignature(levelObjects)}#${options ? JSON.stringify(options) : ''}` : null;
    const propRadius = options?.propRadius;
    const shapeBounds = options?.shapeBounds;
    const latest = useRef({ levelObjects, options });
    useEffect(() => {
        latest.current = { levelObjects, options };
    });
    const [baked, setBaked] = useState<BakedNavGrid>(() => ({
        key,
        propRadius,
        shapeBounds,
        grid: levelObjects ? buildNavGrid(levelObjects, options) : null,
        // The first change after mount (the level finishing loading, say) re-bakes right away.
        bakedAt: -Infinity,
    }));
    const stale = baked.key !== key || baked.propRadius !== propRadius || baked.shapeBounds !== shapeBounds;
    useEffect(() => {
        if (!stale) return undefined;
        const timer = setTimeout(() => {
            const current = latest.current;
            setBaked({
                key,
                propRadius,
                shapeBounds,
                grid: current.levelObjects ? buildNavGrid(current.levelObjects, current.options) : null,
                bakedAt: Date.now(),
            });
        }, Math.max(0, baked.bakedAt + NAV_REBAKE_INTERVAL_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [stale, key, propRadius, shapeBounds, baked.bakedAt]);
    return key === null ? null : baked.grid;
}
