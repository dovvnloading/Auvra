
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

/**
 * Half the side of the square, around what the camera looks at, in which the sun casts shadows
 * (world units): close up it is small, so shadows are sharp; it grows with the distance to that
 * point, so an overview of a large level still has shadows across the view.
 */
export const SUN_SHADOW_MIN_HALF_EXTENT = 30;
export const SUN_SHADOW_MAX_HALF_EXTENT = 400;
/** Shadow reach per unit of distance from the camera to the point it looks at. */
const SUN_SHADOW_REACH = 1.2;
/** The reach changes in steps of this ratio, so the shadow map is not re-fitted every frame of a zoom. */
const SUN_SHADOW_STEP = 1.25;
const SUN_SHADOW_MAP_SIZE = 2048;
/** How far the sun sits from the point it lights; its shadows reach this far either side of it. */
const SUN_DISTANCE = 800;
/** Where no ground is in view (the camera looks level or up), the point this far ahead stands in for it. */
const SUN_SHADOW_LEAD = 25;

const _forward = new THREE.Vector3();
const _camera = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _towardSun = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * The half extent for a camera that is `distance` from the point it looks at: SUN_SHADOW_REACH times
 * that, rounded up to a SUN_SHADOW_STEP step, within the min and max.
 */
export const sunShadowHalfExtent = (distance: number): number => {
    const wanted = THREE.MathUtils.clamp(distance * SUN_SHADOW_REACH, SUN_SHADOW_MIN_HALF_EXTENT, SUN_SHADOW_MAX_HALF_EXTENT);
    const steps = Math.ceil(Math.log(wanted / SUN_SHADOW_MIN_HALF_EXTENT) / Math.log(SUN_SHADOW_STEP) - 1e-9);
    return Math.min(SUN_SHADOW_MAX_HALF_EXTENT, SUN_SHADOW_MIN_HALF_EXTENT * SUN_SHADOW_STEP ** Math.max(0, steps));
};

/**
 * Where the sun's shadows are centred for a camera, and how far they reach: the point on the
 * ground (y = 0) the camera looks at, or a point SUN_SHADOW_LEAD ahead when it looks level or up,
 * moved onto the shadow map's texel grid (in the light's own axes) so shadow edges hold still
 * while the camera moves. Returns the half extent (see sunShadowHalfExtent).
 */
export const sunShadowFocus = (camera: THREE.Camera, towardSun: THREE.Vector3, out: THREE.Vector3): number => {
    camera.getWorldDirection(_forward);
    camera.getWorldPosition(_camera);
    // Down to the ground along the view, unless that is behind the camera or beyond the furthest reach.
    const toGround = _forward.y < -1e-3 ? -_camera.y / _forward.y : Infinity;
    if (toGround > 0 && toGround < SUN_SHADOW_MAX_HALF_EXTENT / SUN_SHADOW_REACH) {
        out.copy(_camera).addScaledVector(_forward, toGround);
    } else {
        _forward.y = 0;
        if (_forward.lengthSq() > 1e-8) _forward.normalize();
        out.copy(_camera).addScaledVector(_forward, SUN_SHADOW_LEAD);
    }
    const halfExtent = sunShadowHalfExtent(out.distanceTo(_camera));

    _towardSun.copy(towardSun).normalize();
    _right.crossVectors(Math.abs(_towardSun.y) > 0.999 ? WORLD_FORWARD : WORLD_UP, _towardSun).normalize();
    _up.crossVectors(_towardSun, _right);
    const texel = (2 * halfExtent) / SUN_SHADOW_MAP_SIZE;
    const across = Math.round(out.dot(_right) / texel) * texel;
    const along = Math.round(out.dot(_up) / texel) * texel;
    const depth = out.dot(_towardSun);
    out.copy(_right).multiplyScalar(across).addScaledVector(_up, along).addScaledVector(_towardSun, depth);
    return halfExtent;
};

/**
 * A directional light that casts shadows around what the camera looks at, as far as it can see
 * (see sunShadowFocus): the default shadow camera only covers a 10 x 10 square at the world
 * origin, so characters and props elsewhere cast none.
 */
const SunLight: React.FC<{ direction: THREE.Vector3; intensity: number; color?: string }> = ({ direction, intensity, color }) => {
    const camera = useThree(state => state.camera);
    const light = useRef<THREE.DirectionalLight>(null);
    const target = useMemo(() => new THREE.Object3D(), []);
    const fitted = useRef(0);

    useLayoutEffect(() => {
        const shadowCamera = light.current?.shadow.camera;
        if (!shadowCamera) return;
        shadowCamera.near = 1;
        shadowCamera.far = SUN_DISTANCE * 2;
        fitted.current = 0;
    }, []);

    useFrame(() => {
        const sun = light.current;
        if (!sun) return;
        const halfExtent = sunShadowFocus(camera, direction, target.position);
        if (halfExtent !== fitted.current) {
            fitted.current = halfExtent;
            const shadowCamera = sun.shadow.camera;
            shadowCamera.left = shadowCamera.bottom = -halfExtent;
            shadowCamera.right = shadowCamera.top = halfExtent;
            shadowCamera.updateProjectionMatrix();
        }
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
const SKY_FILL_COLOR = '#cfe0ff';
const GROUND_FILL_COLOR = '#5a4a3a';
/** A hemisphere light lights only half as much as an ambient one at the same intensity on average. */
const HEMISPHERE_FILL_SCALE = 1.6;
/** Sky fog density as authored (0.02 by default) to FogExp2's: half, so about a third of the way to
 * fully fogged at 100 units, where the old linear fog was already opaque. */
const FOG_DENSITY_SCALE = 0.5;

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

            {/* Fill: sky-coloured from above, earth-coloured from below, so shaded sides still read */}
            <hemisphereLight args={[SKY_FILL_COLOR, GROUND_FILL_COLOR, config.ambienceIntensity * HEMISPHERE_FILL_SCALE]} />

            {/* Environment Reflections (Synced roughly to time) */}
            <LocalEnvironment night={isNight} />

            {/* Scene fog thickens with distance (exponential), leaving nearby objects clear */}
            <fogExp2 attach="fog" args={[config.fogColor, config.fogDensity * FOG_DENSITY_SCALE]} />
        </>
    );
};
