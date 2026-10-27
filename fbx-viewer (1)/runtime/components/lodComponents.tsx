import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LevelComponent, LevelObject } from '../../types';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * Level of detail and distance culling. Both change drawing only: a hidden object keeps its colliders,
 * scripts, sounds and components running. During play they set `visible` on the transform groups of
 * the play session (never on the project); in the editor, with Preview in Editor on, they hide object
 * ids through LodEditorPreviewContext, since the editor draws objects flat and instanced rather than
 * under their parents' groups.
 */

type Vec3 = [number, number, number];

/** chooseLod's level for an object beyond its hide distance. */
export const LOD_HIDDEN = -1;

const LOD_GROUP_DEFAULTS = { distances: [20, 50, 0] as Vec3, hysteresis: 0.1, previewInEditor: false };
const DISTANCE_CULL_DEFAULTS = { maxDistance: 100, hysteresis: 0.1, previewInEditor: false };

/** Largest hysteresis the settings take: at 1 an object that went farther would never come back. */
const MAX_HYSTERESIS = 0.9;
/** Largest switch distance the settings take (m). */
const MAX_DISTANCE = 100_000;

const NO_IDS: ReadonlySet<string> = new Set<string>();
const NO_NODES: ReadonlySet<THREE.Object3D> = new Set<THREE.Object3D>();
const NO_CHILDREN: readonly string[] = [];

const readNumber = (component: LevelComponent, key: string, fallback: number, min: number, max: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const isVec3 = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));

const readVector3 = (component: LevelComponent, key: string, fallback: Vec3): Vec3 => {
    const value = component.props[key];
    return isVec3(value) ? value : fallback;
};

// --- LEVEL CHOICE ---

/**
 * The level of detail for an object `distance` metres from the camera. `thresholds` are switch
 * distances: beyond thresholds[i] the level is at least i + 1, except beyond the last entry, where the
 * object is hidden (LOD_HIDDEN); so [lod1, lod2, hide] gives 0, 1, 2 or hidden, and [maxDistance] gives
 * 0 or hidden. A threshold of 0 (or less) is off. Going farther switches exactly at a threshold; once
 * the object is beyond one (by `previousLevel`, the last frame's level), it comes back nearer only below
 * threshold * (1 - hysteresis), so an object at a boundary does not flicker between two levels.
 */
export const chooseLod = (distance: number, thresholds: readonly number[], previousLevel: number, hysteresis: number): number => {
    const count = thresholds.length;
    if (count === 0) return 0;
    const band = 1 - THREE.MathUtils.clamp(Number.isFinite(hysteresis) ? hysteresis : 0, 0, 1);
    // Ranks order the answers from near to far: levels 0..count - 1, then hidden.
    const previousRank = previousLevel < 0 ? count : previousLevel;
    let rank = 0;
    for (let i = 0; i < count; i++) {
        const threshold = thresholds[i];
        if (!(threshold > 0) || !Number.isFinite(threshold)) continue;
        const beyond = i + 1;
        const edge = previousRank >= beyond ? threshold * band : threshold;
        if (distance > edge && beyond > rank) rank = beyond;
    }
    return rank === count ? LOD_HIDDEN : rank;
};

/** The slot drawn for `level` out of `count` slots: a level past the last slot keeps the last one. */
const shownSlot = (level: number, count: number): number => (level < 0 || count === 0 ? -1 : Math.min(level, count - 1));

/** Everything in the slots other than the shown one. */
const hiddenSlotItems = <T,>(slots: readonly (readonly T[])[], shown: number): Set<T> => {
    const hidden = new Set<T>();
    slots.forEach((items, index) => {
        if (index !== shown) items.forEach(item => hidden.add(item));
    });
    slots[shown]?.forEach(item => hidden.delete(item));
    return hidden;
};

/** The runtime draws a model for props and foliage only (see LevelRuntime's LevelObjectNode). */
const hasOwnModel = (object: LevelObject): boolean =>
    (object.type === 'prop' || object.type === 'foliage') && typeof object.modelId === 'string' && object.modelId.length > 0;

const cameraDistance = (camera: THREE.Camera, host: THREE.Object3D, scratch: { camera: THREE.Vector3; host: THREE.Vector3 }): number =>
    camera.getWorldPosition(scratch.camera).distanceTo(host.getWorldPosition(scratch.host));

// --- NODE VISIBILITY ---

interface NodeHide {
    owners: Set<object>;
    /** The node's visibility before the first owner hid it. */
    restore: boolean;
}

const nodeHides = new WeakMap<THREE.Object3D, NodeHide>();

/**
 * Hides `node` for `owner`, or lets it go. The node stays hidden while any owner hides it; when the
 * last one lets go it gets back the visibility it had before the first hid it. It writes `visible` only
 * when that changes, so other code may still set it in between.
 */
export const setNodeHidden = (node: THREE.Object3D, owner: object, hidden: boolean): void => {
    const hide = nodeHides.get(node);
    if (hidden) {
        if (hide) {
            hide.owners.add(owner);
            return;
        }
        nodeHides.set(node, { owners: new Set([owner]), restore: node.visible });
        node.visible = false;
        return;
    }
    if (!hide || !hide.owners.delete(owner) || hide.owners.size > 0) return;
    nodeHides.delete(node);
    node.visible = hide.restore;
};

/**
 * Hides a changing set of items for one owner: the returned function swaps in the next set, and
 * unmounting (or a new `hide`) lets every item go. Null `hide` hides nothing.
 */
const useHiddenItems = <T,>(hide: ((item: T, owner: object, hidden: boolean) => void) | null): ((next: ReadonlySet<T>) => void) => {
    // The set is also the owner token, so two components never release each other's hides.
    const hidden = useMemo(() => new Set<T>(), []);
    useEffect(() => () => {
        if (hide) hidden.forEach(item => hide(item, hidden, false));
        hidden.clear();
    }, [hide, hidden]);
    return useCallback((next: ReadonlySet<T>) => {
        if (!hide) return;
        hidden.forEach(item => {
            if (next.has(item)) return;
            hide(item, hidden, false);
            hidden.delete(item);
        });
        next.forEach(item => {
            if (hidden.has(item)) return;
            hide(item, hidden, true);
            hidden.add(item);
        });
    }, [hide, hidden]);
};

/** A nested LevelObject: the runtime tags each object's transform group with its id. */
const isNestedObject = (node: THREE.Object3D, objectId: string): boolean => {
    const id = node.userData?.levelObjectId;
    return typeof id === 'string' && id !== objectId;
};

/** Whether `node` draws a mesh of the object itself (not of a nested object). Lights, sounds and particles do not. */
const drawsOwnMesh = (node: THREE.Object3D, objectId: string): boolean => {
    if (isNestedObject(node, objectId)) return false;
    if ((node as THREE.Mesh).isMesh) return true;
    return node.children.some(child => drawsOwnMesh(child, objectId));
};

/** Host slots, redone only when the host, its direct children or the own-model setting change. */
interface SlotLookup {
    host: THREE.Object3D | null;
    children: THREE.Object3D[];
    ownModel: boolean;
    slots: THREE.Object3D[][];
}

const createSlotLookup = (): SlotLookup => ({ host: null, children: [], ownModel: false, slots: [] });

const sameChildren = (host: THREE.Object3D, children: readonly THREE.Object3D[]): boolean => {
    if (host.children.length !== children.length) return false;
    for (let i = 0; i < children.length; i++) {
        if (host.children[i] !== children[i]) return false;
    }
    return true;
};

/**
 * The LOD slots under the host during play: the host's own model nodes first (when it has a model),
 * then each nested object's transform group, in the order they sit under the host.
 */
const nodeLodSlots = (lookup: SlotLookup, host: THREE.Object3D, objectId: string, ownModel: boolean): THREE.Object3D[][] => {
    if (lookup.host === host && lookup.ownModel === ownModel && sameChildren(host, lookup.children)) return lookup.slots;
    const own: THREE.Object3D[] = [];
    const slots: THREE.Object3D[][] = ownModel ? [own] : [];
    for (const child of host.children) {
        if (isNestedObject(child, objectId)) slots.push([child]);
        else if (ownModel && drawsOwnMesh(child, objectId)) own.push(child);
    }
    lookup.host = host;
    lookup.children = [...host.children];
    lookup.ownModel = ownModel;
    lookup.slots = slots;
    return slots;
};

// --- EDITOR PREVIEW ---

/** What LOD previews need from the editor, which draws objects flat (and instanced) instead of under their parents. */
export interface LodEditorPreview {
    /** The object's direct children, in hierarchy order. */
    childIds: (objectId: string) => readonly string[];
    /** Hides the object's own drawing for `owner`, or lets it go; it stays hidden while any owner hides it. */
    setHidden: (objectId: string, owner: object, hidden: boolean) => void;
}

/** Provided by the editor scene; without it LOD Group and Distance Cull do not preview in the editor. */
export const LodEditorPreviewContext = createContext<LodEditorPreview | null>(null);

const childIdsByParent = (objects: readonly LevelObject[]): Map<string, string[]> => {
    const ids = new Set(objects.map(object => object.id));
    const children = new Map<string, string[]>();
    for (const object of objects) {
        const parentId = object.parentId;
        if (!parentId || parentId === object.id || !ids.has(parentId)) continue;
        const siblings = children.get(parentId);
        if (siblings) siblings.push(object.id);
        else children.set(parentId, [object.id]);
    }
    return children;
};

const withId = (ids: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> => {
    if (ids.has(id) === present) return ids;
    const next = new Set(ids);
    if (present) next.add(id);
    else next.delete(id);
    return next;
};

/**
 * The editor's side of LodEditorPreviewContext for `levelObjects` (as authored, parent links included):
 * the stable preview to provide, and the ids previews hide right now, for the scene to leave undrawn.
 */
export const useLodEditorPreview = (levelObjects: readonly LevelObject[]): { preview: LodEditorPreview; hiddenIds: ReadonlySet<string> } => {
    const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(NO_IDS);
    const children = useMemo(() => childIdsByParent(levelObjects), [levelObjects]);
    const childrenRef = useRef(children);
    childrenRef.current = children;
    const preview = useMemo<LodEditorPreview>(() => {
        const owners = new Map<string, Set<object>>();
        return {
            childIds: objectId => childrenRef.current.get(objectId) ?? NO_CHILDREN,
            setHidden: (objectId, owner, hidden) => {
                const current = owners.get(objectId);
                if (hidden) {
                    if (current) {
                        current.add(owner);
                        return;
                    }
                    owners.set(objectId, new Set([owner]));
                    setHiddenIds(ids => withId(ids, objectId, true));
                    return;
                }
                if (!current || !current.delete(owner) || current.size > 0) return;
                owners.delete(objectId);
                setHiddenIds(ids => withId(ids, objectId, false));
            }
        };
    }, []);
    return { preview, hiddenIds };
};

/** `rootId` and every descendant, depth first in hierarchy order; `exclude` (and cycles) are skipped. */
const subtreeIds = (preview: LodEditorPreview, rootId: string, exclude?: string): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>(exclude ? [exclude] : []);
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        const children = preview.childIds(id);
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return ids;
};

/** The editor's LOD slots: the object's own drawing (when it has a model), then each child with its descendants. */
const editorLodSlots = (preview: LodEditorPreview, objectId: string, ownModel: boolean): string[][] => {
    const slots: string[][] = ownModel ? [[objectId]] : [];
    for (const childId of preview.childIds(objectId)) {
        if (childId !== objectId) slots.push(subtreeIds(preview, childId, objectId));
    }
    return slots;
};

// --- LOD GROUP ---

/** Play always runs; the editor only previews when the component asks for it. */
const runsIn = ({ mode, component }: ComponentRenderProps): boolean =>
    mode === 'runtime' || readBoolean(component, 'previewInEditor', false);

/** Where a switch measures from: the host group, or (in the editor, which provides none) the group it is mounted in. */
const useSwitchHost = () => {
    const hostRef = useContext(ComponentHostContext);
    const anchorRef = useRef<THREE.Group>(null);
    const resolve = useCallback(
        (): THREE.Object3D | null => hostRef?.current ?? anchorRef.current?.parent ?? null,
        [hostRef]
    );
    // An anchor only without a host, so the runtime's host gains no node of this component.
    const anchor = hostRef ? null : <group ref={anchorRef} />;
    return { resolve, anchor };
};

const LodGroupSwitch: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const { resolve, anchor } = useSwitchHost();
    const preview = useContext(LodEditorPreviewContext);
    const editor = mode === 'editor';
    const hideNodes = useHiddenItems<THREE.Object3D>(editor ? null : setNodeHidden);
    const hideIds = useHiddenItems<string>(editor && preview ? preview.setHidden : null);
    const [lod1, lod2, hide] = readVector3(component, 'distances', LOD_GROUP_DEFAULTS.distances);
    const thresholds = useMemo(() => [lod1, lod2, hide], [lod1, lod2, hide]);
    const hysteresis = readNumber(component, 'hysteresis', LOD_GROUP_DEFAULTS.hysteresis, 0, MAX_HYSTERESIS);
    const ownModel = hasOwnModel(object);
    const level = useRef(0);
    const applied = useRef<{ shown: number; slots: THREE.Object3D[][] } | null>(null);
    const lookup = useMemo(createSlotLookup, []);
    const scratch = useMemo(() => ({ camera: new THREE.Vector3(), host: new THREE.Vector3() }), []);

    useFrame(({ camera }) => {
        if (editor && !preview) return;
        const host = resolve();
        if (!host) return;
        level.current = chooseLod(cameraDistance(camera, host, scratch), thresholds, level.current, hysteresis);
        if (editor && preview) {
            const slots = editorLodSlots(preview, object.id, ownModel);
            hideIds(hiddenSlotItems(slots, shownSlot(level.current, slots.length)));
            return;
        }
        const slots = nodeLodSlots(lookup, host, object.id, ownModel);
        const shown = shownSlot(level.current, slots.length);
        if (applied.current?.shown === shown && applied.current.slots === slots) return;
        applied.current = { shown, slots };
        hideNodes(hiddenSlotItems(slots, shown));
    });

    return anchor;
};

const LodGroupRender: React.FC<ComponentRenderProps> = (props) => (
    runsIn(props) ? <LodGroupSwitch {...props} /> : null
);

// --- DISTANCE CULL ---

const DistanceCullSwitch: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const { resolve, anchor } = useSwitchHost();
    const preview = useContext(LodEditorPreviewContext);
    const editor = mode === 'editor';
    const hideNodes = useHiddenItems<THREE.Object3D>(editor ? null : setNodeHidden);
    const hideIds = useHiddenItems<string>(editor && preview ? preview.setHidden : null);
    const maxDistance = readNumber(component, 'maxDistance', DISTANCE_CULL_DEFAULTS.maxDistance, 0, MAX_DISTANCE);
    const thresholds = useMemo(() => [maxDistance], [maxDistance]);
    const hysteresis = readNumber(component, 'hysteresis', DISTANCE_CULL_DEFAULTS.hysteresis, 0, MAX_HYSTERESIS);
    const level = useRef(0);
    const applied = useRef<{ host: THREE.Object3D | null; hidden: boolean }>({ host: null, hidden: false });
    const scratch = useMemo(() => ({ camera: new THREE.Vector3(), host: new THREE.Vector3() }), []);

    useFrame(({ camera }) => {
        if (editor && !preview) return;
        const host = resolve();
        if (!host) return;
        level.current = chooseLod(cameraDistance(camera, host, scratch), thresholds, level.current, hysteresis);
        const hidden = level.current === LOD_HIDDEN;
        if (editor && preview) {
            hideIds(hidden ? new Set(subtreeIds(preview, object.id)) : NO_IDS);
            return;
        }
        // Hiding the transform group hides the model, the components' drawing and every nested object.
        if (applied.current.host === host && applied.current.hidden === hidden) return;
        applied.current = { host, hidden };
        hideNodes(hidden ? new Set([host]) : NO_NODES);
    });

    return anchor;
};

const DistanceCullRender: React.FC<ComponentRenderProps> = (props) => (
    runsIn(props) ? <DistanceCullSwitch {...props} /> : null
);

// --- DEFINITIONS ---

const HYSTERESIS_PROP = {
    key: 'hysteresis', label: 'Hysteresis (fraction)', type: 'number', min: 0, max: MAX_HYSTERESIS, step: 0.01
} as const;

const PREVIEW_PROP = { key: 'previewInEditor', label: 'Preview in Editor', type: 'boolean' } as const;

/** The LOD Group and Distance Cull component types, for the registry. */
export const LOD_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'lodGroup',
        label: 'LOD Group',
        description: 'Draws one level of detail by distance from the camera: the object\'s own model (when it has one) and then its direct children, in order, are LOD 0, 1, 2. A level without a child keeps the last one; children past LOD 2 stay hidden. Moving nearer, a switch waits until the camera is inside its distance times (1 - hysteresis). Colliders and scripts keep running.',
        props: [
            { key: 'distances', label: 'Distances (m): LOD 1, LOD 2, hide; 0 = off', type: 'vector3', default: LOD_GROUP_DEFAULTS.distances, min: 0, max: MAX_DISTANCE, step: 1 },
            { ...HYSTERESIS_PROP, default: LOD_GROUP_DEFAULTS.hysteresis },
            { ...PREVIEW_PROP, default: LOD_GROUP_DEFAULTS.previewInEditor }
        ],
        Render: LodGroupRender
    },
    {
        type: 'distanceCull',
        label: 'Distance Cull',
        description: 'Stops drawing the object and its children beyond a distance from the camera; they come back once the camera is inside that distance times (1 - hysteresis). Colliders, scripts and sounds keep running.',
        props: [
            { key: 'maxDistance', label: 'Max Distance (m, 0 = off)', type: 'number', default: DISTANCE_CULL_DEFAULTS.maxDistance, min: 0, max: MAX_DISTANCE, step: 1 },
            { ...HYSTERESIS_PROP, default: DISTANCE_CULL_DEFAULTS.hysteresis },
            { ...PREVIEW_PROP, default: DISTANCE_CULL_DEFAULTS.previewInEditor }
        ],
        Render: DistanceCullRender
    }
];
