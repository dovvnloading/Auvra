import { useMemo, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import type { LevelComponent, LevelObject } from '../types';
import { buildSpline, createSplineFrame, readSplineData, Spline, SPLINE_COMPONENT_TYPE, type SplineData, type SplineFrame } from './splines';

/**
 * SPLINE REGISTRY
 *
 * Drafts: while the editor drags a spline point, the spline's points live here instead of in the
 * level (which takes the edit once, when the drag ends), so the curve and everything laid along it
 * follow the drag without a project write per frame.
 *
 * Live splines: each drawn Spline component registers its curve with the transform group of its
 * object, so other objects (Follow Spline, behavior trees, level script nodes) can find a spline by
 * the id of the object that owns it and sample it in world space.
 */

type Listener = () => void;

const drafts = new Map<string, SplineData>();
const draftListeners = new Set<Listener>();
let draftVersion = 0;

const emitDrafts = () => {
    draftVersion++;
    draftListeners.forEach(listener => listener());
};

/** Shows `data` for the spline component `componentId` until it is cleared (null). */
export const setSplineDraft = (componentId: string, data: SplineData | null): void => {
    if (data) drafts.set(componentId, data);
    else if (!drafts.delete(componentId)) return;
    emitDrafts();
};

export const getSplineDraft = (componentId: string): SplineData | null => drafts.get(componentId) ?? null;

const subscribeDrafts = (listener: Listener) => {
    draftListeners.add(listener);
    return () => draftListeners.delete(listener);
};

/** The object's first enabled spline component, or null. */
export const findSplineComponent = (object: Pick<LevelObject, 'components'>) =>
    (object.components ?? []).find(component => component.type === SPLINE_COMPONENT_TYPE && component.enabled !== false) ?? null;

/** The spline data an object's spline component holds (or its draft while it is dragged), or null without one. */
export const objectSplineData = (object: Pick<LevelObject, 'components'>): SplineData | null => {
    const component = findSplineComponent(object);
    if (!component) return null;
    return getSplineDraft(component.id) ?? readSplineData(component.props);
};

/** The curve of the object's spline component, rebuilt when its props or draft change; null without one. */
export const useObjectSpline = (object: Pick<LevelObject, 'components'>): { spline: Spline; componentId: string } | null =>
    useComponentSpline(findSplineComponent(object));

/** The curve a spline component holds (or its draft while it is dragged); null for no component. */
export const useComponentSpline = (component: LevelComponent | null): { spline: Spline; componentId: string } | null => {
    const version = useSyncExternalStore(subscribeDrafts, () => draftVersion);
    const componentId = component?.id ?? null;
    const draft = componentId ? drafts.get(componentId) ?? null : null;
    const props = component?.props;
    // version: a draft set again for the same component still rebuilds.
    return useMemo(
        () => (componentId ? { spline: buildSpline(draft ?? readSplineData(props)), componentId } : null),
        [componentId, draft, props, version],
    );
};

// ---------------------------------------------------------------------------
// Live splines
// ---------------------------------------------------------------------------

export type SplineRegistryMode = 'editor' | 'runtime';

export interface LiveSpline {
    objectId: string;
    mode: SplineRegistryMode;
    spline: Spline;
    /** The owning object's transform group: the spline's local space. */
    node: THREE.Object3D;
}

const live = new Map<string, LiveSpline[]>();

/** Registers a drawn spline; the returned function removes it again. */
export const registerLiveSpline = (entry: LiveSpline): (() => void) => {
    const list = live.get(entry.objectId) ?? [];
    list.push(entry);
    live.set(entry.objectId, list);
    return () => {
        const current = live.get(entry.objectId);
        if (!current) return;
        const remaining = current.filter(candidate => candidate !== entry);
        if (remaining.length > 0) live.set(entry.objectId, remaining);
        else live.delete(entry.objectId);
    };
};

/** The spline drawn for `objectId`, preferring one drawn in `mode`; null when none is. */
export const getLiveSpline = (objectId: string, mode?: SplineRegistryMode): LiveSpline | null => {
    const list = live.get(objectId);
    if (!list || list.length === 0) return null;
    return (mode ? list.find(entry => entry.mode === mode) : undefined) ?? list[list.length - 1];
};

/** A spline sampled in world space: positions and directions through its object's transform. */
export interface WorldSplineFrame {
    position: THREE.Vector3;
    tangent: THREE.Vector3;
    up: THREE.Vector3;
    right: THREE.Vector3;
    /** Distance along the spline, in its own units. */
    distance: number;
}

export const createWorldSplineFrame = (): WorldSplineFrame => ({
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(0, 0, 1),
    distance: 0,
});

const _local: SplineFrame = createSplineFrame();
const _normal = new THREE.Matrix3();
const _point = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/** The frame `distance` (local units) along a live spline, in world space. */
export const sampleLiveSpline = (entry: LiveSpline, distance: number, target: WorldSplineFrame = createWorldSplineFrame()): WorldSplineFrame => {
    entry.node.updateWorldMatrix(true, false);
    const matrix = entry.node.matrixWorld;
    entry.spline.frameAt(distance, _local);
    target.distance = _local.distance;
    target.position.copy(_local.position).applyMatrix4(matrix);
    // Directions go through the linear part only; a scaled object keeps them unit length.
    _normal.setFromMatrix4(matrix);
    target.tangent.copy(_local.tangent).applyMatrix3(_normal).normalize();
    target.up.copy(_local.up).applyMatrix3(_normal);
    target.up.addScaledVector(target.tangent, -target.up.dot(target.tangent)).normalize();
    target.right.crossVectors(target.tangent, target.up).normalize();
    return target;
};

/** How many world units one unit along the spline is: its world length over its own (1 for an unscaled object). */
export const liveSplineWorldScale = (entry: LiveSpline): number => {
    entry.node.updateWorldMatrix(true, false);
    const spline = entry.spline;
    if (!(spline.length > 1e-9)) return 1;
    const steps = Math.min(256, Math.max(8, spline.segmentCount * 8));
    const previous = new THREE.Vector3();
    let world = 0;
    for (let i = 0; i <= steps; i++) {
        spline.positionAt((spline.length * i) / steps, _point).applyMatrix4(entry.node.matrixWorld);
        if (i > 0) world += _point.distanceTo(previous);
        previous.copy(_point);
    }
    return world > 1e-9 ? world / spline.length : 1;
};

/** Distance along a live spline (its own units) nearest to a world-space point. */
export const closestOnLiveSpline = (entry: LiveSpline, worldPoint: THREE.Vector3): number => {
    entry.node.updateWorldMatrix(true, false);
    _point.copy(worldPoint).applyMatrix4(_inverse.copy(entry.node.matrixWorld).invert());
    return entry.spline.closestDistance(_point);
};

/** A live spline as level script nodes see it: metres along it, world-space points and directions. */
export interface WorldSplineQuery {
    /** World length, metres. */
    length: number;
    closed: boolean;
    /** Position, direction of travel and up `distance` metres along it (wrapped round a closed spline, clamped to an open one). */
    sample(distance: number): { position: [number, number, number]; direction: [number, number, number]; up: [number, number, number] };
    /** The point on it nearest a world-space point, and how many metres along it that is. */
    closest(point: [number, number, number]): { distance: number; position: [number, number, number] };
}

export const liveSplineQuery = (entry: LiveSpline): WorldSplineQuery => {
    const scale = liveSplineWorldScale(entry);
    const frame = createWorldSplineFrame();
    const triple = (vector: THREE.Vector3): [number, number, number] => [vector.x, vector.y, vector.z];
    return {
        length: entry.spline.length * scale,
        closed: entry.spline.closed,
        sample: (distance) => {
            sampleLiveSpline(entry, distance / scale, frame);
            return { position: triple(frame.position), direction: triple(frame.tangent), up: triple(frame.up) };
        },
        closest: (point) => {
            const along = closestOnLiveSpline(entry, new THREE.Vector3(...point));
            sampleLiveSpline(entry, along, frame);
            return { distance: along * scale, position: triple(frame.position) };
        },
    };
};
