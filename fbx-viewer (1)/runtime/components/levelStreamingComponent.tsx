import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useLevelStreaming } from '../levelStreaming';
import { IKPlayerTargetContext } from './ikComponents';
import { ComponentHostContext } from './builtins';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

type Vec3 = [number, number, number];

export interface LevelStreamingSettings {
    levelId: string;
    /** Full extents of the trigger box along the object's local axes. */
    size: Vec3;
    /** Seconds the player must be outside before the level unloads. */
    unloadDelay: number;
}

export const LEVEL_STREAMING_DEFAULTS: LevelStreamingSettings = { levelId: '', size: [40, 20, 40], unloadDelay: 2 };

export const resolveLevelStreamingSettings = (component: LevelComponent): LevelStreamingSettings => {
    const { levelId, size, unloadDelay } = component.props;
    const extent = (index: number) => (Array.isArray(size) && typeof size[index] === 'number' && Number.isFinite(size[index])
        ? Math.min(100000, Math.max(0.1, size[index] as number)) : LEVEL_STREAMING_DEFAULTS.size[index]);
    return {
        levelId: typeof levelId === 'string' ? levelId : '',
        size: [extent(0), extent(1), extent(2)],
        unloadDelay: typeof unloadDelay === 'number' && Number.isFinite(unloadDelay) ? Math.min(600, Math.max(0, unloadDelay)) : LEVEL_STREAMING_DEFAULTS.unloadDelay,
    };
};

const _local = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/** Whether world point `point` is inside a box of full extents `size` centred on `host` (its local axes). */
export const insideStreamingBox = (host: THREE.Object3D, size: Vec3, point: THREE.Vector3): boolean => {
    host.updateWorldMatrix(true, false);
    _local.copy(point).applyMatrix4(_inverse.copy(host.matrixWorld).invert());
    // The host's own scale is part of its matrix, so the box is measured before scaling.
    return Math.abs(_local.x) <= size[0] / 2 && Math.abs(_local.y) <= size[1] / 2 && Math.abs(_local.z) <= size[2] / 2;
};

const StreamingRuntime: React.FC<{ settings: LevelStreamingSettings }> = ({ settings }) => {
    const host = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const streaming = useLevelStreaming();
    const outside = useRef(0);
    const playerPosition = useMemo(() => new THREE.Vector3(), []);

    useFrame((_state, delta) => {
        const box = host?.current;
        const player = playerRef?.current;
        if (!streaming || !box || !player || !settings.levelId) return;
        player.getWorldPosition(playerPosition);
        if (insideStreamingBox(box, settings.size, playerPosition)) {
            outside.current = 0;
            if (!streaming.isLoaded(settings.levelId)) streaming.load(settings.levelId);
        } else if (streaming.isLoaded(settings.levelId)) {
            outside.current += Math.min(delta, 0.1);
            if (outside.current >= settings.unloadDelay) streaming.unload(settings.levelId);
        }
    });

    // A volume that goes away takes its level with it.
    useEffect(() => () => {
        if (streaming && settings.levelId) streaming.unload(settings.levelId);
    }, [streaming, settings.levelId]);

    return null;
};

const StreamingPreview: React.FC<{ settings: LevelStreamingSettings }> = ({ settings }) => (
    <mesh raycast={() => null}>
        <boxGeometry args={settings.size} />
        <meshBasicMaterial color="#a78bfa" wireframe transparent opacity={0.25} depthWrite={false} />
    </mesh>
);

const LevelStreamingRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const settings = useMemo(() => resolveLevelStreamingSettings(component), [component]);
    return mode === 'runtime' ? <StreamingRuntime settings={settings} /> : <StreamingPreview settings={settings} />;
};

export const LEVEL_STREAMING_COMPONENT: ComponentDefinition = {
    type: 'levelStreaming',
    label: 'Level Streaming',
    description: 'Loads another level\'s objects while the player is inside this box and unloads them after the player leaves.',
    props: [
        { key: 'size', label: 'Box size', type: 'vector3', default: LEVEL_STREAMING_DEFAULTS.size, min: 0.1, max: 100000, step: 1 },
        { key: 'unloadDelay', label: 'Unload delay (s)', type: 'number', default: LEVEL_STREAMING_DEFAULTS.unloadDelay, min: 0, max: 600, step: 0.5 },
    ],
    Render: LevelStreamingRender,
};
