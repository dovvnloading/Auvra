import * as THREE from 'three';
import { frontendDiagnostics } from '../diagnostics/runtime';

/**
 * FOLIAGE
 *
 * Trees, rocks, grass and anything else painted over a level by the hundred thousand. A level holds at
 * most one foliage set, a single object whose types each pair a model with the rules for painting it and
 * how it is drawn. A type's instances are kept in a binary asset, not as documents, so a forest neither
 * fills the Outliner nor makes every save rewrite thousands of objects.
 *
 * In memory an instance is ten floats: position, rotation as a quaternion, and scale.
 */

export const FOLIAGE_INSTANCE_FLOATS = 10;
export const FOLIAGE_INSTANCE_MIME = 'application/vnd.auvra.foliage';
export const FOLIAGE_INSTANCE_ENCODING = 'float32le-10' as const;
const MAGIC = 'AUVRAFO1';
const HEADER_BYTES = 16;

export type FoliageScaleMode = 'uniform' | 'free' | 'lockWidth';
export type FoliageCollision = 'none' | 'trunk' | 'box';

export interface FoliageInstanceReference {
    assetId: string;
    encoding: typeof FOLIAGE_INSTANCE_ENCODING;
    count: number;
}

/** One model in the palette: how it is painted and how it is drawn. */
export interface FoliageType {
    id: string;
    modelId: string;
    /** In the palette's brush: painted, erased and reapplied by the tools. */
    active: boolean;

    /** Instances per 100 m². */
    density: number;
    /** Metres kept clear around each instance, from others of its type. */
    radius: number;
    scaleMode: FoliageScaleMode;
    /** Sizes picked between each pair. A uniform type uses scaleX for all three; lockWidth uses it for width and depth. */
    scaleX: [number, number];
    scaleY: [number, number];
    scaleZ: [number, number];
    /** Metres moved along the instance's up, picked between the two. */
    zOffset: [number, number];

    alignToNormal: boolean;
    /** Degrees it may lean from upright when aligning. */
    alignMaxAngle: number;
    randomYaw: boolean;
    /** Degrees of random lean. */
    randomPitch: number;

    /** Degrees of ground slope it grows on. */
    slope: [number, number];
    /** World heights it grows between. */
    height: [number, number];
    /** Terrain layers (by name) it only grows on; empty: anywhere. */
    includeLayers: string[];
    /** Terrain layers (by name) it never grows on. */
    excludeLayers: string[];
    /** How much of an included or excluded layer (0-1) counts as being on it. */
    minLayerWeight: number;

    castShadow: boolean;
    /** Beyond this many metres it is drawn as flat pictures; 0 never. */
    impostorDistance: number;
    /** Beyond this many metres it is not drawn; 0 never. */
    cullDistance: number;
    /** In play: nothing, a narrow column (trees), or the model's box. */
    collision: FoliageCollision;

    instancemap?: FoliageInstanceReference;
    /** In memory: resolved from `instancemap`, never written to a document. */
    instances?: Float32Array;
}

export interface FoliageData {
    types: FoliageType[];
}

export const MAX_FOLIAGE_TYPES = 64;
/** Most instances one type holds. */
export const MAX_FOLIAGE_INSTANCES = 2_000_000;

export const DEFAULT_FOLIAGE_TYPE: Omit<FoliageType, 'id' | 'modelId'> = {
    active: true,
    density: 2,
    radius: 1,
    scaleMode: 'uniform',
    scaleX: [0.8, 1.2],
    scaleY: [0.8, 1.2],
    scaleZ: [0.8, 1.2],
    zOffset: [0, 0],
    alignToNormal: false,
    alignMaxAngle: 25,
    randomYaw: true,
    randomPitch: 0,
    slope: [0, 45],
    height: [-100000, 100000],
    includeLayers: [],
    excludeLayers: [],
    minLayerWeight: 0.5,
    castShadow: true,
    impostorDistance: 0,
    cullDistance: 0,
    collision: 'none',
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const num = (value: unknown, fallback: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
const pair = (value: unknown, fallback: [number, number], min: number, max: number): [number, number] => {
    if (!Array.isArray(value) || value.length < 2) return [...fallback];
    const a = num(value[0], fallback[0], min, max);
    const b = num(value[1], fallback[1], min, max);
    return a <= b ? [a, b] : [b, a];
};
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 8) : []);

/** Every field of a stored type defaulted and in range; its instances and their reference are kept as they are. */
export const sanitizeFoliageType = (value: unknown): FoliageType => {
    const t = record(value);
    const base = DEFAULT_FOLIAGE_TYPE;
    const scaleMode = t.scaleMode === 'free' || t.scaleMode === 'lockWidth' ? t.scaleMode : 'uniform';
    const collision = t.collision === 'trunk' || t.collision === 'box' ? t.collision : 'none';
    const type: FoliageType = {
        id: typeof t.id === 'string' ? t.id : '',
        modelId: typeof t.modelId === 'string' ? t.modelId : '',
        active: t.active !== false,
        density: num(t.density, base.density, 0, 100000),
        radius: num(t.radius, base.radius, 0, 1000),
        scaleMode,
        scaleX: pair(t.scaleX, base.scaleX, 0.001, 1000),
        scaleY: pair(t.scaleY, base.scaleY, 0.001, 1000),
        scaleZ: pair(t.scaleZ, base.scaleZ, 0.001, 1000),
        zOffset: pair(t.zOffset, base.zOffset, -1000, 1000),
        alignToNormal: t.alignToNormal === true,
        alignMaxAngle: num(t.alignMaxAngle, base.alignMaxAngle, 0, 90),
        randomYaw: t.randomYaw !== false,
        randomPitch: num(t.randomPitch, base.randomPitch, 0, 180),
        slope: pair(t.slope, base.slope, 0, 90),
        height: pair(t.height, base.height, -1000000, 1000000),
        includeLayers: names(t.includeLayers),
        excludeLayers: names(t.excludeLayers),
        minLayerWeight: num(t.minLayerWeight, base.minLayerWeight, 0, 1),
        castShadow: t.castShadow !== false,
        impostorDistance: num(t.impostorDistance, base.impostorDistance, 0, 1000000),
        cullDistance: num(t.cullDistance, base.cullDistance, 0, 1000000),
        collision,
    };
    if (t.instancemap) type.instancemap = t.instancemap as FoliageInstanceReference;
    if (t.instances instanceof Float32Array) type.instances = t.instances;
    return type;
};

/** How many instances a type holds, whether or not they are loaded yet. */
export const foliageInstanceCount = (type: Pick<FoliageType, 'instances' | 'instancemap'>): number => (
    type.instances ? Math.floor(type.instances.length / FOLIAGE_INSTANCE_FLOATS) : type.instancemap?.count ?? 0
);

/** True while a type's instances are stored in an asset that is not loaded yet. */
export const isFoliageTypePending = (type: Pick<FoliageType, 'instances' | 'instancemap'>): boolean => Boolean(type.instancemap && !type.instances);

export const isFoliageDataPending = (data: FoliageData | null | undefined): boolean => Boolean(data?.types.some(isFoliageTypePending));

// ---------------------------------------------------------------------------
// Stored form
// ---------------------------------------------------------------------------

/**
 * Binary layout of a foliage instance asset (little-endian):
 *   bytes 0-7   ASCII "AUVRAFO1"
 *   bytes 8-11  uint32 instance count
 *   bytes 12-15 uint32 floats per instance
 *   bytes 16-   Float32 values: position, quaternion, scale
 */
export const encodeFoliageInstances = (instances: Float32Array): Uint8Array<ArrayBuffer> => {
    const count = Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS);
    const bytes = new Uint8Array(HEADER_BYTES + count * FOLIAGE_INSTANCE_FLOATS * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < MAGIC.length; index++) bytes[index] = MAGIC.charCodeAt(index);
    view.setUint32(8, count, true);
    view.setUint32(12, FOLIAGE_INSTANCE_FLOATS, true);
    for (let index = 0; index < count * FOLIAGE_INSTANCE_FLOATS; index++) {
        const value = instances[index];
        if (!Number.isFinite(value)) throw new Error('Foliage instances must be finite');
        view.setFloat32(HEADER_BYTES + index * 4, value, true);
    }
    return bytes;
};

export const decodeFoliageInstances = (source: ArrayBuffer | Uint8Array): Float32Array => {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.byteLength < HEADER_BYTES) throw new Error('Foliage instance asset is truncated');
    for (let index = 0; index < MAGIC.length; index++) {
        if (bytes[index] !== MAGIC.charCodeAt(index)) throw new Error('Foliage instance asset has an unknown format');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(8, true);
    const stride = view.getUint32(12, true);
    if (stride !== FOLIAGE_INSTANCE_FLOATS) throw new Error('Foliage instance asset has an unknown layout');
    if (bytes.byteLength !== HEADER_BYTES + count * stride * 4) throw new Error('Foliage instance asset size is invalid');
    const instances = new Float32Array(count * stride);
    for (let index = 0; index < instances.length; index++) instances[index] = view.getFloat32(HEADER_BYTES + index * 4, true);
    return instances;
};

export type FoliageInstanceUploader = (file: File) => Promise<string>;
export type FoliageInstanceLoader = (assetId: string) => Promise<ArrayBuffer>;

// Arrays decoded from, or committed as, a known asset: an unchanged type is not uploaded again.
const knownInstances = new WeakMap<Float32Array, FoliageInstanceReference>();

/**
 * The stored form of a foliage set: each type's in-memory instances replaced by their asset's reference.
 * `stored` lists the assets the document being replaced still names: the host discards an asset once a
 * commit replaces it, so any other remembered one (what undo goes back to, say) has to be uploaded again.
 */
export const externalizeFoliageData = async (data: FoliageData, upload: FoliageInstanceUploader, stored: ReadonlySet<string> = new Set()): Promise<FoliageData> => {
    const types = await Promise.all(data.types.map(async (type): Promise<FoliageType> => {
        const { instances, instancemap, ...rest } = type;
        if (!instances) return instancemap ? { ...rest, instancemap } : rest;
        if (instances.length === 0) return rest;
        const known = knownInstances.get(instances);
        if (known && stored.has(known.assetId)) return { ...rest, instancemap: known };
        return frontendDiagnostics.runAsync('foliage_instances', 'upload', async () => {
            const bytes = encodeFoliageInstances(instances);
            const assetId = await upload(new File([bytes], 'foliage-instances.bin', { type: FOLIAGE_INSTANCE_MIME }));
            const reference: FoliageInstanceReference = { assetId, encoding: FOLIAGE_INSTANCE_ENCODING, count: Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS) };
            knownInstances.set(instances, reference);
            return { ...rest, instancemap: reference };
        });
    }));
    return { types };
};

/** Loads and decodes a type's instances. */
export const resolveFoliageInstances = (reference: FoliageInstanceReference, load: FoliageInstanceLoader): Promise<Float32Array> =>
    frontendDiagnostics.runAsync('foliage_instances', 'resolve', async () => {
        if (reference.encoding !== FOLIAGE_INSTANCE_ENCODING) throw new Error('Foliage instance encoding is not supported');
        const instances = decodeFoliageInstances(await load(reference.assetId));
        knownInstances.set(instances, reference);
        return instances;
    });

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** Instance `index`'s matrix. */
export const foliageInstanceMatrix = (instances: Float32Array, index: number, target: THREE.Matrix4): THREE.Matrix4 => {
    const at = index * FOLIAGE_INSTANCE_FLOATS;
    _position.set(instances[at], instances[at + 1], instances[at + 2]);
    _quaternion.set(instances[at + 3], instances[at + 4], instances[at + 5], instances[at + 6]);
    _scale.set(instances[at + 7], instances[at + 8], instances[at + 9]);
    return target.compose(_position, _quaternion, _scale);
};

/** Writes a matrix back as instance `index`. */
export const writeFoliageMatrix = (instances: Float32Array, index: number, matrix: THREE.Matrix4): void => {
    matrix.decompose(_position, _quaternion, _scale);
    const at = index * FOLIAGE_INSTANCE_FLOATS;
    instances[at] = _position.x;
    instances[at + 1] = _position.y;
    instances[at + 2] = _position.z;
    instances[at + 3] = _quaternion.x;
    instances[at + 4] = _quaternion.y;
    instances[at + 5] = _quaternion.z;
    instances[at + 6] = _quaternion.w;
    instances[at + 7] = _scale.x;
    instances[at + 8] = _scale.y;
    instances[at + 9] = _scale.z;
};

/** A new array of these instances without the ones in `removed`, followed by `added` (flat floats). */
export const editFoliageInstances = (instances: Float32Array | undefined, removed: ReadonlySet<number>, added: ArrayLike<number>): Float32Array => {
    const count = instances ? Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS) : 0;
    const next = new Float32Array((count - removed.size) * FOLIAGE_INSTANCE_FLOATS + added.length);
    let cursor = 0;
    for (let index = 0; index < count; index++) {
        if (removed.has(index)) continue;
        for (let field = 0; field < FOLIAGE_INSTANCE_FLOATS; field++) next[cursor++] = instances![index * FOLIAGE_INSTANCE_FLOATS + field];
    }
    for (let index = 0; index < added.length; index++) next[cursor++] = added[index];
    return next;
};

/** Where a terrain stands and how large, to read its world height. */
export interface FoliageGroundTerrain {
    position: readonly number[];
    scale: readonly number[];
    width: number;
    depth: number;
    resolution: number;
    heights: ArrayLike<number> | null | undefined;
}

/** A terrain's world height under a point (bilinear), or null off it; heights that do not fit its grid read as flat. */
export const groundHeightUnder = (terrain: FoliageGroundTerrain, x: number, z: number): number | null => {
    const samples = terrain.resolution + 1;
    const u = (x - terrain.position[0]) / (terrain.width * (terrain.scale[0] || 1)) + 0.5;
    const v = (z - terrain.position[2]) / (terrain.depth * (terrain.scale[2] || 1)) + 0.5;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
    const { heights } = terrain;
    if (!heights || heights.length !== samples * samples) return terrain.position[1];
    const fx = u * terrain.resolution;
    const fy = v * terrain.resolution;
    const c0 = Math.min(terrain.resolution - 1, Math.floor(fx));
    const r0 = Math.min(terrain.resolution - 1, Math.floor(fy));
    const tx = fx - c0;
    const ty = fy - r0;
    const top = heights[r0 * samples + c0] * (1 - tx) + heights[r0 * samples + c0 + 1] * tx;
    const bottom = heights[(r0 + 1) * samples + c0] * (1 - tx) + heights[(r0 + 1) * samples + c0 + 1] * tx;
    return terrain.position[1] + (top * (1 - ty) + bottom * ty) * (terrain.scale[1] || 1);
};

/**
 * Keeps instances on the ground after a terrain changed under them. `before` and `after` give the
 * terrain's world height under a point, or null off it. An instance stands on the terrain if it is
 * within `tolerance` metres of the old surface: anything higher is on something else and stays. Only its
 * height moves, so a stroke does not turn what was placed by hand. Returns a new array, or null with no change.
 */
export const followTerrainEdit = (
    instances: Float32Array,
    before: (x: number, z: number) => number | null,
    after: (x: number, z: number) => number | null,
    tolerance = 1.5,
): Float32Array | null => {
    let next: Float32Array | null = null;
    for (let at = 0; at < instances.length; at += FOLIAGE_INSTANCE_FLOATS) {
        const x = instances[at];
        const y = instances[at + 1];
        const z = instances[at + 2];
        const old = before(x, z);
        if (old === null || Math.abs(y - old) > tolerance) continue;
        const now = after(x, z);
        if (now === null || now === old) continue;
        next ??= instances.slice();
        next[at + 1] = y + (now - old);
    }
    return next;
};

/** A set's types after a terrain's heights changed, or null when no instance had to move. */
export const foliageAfterTerrainEdit = (types: readonly FoliageType[], before: FoliageGroundTerrain, after: FoliageGroundTerrain): FoliageType[] | null => {
    let changed = false;
    const next = types.map((type) => {
        const moved = type.instances && followTerrainEdit(type.instances, (x, z) => groundHeightUnder(before, x, z), (x, z) => groundHeightUnder(after, x, z));
        if (!moved) return type;
        changed = true;
        return { ...type, instances: moved };
    });
    return changed ? next : null;
};
