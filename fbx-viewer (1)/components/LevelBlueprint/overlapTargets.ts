import { LevelObject, LogicNode } from '../../types';

/**
 * Overlap events reference their trigger actor by stable LevelObject id (data.targetActorId).
 * Actor names are display-only: every placement of a model shares a default name, and a rename
 * must not orphan the reference. Nodes saved before ids were used only carry data.targetActorName;
 * they keep matching by name until the editor can migrate them to exactly one actor.
 */
export type OverlapTarget =
    | { kind: 'linked'; actor: LevelObject }
    | { kind: 'missing'; actorId: string }
    | { kind: 'legacy-unique'; name: string; actor: LevelObject }
    | { kind: 'legacy-ambiguous'; name: string; matches: LevelObject[] }
    | { kind: 'legacy-missing'; name: string }
    | { kind: 'unset' };

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

export const isOverlapEvent = (node: LogicNode): boolean => node.type === 'Event' && node.name.includes('Overlap');

export const resolveOverlapTarget = (node: LogicNode, levelObjects: LevelObject[]): OverlapTarget => {
    const actorId = node.data?.targetActorId;
    if (nonEmptyString(actorId)) {
        const actor = levelObjects.find(obj => obj.id === actorId);
        return actor ? { kind: 'linked', actor } : { kind: 'missing', actorId };
    }
    const name = node.data?.targetActorName;
    if (nonEmptyString(name)) {
        const matches = levelObjects.filter(obj => obj.name === name);
        if (matches.length === 1) return { kind: 'legacy-unique', name, actor: matches[0] };
        return matches.length > 1 ? { kind: 'legacy-ambiguous', name, matches } : { kind: 'legacy-missing', name };
    }
    return { kind: 'unset' };
};

/** The actor id an actor picker shows as selected, or '' when there is none. */
export const selectedOverlapActorId = (target: OverlapTarget): string => {
    if (target.kind === 'linked' || target.kind === 'legacy-unique') return target.actor.id;
    return target.kind === 'missing' ? target.actorId : '';
};

/** Runtime match: by id when the event has one, otherwise by its legacy name. */
export const overlapEventTargets = (node: LogicNode, actor: LevelObject): boolean => {
    const actorId = node.data?.targetActorId;
    if (nonEmptyString(actorId)) return actorId === actor.id;
    const name = node.data?.targetActorName;
    return nonEmptyString(name) && name === actor.name;
};

/** Node data pointing the event at one actor; any legacy name reference is dropped. */
export const overlapTargetData = (data: Record<string, unknown> | undefined, actor: LevelObject): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...(data || {}), targetActorId: actor.id };
    delete next.targetActorName;
    return next;
};

export const overlapEventName = (actor: LevelObject): string => `On Overlap (${actor.name})`;

/** Picker label: names repeat, so the type and a short id tell same-named actors apart. */
export const describeActor = (actor: LevelObject): string => `${actor.name} · ${actor.type} · ${actor.id.slice(0, 8)}`;

/** Editor warning for a reference that does not resolve to exactly one actor by id. */
export const overlapTargetWarning = (target: OverlapTarget): string | null => {
    switch (target.kind) {
        case 'missing':
            return `Missing actor: ${target.actorId.slice(0, 8)} was deleted from this level.`;
        case 'legacy-ambiguous':
            return `"${target.name}" matches ${target.matches.length} actors and fires for all of them. Pick one.`;
        case 'legacy-missing':
            return `Missing actor: no actor is named "${target.name}".`;
        default:
            return null;
    }
};

/**
 * Upgrades legacy name-only overlap events whose name identifies exactly one actor.
 * Returns null when nothing changed, so callers persist only real migrations.
 */
export const migrateLegacyOverlapTargets = (nodes: LogicNode[], levelObjects: LevelObject[]): LogicNode[] | null => {
    let changed = false;
    const migrated = nodes.map(node => {
        if (!isOverlapEvent(node)) return node;
        const target = resolveOverlapTarget(node, levelObjects);
        if (target.kind !== 'legacy-unique') return node;
        changed = true;
        return { ...node, data: overlapTargetData(node.data, target.actor) };
    });
    return changed ? migrated : null;
};
