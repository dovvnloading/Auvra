import * as THREE from 'three';
import { FOLIAGE_INSTANCE_FLOATS, type FoliageType } from '../../../runtime/foliage';

/**
 * FOLIAGE PLACEMENT
 *
 * The rules a foliage type's instances are placed by: where they may stand, how far apart, how they lean,
 * turn and size. The brush tools hand in the ground; nothing here knows about the scene.
 */

/** What lies under a point. */
export interface FoliageGround {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    /** How much of a terrain layer is there (0-1); null when it is not a terrain, or the layer is unknown. */
    layerWeight?: (name: string) => number | null;
}

/** Instances by position, for finding those near a point. */
export class FoliageHash {
    private readonly cells = new Map<number, number[]>();
    private positions: number[] = [];
    private readonly removed = new Set<number>();

    constructor(private readonly cellSize: number) {}

    private key(x: number, z: number): number {
        return Math.floor(x / this.cellSize) * 73856093 ^ Math.floor(z / this.cellSize) * 19349663;
    }

    /** Adds an instance under the id given. */
    add(id: number, x: number, y: number, z: number): void {
        this.positions[id * 3] = x;
        this.positions[id * 3 + 1] = y;
        this.positions[id * 3 + 2] = z;
        const key = this.key(x, z);
        const cell = this.cells.get(key);
        if (cell) cell.push(id);
        else this.cells.set(key, [id]);
    }

    remove(id: number): void {
        this.removed.add(id);
    }

    /** Calls back with each instance within `radius` of (x, z) across the ground. */
    near(x: number, z: number, radius: number, visit: (id: number, px: number, py: number, pz: number) => void): void {
        const reach = Math.ceil(radius / this.cellSize);
        const cx = Math.floor(x / this.cellSize);
        const cz = Math.floor(z / this.cellSize);
        const limit = radius * radius;
        for (let i = -reach; i <= reach; i++) {
            for (let j = -reach; j <= reach; j++) {
                const cell = this.cells.get((cx + i) * 73856093 ^ (cz + j) * 19349663);
                if (!cell) continue;
                for (const id of cell) {
                    if (this.removed.has(id)) continue;
                    const px = this.positions[id * 3];
                    const pz = this.positions[id * 3 + 2];
                    if ((px - x) ** 2 + (pz - z) ** 2 <= limit) visit(id, px, this.positions[id * 3 + 1], pz);
                }
            }
        }
    }

    /** True with an instance closer than `radius`. */
    occupied(x: number, z: number, radius: number): boolean {
        if (radius <= 0) return false;
        let found = false;
        this.near(x, z, radius, () => { found = true; });
        return found;
    }

    /** How many instances lie within `radius`. */
    count(x: number, z: number, radius: number): number {
        let total = 0;
        this.near(x, z, radius, () => { total++; });
        return total;
    }
}

export const foliageHashOf = (instances: Float32Array | undefined, radius: number): FoliageHash => {
    const hash = new FoliageHash(Math.max(1, radius * 2));
    if (!instances) return hash;
    const count = Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS);
    for (let index = 0; index < count; index++) {
        const at = index * FOLIAGE_INSTANCE_FLOATS;
        hash.add(index, instances[at], instances[at + 1], instances[at + 2]);
    }
    return hash;
};

const UP = new THREE.Vector3(0, 1, 0);
const _align = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _pitch = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _result = new THREE.Quaternion();
const _clampedNormal = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Whether the type grows on this ground: its slope and height, and the layers there. */
export const foliageFits = (type: FoliageType, ground: FoliageGround): boolean => {
    const slope = (Math.acos(Math.min(1, Math.max(-1, ground.normal.y))) * 180) / Math.PI;
    if (slope < type.slope[0] || slope > type.slope[1]) return false;
    const { y } = ground.point;
    if (y < type.height[0] || y > type.height[1]) return false;
    if (type.includeLayers.length > 0) {
        if (!ground.layerWeight) return false;
        const on = type.includeLayers.some(name => (ground.layerWeight!(name) ?? 0) >= type.minLayerWeight);
        if (!on) return false;
    }
    if (type.excludeLayers.length > 0 && ground.layerWeight) {
        if (type.excludeLayers.some(name => (ground.layerWeight!(name) ?? 0) >= type.minLayerWeight)) return false;
    }
    return true;
};

const between = ([low, high]: [number, number], random: () => number): number => low + (high - low) * random();

/** The size an instance of the type is given. */
export const foliageScale = (type: FoliageType, random: () => number): [number, number, number] => {
    if (type.scaleMode === 'free') return [between(type.scaleX, random), between(type.scaleY, random), between(type.scaleZ, random)];
    const width = between(type.scaleX, random);
    return type.scaleMode === 'lockWidth' ? [width, between(type.scaleY, random), width] : [width, width, width];
};

/** Which way an instance of the type turns on this ground. */
export const foliageRotation = (type: FoliageType, normal: THREE.Vector3, random: () => number, target: THREE.Quaternion): THREE.Quaternion => {
    if (type.alignToNormal) {
        const angle = Math.acos(Math.min(1, Math.max(-1, normal.y)));
        const limit = (type.alignMaxAngle * Math.PI) / 180;
        if (angle > limit && angle > 1e-5) {
            // Lean only as far as allowed.
            _axis.crossVectors(UP, normal).normalize();
            _clampedNormal.copy(UP).applyAxisAngle(_axis, limit);
            _align.setFromUnitVectors(UP, _clampedNormal);
        } else {
            _align.setFromUnitVectors(UP, normal);
        }
    } else {
        _align.identity();
    }
    _yaw.setFromAxisAngle(UP, type.randomYaw ? random() * Math.PI * 2 : 0);
    if (type.randomPitch > 0) {
        const lean = random() * type.randomPitch * (Math.PI / 180);
        const around = random() * Math.PI * 2;
        _axis.set(Math.cos(around), 0, Math.sin(around));
        _pitch.setFromAxisAngle(_axis, lean);
    } else {
        _pitch.identity();
    }
    return target.copy(_align).multiply(_pitch).multiply(_yaw);
};

/** Appends a new instance of the type standing on this ground to `out`; returns its position. */
export const placeFoliageInstance = (type: FoliageType, ground: FoliageGround, random: () => number, out: number[]): THREE.Vector3 => {
    foliageRotation(type, ground.normal, random, _result);
    const size = foliageScale(type, random);
    const position = ground.point.clone();
    const offset = between(type.zOffset, random);
    if (offset !== 0) position.addScaledVector(_up.copy(UP).applyQuaternion(_result), offset);
    out.push(position.x, position.y, position.z, _result.x, _result.y, _result.z, _result.w, size[0], size[1], size[2]);
    return position;
};

const _box = new THREE.Matrix4();
const _at = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _size = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

/**
 * Whether the box of an instance (10 floats from `at`) is clear of whatever `blocked` finds along a line.
 * It looks down through a grid of columns, which finds anything with a top, and across the box both ways,
 * which finds walls. The bottom tenth and the outer edge are let off: models sit a little into what they
 * stand on, and touching is not overlapping.
 */
export const foliageBoxIsClear = (bounds: THREE.Box3, instance: ArrayLike<number>, at: number, blocked: (from: THREE.Vector3, to: THREE.Vector3) => boolean): boolean => {
    if (bounds.isEmpty()) return true;
    _box.compose(
        _at.set(instance[at], instance[at + 1], instance[at + 2]),
        _turn.set(instance[at + 3], instance[at + 4], instance[at + 5], instance[at + 6]),
        _size.set(instance[at + 7], instance[at + 8], instance[at + 9]),
    );
    const { min, max } = bounds;
    const insetX = (max.x - min.x) * 0.05;
    const insetZ = (max.z - min.z) * 0.05;
    const low = min.y + (max.y - min.y) * 0.1;
    const xs = [min.x + insetX, (min.x + max.x) / 2, max.x - insetX];
    const zs = [min.z + insetZ, (min.z + max.z) / 2, max.z - insetZ];
    const across = (low + max.y) / 2;
    const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean => blocked(
        _from.set(x0, y0, z0).applyMatrix4(_box),
        _to.set(x1, y1, z1).applyMatrix4(_box),
    );
    for (const x of xs) {
        for (const z of zs) if (line(x, max.y, z, x, low, z)) return false;
        if (line(x, across, zs[0], x, across, zs[2]) || line(x, across, zs[2], x, across, zs[0])) return false;
    }
    for (const z of zs) {
        if (line(xs[0], across, z, xs[2], across, z) || line(xs[2], across, z, xs[0], across, z)) return false;
    }
    return true;
};

/** Instances the brush should hold of a type at this density, a fraction left to chance. */
export const instancesWanted = (density: number, area: number, scale: number, random: () => number): number => {
    const exact = (density / 100) * area * scale;
    const whole = Math.floor(exact);
    return whole + (random() < exact - whole ? 1 : 0);
};

/** A density and spacing that suit a model of this footprint. */
export const foliageDefaultsFor = (footprint: number): { density: number; radius: number } => {
    const size = Math.max(0.05, footprint);
    const radius = Math.round(size * 0.6 * 100) / 100;
    // About half covered at its own spacing: dense enough to read as a patch, with gaps between.
    const density = Math.min(2000, Math.max(0.1, 100 / (size * size * 2.5)));
    return { density: Math.round(density * 100) / 100, radius };
};
