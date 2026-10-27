import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { createPortal, useFrame, useStore, useThree, type RootState } from '@react-three/fiber';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { Grid, OrbitControls, ContactShadows } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Crosshair, Pause, Play, RotateCcw, StepForward } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { AnimationGraphData, GraphTransition, LoadedModelData } from '../../types';
import { GraphRuntime, type GraphRuntimeAPI } from './GraphRuntime';
import { ANIMATION_FRAME_PRIORITY } from './hooks/useGraphAnimator';
import { conditionsMet, transitionAppliesTo } from './utils/transitions';
import { AttachmentController } from '../Scene/AttachmentController';
import { SocketController, resolveSocketFlashTextureUrl } from '../Scene/SocketController';
import { LocalEnvironment } from '../Scene/LocalEnvironment';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** What the preview can show: no model, a model without clips, or a running graph (paused or live). */
export type PreviewStatus = 'no-mesh' | 'no-clips' | 'paused' | 'live';

/** Badge text per status, with a hint when the user has something to fix. */
export const PREVIEW_STATUS_TEXT: Record<PreviewStatus, { label: string; hint: string | null }> = {
    'no-mesh': { label: 'No mesh linked', hint: 'Link a mesh to this blueprint (Blueprints tab, Linked Mesh) to preview the graph here.' },
    'no-clips': { label: 'No clips', hint: 'This model has no animation clips. Import an animated model to preview its states.' },
    paused: { label: 'Paused', hint: null },
    live: { label: 'Live', hint: null },
};

/** The preview's status from what it has to show and whether playback is paused. */
export const previewStatus = (hasModel: boolean, clipCount: number, paused: boolean): PreviewStatus => {
    if (!hasModel) return 'no-mesh';
    if (clipCount === 0) return 'no-clips';
    return paused ? 'paused' : 'live';
};

/** The state a fresh runtime starts in: the root state, else the first one. */
export const entryStateId = (graph: AnimationGraphData): string | null =>
    (graph.states.find(state => state.isRoot) ?? graph.states[0])?.id ?? null;

const transitionPriority = (transition: GraphTransition): number =>
    typeof transition.priority === 'number' && Number.isFinite(transition.priority) ? transition.priority : 0;

/**
 * The transition the runtime most likely took from `fromId` to `toId`: among the transitions that
 * apply to `fromId` and lead to `toId`, the ones whose conditions pass under `variables` (when
 * any do), then the highest priority, ties keeping list order. Null when none leads there.
 */
export const findFiredTransition = (
    transitions: GraphTransition[],
    fromId: string,
    toId: string,
    variables?: Record<string, number | boolean>
): GraphTransition | null => {
    const candidates = transitions.filter(transition => transition.toStateId === toId && transitionAppliesTo(transition, fromId));
    if (candidates.length <= 1) return candidates[0] ?? null;
    const ready = variables ? candidates.filter(transition => conditionsMet(transition, variables)) : [];
    const pool = ready.length ? ready : candidates;
    return pool.reduce((best, transition) => (transitionPriority(transition) > transitionPriority(best) ? transition : best));
};

/** Slowest and fastest preview playback speed. */
export const PREVIEW_MIN_SPEED = 0.1;
export const PREVIEW_MAX_SPEED = 2;
/** Animation time one Step press advances while paused (one 30 fps frame). */
export const PREVIEW_STEP_SECONDS = 1 / 30;
// A runtime restarted while paused gets a few hair-thin frames so its entry state blends in
// instead of leaving the model in its rest pose until the user plays or steps.
const SETTLE_FRAMES = 10;
const SETTLE_SECONDS = 1e-4;
// How often the preview checks the runtime's active state for changes it did not report.
const ACTIVE_STATE_POLL_MS = 250;

/** Clamps a playback speed to PREVIEW_MIN_SPEED..PREVIEW_MAX_SPEED; anything not finite is 1x. */
export const clampPreviewSpeed = (speed: number): number =>
    Number.isFinite(speed) ? Math.min(PREVIEW_MAX_SPEED, Math.max(PREVIEW_MIN_SPEED, speed)) : 1;

/** Playback state shared by the transport buttons and the preview's frame loop. */
export interface PreviewClock {
    paused: boolean;
    /** Playback speed multiplier. */
    rate: number;
    /** Seconds the next frame advances while paused (a Step press). */
    pendingStep: number;
    /** Paused frames that still advance by SETTLE_SECONDS. */
    settleFrames: number;
    /** This frame's preview delta, written before any runtime frame callback runs. */
    frameDelta: number;
}

/** A running clock at 1x. */
export const createPreviewClock = (): PreviewClock => ({ paused: false, rate: 1, pendingStep: 0, settleFrames: 0, frameDelta: 0 });

/**
 * The preview delta for a frame that took `delta` real seconds: a pending step if there is one,
 * the scaled real delta while playing, and nothing while paused (bar settle frames).
 */
export const advancePreviewClock = (clock: PreviewClock, delta: number): number => {
    if (clock.pendingStep > 0) {
        const step = clock.pendingStep;
        clock.pendingStep = 0;
        return step;
    }
    if (!clock.paused) {
        clock.settleFrames = 0;
        return (Number.isFinite(delta) && delta > 0 ? delta : 0) * clock.rate;
    }
    if (clock.settleFrames > 0) {
        clock.settleFrames -= 1;
        return SETTLE_SECONDS;
    }
    return 0;
};

interface NodePose {
    node: THREE.Object3D;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
}

/** A model cloned for the preview, with the materials and textures it owns and its starting pose. */
export interface PreviewResources {
    object: THREE.Group;
    materials: Set<THREE.Material>;
    textures: Set<THREE.Texture>;
    baseMaps: Map<THREE.Material, THREE.Texture | null>;
    /** Every node's transform as cloned, so restart and unmount can put the model back. */
    pose: NodePose[];
}

/** Clone a model for the preview without sharing mutable material state. */
export const clonePreviewResources = (source: THREE.Object3D): PreviewResources => {
    const resources: PreviewResources = {
        object: cloneSkeleton(source) as THREE.Group,
        materials: new Set(),
        textures: new Set(),
        baseMaps: new Map(),
        pose: [],
    };
    resources.object.traverse((child) => {
        resources.pose.push({ node: child, position: child.position.clone(), quaternion: child.quaternion.clone(), scale: child.scale.clone() });
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const previewMaterials = sourceMaterials.map((sourceMaterial) => {
            const material = sourceMaterial.clone();
            resources.materials.add(material);
            for (const key of Object.keys(material)) {
                const value = (material as unknown as Record<string, unknown>)[key];
                if (!value || typeof value !== 'object' || !(value as THREE.Texture).isTexture) continue;
                const texture = (value as THREE.Texture).clone();
                texture.needsUpdate = true;
                resources.textures.add(texture);
                (material as unknown as Record<string, unknown>)[key] = texture;
            }
            if ('map' in material) resources.baseMaps.set(material, (material as THREE.MeshStandardMaterial).map ?? null);
            return material;
        });
        mesh.material = Array.isArray(mesh.material) ? previewMaterials : previewMaterials[0];
    });
    return resources;
};

/**
 * Puts the preview model back the way it was cloned: the root's position and rotation and every
 * descendant's transform. The root's scale belongs to the primitive's scale prop and is kept.
 */
export const restorePreviewPose = (resources: PreviewResources): void => {
    for (const { node, position, quaternion, scale } of resources.pose) {
        node.position.copy(position);
        node.quaternion.copy(quaternion);
        if (node !== resources.object) node.scale.copy(scale);
    }
};

const disposePreviewResources = (resources: PreviewResources): void => {
    for (const material of resources.materials) material.dispose();
    for (const texture of resources.textures) texture.dispose();
    resources.materials.clear();
    resources.textures.clear();
    resources.baseMaps.clear();
    resources.pose.length = 0;
};

type FrameSubscribe = RootState['internal']['subscribe'];

/**
 * Renders its children through a portal whose frame callbacks receive the preview clock's delta
 * instead of the real frame time. Pause, step and speed reach the animation runtime this way,
 * while orbit controls and the renderer's frame metrics stay on real time.
 */
export const PreviewTimeScope: React.FC<{ clock: PreviewClock; children: React.ReactNode }> = ({ clock, children }) => {
    const store = useStore();
    const [container] = useState(() => new THREE.Group());
    const inject = useMemo(() => {
        const subscribe: FrameSubscribe = (ref, priority, subscriber) => store.getState().internal.subscribe(
            { current: (state, _delta, frame) => ref.current(state, clock.frameDelta, frame) },
            priority,
            subscriber
        );
        // Everything but subscribe reads the root's current internals (R3F replaces that object).
        const internal = new Proxy({} as RootState['internal'], {
            get: (_target, key) => (key === 'subscribe' ? subscribe : Reflect.get(store.getState().internal, key)),
        });
        return { internal };
    }, [store, clock]);
    return createPortal(children, container, inject);
};

/** Writes each frame's preview delta (see advancePreviewClock) before any runtime frame callback reads it. */
export const PreviewClockDriver: React.FC<{ clock: PreviewClock }> = ({ clock }) => {
    useFrame((_state, delta) => {
        clock.frameDelta = advancePreviewClock(clock, delta);
    }, ANIMATION_FRAME_PRIORITY - 1);
    return null;
};

interface PreviewSessionProps {
    resources: PreviewResources;
    graph: AnimationGraphData;
    allClips: THREE.AnimationClip[];
    clock: PreviewClock;
    apiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    onStart: () => void;
    onActiveStateChange: (id: string) => void;
}

/**
 * One run of the graph on the preview model. Remounting it (restart, another graph) starts the
 * runtime over in its entry state with the variables' initial values; unmounting it puts the
 * model back where it was cloned and withdraws the runtime API.
 */
const PreviewSession: React.FC<PreviewSessionProps> = ({ resources, graph, allClips, clock, apiRef, onStart, onActiveStateChange }) => {
    // Start and end exactly once per mount; the key, not these props, decides when a run is over.
    const startRef = useRef({ clock, apiRef, onStart });
    startRef.current = { clock, apiRef, onStart };
    useLayoutEffect(() => {
        const session = startRef.current;
        if (session.clock.paused) session.clock.settleFrames = SETTLE_FRAMES;
        session.onStart();
        return () => {
            startRef.current.apiRef.current = undefined;
            restorePreviewPose(resources);
        };
    }, [resources]);

    return (
        <PreviewTimeScope clock={clock}>
            <GraphRuntime
                modelObject={resources.object}
                graph={graph}
                allClips={allClips}
                enableInputs={true}
                onActiveStateChange={onActiveStateChange}
                apiRef={apiRef}
            />
        </PreviewTimeScope>
    );
};

// Without measurable bounds the camera frames the model's origin raised to about chest height.
const FOCUS_OFFSET = new THREE.Vector3(0, 1, 0);
// Share of the remaining distance the camera closes on the model each frame while following.
const FOLLOW_LERP = 0.1;
const MIN_FRAMING_DISTANCE = 2;
const MAX_FRAMING_DISTANCE = 15;
// Room left around a model framed by its bounds.
const FRAMING_MARGIN = 1.15;

// Bones run through the middle of the body; the skin and the head reach past them.
const SKELETON_PADDING = 1.2;

const _bounds = new THREE.Box3();
const _point = new THREE.Vector3();

/**
 * The model's bounding sphere, or null when it has nothing to measure. A skinned model is
 * measured by its bones: its meshes' bounds depend on bone matrices that are only right once
 * the model has been drawn.
 */
const measureModel = (object: THREE.Object3D, out: THREE.Sphere): THREE.Sphere | null => {
    object.updateWorldMatrix(true, true);
    _bounds.makeEmpty();
    object.traverse((child) => {
        if ((child as THREE.Bone).isBone) _bounds.expandByPoint(child.getWorldPosition(_point));
    });
    const skinned = !_bounds.isEmpty();
    if (!skinned) _bounds.setFromObject(object);
    if (_bounds.isEmpty()) return null;
    _bounds.getBoundingSphere(out);
    if (skinned) out.radius *= SKELETON_PADDING;
    return out;
};

const modelFocus = (object: THREE.Object3D, offset: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => {
    object.updateWorldMatrix(true, false);
    return object.getWorldPosition(out).add(offset);
};

/**
 * Orbit camera for the preview. It frames the model when the model appears, looking from the
 * main viewport's direction at the middle of its bounds from far enough to see all of it, and
 * then leaves the view to the user; with `follow` on, the target and the camera move with the model.
 */
const PreviewCamera: React.FC<{ targetObject: THREE.Object3D; follow: boolean }> = ({ targetObject, follow }) => {
    const { cameraState } = useScene();
    const camera = useThree(state => state.camera);
    const controlsRef = useRef<OrbitControlsImpl>(null);
    const focus = useRef(new THREE.Vector3());
    // From the model's origin to the point the camera looks at.
    const focusOffset = useRef(FOCUS_OFFSET.clone());
    const step = useRef(new THREE.Vector3());
    // The main view's direction when the preview opened; later main-view moves do not reframe.
    const initialView = useRef(cameraState);

    useEffect(() => {
        const controls = controlsRef.current;
        if (!controls) return;
        const { position, target } = initialView.current;
        const offset = new THREE.Vector3(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
        if (offset.lengthSq() < 1e-6) offset.set(4, 3, 8);
        let distance = THREE.MathUtils.clamp(offset.length(), MIN_FRAMING_DISTANCE, MAX_FRAMING_DISTANCE);
        const bounds = measureModel(targetObject, new THREE.Sphere());
        if (bounds) {
            focusOffset.current.copy(bounds.center).sub(targetObject.getWorldPosition(focus.current));
            const halfFov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 45) / 2;
            distance = Math.max(distance, (bounds.radius / Math.sin(halfFov)) * FRAMING_MARGIN);
        } else {
            focusOffset.current.copy(FOCUS_OFFSET);
        }
        offset.setLength(distance);
        modelFocus(targetObject, focusOffset.current, focus.current);
        controls.target.copy(focus.current);
        camera.position.copy(focus.current).add(offset);
        controls.update();
    }, [camera, targetObject]);

    useFrame(() => {
        const controls = controlsRef.current;
        if (!follow || !controls) return;
        modelFocus(targetObject, focusOffset.current, focus.current);
        step.current.subVectors(focus.current, controls.target).multiplyScalar(FOLLOW_LERP);
        controls.target.add(step.current);
        camera.position.add(step.current);
    });

    return (
        <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping={true}
            dampingFactor={0.1}
        />
    );
};

const STATUS_STYLE: Record<PreviewStatus, { text: string; dot: string }> = {
    'no-mesh': { text: 'text-gray-300', dot: 'bg-gray-500' },
    'no-clips': { text: 'text-amber-300', dot: 'bg-amber-500' },
    paused: { text: 'text-amber-300', dot: 'bg-amber-400' },
    live: { text: 'text-green-400', dot: 'bg-green-500 animate-pulse' },
};

/** The preview's status pill (top left), with a hint when there is nothing to play. */
export const PreviewStatusBadge: React.FC<{ status: PreviewStatus; modelName?: string }> = ({ status, modelName }) => {
    const { label, hint } = PREVIEW_STATUS_TEXT[status];
    const style = STATUS_STYLE[status];
    return (
        <div className="absolute top-4 left-4 z-10 flex flex-col items-start gap-1.5 max-w-[70%] pointer-events-none">
            <div role="status" className={`bg-gray-900/80 backdrop-blur px-3 py-1.5 rounded-full text-[10px] font-bold border border-gray-700 flex items-center gap-2 shadow-lg ${style.text}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`}></span>
                <span className="uppercase tracking-wider">{label}</span>
                {modelName && status !== 'no-mesh' && <span className="font-normal text-gray-400 truncate">{modelName}</span>}
            </div>
            {hint && (
                <p className="bg-gray-900/80 backdrop-blur px-3 py-1.5 rounded-lg text-[10px] text-gray-400 border border-gray-800 shadow-lg">
                    {hint}
                </p>
            )}
        </div>
    );
};

// Transport clicks keep keyboard focus where it was, so the preview's key bindings keep working.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const transportButton = 'flex items-center justify-center gap-1.5 h-7 px-2 rounded-full text-[10px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

interface PreviewTransportProps {
    paused: boolean;
    speed: number;
    follow: boolean;
    onTogglePause: () => void;
    onStep: () => void;
    onRestart: () => void;
    onSpeedChange: (speed: number) => void;
    onToggleFollow: () => void;
}

/** Play/pause, single-frame step, restart, playback speed and the follow-camera toggle. */
export const PreviewTransport: React.FC<PreviewTransportProps> = ({
    paused,
    speed,
    follow,
    onTogglePause,
    onStep,
    onRestart,
    onSpeedChange,
    onToggleFollow
}) => (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 bg-gray-900/85 backdrop-blur px-1.5 py-1 rounded-full border border-gray-700 shadow-lg text-gray-300">
        <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onTogglePause}
            className={`${transportButton} w-7 px-0 hover:bg-gray-700 hover:text-white`}
            aria-label={paused ? 'Play preview' : 'Pause preview'}
            title={paused ? 'Play' : 'Pause'}
        >
            {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
        <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onStep}
            disabled={!paused}
            className={`${transportButton} w-7 px-0 hover:bg-gray-700 hover:text-white disabled:hover:bg-transparent`}
            aria-label="Step one frame"
            title="Step one frame (while paused)"
        >
            <StepForward size={12} />
        </button>
        <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onRestart}
            className={`${transportButton} w-7 px-0 hover:bg-gray-700 hover:text-white`}
            aria-label="Restart preview"
            title="Restart: model back to its start position, graph back to its entry state"
        >
            <RotateCcw size={12} />
        </button>
        <div className="w-px h-4 bg-gray-700 mx-1"></div>
        <input
            type="range"
            min={PREVIEW_MIN_SPEED}
            max={PREVIEW_MAX_SPEED}
            step={0.05}
            value={speed}
            onChange={(e) => onSpeedChange(clampPreviewSpeed(parseFloat(e.target.value)))}
            className="w-20 accent-blue-500 cursor-pointer"
            aria-label="Playback speed"
        />
        <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onSpeedChange(1)}
            className={`${transportButton} w-11 font-mono hover:bg-gray-700 hover:text-white`}
            aria-label="Reset playback speed"
            title="Back to 1x"
        >
            {speed.toFixed(2)}x
        </button>
        <div className="w-px h-4 bg-gray-700 mx-1"></div>
        <button
            type="button"
            onMouseDown={keepFocus}
            onClick={onToggleFollow}
            aria-pressed={follow}
            className={`${transportButton} ${follow ? 'bg-blue-600 text-white hover:bg-blue-500' : 'hover:bg-gray-700 hover:text-white'}`}
            aria-label="Follow model"
            title={follow ? 'Camera follows the model' : 'Camera stays put; orbit freely'}
        >
            <Crosshair size={12} /> Follow
        </button>
    </div>
);

/** Props of the animation graph preview. */
export interface GraphPreviewProps {
    graph?: AnimationGraphData;
    allClips: THREE.AnimationClip[];
    /** The model to preview; null means none (no fallback), omitted means the scene's selected model. */
    model?: LoadedModelData | null;
    /** Optional scaling multiplier. */
    scale?: number;
    /** Optional texture override. */
    textureUrl?: string | null;
    /** Shows the status badge and the transport (play/pause, step, speed, restart, follow camera). */
    controls?: boolean;
    /** Holds the live runtime API while the preview runs; cleared when the run ends. */
    apiRef?: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    /** The runtime's active state: the entry state when a run starts, then every state it enters. */
    onActiveStateChange?: (stateId: string) => void;
    /** The transition the runtime took into its new active state, reported just before onActiveStateChange. */
    onTransitionFired?: (transitionId: string) => void;
    /** Called with the status whenever it changes. */
    onStatusChange?: (status: PreviewStatus) => void;
    /** Changing it starts a new run, e.g. when the editor opens another graph on the same model. */
    resetKey?: string;
}

export const GraphPreview: React.FC<GraphPreviewProps> = ({
    graph: propGraph,
    allClips,
    model,
    scale = 1.0,
    textureUrl,
    controls = false,
    apiRef,
    onActiveStateChange,
    onTransitionFired,
    onStatusChange,
    resetKey = ''
}) => {
    const { models, selectedModelId, graphData, attachments, sockets, flashTriggers, textures } = useScene();
    
    // Determine which model to show. 
    // Priority: Explicit prop (from BlueprintEditor / GraphEditor) > Global Selection (legacy callers).
    // An explicit null is a graph with no linked mesh, which must not borrow the selected model.
    const targetModel = model === null ? undefined : (model || models.find(m => m.id === selectedModelId));
    
    // If graph is provided as prop (e.g. from Blueprint Editor), use it. 
    // Otherwise fall back to global context graphData (legacy).
    const graph = propGraph || (targetModel && graphData[targetModel.id]);
    const previewResources = useMemo(
        () => targetModel?.object ? clonePreviewResources(targetModel.object) : null,
        [targetModel?.id, targetModel?.object],
    );
    const displayObject = previewResources?.object;

    // Every run starts in the entry state, whatever activeStateId was persisted with the graph.
    const runtimeGraph = useMemo(
        () => graph ? { ...graph, activeStateId: entryStateId(graph) } : undefined,
        [graph],
    );

    // --- Transport ---
    const [clock] = useState(createPreviewClock);
    const [paused, setPaused] = useState(false);
    const [speed, setSpeed] = useState(1);
    // With the transport the camera starts free (the user orbits); without it, nothing could turn
    // following on, so the camera keeps tracking the model as it always has.
    const [follow, setFollow] = useState(!controls);
    const [run, setRun] = useState(0);
    useLayoutEffect(() => {
        clock.paused = paused;
        clock.rate = speed;
    }, [clock, paused, speed]);
    const togglePause = useCallback(() => setPaused(value => !value), []);
    const step = useCallback(() => { clock.pendingStep = PREVIEW_STEP_SECONDS; }, [clock]);
    const restart = useCallback(() => setRun(value => value + 1), []);
    const toggleFollow = useCallback(() => setFollow(value => !value), []);

    // --- Live state reporting ---
    const ownApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const runtimeApiRef = apiRef ?? ownApiRef;
    const graphRef = useRef(graph);
    graphRef.current = graph;
    const callbacksRef = useRef({ onActiveStateChange, onTransitionFired, onStatusChange });
    callbacksRef.current = { onActiveStateChange, onTransitionFired, onStatusChange };
    const activeRef = useRef<string | null>(null);

    const handleSessionStart = useCallback(() => {
        const current = graphRef.current;
        const entry = current ? entryStateId(current) : null;
        activeRef.current = entry;
        if (entry) callbacksRef.current.onActiveStateChange?.(entry);
    }, []);

    const handleRuntimeStateChange = useCallback((id: string) => {
        const from = activeRef.current;
        activeRef.current = id;
        const current = graphRef.current;
        const fired = current && from ? findFiredTransition(current.transitions, from, id, runtimeApiRef.current?.getVariables()) : null;
        if (fired) callbacksRef.current.onTransitionFired?.(fired.id);
        callbacksRef.current.onActiveStateChange?.(id);
    }, [runtimeApiRef]);

    const hasModel = !!(targetModel && previewResources && runtimeGraph);
    const status = previewStatus(hasModel, allClips.length, paused);
    useEffect(() => {
        callbacksRef.current.onStatusChange?.(status);
    }, [status]);

    // The runtime falls back to its entry state on its own when the active state is deleted;
    // a slow poll catches changes like that, which it does not report.
    const watchActive = hasModel && !!onActiveStateChange;
    useEffect(() => {
        if (!watchActive) return;
        const timer = window.setInterval(() => {
            const id = runtimeApiRef.current?.getActiveState?.()?.id;
            if (!id || id === activeRef.current) return;
            activeRef.current = id;
            callbacksRef.current.onActiveStateChange?.(id);
        }, ACTIVE_STATE_POLL_MS);
        return () => window.clearInterval(timer);
    }, [watchActive, runtimeApiRef]);

    // Filter attachments for this specific model
    const modelAttachments = useMemo(() =>
        targetModel
            ? attachments
                .filter(a => a.parentModelId === targetModel.id)
                .map((attachment) => ({ ...attachment, object: cloneSkeleton(attachment.object) as THREE.Group }))
            : [],
    [targetModel, attachments]);

    // AttachmentController reparents its object. Keep that operation inside
    // the preview's disposable graph instead of moving the canonical object.
    useEffect(() => () => {
        modelAttachments.forEach((attachment) => attachment.object.parent?.remove(attachment.object));
    }, [modelAttachments]);

    useEffect(() => {
        if (!previewResources) return;
        return () => disposePreviewResources(previewResources);
    }, [previewResources]);

    // Filter sockets for this specific model
    const modelSockets = useMemo(() => 
        targetModel ? sockets.filter(s => s.parentModelId === targetModel.id) : [], 
    [targetModel, sockets]);

    const finalScale = useMemo(() => {
        const base = targetModel?.initialScale || [1, 1, 1];
        return [base[0] * scale, base[1] * scale, base[2] * scale] as [number, number, number];
    }, [targetModel, scale]);

    // Handle Texture Override
    useEffect(() => {
        if (!previewResources || !textureUrl) return;
        let cancelled = false;
        let appliedTexture: THREE.Texture | null = null;
        const loader = new THREE.TextureLoader();
        void loader.loadAsync(textureUrl).then((texture) => {
            if (cancelled) {
                texture.dispose();
                return;
            }
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.flipY = true;
            previewResources.textures.add(texture);
            appliedTexture = texture;
            for (const material of previewResources.materials) {
                if (!('map' in material)) continue;
                (material as THREE.MeshStandardMaterial).map = texture;
                material.needsUpdate = true;
            }
        }).catch(() => {
            // Preview loading is best-effort; a failed override leaves the
            // cloned material map in its original state.
        });
        return () => {
            cancelled = true;
            for (const material of previewResources.materials) {
                if (!('map' in material)) continue;
                const current = (material as THREE.MeshStandardMaterial).map;
                if (current !== appliedTexture) continue;
                (material as THREE.MeshStandardMaterial).map = previewResources.baseMaps.get(material) ?? null;
                material.needsUpdate = true;
            }
            if (appliedTexture) {
                previewResources.textures.delete(appliedTexture);
                appliedTexture.dispose();
            }
        };
    }, [previewResources, textureUrl]);

    let canvas: React.ReactNode = null;
    if (targetModel && previewResources && displayObject && runtimeGraph) {
        canvas = (
            <AuvraCanvas
                surfaceId="preview-animation-graph"
                role="preview"
                shadows
                camera={{ position: [4, 4, 8], fov: 45 }}
                dpr={[1, 2]}
                gl={{
                    toneMapping: THREE.ACESFilmicToneMapping,
                    toneMappingExposure: 1.0,
                    antialias: true
                }}
            >
                <color attach="background" args={['#0a0a0a']} />
                <fog attach="fog" args={['#0a0a0a', 10, 50]} />

                <LocalEnvironment />

                <ambientLight intensity={0.5} />
                <directionalLight
                    position={[10, 10, 5]}
                    intensity={1.5}
                    castShadow
                    shadow-bias={-0.0001}
                />

                <group position={[0, -0.2, 0]}>
                    <Grid
                        infiniteGrid
                        cellSize={1}
                        sectionSize={5}
                        fadeDistance={30}
                        sectionColor="#525252"
                        cellColor="#171717"
                    />

                    <primitive object={displayObject} scale={finalScale} />

                    {/* Render Attachments */}
                    {modelAttachments.map(att => (
                        <AttachmentController
                            key={att.id}
                            data={att}
                            parentObject={displayObject}
                        />
                    ))}

                    {/* Render Sockets (Always visible in Graph Preview for debugging) */}
                    {modelSockets.map(sock => (
                        <SocketController
                            key={sock.id}
                            data={sock}
                            parentObject={displayObject}
                            flashTrigger={flashTriggers[sock.id] ?? 0}
                            flashTextureUrl={resolveSocketFlashTextureUrl(sock, textures)}
                        />
                    ))}

                    <ContactShadows opacity={0.4} scale={20} blur={2} far={4} resolution={256} color="#000000" />
                </group>

                <PreviewClockDriver clock={clock} />
                <PreviewSession
                    key={`${resetKey}:${displayObject.uuid}:${run}`}
                    resources={previewResources}
                    graph={runtimeGraph}
                    allClips={allClips}
                    clock={clock}
                    apiRef={runtimeApiRef}
                    onStart={handleSessionStart}
                    onActiveStateChange={handleRuntimeStateChange}
                />

                <PreviewCamera targetObject={displayObject} follow={follow} />
            </AuvraCanvas>
        );
    }

    if (!controls) return <>{canvas}</>;

    return (
        <div className="relative w-full h-full">
            {canvas}
            <PreviewStatusBadge status={status} modelName={targetModel?.name} />
            {hasModel && (
                <PreviewTransport
                    paused={paused}
                    speed={speed}
                    follow={follow}
                    onTogglePause={togglePause}
                    onStep={step}
                    onRestart={restart}
                    onSpeedChange={setSpeed}
                    onToggleFollow={toggleFollow}
                />
            )}
        </div>
    );
};
