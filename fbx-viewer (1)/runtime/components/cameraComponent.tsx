import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { cameraDirector } from '../cameraDirector';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

export interface CameraSettings {
    fov: number;
    /** Shown as soon as play starts, instead of the gameplay camera. */
    startActive: boolean;
    /** Seconds to blend in when it starts active. */
    blendIn: number;
}

export const CAMERA_DEFAULTS: CameraSettings = { fov: 60, startActive: false, blendIn: 0 };

export const resolveCameraSettings = (component: LevelComponent): CameraSettings => {
    const { fov, startActive, blendIn } = component.props;
    const finite = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    return {
        fov: finite(fov, CAMERA_DEFAULTS.fov, 10, 150),
        startActive: typeof startActive === 'boolean' ? startActive : CAMERA_DEFAULTS.startActive,
        blendIn: finite(blendIn, CAMERA_DEFAULTS.blendIn, 0, 30),
    };
};

/** Line segments outlining a camera's view pyramid, `length` long, looking down local -Z. */
export const frustumLines = (fov: number, aspect: number, length: number): Float32Array => {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * length;
    const halfWidth = halfHeight * aspect;
    const corners = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]];
    const points: number[] = [];
    corners.forEach(([x, y], index) => {
        const [nx, ny] = corners[(index + 1) % corners.length];
        points.push(0, 0, 0, x, y, -length);
        points.push(x, y, -length, nx, ny, -length);
    });
    // The "up" marker above the far edge.
    points.push(-halfWidth * 0.4, halfHeight * 1.1, -length, 0, halfHeight * 1.5, -length, 0, halfHeight * 1.5, -length, halfWidth * 0.4, halfHeight * 1.1, -length);
    return new Float32Array(points);
};

const CameraRuntime: React.FC<{ objectId: string; settings: CameraSettings }> = ({ objectId, settings }) => {
    const camera = useMemo(() => new THREE.PerspectiveCamera(settings.fov, 16 / 9, 0.1, 2000), []);
    camera.fov = settings.fov;

    useEffect(() => {
        const unregister = cameraDirector.register(objectId, camera);
        if (settings.startActive) cameraDirector.setActive(objectId, settings.blendIn);
        return unregister;
    // Start-active applies when play starts, not when the settings are edited.
    }, [camera, objectId]);

    return <primitive object={camera} />;
};

const CameraPreview: React.FC<{ settings: CameraSettings }> = ({ settings }) => {
    const geometry = useMemo(() => {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute('position', new THREE.BufferAttribute(frustumLines(settings.fov, 16 / 9, 1.5), 3));
        return lines;
    }, [settings.fov]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    return (
        <lineSegments geometry={geometry} raycast={() => null}>
            <lineBasicMaterial color="#f472b6" transparent opacity={0.8} depthTest={false} />
        </lineSegments>
    );
};

const CameraRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => resolveCameraSettings(component), [component]);
    return mode === 'runtime' ? <CameraRuntime objectId={object.id} settings={settings} /> : <CameraPreview settings={settings} />;
};

/** Applies the camera director's choice to the rendered camera each frame. Mount after the gameplay camera rig. */
export const CameraDirectorDriver: React.FC = () => {
    useFrame(({ camera }, delta) => {
        if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) cameraDirector.apply(camera as THREE.PerspectiveCamera, delta);
    });
    useEffect(() => () => cameraDirector.reset(), []);
    return null;
};

export const CAMERA_COMPONENT: ComponentDefinition = {
    type: 'camera',
    label: 'Camera',
    description: 'A level camera looking down the object\'s -Z axis. Timelines, the Set Active Camera node and scripts switch the view to it and back.',
    props: [
        { key: 'fov', label: 'Field of view (deg)', type: 'number', default: CAMERA_DEFAULTS.fov, min: 10, max: 150, step: 1 },
        { key: 'startActive', label: 'Active at start', type: 'boolean', default: CAMERA_DEFAULTS.startActive },
        { key: 'blendIn', label: 'Start blend (s)', type: 'number', default: CAMERA_DEFAULTS.blendIn, min: 0, max: 30, step: 0.1 },
    ],
    Render: CameraRender,
};
