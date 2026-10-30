import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { cascadeSplits, farShadowReach, fitCascade, installDistanceShadows, lookDistance, nearShadowReach, SHADOW_CASCADES, viewSliceSphere } from './distanceShadows';

// Before any lit material compiles: programs built from the plain chunk would be reused for every
// material like them.
installDistanceShadows();

/** Side of each cascade's shadow map, in texels. */
const CASCADE_MAP_SIZE = 2048;
const LOW_DETAIL_CASCADE_MAP_SIZE = 1024;

/** How much distance shadows may cost. Play lowers it when it falls back on low performance. */
export const ShadowDetailContext = createContext<'high' | 'low'>('high');

/** Cascades for a shadow distance: none when off. */
export const cascadeCount = (distance: number): number => (distance > 0 ? SHADOW_CASCADES : 0);

/** A function for how far this view's camera is from what it orbits, this frame (see lookDistance). */
export const useLookDistance = (): (() => number) => {
    const camera = useThree(state => state.camera);
    const controls = useThree(state => state.controls);
    const held = useRef(0);
    return () => (held.current = lookDistance(camera, controls, held.current));
};

const _centre = new THREE.Vector3();

/**
 * The sun's cascades (see runtime/lighting/distanceShadows.ts): black shadow-only lights facing the way
 * `direction` points (toward the sun, read every frame), each fitted to a wider slice of the view out
 * to `distance`. Mount it after the sun's own light, so the sun's map is tried first. A distance of 0
 * leaves only the sun's own map. While `sun` is dark, nothing is drawn.
 */
export const DistanceShadows: React.FC<{
    direction: THREE.Vector3;
    distance: number;
    sun?: React.RefObject<THREE.DirectionalLight | null>;
}> = ({ direction, distance, sun }) => {
    const camera = useThree(state => state.camera);
    const shadowsOn = useThree(state => state.gl.shadowMap.enabled);
    const detail = useContext(ShadowDetailContext);
    const look = useLookDistance();
    const mapSize = detail === 'low' ? LOW_DETAIL_CASCADE_MAP_SIZE : CASCADE_MAP_SIZE;
    const count = shadowsOn ? cascadeCount(distance) : 0;
    const lights = useMemo(() => Array.from({ length: count }, () => {
        const light = new THREE.DirectionalLight(0x000000, 0);
        light.name = 'Distance shadow cascade';
        light.castShadow = true;
        light.shadow.mapSize.set(mapSize, mapSize);
        light.shadow.radius = 2;
        // Drawn when fitted (see below), not every frame.
        light.shadow.autoUpdate = false;
        return light;
    }), [count, mapSize]);
    useEffect(() => () => lights.forEach(light => light.shadow.dispose()), [lights]);

    // Farther cascades change less from frame to frame: the nth is fitted and drawn every nth frame (every
    // 2nth at low detail), and between times keeps the fit its map was drawn with. Back from dark, all at once.
    const frame = useRef(0);
    useFrame(() => {
        if (lights.length === 0) return;
        if (sun?.current && !(sun.current.intensity > 0)) {
            frame.current = 0;
            return;
        }
        camera.updateMatrixWorld();
        // The slices go on from where the sun's own map stops.
        const seen = look();
        const splits = cascadeSplits(nearShadowReach(seen), farShadowReach(distance, seen), lights.length);
        const now = frame.current++;
        const pace = detail === 'low' ? 2 : 1;
        lights.forEach((light, index) => {
            if (light.shadow.map && now % ((index + 1) * pace) !== 0) return;
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
