import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ConvexGeometry } from 'three-stdlib';
import {
    BallCollider,
    CapsuleCollider,
    ConvexHullCollider,
    CuboidCollider,
    RigidBody,
    TrimeshCollider,
    useBeforePhysicsStep,
    useRapier
} from '@react-three/rapier';
import type { CollisionPayload, CuboidColliderProps, RapierCollider, RapierRigidBody, RigidBodyProps } from '@react-three/rapier';
import type { LevelComponent, LevelObject } from '../../types';
import { PhysicsFailureBoundary, objectIdFromRigidBody, physicsUserData, usePhysicsAvailable } from '../physics';
import { useTriggerEvents } from '../triggers';
import type { TriggerEvent } from '../triggers';
import { findWheelNodes, readVehicleSettings, VEHICLE_COMPONENT_TYPE, VEHICLE_SHELL_MASS_SHARE } from '../vehicles';
import { SURFACE_KINDS, SURFACES, surfaceFromName, tagSurface, triangleSurfaces, type SurfaceKind, type SurfaceTag } from '../surfaces';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

type Vec3 = [number, number, number];

export type ColliderShape = 'box' | 'sphere' | 'capsule' | 'mesh';
export type PhysicsBodyType = 'fixed' | 'dynamic' | 'kinematicPosition';

const COLLIDER_SHAPES: readonly ColliderShape[] = ['box', 'sphere', 'capsule', 'mesh'];
const BODY_TYPES: readonly PhysicsBodyType[] = ['fixed', 'dynamic', 'kinematicPosition'];

/** Smallest collider dimension, so a zero or negative field never builds an empty shape. */
const MIN_EXTENT = 0.01;
const MIN_MASS = 0.001;
const ZERO: Vec3 = [0, 0, 0];

export interface ColliderSettings {
    shape: ColliderShape;
    /** Full box extents along the object's local axes. */
    size: Vec3;
    /** Sphere and capsule radius. */
    radius: number;
    /** Capsule height including its rounded ends, along the object's local Y. */
    height: number;
    /** Shape centre in the object's local space. */
    offset: Vec3;
    isTrigger: boolean;
    /** What the ground is made of, for tyres and the like; 'auto' reads it from the model's material names. */
    surface: SurfaceKind | 'auto';
}

export interface RigidBodySettings {
    type: PhysicsBodyType;
    mass: number;
    gravityScale: number;
    lockRotation: boolean;
}

const COLLIDER_DEFAULTS: ColliderSettings = { shape: 'box', size: [1, 1, 1], radius: 0.5, height: 2, offset: [0, 0, 0], isTrigger: false, surface: 'auto' };
const COLLIDER_SURFACES: readonly (SurfaceKind | 'auto')[] = ['auto', ...SURFACE_KINDS];
const RIGID_BODY_DEFAULTS: RigidBodySettings = { type: 'dynamic', mass: 1, gravityScale: 1, lockRotation: false };

const readNumber = (component: LevelComponent, key: string, fallback: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const readChoice = <T extends string>(component: LevelComponent, key: string, choices: readonly T[], fallback: T): T => {
    const value = component.props[key];
    return typeof value === 'string' && (choices as readonly string[]).includes(value) ? value as T : fallback;
};

const readVector3 = (component: LevelComponent, key: string, fallback: Vec3): Vec3 => {
    const value = component.props[key];
    const valid = Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));
    const [x, y, z] = valid ? value as Vec3 : fallback;
    return [x, y, z];
};

/** A collider component's props, with missing or invalid values at their defaults and sizes kept positive. */
export const resolveColliderSettings = (component: LevelComponent): ColliderSettings => {
    const [sx, sy, sz] = readVector3(component, 'size', COLLIDER_DEFAULTS.size);
    return {
        shape: readChoice(component, 'shape', COLLIDER_SHAPES, COLLIDER_DEFAULTS.shape),
        size: [Math.max(MIN_EXTENT, Math.abs(sx)), Math.max(MIN_EXTENT, Math.abs(sy)), Math.max(MIN_EXTENT, Math.abs(sz))],
        radius: Math.max(MIN_EXTENT, readNumber(component, 'radius', COLLIDER_DEFAULTS.radius)),
        height: Math.max(MIN_EXTENT, readNumber(component, 'height', COLLIDER_DEFAULTS.height)),
        offset: readVector3(component, 'offset', COLLIDER_DEFAULTS.offset),
        isTrigger: readBoolean(component, 'isTrigger', COLLIDER_DEFAULTS.isTrigger),
        surface: readChoice(component, 'surface', COLLIDER_SURFACES, COLLIDER_DEFAULTS.surface)
    };
};

/** A rigid body component's props, with missing or invalid values at their defaults. */
export const resolveRigidBodySettings = (component: LevelComponent): RigidBodySettings => ({
    type: readChoice(component, 'type', BODY_TYPES, RIGID_BODY_DEFAULTS.type),
    mass: Math.max(MIN_MASS, readNumber(component, 'mass', RIGID_BODY_DEFAULTS.mass)),
    gravityScale: readNumber(component, 'gravityScale', RIGID_BODY_DEFAULTS.gravityScale),
    lockRotation: readBoolean(component, 'lockRotation', RIGID_BODY_DEFAULTS.lockRotation)
});

/** Half length of a capsule's straight section; a height under twice the radius leaves a sphere. */
export const capsuleHalfHeight = (settings: ColliderSettings): number => Math.max(0, settings.height / 2 - settings.radius);

// --- BODY PLAN ---

export interface PhysicsBodyPlan {
    /** The component whose Render mounts the body: the first enabled rigidBody, else a vehicle, else the first enabled collider. */
    ownerId: string;
    /** True when an enabled Rigid Body (or Vehicle) component sets the body; colliders alone make fixed scenery. */
    rigidBody: boolean;
    /** The object is a vehicle: its automatic hull leaves out the wheels, which ride on the suspension. */
    vehicle: boolean;
    /** Colliders without a rigidBody make fixed scenery. */
    body: RigidBodySettings;
    colliders: { id: string; settings: ColliderSettings }[];
    /** A rigidBody with no collider components gets one convex hull around the object's meshes. */
    autoHull: boolean;
}

/** How the object's enabled physics components combine into one body, or null when it has none. */
export const planPhysicsBody = (object: LevelObject): PhysicsBodyPlan | null => {
    const enabled = (object.components ?? []).filter(component => component.enabled);
    const rigidBody = enabled.find(component => component.type === 'rigidBody');
    // A Vehicle is a dynamic body of its own mass, unless a Rigid Body component on it sets the body.
    const vehicle = enabled.find(component => component.type === VEHICLE_COMPONENT_TYPE);
    const colliders = enabled.filter(component => component.type === 'collider');
    const owner = rigidBody ?? vehicle ?? colliders[0];
    if (!owner) return null;
    const body: RigidBodySettings = rigidBody
        ? resolveRigidBodySettings(rigidBody)
        : vehicle
            ? { ...RIGID_BODY_DEFAULTS, type: 'dynamic', mass: readVehicleSettings(vehicle).mass * VEHICLE_SHELL_MASS_SHARE }
            : { ...RIGID_BODY_DEFAULTS, type: 'fixed' };
    return {
        ownerId: owner.id,
        rigidBody: Boolean(rigidBody ?? vehicle),
        vehicle: Boolean(vehicle),
        body,
        colliders: colliders.map(component => ({ id: component.id, settings: resolveColliderSettings(component) })),
        autoHull: Boolean(rigidBody ?? vehicle) && colliders.length === 0
    };
};

/**
 * The mass one collider gives its body. A dynamic body's mass is shared by its solid shapes (its
 * colliders, its automatic hull and the colliders `folded` in from descendant objects), so triggers
 * add none (unless every shape is a trigger); other body types take no mass.
 */
export const colliderMass = (plan: PhysicsBodyPlan, settings: ColliderSettings, folded: readonly ColliderSettings[] = []): number | undefined => {
    if (plan.body.type !== 'dynamic') return undefined;
    const shapes = [...plan.colliders.map(entry => entry.settings), ...folded];
    const hull = plan.autoHull ? 1 : 0;
    const solid = shapes.filter(shape => !shape.isTrigger).length + hull;
    if (solid === 0) return plan.body.mass / Math.max(1, shapes.length);
    return settings.isTrigger ? 0 : plan.body.mass / solid;
};

// --- SHAPE SCALE ---

/** Smallest scale factor a shape is divided by, so a zero scale axis never makes it infinite. */
const MIN_SCALE = 1e-6;
const UNIT_SCALE: Vec3 = [1, 1, 1];

/** The per-axis size of a world scale, kept above zero. */
const absoluteScale = (scale: THREE.Vector3): Vec3 => [
    Math.max(MIN_SCALE, Math.abs(scale.x)),
    Math.max(MIN_SCALE, Math.abs(scale.y)),
    Math.max(MIN_SCALE, Math.abs(scale.z))
];

const sameScale = (a: Vec3, b: Vec3): boolean =>
    a.every((value, axis) => Math.abs(value - b[axis]) <= 1e-6 * Math.max(1, Math.abs(value)));

const multiplyScale = (a: Vec3, b: Vec3): Vec3 => [
    Math.max(MIN_SCALE, Math.abs(a[0] * b[0])),
    Math.max(MIN_SCALE, Math.abs(a[1] * b[1])),
    Math.max(MIN_SCALE, Math.abs(a[2] * b[2]))
];

export interface RoundShapeSize {
    radius: number;
    /** Half length of a capsule's straight section; 0 for a sphere. */
    halfHeight: number;
}

/**
 * The world size of a sphere or capsule collider on an object with world scale `scale`: the round
 * shape closest to the scaled preview. A sphere takes the largest axis. A capsule keeps its full
 * height (rounded ends included) along the object's Y, scaled by Y, and scales its radius by the
 * larger of X and Z.
 */
export const roundShapeSize = (settings: ColliderSettings, [sx, sy, sz]: Vec3): RoundShapeSize => {
    if (settings.shape !== 'capsule') return { radius: settings.radius * Math.max(sx, sy, sz), halfHeight: 0 };
    const radius = settings.radius * Math.max(sx, sz);
    const fullHalfHeight = (capsuleHalfHeight(settings) + settings.radius) * sy;
    return { radius, halfHeight: Math.max(0, fullHalfHeight - radius) };
};

/**
 * Args for a sphere ([radius]) or capsule ([halfHeight, radius]) collider built at world scale
 * `scale`. @react-three/rapier multiplies positional args by [scale.x, scale.y], which on its own
 * would stretch a capsule's half height by X and its radius by Y, so the world size is divided by
 * those factors here.
 */
export const roundColliderArgs = (settings: ColliderSettings, scale: Vec3): number[] => {
    const { radius, halfHeight } = roundShapeSize(settings, scale);
    return settings.shape === 'capsule' ? [halfHeight / scale[0], radius / scale[1]] : [radius / scale[0]];
};

// --- OBJECT GEOMETRY ---

/** userData flag on the groups physics components add to their object, so geometry scans skip them. */
const PHYSICS_ANCHOR_FLAG = 'auvraPhysicsAnchor';
const ANCHOR_USER_DATA = { [PHYSICS_ANCHOR_FLAG]: true };
/** userData for a group of editor helpers (spline handles, lines) inside an object, which shapes built from the object's meshes leave out. */
export const PHYSICS_IGNORED_USER_DATA: Readonly<Record<string, unknown>> = ANCHOR_USER_DATA;

const isPhysicsAnchor = (node: THREE.Object3D): boolean => node.userData?.[PHYSICS_ANCHOR_FLAG] === true;

/** True for a node carrying PHYSICS_IGNORED_USER_DATA (a physics anchor or an editor helper): not part of the object's model. */
export const isPhysicsIgnored = isPhysicsAnchor;

/**
 * A nested LevelObject is not part of this object's shape, which is built from the object's own
 * model (as the editor previews it); a child collides through Colliders of its own.
 */
const isNestedObject = (node: THREE.Object3D, objectId: string): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId;
};

const hasVisibleMaterial = (mesh: THREE.Mesh): boolean => {
    const material = mesh.material;
    return Array.isArray(material) ? material.some(entry => entry.visible) : Boolean(material?.visible);
};

/**
 * The visible meshes of the object's own model under `host` (the object's transform group). Nested
 * child objects, hidden hit volumes, instanced layers and physics previews are skipped, and so is
 * anything under a node `skip` picks (a vehicle's wheels).
 */
export const collectHostMeshes = (host: THREE.Object3D, objectId: string, skip?: (node: THREE.Object3D) => boolean): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    const visit = (node: THREE.Object3D) => {
        for (const child of node.children) {
            if (!child.visible || isPhysicsAnchor(child) || isNestedObject(child, objectId) || skip?.(child)) continue;
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && !(child as THREE.InstancedMesh).isInstancedMesh
                && mesh.geometry?.getAttribute('position') && hasVisibleMaterial(mesh)) {
                meshes.push(mesh);
            }
            visit(child);
        }
    };
    visit(host);
    return meshes;
};

export interface HostGeometry {
    /** xyz triples in the host's local space (before its own scale, which the physics world applies). */
    positions: Float32Array;
    /** Triangle indices into positions. */
    indices: Uint32Array;
    /** Each triangle's surface, from its material's name; null when no name says one. */
    surfaces?: Pick<SurfaceTag, 'triangles' | 'kinds'> | null;
}

/** The materials a mesh's triangles use, in index order: one run per material group (gaps unnamed). */
const materialRuns = (mesh: THREE.Mesh, triangleCount: number): { count: number; name: string | undefined }[] => {
    const material = mesh.material;
    if (!Array.isArray(material)) return [{ count: triangleCount, name: material?.name }];
    const groups = [...mesh.geometry.groups].sort((a, b) => a.start - b.start);
    const runs: { count: number; name: string | undefined }[] = [];
    let cursor = 0;
    for (const group of groups) {
        const start = Math.min(triangleCount, Math.floor(group.start / 3));
        const end = Math.min(triangleCount, Math.floor((group.start + group.count) / 3));
        if (start > cursor) runs.push({ count: start - cursor, name: undefined });
        if (end > Math.max(start, cursor)) runs.push({ count: end - Math.max(start, cursor), name: material[group.materialIndex ?? 0]?.name });
        cursor = Math.max(cursor, end);
    }
    if (cursor < triangleCount) runs.push({ count: triangleCount - cursor, name: material[0]?.name });
    return runs;
};

/** The surface an object's model says it is: the first of its meshes' material names (or its own) that names one. */
export const hostSurface = (host: THREE.Object3D, objectId: string): SurfaceKind | null => {
    for (const mesh of collectHostMeshes(host, objectId)) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const kind = surfaceFromName(material?.name) ?? surfaceFromName(mesh.name);
            if (kind) return kind;
        }
    }
    return null;
};

/** Every mesh under `host` (but those `skip` leaves out) merged into one triangle soup in the host's local space, or null when it draws none. */
export const collectHostGeometry = (host: THREE.Object3D, objectId: string, skip?: (node: THREE.Object3D) => boolean): HostGeometry | null => {
    host.updateWorldMatrix(true, true);
    const meshes = collectHostMeshes(host, objectId, skip);
    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
        const count = mesh.geometry.getAttribute('position').count;
        vertexCount += count;
        indexCount += mesh.geometry.index ? mesh.geometry.index.count : count - (count % 3);
    }
    if (vertexCount === 0) return null;

    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const toHost = new THREE.Matrix4().copy(host.matrixWorld).invert();
    const relative = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    const runs: { count: number; name: string | undefined }[] = [];
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute('position');
        relative.multiplyMatrices(toHost, mesh.matrixWorld);
        for (let i = 0; i < position.count; i++) {
            vertex.fromBufferAttribute(position, i).applyMatrix4(relative);
            const at = (vertexOffset + i) * 3;
            positions[at] = vertex.x;
            positions[at + 1] = vertex.y;
            positions[at + 2] = vertex.z;
        }
        const index = mesh.geometry.index;
        const triangleIndexCount = index ? index.count : position.count - (position.count % 3);
        for (let i = 0; i < triangleIndexCount; i++) {
            indices[indexOffset + i] = vertexOffset + (index ? index.getX(i) : i);
        }
        runs.push(...materialRuns(mesh, Math.floor(triangleIndexCount / 3)));
        vertexOffset += position.count;
        indexOffset += triangleIndexCount;
    }
    return { positions, indices, surfaces: triangleSurfaces(runs) };
};

export type HullPlan =
    | { kind: 'hull'; points: Float32Array }
    | { kind: 'box'; halfExtents: Vec3; center: Vec3 };

/** True when the points span a volume: not all on one point, line or plane. */
const spansVolume = (points: Float32Array, tolerance: number): boolean => {
    const count = points.length / 3;
    const at = (i: number, target: THREE.Vector3) => target.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    const origin = at(0, new THREE.Vector3());
    const p = new THREE.Vector3();
    const farthest = (distance: (point: THREE.Vector3) => number): { index: number; distance: number } => {
        let best = { index: 0, distance: 0 };
        for (let i = 0; i < count; i++) {
            const d = distance(at(i, p));
            if (d > best.distance) best = { index: i, distance: d };
        }
        return best;
    };
    const first = farthest(point => point.distanceTo(origin));
    if (first.distance <= tolerance) return false;
    const axis = at(first.index, new THREE.Vector3()).sub(origin).normalize();
    const cross = new THREE.Vector3();
    const second = farthest(point => cross.subVectors(point, origin).cross(axis).length());
    if (second.distance <= tolerance) return false;
    const normal = at(second.index, new THREE.Vector3()).sub(origin).cross(axis).normalize();
    const third = farthest(point => Math.abs(cross.subVectors(point, origin).dot(normal)));
    return third.distance > tolerance;
};

/**
 * A convex hull for the points, or (when they are flat, a line or a single point, which Rapier
 * cannot hull) a box around their bounds that is at least MIN_EXTENT thick.
 */
export const planHull = (points: Float32Array): HullPlan => {
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i + 2 < points.length; i += 3) bounds.expandByPoint(point.set(points[i], points[i + 1], points[i + 2]));
    if (bounds.isEmpty()) return { kind: 'box', halfExtents: [MIN_EXTENT / 2, MIN_EXTENT / 2, MIN_EXTENT / 2], center: [0, 0, 0] };
    const size = bounds.getSize(new THREE.Vector3());
    const tolerance = Math.max(size.x, size.y, size.z) * 1e-4 + 1e-7;
    if (spansVolume(points, tolerance)) return { kind: 'hull', points };
    const center = bounds.getCenter(new THREE.Vector3());
    const half = (extent: number) => Math.max(MIN_EXTENT, extent) / 2;
    return { kind: 'box', halfExtents: [half(size.x), half(size.y), half(size.z)], center: [center.x, center.y, center.z] };
};

// --- TRIGGERS ---

export interface TriggerOverlapTracker {
    enter(otherObjectId: string): void;
    exit(otherObjectId: string): void;
}

/**
 * Turns per-collider overlap callbacks into one enter and one exit per other object, so an object
 * touching two of the trigger's colliders (or overlapping it with two of its own) enters once.
 */
export const createTriggerOverlapTracker = (triggerObjectId: string, emit: (event: TriggerEvent) => void): TriggerOverlapTracker => {
    const counts = new Map<string, number>();
    return {
        enter(otherObjectId) {
            if (otherObjectId === triggerObjectId) return;
            const count = counts.get(otherObjectId) ?? 0;
            counts.set(otherObjectId, count + 1);
            if (count === 0) emit({ kind: 'enter', triggerObjectId, otherObjectId });
        },
        exit(otherObjectId) {
            const count = counts.get(otherObjectId) ?? 0;
            if (count === 0) return;
            if (count > 1) {
                counts.set(otherObjectId, count - 1);
                return;
            }
            counts.delete(otherObjectId);
            emit({ kind: 'exit', triggerObjectId, otherObjectId });
        }
    };
};

// --- RUNTIME BODY ---

type RigidBodyState = Parameters<NonNullable<RigidBodyProps['transformState']>>[0];

/**
 * Points a body's synchronisation at the object's transform group (the host) rather than the
 * RigidBody's own empty node, so the object's model and children move with a dynamic body. Fixed
 * and kinematic bodies follow the host instead (see SimulatedBody), so their pose is never written
 * back: the 'instancedMesh' path hands it to setMatrix, which drops it.
 */
export const followHostState = (state: RigidBodyState, host: THREE.Object3D, writeBack: boolean): RigidBodyState => {
    const inverseParent = new THREE.Matrix4();
    const liveScale = new THREE.Vector3();
    const followed: RigidBodyState = {
        ...state,
        object: host,
        // Read on every sync, so a scale set during play is kept.
        get scale() {
            return host.getWorldScale(liveScale);
        },
        // Read on every sync, so a body under a moving parent object still lands where the simulation put it.
        get invertedWorldMatrix() {
            return host.parent ? inverseParent.copy(host.parent.matrixWorld).invert() : inverseParent.identity();
        }
    };
    if (!writeBack) {
        followed.meshType = 'instancedMesh';
        followed.setMatrix = () => undefined;
    }
    return followed;
};

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const POSE_EPSILON = 1e-8;
const STILL = { x: 0, y: 0, z: 0 };

type TeleportableBody = Pick<RapierRigidBody, 'translation' | 'rotation' | 'setTranslation' | 'setRotation' | 'setLinvel' | 'setAngvel'>;

/**
 * Moves a dynamic body to its object's transform group (the host) after the object's transform was
 * set (Set Actor Transform, a level reset), waking it and stopping it there. A write that only echoes
 * the body's own pose leaves it moving. Returns whether the body was moved.
 */
export const teleportBodyToHost = (body: TeleportableBody, host: THREE.Object3D): boolean => {
    host.updateWorldMatrix(true, false);
    host.matrixWorld.decompose(_position, _quaternion, _scale);
    const t = body.translation();
    const r = body.rotation();
    const distanceSquared = (t.x - _position.x) ** 2 + (t.y - _position.y) ** 2 + (t.z - _position.z) ** 2;
    const alignment = Math.abs(r.x * _quaternion.x + r.y * _quaternion.y + r.z * _quaternion.z + r.w * _quaternion.w);
    if (distanceSquared < POSE_EPSILON && alignment > 1 - POSE_EPSILON) return false;
    body.setTranslation(_position, true);
    body.setRotation(_quaternion, true);
    body.setLinvel(STILL, true);
    body.setAngvel(STILL, true);
    return true;
};

// --- COMPOUND BODIES ---

/** userData key on a body's anchor group: the registry descendants' colliders join that body through. */
const COMPOUND_BODY_KEY = 'auvraCompoundBody';

/** A collider of a descendant object, placed in the space of the body it joined. */
export interface FoldedCollider {
    /** Unique among the body's colliders: the folded object's id and its component's. */
    key: string;
    /** The object the collider belongs to; its trigger events report this id. */
    objectId: string;
    settings: ColliderSettings;
    /** The folded object's model geometry, for a mesh collider. */
    content: HostGeometry | null;
    /** Collider centre (offset included) and rotation (Euler XYZ) in the owner host's local space. */
    position: Vec3;
    rotation: Vec3;
    /** The folded object's scale relative to the owner host. */
    scale: Vec3;
}

export interface CompoundBodyRegistry {
    /** True when the body comes from a Rigid Body component. */
    rigidBody: boolean;
    type: PhysicsBodyType;
    /** Adds, replaces or (with null) removes the colliders an object folded into this body. */
    set(objectId: string, colliders: FoldedCollider[] | null): void;
}

export interface CompoundOwner {
    /** The transform group of the object whose body the colliders join. */
    host: THREE.Object3D;
    registry: CompoundBodyRegistry;
}

const compoundRegistryOf = (node: THREE.Object3D): CompoundBodyRegistry | null => {
    for (const child of node.children) {
        const registry = child.userData?.[COMPOUND_BODY_KEY] as CompoundBodyRegistry | undefined;
        if (registry && isPhysicsAnchor(child)) return registry;
    }
    return null;
};

/**
 * The body a collider-only object joins, the way child colliders shape a parent's rigid body in
 * Unity: that of the nearest ancestor object with a Rigid Body, when that body moves (dynamic or
 * kinematic). Under a fixed one, or none, the object keeps a fixed body of its own; a fixed body on
 * a moving parent would be teleported onto it every step and shove it.
 */
export const findCompoundOwner = (host: THREE.Object3D, objectId: string): CompoundOwner | null => {
    for (let node = host.parent; node; node = node.parent) {
        const id = node.userData?.levelObjectId;
        if (typeof id !== 'string' || id === objectId) continue;
        const registry = compoundRegistryOf(node);
        if (!registry?.rigidBody) continue;
        return registry.type === 'fixed' ? null : { host: node, registry };
    }
    return null;
};

/**
 * The transform of `host` in `ownerHost`'s space, written to `target`. Under the owner (where folded
 * objects sit) it is the product of the local transforms in between, so it stays exactly the same
 * while only the owner moves; elsewhere it comes from both world matrices.
 */
const relativeTransform = (ownerHost: THREE.Object3D, host: THREE.Object3D, target: THREE.Matrix4): THREE.Matrix4 => {
    host.updateWorldMatrix(true, false);
    target.identity();
    for (let node: THREE.Object3D | null = host; node; node = node.parent) {
        if (node === ownerHost) return target;
        target.premultiply(node.matrix);
    }
    ownerHost.updateWorldMatrix(true, false);
    return target.copy(ownerHost.matrixWorld).invert().multiply(host.matrixWorld);
};

/** The object's colliders placed at `relative`, the object's transform in the owner host's space. */
const foldAt = (
    relative: THREE.Matrix4,
    objectId: string,
    colliders: PhysicsBodyPlan['colliders'],
    content: HostGeometry | null
): FoldedCollider[] => {
    const translation = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    relative.decompose(translation, quaternion, scale);
    const rotation = new THREE.Euler().setFromQuaternion(quaternion);
    return colliders.map(({ id, settings }) => {
        const centre = new THREE.Vector3(...settings.offset).applyMatrix4(relative);
        return {
            key: `${objectId}/${id}`,
            objectId,
            settings,
            content: settings.shape === 'mesh' ? content : null,
            position: [centre.x, centre.y, centre.z],
            rotation: [rotation.x, rotation.y, rotation.z],
            scale: [scale.x, scale.y, scale.z]
        };
    });
};

/** The object's colliders placed in the owner host's space, as the owner's body builds them. */
export const foldColliders = (
    ownerHost: THREE.Object3D,
    host: THREE.Object3D,
    objectId: string,
    colliders: PhysicsBodyPlan['colliders'],
    content: HostGeometry | null
): FoldedCollider[] => foldAt(relativeTransform(ownerHost, host, new THREE.Matrix4()), objectId, colliders, content);

/** A collider-only object's colliders as placed in its owner's body, and where the object was then. */
export interface FoldedPlacement {
    /** The object's transform group in the owner host's space when its colliders were placed. */
    relative: THREE.Matrix4;
    colliders: FoldedCollider[];
}

const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4): boolean =>
    a.elements.every((value, index) => Math.abs(value - b.elements[index]) <= 1e-9 * Math.max(1, Math.abs(value)));

/**
 * Places the object's colliders in the owner's body (foldColliders). A scale that only differs from
 * the one in `previous` by rounding keeps its value: round shapes and collider keys are built from it,
 * so a turning object would otherwise have its colliders rebuilt on every step.
 */
export const placeFoldedColliders = (
    ownerHost: THREE.Object3D,
    host: THREE.Object3D,
    objectId: string,
    colliders: PhysicsBodyPlan['colliders'],
    content: HostGeometry | null,
    previous: FoldedPlacement | null = null
): FoldedPlacement => {
    const relative = relativeTransform(ownerHost, host, new THREE.Matrix4());
    const folded = foldAt(relative, objectId, colliders, content);
    for (const entry of folded) {
        const before = previous?.colliders.find(other => other.key === entry.key);
        if (before && sameScale(before.scale, entry.scale)) entry.scale = before.scale;
    }
    return { relative, colliders: folded };
};

const _relative = new THREE.Matrix4();

/**
 * Whether the object's transform group has moved in the owner host's space since `placement` (a Mover
 * or Rotator on the object, or an animated object in between). The owner's own motion does not count.
 */
export const foldedPlacementMoved = (placement: FoldedPlacement, ownerHost: THREE.Object3D, host: THREE.Object3D): boolean =>
    !sameMatrix(relativeTransform(ownerHost, host, _relative), placement.relative);

/**
 * Tags a collider with the object it belongs to, for a collider folded into another object's body:
 * raycasts and contacts can then report that object rather than the body's owner.
 */
export const tagColliderObject = (collider: RapierCollider, objectId: string): void => {
    (collider as RapierCollider & { userData?: unknown }).userData = physicsUserData(objectId);
};

// --- COLLIDERS ---

type ColliderCommonProps = Pick<CuboidColliderProps,
    'position' | 'rotation' | 'scale' | 'mass' | 'sensor' | 'activeCollisionTypes' | 'onIntersectionEnter' | 'onIntersectionExit'>;

interface ColliderPlacement {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
}

/** The surface a collider is tagged with: its setting, else its triangles' materials (a mesh), else the object's. */
const colliderSurface = (settings: ColliderSettings, content: HostGeometry | null, objectSurface: SurfaceKind | null): SurfaceTag | null => {
    if (settings.surface !== 'auto') return { kind: settings.surface };
    if (settings.shape === 'mesh' && content?.surfaces) return content.surfaces;
    return objectSurface ? { kind: objectSurface } : null;
};

interface ObjectColliderProps {
    settings: ColliderSettings;
    content: HostGeometry | null;
    /** The surface the object's model names, for an 'auto' collider without triangles of its own. */
    objectSurface?: SurfaceKind | null;
    /** The absolute world scale the collider is built at, which round shapes are fitted to. */
    worldScale: Vec3;
    /** Where a collider folded in from a descendant sits in the body; the body's own colliders sit at their offset. */
    placement?: ColliderPlacement;
    /** For a collider folded in from a descendant: that object, which raycast hits on it report. */
    objectId?: string;
    mass?: number;
    /** Pairs a trigger reports: the defaults plus kinematic bodies (the player, movers) against fixed ones. */
    sensorCollisionTypes: number;
    onTriggerEnter: (payload: CollisionPayload) => void;
    onTriggerExit: (payload: CollisionPayload) => void;
}

const ObjectCollider: React.FC<ObjectColliderProps> = ({ settings, content, objectSurface = null, worldScale, placement, objectId, mass, sensorCollisionTypes, onTriggerEnter, onTriggerExit }) => {
    const surface = useMemo(() => colliderSurface(settings, content, objectSurface), [settings, content, objectSurface]);
    // The binding calls a function ref with each collider it builds (again whenever it rebuilds one).
    const tag = useCallback((collider: RapierCollider | null) => {
        if (!collider) return;
        if (objectId) tagColliderObject(collider, objectId);
        tagSurface(collider as RapierCollider & { userData?: unknown }, surface);
    }, [objectId, surface]);
    const pose: Pick<ColliderCommonProps, 'position' | 'rotation' | 'scale'> = placement
        ? { position: placement.position, rotation: placement.rotation, scale: placement.scale }
        : { position: settings.offset };
    const common: ColliderCommonProps = settings.isTrigger
        ? {
            ...pose,
            mass,
            sensor: true,
            activeCollisionTypes: sensorCollisionTypes,
            onIntersectionEnter: onTriggerEnter,
            onIntersectionExit: onTriggerExit
        }
        : { ...pose, mass };
    switch (settings.shape) {
        case 'box':
            return <CuboidCollider ref={tag} args={[settings.size[0] / 2, settings.size[1] / 2, settings.size[2] / 2]} {...common} />;
        case 'sphere':
            return <BallCollider ref={tag} args={[roundColliderArgs(settings, worldScale)[0]]} {...common} />;
        case 'capsule': {
            const [halfHeight, radius] = roundColliderArgs(settings, worldScale);
            return <CapsuleCollider ref={tag} args={[halfHeight, radius]} {...common} />;
        }
        case 'mesh':
            return content ? <TrimeshCollider ref={tag} args={[content.positions, content.indices]} {...common} /> : null;
    }
};

/** The automatic shape of a rigid body without colliders: a hull around its meshes, or a unit box when it draws none. */
const HullCollider: React.FC<{ points: Float32Array | null; mass?: number }> = ({ points, mass }) => {
    const hull = useMemo(() => (points ? planHull(points) : null), [points]);
    if (!hull) return <CuboidCollider args={[0.5, 0.5, 0.5]} mass={mass} />;
    if (hull.kind === 'box') return <CuboidCollider args={hull.halfExtents} position={hull.center} mass={mass} />;
    return <ConvexHullCollider args={[hull.points]} mass={mass} />;
};

interface TriggerHandlers {
    enter: (payload: CollisionPayload) => void;
    exit: (payload: CollisionPayload) => void;
}

interface SimulatedBodyProps {
    object: LevelObject;
    plan: PhysicsBodyPlan;
    host: THREE.Object3D;
    content: HostGeometry | null;
    /** Colliders of collider-only descendant objects that joined this body. */
    folded: readonly FoldedCollider[];
}

const SimulatedBody: React.FC<SimulatedBodyProps> = ({ object, plan, host, content, folded }) => {
    const { rapier } = useRapier();
    const triggers = useTriggerEvents();
    const bodyRef = useRef<RapierRigidBody>(null);
    const lastPose = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion } | null>(null);
    const { type, gravityScale, lockRotation } = plan.body;
    const userData = useMemo(() => physicsUserData(object.id), [object.id]);
    const transformState = useCallback(
        (state: RigidBodyState) => followHostState(state, host, type === 'dynamic'),
        [host, type]
    );

    // One overlap tracker per object with trigger colliders here: this one and any folded-in descendant.
    const triggerHandlers = useMemo(() => {
        const byObject = new Map<string, TriggerHandlers>();
        return (objectId: string): TriggerHandlers => {
            const known = byObject.get(objectId);
            if (known) return known;
            const tracker = createTriggerOverlapTracker(objectId, event => triggers.emit(event));
            const handlers: TriggerHandlers = {
                enter: payload => {
                    const other = objectIdFromRigidBody(payload.other.rigidBody);
                    if (other) tracker.enter(other);
                },
                exit: payload => {
                    const other = objectIdFromRigidBody(payload.other.rigidBody);
                    if (other) tracker.exit(other);
                }
            };
            byObject.set(objectId, handlers);
            return handlers;
        };
    }, [triggers]);
    const { ActiveCollisionTypes } = rapier;
    const sensorCollisionTypes = ActiveCollisionTypes.DEFAULT | ActiveCollisionTypes.KINEMATIC_FIXED | ActiveCollisionTypes.KINEMATIC_KINEMATIC;
    // Re-read when the model's geometry is (the model can load after the body mounts).
    const objectSurface = useMemo(() => hostSurface(host, object.id), [host, object.id, content]);

    // Colliders take the host's world scale when they are built, so they are rebuilt when it changes
    // (Set Actor Transform's Scale, a scaled or animated parent); the body and its velocity stay.
    const [shapeScale, setShapeScale] = useState<Vec3>(() => absoluteScale(host.getWorldScale(new THREE.Vector3())));
    const builtScale = useRef(shapeScale);

    // A transform write moves the host only; a dynamic body is moved to it, or the next sync would
    // undo the move (and, while the body sleeps, its collider would stay behind).
    const authored = useRef({ position: object.position, rotation: object.rotation });
    useLayoutEffect(() => {
        const previous = authored.current;
        authored.current = { position: object.position, rotation: object.rotation };
        const moved = previous.position !== object.position;
        const turned = previous.rotation !== object.rotation;
        if (type !== 'dynamic' || (!moved && !turned)) return;
        // R3F skips a prop equal to the one it last applied, though the body has moved the host since.
        if (moved) host.position.fromArray(object.position);
        if (turned) host.rotation.fromArray(object.rotation);
        const body = bodyRef.current;
        if (body) teleportBodyToHost(body, host);
    }, [object.position, object.rotation, type, host]);

    // Fixed and kinematic bodies go where their object is, which movers, rotators or an animated parent may change.
    useBeforePhysicsStep(() => {
        const body = bodyRef.current;
        if (!body) return;
        host.updateWorldMatrix(true, false);
        host.matrixWorld.decompose(_position, _quaternion, _scale);
        const scale = absoluteScale(_scale);
        if (!sameScale(scale, builtScale.current)) {
            builtScale.current = scale;
            setShapeScale(scale);
        }
        if (type === 'dynamic') return;
        if (type === 'kinematicPosition') {
            body.setNextKinematicTranslation(_position);
            body.setNextKinematicRotation(_quaternion);
            return;
        }
        const last = lastPose.current;
        if (last && last.position.distanceToSquared(_position) < POSE_EPSILON && Math.abs(last.quaternion.dot(_quaternion)) > 1 - POSE_EPSILON) return;
        // Fixed bodies have no velocity, so a moved one is teleported.
        body.setTranslation(_position, true);
        body.setRotation(_quaternion, true);
        lastPose.current = { position: _position.clone(), quaternion: _quaternion.clone() };
    });

    // Folded colliders re-placed (a child turned by a Rotator, say) may now touch what a resting body would not notice.
    const placedFolded = useRef(folded);
    useEffect(() => {
        if (placedFolded.current === folded) return;
        placedFolded.current = folded;
        bodyRef.current?.wakeUp();
    }, [folded]);

    const foldedShapes = useMemo(() => folded.map(entry => entry.settings), [folded]);
    const scaleKey = shapeScale.join(',');
    const own = triggerHandlers(object.id);

    return (
        <RigidBody
            key={type}
            ref={bodyRef}
            type={type}
            colliders={false}
            gravityScale={gravityScale}
            lockRotations={lockRotation}
            userData={userData}
            transformState={transformState}
        >
            {plan.colliders.map(entry => (
                <ObjectCollider
                    key={`${entry.id}@${scaleKey}`}
                    settings={entry.settings}
                    content={content}
                    objectSurface={objectSurface}
                    worldScale={shapeScale}
                    mass={colliderMass(plan, entry.settings, foldedShapes)}
                    sensorCollisionTypes={sensorCollisionTypes}
                    onTriggerEnter={own.enter}
                    onTriggerExit={own.exit}
                />
            ))}
            {plan.autoHull && (
                <HullCollider key={scaleKey} points={content?.positions ?? null} mass={colliderMass(plan, COLLIDER_DEFAULTS, foldedShapes)} />
            )}
            {folded.map(entry => {
                const handlers = triggerHandlers(entry.objectId);
                const worldScale = multiplyScale(shapeScale, entry.scale);
                return (
                    <ObjectCollider
                        key={`${entry.key}@${worldScale.join(',')}`}
                        settings={entry.settings}
                        content={entry.content}
                        worldScale={worldScale}
                        placement={entry}
                        objectId={entry.objectId}
                        mass={colliderMass(plan, entry.settings, foldedShapes)}
                        sensorCollisionTypes={sensorCollisionTypes}
                        onTriggerEnter={handlers.enter}
                        onTriggerExit={handlers.exit}
                    />
                );
            })}
        </RigidBody>
    );
};

const NO_FOLDED: ReadonlyMap<string, readonly FoldedCollider[]> = new Map();

/**
 * The object's body. It waits one layout pass for the object's transform group (the host) and, when a
 * shape is built from the model, for the model to be attached so its meshes can be measured. A
 * collider-only object under a moving rigid body adds its colliders to that body instead.
 */
const ObjectBody: React.FC<{ object: LevelObject; plan: PhysicsBodyPlan }> = ({ object, plan }) => {
    const hostRef = useContext(ComponentHostContext);
    const anchorRef = useRef<THREE.Group>(null);
    const [host, setHost] = useState<THREE.Object3D | null>(null);
    const [content, setContent] = useState<HostGeometry | null>(null);
    const [owner, setOwner] = useState<CompoundOwner | null>(null);
    const [foldedByObject, setFoldedByObject] = useState(NO_FOLDED);
    const [registry] = useState((): CompoundBodyRegistry => ({
        rigidBody: false,
        type: 'fixed',
        set: (objectId, colliders) => setFoldedByObject(current => {
            if (!colliders && !current.has(objectId)) return current;
            const next = new Map(current);
            if (colliders) next.set(objectId, colliders);
            else next.delete(objectId);
            return next;
        })
    }));
    // Read by descendants deciding whether to join this body, in layout effects after this render.
    registry.rigidBody = plan.rigidBody;
    registry.type = plan.body.type;
    const anchorUserData = useMemo(() => ({ ...ANCHOR_USER_DATA, [COMPOUND_BODY_KEY]: registry }), [registry]);
    const folded = useMemo(() => Array.from(foldedByObject.values()).flat(), [foldedByObject]);
    const needsContent = plan.autoHull || plan.colliders.some(entry => entry.settings.shape === 'mesh');

    useLayoutEffect(() => {
        const resolved = hostRef?.current ?? anchorRef.current?.parent ?? null;
        setHost(resolved);
        setOwner(resolved && !plan.rigidBody ? findCompoundOwner(resolved, object.id) : null);
        setContent(resolved && needsContent ? collectHostGeometry(resolved, object.id, plan.vehicle ? wheelSkip(resolved, object.id) : undefined) : null);
    }, [hostRef, needsContent, object.id, plan.rigidBody, plan.vehicle]);

    return (
        <group ref={anchorRef} userData={anchorUserData}>
            {host && owner && <FoldedIntoOwner owner={owner} host={host} object={object} colliders={plan.colliders} content={content} />}
            {host && !owner && (
                <PhysicsFailureBoundary code="physics_body_failed">
                    <SimulatedBody object={object} plan={plan} host={host} content={content} folded={folded} />
                </PhysicsFailureBoundary>
            )}
        </group>
    );
};

interface FoldedIntoOwnerProps {
    owner: CompoundOwner;
    host: THREE.Object3D;
    object: LevelObject;
    colliders: PhysicsBodyPlan['colliders'];
    content: HostGeometry | null;
}

/**
 * Keeps a collider-only object's colliders in its owner's body where the object is. They are placed
 * when it mounts and when its transform is set, and again before a physics step once something else
 * has moved its transform group relative to the owner: a Mover or Rotator on the object, or an
 * animated object in between.
 */
const FoldedIntoOwner: React.FC<FoldedIntoOwnerProps> = ({ owner, host, object, colliders, content }) => {
    const placement = useRef<FoldedPlacement | null>(null);
    const { id, position, rotation, scale } = object;

    useLayoutEffect(() => {
        const placed = placeFoldedColliders(owner.host, host, id, colliders, content, placement.current);
        placement.current = placed;
        owner.registry.set(id, placed.colliders);
        return () => owner.registry.set(id, null);
    }, [owner, host, id, colliders, content, position, rotation, scale]);

    useBeforePhysicsStep(() => {
        const placed = placement.current;
        if (!placed || !foldedPlacementMoved(placed, owner.host, host)) return;
        const moved = placeFoldedColliders(owner.host, host, id, colliders, content, placed);
        placement.current = moved;
        owner.registry.set(id, moved.colliders);
    });

    return null;
};

/** Leaves out a vehicle's wheels (and nested objects' wheels) when its shape is built from its model. */
const wheelSkip = (host: THREE.Object3D, objectId: string): ((node: THREE.Object3D) => boolean) => {
    const wheels = new Set(findWheelNodes(host, node => isNestedObject(node, objectId) || isPhysicsAnchor(node)));
    return node => wheels.has(node);
};

/** Mounts the object's body from whichever of its physics components owns it, so it is built once. */
export const PhysicsOwnerBody: React.FC<{ object: LevelObject; component: LevelComponent }> = ({ object, component }) => {
    const available = usePhysicsAvailable();
    const plan = useMemo(() => planPhysicsBody(object), [object]);
    if (!available || !plan || plan.ownerId !== component.id) return null;
    return <ObjectBody object={object} plan={plan} />;
};

// --- EDITOR PREVIEWS ---

const SOLID_PREVIEW_COLOR = '#4ade80';
const TRIGGER_PREVIEW_COLOR = '#f59e0b';
const AUTO_HULL_PREVIEW_COLOR = '#60a5fa';
/** How often (in frames) a model-based preview checks whether the model changed or finished loading. */
const PREVIEW_REFRESH_FRAMES = 30;
/** Hull previews sample at most this many points; the simulated hull uses every vertex. */
const PREVIEW_HULL_POINTS = 4096;

/** Previews never take clicks or placement hits from the object they outline. */
const ignoreRaycast: THREE.Object3D['raycast'] = () => undefined;

const PreviewMaterial: React.FC<{ color: string }> = ({ color }) => (
    <meshBasicMaterial color={color} wireframe transparent opacity={0.8} depthWrite={false} toneMapped={false} />
);

const buildPreviewGeometry = (kind: 'mesh' | 'hull', content: HostGeometry): THREE.BufferGeometry | null => {
    if (kind === 'mesh') {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(content.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(content.indices, 1));
        return geometry;
    }
    const hull = planHull(content.positions);
    if (hull.kind === 'box') {
        const [hx, hy, hz] = hull.halfExtents;
        return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2).translate(...hull.center);
    }
    const count = hull.points.length / 3;
    const stride = Math.max(1, Math.ceil(count / PREVIEW_HULL_POINTS));
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < count; i += stride) points.push(new THREE.Vector3(hull.points[i * 3], hull.points[i * 3 + 1], hull.points[i * 3 + 2]));
    try {
        return new ConvexGeometry(points);
    } catch {
        return null;
    }
};

/** Wireframe of a shape built from the object's model: the triangle mesh itself, or its convex hull. */
const ContentPreview: React.FC<{ objectId: string; kind: 'mesh' | 'hull'; offset: Vec3; color: string }> = ({ objectId, kind, offset, color }) => {
    const anchorRef = useRef<THREE.Group>(null);
    const signature = useRef<string | null>(null);
    const frame = useRef(0);
    const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);

    const refresh = useCallback(() => {
        const host = anchorRef.current?.parent;
        if (!host) return;
        const next = collectHostMeshes(host, objectId).map(mesh => `${mesh.id}:${mesh.geometry.uuid}`).join('|');
        if (next === signature.current) return;
        signature.current = next;
        const content = collectHostGeometry(host, objectId);
        setGeometry(content ? buildPreviewGeometry(kind, content) : null);
    }, [objectId, kind]);

    useLayoutEffect(() => {
        signature.current = null;
        refresh();
    }, [refresh]);
    // The model can finish loading, or be swapped, after the component mounts.
    useFrame(() => {
        frame.current = (frame.current + 1) % PREVIEW_REFRESH_FRAMES;
        if (frame.current === 0) refresh();
    });
    useEffect(() => () => geometry?.dispose(), [geometry]);

    return (
        <group ref={anchorRef} userData={ANCHOR_USER_DATA}>
            {geometry && (
                <mesh geometry={geometry} position={offset} raycast={ignoreRaycast}>
                    <PreviewMaterial color={color} />
                </mesh>
            )}
        </group>
    );
};

const _previewScale = new THREE.Vector3();

/** The world scale of `ref`'s node, sampled every frame while `enabled` (gizmos rescale objects while editing). */
const usePreviewWorldScale = (ref: React.RefObject<THREE.Object3D | null>, enabled: boolean): Vec3 => {
    const [scale, setScale] = useState<Vec3>(UNIT_SCALE);
    const current = useRef(scale);
    const sample = useCallback(() => {
        const node = ref.current;
        if (!enabled || !node) return;
        const next = absoluteScale(node.getWorldScale(_previewScale));
        if (sameScale(next, current.current)) return;
        current.current = next;
        setScale(next);
    }, [ref, enabled]);
    useLayoutEffect(() => sample(), [sample]);
    useFrame(sample);
    return scale;
};

const ColliderPreview: React.FC<{ object: LevelObject; component: LevelComponent }> = ({ object, component }) => {
    const settings = resolveColliderSettings(component);
    const color = settings.isTrigger ? TRIGGER_PREVIEW_COLOR : SOLID_PREVIEW_COLOR;
    const anchorRef = useRef<THREE.Group>(null);
    const round = settings.shape === 'sphere' || settings.shape === 'capsule';
    const worldScale = usePreviewWorldScale(anchorRef, round);
    if (settings.shape === 'mesh') return <ContentPreview objectId={object.id} kind="mesh" offset={settings.offset} color={color} />;
    // Round shapes are drawn at the size play builds them (roundShapeSize), undoing the object's scale.
    const size = roundShapeSize(settings, worldScale);
    const meshScale: Vec3 = round ? [1 / worldScale[0], 1 / worldScale[1], 1 / worldScale[2]] : UNIT_SCALE;
    return (
        <group ref={anchorRef} userData={ANCHOR_USER_DATA}>
            <mesh key={settings.shape} position={settings.offset} scale={meshScale} raycast={ignoreRaycast}>
                {settings.shape === 'box' && <boxGeometry args={settings.size} />}
                {settings.shape === 'sphere' && <sphereGeometry args={[size.radius, 16, 12]} />}
                {settings.shape === 'capsule' && <capsuleGeometry args={[size.radius, size.halfHeight * 2, 4, 12]} />}
                <PreviewMaterial color={color} />
            </mesh>
        </group>
    );
};

/** A rigid body without colliders previews the hull it will get; with colliders, they preview themselves. */
const AutoHullPreview: React.FC<{ object: LevelObject; component: LevelComponent }> = ({ object, component }) => {
    const plan = useMemo(() => planPhysicsBody(object), [object]);
    if (!plan || !plan.autoHull || plan.ownerId !== component.id) return null;
    return <ContentPreview objectId={object.id} kind="hull" offset={ZERO} color={AUTO_HULL_PREVIEW_COLOR} />;
};

const ColliderRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => (
    mode === 'editor'
        ? <ColliderPreview object={object} component={component} />
        : <PhysicsOwnerBody object={object} component={component} />
);

const RigidBodyRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => (
    mode === 'editor'
        ? <AutoHullPreview object={object} component={component} />
        : <PhysicsOwnerBody object={object} component={component} />
);

// --- DEFINITIONS ---

export const PHYSICS_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'collider',
        label: 'Collider',
        description: 'Physics shape in the object\'s local space. On its own it makes the object solid scenery; with a Rigid Body it shapes the body. A trigger lets things pass and reports them entering and leaving.',
        props: [
            {
                key: 'shape', label: 'Shape', type: 'select', default: COLLIDER_DEFAULTS.shape,
                options: [
                    { label: 'Box', value: 'box' },
                    { label: 'Sphere', value: 'sphere' },
                    { label: 'Capsule', value: 'capsule' },
                    { label: 'Mesh (model surface)', value: 'mesh' }
                ]
            },
            { key: 'size', label: 'Box Size', type: 'vector3', default: COLLIDER_DEFAULTS.size, step: 0.1 },
            { key: 'radius', label: 'Radius', type: 'number', default: COLLIDER_DEFAULTS.radius, min: MIN_EXTENT, max: 1000, step: 0.05 },
            { key: 'height', label: 'Capsule Height', type: 'number', default: COLLIDER_DEFAULTS.height, min: MIN_EXTENT, max: 1000, step: 0.1 },
            { key: 'offset', label: 'Offset', type: 'vector3', default: COLLIDER_DEFAULTS.offset, step: 0.1 },
            { key: 'isTrigger', label: 'Is Trigger', type: 'boolean', default: COLLIDER_DEFAULTS.isTrigger },
            {
                key: 'surface', label: 'Surface', type: 'select', default: COLLIDER_DEFAULTS.surface,
                options: [
                    { label: 'Auto (from material names)', value: 'auto' },
                    ...SURFACE_KINDS.map(kind => ({ label: SURFACES[kind].label, value: kind })),
                ],
            }
        ],
        Render: ColliderRender
    },
    {
        type: 'rigidBody',
        label: 'Rigid Body',
        description: 'Simulates the object during play: dynamic bodies fall and collide, kinematic ones follow the object\'s motion, fixed ones stay put. Uses the object\'s Colliders, or a convex hull of its own model when it has none; child objects with only Colliders add theirs to the body.',
        props: [
            {
                key: 'type', label: 'Body Type', type: 'select', default: RIGID_BODY_DEFAULTS.type,
                options: [
                    { label: 'Fixed', value: 'fixed' },
                    { label: 'Dynamic', value: 'dynamic' },
                    { label: 'Kinematic', value: 'kinematicPosition' }
                ]
            },
            { key: 'mass', label: 'Mass (kg)', type: 'number', default: RIGID_BODY_DEFAULTS.mass, min: MIN_MASS, max: 100000, step: 0.1 },
            { key: 'gravityScale', label: 'Gravity Scale', type: 'number', default: RIGID_BODY_DEFAULTS.gravityScale, min: -10, max: 10, step: 0.1 },
            { key: 'lockRotation', label: 'Lock Rotation', type: 'boolean', default: RIGID_BODY_DEFAULTS.lockRotation }
        ],
        Render: RigidBodyRender
    }
];
