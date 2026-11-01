
import React, { useRef, useState, useMemo, useEffect, useCallback, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { renderView } from './renderBundle';
import type { ThreeEvent } from '@react-three/fiber';
import { Grid, TransformControls } from '@react-three/drei';
import { LoadedModelData, LevelObject } from '../../types';
import { InteractionMode, PaintMode, PaintSettings, TransformSettings, TransformTool, SculptSettings } from './types';
import { LevelObjectRenderer, LevelComponentPreviews } from './LevelObjectRenderer';
import { FoliageBrushTool, type FoliagePlacement } from './FoliageBrushTool';
import { TerrainObject } from './Terrain/TerrainObject';
import { TerrainSculptor } from './Terrain/TerrainSculptor';
import { InstancedLevelLayer } from './InstancedLevelLayer';
import { LodEditorPreviewContext, useLodEditorPreview } from '../../runtime/components/lodComponents';
import { AudioSystem } from './AudioSystem';
import { LevelDynamicGi } from '../../runtime/lighting/dynamicGi/LevelDynamicGi';
import { LevelLightVolume, LightBakeRunner } from '../../runtime/lighting/LevelLightVolume';
import { useLevel } from '../../context/LevelContext';
import { SkySystem } from './SkySystem';
import { useAssets } from '../../context/AssetContext';
import { getWorldMatrix, toLocalTransform } from '../../utils/sceneGraph';
import type { LocalTransform } from '../../utils/sceneGraph';
import { raycastPlacement } from '../../utils/surfacePlacement';
import { NavMeshOverlay } from './NavMeshOverlay';
import type { LevelNavMesh } from '../../runtime/navigation';
import { findSplineComponent } from '../../runtime/splineRegistry';
import { SplineEditOverlay } from './SplineEditOverlay';
import { useSplineSelection } from './splineEditing';
import { gizmoPointer } from './gizmoPointer';
import { timelinePreview } from '../../runtime/timeline/preview';
import { timelineTargetIds } from '../../runtime/timeline/evaluate';

type Vec3 = [number, number, number];
type RegisterNode = (id: string, node: THREE.Object3D | null, owner?: THREE.Object3D | null) => void;
type SelectHandler = (id: string, event?: unknown) => void;

// Objects drawn as editor markers rather than model geometry.
const MARKER_TYPES = new Set<LevelObject['type']>(['spawn_point', 'audio_emitter', 'sky_sphere', 'player_start']);
/** A prop with no model (an empty object, or one that only carries components such as a light). */
const isEmptyProp = (object: LevelObject) => object.type === 'prop' && !object.modelId;
/** Drawn one by one with its own marker rather than in an instanced layer. */
const isMarkerObject = (object: LevelObject) => MARKER_TYPES.has(object.type) || isEmptyProp(object);
const isInstancedObject = (object: LevelObject) => object.type !== 'terrain' && !isMarkerObject(object);

/** Selected instanced objects past this many keep the in-layer highlight instead of a proxy. */
const MAX_SELECTION_PROXIES = 64;
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const NO_OBJECTS: LevelObject[] = [];
const DOWN = new THREE.Vector3(0, -1, 0);
// Height above the first hit that the snapped-column probe starts from.
const COLUMN_PROBE_HEIGHT = 100;
const TRANSFORM_EPSILON = 1e-6;

/** Shift, Ctrl or Cmd adds an object to (or removes it from) the selection. */
const isAdditiveClick = (event: unknown): boolean => {
    type Modifiers = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    const e = event as (Modifiers & { nativeEvent?: Modifiers }) | null | undefined;
    if (!e) return false;
    const native = e.nativeEvent;
    return Boolean(e.shiftKey || e.ctrlKey || e.metaKey || native?.shiftKey || native?.ctrlKey || native?.metaKey);
};

/** The same Set while the ids are the same, so memoised consumers are not re-run by identity churn. */
const useStableIdSet = (ids: Iterable<string>): ReadonlySet<string> => {
    const key = Array.from(ids).join('\u0000');
    return useMemo(() => (key ? new Set(key.split('\u0000')) : EMPTY_IDS), [key]);
};

const sameVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const nearVec = (a: Vec3, b: Vec3) =>
    Math.abs(a[0] - b[0]) <= TRANSFORM_EPSILON && Math.abs(a[1] - b[1]) <= TRANSFORM_EPSILON && Math.abs(a[2] - b[2]) <= TRANSFORM_EPSILON;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _euler = new THREE.Euler();
const sameRotation = (a: Vec3, b: Vec3) => {
    _qa.setFromEuler(_euler.set(a[0], a[1], a[2], 'XYZ'));
    _qb.setFromEuler(_euler.set(b[0], b[1], b[2], 'XYZ'));
    return Math.abs(_qa.dot(_qb)) >= 1 - TRANSFORM_EPSILON;
};

/** World matrix of an already resolved (world-space) object. */
const composeTransform = (object: LevelObject, target = new THREE.Matrix4()) => target.compose(
    new THREE.Vector3(...object.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(object.rotation[0], object.rotation[1], object.rotation[2], 'XYZ')),
    new THREE.Vector3(...object.scale),
);

/**
 * Transform of a drawn object group in level (world) space. Object groups are mounted directly
 * under the scene root, so their local matrix is their level-space transform.
 */
const levelMatrix = (node: THREE.Object3D) => {
    node.updateMatrix();
    return node.matrix;
};

/**
 * Level objects with world transforms: a child's local transform composed with its parent's
 * world matrix. Roots come back as-is; resolved children drop parentId so a consumer that
 * walks the hierarchy itself does not apply it twice. `cache` keeps unchanged children
 * referentially stable between renders.
 */
const resolveWorldObjects = (
    objects: LevelObject[],
    cache: Map<string, { source: LevelObject; resolved: LevelObject }>,
): LevelObject[] => {
    const ids = new Set(objects.map(object => object.id));
    const parentWorlds = new Map<string, THREE.Matrix4>();
    const local = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const live = new Set<string>();

    const resolved = objects.map(object => {
        const parentId = object.parentId;
        if (!parentId || parentId === object.id || !ids.has(parentId)) return object;
        let parentWorld = parentWorlds.get(parentId);
        if (!parentWorld) {
            parentWorld = getWorldMatrix(objects, parentId);
            parentWorlds.set(parentId, parentWorld);
        }
        local.compose(
            position.set(...object.position),
            quaternion.setFromEuler(euler.set(object.rotation[0], object.rotation[1], object.rotation[2], 'XYZ')),
            scale.set(...object.scale),
        );
        world.multiplyMatrices(parentWorld, local).decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion, 'XYZ');
        const worldPosition: Vec3 = [position.x, position.y, position.z];
        const worldRotation: Vec3 = [euler.x, euler.y, euler.z];
        const worldScale: Vec3 = [scale.x, scale.y, scale.z];

        live.add(object.id);
        const previous = cache.get(object.id);
        if (
            previous && previous.source === object
            && sameVec(previous.resolved.position, worldPosition)
            && sameVec(previous.resolved.rotation, worldRotation)
            && sameVec(previous.resolved.scale, worldScale)
        ) {
            return previous.resolved;
        }
        const next: LevelObject = { ...object, position: worldPosition, rotation: worldRotation, scale: worldScale, parentId: null };
        cache.set(object.id, { source: object, resolved: next });
        return next;
    });

    for (const id of Array.from(cache.keys())) {
        if (!live.has(id)) cache.delete(id);
    }
    return resolved;
};

/** The fields a gizmo drag with `tool` changed, or null when nothing moved. */
const transformUpdates = (tool: TransformTool, next: LocalTransform, current: LevelObject | undefined): Partial<LevelObject> | null => {
    const updates: Partial<LevelObject> = {};
    if (!current || !nearVec(next.position, current.position)) updates.position = next.position;
    if (tool === 'rotate' && (!current || !sameRotation(next.rotation, current.rotation))) updates.rotation = next.rotation;
    if (tool === 'scale' && (!current || !nearVec(next.scale, current.scale))) updates.scale = next.scale;
    return Object.keys(updates).length > 0 ? updates : null;
};

/** Registers the group behind `ref` under `id` while it is mounted. */
const useRegisteredNode = (id: string, register: RegisterNode) => {
    const ref = useRef<THREE.Group>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        register(id, node);
        return () => register(id, null, node);
    }, [id, register]);
    return ref;
};

// --- INTERACTION LAYER ---
interface InteractionLayerProps {
    activeModel: LoadedModelData | null;
    levelObjects: LevelObject[];
    onPlace: (position: THREE.Vector3, rotationY: number) => void;
    onSelectObject: (id: string | null) => void;
    isTransforming: boolean;
    enabled: boolean;
    snapEnabled: boolean;
    snapGrid: number;
    viewId: string;
    interactionMode: InteractionMode;
}

const InteractionLayer: React.FC<InteractionLayerProps> = ({
    activeModel,
    levelObjects,
    onPlace,
    onSelectObject,
    isTransforming,
    enabled,
    snapEnabled,
    snapGrid,
    viewId,
    interactionMode
}) => {
    const { camera, raycaster, pointer, scene } = useThree();
    const ghostRef = useRef<THREE.Group>(null);
    const planeRef = useRef<THREE.Mesh>(null);
    const [ghostRotation, setGhostRotation] = useState(0);
    const ghostObject = useMemo(() => activeModel ? activeModel.object.clone() : null, [activeModel]);
    const columnRay = useMemo(() => new THREE.Raycaster(), []);

    const planeConfig = useMemo(() => {
        const isPlaceMode = interactionMode === 'place' || interactionMode === 'paint';
        const bgOffset = 2000;

        switch (viewId) {
            case 'left':
                return {
                    position: new THREE.Vector3(isPlaceMode ? 0 : -bgOffset, 0, 0),
                    rotation: new THREE.Euler(0, Math.PI / 2, 0),
                    normal: new THREE.Vector3(1, 0, 0)
                };
            case 'right':
                return {
                    position: new THREE.Vector3(isPlaceMode ? 0 : bgOffset, 0, 0),
                    rotation: new THREE.Euler(0, Math.PI / 2, 0),
                    normal: new THREE.Vector3(1, 0, 0)
                };
            case 'bottom':
                return {
                    position: new THREE.Vector3(0, isPlaceMode ? 0 : bgOffset, 0),
                    rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
                    normal: new THREE.Vector3(0, 1, 0)
                };
            case 'top':
            case 'main':
            default:
                return {
                    position: new THREE.Vector3(0, isPlaceMode ? -0.01 : -bgOffset, 0),
                    rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
                    normal: new THREE.Vector3(0, 1, 0)
                };
        }
    }, [viewId, interactionMode]);

    const raycastPlane = useMemo(() => new THREE.Plane(planeConfig.normal, 0), [planeConfig.normal]);
    const planeIntersect = new THREE.Vector3();
    const snapValue = (value: number) => Math.round(value / snapGrid) * snapGrid;

    /** Where the ghost goes for the current pointer ray, or null when it points at nothing placeable. */
    const findPlacement = (): THREE.Vector3 | null => {
        const snap = snapEnabled && snapGrid > 0;

        if (planeConfig.normal.y > 0.5) {
            // Ground views land on terrain or level geometry, else on the y = 0 plane.
            const ignore: THREE.Object3D[] = [];
            if (ghostRef.current) ignore.push(ghostRef.current);
            if (planeRef.current) ignore.push(planeRef.current);
            const hit = raycastPlacement(raycaster, scene, levelObjects, { ignore });
            if (!hit) return null;
            const point = hit.point.clone();
            if (snap) {
                point.x = snapValue(point.x);
                point.z = snapValue(point.z);
                // Re-sample the surface under the snapped column so the object still sits on it.
                columnRay.set(new THREE.Vector3(point.x, hit.point.y + COLUMN_PROBE_HEIGHT, point.z), DOWN);
                columnRay.far = COLUMN_PROBE_HEIGHT * 2;
                const below = raycastPlacement(columnRay, scene, levelObjects, { ignore });
                point.y = below ? below.point.y : hit.point.y;
            }
            return point;
        }

        // Side views place on their vertical construction plane.
        if (!raycaster.ray.intersectPlane(raycastPlane, planeIntersect)) return null;
        const point = planeIntersect.clone();
        if (snap) {
            point.y = snapValue(point.y);
            point.z = snapValue(point.z);
            point.x = 0;
        }
        return point;
    };

    const handlePointerMove = () => {
        if (!enabled || isTransforming) {
            if (ghostRef.current) ghostRef.current.visible = false;
            return;
        }
        if (!ghostRef.current || !activeModel) return;

        raycaster.setFromCamera(pointer, camera);
        const point = findPlacement();
        if (point) {
            ghostRef.current.position.copy(point);
            ghostRef.current.rotation.set(0, ghostRotation, 0);
            ghostRef.current.visible = true;
        } else {
            ghostRef.current.visible = false;
        }
    };

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        if (isTransforming || gizmoPointer.owns()) return;

        if (enabled && activeModel && ghostRef.current && ghostRef.current.visible) {
            e.stopPropagation();
            onPlace(ghostRef.current.position.clone(), ghostRotation);
            return;
        }
        // Modifier clicks only add to the selection, and a click that landed on a level object
        // in front of this background plane is that object's click, not "select nothing".
        if (isAdditiveClick(e)) return;
        const front = e.intersections?.[0]?.object;
        if (front && front !== planeRef.current && typeof front.userData?.levelObjectId === 'string') return;
        onSelectObject(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (!activeModel || !enabled) return;
        if (e.key === 'r' || e.key === 'R') {
            setGhostRotation(prev => prev + (Math.PI / 4));
        }
    };

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeModel, enabled]);

    return (
        <>
            <mesh
                ref={planeRef}
                visible={enabled}
                onPointerMove={handlePointerMove}
                onClick={handleClick}
                rotation={planeConfig.rotation}
                position={planeConfig.position}
            >
                <planeGeometry args={[10000, 10000]} />
                <meshBasicMaterial visible={false} />
            </mesh>

            {ghostObject && enabled && (
                <group ref={ghostRef}>
                    <primitive
                        object={ghostObject}
                        opacity={0.5}
                        transparent
                    />
                    <mesh position={[0, 2.5, 0]}>
                        <boxGeometry args={[1, 5, 1]} />
                        <meshBasicMaterial color="#4ade80" wireframe transparent opacity={0.3} />
                    </mesh>
                </group>
            )}
        </>
    );
};

// --- OBJECT NODES ---

/**
 * A level object drawn in its own group at its world transform: markers (spawners, audio, sky,
 * player start) and selected props/foliage lifted out of instancing. The group is what the
 * transform gizmo drags, and component previews mount inside it in the object's local space.
 */
const LevelObjectNode = React.memo(({
    object,
    source,
    model,
    isSelected,
    selectable,
    onRegister,
    onSelect,
    hidden = false
}: {
    object: LevelObject,
    source: LevelObject,
    model?: LoadedModelData,
    isSelected: boolean,
    selectable: boolean,
    onRegister: RegisterNode,
    onSelect: SelectHandler,
    /** Hidden by an LOD Group or Distance Cull editor preview. */
    hidden?: boolean
}) => {
    const ref = useRegisteredNode(object.id, onRegister);

    return (
        <group
            ref={ref}
            position={object.position}
            rotation={object.rotation}
            scale={object.scale}
            // The object's own transform group, as a play session draws it, for what drives it (a timeline preview).
            userData={{ levelObjectId: object.id, modelId: object.modelId }}
            onClick={selectable ? (e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                onSelect(object.id, e);
            } : undefined}
        >
            <LevelObjectRenderer
                data={object}
                model={model}
                isSelected={isSelected}
                applyTransform={false}
                visible={!hidden}
            />
            <LevelComponentPreviews object={source} />
        </group>
    );
});

LevelObjectNode.displayName = 'LevelObjectNode';

/** Component previews of an object whose own geometry is drawn elsewhere (terrain, instanced props). */
const ComponentPreviewGroup: React.FC<{
    object: LevelObject;
    source: LevelObject;
    onRegister: RegisterNode;
    onClick?: (e: ThreeEvent<MouseEvent>) => void;
}> = ({ object, source, onRegister, onClick }) => {
    const ref = useRegisteredNode(object.id, onRegister);
    return (
        <group ref={ref} position={object.position} rotation={object.rotation} scale={object.scale} onClick={onClick}>
            <LevelComponentPreviews object={source} />
        </group>
    );
};

const TerrainInstance: React.FC<{ onRegister: RegisterNode } & React.ComponentPropsWithoutRef<typeof TerrainObject>> = ({ onRegister, ...props }) => {
    const ref = useRegisteredNode(props.data.id, onRegister);
    return <TerrainObject ref={ref} {...props} />;
};

// --- MAIN SCENE CONTENT ---
interface EnvironmentSceneProps {
    activeModel: LoadedModelData | null;
    interactionMode: InteractionMode;
    paintMode: PaintMode;
    onPlace: (pos: THREE.Vector3, rotY: number) => void;
    onPaint: (placements: FoliagePlacement[]) => Promise<unknown> | void;
    onErase: (ids: string[]) => Promise<unknown> | void;
    onSelectObject: (id: string | null) => void;
    /** Shift/Ctrl/Cmd-click; without it a modifier click selects like a plain click. */
    onToggleSelect?: (id: string) => void;
    models: LoadedModelData[];
    /** Objects as authored: transforms are local to `parentId`. */
    levelObjects: LevelObject[];
    updateLevelObject: (id: string, updates: Partial<LevelObject>) => void;
    transformSettings: TransformSettings;
    paintSettings?: PaintSettings;
    sculptSettings?: SculptSettings;
    onSnapshot: () => void;
    /** The primary selection: it carries the gizmo. */
    selectedId: string | null;
    /** Every selected object; selectedId is always treated as part of it. */
    selectedIds?: string[];
    gridRotation?: [number, number, number];
    viewId: string;
    activeViewId: string;
    isOrthographic?: boolean;
    isMuted: boolean;
    enableAudio?: boolean;
    /** The level's navmesh, drawn over the scene (Show navigation); null draws nothing. */
    navMesh?: LevelNavMesh | null;
}

interface DragState {
    primaryId: string;
    tool: TransformTool;
    startInverse: THREE.Matrix4;
    /** Selected objects without a selected ancestor: the ones whose transforms are written back. */
    roots: { id: string; parentId: string | null; startWorld: THREE.Matrix4 }[];
    /** Every other drawn group that moves with the drag (other selected objects, descendants, previews). */
    followers: { node: THREE.Object3D; startWorld: THREE.Matrix4 }[];
}

/** Keeps what a render starts from up to date with the view. */
const RenderViewTracker: React.FC = () => {
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const renderer = useThree(state => state.gl);
    useEffect(() => {
        renderView.scene = scene;
        renderView.camera = camera;
        renderView.renderer = renderer as unknown as THREE.WebGLRenderer;
    }, [scene, camera, renderer]);
    return null;
};

export const EnvironmentScene: React.FC<EnvironmentSceneProps> = ({
    activeModel,
    interactionMode,
    paintMode,
    onPlace,
    onPaint,
    onErase,
    onSelectObject,
    onToggleSelect,
    models,
    levelObjects,
    updateLevelObject,
    transformSettings,
    paintSettings,
    sculptSettings,
    onSnapshot,
    selectedId,
    selectedIds,
    gridRotation = [0, 0, 0],
    viewId,
    activeViewId,
    isOrthographic = false,
    isMuted,
    enableAudio = true,
    navMesh = null,
}) => {
    const { camera, controls } = useThree();
    const { audioAssets } = useAssets();
    const { levels, currentLevelId } = useLevel();
    const bakedLighting = levels.find(level => level.id === currentLevelId)?.bakedLighting;
    const [isTransforming, setIsTransforming] = useState(false);
    const [transformTarget, setTransformTarget] = useState<THREE.Object3D | null>(null);

    // Drawn groups by object id: object nodes (gizmo targets) and component preview groups.
    const nodesRef = useRef(new Map<string, THREE.Object3D>());
    const previewNodesRef = useRef(new Map<string, THREE.Object3D>());
    const selectedIdRef = useRef(selectedId);
    selectedIdRef.current = selectedId;

    const isShiftDown = useRef(false);
    const lastObjPos = useRef(new THREE.Vector3());
    const activeAxis = useRef<string | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const dragScratch = useMemo(() => ({ delta: new THREE.Matrix4(), world: new THREE.Matrix4() }), []);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => isShiftDown.current = e.shiftKey;
        window.addEventListener('keydown', handleKey);
        window.addEventListener('keyup', handleKey);
        return () => {
            window.removeEventListener('keydown', handleKey);
            window.removeEventListener('keyup', handleKey);
        };
    }, []);

    // --- Hierarchy: draw every object at its world transform ---
    const worldCache = useRef(new Map<string, { source: LevelObject; resolved: LevelObject }>());
    const resolvedObjects = useMemo(() => resolveWorldObjects(levelObjects, worldCache.current), [levelObjects]);
    const objectById = useMemo(() => new Map(levelObjects.map(object => [object.id, object])), [levelObjects]);
    const resolvedById = useMemo(() => new Map(resolvedObjects.map(object => [object.id, object])), [resolvedObjects]);
    const modelById = useMemo(() => new Map(models.map(model => [model.id, model])), [models]);
    const childrenById = useMemo(() => {
        const children = new Map<string, string[]>();
        for (const object of levelObjects) {
            const parentId = object.parentId;
            if (!parentId || parentId === object.id) continue;
            const siblings = children.get(parentId);
            if (siblings) siblings.push(object.id);
            else children.set(parentId, [object.id]);
        }
        return children;
    }, [levelObjects]);

    // LOD Group / Distance Cull components with "preview in editor" hide objects by camera distance.
    const { preview: lodPreview, hiddenIds: lodHiddenIds } = useLodEditorPreview(levelObjects);

    // --- Spline point editing: the selected object's spline, and whether one of its points has the gizmo ---
    const selectedSource = selectedId ? objectById.get(selectedId) : undefined;
    const selectedSpline = selectedSource ? findSplineComponent(selectedSource) : null;
    const splineSelection = useSplineSelection();
    const editingSplinePoint = Boolean(selectedSpline && splineSelection
        && splineSelection.objectId === selectedId && splineSelection.componentId === selectedSpline.id);

    // --- Selection ---
    const selection = useStableIdSet(selectedId ? [...(selectedIds ?? []), selectedId] : (selectedIds ?? []));
    const promotedIds = useStableIdSet(useMemo(() => {
        const ids = new Set<string>();
        const consider = (id: string | null) => {
            if (!id || ids.has(id) || ids.size >= MAX_SELECTION_PROXIES) return;
            const object = resolvedById.get(id);
            if (object && isInstancedObject(object)) ids.add(id);
        };
        // The primary first, so it always gets a proxy for the gizmo.
        consider(selectedId);
        selection.forEach(consider);
        return ids;
    }, [selection, selectedId, resolvedById]));

    // Latest selection callbacks behind a stable handler, so memoised nodes do not re-render.
    const selectCallbacks = useRef({ onSelectObject, onToggleSelect });
    selectCallbacks.current = { onSelectObject, onToggleSelect };
    const handleSelect = useCallback<SelectHandler>((id, event) => {
        // A press on a gizmo is a drag, not a click on what is behind it.
        if (gizmoPointer.owns()) return;
        const { onSelectObject: select, onToggleSelect: toggle } = selectCallbacks.current;
        if (toggle && isAdditiveClick(event)) toggle(id);
        else select(id);
    }, []);

    // --- Gizmo targets ---
    const registerNode = useCallback<RegisterNode>((id, node, owner) => {
        const nodes = nodesRef.current;
        if (node) nodes.set(id, node);
        else if (!owner || nodes.get(id) === owner) nodes.delete(id);
        if (id === selectedIdRef.current) setTransformTarget(nodes.get(id) ?? null);
    }, []);

    const registerPreview = useCallback<RegisterNode>((id, node, owner) => {
        const nodes = previewNodesRef.current;
        if (node) nodes.set(id, node);
        else if (!owner || nodes.get(id) === owner) nodes.delete(id);
    }, []);

    // Every selectable type registers a node (selected props/foliage through their proxy), so the
    // gizmo can attach to whatever is selected.
    useEffect(() => {
        setTransformTarget(selectedId ? nodesRef.current.get(selectedId) ?? null : null);
    }, [selectedId]);

    const beginDrag = (): DragState | null => {
        const target = transformTarget;
        if (!target || !selectedId) return null;
        const startInverse = levelMatrix(target).clone().invert();

        // Objects with a selected ancestor move with that ancestor; only the topmost are written.
        const roots: DragState['roots'] = [];
        selection.forEach(id => {
            const object = objectById.get(id);
            if (!object) return;
            const seen = new Set<string>([id]);
            let parentId = object.parentId;
            while (parentId && !seen.has(parentId)) {
                if (selection.has(parentId)) return;
                seen.add(parentId);
                parentId = objectById.get(parentId)?.parentId;
            }
            const resolved = resolvedById.get(id) ?? object;
            roots.push({ id, parentId: object.parentId ?? null, startWorld: composeTransform(resolved) });
        });

        // Everything drawn under the moving roots follows the gizmo live.
        const moving = new Set<string>();
        const queue = roots.map(root => root.id);
        while (queue.length > 0) {
            const id = queue.pop()!;
            if (moving.has(id)) continue;
            moving.add(id);
            for (const childId of childrenById.get(id) ?? []) queue.push(childId);
        }
        const followers: DragState['followers'] = [];
        moving.forEach(id => {
            for (const node of [nodesRef.current.get(id), previewNodesRef.current.get(id)]) {
                if (!node || node === target) continue;
                followers.push({ node, startWorld: levelMatrix(node).clone() });
            }
        });

        return { primaryId: selectedId, tool: transformSettings.tool, startInverse, roots, followers };
    };

    const onTransformMouseDown = (e: any) => {
        gizmoPointer.take();
        onSnapshot();
        setIsTransforming(true);
        if (transformTarget) {
            lastObjPos.current.copy(transformTarget.position);
        }
        if (e.target) {
            activeAxis.current = e.target.axis;
        }
        dragRef.current = beginDrag();
    };

    const onTransformChange = () => {
        if (!transformTarget) return;

        if (transformSettings.snapEnabled && isShiftDown.current && transformSettings.snapGrid > 0) {
            const grid = transformSettings.snapGrid;
            transformTarget.position.x = Math.round(transformTarget.position.x / grid) * grid;
            transformTarget.position.y = Math.round(transformTarget.position.y / grid) * grid;
            transformTarget.position.z = Math.round(transformTarget.position.z / grid) * grid;
        }

        const currentPos = transformTarget.position;
        const delta = new THREE.Vector3().subVectors(currentPos, lastObjPos.current);

        if (isTransforming && isShiftDown.current && controls) {
            const axis = activeAxis.current;
            if (axis === 'X' || axis === 'Y' || axis === 'Z') {
                if (delta.lengthSq() > 0.000001) {
                    camera.position.add(delta);
                    if ((controls as any).target) {
                        (controls as any).target.add(delta);
                    }
                }
            }
        }
        lastObjPos.current.copy(currentPos);

        // Carry the rest of the selection, children and previews along with the gizmo.
        const drag = dragRef.current;
        if (drag && drag.followers.length > 0) {
            dragScratch.delta.multiplyMatrices(levelMatrix(transformTarget), drag.startInverse);
            for (const follower of drag.followers) {
                dragScratch.world
                    .multiplyMatrices(dragScratch.delta, follower.startWorld)
                    .decompose(follower.node.position, follower.node.quaternion, follower.node.scale);
            }
        }
    };

    const onTransformEnd = () => {
        setIsTransforming(false);
        activeAxis.current = null;
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag || !transformTarget) return;

        const finalWorld = levelMatrix(transformTarget).clone();
        const delta = finalWorld.clone().multiply(drag.startInverse);
        for (const root of drag.roots) {
            const world = root.id === drag.primaryId ? finalWorld : new THREE.Matrix4().multiplyMatrices(delta, root.startWorld);
            // LevelObject transforms are local to their parent; a root's local transform is its
            // world transform, which needs no scene lookup.
            const local = root.parentId
                ? toLocalTransform(levelObjects, root.id, world, root.parentId)
                : toLocalTransform(NO_OBJECTS, root.id, world, null);
            const updates = transformUpdates(drag.tool, local, objectById.get(root.id));
            if (updates) updateLevelObject(root.id, updates);
        }
    };

    // Filter objects by type
    const { foliageObjects, propObjects, markerObjects, terrainObjects } = useMemo(() => {
        const foliage: LevelObject[] = [];
        const props: LevelObject[] = [];
        const markers: LevelObject[] = [];
        const terrains: LevelObject[] = [];
        resolvedObjects.forEach(obj => {
            if (obj.type === 'foliage') foliage.push(obj);
            else if (isMarkerObject(obj)) markers.push(obj);
            else if (obj.type === 'terrain') terrains.push(obj);
            else props.push(obj);
        });
        return { foliageObjects: foliage, propObjects: props, markerObjects: markers, terrainObjects: terrains };
    }, [resolvedObjects]);

    const promotedObjects = useMemo(
        () => Array.from(promotedIds, id => resolvedById.get(id)).filter((object): object is LevelObject => Boolean(object)),
        [promotedIds, resolvedById]
    );

    // While the Timeline editor previews a timeline, what it moves and poses is drawn on its own, as play draws it.
    const preview = useSyncExternalStore(timelinePreview.subscribe, timelinePreview.get, timelinePreview.get);
    const previewTargets = useMemo(() => (preview ? timelineTargetIds(preview.data).join('|') : ''), [preview]);
    const previewedObjects = useMemo(
        () => (previewTargets ? previewTargets.split('|') : [])
            .map(id => resolvedById.get(id))
            .filter((object): object is LevelObject => !!object && isInstancedObject(object) && !promotedIds.has(object.id)),
        [previewTargets, resolvedById, promotedIds]
    );
    const liftedIds = useStableIdSet(useMemo(() => [...promotedIds, ...previewedObjects.map(object => object.id)], [promotedIds, previewedObjects]));

    // Terrain and instanced objects draw their geometry elsewhere, so their components get a group of their own.
    const previewObjects = useMemo(
        () => resolvedObjects.filter(object => object.components?.length
            && (object.type === 'terrain' || (isInstancedObject(object) && !liftedIds.has(object.id)))),
        [resolvedObjects, liftedIds]
    );

    // Check if current view is active for interaction
    const isActiveView = viewId === activeViewId;
    const objectsInteractive = isActiveView && interactionMode !== 'place' && interactionMode !== 'paint';
    const highlightedIds = isActiveView ? selection : EMPTY_IDS;
    // Objects a foliage erase stroke has taken, hidden until the stroke is saved.
    const [erasingIds, setErasingIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
    const layerHiddenIds = useMemo(
        () => (lodHiddenIds.size || erasingIds.size ? new Set([...liftedIds, ...lodHiddenIds, ...erasingIds]) : liftedIds),
        [liftedIds, lodHiddenIds, erasingIds]
    );

    const handleInstancedSelect = useCallback((id: string, event: unknown) => {
        if (isActiveView) handleSelect(id, event);
    }, [isActiveView, handleSelect]);

    return (
        <LodEditorPreviewContext.Provider value={lodPreview}>
            {/* Dynamic Sky System */}
            <SkySystem levelObjects={resolvedObjects} />
            <RenderViewTracker />
            <LevelLightVolume bakedLighting={bakedLighting} />
            <LevelDynamicGi levelObjects={resolvedObjects} />
            <LightBakeRunner />

            {/* Grid */}
            <Grid
                position={[0, -0.01, 0]}
                rotation={gridRotation}
                infiniteGrid
                cellSize={1}
                sectionSize={5}
                fadeDistance={50}
                sectionColor="#444"
                cellColor="#222"
            />

            <NavMeshOverlay navMesh={navMesh} />

            {/* Audio System */}
            {enableAudio && <AudioSystem
                levelObjects={resolvedObjects}
                audioAssets={audioAssets}
                isMuted={isMuted}
            />}

            {/* Render Terrain */}
            {terrainObjects.map(terrain => (
                <TerrainInstance
                    key={terrain.id}
                    onRegister={registerNode}
                    data={terrain}
                    isSelected={selection.has(terrain.id) && isActiveView}
                    visible={!lodHiddenIds.has(terrain.id)}
                    receiveShadow
                    castShadow
                    onClick={(e) => {
                        // Like every other selection in this scene, only the active view selects.
                        if (isActiveView && !gizmoPointer.owns() && (interactionMode === 'select' || interactionMode === 'sculpt')) {
                            e.stopPropagation();
                            // Sculpt mode picks the sculpt target; it never builds a multi-selection.
                            if (interactionMode === 'select') handleSelect(terrain.id, e);
                            else onSelectObject(terrain.id);
                        }
                    }}
                    sculptingEnabled={interactionMode === 'sculpt' && selectedId === terrain.id && isActiveView}
                    sculptSettings={sculptSettings}
                    onHeightUpdate={(id, heights) => {
                        const source = objectById.get(id);
                        if (source) updateLevelObject(id, { terrainData: { ...source.terrainData!, heights } });
                    }}
                    onStrokeStart={onSnapshot}
                />
            ))}

            {/* Terrain Sculptor (Global Overlay Logic) */}
            {interactionMode === 'sculpt' && sculptSettings && (
                <TerrainSculptor
                    settings={sculptSettings}
                    onPaintStrokeEnd={(id, splat) => {
                        const terr = objectById.get(id);
                        if (terr) updateLevelObject(id, { terrainData: { ...terr.terrainData!, splat } });
                    }}
                    onStrokeStart={onSnapshot}
                    enabled={isActiveView}
                />
            )}

            {/* Render Foliage (Instanced) */}
            <InstancedLevelLayer
                models={models}
                levelObjects={foliageObjects}
                onSelect={handleInstancedSelect}
                interactive={objectsInteractive}
                hiddenIds={layerHiddenIds}
                selectedIds={highlightedIds}
            />

            {/* Render Props (Instanced) */}
            <InstancedLevelLayer
                models={models}
                levelObjects={propObjects}
                onSelect={handleInstancedSelect}
                interactive={objectsInteractive}
                hiddenIds={layerHiddenIds}
                selectedIds={highlightedIds}
            />

            {/* Render Unique Objects (Spawners, Audio, Sky, Player Start) */}
            {markerObjects.map(obj => (
                <LevelObjectNode
                    key={obj.id}
                    object={obj}
                    source={objectById.get(obj.id) ?? obj}
                    isSelected={selection.has(obj.id) && isActiveView}
                    selectable={true}
                    onRegister={registerNode}
                    onSelect={handleSelect}
                    hidden={lodHiddenIds.has(obj.id)}
                />
            ))}

            {/* Selected props/foliage, lifted out of their instanced layer so the gizmo can drag them */}
            {promotedObjects.map(obj => (
                <LevelObjectNode
                    key={obj.id}
                    object={obj}
                    source={objectById.get(obj.id) ?? obj}
                    model={modelById.get(obj.modelId)}
                    isSelected={isActiveView}
                    selectable={objectsInteractive}
                    onRegister={registerNode}
                    onSelect={handleSelect}
                    hidden={lodHiddenIds.has(obj.id)}
                />
            ))}

            {/* Objects a previewed timeline moves or poses, lifted out of their instanced layer */}
            {previewedObjects.map(obj => (
                <LevelObjectNode
                    key={obj.id}
                    object={obj}
                    source={objectById.get(obj.id) ?? obj}
                    model={modelById.get(obj.modelId)}
                    isSelected={false}
                    selectable={objectsInteractive}
                    onRegister={registerNode}
                    onSelect={handleSelect}
                    hidden={lodHiddenIds.has(obj.id)}
                />
            ))}

            {/* Component previews (lights, ...) of terrain and instanced objects */}
            {previewObjects.map(obj => (
                <ComponentPreviewGroup
                    key={obj.id}
                    object={obj}
                    source={objectById.get(obj.id) ?? obj}
                    onRegister={registerPreview}
                    onClick={objectsInteractive ? (e) => {
                        e.stopPropagation();
                        handleSelect(obj.id, e);
                    } : undefined}
                />
            ))}

            {/* Interaction Planes & Tools */}
            {isActiveView && (
                <>
                    <InteractionLayer
                        activeModel={activeModel}
                        levelObjects={resolvedObjects}
                        onPlace={onPlace}
                        onSelectObject={onSelectObject}
                        isTransforming={isTransforming}
                        enabled={interactionMode === 'place' || interactionMode === 'select'}
                        snapEnabled={transformSettings.snapEnabled}
                        snapGrid={transformSettings.snapGrid}
                        viewId={viewId}
                        interactionMode={interactionMode}
                    />

                    {interactionMode === 'paint' && paintSettings && (
                        <FoliageBrushTool
                            activeModel={activeModel}
                            mode={paintMode}
                            existingObjects={[...foliageObjects, ...propObjects]}
                            levelObjects={resolvedObjects}
                            settings={paintSettings}
                            onPaint={onPaint}
                            onErase={onErase}
                            onPendingEraseChange={setErasingIds}
                        />
                    )}

                    {/* The selected spline's points; a selected point takes the gizmo from the object */}
                    {selectedSource && selectedSpline && transformTarget && interactionMode === 'select' && (
                        <SplineEditOverlay
                            object={selectedSource}
                            component={selectedSpline}
                            node={transformTarget}
                            transformSettings={transformSettings}
                            updateLevelObject={updateLevelObject}
                            onSnapshot={onSnapshot}
                        />
                    )}

                    {/* Transform Gizmo */}
                    {selectedId && transformTarget && interactionMode === 'select' && !editingSplinePoint && (
                        <TransformControls
                            object={transformTarget}
                            mode={transformSettings.tool}
                            space={transformSettings.space}
                            onMouseDown={onTransformMouseDown}
                            onChange={onTransformChange}
                            onMouseUp={onTransformEnd}
                            translationSnap={transformSettings.snapEnabled && transformSettings.tool === 'translate' ? transformSettings.snapGrid : null}
                            rotationSnap={transformSettings.snapEnabled && transformSettings.tool === 'rotate' ? THREE.MathUtils.degToRad(transformSettings.snapAngle) : null}
                            scaleSnap={transformSettings.snapEnabled && transformSettings.tool === 'scale' ? transformSettings.snapGrid : null}
                            size={0.8}
                        />
                    )}
                </>
            )}
        </LodEditorPreviewContext.Provider>
    );
};
