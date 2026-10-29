import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line, TransformControls } from '@react-three/drei';
import type { LevelComponent, LevelObject } from '../../types';
import { getSplineDraft, setSplineDraft, useComponentSpline } from '../../runtime/splineRegistry';
import {
    buildSpline,
    duplicateSplinePoint,
    insertSplinePointAt,
    readSplineData,
    updateSplinePoint,
    splineFrameQuaternion,
    type SplineData,
    type SplineVec3,
} from '../../runtime/splines';
import { splineEditing, useSplineSelection, withSplineData, type SplineHandle } from './splineEditing';
import { gizmoPointer } from './gizmoPointer';
import type { TransformSettings } from './types';

/**
 * SPLINE POINT EDITING
 *
 * Over the selected object's spline: a handle on every point, and on the selected point its two
 * tangent handles. Click a handle to select it; the gizmo then edits it instead of the object:
 * Move moves the point (Alt-drag leaves a copy behind and drags the new point), Rotate turns its
 * tangent and rolls it, Scale sets its width and height. Dragging a tangent handle gives the point
 * a custom tangent. Ctrl-click the curve to add a point there; Delete removes the selected point
 * and Escape deselects it (useEnvironmentHotkeys).
 *
 * While a handle is dragged the points live in a draft (runtime/splineRegistry.ts), so the curve
 * and what is laid along it follow; the level takes the edit, as one undo step, when it ends.
 */

const POINT_COLOR = '#f5d0fe';
const START_COLOR = '#4ade80';
const SELECTED_COLOR = '#facc15';
const TANGENT_COLOR = '#22d3ee';
/** Handle radius per metre of camera distance, so handles stay the same size on screen. */
const HANDLE_SCREEN_SIZE = 0.012;
const HANDLE_MIN_RADIUS = 0.02;

interface SplineEditOverlayProps {
    object: LevelObject;
    component: LevelComponent;
    /** The object's drawn transform group: the spline's space. */
    node: THREE.Object3D;
    transformSettings: TransformSettings;
    updateLevelObject: (id: string, updates: Partial<LevelObject>) => void;
    onSnapshot: () => void;
}

interface DragStart {
    data: SplineData;
    index: number;
    handle: SplineHandle;
    /** The proxy's world rotation and scale when the drag began. */
    quaternion: THREE.Quaternion;
    scale: [number, number];
}

const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _world = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _nodeQuaternion = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();

export const SplineEditOverlay: React.FC<SplineEditOverlayProps> = ({ object, component, node, transformSettings, updateLevelObject, onSnapshot }) => {
    const camera = useThree(state => state.camera);
    const selection = useSplineSelection();
    const curve = useComponentSpline(component);
    const spline = curve?.spline ?? null;
    const group = useRef<THREE.Group>(null);
    const handles = useRef(new Map<string, THREE.Mesh>());
    const proxy = useMemo(() => new THREE.Object3D(), []);
    const drag = useRef<DragStart | null>(null);
    const latest = useRef<SplineData | null>(null);
    const pendingClear = useRef(false);

    const selected = selection && selection.objectId === object.id && selection.componentId === component.id && spline
        && selection.index < spline.points.length ? selection : null;

    // A selection on another spline, or past the last point, is dropped.
    useEffect(() => {
        const current = splineEditing.get();
        if (current && (current.objectId !== object.id || current.componentId !== component.id)) splineEditing.set(null);
    }, [object.id, component.id]);
    useEffect(() => () => {
        const current = splineEditing.get();
        if (current?.componentId === component.id) splineEditing.set(null);
    }, [component.id]);
    // Once the level holds a finished drag's points, the draft is no longer needed.
    useEffect(() => {
        if (!pendingClear.current) return;
        pendingClear.current = false;
        setSplineDraft(component.id, null);
    }, [component.props, component.id]);
    useEffect(() => () => setSplineDraft(component.id, null), [component.id]);

    // Handles ride on the object's transform and keep their size on screen.
    useFrame(() => {
        const overlay = group.current;
        if (!overlay) return;
        node.updateWorldMatrix(true, false);
        overlay.matrix.copy(node.matrixWorld);
        overlay.matrixWorldNeedsUpdate = true;
        overlay.updateMatrixWorld(true);
        for (const mesh of handles.current.values()) {
            const distance = mesh.getWorldPosition(_world).distanceTo(camera.position);
            const scale = Math.max(HANDLE_MIN_RADIUS, distance * HANDLE_SCREEN_SIZE);
            // The object's own scale would grow handles with it; take it back out.
            const parentScale = overlay.getWorldScale(_local);
            mesh.scale.set(scale / Math.max(parentScale.x, 1e-6), scale / Math.max(parentScale.y, 1e-6), scale / Math.max(parentScale.z, 1e-6));
        }
        if (!drag.current) placeProxy();
    });

    const tangentOf = (index: number): THREE.Vector3 => {
        if (!spline) return new THREE.Vector3();
        const tangent = spline.pointTangent(index);
        if (tangent.lengthSq() < 1e-8) tangent.copy(spline.tangentAt(spline.distanceAtPoint(index)));
        return tangent;
    };

    /** Where the selected handle is, in the spline's space. */
    const handlePosition = (index: number, handle: SplineHandle, target: THREE.Vector3): THREE.Vector3 => {
        const point = spline!.points[index];
        target.set(...point.position);
        if (handle === 'point') return target;
        return target.addScaledVector(tangentOf(index), handle === 'leave' ? 1 / 3 : -1 / 3);
    };

    const placeProxy = () => {
        if (!selected || !spline) return;
        node.updateWorldMatrix(true, false);
        handlePosition(selected.index, selected.handle, proxy.position).applyMatrix4(node.matrixWorld);
        if (selected.handle === 'point') {
            const frame = spline.frameAt(spline.distanceAtPoint(selected.index));
            splineFrameQuaternion(frame, proxy.quaternion).premultiply(node.getWorldQuaternion(_nodeQuaternion));
        } else {
            node.getWorldQuaternion(proxy.quaternion);
        }
        proxy.scale.set(1, 1, 1);
        proxy.updateMatrixWorld(true);
    };

    const select = (index: number, handle: SplineHandle) => (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        if (gizmoPointer.owns()) return;
        splineEditing.set({ objectId: object.id, componentId: component.id, index, handle });
    };

    const commit = (data: SplineData) => {
        pendingClear.current = true;
        updateLevelObject(object.id, { components: withSplineData(object, component.id, data) });
        // The level may refuse the edit (a read-only project); the draft must not outlive it.
        window.setTimeout(() => {
            if (!pendingClear.current) return;
            pendingClear.current = false;
            setSplineDraft(component.id, null);
        }, 1000);
    };

    // Ctrl-click on the curve adds a point where it was clicked. It acts on the press, before the
    // terrain behind takes it, and claims the click that follows from the object's own selection.
    const onCurvePress = (event: ThreeEvent<PointerEvent>) => {
        if (!(event.ctrlKey || event.metaKey) || !spline || event.button !== 0) return;
        event.stopPropagation();
        gizmoPointer.take();
        node.updateWorldMatrix(true, false);
        _local.copy(event.point).applyMatrix4(_inverse.copy(node.matrixWorld).invert());
        const data = getSplineDraft(component.id) ?? readSplineData(component.props);
        const inserted = insertSplinePointAt(data, spline.closestDistance(_local));
        if (inserted.index < 0) return;
        onSnapshot();
        setSplineDraft(component.id, inserted.data);
        commit(inserted.data);
        splineEditing.set({ objectId: object.id, componentId: component.id, index: inserted.index, handle: 'point' });
    };

    const onMouseDown = () => {
        gizmoPointer.take();
        if (!selected || !spline) return;
        onSnapshot();
        let data = getSplineDraft(component.id) ?? readSplineData(component.props);
        let index = selected.index;
        if (altDown.current && selected.handle === 'point' && transformSettings.tool === 'translate') {
            const duplicated = duplicateSplinePoint(data, index);
            data = duplicated.data;
            index = duplicated.index;
            splineEditing.set({ ...selected, index });
            setSplineDraft(component.id, data);
        }
        const point = data.points[index];
        drag.current = { data, index, handle: selected.handle, quaternion: proxy.quaternion.clone(), scale: [...point.scale] };
        latest.current = data;
    };

    const onChange = () => {
        const start = drag.current;
        if (!start) return;
        node.updateWorldMatrix(true, false);
        _inverse.copy(node.matrixWorld).invert();
        const point = start.data.points[start.index];
        let data = start.data;
        if (start.handle !== 'point') {
            _local.copy(proxy.position).applyMatrix4(_inverse);
            const offset = _local.sub(new THREE.Vector3(...point.position)).multiplyScalar(start.handle === 'leave' ? 3 : -3);
            data = updateSplinePoint(data, start.index, { mode: 'custom', tangent: offset.toArray() as SplineVec3 });
        } else if (transformSettings.tool === 'translate') {
            _local.copy(proxy.position).applyMatrix4(_inverse);
            data = updateSplinePoint(data, start.index, { position: _local.toArray() as SplineVec3 });
        } else if (transformSettings.tool === 'rotate') {
            // The gizmo's front is the new tangent; its up, against the point's unrolled up, the roll.
            _quaternion.copy(node.getWorldQuaternion(_nodeQuaternion)).invert().multiply(proxy.quaternion);
            _forward.set(0, 0, 1).applyQuaternion(_quaternion);
            _up.set(0, 1, 0).applyQuaternion(_quaternion);
            const before = buildSpline(start.data);
            const length = Math.max(before.pointTangent(start.index).length(), 1e-3);
            const turned = updateSplinePoint(start.data, start.index, { mode: 'custom', tangent: _forward.clone().multiplyScalar(length).toArray() as SplineVec3, roll: 0 });
            const unrolled = buildSpline(turned).frameAt(buildSpline(turned).distanceAtPoint(start.index));
            const roll = Math.atan2(_world.crossVectors(unrolled.up, _up).dot(unrolled.tangent), unrolled.up.dot(_up));
            data = updateSplinePoint(turned, start.index, { roll: Math.round(THREE.MathUtils.radToDeg(roll) * 100) / 100 });
        } else {
            data = updateSplinePoint(data, start.index, {
                scale: [Math.max(0.001, start.scale[0] * Math.abs(proxy.scale.x)), Math.max(0.001, start.scale[1] * Math.abs(proxy.scale.y))],
            });
        }
        latest.current = data;
        setSplineDraft(component.id, data);
    };

    const onMouseUp = () => {
        const finished = latest.current;
        drag.current = null;
        latest.current = null;
        if (finished) commit(finished);
        placeProxy();
    };

    // TransformControls reports the press without the key state; Alt is tracked here.
    const altDown = useRef(false);
    useEffect(() => {
        const track = (event: KeyboardEvent) => { altDown.current = event.altKey; };
        const blur = () => { altDown.current = false; };
        window.addEventListener('keydown', track);
        window.addEventListener('keyup', track);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', track);
            window.removeEventListener('keyup', track);
            window.removeEventListener('blur', blur);
        };
    }, []);

    const line = useMemo(() => (spline ? spline.polyline(0.25) : []), [spline]);

    if (!spline) return null;
    const tangentLine = selected
        ? [handlePosition(selected.index, 'arrive', new THREE.Vector3()), handlePosition(selected.index, 'leave', new THREE.Vector3())]
        : null;
    const stop = (event: ThreeEvent<MouseEvent>) => event.stopPropagation();

    const handleMesh = (key: string, position: THREE.Vector3 | SplineVec3, color: string, onPointerDown: (event: ThreeEvent<PointerEvent>) => void, size = 1) => (
        <mesh
            key={key}
            ref={(mesh) => {
                if (mesh) handles.current.set(key, mesh);
                else handles.current.delete(key);
            }}
            position={position as THREE.Vector3}
            onPointerDown={onPointerDown}
            onClick={stop}
            renderOrder={10}
        >
            <sphereGeometry args={[size, 14, 10]} />
            <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} toneMapped={false} />
        </mesh>
    );

    return (
        <>
            <group ref={group} matrixAutoUpdate={false}>
                {line.length >= 2 && (
                    // Wide and invisible: a target for Ctrl-click, drawn over by the curve itself.
                    <Line points={line} lineWidth={14} transparent opacity={0} depthWrite={false} onPointerDown={onCurvePress} />
                )}
                {spline.points.map((point, index) => handleMesh(
                    `p${index}`,
                    point.position,
                    selected?.index === index && selected.handle === 'point' ? SELECTED_COLOR : index === 0 ? START_COLOR : POINT_COLOR,
                    select(index, 'point'),
                ))}
                {selected && tangentLine && (
                    <>
                        <Line points={tangentLine} color={TANGENT_COLOR} lineWidth={1.5} depthTest={false} renderOrder={9} />
                        {handleMesh('arrive', tangentLine[0], selected.handle === 'arrive' ? SELECTED_COLOR : TANGENT_COLOR, select(selected.index, 'arrive'), 0.75)}
                        {handleMesh('leave', tangentLine[1], selected.handle === 'leave' ? SELECTED_COLOR : TANGENT_COLOR, select(selected.index, 'leave'), 0.75)}
                    </>
                )}
            </group>
            <primitive object={proxy} />
            {selected && (
                <TransformControls
                    object={proxy}
                    mode={selected.handle === 'point' ? transformSettings.tool : 'translate'}
                    space={selected.handle === 'point' && transformSettings.tool !== 'translate' ? 'local' : transformSettings.space}
                    onMouseDown={onMouseDown}
                    onChange={onChange}
                    onMouseUp={onMouseUp}
                    translationSnap={transformSettings.snapEnabled && transformSettings.tool === 'translate' ? transformSettings.snapGrid : null}
                    rotationSnap={transformSettings.snapEnabled && transformSettings.tool === 'rotate' ? THREE.MathUtils.degToRad(transformSettings.snapAngle) : null}
                    size={0.7}
                />
            )}
        </>
    );
};
