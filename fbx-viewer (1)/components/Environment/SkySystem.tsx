
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import { LevelObject, SkyConfig } from '../../types';
import { LocalEnvironment } from '../Scene/LocalEnvironment';

interface SkySystemProps {
    levelObjects: LevelObject[];
}

export const DEFAULT_SKY_CONFIG: SkyConfig = {
    timeOfDay: 14, // 2 PM
    sunIntensity: 1.5,
    ambienceIntensity: 0.5,
    sunColor: '#ffffff',
    fogColor: '#050505',
    fogDensity: 0.02,
    turbidity: 8,
    rayleigh: 1, // Changed default from 3 to 1 for better blue sky
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    inclination: 0.49, // 0.49 ensures sun goes overhead properly
    azimuth: 0.25
};

/** Half the side of the square, around the view, in which the sun casts shadows (world units). */
export const SUN_SHADOW_HALF_EXTENT = 50;
const SUN_SHADOW_MAP_SIZE = 2048;
/** How far the sun sits from the point it lights; its shadows reach this far either side of it. */
const SUN_DISTANCE = 300;
/** The shadowed square is centred this far ahead of the camera, where most of the view is. */
const SUN_SHADOW_LEAD = SUN_SHADOW_HALF_EXTENT * 0.5;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _towardSun = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Where the sun's shadows are centred for a camera: a little ahead of it, moved onto the shadow
 * map's texel grid (in the light's own axes) so shadow edges hold still while the camera moves.
 */
export const sunShadowFocus = (camera: THREE.Camera, towardSun: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => {
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() > 1e-8) _forward.normalize();
    camera.getWorldPosition(out).addScaledVector(_forward, SUN_SHADOW_LEAD);

    _towardSun.copy(towardSun).normalize();
    _right.crossVectors(Math.abs(_towardSun.y) > 0.999 ? WORLD_FORWARD : WORLD_UP, _towardSun).normalize();
    _up.crossVectors(_towardSun, _right);
    const texel = (2 * SUN_SHADOW_HALF_EXTENT) / SUN_SHADOW_MAP_SIZE;
    const across = Math.round(out.dot(_right) / texel) * texel;
    const along = Math.round(out.dot(_up) / texel) * texel;
    const depth = out.dot(_towardSun);
    return out.copy(_right).multiplyScalar(across).addScaledVector(_up, along).addScaledVector(_towardSun, depth);
};

/**
 * A directional light that casts shadows around the view: the default shadow camera only covers
 * a 10 x 10 square at the world origin, so characters and props elsewhere cast none.
 */
const SunLight: React.FC<{ direction: THREE.Vector3; intensity: number; color?: string }> = ({ direction, intensity, color }) => {
    const camera = useThree(state => state.camera);
    const light = useRef<THREE.DirectionalLight>(null);
    const target = useMemo(() => new THREE.Object3D(), []);

    useLayoutEffect(() => {
        const shadowCamera = light.current?.shadow.camera;
        if (!shadowCamera) return;
        shadowCamera.left = shadowCamera.bottom = -SUN_SHADOW_HALF_EXTENT;
        shadowCamera.right = shadowCamera.top = SUN_SHADOW_HALF_EXTENT;
        shadowCamera.near = 1;
        shadowCamera.far = SUN_DISTANCE * 2;
        shadowCamera.updateProjectionMatrix();
    }, []);

    useFrame(() => {
        const sun = light.current;
        if (!sun) return;
        sunShadowFocus(camera, direction, target.position);
        target.updateMatrixWorld();
        sun.position.copy(target.position).addScaledVector(_towardSun.copy(direction).normalize(), SUN_DISTANCE);
    });

    return (
        <>
            <primitive object={target} />
            <directionalLight
                ref={light}
                target={target}
                intensity={intensity}
                color={color}
                castShadow
                shadow-bias={-0.0002}
                shadow-normalBias={0.03}
                shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
            />
        </>
    );
};

const FALLBACK_SUN_DIRECTION = new THREE.Vector3(10, 20, 10);

export const SkySystem: React.FC<SkySystemProps> = ({ levelObjects }) => {
    // 1. Find the Sky Sphere object (First one wins)
    const skyObject = useMemo(() => {
        return levelObjects.find(obj => obj.type === 'sky_sphere');
    }, [levelObjects]);

    // 2. Resolve Configuration
    const config: SkyConfig = skyObject?.skyConfig || DEFAULT_SKY_CONFIG;

    // 3. Calculate Sun Position based on Time of Day (0-24)
    const sunPosition = useMemo(() => {
        const time = config.timeOfDay;
        // 6AM = 0, 12PM = PI/2, 6PM = PI, 12AM = 3PI/2
        // Map 0..24 to 0..2PI relative to sunrise at 6
        const theta = ((time - 6) / 24) * Math.PI * 2;
        
        const r = 100;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const z = 0; // Keeping it simple on XY plane for Day/Night arc

        // Apply azimuth rotation
        const pos = new THREE.Vector3(x, y, z);
        pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), config.azimuth * Math.PI * 2);
        
        return pos;
    }, [config.timeOfDay, config.azimuth]);

    const isNight = config.timeOfDay < 6 || config.timeOfDay > 18;
    // The sun dims through sunset and gives no light below the horizon, where it would light the scene
    // from underneath; a faint moon opposite it keeps the night readable.
    const daylight = THREE.MathUtils.smoothstep(sunPosition.y / 100, -0.05, 0.15);
    const moonPosition = useMemo(() => sunPosition.clone().multiplyScalar(-1), [sunPosition]);

    // Default Fallback if no sky object exists (Standard Editor Lighting)
    if (!skyObject) {
        return (
            <>
                <color attach="background" args={['#050505']} />
                <fog attach="fog" args={['#050505', 10, 60]} />
                <ambientLight intensity={0.4} />
                <SunLight direction={FALLBACK_SUN_DIRECTION} intensity={1.2} />
                <LocalEnvironment />
            </>
        );
    }

    return (
        <>
            {/* Background Color Sync for Fog */}
            <color attach="background" args={[config.fogColor]} />

            {/* Atmosphere */}
            <Sky 
                distance={450000} 
                sunPosition={sunPosition} 
                inclination={config.inclination} 
                azimuth={config.azimuth} 
                turbidity={config.turbidity}
                rayleigh={config.rayleigh}
                mieCoefficient={config.mieCoefficient}
                mieDirectionalG={config.mieDirectionalG}
            />

            {/* Main Sun Light */}
            <SunLight direction={sunPosition} intensity={config.sunIntensity * daylight} color={config.sunColor} />
            <directionalLight position={moonPosition} intensity={config.sunIntensity * 0.12 * (1 - daylight)} color="#9db4ff" />

            {/* Ambient Light (Fill) */}
            <ambientLight intensity={config.ambienceIntensity} />

            {/* Environment Reflections (Synced roughly to time) */}
            <LocalEnvironment night={isNight} />

            {/* Scene Fog */}
            <fog attach="fog" args={[config.fogColor, 0, 1 / Math.max(0.0001, config.fogDensity * 0.5)]} />
        </>
    );
};
