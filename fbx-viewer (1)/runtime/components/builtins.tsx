import React, { createContext, useContext, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

type Vec3 = [number, number, number];

/**
 * The transform group of the object a component is mounted in. The level runtime provides it so
 * motion components can drive their owner; without a provider they leave the transform alone.
 */
export const ComponentHostContext = createContext<React.RefObject<THREE.Object3D | null> | null>(null);

/** Longest step motion takes in one frame, so resuming from a pause or a stalled tab does not jump. */
const MAX_FRAME_STEP = 0.1;

const readNumber = (component: LevelComponent, key: string, fallback: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const readString = (component: LevelComponent, key: string, fallback: string): string => {
    const value = component.props[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
};

const isVec3 = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));

const readVector3 = (component: LevelComponent, key: string, fallback: Vec3): Vec3 => {
    const value = component.props[key];
    return isVec3(value) ? value : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// --- ROTATOR ---

const ROTATOR_DEFAULTS = { axis: 'y', speed: 45 };

const ROTATION_AXES: Record<string, THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1)
};

const RotatorMotion: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const host = useContext(ComponentHostContext);
    const angle = useRef(0);
    const spin = useMemo(() => new THREE.Quaternion(), []);
    const [rx, ry, rz] = object.rotation;
    const base = useMemo(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), [rx, ry, rz]);
    const axis = ROTATION_AXES[readString(component, 'axis', ROTATOR_DEFAULTS.axis)] ?? ROTATION_AXES.y;
    const speed = THREE.MathUtils.degToRad(readNumber(component, 'speed', ROTATOR_DEFAULTS.speed));

    useFrame((_state, delta) => {
        const target = host?.current;
        if (!target) return;
        angle.current = (angle.current + speed * Math.min(delta, MAX_FRAME_STEP)) % (Math.PI * 2);
        // Authored orientation, then the spin around the object's own axis.
        target.quaternion.copy(base).multiply(spin.setFromAxisAngle(axis, angle.current));
    });

    return null;
};

const RotatorRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <RotatorMotion {...props} /> : null
);

// --- MOVER ---

const MOVER_DEFAULTS = { offset: [0, 2, 0] as Vec3, period: 4, pingPong: true };

const MoverMotion: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const host = useContext(ComponentHostContext);
    const elapsed = useRef(0);
    const offset = readVector3(component, 'offset', MOVER_DEFAULTS.offset);
    const period = Math.max(0.05, readNumber(component, 'period', MOVER_DEFAULTS.period));
    const pingPong = readBoolean(component, 'pingPong', MOVER_DEFAULTS.pingPong);

    useFrame((_state, delta) => {
        const target = host?.current;
        if (!target) return;
        elapsed.current = (elapsed.current + Math.min(delta, MAX_FRAME_STEP)) % period;
        const phase = elapsed.current / period;
        // Ping-pong goes out and back within one period; otherwise it travels for the whole period and restarts.
        const t = pingPong ? 1 - Math.abs(1 - 2 * phase) : phase;
        const [x, y, z] = object.position;
        target.position.set(x + offset[0] * t, y + offset[1] * t, z + offset[2] * t);
    });

    return null;
};

const MoverRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <MoverMotion {...props} /> : null
);

// --- LIGHTS ---

const POINT_LIGHT_DEFAULTS = { color: '#ffffff', intensity: 20, distance: 15, castShadow: false };
const SPOT_LIGHT_DEFAULTS = { color: '#ffffff', intensity: 60, distance: 20, angle: 35, penumbra: 0.3, castShadow: true };

/** Small unlit bulb so a light is visible (and clickable) in the editor. */
const LightMarker: React.FC<{ color: string }> = ({ color }) => (
    <mesh>
        <sphereGeometry args={[0.12, 12, 8]} />
        <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
);

const PointLightRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const color = readString(component, 'color', POINT_LIGHT_DEFAULTS.color);
    return (
        <>
            <pointLight
                color={color}
                intensity={Math.max(0, readNumber(component, 'intensity', POINT_LIGHT_DEFAULTS.intensity))}
                distance={Math.max(0, readNumber(component, 'distance', POINT_LIGHT_DEFAULTS.distance))}
                decay={2}
                castShadow={readBoolean(component, 'castShadow', POINT_LIGHT_DEFAULTS.castShadow)}
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
                shadow-bias={-0.0005}
            />
            {mode === 'editor' && <LightMarker color={color} />}
        </>
    );
};

const SpotLightRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    // A target inside the owner's group, so the cone follows the object's rotation.
    const target = useMemo(() => new THREE.Object3D(), []);
    const color = readString(component, 'color', SPOT_LIGHT_DEFAULTS.color);
    const angle = clamp(readNumber(component, 'angle', SPOT_LIGHT_DEFAULTS.angle), 1, 89);
    return (
        <>
            <spotLight
                color={color}
                intensity={Math.max(0, readNumber(component, 'intensity', SPOT_LIGHT_DEFAULTS.intensity))}
                distance={Math.max(0, readNumber(component, 'distance', SPOT_LIGHT_DEFAULTS.distance))}
                angle={THREE.MathUtils.degToRad(angle)}
                penumbra={clamp(readNumber(component, 'penumbra', SPOT_LIGHT_DEFAULTS.penumbra), 0, 1)}
                decay={2}
                castShadow={readBoolean(component, 'castShadow', SPOT_LIGHT_DEFAULTS.castShadow)}
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
                shadow-bias={-0.0005}
                target={target}
            />
            <primitive object={target} position={[0, -1, 0]} />
            {mode === 'editor' && <LightMarker color={color} />}
        </>
    );
};

// --- DEFINITIONS ---

export const BUILTIN_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'rotator',
        label: 'Rotator',
        description: 'Spins the object around one of its own axes during play.',
        props: [
            {
                key: 'axis', label: 'Axis', type: 'select', default: ROTATOR_DEFAULTS.axis,
                options: [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }, { label: 'Z', value: 'z' }]
            },
            { key: 'speed', label: 'Speed (deg/s)', type: 'number', default: ROTATOR_DEFAULTS.speed, min: -3600, max: 3600, step: 1 }
        ],
        Render: RotatorRender
    },
    {
        type: 'mover',
        label: 'Mover',
        description: 'Moves the object by an offset in its parent\'s space during play, then back (ping-pong) or from the start again.',
        props: [
            { key: 'offset', label: 'Offset', type: 'vector3', default: MOVER_DEFAULTS.offset, step: 0.1 },
            { key: 'period', label: 'Period (s)', type: 'number', default: MOVER_DEFAULTS.period, min: 0.05, max: 600, step: 0.1 },
            { key: 'pingPong', label: 'Ping-pong', type: 'boolean', default: MOVER_DEFAULTS.pingPong }
        ],
        Render: MoverRender
    },
    {
        type: 'pointLight',
        label: 'Point Light',
        description: 'Light shining in every direction from the object\'s origin.',
        props: [
            { key: 'color', label: 'Color', type: 'color', default: POINT_LIGHT_DEFAULTS.color },
            { key: 'intensity', label: 'Intensity', type: 'number', default: POINT_LIGHT_DEFAULTS.intensity, min: 0, max: 10000, step: 1 },
            { key: 'distance', label: 'Distance (0 = unlimited)', type: 'number', default: POINT_LIGHT_DEFAULTS.distance, min: 0, max: 1000, step: 0.5 },
            { key: 'castShadow', label: 'Cast Shadows', type: 'boolean', default: POINT_LIGHT_DEFAULTS.castShadow }
        ],
        Render: PointLightRender
    },
    {
        type: 'spotLight',
        label: 'Spot Light',
        description: 'Cone of light from the object\'s origin along its local down (-Y) axis; rotate the object to aim it.',
        props: [
            { key: 'color', label: 'Color', type: 'color', default: SPOT_LIGHT_DEFAULTS.color },
            { key: 'intensity', label: 'Intensity', type: 'number', default: SPOT_LIGHT_DEFAULTS.intensity, min: 0, max: 10000, step: 1 },
            { key: 'distance', label: 'Distance (0 = unlimited)', type: 'number', default: SPOT_LIGHT_DEFAULTS.distance, min: 0, max: 1000, step: 0.5 },
            { key: 'angle', label: 'Cone Angle (deg)', type: 'number', default: SPOT_LIGHT_DEFAULTS.angle, min: 1, max: 89, step: 1 },
            { key: 'penumbra', label: 'Penumbra', type: 'number', default: SPOT_LIGHT_DEFAULTS.penumbra, min: 0, max: 1, step: 0.05 },
            { key: 'castShadow', label: 'Cast Shadows', type: 'boolean', default: SPOT_LIGHT_DEFAULTS.castShadow }
        ],
        Render: SpotLightRender
    }
];
