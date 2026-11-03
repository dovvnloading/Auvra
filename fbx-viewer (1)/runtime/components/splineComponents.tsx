import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider } from '@react-three/rapier';
import type { LevelComponent } from '../../types';
import { useGameContent } from '../GameContentContext';
import { levelVariables } from '../levelVariables';
import { physicsUserData, usePhysicsAvailable } from '../physicsQueries';
import { isTimelinePlayValue } from '../timeline/evaluate';
import {
    createWorldSplineFrame,
    getLiveSpline,
    liveSplineWorldScale,
    registerLiveSpline,
    sampleLiveSpline,
    useComponentSpline,
    useObjectSpline,
    type LiveSpline,
} from '../splineRegistry';
import { SPLINE_COMPONENT_TYPE, splineFrameQuaternion, type Spline } from '../splines';
import {
    buildSplineMesh,
    readSplineMeshSettings,
    readSplineScatterSettings,
    scatterAlongSpline,
    SPLINE_MESH_COMPONENT_TYPE,
    SPLINE_MESH_DEFAULTS,
    SPLINE_SCATTER_COMPONENT_TYPE,
    SPLINE_SCATTER_DEFAULTS,
    splineMeshTriangles,
    splineModelBounds,
    splineModelParts,
    type SplineMeshBuild,
    type SplineTriangles,
} from '../splineMesh';
import { ComponentHostContext } from './builtins';
import { PHYSICS_IGNORED_USER_DATA } from './physicsComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * SPLINE COMPONENTS
 *
 * Spline: a curve through points in the object's space (runtime/splines.ts), drawn in the editor
 * and edited there point by point; every drawn spline registers itself (runtime/splineRegistry.ts)
 * so other objects can follow it.
 *
 * Spline Mesh and Spline Scatter lay a model along the object's spline (runtime/splineMesh.ts),
 * bent or as copies, with collision in play. Follow Spline moves its own object along another
 * object's spline: platforms, trains, patrolling props, cameras on rails.
 */

export const FOLLOW_SPLINE_COMPONENT_TYPE = 'followSpline';

const SPLINE_COLOR = '#e879f9';
const FOLLOW_COLOR = '#38bdf8';
/** Longest step motion takes in one frame, so resuming from a pause or a stalled tab does not jump. */
const MAX_FRAME_STEP = 0.1;

const noRaycast: THREE.Object3D['raycast'] = () => undefined;

// --- SPLINE ---

/** The curve with a dot at each point and an arrow at its end, which way it runs. */
const SplineCurve: React.FC<{ spline: Spline }> = ({ spline }) => {
    const line = useMemo(() => spline.polyline(0.25), [spline]);
    const end = useMemo(() => {
        if (spline.segmentCount === 0) return null;
        const at = spline.closed ? spline.length * 0.999 : spline.length;
        const position = spline.positionAt(at);
        const direction = spline.tangentAt(at);
        return { position, quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction) };
    }, [spline]);
    return (
        <>
            {line.length >= 2 && <Line points={line} color={SPLINE_COLOR} lineWidth={2.5} />}
            {spline.points.map((point, index) => (
                <mesh key={index} position={point.position} raycast={noRaycast}>
                    <sphereGeometry args={[0.09, 10, 8]} />
                    <meshBasicMaterial color={index === 0 ? '#ffffff' : SPLINE_COLOR} toneMapped={false} />
                </mesh>
            ))}
            {end && (
                <mesh position={end.position} quaternion={end.quaternion} raycast={noRaycast}>
                    <coneGeometry args={[0.16, 0.45, 12]} />
                    <meshBasicMaterial color={SPLINE_COLOR} toneMapped={false} />
                </mesh>
            )}
        </>
    );
};

const SplineRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const curve = useComponentSpline(component);
    const anchor = useRef<THREE.Group>(null);
    // The anchor sits at the object's origin, so its world transform is the spline's space.
    useLayoutEffect(() => {
        if (!anchor.current || !curve) return undefined;
        return registerLiveSpline({ objectId: object.id, mode, spline: curve.spline, node: anchor.current });
    }, [object.id, mode, curve]);
    return (
        <group ref={anchor} userData={PHYSICS_IGNORED_USER_DATA}>
            {mode === 'editor' && curve && <SplineCurve spline={curve.spline} />}
        </group>
    );
};

// --- SHARED: models and collision ---

const useModelObject = (modelId: string): THREE.Object3D | null => {
    const { models } = useGameContent();
    return useMemo(() => (modelId ? models.find(model => model.id === modelId)?.object ?? null : null), [models, modelId]);
};

/** A fixed body with the triangles laid along the spline, for the player and physics to collide with. */
const SplineTrimeshBody: React.FC<{ objectId: string; triangles: SplineTriangles }> = ({ objectId, triangles }) => {
    const userData = useMemo(() => physicsUserData(objectId), [objectId]);
    return (
        <RigidBody type="fixed" colliders={false} userData={userData}>
            <TrimeshCollider args={[triangles.positions, triangles.indices]} />
        </RigidBody>
    );
};

const EMPTY_BUILD: SplineMeshBuild = { parts: [], copies: 0 };

// --- SPLINE MESH ---

const SplineMeshRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readSplineMeshSettings(component.props), [component.props]);
    const curve = useObjectSpline(object);
    const model = useModelObject(settings.modelId);
    const parts = useMemo(() => (model ? splineModelParts(model) : []), [model]);
    const build = useMemo(() => (curve ? buildSplineMesh(parts, curve.spline, settings) : EMPTY_BUILD), [parts, curve, settings]);
    useEffect(() => () => build.parts.forEach(part => part.geometry.dispose()), [build]);
    const physics = usePhysicsAvailable();
    const triangles = useMemo(
        () => (mode === 'runtime' && settings.collision ? splineMeshTriangles(build.parts) : null),
        [mode, settings.collision, build],
    );
    return (
        <group>
            {build.parts.map((part, index) => (
                <mesh
                    key={`${part.geometry.uuid}:${index}`}
                    geometry={part.geometry}
                    material={part.material}
                    castShadow={settings.castShadow}
                    receiveShadow={settings.receiveShadow}
                />
            ))}
            {physics && triangles && <SplineTrimeshBody objectId={object.id} triangles={triangles} />}
        </group>
    );
};

// --- SPLINE SCATTER ---

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _center = new THREE.Vector3();
const _euler = new THREE.Euler();

const SplineScatterRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readSplineScatterSettings(component.props), [component.props]);
    const curve = useObjectSpline(object);
    const model = useModelObject(settings.modelId);
    const parts = useMemo(() => (model ? splineModelParts(model) : []), [model]);
    const matrices = useMemo(() => (curve && parts.length > 0 ? scatterAlongSpline(curve.spline, settings) : []), [curve, parts, settings]);
    const meshes = useMemo(() => parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, matrices.length));
        mesh.count = matrices.length;
        matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
        return mesh;
    }), [parts, matrices]);
    useLayoutEffect(() => {
        for (const mesh of meshes) {
            mesh.castShadow = settings.castShadow;
            mesh.receiveShadow = settings.receiveShadow;
        }
    }, [meshes, settings.castShadow, settings.receiveShadow]);
    // The geometry and material are the model's; only the instance buffers are this mesh's own.
    useEffect(() => () => meshes.forEach(mesh => mesh.dispose()), [meshes]);

    const physics = usePhysicsAvailable();
    const boxes = useMemo(() => {
        if (mode !== 'runtime' || !settings.collision || matrices.length === 0) return [];
        const bounds = splineModelBounds(parts);
        if (bounds.isEmpty()) return [];
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        return matrices.map((matrix) => {
            matrix.decompose(_position, _quaternion, _scale);
            _center.copy(center).applyMatrix4(matrix);
            _euler.setFromQuaternion(_quaternion);
            return {
                half: [size.x * _scale.x / 2, size.y * _scale.y / 2, size.z * _scale.z / 2] as [number, number, number],
                position: _center.toArray() as [number, number, number],
                rotation: [_euler.x, _euler.y, _euler.z] as [number, number, number],
            };
        });
    }, [mode, settings.collision, matrices, parts]);
    const userData = useMemo(() => physicsUserData(object.id), [object.id]);

    return (
        <group>
            {meshes.map(mesh => <primitive key={mesh.uuid} object={mesh} />)}
            {physics && boxes.length > 0 && (
                <RigidBody type="fixed" colliders={false} userData={userData}>
                    {boxes.map((box, index) => <CuboidCollider key={index} args={box.half} position={box.position} rotation={box.rotation} />)}
                </RigidBody>
            )}
        </group>
    );
};

// --- FOLLOW SPLINE ---

export type FollowSplineLoop = 'loop' | 'pingPong' | 'once';
export type FollowSplineOrient = 'none' | 'yaw' | 'full';

export interface FollowSplineSettings {
    /** Id of the object whose spline is followed. */
    spline: string;
    /** Metres per second; negative runs it backwards. */
    speed: number;
    /** Where on the spline it starts, 0 (start) to 1 (end). */
    startAt: number;
    loop: FollowSplineLoop;
    orient: FollowSplineOrient;
    /** Metres to the right of, above and ahead of the spline. */
    offset: [number, number, number];
    autoplay: boolean;
    /** A level variable that, when set, decides when it moves: while it is true or non-zero. */
    playVariable: string;
}

export const FOLLOW_SPLINE_DEFAULTS: FollowSplineSettings = {
    spline: '',
    speed: 3,
    startAt: 0,
    loop: 'loop',
    orient: 'yaw',
    offset: [0, 0, 0],
    autoplay: true,
    playVariable: '',
};

const LOOPS: readonly FollowSplineLoop[] = ['loop', 'pingPong', 'once'];
const ORIENTS: readonly FollowSplineOrient[] = ['none', 'yaw', 'full'];

export const readFollowSplineSettings = (component: LevelComponent): FollowSplineSettings => {
    const { spline, speed, startAt, loop, orient, offset, autoplay, playVariable } = component.props;
    const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    return {
        spline: typeof spline === 'string' ? spline : '',
        speed: Math.min(1000, Math.max(-1000, finite(speed, FOLLOW_SPLINE_DEFAULTS.speed))),
        startAt: Math.min(1, Math.max(0, finite(startAt, 0))),
        loop: typeof loop === 'string' && (LOOPS as readonly string[]).includes(loop) ? loop as FollowSplineLoop : FOLLOW_SPLINE_DEFAULTS.loop,
        orient: typeof orient === 'string' && (ORIENTS as readonly string[]).includes(orient) ? orient as FollowSplineOrient : FOLLOW_SPLINE_DEFAULTS.orient,
        offset: Array.isArray(offset) && offset.length === 3 ? offset.map(value => finite(value, 0)) as [number, number, number] : [0, 0, 0],
        autoplay: typeof autoplay === 'boolean' ? autoplay : true,
        playVariable: typeof playVariable === 'string' ? playVariable.trim() : '',
    };
};

export interface FollowState {
    /** Distance along the spline, in its own units. */
    distance: number;
    /** 1 forwards, -1 backwards (ping-pong on its way back). */
    direction: 1 | -1;
    finished: boolean;
}

/** Advances a follower by `travel` (signed, spline units) along a spline `length` long, as `loop` says. */
export const stepFollow = (state: FollowState, travel: number, length: number, closed: boolean, loop: FollowSplineLoop): FollowState => {
    if (!(length > 1e-9) || state.finished || travel === 0) return state;
    let distance = state.distance + travel * state.direction;
    let direction = state.direction;
    let finished = false;
    if (closed && loop !== 'pingPong') {
        // Round a loop it keeps going, whatever the loop setting; Once stops back at the start.
        if (loop === 'once' && (distance >= length || distance < 0)) {
            distance = distance >= length ? length : 0;
            finished = true;
        } else {
            distance = ((distance % length) + length) % length;
        }
    } else if (loop === 'loop') {
        distance = ((distance % length) + length) % length;
    } else if (loop === 'pingPong') {
        // Bounce off the ends, as many times as one step needs.
        for (let i = 0; i < 8 && (distance > length || distance < 0); i++) {
            distance = distance > length ? 2 * length - distance : -distance;
            direction = direction === 1 ? -1 : 1;
        }
        distance = Math.min(length, Math.max(0, distance));
    } else {
        if (distance >= length || distance <= 0) finished = true;
        distance = Math.min(length, Math.max(0, distance));
    }
    return { distance, direction, finished };
};

const UP = new THREE.Vector3(0, 1, 0);
const _frame = createWorldSplineFrame();
const _world = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _parentQuaternion = new THREE.Quaternion();
const _flat = new THREE.Vector3();
const _turn = new THREE.Quaternion();

/** Moves the object's transform group along the followed spline during play. */
const FollowSplineMotion: React.FC<ComponentRenderProps> = ({ component }) => {
    const host = useContext(ComponentHostContext);
    const settings = readFollowSplineSettings(component);
    const state = useRef<FollowState | null>(null);
    const scaleOf = useRef<{ entry: LiveSpline; scale: number } | null>(null);

    useFrame((_state, delta) => {
        const target = host?.current;
        const entry = settings.spline ? getLiveSpline(settings.spline, 'runtime') : null;
        if (!target || !entry) return;
        if (scaleOf.current?.entry !== entry) scaleOf.current = { entry, scale: liveSplineWorldScale(entry) };
        const length = entry.spline.length;
        if (!state.current) {
            const start = settings.startAt * length;
            state.current = { distance: start, direction: settings.speed < 0 ? -1 : 1, finished: false };
        }
        const playing = settings.playVariable ? isTimelinePlayValue(levelVariables.get(settings.playVariable)) : settings.autoplay;
        if (playing) {
            const travel = (Math.abs(settings.speed) / scaleOf.current.scale) * Math.min(delta, MAX_FRAME_STEP);
            state.current = stepFollow(state.current, travel, length, entry.spline.closed, settings.loop);
        }

        const frame = sampleLiveSpline(entry, state.current.distance, _frame);
        const [right, up, ahead] = settings.offset;
        _world.copy(frame.position).addScaledVector(frame.right, right).addScaledVector(frame.up, up).addScaledVector(frame.tangent, ahead);
        const parent = target.parent;
        if (parent) {
            parent.updateWorldMatrix(true, false);
            parent.worldToLocal(_world);
        }
        target.position.copy(_world);
        if (settings.orient === 'none') return;

        // Facing the way it travels: turned round on its way back.
        const backwards = state.current.direction < 0;
        if (settings.orient === 'full') {
            splineFrameQuaternion(frame, _rotation);
            if (backwards) _rotation.multiply(_turn.setFromAxisAngle(UP, Math.PI));
        } else {
            _flat.set(frame.tangent.x, 0, frame.tangent.z);
            const heading = _flat.lengthSq() > 1e-8 ? Math.atan2(_flat.x, _flat.z) : 0;
            _rotation.setFromAxisAngle(UP, heading + (backwards ? Math.PI : 0));
        }
        if (parent) _rotation.premultiply(parent.getWorldQuaternion(_parentQuaternion).invert());
        target.quaternion.copy(_rotation);
    });

    return null;
};

/** In the editor: a line from the object to where on the spline it starts. */
const FollowSplinePreview: React.FC<ComponentRenderProps> = ({ component }) => {
    const settings = readFollowSplineSettings(component);
    const anchor = useRef<THREE.Group>(null);
    const [line] = useState(() => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const material = new THREE.LineDashedMaterial({ color: FOLLOW_COLOR, dashSize: 0.3, gapSize: 0.2, toneMapped: false });
        const created = new THREE.Line(geometry, material);
        created.raycast = noRaycast;
        created.frustumCulled = false;
        return created;
    });
    useEffect(() => () => {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
    }, [line]);

    useFrame(() => {
        const group = anchor.current;
        const entry = settings.spline ? getLiveSpline(settings.spline, 'editor') : null;
        line.visible = Boolean(group && entry);
        if (!group || !entry) return;
        const frame = sampleLiveSpline(entry, settings.startAt * entry.spline.length, _frame);
        group.updateWorldMatrix(true, false);
        const start = group.worldToLocal(_world.copy(frame.position));
        const position = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        position.setXYZ(0, 0, 0, 0);
        position.setXYZ(1, start.x, start.y, start.z);
        position.needsUpdate = true;
        line.computeLineDistances();
    });

    return (
        <group ref={anchor} userData={PHYSICS_IGNORED_USER_DATA}>
            <primitive object={line} />
        </group>
    );
};

const FollowSplineRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <FollowSplineMotion {...props} /> : <FollowSplinePreview {...props} />
);

// --- DEFINITIONS ---

const AXIS_OPTIONS = [{ label: 'Z (its front)', value: 'z' }, { label: 'X (its side)', value: 'x' }];

export const SPLINE_COMPONENTS: ComponentDefinition[] = [
    {
        type: SPLINE_COMPONENT_TYPE,
        label: 'Spline',
        description: 'A smooth curve through points, for roads, rails, fences, rivers, paths and rails for cameras and moving objects. Select the object to edit its points in the viewport; Spline Mesh, Spline Scatter and Follow Spline use it.',
        props: [
            { key: 'closed', label: 'Closed loop', type: 'boolean', default: false },
            {
                key: 'up', label: 'Up', type: 'select', default: 'world',
                options: [
                    { label: 'Level (roads, fences)', value: 'world' },
                    { label: 'Least twist (loops, coasters)', value: 'minimal' },
                ],
            },
        ],
        Render: SplineRender,
    },
    {
        type: SPLINE_MESH_COMPONENT_TYPE,
        label: 'Spline Mesh',
        description: 'Bends a model along the object\'s spline, end to end or stretched once along it: roads, rails, pipes, walls. Collision lets the player and enemies walk on and bump into it.',
        props: [
            { key: 'axis', label: 'Model length along', type: 'select', default: SPLINE_MESH_DEFAULTS.axis, options: AXIS_OPTIONS },
            {
                key: 'fit', label: 'Fit', type: 'select', default: SPLINE_MESH_DEFAULTS.fit,
                options: [{ label: 'Tile end to end', value: 'tile' }, { label: 'Stretch once', value: 'stretch' }],
            },
            { key: 'scale', label: 'Scale (width, height, length)', type: 'vector3', default: SPLINE_MESH_DEFAULTS.scale, min: 0.001, max: 1000, step: 0.05 },
            { key: 'offsetRight', label: 'Offset right (m)', type: 'number', default: 0, min: -1000, max: 1000, step: 0.05 },
            { key: 'offsetUp', label: 'Offset up (m)', type: 'number', default: 0, min: -1000, max: 1000, step: 0.05 },
            { key: 'gap', label: 'Gap between tiles (m)', type: 'number', default: 0, min: 0, max: 1000, step: 0.05 },
            { key: 'start', label: 'Start trim (m)', type: 'number', default: 0, min: 0, max: 100000, step: 0.1 },
            { key: 'end', label: 'End trim (m)', type: 'number', default: 0, min: 0, max: 100000, step: 0.1 },
            { key: 'smoothness', label: 'Bend detail (m)', type: 'number', default: SPLINE_MESH_DEFAULTS.smoothness, min: 0.05, max: 100, step: 0.05 },
            { key: 'collision', label: 'Collision', type: 'boolean', default: SPLINE_MESH_DEFAULTS.collision },
            { key: 'castShadow', label: 'Cast shadows', type: 'boolean', default: true },
            { key: 'receiveShadow', label: 'Receive shadows', type: 'boolean', default: true },
        ],
        Render: SplineMeshRender,
    },
    {
        type: SPLINE_SCATTER_COMPONENT_TYPE,
        label: 'Spline Scatter',
        description: 'Places copies of a model along the object\'s spline at a spacing: fence posts, lamps, trees along a road, with random turn, size and sideways shift so a row does not look stamped.',
        props: [
            { key: 'spacing', label: 'Spacing (m)', type: 'number', default: SPLINE_SCATTER_DEFAULTS.spacing, min: 0.05, max: 100000, step: 0.1 },
            { key: 'start', label: 'Start trim (m)', type: 'number', default: 0, min: 0, max: 100000, step: 0.1 },
            { key: 'end', label: 'End trim (m)', type: 'number', default: 0, min: 0, max: 100000, step: 0.1 },
            { key: 'offsetRight', label: 'Offset right (m)', type: 'number', default: 0, min: -1000, max: 1000, step: 0.05 },
            { key: 'offsetUp', label: 'Offset up (m)', type: 'number', default: 0, min: -1000, max: 1000, step: 0.05 },
            { key: 'bothSides', label: 'Both sides', type: 'boolean', default: false },
            {
                key: 'align', label: 'Turn copies', type: 'select', default: SPLINE_SCATTER_DEFAULTS.align,
                options: [
                    { label: 'Upright, facing along it', value: 'upright' },
                    { label: 'With the curve (tilt and roll)', value: 'spline' },
                    { label: 'Not at all', value: 'fixed' },
                ],
            },
            { key: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.001, max: 1000, step: 0.05 },
            { key: 'yawJitter', label: 'Random turn (deg)', type: 'number', default: 0, min: 0, max: 180, step: 1 },
            { key: 'scaleJitter', label: 'Random size (0-0.95)', type: 'number', default: 0, min: 0, max: 0.95, step: 0.05 },
            { key: 'offsetJitter', label: 'Random shift (m)', type: 'number', default: 0, min: 0, max: 1000, step: 0.05 },
            { key: 'seed', label: 'Seed', type: 'number', default: 1, min: 0, max: 2147483647, step: 1 },
            { key: 'collision', label: 'Collision (boxes)', type: 'boolean', default: false },
            { key: 'castShadow', label: 'Cast shadows', type: 'boolean', default: true },
            { key: 'receiveShadow', label: 'Receive shadows', type: 'boolean', default: true },
        ],
        Render: SplineScatterRender,
    },
    {
        type: FOLLOW_SPLINE_COMPONENT_TYPE,
        label: 'Follow Spline',
        description: 'Moves the object along another object\'s spline during play: platforms, trains, carts, patrolling props, cameras on rails. Loops, goes back and forth, or runs once. With a Play Variable it moves only while that level variable is true or non-zero.',
        props: [
            { key: 'speed', label: 'Speed (m/s)', type: 'number', default: FOLLOW_SPLINE_DEFAULTS.speed, min: -1000, max: 1000, step: 0.1 },
            { key: 'startAt', label: 'Start at (0 start - 1 end)', type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
            {
                key: 'loop', label: 'At the end', type: 'select', default: FOLLOW_SPLINE_DEFAULTS.loop,
                options: [
                    { label: 'Loop', value: 'loop' },
                    { label: 'Go back (ping-pong)', value: 'pingPong' },
                    { label: 'Stop (once)', value: 'once' },
                ],
            },
            {
                key: 'orient', label: 'Turn with it', type: 'select', default: FOLLOW_SPLINE_DEFAULTS.orient,
                options: [
                    { label: 'Face along it, upright', value: 'yaw' },
                    { label: 'Follow the curve fully', value: 'full' },
                    { label: 'Keep its own rotation', value: 'none' },
                ],
            },
            { key: 'offset', label: 'Offset (right, up, ahead)', type: 'vector3', default: FOLLOW_SPLINE_DEFAULTS.offset, step: 0.05 },
            { key: 'autoplay', label: 'Autoplay', type: 'boolean', default: true },
            { key: 'playVariable', label: 'Play Variable', type: 'string', default: '' },
        ],
        Render: FollowSplineRender,
    },
];
