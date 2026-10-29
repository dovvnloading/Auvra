import { useSyncExternalStore } from 'react';
import type { LevelComponent, LevelObject } from '../../types';
import { readSplineData, removeSplinePoint, writeSplineData, type SplineData } from '../../runtime/splines';
import { findSplineComponent } from '../../runtime/splineRegistry';

/**
 * Which spline point the World Editor is editing: the viewport draws its gizmo on it, the
 * inspector shows its fields, Delete removes it. 'point' is the point itself; 'leave' and 'arrive'
 * are its tangent handles, after and before it.
 */
export type SplineHandle = 'point' | 'leave' | 'arrive';

export interface SplineSelection {
    objectId: string;
    componentId: string;
    index: number;
    handle: SplineHandle;
}

type Listener = () => void;

let selection: SplineSelection | null = null;
const listeners = new Set<Listener>();

export const splineEditing = {
    get: (): SplineSelection | null => selection,
    set(next: SplineSelection | null): void {
        const same = next === selection || (next && selection
            && next.objectId === selection.objectId && next.componentId === selection.componentId
            && next.index === selection.index && next.handle === selection.handle);
        if (same) return;
        selection = next;
        listeners.forEach(listener => listener());
    },
    subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};

export const useSplineSelection = (): SplineSelection | null =>
    useSyncExternalStore(splineEditing.subscribe, splineEditing.get, splineEditing.get);

/** The object's components with its spline component's props set to hold `data`. */
export const withSplineData = (object: Pick<LevelObject, 'components'>, componentId: string, data: SplineData): LevelComponent[] =>
    (object.components ?? []).map(component => (component.id === componentId
        ? { ...component, props: { ...component.props, ...writeSplineData(data) } }
        : component));

/**
 * Removes the selected spline point (a spline keeps two); returns the object's new components, or
 * null when nothing is selected on `object` or the point cannot go.
 */
export const deleteSelectedSplinePoint = (object: LevelObject): LevelComponent[] | null => {
    const current = selection;
    const component = findSplineComponent(object);
    if (!current || !component || current.objectId !== object.id || current.componentId !== component.id) return null;
    const data = readSplineData(component.props);
    if (data.points.length <= 2) return null;
    const next = removeSplinePoint(data, current.index);
    splineEditing.set({ ...current, index: Math.min(current.index, next.points.length - 1), handle: 'point' });
    return withSplineData(object, component.id, next);
};
