import * as THREE from 'three';
import type { LevelObject, LevelObjectType } from '../types';
import { getWorldMatrix } from './sceneGraph';

/**
 * Surface placement for editor tools (foliage brush, drag-and-drop placement).
 *
 * A placement ray hits, nearest first, either a terrain heightfield or a
 * visible level mesh; when it hits neither it falls back to the y = 0 ground
 * plane. Terrain is intersected analytically against the same triangles
 * PlaneGeometry renders, so a sculpted 512x512 terrain costs a short march
 * instead of a brute-force raycast over half a million triangles.
 *
 * Editor furniture is never a surface: invisible objects, shader-driven
 * helpers (the infinite grid, the sky dome, socket gizmos), TransformControls,
 * lines/points/sprites, anything tagged `userData.ignorePlacement`, objects
 * whose raycast is disabled, and level objects that are markers rather than
 * geometry (spawn points, audio emitters, the sky sphere, the player start).
 */
export interface PlacementHit {
    point: THREE.Vector3;
    normal: THREE.Vector3;
}

export interface PlacementOptions {
    /** Objects (with their descendants) the ray must pass through, e.g. a brush cursor or placement ghost. */
    ignore?: THREE.Object3D[];
}

/** A prepared query that can be cast many times against one collected scene. */
export type PlacementQuery = (raycaster: THREE.Raycaster) => PlacementHit | null;

const NON_SURFACE_TYPES: ReadonlySet<LevelObjectType> = new Set<LevelObjectType>([
    'spawn_point',
    'audio_emitter',
    'sky_sphere',
    'player_start',
]);

// TerrainObject's defaults when a terrain object carries no terrainData.
const DEFAULT_TERRAIN = { resolution: 64, width: 100, depth: 100 };
const MAX_MARCH_STEPS = 8192;
const BISECTION_STEPS = 24;
const UP = new THREE.Vector3(0, 1, 0);
const GROUND_PLANE = new THREE.Plane(UP, 0);
// TerrainObject renders its PlaneGeometry rotated -90 degrees about X inside the object's group.
const TERRAIN_PLANE_ROTATION = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/**
 * A terrain heightfield in the local space of its plane mesh: x across the
 * width, y across the depth (row 0 at +depth/2), z the sculpted height.
 */
interface TerrainSurface {
    object: THREE.Object3D | null;
    matrix: THREE.Matrix4;
    inverse: THREE.Matrix4;
    normalMatrix: THREE.Matrix3;
    width: number;
    depth: number;
    columns: number;
    rows: number;
    height: (index: number) => number;
    minHeight: number;
    maxHeight: number;
}

interface SurfaceSample {
    height: number;
    dhdx: number;
    dhdy: number;
}

interface RayHit {
    distance: number;
    point: THREE.Vector3;
    normal: THREE.Vector3;
}

const heightRangeCache = new WeakMap<object, { version: number; min: number; max: number }>();

const heightRange = (key: object, version: number, count: number, height: (index: number) => number): { min: number; max: number } => {
    const cached = heightRangeCache.get(key);
    if (cached && cached.version === version) return cached;
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < count; index++) {
        const value = height(index);
        if (value < min) min = value;
        if (value > max) max = value;
    }
    const range = count > 0 ? { version, min, max } : { version, min: 0, max: 0 };
    heightRangeCache.set(key, range);
    return range;
};

const finiteOrZero = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const createSurface = (
    object: THREE.Object3D | null,
    matrix: THREE.Matrix4,
    width: number,
    depth: number,
    columns: number,
    rows: number,
    height: (index: number) => number,
    range: { min: number; max: number },
): TerrainSurface | null => {
    if (!(width > 0) || !(depth > 0) || columns < 1 || rows < 1) return null;
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    return {
        object,
        matrix,
        inverse: matrix.clone().invert(),
        normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
        width,
        depth,
        columns,
        rows,
        height,
        minHeight: range.min,
        maxHeight: range.max,
    };
};

/** A rendered terrain mesh: the displaced PlaneGeometry is the source of truth (it includes an in-progress sculpt). */
const surfaceFromMesh = (mesh: THREE.Mesh): TerrainSurface | null => {
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    if (geometry?.type !== 'PlaneGeometry') return null;
    const parameters = geometry.parameters;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!parameters || !position) return null;
    const columns = Math.floor(parameters.widthSegments);
    const rows = Math.floor(parameters.heightSegments);
    if (position.count !== (columns + 1) * (rows + 1)) return null;
    const height = (index: number) => finiteOrZero(position.getZ(index));
    const range = heightRange(position, position.version, position.count, height);
    return createSurface(mesh, mesh.matrixWorld, parameters.width, parameters.height, columns, rows, height, range);
};

/** A terrain level object that is not rendered in this scene, sampled from its resolved heights. */
const surfaceFromLevelObject = (terrain: LevelObject, levelObjects: readonly LevelObject[]): TerrainSurface | null => {
    const { resolution, width, depth } = terrain.terrainData ?? DEFAULT_TERRAIN;
    const columns = Math.floor(resolution);
    const count = (columns + 1) * (columns + 1);
    const heights = terrain.terrainData?.heights;
    // Like TerrainObject, heights that do not describe the grid leave the terrain flat.
    const usable = heights && heights.length === count ? heights : null;
    const height = usable ? (index: number) => finiteOrZero(usable[index]) : () => 0;
    const range = usable ? heightRange(usable, 0, count, height) : { min: 0, max: 0 };
    const matrix = getWorldMatrix(levelObjects, terrain.id).multiply(TERRAIN_PLANE_ROTATION);
    return createSurface(null, matrix, width, depth, columns, columns, height, range);
};

/** Height and slope of the rendered triangle under plane-local (x, y). */
const sampleSurface = (surface: TerrainSurface, x: number, y: number, target: SurfaceSample): SurfaceSample => {
    const { width, depth, columns, rows } = surface;
    const gx = THREE.MathUtils.clamp(((x + width / 2) / width) * columns, 0, columns);
    const gy = THREE.MathUtils.clamp(((depth / 2 - y) / depth) * rows, 0, rows);
    const c0 = Math.min(Math.floor(gx), columns - 1);
    const r0 = Math.min(Math.floor(gy), rows - 1);
    const tx = gx - c0;
    const ty = gy - r0;
    const stride = columns + 1;
    const index = r0 * stride + c0;
    const h00 = surface.height(index);
    const h10 = surface.height(index + 1);
    const h01 = surface.height(index + stride);
    const h11 = surface.height(index + stride + 1);
    // PlaneGeometry splits each cell along the (c0, r0 + 1)-(c0 + 1, r0) diagonal.
    let dhdgx: number;
    let dhdgy: number;
    if (tx + ty <= 1) {
        dhdgx = h10 - h00;
        dhdgy = h01 - h00;
        target.height = h00 + tx * dhdgx + ty * dhdgy;
    } else {
        dhdgx = h11 - h01;
        dhdgy = h11 - h10;
        target.height = h11 - (1 - tx) * dhdgx - (1 - ty) * dhdgy;
    }
    target.dhdx = dhdgx * (columns / width);
    target.dhdy = -dhdgy * (rows / depth);
    return target;
};

const clipSlab = (origin: number, direction: number, low: number, high: number, range: [number, number]): boolean => {
    if (Math.abs(direction) < 1e-12) return origin >= low && origin <= high;
    const t1 = (low - origin) / direction;
    const t2 = (high - origin) / direction;
    range[0] = Math.max(range[0], Math.min(t1, t2));
    range[1] = Math.min(range[1], Math.max(t1, t2));
    return range[0] <= range[1];
};

const intersectSurface = (surface: TerrainSurface, raycaster: THREE.Raycaster): RayHit | null => {
    if (surface.object && !surface.object.layers.test(raycaster.layers)) return null;
    const worldRay = raycaster.ray;
    const origin = worldRay.origin.clone().applyMatrix4(surface.inverse);
    const direction = worldRay.direction.clone().transformDirection(surface.inverse);
    // World distance travelled per unit of local ray parameter.
    const scale = origin.clone().add(direction).applyMatrix4(surface.matrix).distanceTo(worldRay.origin);
    if (!(scale > 0)) return null;

    // Small pads keep rays along the exact terrain edge (and float noise from the plane rotation) inside.
    const pad = 1e-3 * Math.max(1, surface.maxHeight - surface.minHeight);
    const halfWidth = (surface.width / 2) * (1 + 1e-9);
    const halfDepth = (surface.depth / 2) * (1 + 1e-9);
    const range: [number, number] = [raycaster.near / scale, raycaster.far / scale];
    if (!clipSlab(origin.x, direction.x, -halfWidth, halfWidth, range)) return null;
    if (!clipSlab(origin.y, direction.y, -halfDepth, halfDepth, range)) return null;
    if (!clipSlab(origin.z, direction.z, surface.minHeight - pad, surface.maxHeight + pad, range)) return null;
    const [start, end] = range;

    const sample: SurfaceSample = { height: 0, dhdx: 0, dhdy: 0 };
    const gap = (t: number) => origin.z + t * direction.z - sampleSurface(surface, origin.x + t * direction.x, origin.y + t * direction.y, sample).height;

    // March at half-cell steps across the plane, then bisect the first crossing.
    const cell = Math.min(surface.width / surface.columns, surface.depth / surface.rows);
    const planarLength = (end - start) * Math.hypot(direction.x, direction.y);
    const steps = THREE.MathUtils.clamp(Math.ceil(planarLength / (cell * 0.5)), 1, MAX_MARCH_STEPS);
    const startGap = gap(start);
    const above = startGap > 0;
    let hitT: number | null = startGap === 0 ? start : null;
    let previous = start;
    for (let step = 1; hitT === null && step <= steps; step++) {
        const t = start + ((end - start) * step) / steps;
        const value = gap(t);
        if (value === 0) {
            hitT = t;
        } else if ((value > 0) !== above) {
            let low = previous;
            let high = t;
            for (let iteration = 0; iteration < BISECTION_STEPS; iteration++) {
                const middle = (low + high) / 2;
                if ((gap(middle) > 0) === above) low = middle;
                else high = middle;
            }
            hitT = (low + high) / 2;
        }
        previous = t;
    }
    if (hitT === null) return null;

    const local = origin.clone().addScaledVector(direction, hitT);
    sampleSurface(surface, local.x, local.y, sample);
    const point = new THREE.Vector3(local.x, local.y, sample.height).applyMatrix4(surface.matrix);
    const normal = new THREE.Vector3(-sample.dhdx, -sample.dhdy, 1).applyMatrix3(surface.normalMatrix).normalize();
    if (normal.dot(worldRay.direction) > 0) normal.negate();
    return { distance: point.distanceTo(worldRay.origin), point, normal };
};

const isEditorHelper = (object: THREE.Object3D): boolean => {
    const flags = object as THREE.Object3D & {
        isTransformControls?: boolean;
        isTransformControlsGizmo?: boolean;
        isTransformControlsPlane?: boolean;
    };
    return Boolean(
        flags.isTransformControls
        || flags.isTransformControlsGizmo
        || flags.isTransformControlsPlane
        || object.userData?.ignorePlacement
        || object.type.endsWith('Helper'),
    );
};

const materialIsSurface = (material: THREE.Material | THREE.Material[]): boolean => {
    const materials = Array.isArray(material) ? material : [material];
    // Shader materials are the grid, sky dome and gizmo overlays, never level geometry.
    return materials.some((entry) => entry && entry.visible && !(entry as THREE.ShaderMaterial).isShaderMaterial);
};

const meshHitNormal = (hit: THREE.Intersection): THREE.Vector3 => {
    const face = hit.face;
    if (!face) return UP.clone();
    const matrix = hit.object.matrixWorld.clone();
    const instanced = hit.object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh && hit.instanceId !== undefined) {
        const instanceMatrix = new THREE.Matrix4();
        instanced.getMatrixAt(hit.instanceId, instanceMatrix);
        matrix.multiply(instanceMatrix);
    }
    const normal = face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix)).normalize();
    return normal.lengthSq() > 0 ? normal : UP.clone();
};

/**
 * Collect the placement surfaces of `scene` once so a tool can cast several
 * rays per frame (a brush cursor plus its scatter samples) without walking
 * the scene for each one.
 */
export const createPlacementQuery = (
    scene: THREE.Object3D,
    levelObjects: readonly LevelObject[],
    options: PlacementOptions = {},
): PlacementQuery => {
    const ignored = new Set(options.ignore ?? []);
    const typeById = new Map<string, LevelObjectType>();
    for (const object of levelObjects) typeById.set(object.id, object.type);

    const surfaces: TerrainSurface[] = [];
    const renderedTerrainIds = new Set<string>();
    const meshes: THREE.Object3D[] = [];

    const visit = (object: THREE.Object3D) => {
        if (!object.visible || ignored.has(object) || isEditorHelper(object)) return;
        const levelObjectId = object.userData?.levelObjectId;
        const levelObjectType = typeof levelObjectId === 'string' ? typeById.get(levelObjectId) : undefined;
        if (levelObjectType && NON_SURFACE_TYPES.has(levelObjectType)) return;

        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && materialIsSurface(mesh.material)) {
            const surface = object.userData?.isTerrain ? surfaceFromMesh(mesh) : null;
            if (surface) {
                surfaces.push(surface);
                if (typeof levelObjectId === 'string') renderedTerrainIds.add(levelObjectId);
            } else {
                meshes.push(object);
            }
        }
        for (const child of object.children) visit(child);
    };
    visit(scene);

    for (const object of levelObjects) {
        if (object.type !== 'terrain' || renderedTerrainIds.has(object.id)) continue;
        const surface = surfaceFromLevelObject(object, levelObjects);
        if (surface) surfaces.push(surface);
    }

    return (raycaster) => {
        let nearest: RayHit | null = null;
        for (const surface of surfaces) {
            const hit = intersectSurface(surface, raycaster);
            if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
        }

        const intersections: THREE.Intersection[] = [];
        for (const mesh of meshes) {
            if (mesh.layers.test(raycaster.layers)) mesh.raycast(raycaster, intersections);
        }
        for (const hit of intersections) {
            if (nearest && hit.distance >= nearest.distance) continue;
            const normal = meshHitNormal(hit);
            if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
            nearest = { distance: hit.distance, point: hit.point.clone(), normal };
        }
        if (nearest) return { point: nearest.point, normal: nearest.normal };

        const point = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(GROUND_PLANE, point)) return null;
        const distance = point.distanceTo(raycaster.ray.origin);
        if (distance < raycaster.near || distance > raycaster.far) return null;
        return { point, normal: UP.clone() };
    };
};

/**
 * Where a ray lands for placement: the nearest terrain or level mesh hit,
 * else the y = 0 ground plane, else null (the ray points away from the ground).
 */
export const raycastPlacement = (
    raycaster: THREE.Raycaster,
    scene: THREE.Object3D,
    levelObjects: LevelObject[],
    options?: PlacementOptions,
): PlacementHit | null => createPlacementQuery(scene, levelObjects, options)(raycaster);
