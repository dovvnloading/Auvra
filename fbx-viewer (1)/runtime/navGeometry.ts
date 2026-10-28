import * as THREE from 'three';
import { ConvexGeometry } from 'three-stdlib';
import type { LevelComponent, LevelObject } from '../types';
import { planHull, type HostGeometry } from './components/physicsComponents';
import { resolveNavSettings, type NavSettings } from './navSettings';
import { isDynamicObject } from './levelObjectMotion';
import { flatGroundHeight, terrainHeightfieldShape, terrainSurfaceHeight } from './terrainPhysics';

/**
 * WHAT THE NAVMESH IS BAKED FROM
 *
 * A level becomes one triangle soup for Recast (runtime/navMesh.ts), built from the shapes physics
 * builds, so agents walk where the player can:
 * - the ground: each terrain's heightfield, and the flat ground (flatGroundHeight) around them;
 * - solid colliders: boxes, spheres and capsules as they are shaped, mesh colliders from the
 *   model's own triangles, and a fixed rigid body without colliders as the convex hull physics
 *   wraps it in;
 * - props with a model and no collider: the model's own triangles (a tree's trunk blocks, its
 *   branches are walked under), or, until the model is loaded, the player's collision circle.
 *
 * Objects that move (mover or rotator components, a non-fixed rigid body, or a child of one) are
 * left out; a Nav Obstacle component carves them out as they move instead. Triggers, pickups and
 * objects with nothing solid (lights, spawn points) are left out too. Nav Link components become
 * off-mesh links: a drop, a gap or a ladder agents may cross.
 */

/** An off-mesh link, in world space. */
export interface NavLinkSpec {
    start: [number, number, number];
    end: [number, number, number];
    /** How close to either end an agent must be to take it (m). */
    radius: number;
    /** False: only from start to end (a drop). */
    bidirectional: boolean;
}

export interface NavGeometry {
    /** xyz triples in world space. */
    positions: Float32Array;
    /** Triangle indices, wound counter-clockwise seen from the side a surface faces. */
    indices: Uint32Array;
    links: NavLinkSpec[];
    /** The ground (terrain or flat ground) under a point: where a surface well above it is a raised top. */
    groundHeight: (x: number, z: number) => number;
}

export interface NavGeometryOptions {
    settings?: Partial<NavSettings>;
    /**
     * The triangles of the object's model in object-local space (import normalisation included),
     * for mesh colliders and the hull of a rigid body without colliders; null when unknown, which
     * falls back to the prop circle.
     */
    shapeGeometry?: (object: LevelObject) => HostGeometry | null;
    /** Circle radius of a prop without a collider; null leaves it out. Defaults to the player's max(scale.x, scale.z) / 2. */
    propRadius?: (object: LevelObject, worldScale: THREE.Vector3) => number | null;
}

// The flat ground covers at least the arena enemies have always had, plus the level around it.
const MIN_HALF_EXTENT = 50;
const PADDING = 10;
// Never more than the physics flat ground (FLAT_GROUND_EXTENT / 2).
const MAX_HALF_EXTENT = 2000;
// The flat ground is laid in runs of square cells, at most this many to a side.
const FLAT_GROUND_CELLS = 256;
// Smallest collider dimension physics builds (physicsComponents MIN_EXTENT).
const MIN_COLLIDER_EXTENT = 0.01;

export const NAV_LINK_COMPONENT_TYPE = 'navLink';
export const NAV_OBSTACLE_COMPONENT_TYPE = 'navObstacle';

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

/**
 * True when the object has something solid to bake (ignoring whether it moves): a non-trigger
 * collider, a rigid body with no colliders (physics gives it an automatic hull), or the player's
 * legacy circle, which only props with a model have (usePlayerPhysics isLegacySolidProp).
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

// ---------------------------------------------------------------------------
// Triangle soup
// ---------------------------------------------------------------------------

/** The convex hull of points in the plane, corners in order (Andrew's monotone chain). */
const convexHull2d = (points: [number, number][]): [number, number][] => {
    if (points.length < 3) return [];
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: [number, number][] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-12) lower.pop();
        lower.push(point);
    }
    const upper: [number, number][] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const point = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-12) upper.pop();
        upper.push(point);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
};

class TriangleSoup {
    readonly positions: number[] = [];
    readonly indices: number[] = [];
    private readonly vertex = new THREE.Vector3();

    /** sliceStep: how far apart addSolid slices solids (closer than an agent is tall); 0 does not slice. */
    constructor(private readonly sliceStep = 0) {}

    /** Adds triangles given in some space, taking them to world space by `matrix`. */
    add(positions: ArrayLike<number>, indices: ArrayLike<number> | null, matrix: THREE.Matrix4 | null): void {
        const base = this.positions.length / 3;
        for (let i = 0; i + 2 < positions.length; i += 3) {
            this.vertex.set(positions[i], positions[i + 1], positions[i + 2]);
            if (matrix) this.vertex.applyMatrix4(matrix);
            this.positions.push(this.vertex.x, this.vertex.y, this.vertex.z);
        }
        const count = indices ? indices.length : positions.length / 3;
        // A mirroring transform turns faces inside out; swapping two corners turns them back.
        const mirrored = matrix ? matrix.determinant() < 0 : false;
        for (let i = 0; i + 2 < count; i += 3) {
            const a = indices ? indices[i] : i;
            const b = indices ? indices[i + 1] : i + 1;
            const c = indices ? indices[i + 2] : i + 2;
            if (mirrored) this.indices.push(base + a, base + c, base + b);
            else this.indices.push(base + a, base + b, base + c);
        }
    }

    addGeometry(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null): void {
        const position = geometry.getAttribute('position');
        this.add(position.array as ArrayLike<number>, geometry.index ? (geometry.index.array as ArrayLike<number>) : null, matrix);
        geometry.dispose();
    }

    /**
     * Adds a convex solid: its surface, and level slices through it sliceStep apart. Recast bakes
     * surfaces, not volumes, so without the slices the ground inside a big solid would have the
     * headroom to be walkable (an island no agent can reach); with them, nothing inside it does. Its
     * top keeps the headroom above it, so it stays walkable.
     */
    addSolid(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null): void {
        const sliceStep = this.sliceStep;
        const firstVertex = this.positions.length / 3;
        const firstIndex = this.indices.length;
        this.addGeometry(geometry, matrix);
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = firstVertex * 3 + 1; i < this.positions.length; i += 3) {
            minY = Math.min(minY, this.positions[i]);
            maxY = Math.max(maxY, this.positions[i]);
        }
        if (!(sliceStep > 0)) return;
        const p = this.positions;
        for (let y = minY + sliceStep / 2; y < maxY - sliceStep / 4; y += sliceStep) {
            const crossings: [number, number][] = [];
            for (let i = firstIndex; i + 2 < this.indices.length; i += 3) {
                for (const [a, b] of [[this.indices[i], this.indices[i + 1]], [this.indices[i + 1], this.indices[i + 2]], [this.indices[i + 2], this.indices[i]]]) {
                    const ya = p[a * 3 + 1];
                    const yb = p[b * 3 + 1];
                    if ((ya - y) * (yb - y) >= 0) continue;
                    const t = (y - ya) / (yb - ya);
                    crossings.push([p[a * 3] + t * (p[b * 3] - p[a * 3]), p[a * 3 + 2] + t * (p[b * 3 + 2] - p[a * 3 + 2])]);
                }
            }
            this.addLevelPolygon(convexHull2d(crossings), y);
        }
    }

    /** A convex polygon (x, z corners in order) at height y, facing up. */
    private addLevelPolygon(corners: [number, number][], y: number): void {
        if (corners.length < 3) return;
        const [x0, z0] = corners[0];
        const [x1, z1] = corners[1];
        const [x2, z2] = corners[2];
        // Upward when (b - a) x (c - a) has a positive y, as Recast takes a triangle's normal.
        const upward = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0) > 0;
        const ordered = upward ? corners : [...corners].reverse();
        const base = this.positions.length / 3;
        for (const [x, z] of ordered) this.positions.push(x, y, z);
        for (let i = 1; i + 1 < ordered.length; i++) this.indices.push(base, base + i, base + i + 1);
    }

    /** An upward-facing quad over [x0, x1] x [z0, z1] at height y. */
    addFlatQuad(x0: number, z0: number, x1: number, z1: number, y: number): void {
        const base = this.positions.length / 3;
        this.positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
        this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    bounds(): THREE.Box3 {
        const box = new THREE.Box3();
        const point = new THREE.Vector3();
        for (let i = 0; i < this.positions.length; i += 3) box.expandByPoint(point.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]));
        return box;
    }
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

interface TerrainFootprint {
    /** Terrain space without scale (its extent carries the scale), as its physics body has it. */
    inverse: THREE.Matrix4;
    halfX: number;
    halfZ: number;
}

/** A terrain's heightfield as triangles (the TerrainCollider's shape), and its footprint. */
const addTerrain = (soup: TriangleSoup, terrain: LevelObject, matrix: THREE.Matrix4): TerrainFootprint | null => {
    const shape = terrainHeightfieldShape(terrain);
    if (!shape) return null;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    matrix.decompose(position, quaternion, new THREE.Vector3());
    const body = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
    const { rows, columns, heights, scale } = shape;
    const samplesX = columns + 1;
    const samplesZ = rows + 1;
    const local = new Float32Array(samplesX * samplesZ * 3);
    // Rows run along Z and columns along X, from -half to +half; heights are column-major.
    for (let row = 0; row < samplesZ; row++) {
        for (let column = 0; column < samplesX; column++) {
            const at = (row * samplesX + column) * 3;
            local[at] = -scale.x / 2 + (column / columns) * scale.x;
            local[at + 1] = heights[row + column * samplesZ] * scale.y;
            local[at + 2] = -scale.z / 2 + (row / rows) * scale.z;
        }
    }
    const indices = new Uint32Array(rows * columns * 6);
    let index = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const a = row * samplesX + column;
            const below = a + samplesX;
            indices.set([a, below, a + 1, a + 1, below, below + 1], index);
            index += 6;
        }
    }
    soup.add(local, indices, body);
    return { inverse: body.clone().invert(), halfX: scale.x / 2, halfZ: scale.z / 2 };
};

const onFootprint = (footprints: readonly TerrainFootprint[], x: number, z: number, point: THREE.Vector3): boolean =>
    footprints.some(({ inverse, halfX, halfZ }) => {
        point.set(x, 0, z).applyMatrix4(inverse);
        return Math.abs(point.x) <= halfX && Math.abs(point.z) <= halfZ;
    });

/** The flat ground over `area`, in runs of cells, leaving out the cells a terrain covers. */
const addFlatGround = (soup: TriangleSoup, area: THREE.Box2, height: number, footprints: readonly TerrainFootprint[]): void => {
    const width = area.max.x - area.min.x;
    const depth = area.max.y - area.min.y;
    const cell = Math.max(1, Math.max(width, depth) / FLAT_GROUND_CELLS);
    const columns = Math.ceil(width / cell);
    const rows = Math.ceil(depth / cell);
    const point = new THREE.Vector3();
    // A cell is left out only when a terrain covers all four corners, so no gap opens at a terrain's edge.
    const covered = (column: number, row: number) => {
        if (footprints.length === 0) return false;
        const x0 = area.min.x + column * cell;
        const z0 = area.min.y + row * cell;
        return onFootprint(footprints, x0, z0, point) && onFootprint(footprints, x0 + cell, z0, point)
            && onFootprint(footprints, x0, z0 + cell, point) && onFootprint(footprints, x0 + cell, z0 + cell, point);
    };
    for (let row = 0; row < rows; row++) {
        const z0 = area.min.y + row * cell;
        const z1 = Math.min(area.max.y, z0 + cell);
        let start = -1;
        for (let column = 0; column <= columns; column++) {
            const open = column < columns && !covered(column, row);
            if (open && start < 0) start = column;
            if (!open && start >= 0) {
                soup.addFlatQuad(area.min.x + start * cell, z0, Math.min(area.max.x, area.min.x + column * cell), z1, height);
                start = -1;
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Solid shapes
// ---------------------------------------------------------------------------

const defaultPropRadius = (_object: LevelObject, worldScale: THREE.Vector3): number =>
    Math.max(Math.abs(worldScale.x), Math.abs(worldScale.z)) * 0.5;

/** A capsule between world points a and b. */
const capsuleGeometry = (a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.BufferGeometry => {
    const axis = new THREE.Vector3().subVectors(b, a);
    const length = axis.length();
    const geometry = new THREE.CapsuleGeometry(radius, length, 4, 12);
    if (length > 1e-9) geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
    return geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
};

/** One collider component's shape in world space, or null for a shape that needs the model it has not got. */
const addCollider = (soup: TriangleSoup, component: LevelComponent, object: LevelObject, matrix: THREE.Matrix4, shapeGeometry: NavGeometryOptions['shapeGeometry']): boolean => {
    const props = component.props ?? {};
    const shape = typeof props.shape === 'string' ? props.shape : 'box';
    const offset = vectorProp(props.offset, [0, 0, 0]);
    if (shape === 'box') {
        const size = vectorProp(props.size, [1, 1, 1]);
        const extent = (value: number) => Math.max(MIN_COLLIDER_EXTENT, Math.abs(value));
        soup.addSolid(new THREE.BoxGeometry(extent(size.x), extent(size.y), extent(size.z)).translate(offset.x, offset.y, offset.z), matrix);
        return true;
    }
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    const largest = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    if (shape === 'sphere') {
        const center = offset.clone().applyMatrix4(matrix);
        const radius = Math.max(MIN_COLLIDER_EXTENT, Math.abs(finite(props.radius, 0.5))) * largest;
        soup.addSolid(new THREE.SphereGeometry(radius, 16, 10).translate(center.x, center.y, center.z), null);
        return true;
    }
    if (shape === 'capsule') {
        // Like physics (capsuleHalfHeight): height is the full length, caps included, along the object's local Y.
        const radius = Math.max(MIN_COLLIDER_EXTENT, finite(props.radius, 0.5));
        const height = Math.max(MIN_COLLIDER_EXTENT, finite(props.height, 2));
        const halfSegment = Math.max(0, height / 2 - radius);
        const a = new THREE.Vector3(offset.x, offset.y + halfSegment, offset.z).applyMatrix4(matrix);
        const b = new THREE.Vector3(offset.x, offset.y - halfSegment, offset.z).applyMatrix4(matrix);
        soup.addSolid(capsuleGeometry(a, b, radius * largest), null);
        return true;
    }
    if (shape === 'mesh') {
        // A triangle mesh may be hollow (a building with rooms), so it is baked as its surface alone.
        const content = shapeGeometry?.(object);
        if (!content) return false;
        const withOffset = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z).premultiply(matrix);
        soup.add(content.positions, content.indices, withOffset);
        return true;
    }
    return false;
};

/** The convex hull physics wraps a fixed rigid body without colliders in, or null without the model. */
const addHull = (soup: TriangleSoup, object: LevelObject, matrix: THREE.Matrix4, shapeGeometry: NavGeometryOptions['shapeGeometry']): boolean => {
    const content = shapeGeometry?.(object);
    if (!content) return false;
    const hull = planHull(content.positions);
    if (hull.kind === 'box') {
        const [hx, hy, hz] = hull.halfExtents;
        soup.addSolid(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2).translate(...hull.center), matrix);
        return true;
    }
    const points: THREE.Vector3[] = [];
    for (let i = 0; i + 2 < hull.points.length; i += 3) points.push(new THREE.Vector3(hull.points[i], hull.points[i + 1], hull.points[i + 2]));
    try {
        soup.addSolid(new ConvexGeometry(points), matrix);
        return true;
    } catch {
        return false;
    }
};

/**
 * The player's collision circle for a prop without collider data, which blocks at every height, as a
 * solid cylinder from just under the prop to an agent's height over it.
 */
const addPropCircle = (soup: TriangleSoup, center: THREE.Vector3, radius: number, settings: NavSettings): void => {
    const bottom = center.y - 0.5;
    const height = settings.agentHeight + 1;
    soup.addSolid(new THREE.CylinderGeometry(radius, radius, height, 16).translate(center.x, bottom + height / 2, center.z), null);
};

const addLinks = (links: NavLinkSpec[], object: LevelObject, matrix: THREE.Matrix4): void => {
    for (const component of enabledComponents(object)) {
        if (component.type !== NAV_LINK_COMPONENT_TYPE) continue;
        const start = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
        const end = vectorProp(component.props?.end, [0, 0, 2]).applyMatrix4(matrix);
        links.push({
            start: [start.x, start.y, start.z],
            end: [end.x, end.y, end.z],
            radius: Math.max(0.1, finite(component.props?.radius, 0.6)),
            bidirectional: component.props?.bidirectional !== false,
        });
    }
};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** The triangles and links to bake a level's navmesh from. Pass objects with their hierarchy (parentId) intact. */
export function collectNavGeometry(levelObjects: readonly LevelObject[], options: NavGeometryOptions = {}): NavGeometry {
    const settings = resolveNavSettings(options.settings);
    const propRadius = options.propRadius ?? defaultPropRadius;
    const index = new Map<string, LevelObject>();
    for (const object of levelObjects) index.set(object.id, object);
    const worldMatrix = createWorldMatrixResolver(index);

    const ground = new TriangleSoup();
    // Slices well under an agent's height apart leave no headroom inside a solid.
    const solids = new TriangleSoup(settings.agentHeight * 0.45);
    const links: NavLinkSpec[] = [];
    const terrains: LevelObject[] = [];
    const footprints: TerrainFootprint[] = [];
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (const object of levelObjects) {
        const matrix = worldMatrix(object.id);
        if (object.type === 'terrain') {
            terrains.push(object);
            const footprint = addTerrain(ground, object, matrix);
            if (footprint) footprints.push(footprint);
            continue;
        }
        addLinks(links, object, matrix);
        if (!mayBlock(object) || isDynamicObject(object, index)) continue;
        const components = enabledComponents(object);
        const colliders = components.filter(component => component.type === 'collider' && component.props?.isTrigger !== true);
        let needsCircle = colliders.length === 0;
        // A fixed rigid body without colliders: physics wraps the object's meshes in a hull.
        if (needsCircle && components.some(component => component.type === 'rigidBody') && addHull(solids, object, matrix, options.shapeGeometry)) continue;
        for (const collider of colliders) {
            if (!addCollider(solids, collider, object, matrix, options.shapeGeometry)) needsCircle = true;
        }
        // Without a model there is nothing solid to fall back on (lights and other empty props).
        if (!needsCircle || !object.modelId) continue;
        // A prop without colliders is baked as its model is shaped, where the model is loaded: agents
        // go round a tree's trunk and under its branches, and over clutter lower than a step.
        const model = colliders.length === 0 ? options.shapeGeometry?.(object) : null;
        if (model) {
            solids.add(model.positions, model.indices, matrix);
            continue;
        }
        matrix.decompose(position, quaternion, scale);
        const radius = propRadius(object, scale);
        if (radius !== null && radius > 0) addPropCircle(solids, position.clone(), radius, settings);
    }

    // The flat ground under everything that is baked, and at least the arena around the origin.
    const area = new THREE.Box2(new THREE.Vector2(-MIN_HALF_EXTENT, -MIN_HALF_EXTENT), new THREE.Vector2(MIN_HALF_EXTENT, MIN_HALF_EXTENT));
    for (const soup of [ground, solids]) {
        const box = soup.bounds();
        if (box.isEmpty()) continue;
        area.expandByPoint(new THREE.Vector2(box.min.x, box.min.z)).expandByPoint(new THREE.Vector2(box.max.x, box.max.z));
    }
    for (const link of links) {
        area.expandByPoint(new THREE.Vector2(link.start[0], link.start[2])).expandByPoint(new THREE.Vector2(link.end[0], link.end[2]));
    }
    area.expandByScalar(PADDING);
    area.intersect(new THREE.Box2(new THREE.Vector2(-MAX_HALF_EXTENT, -MAX_HALF_EXTENT), new THREE.Vector2(MAX_HALF_EXTENT, MAX_HALF_EXTENT)));
    const flatHeight = flatGroundHeight(terrains);
    addFlatGround(ground, area, flatHeight, footprints);

    const groundCount = ground.positions.length / 3;
    const positions = new Float32Array(ground.positions.length + solids.positions.length);
    positions.set(ground.positions);
    positions.set(solids.positions, ground.positions.length);
    const indices = new Uint32Array(ground.indices.length + solids.indices.length);
    indices.set(ground.indices);
    for (let i = 0; i < solids.indices.length; i++) indices[ground.indices.length + i] = solids.indices[i] + groundCount;

    const groundHeight = (x: number, z: number): number => {
        let best: number | null = null;
        for (const terrain of terrains) {
            const height = terrainSurfaceHeight(x, z, terrain);
            if (height !== null && (best === null || height > best)) best = height;
        }
        return best ?? flatHeight;
    };
    return { positions, indices, links, groundHeight };
}

/**
 * Every mesh of a loaded model merged into one triangle soup, as the model is placed under a level
 * object (its root's own transform, the import normalisation, included), or null when it draws none.
 */
export const modelTriangles = (model: THREE.Object3D): HostGeometry | null => {
    model.updateWorldMatrix(true, true);
    const toModel = model.parent ? new THREE.Matrix4().copy(model.parent.matrixWorld).invert() : new THREE.Matrix4();
    const soup = new TriangleSoup();
    const relative = new THREE.Matrix4();
    model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
        relative.multiplyMatrices(toModel, mesh.matrixWorld);
        const position = mesh.geometry.getAttribute('position');
        const values = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
            values[i * 3] = position.getX(i);
            values[i * 3 + 1] = position.getY(i);
            values[i * 3 + 2] = position.getZ(i);
        }
        soup.add(values, mesh.geometry.index ? (mesh.geometry.index.array as ArrayLike<number>) : null, relative);
    });
    if (soup.positions.length === 0) return null;
    return { positions: new Float32Array(soup.positions), indices: new Uint32Array(soup.indices) };
};

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
 * A key that changes only when something the navmesh bakes changes: terrains, static objects that
 * can block, nav links, and the ancestors their world transforms come from. Objects that are never
 * baked (lights, spawn points, movers and other dynamic objects) do not affect it.
 */
export function navGeometrySignature(levelObjects: readonly LevelObject[]): string {
    const index = new Map<string, LevelObject>();
    for (const object of levelObjects) index.set(object.id, object);
    const baked = new Set<string>();
    for (const object of levelObjects) {
        const linked = enabledComponents(object).some(component => component.type === NAV_LINK_COMPONENT_TYPE);
        if (object.type !== 'terrain' && !linked && (!mayBlock(object) || isDynamicObject(object, index))) continue;
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
