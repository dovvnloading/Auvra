
import React, { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { View, PerspectiveCamera, OrthographicCamera, OrbitControls } from '@react-three/drei';
import { useAssets, useLevel } from '../../context/SceneContext';
import { LevelObject } from '../../types';
import { InteractionMode, PaintMode, PaintSettings, TransformSettings, ViewportLayout, SculptSettings } from './types';
import { EnvironmentScene } from './EnvironmentScene';
import type { FoliagePlacement } from './FoliageBrushTool';
import { editorSession } from '../../utils/editorSession';
import { raycastPlacement } from '../../utils/surfacePlacement';
import { getWorldMatrix } from '../../utils/sceneGraph';
import { MODEL_DRAG_TYPE } from '../UI/Browser/browserFolders';
import { frontendDiagnostics } from '../../diagnostics/runtime';

type FocusRequest = { id: string; nonce: number };

interface EnvironmentViewportProps {
    activeModelId: string | null;
    onSelectObject: (id: string | null) => void;
    /** Shift/Ctrl/Cmd-click in a view: add the object to, or drop it from, the selection. */
    onToggleSelect?: (id: string) => void;
    /** The editor's primary selection; it carries the gizmo. */
    selectedObjectId?: string | null;
    /** The editor's full selection (includes the primary). */
    selectedObjectIds?: string[];
    interactionMode: InteractionMode;
    paintMode?: PaintMode;
    transformSettings: TransformSettings;
    paintSettings?: PaintSettings;
    sculptSettings?: SculptSettings;
    layout?: ViewportLayout;
    cameraSpeed?: number;
    /** Frame this object in every view; a new request (nonce) re-frames the same object. */
    focusRequest?: FocusRequest | null;
    isMuted: boolean;
}

/** What a drop needs from a view: the camera that looks through it and the scene it renders. */
interface ViewHandle {
    camera: THREE.Camera;
    scene: THREE.Object3D;
}

// --- Camera tuning ---
const FLY_BASE_SPEED = 8; // world units per second at camera speed 1
const FLY_BOOST = 3; // Shift multiplier
const LOOK_SENSITIVITY = 0.0025; // radians per pixel of mouse travel
const MAX_PITCH = Math.PI / 2 - 0.01;
const MIN_ORBIT_DISTANCE = 0.5;
const FOCUS_DURATION = 0.25; // seconds
const FOCUS_PADDING = 1.25;
const MIN_FOCUS_RADIUS = 0.5;

/** Camera-local WASD; Q/E move along world up, as in Unreal. */
const FLY_KEYS: Readonly<Record<string, readonly [number, number, number]>> = {
    KeyW: [0, 0, -1],
    KeyS: [0, 0, 1],
    KeyA: [-1, 0, 0],
    KeyD: [1, 0, 0],
    KeyE: [0, 1, 0],
    KeyQ: [0, -1, 0],
};

const isTypingTarget = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== 'string') return false;
    return element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
};

const asOrbitControls = (controls: unknown): OrbitControlsImpl | null => {
    const candidate = controls as OrbitControlsImpl | null;
    return candidate && candidate.target instanceof THREE.Vector3 ? candidate : null;
};

/** Registers a view's camera and scene so DOM drops can raycast into it. */
const ViewBridge: React.FC<{ viewId: string; handles: React.MutableRefObject<Map<string, ViewHandle>> }> = ({ viewId, handles }) => {
    const camera = useThree(state => state.camera);
    const scene = useThree(state => state.scene);
    useEffect(() => {
        const registry = handles.current;
        const handle: ViewHandle = { camera, scene };
        registry.set(viewId, handle);
        return () => {
            if (registry.get(viewId) === handle) registry.delete(viewId);
        };
    }, [viewId, camera, scene, handles]);
    return null;
};

/**
 * Fly camera for the perspective view: hold the right mouse button and press
 * W/A/S/D (camera-relative) or Q/E (world down/up) to fly; the mouse then
 * looks around in place. A right-drag without those keys still orbits, and
 * releasing the button hands the camera back to OrbitControls, re-targeted in
 * front of the camera so the next orbit continues from the new viewpoint.
 */
const FlyCameraController: React.FC<{ track: React.RefObject<HTMLElement | null>; speed: number }> = ({ track, speed }) => {
    const camera = useThree(state => state.camera);
    const controls = asOrbitControls(useThree(state => state.controls));
    const speedRef = useRef(speed);
    speedRef.current = speed;
    const fly = useRef({ looking: false, flying: false, boost: false, keys: new Set<string>(), orbitDistance: 10 });
    const scratch = useMemo(() => ({ move: new THREE.Vector3(), euler: new THREE.Euler(0, 0, 0, 'YXZ') }), []);

    useEffect(() => {
        const element = track.current;
        if (!element) return;
        const state = fly.current;
        const view = element.ownerDocument.defaultView ?? window;

        const begin = () => {
            if (state.flying) return;
            state.flying = true;
            if (!controls) return;
            state.orbitDistance = Math.max(camera.position.distanceTo(controls.target), MIN_ORBIT_DISTANCE);
            // Settle any damped orbit motion now so it does not resume when orbiting comes back.
            const damping = controls.enableDamping;
            controls.enableDamping = false;
            controls.update();
            controls.enableDamping = damping;
            controls.enabled = false;
        };

        const end = () => {
            state.looking = false;
            state.keys.clear();
            if (!state.flying) return;
            state.flying = false;
            if (!controls) return;
            const forward = camera.getWorldDirection(new THREE.Vector3());
            controls.target.copy(camera.position).addScaledVector(forward, state.orbitDistance);
            controls.enabled = true;
            controls.update();
        };

        const onPointerDown = (event: PointerEvent) => {
            if (event.button === 2) state.looking = true;
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.button === 2) end();
        };
        const onPointerMove = (event: PointerEvent) => {
            state.boost = event.shiftKey;
            if (!state.flying) return;
            // The button was released somewhere we did not hear about (outside the window).
            if ((event.buttons & 2) === 0) {
                end();
                return;
            }
            const euler = scratch.euler.setFromQuaternion(camera.quaternion, 'YXZ');
            euler.y -= event.movementX * LOOK_SENSITIVITY;
            euler.x = THREE.MathUtils.clamp(euler.x - event.movementY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
            euler.z = 0;
            camera.quaternion.setFromEuler(euler);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            state.boost = event.shiftKey;
            if (!state.looking || !(event.code in FLY_KEYS)) return;
            if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
            // While flying, WASDQE drive the camera rather than the editor's tool hotkeys.
            event.preventDefault();
            event.stopPropagation();
            state.keys.add(event.code);
            begin();
        };
        const onKeyUp = (event: KeyboardEvent) => {
            state.boost = event.shiftKey;
            if (!state.keys.delete(event.code)) return;
            event.preventDefault();
            event.stopPropagation();
        };
        // OrbitControls stops suppressing the menu while disabled, so the viewport always does.
        const onContextMenu = (event: MouseEvent) => event.preventDefault();

        element.addEventListener('pointerdown', onPointerDown);
        element.addEventListener('contextmenu', onContextMenu);
        view.addEventListener('pointermove', onPointerMove);
        view.addEventListener('pointerup', onPointerUp);
        view.addEventListener('keydown', onKeyDown, true);
        view.addEventListener('keyup', onKeyUp, true);
        view.addEventListener('blur', end);
        return () => {
            element.removeEventListener('pointerdown', onPointerDown);
            element.removeEventListener('contextmenu', onContextMenu);
            view.removeEventListener('pointermove', onPointerMove);
            view.removeEventListener('pointerup', onPointerUp);
            view.removeEventListener('keydown', onKeyDown, true);
            view.removeEventListener('keyup', onKeyUp, true);
            view.removeEventListener('blur', end);
            end();
        };
    }, [camera, controls, track, scratch]);

    useFrame((_, delta) => {
        const state = fly.current;
        if (!state.flying || state.keys.size === 0) return;
        const move = scratch.move.set(0, 0, 0);
        let lift = 0;
        for (const code of state.keys) {
            const [x, y, z] = FLY_KEYS[code];
            move.x += x;
            move.z += z;
            lift += y;
        }
        move.applyQuaternion(camera.quaternion);
        move.y += lift;
        if (move.lengthSq() === 0) return;
        const rate = FLY_BASE_SPEED * speedRef.current * (state.boost ? FLY_BOOST : 1);
        camera.position.addScaledVector(move.normalize(), rate * Math.min(delta, 0.1));
    });

    return null;
};

const findLevelObjectNode = (node: THREE.Object3D, id: string): THREE.Object3D | null => {
    if (node.userData?.levelObjectId === id) return node;
    for (const child of node.children) {
        const found = findLevelObjectNode(child, id);
        if (found) return found;
    }
    return null;
};

/** World-space bounds of a level object: its rendered geometry, else its transform (e.g. instanced foliage). */
const focusBounds = (scene: THREE.Object3D, levelObjects: readonly LevelObject[], id: string): THREE.Sphere | null => {
    const node = findLevelObjectNode(scene, id);
    if (node) {
        const box = new THREE.Box3().setFromObject(node);
        if (!box.isEmpty() && Number.isFinite(box.min.x) && Number.isFinite(box.max.x)) {
            const sphere = box.getBoundingSphere(new THREE.Sphere());
            sphere.radius = Math.max(sphere.radius, MIN_FOCUS_RADIUS);
            return sphere;
        }
    }
    if (!levelObjects.some(object => object.id === id)) return null;
    const world = getWorldMatrix(levelObjects, id);
    const center = new THREE.Vector3().setFromMatrixPosition(world);
    return new THREE.Sphere(center, Math.max(world.getMaxScaleOnAxis(), MIN_FOCUS_RADIUS));
};

interface FocusAnimation {
    elapsed: number;
    fromPosition: THREE.Vector3;
    toPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromZoom: number;
    toZoom: number;
}

/** Frames the requested object's world bounds, keeping the current viewing direction. */
const FocusController: React.FC<{ focusRequest: FocusRequest | null | undefined; levelObjects: LevelObject[] }> = ({ focusRequest, levelObjects }) => {
    const camera = useThree(state => state.camera);
    const scene = useThree(state => state.scene);
    const size = useThree(state => state.size);
    const controls = asOrbitControls(useThree(state => state.controls));
    const levelObjectsRef = useRef(levelObjects);
    levelObjectsRef.current = levelObjects;
    // A request that predates this view (e.g. before a layout switch) is not replayed.
    const handledRef = useRef(focusRequest ?? null);
    const animation = useRef<FocusAnimation | null>(null);
    const target = useMemo(() => new THREE.Vector3(), []);

    useEffect(() => {
        if (!focusRequest || handledRef.current === focusRequest) return;
        handledRef.current = focusRequest;
        const bounds = focusBounds(scene, levelObjectsRef.current, focusRequest.id);
        if (!bounds) return;

        const forward = camera.getWorldDirection(new THREE.Vector3());
        const fromTarget = controls
            ? controls.target.clone()
            : camera.position.clone().addScaledVector(forward, camera.position.distanceTo(bounds.center));
        const offset = camera.position.clone().sub(fromTarget);
        if (offset.lengthSq() < 1e-8) offset.copy(forward).negate();

        const perspective = camera as THREE.PerspectiveCamera;
        const orthographic = camera as THREE.OrthographicCamera;
        let toPosition: THREE.Vector3;
        let toZoom = orthographic.isOrthographicCamera ? orthographic.zoom : 1;
        if (perspective.isPerspectiveCamera) {
            const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : perspective.aspect;
            const verticalFov = THREE.MathUtils.degToRad(perspective.fov);
            const fitFov = aspect < 1 ? 2 * Math.atan(Math.tan(verticalFov / 2) * aspect) : verticalFov;
            const distance = (bounds.radius / Math.sin(fitFov / 2)) * FOCUS_PADDING;
            toPosition = bounds.center.clone().addScaledVector(offset.normalize(), distance);
        } else {
            // Orthographic views keep their offset and fit the bounds through zoom (frustum is in pixels / zoom).
            toPosition = bounds.center.clone().add(offset);
            const viewport = Math.min(size.width, size.height);
            if (orthographic.isOrthographicCamera && viewport > 0) toZoom = viewport / (2 * bounds.radius * FOCUS_PADDING);
        }

        animation.current = {
            elapsed: 0,
            fromPosition: camera.position.clone(),
            toPosition,
            fromTarget,
            toTarget: bounds.center.clone(),
            fromZoom: orthographic.isOrthographicCamera ? orthographic.zoom : 1,
            toZoom,
        };
    }, [focusRequest, camera, scene, size, controls]);

    // Any manual camera input takes over from an in-flight focus.
    useEffect(() => {
        if (!controls) return;
        const cancel = () => { animation.current = null; };
        controls.addEventListener('start', cancel);
        return () => controls.removeEventListener('start', cancel);
    }, [controls]);

    useFrame((_, delta) => {
        const current = animation.current;
        if (!current) return;
        if (controls && !controls.enabled) {
            animation.current = null;
            return;
        }
        current.elapsed = Math.min(current.elapsed + delta, FOCUS_DURATION);
        const t = current.elapsed / FOCUS_DURATION;
        const eased = 1 - (1 - t) ** 3;
        camera.position.lerpVectors(current.fromPosition, current.toPosition, eased);
        target.lerpVectors(current.fromTarget, current.toTarget, eased);
        if (controls) controls.target.copy(target);
        camera.lookAt(target);
        const orthographic = camera as THREE.OrthographicCamera;
        if (orthographic.isOrthographicCamera) {
            orthographic.zoom = THREE.MathUtils.lerp(current.fromZoom, current.toZoom, eased);
            orthographic.updateProjectionMatrix();
        }
        if (t >= 1) animation.current = null;
    });

    return null;
};

/**
 * Meshes that are editor furniture rather than level geometry (placement
 * ghost, brush cursors, selection hit volumes): anything not under a node
 * tagged with a level object id. Instanced foliage stays a surface.
 */
const collectEditorOverlays = (root: THREE.Object3D): THREE.Object3D[] => {
    const overlays: THREE.Object3D[] = [];
    const visit = (node: THREE.Object3D) => {
        if (typeof node.userData?.levelObjectId === 'string') return;
        if ((node as THREE.Mesh).isMesh && !(node as THREE.InstancedMesh).isInstancedMesh) overlays.push(node);
        for (const child of node.children) visit(child);
    };
    visit(root);
    return overlays;
};

const ORIGIN = new THREE.Vector3();

/** Where a drop at (clientX, clientY) over `element` lands in the view's world. */
const dropPoint = (handle: ViewHandle, element: HTMLElement, clientX: number, clientY: number, levelObjects: LevelObject[]): THREE.Vector3 | null => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    handle.camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, handle.camera);
    const hit = raycastPlacement(raycaster, handle.scene, levelObjects, { ignore: collectEditorOverlays(handle.scene) });
    if (hit) return hit.point;
    // Side orthographic views look parallel to the ground: land on the plane through the origin facing the view.
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(raycaster.ray.direction.clone().negate(), ORIGIN);
    return raycaster.ray.intersectPlane(facing, new THREE.Vector3());
};

const isModelDrag = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes(MODEL_DRAG_TYPE);

// Internal component to handle view-specific scene rendering
const ViewportSceneContent: React.FC<{
    viewId: string;
    activeViewId: string;
    gridRotation?: [number, number, number];
    isOrthographic?: boolean;
    enableAudio?: boolean;
    sceneProps: any;
}> = ({ viewId, activeViewId, gridRotation, isOrthographic, enableAudio = true, sceneProps }) => {
    return (
        <EnvironmentScene
            {...sceneProps}
            viewId={viewId}
            activeViewId={activeViewId}
            gridRotation={gridRotation}
            isOrthographic={isOrthographic}
            enableAudio={enableAudio}
        />
    );
};

export const EnvironmentViewport: React.FC<EnvironmentViewportProps> = ({
    activeModelId,
    onSelectObject,
    onToggleSelect,
    selectedObjectId = null,
    selectedObjectIds,
    interactionMode,
    paintMode = 'add',
    transformSettings,
    paintSettings,
    sculptSettings,
    layout = 'single',
    cameraSpeed = 1.0,
    focusRequest = null,
    isMuted
}) => {
    const { models } = useAssets();
    const { levelObjects, addLevelObject, addLevelObjects, removeLevelObjects, updateLevelObject, snapshotHistory } = useLevel();
    const containerRef = useRef<HTMLDivElement>(null);

    // Active View State (the selection itself lives in the editor state)
    const [activeView, setActiveView] = useState<string>('main');
    const [isDropTarget, setIsDropTarget] = useState(false);

    // Refs for View tracking
    const viewMain = useRef<HTMLDivElement>(null);
    const viewTop = useRef<HTMLDivElement>(null);
    const viewBottom = useRef<HTMLDivElement>(null);
    const viewLeft = useRef<HTMLDivElement>(null);
    const viewRight = useRef<HTMLDivElement>(null);
    const viewHandles = useRef(new Map<string, ViewHandle>());

    const activeModel = useMemo(() =>
        activeModelId ? models.find(m => m.id === activeModelId) || null : null,
    [models, activeModelId]);

    const canEdit = () => editorSession.captureReady() !== null;

    // Selection is only drawn (and the gizmo only offered) in the tools that act on it.
    const showsSelection = interactionMode === 'select' || interactionMode === 'sculpt';

    const handleViewSelect = (id: string | null, viewId: string) => {
        if (!canEdit()) return;
        setActiveView(viewId);
        onSelectObject(id);
    };

    /** Per-view toggle handler, or undefined so a modifier click selects like a plain click. */
    const viewToggle = (viewId: string) => onToggleSelect
        ? (id: string) => {
            if (!canEdit()) return;
            setActiveView(viewId);
            onToggleSelect(id);
        }
        : undefined;

    const handlePlace = (pos: THREE.Vector3, rotY: number) => {
        if (!canEdit()) return;
        if (!activeModelId) return;
        addLevelObject(activeModelId, pos.toArray(), [0, rotY, 0], [1, 1, 1], 'prop');
    };

    // A whole paint or erase stroke is saved at once, as one undo step.
    const handlePaint = async (placements: FoliagePlacement[]) => {
        const model = activeModelId ? models.find(m => m.id === activeModelId) : undefined;
        if (!canEdit() || !model) return;
        try {
            await addLevelObjects(placements.map((placement): LevelObject => ({
                id: crypto.randomUUID(),
                levelId: '',
                modelId: model.id,
                name: `${model.name}_Foliage`,
                type: 'foliage',
                ...placement,
            })));
        } catch {
            // addLevelObjects has already reported the failure.
        }
    };

    const handleErase = async (ids: string[]) => {
        if (!canEdit()) return;
        await removeLevelObjects(ids);
    };

    // --- Content browser drag & drop ---
    const viewUnderPointer = (clientX: number, clientY: number): { viewId: string; element: HTMLElement } | null => {
        const tracked: [string, HTMLDivElement | null][] = layout === 'single'
            ? [['main', viewMain.current]]
            : [['left', viewLeft.current], ['right', viewRight.current], ['top', viewTop.current], ['bottom', viewBottom.current]];
        for (const [viewId, element] of tracked) {
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return { viewId, element };
        }
        return null;
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        if (!isModelDrag(event)) return;
        event.preventDefault();
        const editable = canEdit();
        event.dataTransfer.dropEffect = editable ? 'copy' : 'none';
        if (isDropTarget !== editable) setIsDropTarget(editable);
    };

    const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as Node | null;
        if (next && containerRef.current?.contains(next)) return;
        setIsDropTarget(false);
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        if (!isModelDrag(event)) return;
        event.preventDefault();
        setIsDropTarget(false);
        const modelId = event.dataTransfer.getData(MODEL_DRAG_TYPE);
        if (!canEdit() || !modelId || !models.some(model => model.id === modelId)) return;
        const target = viewUnderPointer(event.clientX, event.clientY);
        const handle = target ? viewHandles.current.get(target.viewId) : undefined;
        if (!target || !handle) return;
        const point = dropPoint(handle, target.element, event.clientX, event.clientY, levelObjects);
        if (!point) return;
        setActiveView(target.viewId);
        // addLevelObject snapshots history before inserting, so the drop is a single undo step.
        void addLevelObject(modelId, point.toArray(), [0, 0, 0], [1, 1, 1], 'prop')
            .then((id) => {
                if (id && interactionMode !== 'sculpt') handleViewSelect(id, target.viewId);
            })
            .catch((error: unknown) => frontendDiagnostics.failure('environment_viewport_drop_failed', error));
    };

    // Bundle props for the scene
    const baseSceneProps = {
        activeModel,
        interactionMode,
        paintMode,
        onPlace: handlePlace,
        onPaint: handlePaint,
        onErase: handleErase,
        models,
        levelObjects,
        updateLevelObject: (id: string, updates: Parameters<typeof updateLevelObject>[1]) => {
            if (canEdit()) updateLevelObject(id, updates);
        },
        transformSettings,
        paintSettings,
        sculptSettings,
        onSnapshot: () => { if (canEdit()) snapshotHistory(); },
        selectedId: showsSelection ? selectedObjectId : null,
        selectedIds: showsSelection ? selectedObjectIds : undefined,
        isMuted
    };

    // --- Control Configuration ---
    // UX Decision: Left Click is ALWAYS for Tools (Select, Paint, Sculpt).
    // Right Click is ALWAYS for Camera Rotation (orbit; hold it with WASD/QE to fly).
    const controlConfig = {
        mouseButtons: {
            LEFT: undefined as any, // Disable Left Click Rotation
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE
        }
    };

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full bg-[#111]"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >

            {/* HTML Layout Grid for View Tracking */}
            <div className="absolute inset-0 w-full h-full flex flex-col pointer-events-none">
                {layout === 'single' ? (
                    <div className="relative w-full h-full bg-[#111] pointer-events-auto border-b border-gray-800">
                        <div ref={viewMain} className="w-full h-full" onMouseDown={() => setActiveView('main')} />
                        <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'main' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                            PERSPECTIVE
                        </div>
                    </div>
                ) : (
                    <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-0.5 bg-gray-800 pointer-events-auto">
                        {/* 1. TOP LEFT -> LEFT View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewLeft} className="w-full h-full" onMouseDown={() => setActiveView('left')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'left' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                LEFT
                            </div>
                        </div>
                        {/* 2. TOP RIGHT -> RIGHT View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewRight} className="w-full h-full" onMouseDown={() => setActiveView('right')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'right' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                RIGHT
                            </div>
                        </div>
                        {/* 3. BOTTOM LEFT -> TOP View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewTop} className="w-full h-full" onMouseDown={() => setActiveView('top')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'top' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                TOP
                            </div>
                        </div>
                        {/* 4. BOTTOM RIGHT -> BOTTOM View */}
                        <div className="relative bg-[#111]">
                            <div ref={viewBottom} className="w-full h-full" onMouseDown={() => setActiveView('bottom')} />
                            <div className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none z-10 ${activeView === 'bottom' ? 'bg-blue-600 text-white' : 'bg-black/50 text-gray-500'}`}>
                                BOTTOM
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {isDropTarget && (
                <div className="absolute inset-0 z-20 pointer-events-none ring-2 ring-inset ring-blue-500/70 bg-blue-500/5" />
            )}

            {/* Shared Canvas */}
            <AuvraCanvas
                surfaceId="editor-environment-viewport"
                role="editor"
                className="absolute inset-0 pointer-events-none"
                eventSource={containerRef as React.MutableRefObject<HTMLElement>}
                shadows
            >
                {layout === 'single' && (
                    <View track={viewMain as React.MutableRefObject<HTMLElement>}>
                        <PerspectiveCamera makeDefault position={[10, 10, 10]} fov={45} />
                        <OrbitControls
                            makeDefault
                            panSpeed={cameraSpeed}
                            zoomSpeed={cameraSpeed}
                            mouseButtons={controlConfig.mouseButtons}
                        />
                        <FlyCameraController track={viewMain} speed={cameraSpeed} />
                        <FocusController focusRequest={focusRequest} levelObjects={levelObjects} />
                        <ViewBridge viewId="main" handles={viewHandles} />
                        <ViewportSceneContent
                            viewId="main"
                            activeViewId={activeView}
                            sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'main'), onToggleSelect: viewToggle('main')}}
                        />
                    </View>
                )}

                {layout === 'quad' && (
                    <>
                        <View track={viewLeft as React.MutableRefObject<HTMLElement>}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[50, 0, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <FocusController focusRequest={focusRequest} levelObjects={levelObjects} />
                            <ViewBridge viewId="left" handles={viewHandles} />
                            <ViewportSceneContent
                                viewId="left"
                                activeViewId={activeView}
                                gridRotation={[0, 0, -Math.PI / 2]}
                                isOrthographic
                                enableAudio
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'left'), onToggleSelect: viewToggle('left')}}
                            />
                        </View>

                        <View track={viewRight as React.MutableRefObject<HTMLElement>}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[-50, 0, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <FocusController focusRequest={focusRequest} levelObjects={levelObjects} />
                            <ViewBridge viewId="right" handles={viewHandles} />
                            <ViewportSceneContent
                                viewId="right"
                                activeViewId={activeView}
                                gridRotation={[0, 0, Math.PI / 2]}
                                isOrthographic
                                enableAudio={false}
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'right'), onToggleSelect: viewToggle('right')}}
                            />
                        </View>

                        <View track={viewTop as React.MutableRefObject<HTMLElement>}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[0, 50, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <FocusController focusRequest={focusRequest} levelObjects={levelObjects} />
                            <ViewBridge viewId="top" handles={viewHandles} />
                            <ViewportSceneContent
                                viewId="top"
                                activeViewId={activeView}
                                isOrthographic
                                enableAudio={false}
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'top'), onToggleSelect: viewToggle('top')}}
                            />
                        </View>

                        <View track={viewBottom as React.MutableRefObject<HTMLElement>}>
                            <ambientLight intensity={0.8} />
                            <OrthographicCamera makeDefault position={[0, -50, 0]} zoom={20} near={-100} far={100} />
                            <OrbitControls makeDefault enableRotate={false} panSpeed={cameraSpeed} zoomSpeed={cameraSpeed} mouseButtons={controlConfig.mouseButtons} />
                            <FocusController focusRequest={focusRequest} levelObjects={levelObjects} />
                            <ViewBridge viewId="bottom" handles={viewHandles} />
                            <ViewportSceneContent
                                viewId="bottom"
                                activeViewId={activeView}
                                gridRotation={[Math.PI, 0, 0]}
                                isOrthographic
                                enableAudio={false}
                                sceneProps={{...baseSceneProps, onSelectObject: (id: string | null) => handleViewSelect(id, 'bottom'), onToggleSelect: viewToggle('bottom')}}
                            />
                        </View>
                    </>
                )}
            </AuvraCanvas>
        </div>
    );
};
