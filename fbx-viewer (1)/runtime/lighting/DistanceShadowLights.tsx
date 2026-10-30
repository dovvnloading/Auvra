import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { cascadeSplits, fitCascade, installDistanceShadows, MAX_SHADOW_CASCADES, NEAR_SHADOW_REACH, viewSliceSphere } from './distanceShadows';

// Before any lit material compiles: programs built from the plain chunk would be reused for every
// material like them.
installDistanceShadows();

/** Side of each cascade's shadow map, in texels. */
const CASCADE_MAP_SIZE = 2048;

/** Cascades for a shadow distance: none when off, more the farther it reaches. */
export const cascadeCount = (distance: number): number => {
    if (!(distance > 0)) return 0;
    if (distance <= 120) return 1;
    return distance <= 400 ? 2 : MAX_SHADOW_CASCADES;
};

const _centre = new THREE.Vector3();

/**
 * The sun's cascades (see runtime/lighting/distanceShadows.ts): black shadow-only lights facing the way
 * `direction` points (toward the sun, read every frame), each fitted to a wider slice of the view out
 * to `distance`. Mount it after the sun's own light, so the sun's map is tried first. A distance of 0
 * leaves only the sun's own map.
 */
export const DistanceShadows: React.FC<{ direction: THREE.Vector3; distance: number }> = ({ direction, distance }) => {
    const camera = useThree(state => state.camera);
    const count = cascadeCount(distance);
    const lights = useMemo(() => Array.from({ length: count }, () => {
        const light = new THREE.DirectionalLight(0x000000, 0);
        light.name = 'Distance shadow cascade';
        light.castShadow = true;
        light.shadow.mapSize.set(CASCADE_MAP_SIZE, CASCADE_MAP_SIZE);
        light.shadow.radius = 2;
        // Drawn when fitted (see below), not every frame.
        light.shadow.autoUpdate = false;
        return light;
    }), [count]);
    useEffect(() => () => lights.forEach(light => light.shadow.dispose()), [lights]);

    // Farther cascades change less from frame to frame: the nth is fitted and drawn every nth frame, and
    // between times keeps the fit its map was drawn with.
    const frame = useRef(0);
    useFrame(() => {
        if (lights.length === 0) return;
        camera.updateMatrixWorld();
        // The slices go on from where the sun's own map stops.
        const splits = cascadeSplits(NEAR_SHADOW_REACH, distance, lights.length);
        const now = frame.current++;
        lights.forEach((light, index) => {
            if (now % (index + 1) !== 0) return;
            const radius = viewSliceSphere(camera, splits[index], _centre);
            fitCascade(light, _centre, radius, direction);
            light.shadow.needsUpdate = true;
        });
    }, -1);

    return (
        <>
            {lights.map((light, index) => (
                <React.Fragment key={index}>
                    <primitive object={light} />
                    <primitive object={light.target} />
                </React.Fragment>
            ))}
        </>
    );
};
