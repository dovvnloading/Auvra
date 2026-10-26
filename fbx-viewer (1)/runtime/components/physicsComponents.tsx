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
import type { CollisionPayload, CuboidColliderProps, RapierRigidBody, RigidBodyProps } from '@react-three/rapier';
import type { LevelComponent, LevelObject } from '../../types';
import { PhysicsFailureBoundary, objectIdFromRigidBody, physicsUserData, usePhysicsAvailable } from '../physics';
import { useTriggerEvents } from '../triggers';
import type { TriggerEvent } from '../triggers';
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
}

export interface RigidBodySettings {
    type: PhysicsBodyType;
    mass: number;
    gravityScale: number;
    lockRotation: boolean;
}

const COLLIDER_DEFAULTS: ColliderSettings = { shape: 'box', size: [1, 1, 1], radius: 0.5, height: 2, offset: [0, 0, 0], isTrigger: false };
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
        isTrigger: readBoolean(component, 'isTrigger', COLLIDER_DEFAULTS.isTrigger)
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
    /** The component whose Render mounts the body: the first enabled rigidBody, else the first enabled collider. */
    ownerId: string;
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
    const colliders = enabled.filter(component => component.type === 'collider');
    const owner = rigidBody ?? colliders[0];
    if (!owner) return null;
    return {
        ownerId: owner.id,
        body: rigidBody ? resolveRigidBodySettings(rigidBody) : { ...RIGID_BODY_DEFAULTS, type: 'fixed' },
        colliders: colliders.map(component => ({ id: component.id, settings: resolveColliderSettings(component) })),
        autoHull: Boolean(rigidBody) && colliders.length === 0
    };
};

/**
 * The mass one collider gives its body. A dynamic body's mass is shared by its solid colliders, so
 * triggers add none (unless every collider is a trigger); other body types take no mass.
 */
export const colliderMass = (plan: PhysicsBodyPlan, settings: ColliderSettings): number | undefined => {
    if (plan.body.type !== 'dynamic') return undefined;
    const solid = plan.colliders.filter(entry => !entry.settings.isTrigger).length;
    if (solid === 0) return plan.body.mass / Math.max(1, plan.colliders.length);
    return settings.isTrigger ? 0 : plan.body.mass / solid;
};

// --- OBJECT GEOMETRY ---

/** userData flag on the groups physics components add to their object, so geometry scans skip them. */
const PHYSICS_ANCHOR_FLAG = 'auvraPhysicsAnchor';
const ANCHOR_USER_DATA = { [PHYSICS_ANCHOR_FLAG]: true };

const isPhysicsAnchor = (node: THREE.Object3D): boolean => node.userData?.[PHYSICS_ANCHOR_FLAG] === true;

/** A nested LevelObject with physics of its own is simulated separately, so it is not part of this object's shape. */
const isSeparateBody = (node: THREE.Object3D, objectId: string): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId && node.children.some(isPhysicsAnchor);
};

const hasVisibleMaterial = (mesh: THREE.Mesh): boolean => {
    const material = mesh.material;
    return Array.isArray(material) ? material.some(entry => entry.visible) : Boolean(material?.visible);
};

/**
 * The visible meshes drawn under `host` (the object's transform group): its model and any child
 * objects without physics of their own. Hidden hit volumes, instanced layers and physics previews are skipped.
 */
export const collectHostMeshes = (host: THREE.Object3D, objectId: string): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    const visit = (node: THREE.Object3D) => {
        for (const child of node.children) {
            if (!child.visible || isPhysicsAnchor(child) || isSeparateBody(child, objectId)) continue;
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
}

/** Every mesh under `host` merged into one triangle soup in the host's local space, or null when it draws none. */
export const collectHostGeometry = (host: THREE.Object3D, objectId: string): HostGeometry | null => {
    host.updateWorldMatrix(true, true);
    const meshes = collectHostMeshes(host, objectId);
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
        vertexOffset += position.count;
        indexOffset += triangleIndexCount;
    }
    return { positions, indices };
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
    const followed: RigidBodyState = {
        ...state,
        object: host,
        scale: host.getWorldScale(new THREE.Vector3()),
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

type ColliderCommonProps = Pick<CuboidColliderProps,
    'position' | 'mass' | 'sensor' | 'activeCollisionTypes' | 'onIntersectionEnter' | 'onIntersectionExit'>;

interface ObjectColliderProps {
    settings: ColliderSettings;
    content: HostGeometry | null;
    mass?: number;
    /** Pairs a trigger reports: the defaults plus kinematic bodies (the player, movers) against fixed ones. */
    sensorCollisionTypes: number;
    onTriggerEnter: (payload: CollisionPayload) => void;
    onTriggerExit: (payload: CollisionPayload) => void;
}

const ObjectCollider: React.FC<ObjectColliderProps> = ({ settings, content, mass, sensorCollisionTypes, onTriggerEnter, onTriggerExit }) => {
    const common: ColliderCommonProps = settings.isTrigger
        ? {
            position: settings.offset,
            mass,
            sensor: true,
            activeCollisionTypes: sensorCollisionTypes,
            onIntersectionEnter: onTriggerEnter,
            onIntersectionExit: onTriggerExit
        }
        : { position: settings.offset, mass };
    switch (settings.shape) {
        case 'box':
            return <CuboidCollider args={[settings.size[0] / 2, settings.size[1] / 2, settings.size[2] / 2]} {...common} />;
        case 'sphere':
            return <BallCollider args={[settings.radius]} {...common} />;
        case 'capsule':
            return <CapsuleCollider args={[capsuleHalfHeight(settings), settings.radius]} {...common} />;
        case 'mesh':
            return content ? <TrimeshCollider args={[content.positions, content.indices]} {...common} /> : null;
    }
};

/** The automatic shape of a rigid body without colliders: a hull around its meshes, or a unit box when it draws none. */
const HullCollider: React.FC<{ points: Float32Array | null; mass?: number }> = ({ points, mass }) => {
    const hull = useMemo(() => (points ? planHull(points) : null), [points]);
    if (!hull) return <CuboidCollider args={[0.5, 0.5, 0.5]} mass={mass} />;
    if (hull.kind === 'box') return <CuboidCollider args={hull.halfExtents} position={hull.center} mass={mass} />;
    return <ConvexHullCollider args={[hull.points]} mass={mass} />;
};

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const POSE_EPSILON = 1e-8;

interface SimulatedBodyProps {
    object: LevelObject;
    plan: PhysicsBodyPlan;
    host: THREE.Object3D;
    content: HostGeometry | null;
}

const SimulatedBody: React.FC<SimulatedBodyProps> = ({ object, plan, host, content }) => {
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

    const tracker = useMemo(
        () => createTriggerOverlapTracker(object.id, event => triggers.emit(event)),
        [object.id, triggers]
    );
    const onTriggerEnter = useCallback((payload: CollisionPayload) => {
        const other = objectIdFromRigidBody(payload.other.rigidBody);
        if (other) tracker.enter(other);
    }, [tracker]);
    const onTriggerExit = useCallback((payload: CollisionPayload) => {
        const other = objectIdFromRigidBody(payload.other.rigidBody);
        if (other) tracker.exit(other);
    }, [tracker]);
    const { ActiveCollisionTypes } = rapier;
    const sensorCollisionTypes = ActiveCollisionTypes.DEFAULT | ActiveCollisionTypes.KINEMATIC_FIXED | ActiveCollisionTypes.KINEMATIC_KINEMATIC;

    // Fixed and kinematic bodies go where their object is, which movers, rotators or an animated parent may change.
    useBeforePhysicsStep(() => {
        const body = bodyRef.current;
        if (!body || type === 'dynamic') return;
        host.updateWorldMatrix(true, false);
        host.matrixWorld.decompose(_position, _quaternion, _scale);
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
                    key={entry.id}
                    settings={entry.settings}
                    content={content}
                    mass={colliderMass(plan, entry.settings)}
                    sensorCollisionTypes={sensorCollisionTypes}
                    onTriggerEnter={onTriggerEnter}
                    onTriggerExit={onTriggerExit}
                />
            ))}
            {plan.autoHull && <HullCollider points={content?.positions ?? null} mass={type === 'dynamic' ? plan.body.mass : undefined} />}
        </RigidBody>
    );
};

/**
 * The object's body. It waits one layout pass for the object's transform group (the host) and, when a
 * shape is built from the model, for the model to be attached so its meshes can be measured.
 */
const ObjectBody: React.FC<{ object: LevelObject; plan: PhysicsBodyPlan }> = ({ object, plan }) => {
    const hostRef = useContext(ComponentHostContext);
    const anchorRef = useRef<THREE.Group>(null);
    const [host, setHost] = useState<THREE.Object3D | null>(null);
    const [content, setContent] = useState<HostGeometry | null>(null);
    const needsContent = plan.autoHull || plan.colliders.some(entry => entry.settings.shape === 'mesh');

    useLayoutEffect(() => {
        const resolved = hostRef?.current ?? anchorRef.current?.parent ?? null;
        setHost(resolved);
        setContent(resolved && needsContent ? collectHostGeometry(resolved, object.id) : null);
    }, [hostRef, needsContent, object.id]);

    return (
        <group ref={anchorRef} userData={ANCHOR_USER_DATA}>
            {host && (
                <PhysicsFailureBoundary code="physics_body_failed">
                    <SimulatedBody object={object} plan={plan} host={host} content={content} />
                </PhysicsFailureBoundary>
            )}
        </group>
    );
};

/** Mounts the object's body from whichever of its physics components owns it, so it is built once. */
const PhysicsOwnerBody: React.FC<{ object: LevelObject; component: LevelComponent }> = ({ object, component }) => {
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

const ColliderPreview: React.FC<{ object: LevelObject; component: LevelComponent }> = ({ object, component }) => {
    const settings = resolveColliderSettings(component);
    const color = settings.isTrigger ? TRIGGER_PREVIEW_COLOR : SOLID_PREVIEW_COLOR;
    if (settings.shape === 'mesh') return <ContentPreview objectId={object.id} kind="mesh" offset={settings.offset} color={color} />;
    return (
        <group userData={ANCHOR_USER_DATA}>
            <mesh key={settings.shape} position={settings.offset} raycast={ignoreRaycast}>
                {settings.shape === 'box' && <boxGeometry args={settings.size} />}
                {settings.shape === 'sphere' && <sphereGeometry args={[settings.radius, 16, 12]} />}
                {settings.shape === 'capsule' && <capsuleGeometry args={[settings.radius, capsuleHalfHeight(settings) * 2, 4, 12]} />}
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
            { key: 'isTrigger', label: 'Is Trigger', type: 'boolean', default: COLLIDER_DEFAULTS.isTrigger }
        ],
        Render: ColliderRender
    },
    {
        type: 'rigidBody',
        label: 'Rigid Body',
        description: 'Simulates the object during play: dynamic bodies fall and collide, kinematic ones follow the object\'s motion, fixed ones stay put. Uses the object\'s Colliders, or a convex hull of its model when it has none.',
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
