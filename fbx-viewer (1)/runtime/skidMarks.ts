import * as THREE from 'three';
import { SURFACES, type SurfaceSpec } from './surfaces';

/**
 * Tyre marks: a ring of quads laid along each wheel's path while it slides or spins (and wherever
 * it rolls on loose ground, a rut), the oldest overwritten first. One buffer for the whole play
 * session; vehicles lay their wheels' trails into it.
 */

/** Quads the session keeps before the oldest are overwritten. */
export const SKID_SEGMENTS = 6000;
/** A trail lays a new quad each time its wheel has moved this far, metres. */
export const SKID_SPACING = 0.3;
/** Marks sit this far above the ground so they do not flicker into it, metres. */
const LIFT = 0.012;
/** Below this a wheel lays no mark. */
const MARK_THRESHOLD = 0.08;
/** A trail broken by a gap longer than this starts afresh rather than bridging it, metres. */
const MAX_GAP = 2.5;

/** How dark a wheel's mark is, 0-1: the slide or spin past the tyre's grip, or a rut on loose ground. */
export const markIntensity = (
    wheel: { contact: boolean; slipRatio: number; slipAngle: number; groundSpeed: number; load: number },
    surface: Pick<SurfaceSpec, 'markColor' | 'loose'>,
): number => {
    if (!wheel.contact || surface.markColor === null || wheel.load <= 0) return 0;
    const slide = wheel.groundSpeed > 1 ? Math.min(1, Math.max(0, Math.abs(wheel.slipAngle) - 0.14) / 0.3) : 0;
    const spin = Math.min(1, Math.max(0, Math.abs(wheel.slipRatio) - 0.25) / 0.75);
    const skid = Math.max(slide, spin);
    const rut = surface.loose && wheel.groundSpeed > 0.4 ? 0.35 : 0;
    return Math.max(skid, rut);
};

/** Where a wheel's trail ended: its last point and the half-width across it there. */
export interface SkidTrail {
    active: boolean;
    point: THREE.Vector3;
    across: THREE.Vector3;
}

export const createSkidTrail = (): SkidTrail => ({ active: false, point: new THREE.Vector3(), across: new THREE.Vector3() });

const _direction = new THREE.Vector3();
const _across = new THREE.Vector3();
const _lifted = new THREE.Vector3();
const _color = new THREE.Color();

export class SkidMarkBuffer {
    readonly capacity: number;
    /** Four corners per quad. */
    readonly positions: Float32Array;
    /** RGBA per corner (linear). */
    readonly colors: Float32Array;
    readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    /** The next quad to write. */
    next = 0;
    /** Quads written, up to the capacity. */
    count = 0;

    constructor(capacity = SKID_SEGMENTS) {
        this.capacity = capacity;
        this.positions = new Float32Array(capacity * 4 * 3);
        this.colors = new Float32Array(capacity * 4 * 4);
        const indices = new Uint32Array(capacity * 6);
        for (let q = 0; q < capacity; q++) {
            const v = q * 4;
            indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.setDrawRange(0, 0);
        // The marks are scattered over the level; nothing is gained culling or sorting them.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.name = 'SkidMarks';
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -1;
        this.mesh.raycast = () => undefined;
    }

    /** One quad from (a0, a1) to (b0, b1), each pair across the trail. */
    addQuad(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3, color: THREE.Color, alphaStart: number, alphaEnd: number): void {
        const q = this.next;
        const p = q * 12;
        const corners = [a0, a1, b0, b1];
        corners.forEach((corner, i) => {
            this.positions[p + i * 3] = corner.x;
            this.positions[p + i * 3 + 1] = corner.y;
            this.positions[p + i * 3 + 2] = corner.z;
            const c = q * 16 + i * 4;
            this.colors[c] = color.r;
            this.colors[c + 1] = color.g;
            this.colors[c + 2] = color.b;
            this.colors[c + 3] = i < 2 ? alphaStart : alphaEnd;
        });
        this.next = (q + 1) % this.capacity;
        this.count = Math.min(this.capacity, this.count + 1);
        const geometry = this.mesh.geometry;
        geometry.setDrawRange(0, this.count * 6);
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;
        const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
        position.addUpdateRange(p, 12);
        colors.addUpdateRange(q * 16, 16);
        position.needsUpdate = true;
        colors.needsUpdate = true;
    }

    clear(): void {
        this.next = 0;
        this.count = 0;
        this.mesh.geometry.setDrawRange(0, 0);
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

/**
 * One wheel's mark this frame: carries its trail on to `point` (the tyre's contact, `normal` the
 * ground's) once it has moved SKID_SPACING, at `intensity` (markIntensity) in the surface's mark
 * colour; a wheel laying no mark ends its trail. Returns whether a quad was laid.
 */
export const extendSkidTrail = (
    buffer: SkidMarkBuffer,
    trail: SkidTrail,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    halfWidth: number,
    intensity: number,
    surface: keyof typeof SURFACES,
): boolean => {
    const markColor = SURFACES[surface].markColor;
    if (intensity < MARK_THRESHOLD || !markColor) {
        trail.active = false;
        return false;
    }
    _lifted.copy(point).addScaledVector(normal, LIFT);
    if (!trail.active || trail.point.distanceTo(_lifted) > MAX_GAP) {
        trail.active = true;
        trail.point.copy(_lifted);
        trail.across.set(0, 0, 0);
        return false;
    }
    _direction.subVectors(_lifted, trail.point);
    const length = _direction.length();
    if (length < SKID_SPACING) return false;
    _direction.divideScalar(length);
    _across.crossVectors(normal, _direction).normalize().multiplyScalar(halfWidth);
    // A trail's first quad starts square across its own direction.
    if (trail.across.lengthSq() === 0) trail.across.copy(_across);
    const alpha = Math.min(0.85, 0.25 + 0.6 * intensity);
    _color.set(markColor);
    const a0 = trail.point.clone().add(trail.across);
    const a1 = trail.point.clone().sub(trail.across);
    const b0 = _lifted.clone().add(_across);
    const b1 = _lifted.clone().sub(_across);
    buffer.addQuad(a0, a1, b0, b1, _color, alpha, alpha);
    trail.point.copy(_lifted);
    trail.across.copy(_across);
    return true;
};

/** The play session's tyre marks, laid by every vehicle; cleared when the session ends. */
let sessionMarks: SkidMarkBuffer | null = null;

export const skidMarks = (): SkidMarkBuffer => (sessionMarks ??= new SkidMarkBuffer());

export const releaseSkidMarks = (): void => {
    sessionMarks?.dispose();
    sessionMarks = null;
};
