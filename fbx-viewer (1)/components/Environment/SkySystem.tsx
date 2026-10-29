
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import type { Sky as SkyMesh } from 'three-stdlib';
import { LevelObject, SkyConfig } from '../../types';
import { LocalEnvironment } from '../Scene/LocalEnvironment';
import { publishDaylight } from '../../runtime/daylight';
import { usePhysicsAvailable, usePhysicsQueries, type PhysicsQueries } from '../../runtime/physics';
import { Precipitation } from '../../runtime/precipitation';
import { createSkyLighting, sanitizeWeather, worldClock } from '../../runtime/weather';
import { COVER_SAMPLES_PER_FRAME, weatherCover, type CoverSampler } from '../../runtime/weatherCover';
import { patchWeatherSurfaces, setSurfaceWeather } from '../../runtime/weatherSurfaces';
import { CloudLayer, LightningBolt, NightSky } from './sky/skyObjects';

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
const _cameraPosition = new THREE.Vector3();
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
 * origin, so characters and props elsewhere cast none. `direction` is read every frame, so the
 * sky moves the sun by changing it; `light` lets the sky set its intensity and colour as it goes.
 */
const SunLight: React.FC<{
    direction: THREE.Vector3;
    intensity?: number;
    color?: string;
    light?: React.MutableRefObject<THREE.DirectionalLight | null>;
}> = ({ direction, intensity, color, light: outer }) => {
    const camera = useThree(state => state.camera);
    const own = useRef<THREE.DirectionalLight | null>(null);
    const light = outer ?? own;
    const target = useMemo(() => new THREE.Object3D(), []);
    const fitted = useRef(0);

    useLayoutEffect(() => {
        const shadowCamera = light.current?.shadow.camera;
        if (!shadowCamera) return;
        shadowCamera.near = 1;
        shadowCamera.far = SUN_DISTANCE * 2;
        fitted.current = 0;
    }, [light]);

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
                {...(intensity === undefined ? {} : { intensity })}
                {...(color === undefined ? {} : { color })}
                castShadow
                shadow-bias={-0.0002}
                shadow-normalBias={0.03}
                shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
            />
        </>
    );
};

const FALLBACK_SUN_DIRECTION = new THREE.Vector3(10, 20, 10);
/** A hemisphere light lights only half as much as an ambient one at the same intensity on average. */
const HEMISPHERE_FILL_SCALE = 1.6;
/** Sky fog density as authored (0.02 by default) to FogExp2's: half, so about a third of the way to
 * fully fogged at 100 units, where the old linear fog was already opaque. */
const FOG_DENSITY_SCALE = 0.5;
/** How far the sun and moon lights sit, for their direction. */
const LIGHT_DISTANCE = 100;
/** Lightning's light at its brightest, against the sky's Sun Intensity. */
const LIGHTNING_INTENSITY = 2.2;
/** How often (frames) the scene is looked over for new materials to wet, once the weather is wet. */
const SURFACE_SCAN_FRAMES = 30;

const _sunColor = new THREE.Color();
const _tint = new THREE.Color();
const _authoredFog = new THREE.Color();
const _weatherFog = new THREE.Color();
const FLASH_FOG = new THREE.Color(0.75, 0.8, 0.95);

/**
 * Down from high above (x, z) to the first fixed surface: what covers that spot from the weather.
 * Dynamic and kinematic bodies (characters, vehicles) are not cover.
 */
const coverSampler = (queries: PhysicsQueries, height: () => number): CoverSampler => {
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    return (x, z) => {
        origin.set(x, height(), z);
        const hit = queries.raycast(origin, down, 600, { fixedOnly: true });
        return hit ? hit.point.y : null;
    };
};

interface SkySystemProps {
    levelObjects: LevelObject[];
    /**
     * In play: time moves through the day and the weather changes (and the level's scripts may change
     * them); rain and snow stop at what covers them. In the editor the sky shows the level as set.
     */
    live?: boolean;
}

export const SkySystem: React.FC<SkySystemProps> = ({ levelObjects, live = false }) => {
    // 1. Find the Sky Sphere object (First one wins)
    const skyObject = useMemo(() => {
        return levelObjects.find(obj => obj.type === 'sky_sphere');
    }, [levelObjects]);

    // 2. Resolve Configuration
    const config: SkyConfig = skyObject?.skyConfig || DEFAULT_SKY_CONFIG;
    const weather = useMemo(() => sanitizeWeather(config.weather), [config.weather]);
    const camera = useThree(state => state.camera);
    const scene = useThree(state => state.scene);
    const physics = usePhysicsAvailable();
    const queries = usePhysicsQueries();

    // The clock starts from the sky as set: in the editor whenever it is edited, in play once.
    const resetKey = live
        ? `${skyObject?.id ?? ''}`
        : JSON.stringify([skyObject ? config.timeOfDay : 14, config.dayLength ?? 0, skyObject ? weather : null]);
    useLayoutEffect(() => {
        if (!skyObject) worldClock.reset(14, 0, null, null);
        else worldClock.reset(config.timeOfDay, live ? (config.dayLength ?? 0) : 0, weather, weather?.preset ?? null);
        weatherCover.clear();
        // Read when the effect runs; resetKey says when that is.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);

    const sunDirection = useMemo(() => new THREE.Vector3(0, LIGHT_DISTANCE, 0), []);
    const lighting = useMemo(() => createSkyLighting(), []);
    const sky = useRef<SkyMesh>(null);
    const sun = useRef<THREE.DirectionalLight | null>(null);
    const moon = useRef<THREE.DirectionalLight>(null);
    const flash = useRef<THREE.DirectionalLight>(null);
    const fill = useRef<THREE.HemisphereLight>(null);
    const fog = useMemo(() => new THREE.FogExp2('#050505', 0.01), []);
    const background = useMemo(() => new THREE.Color('#050505'), []);
    const clouds = useMemo(() => new CloudLayer(), []);
    const night = useMemo(() => new NightSky(), []);
    const bolt = useMemo(() => new LightningBolt(), []);
    const precipitation = useMemo(() => new Precipitation(), []);
    const sampler = useMemo(
        () => (live && physics ? coverSampler(queries, () => camera.getWorldPosition(_cameraPosition).y + 150) : null),
        [live, physics, queries, camera],
    );
    const [isNight, setNight] = useState(false);
    const [reflections, setReflections] = useState(0.8);
    const frame = useRef(0);
    const surfacesWet = useRef(false);

    useEffect(() => () => {
        clouds.dispose();
        night.dispose();
        bolt.dispose();
        precipitation.dispose();
    }, [clouds, night, bolt, precipitation]);

    // What reacts to the light (vehicle headlights) and the weather (wet surfaces) goes back to normal without a sky.
    useEffect(() => () => {
        publishDaylight(null);
        setSurfaceWeather(0, 0, null);
    }, []);

    // The sky's fog (exponential: it thickens with distance, leaving nearby objects clear) and the
    // background behind it are set on the scene directly, every frame: attached as elements, the
    // no-sky fallback's fog detaching after them would clear them.
    useEffect(() => () => {
        if (scene.fog === fog) scene.fog = null;
        if (scene.background === background) scene.background = null;
    }, [scene, fog, background]);

    useFrame((_, delta) => {
        if (live) worldClock.step(delta);
        if (!skyObject) {
            publishDaylight(1);
            setSurfaceWeather(0, 0, null);
            return;
        }
        const now = worldClock.lighting(config.azimuth, lighting);
        const state = worldClock.weather;
        sunDirection.set(now.sun.x, now.sun.y, now.sun.z).multiplyScalar(LIGHT_DISTANCE);
        publishDaylight(now.light);

        // The sky's own colour: the sun's place, hazier under cloud.
        const skyMaterial = sky.current?.material;
        if (skyMaterial?.uniforms) {
            (skyMaterial.uniforms.sunPosition.value as THREE.Vector3).copy(sunDirection);
            skyMaterial.uniforms.turbidity.value = config.turbidity + state.clouds * 6 + state.fog * 6;
            skyMaterial.uniforms.rayleigh.value = config.rayleigh * (1 - 0.6 * state.clouds * state.clouds);
        }

        // Sun, moon, fill and lightning.
        _sunColor.set(config.sunColor).multiply(_tint.setRGB(now.sunTint[0], now.sunTint[1], now.sunTint[2]));
        if (sun.current) {
            sun.current.intensity = config.sunIntensity * now.sunIntensity;
            sun.current.color.copy(_sunColor);
        }
        if (moon.current) {
            moon.current.position.copy(sunDirection).multiplyScalar(-1);
            moon.current.intensity = config.sunIntensity * 0.12 * now.moonIntensity;
        }
        if (fill.current) {
            fill.current.intensity = config.ambienceIntensity * HEMISPHERE_FILL_SCALE * now.ambient;
            fill.current.color.setRGB(now.skyFill[0], now.skyFill[1], now.skyFill[2]);
            fill.current.groundColor.setRGB(now.groundFill[0], now.groundFill[1], now.groundFill[2]);
        }
        const strike = worldClock.strike;
        if (flash.current) {
            flash.current.intensity = worldClock.flash * config.sunIntensity * LIGHTNING_INTENSITY;
            if (strike) flash.current.position.set(Math.sin(strike.bearing) * 40, 80, Math.cos(strike.bearing) * 40);
        }

        // Fog: as set or the horizon's colour, greyed and thickened by the weather.
        if ((config.fogMode ?? 'custom') === 'sky') _authoredFog.setRGB(now.horizon[0], now.horizon[1], now.horizon[2]);
        else _authoredFog.set(config.fogColor);
        _weatherFog.setRGB(now.weatherFog[0], now.weatherFog[1], now.weatherFog[2]);
        fog.color.copy(_authoredFog).lerp(_weatherFog, now.weatherFogAmount).lerp(FLASH_FOG, worldClock.flash * 0.3);
        fog.density = config.fogDensity * FOG_DENSITY_SCALE + now.fogDensity;
        background.copy(fog.color);
        if (scene.fog !== fog) scene.fog = fog;
        if (scene.background !== background) scene.background = background;

        // Clouds, stars and moon, lightning, rain and snow.
        clouds.update(camera, now, state, worldClock.flash, delta);
        night.update(camera, now, delta);
        bolt.update(camera, strike, worldClock.flash);
        if (sampler) {
            camera.getWorldPosition(_cameraPosition);
            weatherCover.centre(_cameraPosition.x, _cameraPosition.z);
            weatherCover.refresh(COVER_SAMPLES_PER_FRAME, sampler);
        }
        precipitation.update(delta, camera, state, sampler ? weatherCover : null, Math.min(1, now.light + worldClock.flash));

        // Wet and snowy surfaces: once the weather first wets anything, materials are patched as they appear.
        if (worldClock.wetness > 0.001 || worldClock.snowCover > 0.001) surfacesWet.current = true;
        if (surfacesWet.current && frame.current++ % SURFACE_SCAN_FRAMES === 0) patchWeatherSurfaces(scene);
        setSurfaceWeather(worldClock.wetness, worldClock.snowCover, sampler ? weatherCover : null);

        // Reflections dim with the light; the night rig takes over after dark.
        const dark = now.daylight < 0.2;
        if (dark !== isNight) setNight(dark);
        const wanted = Math.round(0.8 * (0.3 + 0.7 * Math.max(now.light, 0.15)) * 20) / 20;
        if (wanted !== reflections) setReflections(wanted);
    }, -1);

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
            {/* Atmosphere; the sun's place and haze are set every frame */}
            <Sky
                ref={sky}
                distance={450000}
                sunPosition={sunDirection}
                inclination={config.inclination}
                azimuth={config.azimuth}
                turbidity={config.turbidity}
                rayleigh={config.rayleigh}
                mieCoefficient={config.mieCoefficient}
                mieDirectionalG={config.mieDirectionalG}
            />
            <primitive object={night.object} />
            <primitive object={clouds.object} />
            <primitive object={bolt.object} />
            <primitive object={precipitation.object} />

            {/* Sun, a faint moon opposite it, and lightning: always there, dark when idle, so lit materials never recompile */}
            <SunLight direction={sunDirection} light={sun} />
            <directionalLight ref={moon} color="#9db4ff" intensity={0} />
            <directionalLight ref={flash} color="#c8d8ff" intensity={0} />

            {/* Fill: sky-coloured from above, earth-coloured from below, so shaded sides still read */}
            <hemisphereLight ref={fill} />

            {/* Environment Reflections (Synced roughly to time) */}
            <LocalEnvironment night={isNight} intensity={reflections} />
        </>
    );
};
