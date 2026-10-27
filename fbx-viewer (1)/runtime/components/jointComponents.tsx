import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import type { RapierCollider, RapierContext, RapierRigidBody } from '@react-three/rapier';
import type { LevelComponent } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { PhysicsFailureBoundary, objectIdFromRigidBody, objectIdFromUserData, usePhysicsAvailable } from '../physics';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * Physics joints: a Physics Joint component links its object's rigid body to another object's body,
 * or pins it to the world, while the level plays. Rapier's first body is the connected one (or the
 * world anchor) and its second this object's, so limits measure how this object turns or slides.
 */

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type RapierWorld = RapierContext['world'];
type RapierModule = RapierContext['rapier'];
type RapierImpulseJoint = ReturnType<RapierWorld['createImpulseJoint']>;
type RapierUnitJoint = InstanceType<RapierModule['UnitImpulseJoint']>;
type RapierJointData = ReturnType<RapierModule['JointData']['spherical']>;

/** Fixed welds, spherical turns freely about the anchor, revolute hinges about the axis, prismatic slides along it. */
export type JointKind = 'fixed' | 'spherical' | 'revolute' | 'prismatic';

const JOINT_KINDS: readonly JointKind[] = ['fixed', 'spherical', 'revolute', 'prismatic'];

/** A joint component's props, resolved (see resolveJointSettings). */
export interface JointSettings {
    kind: JointKind;
    /** Level object id of the body this one is joined to; empty pins it to the world at its anchor. */
    connectedObjectId: string;
    /** The joint point in this object's local space (its scale included). */
    anchor: Vec3;
    /** The joint point in the connected object's local space; unused on a world anchor. */
    connectedAnchor: Vec3;
    /** Hinge (revolute) or slide (prismatic) direction in this object's local space; any length. */
    axis: Vec3;
    limitsEnabled: boolean;
    /** Lower limit: degrees for a revolute joint, metres for a prismatic one. Never above limitMax. */
    limitMin: number;
    limitMax: number;
    /** Newtons the joint carries before it breaks; 0 never breaks. */
    breakForce: number;
}

const JOINT_DEFAULTS: JointSettings = {
    kind: 'spherical',
    connectedObjectId: '',
    anchor: [0, 0, 0],
    connectedAnchor: [0, 0, 0],
    axis: [0, 1, 0],
    limitsEnabled: false,
    limitMin: -45,
    limitMax: 45,
    breakForce: 0
};

const ORIGIN: Vec3 = [0, 0, 0];
const IDENTITY: Quat = [0, 0, 0, 1];
/** An axis shorter than this has no direction; the default up axis is used instead. */
const MIN_AXIS_LENGTH = 1e-9;

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

/** A joint component's props, with missing or invalid values at their defaults, the limits in order and the break force not negative. */
export const resolveJointSettings = (component: LevelComponent): JointSettings => {
    const first = readNumber(component, 'limitMin', JOINT_DEFAULTS.limitMin);
    const second = readNumber(component, 'limitMax', JOINT_DEFAULTS.limitMax);
    const connected = component.props.connectedObjectId;
    return {
        kind: readChoice(component, 'kind', JOINT_KINDS, JOINT_DEFAULTS.kind),
        connectedObjectId: typeof connected === 'string' ? connected.trim() : JOINT_DEFAULTS.connectedObjectId,
        anchor: readVector3(component, 'anchor', JOINT_DEFAULTS.anchor),
        connectedAnchor: readVector3(component, 'connectedAnchor', JOINT_DEFAULTS.connectedAnchor),
        axis: readVector3(component, 'axis', JOINT_DEFAULTS.axis),
        limitsEnabled: readBoolean(component, 'limitsEnabled', JOINT_DEFAULTS.limitsEnabled),
        limitMin: Math.min(first, second),
        limitMax: Math.max(first, second),
        breakForce: Math.max(0, readNumber(component, 'breakForce', JOINT_DEFAULTS.breakForce))
    };
};

// --- RAPIER JOINT DATA ---

/** Where a joint sits on its two bodies, each in that body's local space. */
export interface JointPlacement {
    /** The joint point on the connected body; on a world anchor, the origin of the anchor body made there. */
    connectedAnchor: Vec3;
    /** The joint point on this object's body. */
    anchor: Vec3;
    /** The hinge or slide direction on this object's body; any length. */
    axis: Vec3;
    /** This body's rotation relative to the connected body's when the joint formed, [x, y, z, w]. */
    relativeRotation: Quat;
}

/** The placement the settings give on their own: bodies in their objects' frames, the connected one turned like this one. */
const settingsPlacement = (settings: JointSettings): JointPlacement => ({
    connectedAnchor: settings.connectedObjectId ? settings.connectedAnchor : ORIGIN,
    anchor: settings.anchor,
    axis: settings.axis,
    relativeRotation: IDENTITY
});

interface RapierVector {
    x: number;
    y: number;
    z: number;
}

interface RapierRotation {
    x: number;
    y: number;
    z: number;
    w: number;
}

/** What Rapier's JointData is built from. Body 1 is the connected body (or world anchor), body 2 this object's. */
export interface JointDataParams {
    kind: JointKind;
    /** Joint point on the connected body, in its local space. */
    anchor1: RapierVector;
    /** Joint point on this object's body, in its local space. */
    anchor2: RapierVector;
    /** Fixed joints: the joint frame on the connected body, which keeps this body turned as it was when the joint formed. */
    frame1: RapierRotation;
    /** Fixed joints: the joint frame on this object's body (always identity). */
    frame2: RapierRotation;
    /** Unit hinge or slide axis; Rapier uses it in both bodies' local spaces. */
    axis: RapierVector;
    /** [min, max] in radians (revolute, within a half turn each way) or metres (prismatic) when limits apply; null otherwise. */
    limits: [number, number] | null;
}

const toVector = ([x, y, z]: Vec3): RapierVector => ({ x, y, z });

/**
 * The settings as Rapier takes them, at `placement` (by default the settings' own anchors and axis,
 * with the connected body turned like this one): the axis normalised (the default up axis when it has
 * no length), revolute limits in radians, and limits only for the joint kinds that have them.
 */
export const jointDataParams = (settings: JointSettings, placement: JointPlacement = settingsPlacement(settings)): JointDataParams => {
    const [ax, ay, az] = placement.axis;
    const axisLength = Math.hypot(ax, ay, az);
    const axis = axisLength > MIN_AXIS_LENGTH ? { x: ax / axisLength, y: ay / axisLength, z: az / axisLength } : toVector(JOINT_DEFAULTS.axis);
    const [qx, qy, qz, qw] = placement.relativeRotation;
    const rotationLength = Math.hypot(qx, qy, qz, qw);
    const frame1 = rotationLength > 0
        ? { x: qx / rotationLength, y: qy / rotationLength, z: qz / rotationLength, w: qw / rotationLength }
        : { x: 0, y: 0, z: 0, w: 1 };
    const angle = (degrees: number) => THREE.MathUtils.clamp(THREE.MathUtils.degToRad(degrees), -Math.PI, Math.PI);
    let limits: [number, number] | null = null;
    if (settings.limitsEnabled && settings.kind === 'revolute') limits = [angle(settings.limitMin), angle(settings.limitMax)];
    if (settings.limitsEnabled && settings.kind === 'prismatic') limits = [settings.limitMin, settings.limitMax];
    return {
        kind: settings.kind,
        anchor1: toVector(placement.connectedAnchor),
        anchor2: toVector(placement.anchor),
        frame1,
        frame2: { x: 0, y: 0, z: 0, w: 1 },
        axis,
        limits
    };
};

/** Rapier's JointData for the params; a prismatic joint's limits are part of it. */
export const createJointData = (rapier: RapierModule, params: JointDataParams): RapierJointData => {
    const { JointData } = rapier;
    switch (params.kind) {
        case 'fixed':
            return JointData.fixed(params.anchor1, params.frame1, params.anchor2, params.frame2);
        case 'spherical':
            return JointData.spherical(params.anchor1, params.anchor2);
        case 'revolute':
            return JointData.revolute(params.anchor1, params.anchor2, params.axis);
        case 'prismatic': {
            const data = JointData.prismatic(params.anchor1, params.anchor2, params.axis);
            if (params.limits) {
                data.limitsEnabled = true;
                data.limits = [params.limits[0], params.limits[1]];
            }
            return data;
        }
    }
};

const isUnitJoint = (joint: RapierImpulseJoint): joint is RapierUnitJoint =>
    typeof (joint as Partial<RapierUnitJoint>).setLimits === 'function';

/**
 * Creates the impulse joint between `connectedBody` (Rapier's first body) and `body`, with its limits.
 * The two bodies stop colliding with each other, as a door does with its frame.
 */
export const createRapierJoint = (
    world: RapierWorld,
    rapier: RapierModule,
    params: JointDataParams,
    connectedBody: RapierRigidBody,
    body: RapierRigidBody
): RapierImpulseJoint => {
    const joint = world.createImpulseJoint(createJointData(rapier, params), connectedBody, body, true);
    joint.setContactsEnabled(false);
    if (params.kind === 'revolute' && params.limits && isUnitJoint(joint)) joint.setLimits(params.limits[0], params.limits[1]);
    return joint;
};

// --- FINDING THE BODIES ---

/**
 * The rigid body simulating a level object: its own (tagged by physicsUserData), else the body its
 * colliders were folded into (a collider-only child of a moving rigid body). Null until one exists.
 */
export const findObjectBody = (world: RapierWorld, objectId: string): RapierRigidBody | null => {
    const found: { body?: RapierRigidBody } = {};
    world.forEachRigidBody(body => {
        if (!found.body && objectIdFromRigidBody(body) === objectId) found.body = body;
    });
    if (found.body) return found.body;
    world.forEachCollider(collider => {
        if (found.body || objectIdFromUserData((collider as RapierCollider & { userData?: unknown }).userData) !== objectId) return;
        found.body = collider.parent() ?? undefined;
    });
    return found.body ?? null;
};

/** The transform group LevelRuntime draws `objectId` as, or null. */
const findLevelGroup = (root: THREE.Object3D, objectId: string): THREE.Object3D | null => {
    const pending: THREE.Object3D[] = [root];
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (node.userData?.levelObjectId === objectId) return node;
        pending.push(...node.children);
    }
    return null;
};

const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _ownerRotation = new THREE.Quaternion();
const _objectRotation = new THREE.Quaternion();
const UNIT = new THREE.Vector3(1, 1, 1);

interface BodySpace {
    point(local: Vec3): Vec3;
    direction(local: Vec3): Vec3;
}

const SAME_SPACE: BodySpace = { point: local => local, direction: local => local };

/**
 * Maps points and directions in `objectId`'s local space onto `body`, the body simulating it, whose
 * frame is its owner object's transform group without scale. Points take the object's scale; directions
 * only turn. An object with no transform group in `root` (the player) is taken to be in its body's space.
 */
const objectToBodySpace = (root: THREE.Object3D | null, objectId: string, body: RapierRigidBody): BodySpace => {
    const group = root ? findLevelGroup(root, objectId) : null;
    const ownerId = objectIdFromRigidBody(body);
    const owner = !root || !group || !ownerId ? null : ownerId === objectId ? group : findLevelGroup(root, ownerId);
    if (!group || !owner) return SAME_SPACE;
    owner.updateWorldMatrix(true, false);
    group.updateWorldMatrix(true, false);
    owner.matrixWorld.decompose(_position, _ownerRotation, _scale);
    const toBody = new THREE.Matrix4().compose(_position, _ownerRotation, UNIT).invert().multiply(group.matrixWorld);
    group.matrixWorld.decompose(_position, _objectRotation, _scale);
    const turn = _ownerRotation.clone().invert().multiply(_objectRotation);
    return {
        point: ([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(toBody).toArray() as Vec3,
        direction: ([x, y, z]) => new THREE.Vector3(x, y, z).applyQuaternion(turn).toArray() as Vec3
    };
};

const bodyRotation = (body: RapierRigidBody): THREE.Quaternion => {
    const r = body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
};

// --- CONNECTING ---

/** The world pose a world-anchored joint pins its object to. */
export interface JointPivot {
    position: Vec3;
    /** [x, y, z, w]; the object's rotation when the joint first formed, the rest pose of its limits. */
    rotation: Quat;
}

/** A formed joint and the bodies it holds. */
export interface JointLink {
    joint: RapierImpulseJoint;
    /** The connected object's body, or the fixed body made for a world anchor. */
    connectedBody: RapierRigidBody;
    body: RapierRigidBody;
    /** The fixed body made at a world anchor, removed with the joint; null when joined to an object. */
    anchorBody: RapierRigidBody | null;
    /** Where a world anchor pins the object, so a joint formed again (after its body was rebuilt) pins the same spot. */
    pivot: JointPivot | null;
}

/** What connectJoint did: formed the joint, is waiting for a body, or found both ends on one body. */
export type JointConnection =
    | { status: 'waiting' }
    | { status: 'sameBody' }
    | { status: 'connected'; link: JointLink };

const WAITING: JointConnection = { status: 'waiting' };
const SAME_BODY: JointConnection = { status: 'sameBody' };

/**
 * Joins `objectId`'s body as `settings` say: 'waiting' while either body does not exist yet, 'sameBody'
 * when both ends are one body (an object joined to itself, or to the parent its colliders were folded
 * into). Anchors are placed through the objects' transform groups under `root`. A world anchor gets a
 * fixed body at `pivot` (by default where the object's anchor is now, turned as the object is).
 */
export const connectJoint = (
    world: RapierWorld,
    rapier: RapierModule,
    objectId: string,
    settings: JointSettings,
    root: THREE.Object3D | null,
    pivot: JointPivot | null = null
): JointConnection => {
    const body = findObjectBody(world, objectId);
    if (!body) return WAITING;
    const connectedId = settings.connectedObjectId;
    const target = connectedId ? findObjectBody(world, connectedId) : null;
    if (connectedId && !target) return WAITING;
    if (target && target.handle === body.handle) return SAME_BODY;

    const own = objectToBodySpace(root, objectId, body);
    const anchor = own.point(settings.anchor);
    const rotation = bodyRotation(body);
    let connectedBody: RapierRigidBody;
    let connectedAnchor: Vec3;
    let connectedRotation: THREE.Quaternion;
    let anchorBody: RapierRigidBody | null = null;
    let kept: JointPivot | null = null;
    if (target) {
        connectedBody = target;
        connectedAnchor = objectToBodySpace(root, connectedId, target).point(settings.connectedAnchor);
        connectedRotation = bodyRotation(target);
    } else {
        const t = body.translation();
        const at = new THREE.Vector3(...anchor).applyQuaternion(rotation).add(_position.set(t.x, t.y, t.z));
        kept = pivot ?? { position: [at.x, at.y, at.z], rotation: rotation.toArray() as Quat };
        const [px, py, pz] = kept.position;
        const [qx, qy, qz, qw] = kept.rotation;
        anchorBody = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(px, py, pz).setRotation({ x: qx, y: qy, z: qz, w: qw }));
        connectedBody = anchorBody;
        connectedAnchor = ORIGIN;
        connectedRotation = new THREE.Quaternion(qx, qy, qz, qw);
    }
    const relativeRotation = connectedRotation.invert().multiply(rotation).toArray() as Quat;
    const params = jointDataParams(settings, { connectedAnchor, anchor, axis: own.direction(settings.axis), relativeRotation });
    let joint: RapierImpulseJoint;
    try {
        joint = createRapierJoint(world, rapier, params, connectedBody, body);
    } catch (error) {
        if (anchorBody) world.removeRigidBody(anchorBody);
        throw error;
    }
    return { status: 'connected', link: { joint, connectedBody, body, anchorBody, pivot: kept } };
};

/** True while the link's joint and bodies are all still in the world (rebuilding a body drops its joints). */
export const jointIntact = (world: RapierWorld, link: JointLink): boolean =>
    world.getImpulseJoint(link.joint.handle) === link.joint
    && world.getRigidBody(link.body.handle) === link.body
    && world.getRigidBody(link.connectedBody.handle) === link.connectedBody;

/** Removes the link's joint and the anchor body made for it, whichever are still in the world. */
export const releaseJoint = (world: RapierWorld, link: JointLink): void => {
    if (world.getImpulseJoint(link.joint.handle) === link.joint) world.removeImpulseJoint(link.joint, true);
    if (link.anchorBody && world.getRigidBody(link.anchorBody.handle) === link.anchorBody) world.removeRigidBody(link.anchorBody);
};

// --- BREAKING ---

/** One joint of a world, by the handles of its two bodies. */
export interface JointLoadEdge {
    body1: number;
    body2: number;
}

const addInto = (target: Vec3, [x, y, z]: Vec3, scale = 1): void => {
    target[0] += x * scale;
    target[1] += y * scale;
    target[2] += z * scale;
};

const vectorLength = ([x, y, z]: Vec3): number => Math.hypot(x, y, z);

/**
 * The linear impulse each joint carried over one step. `residual` gives, per body, the impulse its
 * joints gave it: its momentum change less what gravity, applied forces and contacts gave it; null for
 * a fixed or kinematic body, which holds whatever its joints ask. Rapier does not report joint impulses,
 * so they come from momentum balance: a joint that alone links a free part (dynamic bodies held by
 * nothing else) to the rest carries that part's whole residual. Joints that share a load (a plank held at
 * both ends, a loop) split what their body has left after its other joints equally.
 */
export const estimateJointLoads = (edges: readonly JointLoadEdge[], residual: (body: number) => Vec3 | null): number[] => {
    const residuals = new Map<number, Vec3 | null>();
    const residualOf = (body: number): Vec3 | null => {
        if (!residuals.has(body)) residuals.set(body, residual(body));
        return residuals.get(body) ?? null;
    };
    const links = new Map<number, number[]>();
    edges.forEach((edge, index) => {
        if (edge.body1 === edge.body2) return;
        for (const body of [edge.body1, edge.body2]) {
            const list = links.get(body);
            if (list) list.push(index);
            else links.set(body, [index]);
        }
    });

    /** The summed residual of the bodies `start` reaches without edge `skip`; null when that part is held or reaches `stop`. */
    const freePart = (skip: number, start: number, stop: number): Vec3 | null => {
        const sum: Vec3 = [0, 0, 0];
        const seen = new Set([start]);
        const pending = [start];
        for (let body = pending.pop(); body !== undefined; body = pending.pop()) {
            const own = residualOf(body);
            if (!own) return null;
            addInto(sum, own);
            for (const index of links.get(body) ?? []) {
                if (index === skip) continue;
                const edge = edges[index];
                const next = edge.body1 === body ? edge.body2 : edge.body1;
                if (next === stop) return null;
                if (seen.has(next)) continue;
                seen.add(next);
                pending.push(next);
            }
        }
        return sum;
    };

    // The impulse a joint gives its second body, where momentum balance alone settles it.
    const toBody2 = edges.map((edge, index): Vec3 | null => {
        if (edge.body1 === edge.body2) return [0, 0, 0];
        const second = freePart(index, edge.body2, edge.body1);
        if (second) return second;
        const first = freePart(index, edge.body1, edge.body2);
        return first ? [-first[0], -first[1], -first[2]] : null;
    });

    /** What `body`'s shared joints each carry: its residual less its settled joints, split between them. */
    const shareAt = (body: number): number => {
        const own = residualOf(body);
        if (!own) return 0;
        const left: Vec3 = [own[0], own[1], own[2]];
        let sharing = 0;
        for (const index of links.get(body) ?? []) {
            const given = toBody2[index];
            if (given) addInto(left, given, edges[index].body2 === body ? -1 : 1);
            else sharing += 1;
        }
        return sharing > 0 ? vectorLength(left) / sharing : 0;
    };

    return edges.map((edge, index) => {
        const given = toBody2[index];
        return given ? vectorLength(given) : Math.max(shareAt(edge.body1), shareAt(edge.body2));
    });
};

const contactPairKey = (collider: number, other: number): string => `${collider}:${other}`;

/**
 * The normal impulse one step's contacts gave `body` (Rapier reports no friction direction, so friction
 * stays in the body's residual). The impulse Rapier reports for a touching pair also holds the warm start
 * it carried over from the step before, about that step's impulse over the solver's substeps; that is
 * taken off using `previous` (each pair's impulse last step), and this step's go into `next`.
 */
const contactImpulseOn = (
    world: RapierWorld,
    body: RapierRigidBody,
    substeps: number,
    previous: ReadonlyMap<string, number>,
    next: Map<string, number>
): Vec3 => {
    const total: Vec3 = [0, 0, 0];
    for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i);
        world.contactPairsWith(collider, other => {
            const pair: Vec3 = [0, 0, 0];
            let reported = 0;
            world.contactPair(collider, other, (manifold, flipped) => {
                let impulse = 0;
                for (let k = 0; k < manifold.numContacts(); k++) impulse += manifold.contactImpulse(k);
                if (!(impulse > 0)) return;
                // The normal points from the manifold's first collider to its second; `collider` is the second when flipped.
                const n = manifold.normal();
                addInto(pair, [n.x, n.y, n.z], flipped ? impulse : -impulse);
                reported += impulse;
            });
            if (!(reported > 0)) return;
            const key = contactPairKey(collider.handle, other.handle);
            const given = Math.max(0, reported - (previous.get(key) ?? 0) / substeps);
            next.set(key, given);
            addInto(total, pair, given / reported);
        });
    }
    return total;
};

/** The impulse `body`'s joints gave it over the step that took its velocity from `before`. */
const jointResidual = (
    world: RapierWorld,
    body: RapierRigidBody,
    before: Vec3,
    substeps: number,
    previous: ReadonlyMap<string, number>,
    next: Map<string, number>
): Vec3 => {
    const dt = world.timestep;
    const mass = body.mass();
    const v = body.linvel();
    const g = world.gravity;
    const gravityScale = body.gravityScale();
    const force = body.userForce();
    const contact = contactImpulseOn(world, body, substeps, previous, next);
    return [
        mass * (v.x - before[0]) - mass * g.x * gravityScale * dt - force.x * dt - contact[0],
        mass * (v.y - before[1]) - mass * g.y * gravityScale * dt - force.y * dt - contact[1],
        mass * (v.z - before[2]) - mass * g.z * gravityScale * dt - force.z * dt - contact[2]
    ];
};

/** Breaks joints that carry more than their break force. One per world, shared by its joints. */
export interface JointBreakMonitor {
    /**
     * Breaks `joint` once it carries more than `breakForce` newtons for a step: the joint is removed from
     * its world (waking its bodies), then `onBreak` runs. Returns a function that stops watching it.
     */
    watch(joint: RapierImpulseJoint, breakForce: number, onBreak: () => void): () => void;
    /** Records the jointed bodies' velocities. Call before every world step; repeat calls before one step are ignored. */
    beforeStep(world: RapierWorld): void;
    /** Measures the step's joint loads and breaks the overloaded joints. Call after every world step; repeat calls are ignored. */
    afterStep(world: RapierWorld): void;
}

interface WatchedJoint {
    breakForce: number;
    onBreak: () => void;
}

/** A break monitor for one world; joints it does not watch still count towards the loads of those it does. */
export const createJointBreakMonitor = (): JointBreakMonitor => {
    const watched = new Map<RapierImpulseJoint, WatchedJoint>();
    let velocities: Map<number, Vec3> | null = null;
    let contacts = new Map<string, number>();
    return {
        watch(joint, breakForce, onBreak) {
            const entry: WatchedJoint = { breakForce, onBreak };
            watched.set(joint, entry);
            return () => {
                if (watched.get(joint) === entry) watched.delete(joint);
            };
        },
        beforeStep(world) {
            if (velocities || watched.size === 0) return;
            const recorded = new Map<number, Vec3>();
            world.impulseJoints.forEach(joint => {
                for (const body of [joint.body1(), joint.body2()]) {
                    if (!body.isDynamic() || recorded.has(body.handle)) continue;
                    const v = body.linvel();
                    recorded.set(body.handle, [v.x, v.y, v.z]);
                }
            });
            velocities = recorded;
        },
        afterStep(world) {
            const before = velocities;
            velocities = null;
            if (!before) return;
            const substeps = Math.max(1, world.integrationParameters.numSolverIterations);
            const nextContacts = new Map<string, number>();
            const residuals = new Map<number, Vec3 | null>();
            const edges: JointLoadEdge[] = [];
            const joints: RapierImpulseJoint[] = [];
            world.impulseJoints.forEach(joint => {
                const ends = [joint.body1(), joint.body2()];
                edges.push({ body1: ends[0].handle, body2: ends[1].handle });
                joints.push(joint);
                for (const body of ends) {
                    if (residuals.has(body.handle)) continue;
                    const velocity = before.get(body.handle);
                    // A body that slept through the step, or joined a joint during it, took nothing from its joints.
                    const still = !velocity || body.isSleeping();
                    residuals.set(body.handle, !body.isDynamic() ? null
                        : still ? [0, 0, 0] : jointResidual(world, body, velocity, substeps, contacts, nextContacts));
                }
            });
            contacts = nextContacts;
            const loads = estimateJointLoads(edges, handle => residuals.get(handle) ?? null);
            const dt = world.timestep;
            const overloaded = joints.flatMap((joint, index) => {
                const entry = watched.get(joint);
                return entry && loads[index] > entry.breakForce * dt ? [{ joint, entry }] : [];
            });
            for (const { joint, entry } of overloaded) {
                watched.delete(joint);
                if (world.getImpulseJoint(joint.handle) === joint) world.removeImpulseJoint(joint, true);
                entry.onBreak();
            }
        }
    };
};

const breakMonitors = new WeakMap<RapierWorld, JointBreakMonitor>();

/** The break monitor shared by every joint component in `world`. */
const breakMonitorFor = (world: RapierWorld): JointBreakMonitor => {
    const known = breakMonitors.get(world);
    if (known) return known;
    const monitor = createJointBreakMonitor();
    breakMonitors.set(world, monitor);
    return monitor;
};

// --- RUNTIME ---

/** Steps a joint looks for its bodies before reporting them missing; it keeps looking afterwards. */
const UNCONNECTED_WARNING_STEPS = 300;

type JointPhase = 'connecting' | 'connected' | 'broken' | 'failed';

interface RuntimeJointProps {
    objectId: string;
    settings: JointSettings;
}

/**
 * Keeps the object's joint in the physics world. Bodies are built a few frames after the level mounts,
 * so it looks for both before every physics step until they exist. A body rebuilt during play (its type
 * changed) takes its joints with it; the joint then forms again with the new body. Changed settings or
 * unmounting remove the joint and any anchor body made for it; a broken joint stays broken until then.
 */
const RuntimeJoint: React.FC<RuntimeJointProps> = ({ objectId, settings }) => {
    const { world, rapier } = useRapier();
    const scene = useThree(state => state.scene);
    const monitor = breakMonitorFor(world);
    const link = useRef<JointLink | null>(null);
    const unwatch = useRef<(() => void) | null>(null);
    const phase = useRef<JointPhase>('connecting');
    const pivot = useRef<JointPivot | null>(null);
    const attempts = useRef(0);

    const disconnect = useCallback(() => {
        unwatch.current?.();
        unwatch.current = null;
        if (link.current) releaseJoint(world, link.current);
        link.current = null;
    }, [world]);

    useEffect(() => {
        phase.current = 'connecting';
        pivot.current = null;
        attempts.current = 0;
        return disconnect;
    }, [disconnect, objectId, settings]);

    const connect = () => {
        let connection: JointConnection;
        try {
            connection = connectJoint(world, rapier, objectId, settings, scene, pivot.current);
        } catch (error) {
            phase.current = 'failed';
            frontendDiagnostics.failure('physics_joint_failed', error);
            return;
        }
        if (connection.status === 'sameBody') {
            phase.current = 'failed';
            frontendDiagnostics.warning('physics_joint_same_body');
            return;
        }
        if (connection.status === 'waiting') {
            attempts.current += 1;
            if (attempts.current === UNCONNECTED_WARNING_STEPS) frontendDiagnostics.warning('physics_joint_unconnected');
            return;
        }
        const formed = connection.link;
        link.current = formed;
        pivot.current = formed.pivot;
        phase.current = 'connected';
        if (settings.breakForce <= 0) return;
        unwatch.current = monitor.watch(formed.joint, settings.breakForce, () => {
            unwatch.current = null;
            phase.current = 'broken';
            releaseJoint(world, formed);
            if (link.current === formed) link.current = null;
        });
    };

    useBeforePhysicsStep(() => {
        if (phase.current === 'connected' && link.current && !jointIntact(world, link.current)) {
            disconnect();
            phase.current = 'connecting';
        }
        if (phase.current === 'connecting') connect();
        monitor.beforeStep(world);
    });
    useAfterPhysicsStep(() => monitor.afterStep(world));

    return null;
};

const JointRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const available = usePhysicsAvailable();
    // Resolved settings compared by value, so a re-render with equal props keeps the joint.
    const signature = JSON.stringify(resolveJointSettings(component));
    const settings = useMemo(() => JSON.parse(signature) as JointSettings, [signature]);
    if (mode !== 'runtime' || !available) return null;
    return (
        <PhysicsFailureBoundary code="physics_joint_failed">
            <RuntimeJoint objectId={object.id} settings={settings} />
        </PhysicsFailureBoundary>
    );
};

// --- DEFINITIONS ---

/** The Physics Joint component type. */
export const JOINT_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'joint',
        label: 'Physics Joint',
        description: 'During play, joins this object\'s rigid body to another object\'s body, or pins it to the world at the anchor when no object is set. Fixed welds them, spherical lets them turn freely about the anchor, revolute hinges them about the axis and prismatic lets them slide along it; limits bound the hinge angle (degrees) or slide (metres). Jointed bodies do not collide with each other. A break force above 0 snaps the joint once it carries more than that many newtons. A hinge or slider expects the connected object turned like this one (about the axis, for a hinge).',
        props: [
            {
                key: 'kind', label: 'Joint Type', type: 'select', default: JOINT_DEFAULTS.kind,
                options: [
                    { label: 'Fixed (weld)', value: 'fixed' },
                    { label: 'Spherical (ball)', value: 'spherical' },
                    { label: 'Revolute (hinge)', value: 'revolute' },
                    { label: 'Prismatic (slider)', value: 'prismatic' }
                ]
            },
            { key: 'connectedObjectId', label: 'Connected Object ID (empty = world)', type: 'string', default: JOINT_DEFAULTS.connectedObjectId },
            { key: 'anchor', label: 'Anchor', type: 'vector3', default: JOINT_DEFAULTS.anchor, step: 0.1 },
            { key: 'connectedAnchor', label: 'Connected Anchor', type: 'vector3', default: JOINT_DEFAULTS.connectedAnchor, step: 0.1 },
            { key: 'axis', label: 'Axis', type: 'vector3', default: JOINT_DEFAULTS.axis, step: 0.1 },
            { key: 'limitsEnabled', label: 'Limits', type: 'boolean', default: JOINT_DEFAULTS.limitsEnabled },
            { key: 'limitMin', label: 'Lower Limit (deg / m)', type: 'number', default: JOINT_DEFAULTS.limitMin, min: -1000, max: 1000, step: 1 },
            { key: 'limitMax', label: 'Upper Limit (deg / m)', type: 'number', default: JOINT_DEFAULTS.limitMax, min: -1000, max: 1000, step: 1 },
            { key: 'breakForce', label: 'Break Force (N, 0 = never)', type: 'number', default: JOINT_DEFAULTS.breakForce, min: 0, max: 10000000, step: 10 }
        ],
        Render: JointRender
    }
];
