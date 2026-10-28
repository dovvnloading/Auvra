import type { LevelComponent, LevelObject } from '../types';

/**
 * Which level objects move at runtime. Systems baked from the level's static geometry (the
 * navigation mesh, baked lighting) leave moving objects out.
 */

const DYNAMIC_COMPONENT_TYPES: ReadonlySet<string> = new Set(['mover', 'rotator']);

const isDynamicComponent = (component: LevelComponent): boolean => {
    if (component.enabled === false) return false;
    if (DYNAMIC_COMPONENT_TYPES.has(component.type)) return true;
    // A rigid body is static only when it is explicitly fixed (Rapier bodies default to dynamic).
    return component.type === 'rigidBody' && component.props?.type !== 'fixed';
};

/** True when the object or one of its ancestors moves at runtime. */
export const isDynamicObject = (object: LevelObject, index: ReadonlyMap<string, LevelObject>): boolean => {
    const visited = new Set<string>();
    let current: LevelObject | undefined = object;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if ((current.components ?? []).some(isDynamicComponent)) return true;
        const parentId: string | null | undefined = current.parentId;
        current = parentId ? index.get(parentId) : undefined;
    }
    return false;
};
