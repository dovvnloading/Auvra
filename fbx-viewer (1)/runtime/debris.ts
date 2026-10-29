import * as THREE from 'three';
import type { FracturePiece, FractureResult } from './fracture';
import type { Vec3 } from './destructibles';

/**
 * DEBRIS
 *
 * The pieces of broken objects, loose in the world: each a mesh and a physics body (a convex hull
 * of its solid), placed where it was in the object, the object's scale baked in. They scatter from
 * the break, and from the hit that caused it, settle, and after their lifetime shrink away. The
 * oldest go first when there are too many. The physics comes through a small interface, so this
 * works the same against Rapier in play and a stand-in in tests.
 */

/** Most pieces loose at once. */
export const MAX_DEBRIS = 600;
/** Seconds a piece takes to shrink away at the end of its life. */
export const DEBRIS_FADE = 0.8;
/** Lightest a piece is, kg. */
const MIN_PIECE_MASS = 0.05;

export interface DebrisPhysics {
    /** Adds a dynamic body with a convex collider round `hull` (its own space); null when it cannot. */
    spawn(hull: Float32Array, position: Vec3, rotation: THREE.Quaternion, velocity: Vec3, spin: Vec3, mass: number): unknown | null;
    /** Reads a body's pose; false once it is gone. */
    pose(body: unknown, position: THREE.Vector3, rotation: THREE.Quaternion): boolean;
    remove(body: unknown): void;
}

export interface DebrisOptions {
    /** kg per cubic metre. */
    density: number;
    /** Seconds the pieces stay before shrinking away; 0 or less: they stay. */
    life: number;
    /** How fast pieces fly apart from the object's middle, m/s. */
    scatter: number;
    /** Where it was hit, world (null: no hit), the hit's direction, and how fast the pieces nearest it fly from it, m/s. */
    hit: Vec3 | null;
    direction: Vec3 | null;
    push: number;
    /** Velocity every piece starts with on top (the object's own motion), m/s. */
    inherit?: Vec3;
}

interface Piece {
    mesh: THREE.Mesh;
    body: unknown;
    age: number;
    life: number;
    scale: number;
}

const _position = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _middle = new THREE.Vector3();

/** A piece's triangles as geometry, scaled by the object's (possibly uneven) scale. */
export const pieceGeometry = (piece: FracturePiece, scale: THREE.Vector3): THREE.BufferGeometry => {
    const positions = new Float32Array(piece.positions.length);
    const normals = new Float32Array(piece.normals.length);
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = piece.positions[i] * scale.x;
        positions[i + 1] = piece.positions[i + 1] * scale.y;
        positions[i + 2] = piece.positions[i + 2] * scale.z;
        // Normals go by the inverse scale, then back to unit length.
        const nx = piece.normals[i] / scale.x, ny = piece.normals[i + 1] / scale.y, nz = piece.normals[i + 2] / scale.z;
        const length = Math.hypot(nx, ny, nz) || 1;
        normals[i] = nx / length;
        normals[i + 1] = ny / length;
        normals[i + 2] = nz / length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(piece.uvs.slice(), 2));
    for (const group of piece.groups) geometry.addGroup(group.start, group.count, group.material);
    geometry.computeBoundingSphere();
    return geometry;
};

/** A piece's collider corners, scaled. */
const scaledHull = (piece: FracturePiece, scale: THREE.Vector3): Float32Array => {
    const hull = new Float32Array(piece.hull.length);
    for (let i = 0; i < hull.length; i += 3) {
        hull[i] = piece.hull[i] * scale.x;
        hull[i + 1] = piece.hull[i + 1] * scale.y;
        hull[i + 2] = piece.hull[i + 2] * scale.z;
    }
    return hull;
};

export class DebrisWorld {
    readonly object = new THREE.Group();
    private readonly pieces: Piece[] = [];
    private readonly physics: DebrisPhysics;
    private readonly cap: number;
    private readonly random: () => number;

    constructor(physics: DebrisPhysics, cap = MAX_DEBRIS, random: () => number = Math.random) {
        this.physics = physics;
        this.cap = cap;
        this.random = random;
        this.object.name = 'Debris';
    }

    get count(): number {
        return this.pieces.length;
    }

    /**
     * Puts a broken object's pieces into the world where the object stood (`matrix`: its world
     * matrix, scale included), drawn with `materials` by slot. Returns how many came loose.
     */
    spawn(result: FractureResult, materials: THREE.Material[], matrix: THREE.Matrix4, options: DebrisOptions): number {
        if (result.pieces.length === 0) return 0;
        matrix.decompose(_position, _rotation, _scale);
        const scale = _scale.clone().set(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z));
        const volumeScale = scale.x * scale.y * scale.z;
        // The object's middle: its pieces' centres weighed by volume.
        _middle.set(0, 0, 0);
        let total = 0;
        for (const piece of result.pieces) {
            _middle.x += piece.centre[0] * piece.volume;
            _middle.y += piece.centre[1] * piece.volume;
            _middle.z += piece.centre[2] * piece.volume;
            total += piece.volume;
        }
        if (total > 0) _middle.divideScalar(total);
        _middle.multiply(scale).applyQuaternion(_rotation).add(_position);
        const size = Math.cbrt(Math.max(1e-6, total * volumeScale));

        while (this.pieces.length + result.pieces.length > this.cap && this.pieces.length > 0) this.removeAt(0);

        let spawned = 0;
        for (const piece of result.pieces) {
            _centre.set(piece.centre[0], piece.centre[1], piece.centre[2]).multiply(scale).applyQuaternion(_rotation).add(_position);
            // Outward from the middle, faster for the pieces nearest the hit, along the hit's direction.
            _offset.subVectors(_centre, _middle);
            const outward = _offset.length() > 1e-6 ? _offset.clone().normalize() : new THREE.Vector3(this.random() - 0.5, 0.5, this.random() - 0.5).normalize();
            const velocity = outward.multiplyScalar(options.scatter * (0.5 + 0.5 * this.random()));
            if (options.hit && options.push > 0) {
                const away = _offset.subVectors(_centre, new THREE.Vector3(options.hit.x, options.hit.y, options.hit.z));
                const distance = away.length();
                const nearness = 1 / (1 + (distance / Math.max(0.2, size * 0.5)) ** 2);
                if (distance > 1e-6) velocity.addScaledVector(away.normalize(), options.push * nearness);
                if (options.direction) velocity.add(new THREE.Vector3(options.direction.x, options.direction.y, options.direction.z).multiplyScalar(options.push * 0.6 * nearness));
            }
            if (options.inherit) velocity.add(new THREE.Vector3(options.inherit.x, options.inherit.y, options.inherit.z));
            const pieceSize = Math.cbrt(Math.max(1e-9, piece.volume * volumeScale));
            const spinRate = Math.min(12, (2 + 4 * this.random()) / Math.max(0.15, pieceSize));
            const spin = new THREE.Vector3(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).normalize().multiplyScalar(spinRate * Math.min(1, (options.scatter + options.push) / 4));
            const mass = Math.max(MIN_PIECE_MASS, piece.volume * volumeScale * options.density);
            const body = this.physics.spawn(scaledHull(piece, scale), _centre, _rotation, velocity, spin, mass);
            if (body === null) continue;
            const mesh = new THREE.Mesh(pieceGeometry(piece, scale), materials);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.copy(_centre);
            mesh.quaternion.copy(_rotation);
            mesh.name = 'DebrisPiece';
            this.object.add(mesh);
            // Lifetimes differ a little, so a heap does not vanish all at once.
            this.pieces.push({ mesh, body, age: 0, life: options.life > 0 ? options.life * (0.8 + 0.4 * this.random()) : Infinity, scale: 1 });
            spawned++;
        }
        return spawned;
    }

    /** Moves the meshes to their bodies, ages them, and lets the old ones shrink away. */
    update(dt: number): void {
        for (let i = this.pieces.length - 1; i >= 0; i--) {
            const piece = this.pieces[i];
            if (!this.physics.pose(piece.body, piece.mesh.position, piece.mesh.quaternion)) {
                this.removeAt(i);
                continue;
            }
            piece.age += dt;
            if (piece.age > piece.life) {
                const left = 1 - (piece.age - piece.life) / DEBRIS_FADE;
                if (left <= 0) {
                    this.removeAt(i);
                    continue;
                }
                piece.mesh.scale.setScalar(left);
            }
        }
    }

    /** Removes every piece. */
    clear(): void {
        while (this.pieces.length > 0) this.removeAt(this.pieces.length - 1);
    }

    private removeAt(index: number): void {
        const [piece] = this.pieces.splice(index, 1);
        this.physics.remove(piece.body);
        piece.mesh.removeFromParent();
        piece.mesh.geometry.dispose();
    }
}
