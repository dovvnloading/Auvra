import React, { Component, Suspense, createContext, useContext, useMemo } from 'react';
import * as THREE from 'three';
import { Physics, useRapier } from '@react-three/rapier';
import type { RapierCollider, RapierContext, RapierRigidBody } from '@react-three/rapier';
import { frontendDiagnostics } from '../diagnostics/runtime';

/**
 * The play session's physics world (Rapier through @react-three/rapier) and the queries gameplay
 * runs against it. Bodies carry `{ levelObjectId }` in their userData, so a collider maps back to
 * the LevelObject that owns it; the player character's body uses PLAYER_PHYSICS_ID.
 */

/** The id the player character's body reports as, in trigger events and raycast hits. */
export const PLAYER_PHYSICS_ID = 'player';

export interface PhysicsBodyUserData {
    levelObjectId: string;
}

/** userData for a RigidBody owned by `objectId` (a LevelObject id, or PLAYER_PHYSICS_ID). */
export const physicsUserData = (objectId: string): PhysicsBodyUserData => ({ levelObjectId: objectId });

/** The object id stored by physicsUserData, or null for a body that carries none. */
export const objectIdFromUserData = (userData: unknown): string | null => {
    if (!userData || typeof userData !== 'object') return null;
    const id = (userData as { levelObjectId?: unknown }).levelObjectId;
    return typeof id === 'string' && id.length > 0 ? id : null;
};

export const objectIdFromRigidBody = (body: RapierRigidBody | null | undefined): string | null =>
    body ? objectIdFromUserData(body.userData) : null;

/**
 * A collider belongs to the object it is tagged with (a child's collider folded into its parent's body
 * carries the child's id), otherwise to the object of its body; a free-standing collider to none.
 */
export const objectIdFromCollider = (collider: RapierCollider | null | undefined): string | null =>
    objectIdFromUserData((collider as { userData?: unknown } | null | undefined)?.userData) ?? objectIdFromRigidBody(collider?.parent());

export interface PhysicsRaycastHit {
    /** LevelObject id (or PLAYER_PHYSICS_ID) of the body hit; null for a collider no object owns. */
    objectId: string | null;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    /** Distance from the origin to the hit point. */
    distance: number;
}

export interface PhysicsRaycastOptions {
    /** Skip every collider of this object (e.g. the caster's own body). */
    excludeObjectId?: string;
    /** Skip every collider of these objects too (a vehicle and the player riding in it). */
    excludeObjectIds?: readonly string[];
    /** Trigger (sensor) colliders are ignored unless this is true. */
    includeTriggers?: boolean;
    /** Only fixed colliders (the level's static world): no characters, vehicles or other moving bodies. */
    fixedOnly?: boolean;
}

/** A body's simulated pose in world space. */
export interface PhysicsBodyPose {
    position: [number, number, number];
    /** Euler angles in radians, XYZ order (the order LevelObject rotations use). */
    rotation: [number, number, number];
}

export interface PhysicsQueries {
    /** First collider along the ray within maxDistance, or null. `direction` need not be normalised. */
    raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, options?: PhysicsRaycastOptions): PhysicsRaycastHit | null;
    /** Pushes the dynamic body of `objectId`; false when that object has no dynamic body. */
    applyImpulse(objectId: string, impulse: { x: number; y: number; z: number }): boolean;
    /** The live world-space pose of the dynamic body of `objectId`; null when that object has no dynamic body. */
    getBodyPose(objectId: string): PhysicsBodyPose | null;
}

/** Rays longer than this are clamped; Rapier works in 32-bit floats. */
const MAX_RAY_DISTANCE = 1e6;

type RapierWorld = RapierContext['world'];
type RapierModule = RapierContext['rapier'];

/** Queries against `world`. Split from the hook so it can be exercised without a WebGL canvas. */
export const createPhysicsQueries = (world: RapierWorld, rapier: RapierModule): PhysicsQueries => ({
    raycast(origin, direction, maxDistance, options = {}) {
        const length = direction.length();
        if (!(length > 1e-9) || !Number.isFinite(length) || !(maxDistance > 0)) return null;
        const dir = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
        const ray = new rapier.Ray({ x: origin.x, y: origin.y, z: origin.z }, dir);
        const sensors = options.includeTriggers ? 0 : rapier.QueryFilterFlags.EXCLUDE_SENSORS;
        const moving = options.fixedOnly ? rapier.QueryFilterFlags.ONLY_FIXED : 0;
        const flags = sensors | moving || undefined;
        const excluded = [...(options.excludeObjectId === undefined ? [] : [options.excludeObjectId]), ...(options.excludeObjectIds ?? [])];
        const predicate = excluded.length === 0
            ? undefined
            // Excluding an object also skips the children folded into its body.
            : (collider: RapierCollider) => {
                const own = objectIdFromCollider(collider);
                const body = objectIdFromRigidBody(collider.parent());
                return !excluded.some(id => id === own || id === body);
            };
        let hit: ReturnType<RapierWorld['castRayAndGetNormal']>;
        try {
            hit = world.castRayAndGetNormal(
                ray, Math.min(maxDistance, MAX_RAY_DISTANCE), true,
                flags, undefined, undefined, undefined, predicate
            );
        } catch (error) {
            frontendDiagnostics.failure('physics_raycast_failed', error);
            return null;
        }
        if (!hit) return null;
        const distance = hit.timeOfImpact;
        return {
            objectId: objectIdFromCollider(hit.collider),
            point: new THREE.Vector3(origin.x + dir.x * distance, origin.y + dir.y * distance, origin.z + dir.z * distance),
            normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
            distance
        };
    },
    applyImpulse(objectId, impulse) {
        let applied = false;
        world.forEachRigidBody(body => {
            if (!body.isDynamic() || objectIdFromRigidBody(body) !== objectId) return;
            body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
            applied = true;
        });
        return applied;
    },
    getBodyPose(objectId) {
        const found: { body?: RapierRigidBody } = {};
        world.forEachRigidBody(body => {
            if (!found.body && body.isDynamic() && objectIdFromRigidBody(body) === objectId) found.body = body;
        });
        if (!found.body) return null;
        const t = found.body.translation();
        const r = found.body.rotation();
        const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w), 'XYZ');
        return { position: [t.x, t.y, t.z], rotation: [euler.x, euler.y, euler.z] };
    }
});

/** Queries for code outside a physics world: nothing is ever hit and no body exists. */
const INERT_PHYSICS_QUERIES: PhysicsQueries = { raycast: () => null, applyImpulse: () => false, getBodyPose: () => null };

const PhysicsQueriesContext = createContext<PhysicsQueries | null>(null);

/** Physics queries for the surrounding PhysicsWorld; outside one (or while it failed to load) nothing is hit. */
export const usePhysicsQueries = (): PhysicsQueries => useContext(PhysicsQueriesContext) ?? INERT_PHYSICS_QUERIES;

/** True inside a running PhysicsWorld, where Rapier components and hooks may be mounted. */
export const usePhysicsAvailable = (): boolean => useContext(PhysicsQueriesContext) !== null;

const PhysicsServices: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const { world, rapier } = useRapier();
    const queries = useMemo(() => createPhysicsQueries(world, rapier), [world, rapier]);
    return React.createElement(PhysicsQueriesContext.Provider, { value: queries }, children);
};

interface PhysicsFailureBoundaryProps {
    /** Diagnostics code reported for a handled failure. */
    code: string;
    /** Rendered in place of the children once a handled failure happened. */
    fallback?: React.ReactNode;
    /** Which errors this boundary absorbs; anything else propagates to the next boundary. Defaults to all. */
    handles?: (error: unknown) => boolean;
    children?: React.ReactNode;
}

interface PhysicsFailureBoundaryState {
    error: unknown;
    handled: boolean;
}

/**
 * Keeps a physics failure local: reports it once, then renders `fallback` instead of crashing the
 * scene. Errors it does not handle, and any error thrown by the fallback, go to the next boundary up.
 */
export class PhysicsFailureBoundary extends Component<PhysicsFailureBoundaryProps, PhysicsFailureBoundaryState> {
    state: PhysicsFailureBoundaryState = { error: null, handled: false };
    private absorbed: unknown = null;

    static getDerivedStateFromError(error: unknown): Partial<PhysicsFailureBoundaryState> {
        return { error: error ?? new Error('physics failure') };
    }

    private absorbs(error: unknown): boolean {
        return !this.state.handled && (!this.props.handles || this.props.handles(error));
    }

    componentDidCatch(error: unknown) {
        if (!this.absorbs(error)) return;
        this.absorbed = error;
        frontendDiagnostics.failure(this.props.code, error);
        this.setState({ handled: true });
    }

    render() {
        const { error, handled } = this.state;
        if (error === null) return this.props.children ?? null;
        if (handled ? error !== this.absorbed : !this.absorbs(error)) throw error;
        return handled ? (this.props.fallback ?? null) : null;
    }
}

/** Rapier ships as WebAssembly; a page that cannot compile it (CSP, old engine) plays on without physics. */
export const isPhysicsEngineLoadError = (error: unknown): boolean => {
    if (typeof WebAssembly !== 'undefined' && (error instanceof WebAssembly.CompileError
        || error instanceof WebAssembly.LinkError || error instanceof WebAssembly.RuntimeError)) return true;
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /webassembly|\bwasm\b/i.test(text);
};

const GRAVITY: [number, number, number] = [0, -9.81, 0];

export interface PhysicsWorldProps {
    children?: React.ReactNode;
    /** Freezes the simulation (pause menu, game over); bodies keep their state. */
    paused?: boolean;
    /** Draws every collider as Rapier debug lines. */
    debug?: boolean;
}

/**
 * The physics world of a play session. Children render once Rapier has loaded; if it cannot load
 * they render without physics (bodies are skipped, queries hit nothing) and the failure is reported.
 */
export const PhysicsWorld: React.FC<PhysicsWorldProps> = ({ children, paused = false, debug = false }) =>
    React.createElement(
        PhysicsFailureBoundary,
        { code: 'physics_engine_unavailable', handles: isPhysicsEngineLoadError, fallback: children },
        React.createElement(
            Suspense,
            { fallback: null },
            React.createElement(Physics, {
                gravity: GRAVITY,
                paused,
                debug,
                children: React.createElement(PhysicsServices, null, children)
            })
        )
    );
