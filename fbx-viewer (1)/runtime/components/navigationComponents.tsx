import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useNavMeshContext } from '../navigation';
import type { NavObstacleHandle } from '../navMesh';
import { NAV_LINK_COMPONENT_TYPE, NAV_OBSTACLE_COMPONENT_TYPE } from '../navGeometry';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * NAVIGATION COMPONENTS
 *
 * Nav Link: an off-mesh link from the object to a point relative to it, which agents may cross
 * where the navmesh does not join up: a drop off a ledge, a gap, a ladder. It is baked into the
 * navmesh (runtime/navGeometry.ts); one way links only go from the object to the end.
 *
 * Nav Obstacle: carves an upright cylinder around a moving object out of the navmesh, following it,
 * so agents path around a pushed crate or a patrolling vehicle that is not baked.
 */

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const vector = (value: unknown, fallback: [number, number, number]): THREE.Vector3 =>
    Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v))
        ? new THREE.Vector3(value[0], value[1], value[2])
        : new THREE.Vector3(...fallback);

const LINK_COLOR = '#22d3ee';
const OBSTACLE_COLOR = '#f97316';

/** The link drawn as an arc over its two ends, with an arrowhead for each way it can be taken. */
const NavLinkRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const end = useMemo(() => vector(component.props.end, [0, 0, 3]), [component.props.end]);
    const bidirectional = component.props.bidirectional !== false;
    const arc = useMemo(() => {
        const lift = Math.max(0.5, end.length() * 0.25);
        const mid = end.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, lift + Math.max(0, end.y) * 0.5, 0));
        return new THREE.QuadraticBezierCurve3(new THREE.Vector3(), mid, end).getPoints(24);
    }, [end]);
    if (mode !== 'editor') return null;
    const arrow = (at: THREE.Vector3, from: THREE.Vector3, key: string) => {
        const direction = at.clone().sub(from).normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        return (
            <mesh key={key} position={at} quaternion={quaternion} raycast={() => undefined}>
                <coneGeometry args={[0.12, 0.35, 10]} />
                <meshBasicMaterial color={LINK_COLOR} toneMapped={false} />
            </mesh>
        );
    };
    return (
        <group>
            <Line points={arc} color={LINK_COLOR} lineWidth={2} raycast={() => undefined} />
            {arrow(arc[arc.length - 1], arc[arc.length - 2], 'end')}
            {bidirectional && arrow(arc[0], arc[1], 'start')}
        </group>
    );
};

// An obstacle is moved on the navmesh once its object has moved this far (m).
const OBSTACLE_MOVE_THRESHOLD = 0.2;

const NavObstacleRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const navMesh = useNavMeshContext();
    const radius = number(component.props.radius, 1, 0.05, 50);
    const height = number(component.props.height, 2, 0.1, 50);
    const anchor = useRef<THREE.Group>(null);
    const placed = useRef<{ handle: NavObstacleHandle | null; at: THREE.Vector3 }>({ handle: null, at: new THREE.Vector3() });
    const world = useMemo(() => new THREE.Vector3(), []);

    // A new navmesh (or new size) starts the obstacle over; leaving removes it.
    useEffect(() => {
        const state = placed.current;
        state.handle = null;
        return () => {
            if (state.handle) navMesh?.removeObstacle(state.handle);
            state.handle = null;
        };
    }, [navMesh, radius, height]);

    useFrame(() => {
        if (mode !== 'runtime' || !navMesh || !anchor.current) return;
        const state = placed.current;
        anchor.current.getWorldPosition(world);
        if (state.handle && world.distanceToSquared(state.at) < OBSTACLE_MOVE_THRESHOLD * OBSTACLE_MOVE_THRESHOLD) return;
        if (state.handle) navMesh.removeObstacle(state.handle);
        // Centred on the object, and grown by the agent's radius as the baked walls are.
        state.handle = navMesh.addCylinderObstacle({ x: world.x, y: world.y - height / 2, z: world.z }, radius + navMesh.settings.agentRadius, height);
        state.at.copy(world);
    });

    return (
        <group ref={anchor}>
            {mode === 'editor' && (
                <mesh raycast={() => undefined}>
                    <cylinderGeometry args={[radius, radius, height, 24, 1, true]} />
                    <meshBasicMaterial color={OBSTACLE_COLOR} wireframe transparent opacity={0.6} depthWrite={false} toneMapped={false} />
                </mesh>
            )}
        </group>
    );
};

export const NAVIGATION_COMPONENTS: ComponentDefinition[] = [
    {
        type: NAV_LINK_COMPONENT_TYPE,
        label: 'Nav Link',
        description: 'Lets enemies cross from this object to the end point where the navmesh does not join up: a drop, a gap, a ladder. One way links only go from the object to the end.',
        props: [
            { key: 'end', label: 'End (relative to the object)', type: 'vector3', default: [0, 0, 3] },
            { key: 'bidirectional', label: 'Both ways', type: 'boolean', default: true },
            { key: 'radius', label: 'Reach (m)', type: 'number', default: 0.6, min: 0.1, max: 5, step: 0.1 },
        ],
        Render: NavLinkRender,
    },
    {
        type: NAV_OBSTACLE_COMPONENT_TYPE,
        label: 'Nav Obstacle',
        description: 'Cuts a cylinder around this object out of the navmesh and follows it as it moves, so enemies path around it. For objects that move; static ones are baked in.',
        props: [
            { key: 'radius', label: 'Radius (m)', type: 'number', default: 1, min: 0.05, max: 50, step: 0.05 },
            { key: 'height', label: 'Height (m)', type: 'number', default: 2, min: 0.1, max: 50, step: 0.1 },
        ],
        Render: NavObstacleRender,
    },
];
