
import { renderView } from './renderBundle';
import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import type { Sky as SkyMesh } from 'three-stdlib';
import { LevelObject, SkyConfig } from '../../types';
import { LocalEnvironment } from '../Scene/LocalEnvironment';
import { publishDaylight, publishSkyLight } from '../../runtime/daylight';
import { usePhysicsAvailable, usePhysicsQueries, type PhysicsQueries } from '../../runtime/physicsQueries';
import { Precipitation } from '../../runtime/precipitation';
import { createSkyLighting, sanitizeWeather, windVelocity, worldClock } from '../../runtime/weather';
import { COVER_SAMPLES_PER_FRAME, weatherCover, type CoverSampler } from '../../runtime/weatherCover';
import { patchWeatherSurfaces, patchWindSurfaces, setSurfaceWeather } from '../../runtime/weatherSurfaces';
import { stepWind, windUniforms } from '../../runtime/wind';
import { CloudLayer, LightningBolt, NightSky } from './sky/skyObjects';
import { DistanceShadows, ShadowDetailContext, useLookDistance } from '../../runtime/lighting/DistanceShadowLights';
import { DEFAULT_SHADOW_DISTANCE, fitCascade, nearShadowReach, viewSliceSphere } from '../../runtime/lighting/distanceShadows';
import { setSceneSky, type SceneSky } from '../../runtime/lighting/skyScene';
import {
    atmosphereCoefficients, cloudThreshold, eyeAdaptation, horizonColour, linearFromHex, MOON_ANGULAR_RADIUS, overcastSky, SKY_EXPOSURE, skyAmbient, sunlightAt, SUN_ANGULAR_RADIUS,
} from '../../runtime/sky/atmosphere';
import {
    resolveSkyImage, resolveSkyLight, skyModel,
} from '../../runtime/sky/skySettings';
import { skyDirector, skyLookOf, type SkyLook } from '../../runtime/sky/skyDirector';
import { useGameContent } from '../../runtime/GameContentContext';
import { skyRenderer, WEATHER_TILES_PER_KM, type SkyFrame } from './sky/SkyRenderer';
import { dayPreview } from './sky/dayPreview';

const _sliceCentre = new THREE.Vector3();

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
const SUN_SHADOW_BIAS = -0.0002;
const SUN_SHADOW_NORMAL_BIAS = 0.03;
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
    /**
     * With distance shadows carrying the far view: the sun's own map covers just the view's first units
     * (see nearShadowReach), so near shadows stay sharp however far the camera looks. Otherwise it follows
     * the point looked at and widens with its distance.
     */
    cascaded?: boolean;
}> = ({ direction, intensity, color, light: outer, cascaded = false }) => {
    const camera = useThree(state => state.camera);
    const look = useLookDistance();
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
        // A dark sun (at night) casts nothing to draw.
        sun.shadow.autoUpdate = sun.intensity > 0;
        if (cascaded) {
            camera.updateMatrixWorld();
            const radius = viewSliceSphere(camera, nearShadowReach(look()), _sliceCentre);
            fitCascade(sun, _sliceCentre, radius, direction);
            fitted.current = 0;
            return;
        }
        const halfExtent = sunShadowFocus(camera, direction, target.position);
        if (halfExtent !== fitted.current) {
            fitted.current = halfExtent;
            const shadowCamera = sun.shadow.camera;
            shadowCamera.left = shadowCamera.bottom = -halfExtent;
            shadowCamera.right = shadowCamera.top = halfExtent;
            // Distance shadows may have just given the map up, with their own depth range and bias.
            shadowCamera.near = 1;
            shadowCamera.far = SUN_DISTANCE * 2;
            shadowCamera.updateProjectionMatrix();
            sun.shadow.bias = SUN_SHADOW_BIAS;
            sun.shadow.normalBias = SUN_SHADOW_NORMAL_BIAS;
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
                shadow-bias={SUN_SHADOW_BIAS}
                shadow-normalBias={SUN_SHADOW_NORMAL_BIAS}
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
const _white = new THREE.Color(1, 1, 1);
const _black = new THREE.Color(0, 0, 0);
/** Below this height the sun gives no light and the moon takes over: the two never light the scene at once. */
const SUN_GONE = -0.012;
const WIND_ON_CLOUDS = 3;
const CLOUD_BRIGHTNESS = 1;
/**
 * The Sky Light's strength at Intensity 1. Picture-making keeps shade well above what a strict ratio to direct
 * sun would give, and more so at night, when the eye has adapted to the dark.
 */
const SKY_LIGHT_GAIN = 1.5;
const NIGHT_SHADE_LIFT = 2.2;
/** Moonlight's strength on the scene against its Moonlight setting: readable, as a night in a picture is. */
const MOONLIGHT_GAIN = 1.5;
/** The Night Air colour's strength in the sky: colours pick poorly at this end of the range. */
const NIGHT_AIR_LIGHT = 2;
/** Sky Light: seconds between live captures while the sky is moving, and while only the clouds are. */
const LIVE_CAPTURE_SECONDS = 0.2;
const CLOUD_CAPTURE_SECONDS = 1.5;
/** Captures again this long after a change, once the clouds' map has caught up with it. */
const SETTLED_CAPTURE_SECONDS = 0.6;
const _key = new THREE.Vector3();
const _sunUnit = new THREE.Vector3();
const _moonUnit = new THREE.Vector3();
const _skyColour = new THREE.Color();
const _rgb: [number, number, number] = [0, 0, 0];
const _sunlight: [number, number, number] = [0, 0, 0];
const _horizon: [number, number, number] = [0, 0, 0];
const _ambient: [number, number, number] = [0, 0, 0];
const _visibility = { x: 0, z: 0, size: 1, y: 0 };

/** A panorama for the sky or the Sky Light, from a texture's url. */
const usePanorama = (url: string | undefined): THREE.Texture | null => {
    const [texture, setTexture] = useState<THREE.Texture | null>(null);
    const showing = useRef<THREE.Texture | null>(null);
    useEffect(() => {
        const show = (next: THREE.Texture | null) => {
            showing.current?.dispose();
            showing.current = next;
            setTexture(next);
        };
        if (!url) {
            show(null);
            return undefined;
        }
        let live = true;
        new THREE.TextureLoader().load(url, next => {
            if (!live) {
                next.dispose();
                return;
            }
            next.colorSpace = THREE.SRGBColorSpace;
            next.wrapS = THREE.RepeatWrapping;
            next.minFilter = THREE.LinearFilter;
            next.generateMipmaps = false;
            show(next);
        });
        return () => {
            live = false;
        };
    }, [url]);
    useEffect(() => () => {
        showing.current?.dispose();
        showing.current = null;
    }, []);
    return texture;
};
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
    const gl = useThree(state => state.gl);
    const physics = usePhysicsAvailable();
    const queries = usePhysicsQueries();
    const detail = useContext(ShadowDetailContext);
    const orbitDistance = useLookDistance();

    // What the sky is made of, past the clock and the weather. A level without a Sky Sphere keeps the plain editor light.
    const model = skyObject ? skyModel(config) : 'classic';
    const atmospheric = model !== 'classic';
    const ownLook = useMemo(() => skyLookOf(config), [config]);
    const lastLook = useRef<{ look: SkyLook; coefficients: ReturnType<typeof atmosphereCoefficients> } | null>(null);
    const skyLightSettings = useMemo(() => resolveSkyLight(config.skyLight), [config.skyLight]);
    const panoramaSettings = useMemo(() => resolveSkyImage(config.panorama), [config.panorama]);
    const skyLit = atmospheric && skyLightSettings.enabled;
    const { textures } = useGameContent();
    const panoramaTexture = textures.find(texture => texture.id === panoramaSettings.textureId) ?? textures.find(texture => texture.name === panoramaSettings.textureId);
    const panorama = usePanorama(panoramaTexture?.url);
    useEffect(() => {
        renderView.panorama = model === 'image' && panoramaTexture?.url
            ? { url: panoramaTexture.url, rotation: panoramaSettings.rotation, brightness: panoramaSettings.brightness }
            : null;
        return () => { renderView.panorama = null; };
    }, [model, panoramaTexture?.url, panoramaSettings.rotation, panoramaSettings.brightness]);
    const skyLightImage = skyLightSettings.source === 'image' ? panorama : null;
    const skyDome = useMemo(() => (atmospheric ? skyRenderer.createDome() : null), [atmospheric]);
    useEffect(() => (atmospheric ? skyRenderer.acquire() : undefined), [atmospheric]);
    const sceneSky = useMemo<SceneSky>(() => ({
        fogScale: [1, 1, 1], fogFollowsSky: false, fogShare: 0, fogGrey: 0, lightOn: false, occlusion: 0, occlusionFloor: 0, reflections: 1,
        areaX: 0, areaZ: 0, areaSize: 1, areaY: 0, cloudTiling: 0, cloudDriftU: 0, cloudDriftV: 0, cloudThreshold: 1,
        cloudLeanX: 0, cloudLeanZ: 0, cloudHeight: 0, cloudStrength: 0,
    }), []);
    useLayoutEffect(() => (atmospheric ? setSceneSky(scene, sceneSky) : undefined), [atmospheric, scene, sceneSky]);
    // Handed back as the fill's own light: the capture sets it each time.
    useLayoutEffect(() => {
        if (!skyLit) return undefined;
        return () => {
            scene.environment = null;
            scene.environmentIntensity = 1;
            skyRenderer.releaseSkyLight(gl);
        };
    }, [skyLit, scene, gl]);
    const skyLightKey = useMemo(() => JSON.stringify([model, config.panorama, skyLightSettings, config.atmosphere, config.cloudLayer, config.timeOfDay, config.azimuth, config.sunTilt, config.sunColor, config.sunIntensity, config.weather, config.night, skyLightImage?.uuid]), [model, skyLightSettings, config, skyLightImage]);
    const capture = useRef({ key: '', since: 0, settle: 0, sunY: NaN, sunX: NaN, cloudsReady: false });
    const cloudDrift = useRef({ x: 0, z: 0 });
    /** Colours the model works out when the sun moves, not every frame. */
    const modelColours = useRef({ sunX: NaN, sunY: NaN, sunZ: NaN, coefficients: null as unknown, horizon: [0, 0, 0] as [number, number, number], ambient: [0, 0, 0] as [number, number, number] });
    const skyFrame = useMemo<SkyFrame>(() => ({
        time: 0, coefficients: atmosphereCoefficients(ownLook.atmosphere), sun: new THREE.Vector3(0, 1, 0), moon: new THREE.Vector3(0, -1, 0), moonLight: 0, glow: [0, 0, 0],
        viewHeight: 0.002, skyScale: [1, 1, 1], cloudScale: [1, 1, 1], skyGrey: 0, sunRadiance: [0, 0, 0], sunRadius: SUN_ANGULAR_RADIUS, moonRadiance: [0, 0, 0], moonRadius: MOON_ANGULAR_RADIUS,
        moonPhase: 0.5, stars: 0, milkyWay: 0, starAngle: 0, flash: 0,
        clouds: { quality: 'off', coverage: 0, base: 1.5, depth: 2.2, density: 1, detail: 0.5, scale: 1, offsetX: 0, offsetZ: 0, key: new THREE.Vector3(0, 1, 0), keyStrength: 1, ambient: [0, 0, 0], groundAmbient: [0, 0, 0] },
        flatCloud: [0, 0, 0], flatCover: 0, panorama: null, panoramaTurn: 0, panoramaScale: [1, 1, 1],
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    // The clock starts from the sky as set: in the editor whenever it is edited, in play once.
    const resetKey = live
        ? `${skyObject?.id ?? ''}`
        : JSON.stringify([skyObject ? config.timeOfDay : 14, config.dayLength ?? 0, skyObject ? weather : null]);
    useLayoutEffect(() => {
        if (!skyObject) worldClock.reset(14, 0, null, null);
        else worldClock.reset(config.timeOfDay, live ? (config.dayLength ?? 0) : 0, weather, weather?.preset ?? null);
        skyDirector.reset();
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
    useEffect(() => {
        renderView.skyLights = skyLit;
        return () => { renderView.skyLights = false; };
    }, [skyLit]);

    useEffect(() => {
        if (!skyObject) return undefined;
        renderView.drawSky = atmospheric
            ? (renderer, onto) => skyRenderer.drawSkyOnto(renderer, onto)
            : (renderer, onto) => {
                if (!sky.current) return;
                const faces = new THREE.CubeCamera(0.1, LIGHT_DISTANCE, onto);
                camera.getWorldPosition(faces.position);
                const skyOnly = new THREE.Scene();
                skyOnly.add(sky.current.clone(), night.object.clone(), clouds.object.clone());
                faces.update(renderer, skyOnly);
            };
        return () => { renderView.drawSky = null; };
    }, [skyObject, atmospheric, camera, night, clouds]);
    const [isNight, setNight] = useState(false);
    const [reflections, setReflections] = useState(0.8);
    const frame = useRef(0);
    const windScan = useRef(0);
    const surfacesWet = useRef(false);

    useEffect(() => () => {
        clouds.dispose();
        night.dispose();
        bolt.dispose();
        precipitation.dispose();
    }, [clouds, night, bolt, precipitation]);

    // The classic sky reaches the scene as a primitive, and nothing frees a primitive when it leaves.
    const classicSky = !!skyObject && !atmospheric;
    useEffect(() => {
        const mesh = sky.current;
        if (!classicSky || !mesh) return undefined;
        return () => {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
        };
    }, [classicSky]);

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

    useFrame((rootState, delta) => {
        if (live) worldClock.step(delta);
        else if (dayPreview.speed > 0 && dayPreview.time !== rootState.clock.elapsedTime) {
            dayPreview.time = rootState.clock.elapsedTime;
            worldClock.setHours(worldClock.hours + delta * dayPreview.speed);
        }
        // The wind blows in the editor too, so foliage and cloth can be seen moving as they will.
        stepWind(delta);
        if (windUniforms.uWindStrength.value > 0.05 && windScan.current++ % SURFACE_SCAN_FRAMES === 0) patchWindSurfaces(scene);
        if (!skyObject) {
            publishDaylight(1);
            setSurfaceWeather(0, 0, null);
            publishSkyLight(FALLBACK_SUN_DIRECTION, _white, 0.6, 0, _black);
            return;
        }
        // What the sky is now: the level's own, or on its way to where a script has sent it.
        const look = atmospheric ? (live ? skyDirector.step(ownLook, delta) : ownLook) : null;
        if (look && lastLook.current?.look !== look) lastLook.current = { look, coefficients: atmosphereCoefficients(look.atmosphere) };
        const now = worldClock.lighting(look ? look.azimuth : config.azimuth, lighting, look ? look.tilt : 0);
        const state = worldClock.weather;
        sunDirection.set(now.sun.x, now.sun.y, now.sun.z).multiplyScalar(LIGHT_DISTANCE);
        publishDaylight(now.light);

        if (look) {
            const { atmosphere, clouds: cloudSettings, night: nightSettings } = look;
            const coefficients = lastLook.current!.coefficients;
            // The sun, or once it has gone the moon, is the one light that casts shadows.
            _sunUnit.set(now.sun.x, now.sun.y, now.sun.z);
            _moonUnit.set(-now.sun.x, -now.sun.y, -now.sun.z + 0.15).normalize();
            const strength = look.sunIntensity;
            const sunFade = THREE.MathUtils.smoothstep(now.sun.y, SUN_GONE, 0.04);
            const falling = Math.max(state.rain, state.snow);
            const phaseLight = (1 - Math.cos(nightSettings.moonPhase * Math.PI * 2)) / 2;
            const moonFade = THREE.MathUtils.smoothstep(_moonUnit.y, 0, 0.06) * (1 - THREE.MathUtils.smoothstep(now.sun.y, SUN_GONE - 0.04, SUN_GONE));
            const direct = now.sunIntensity / Math.max(now.daylight, 1e-3);
            const viewHeight = Math.max(camera.getWorldPosition(_cameraPosition).y, 2) / 1000;
            linearFromHex(look.sunColor, _rgb);
            const [tintR, tintG, tintB] = _rgb;

            // What the air leaves of the sunlight, and the sky's colours, when the sun has moved.
            const colours = modelColours.current;
            const moved = Math.abs(now.sun.x - colours.sunX) + Math.abs(now.sun.y - colours.sunY) + Math.abs(now.sun.z - colours.sunZ);
            if (moved > 0.002 || colours.coefficients !== coefficients) {
                colours.sunX = now.sun.x;
                colours.sunY = now.sun.y;
                colours.sunZ = now.sun.z;
                colours.coefficients = coefficients;
                horizonColour(coefficients, now.sun, viewHeight, colours.horizon);
                skyAmbient(coefficients, now.sun, viewHeight, colours.ambient);
            }
            sunlightAt(coefficients, Math.max(now.sun.y, 0.004), viewHeight, _sunlight);

            const nightAir = 1 - THREE.MathUtils.smoothstep(now.sun.y, -0.2, 0.02);
            linearFromHex(nightSettings.glow, _rgb);
            // The eye opens as the light falls: the sun and the sky it lights both read brighter than they are.
            const adapted = eyeAdaptation(now.sun.y);
            const skyPerUnit = (NIGHT_AIR_LIGHT / Math.max(strength, 1e-3)) / adapted;
            const moonSky = (nightSettings.moonBrightness * phaseLight * 0.07 * moonFade) / adapted;
            const glow: [number, number, number] = [_rgb[0] * nightAir * skyPerUnit, _rgb[1] * nightAir * skyPerUnit, _rgb[2] * nightAir * skyPerUnit];
            const skyScale = strength * atmosphere.brightness * SKY_EXPOSURE * adapted * overcastSky(state.clouds);
            _ambient[0] = colours.ambient[0] + glow[0] + moonSky * 0.1;
            _ambient[1] = colours.ambient[1] + glow[1] + moonSky * 0.12;
            _ambient[2] = colours.ambient[2] + glow[2] + moonSky * 0.16;
            _horizon[0] = (colours.horizon[0] + glow[0]) * skyScale * tintR;
            _horizon[1] = (colours.horizon[1] + glow[1]) * skyScale * tintG;
            _horizon[2] = (colours.horizon[2] + glow[2]) * skyScale * tintB;

            // Lights.
            const usingMoon = now.sun.y < SUN_GONE;
            _key.copy(usingMoon ? _moonUnit : _sunUnit);
            sunDirection.copy(_key).multiplyScalar(LIGHT_DISTANCE);
            if (sun.current) {
                if (usingMoon) {
                    sun.current.intensity = strength * nightSettings.moonBrightness * MOONLIGHT_GAIN * phaseLight * moonFade * (1 - 0.85 * state.clouds);
                    sun.current.color.setRGB(0.62, 0.72, 1);
                } else {
                    sun.current.intensity = strength * sunFade * direct * adapted;
                    sun.current.color.setRGB(tintR * _sunlight[0], tintG * _sunlight[1], tintB * _sunlight[2]);
                }
            }
            if (moon.current) moon.current.intensity = 0;
            if (fill.current) {
                // With a Sky Light the sky itself is the fill; without one, a flat fill in the sky's colours.
                fill.current.intensity = skyLit ? 0 : 1;
                const fillScale = config.ambienceIntensity * skyScale * Math.PI;
                fill.current.color.setRGB(_ambient[0] * fillScale, _ambient[1] * fillScale, _ambient[2] * fillScale);
                const groundScale = fillScale * 0.5;
                fill.current.groundColor.setRGB(_ambient[0] * coefficients.ground[0] * groundScale, _ambient[1] * coefficients.ground[1] * groundScale, _ambient[2] * coefficients.ground[2] * groundScale);
            }
            const strike = worldClock.strike;
            if (flash.current) {
                flash.current.intensity = worldClock.flash * strength * LIGHTNING_INTENSITY;
                if (strike) flash.current.position.set(Math.sin(strike.bearing) * 40, 80, Math.cos(strike.bearing) * 40);
            }

            // Fog: the sky's own colour in each direction, greyed by the weather, or the colour as set.
            const followsSky = (config.fogMode ?? 'custom') === 'sky';
            if (followsSky) _authoredFog.setRGB(_horizon[0], _horizon[1], _horizon[2]);
            else _authoredFog.set(config.fogColor);
            const weatherLight = Math.min(strength / Math.PI, 2);
            _weatherFog.setRGB(now.weatherFog[0] * weatherLight, now.weatherFog[1] * weatherLight, now.weatherFog[2] * weatherLight);
            fog.color.copy(_authoredFog).lerp(_weatherFog, now.weatherFogAmount).lerp(FLASH_FOG, worldClock.flash * 0.3);
            fog.density = look.fogDensity * FOG_DENSITY_SCALE + now.fogDensity;
            background.copy(fog.color);
            if (scene.fog !== fog) scene.fog = fog;
            if (scene.background !== background) scene.background = background;
            _skyColour.setRGB(tintR, tintG, tintB);
            publishSkyLight(now.sun, _skyColour, strength * now.sunIntensity, fog.density, fog.color);

            // The sky's frame.
            const drawing = skyFrame;
            const useClouds = model === 'atmosphere' ? cloudSettings.quality : 'off';
            const lowDetail = detail === 'low' && useClouds !== 'off' && useClouds !== 'layer';
            drawing.time = rootState.clock.elapsedTime;
            drawing.coefficients = coefficients;
            drawing.sun.copy(_sunUnit);
            drawing.moon.copy(_moonUnit);
            drawing.moonLight = moonSky;
            drawing.glow = glow;
            drawing.viewHeight = viewHeight;
            drawing.skyScale = [skyScale * tintR, skyScale * tintG, skyScale * tintB];
            drawing.skyGrey = 0.8 * THREE.MathUtils.smoothstep(state.clouds, 0.55, 1);
            const cloudLight = strength * atmosphere.brightness * CLOUD_BRIGHTNESS * adapted;
            drawing.cloudScale = [cloudLight * tintR, cloudLight * tintG, cloudLight * tintB];
            const size = look.sunSize;
            const disc = 26 * strength * sunFade / (size * size);
            drawing.sunRadiance = [disc * tintR, disc * tintG, disc * tintB];
            drawing.sunRadius = SUN_ANGULAR_RADIUS * size;
            const moonGlow = (0.5 + nightSettings.moonBrightness * 7) * Math.min(1, nightAir * 1.4);
            drawing.moonRadiance = [moonGlow * 0.96, moonGlow * 0.98, moonGlow];
            drawing.moonRadius = MOON_ANGULAR_RADIUS * nightSettings.moonSize;
            drawing.moonPhase = nightSettings.moonPhase;
            drawing.stars = now.stars * nightSettings.stars;
            drawing.milkyWay = nightSettings.milkyWay;
            drawing.starAngle = (worldClock.hours / 24) * Math.PI * 2;
            drawing.flash = worldClock.flash * 2;
            const [wx, wz] = windVelocity(state);
            cloudDrift.current.x += (wx * delta * WIND_ON_CLOUDS) / 1000;
            cloudDrift.current.z += (wz * delta * WIND_ON_CLOUDS) / 1000;
            const cloudsNow = drawing.clouds;
            cloudsNow.quality = lowDetail ? 'low' : useClouds;
            cloudsNow.coverage = state.clouds;
            cloudsNow.base = cloudSettings.altitude / 1000;
            cloudsNow.depth = cloudSettings.thickness / 1000;
            cloudsNow.density = cloudSettings.density;
            cloudsNow.detail = cloudSettings.detail;
            cloudsNow.scale = cloudSettings.scale;
            cloudsNow.offsetX = cloudDrift.current.x + _cameraPosition.x / 1000;
            cloudsNow.offsetZ = cloudDrift.current.z + _cameraPosition.z / 1000;
            cloudsNow.key.copy(_key);
            cloudsNow.keyStrength = (usingMoon ? (nightSettings.moonBrightness * phaseLight * 0.5 * moonFade) / adapted : sunFade) * (1 - 0.55 * falling);
            cloudsNow.ambient = [_ambient[0] * (1 - 0.5 * falling), _ambient[1] * (1 - 0.5 * falling), _ambient[2] * (1 - 0.5 * falling)];
            const groundLight = 0.45;
            cloudsNow.groundAmbient = [_ambient[0] * coefficients.ground[0] * groundLight, _ambient[1] * coefficients.ground[1] * groundLight, _ambient[2] * coefficients.ground[2] * groundLight];
            // Without volumetric clouds the Sky Light still sees how grey the weather has made the sky.
            drawing.flatCover = useClouds === 'layer' ? THREE.MathUtils.smoothstep(state.clouds, 0.35, 1) * 0.85 : 0;
            drawing.flatCloud = [_ambient[0] * skyScale * 0.8, _ambient[1] * skyScale * 0.8, _ambient[2] * skyScale * 0.8];
            drawing.panorama = model === 'image' ? panorama : null;
            drawing.panoramaTurn = (panoramaSettings.rotation * Math.PI) / 180;
            drawing.panoramaScale = [panoramaSettings.brightness, panoramaSettings.brightness, panoramaSettings.brightness];
            if (skyDome) skyDome.visible = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
            skyRenderer.update(gl, drawing);

            // What every lit material reads from the sky.
            const shared = sceneSky;
            shared.fogScale = drawing.skyScale;
            shared.fogFollowsSky = followsSky && model === 'atmosphere';
            shared.fogShare = 1 - now.weatherFogAmount;
            shared.fogGrey = drawing.skyGrey;
            const volumetric = cloudsNow.quality === 'low' || cloudsNow.quality === 'medium' || cloudsNow.quality === 'high';
            const threshold = cloudThreshold(state.clouds);
            shared.cloudTiling = WEATHER_TILES_PER_KM / 1000 / cloudSettings.scale;
            shared.cloudDriftU = (cloudDrift.current.x * WEATHER_TILES_PER_KM) / cloudSettings.scale;
            shared.cloudDriftV = (cloudDrift.current.z * WEATHER_TILES_PER_KM) / cloudSettings.scale;
            shared.cloudThreshold = threshold;
            const rising = Math.max(_key.y, 0.08);
            shared.cloudLeanX = _key.x / rising;
            shared.cloudLeanZ = _key.z / rising;
            shared.cloudHeight = cloudSettings.altitude + cloudSettings.thickness * 0.35;
            // Heavy cloud has already dimmed the light all over; the patches show under broken cloud.
            shared.cloudStrength = volumetric && state.clouds > 0.005 ? cloudSettings.shadows * (1 - THREE.MathUtils.smoothstep(state.clouds, 0.7, 1)) : 0;

            // The Sky Light.
            shared.lightOn = skyLit;
            shared.occlusion = skyLightSettings.occlusion;
            shared.occlusionFloor = skyLightSettings.occlusionFloor;
            // A reflection shows the sky as it is, without what the shade is lifted by.
            shared.reflections = skyLightSettings.reflections / (SKY_LIGHT_GAIN * (1 + NIGHT_SHADE_LIFT * nightAir));
            if (skyLit) {
                if (skyLightSettings.occlusion > 0) {
                    const reach = Math.max(skyLightSettings.occlusionRange, nearShadowReach(orbitDistance()) * 1.5);
                    skyRenderer.updateVisibility(gl, scene, camera, reach, delta, drawing.time, _visibility);
                    shared.areaX = _visibility.x;
                    shared.areaZ = _visibility.z;
                    shared.areaSize = _visibility.size;
                    shared.areaY = _visibility.y;
                }
                const taking = capture.current;
                taking.since += delta;
                const changed = taking.key !== skyLightKey;
                if (changed) {
                    taking.key = skyLightKey;
                    taking.settle = 2;
                }
                // Clouds that have only now got their shader: take them in, once their map has filled.
                const cloudsReady = skyRenderer.cloudsReady(gl);
                if (cloudsReady !== taking.cloudsReady) {
                    taking.cloudsReady = cloudsReady;
                    taking.settle = 2;
                    taking.since = 0;
                }
                const skyMoved = Math.abs(now.sun.y - taking.sunY) + Math.abs(now.sun.x - taking.sunX) > 0.0015;
                const wanted = !skyRenderer.hasSkyLight(gl) || changed
                    || (taking.settle > 0 && taking.since > SETTLED_CAPTURE_SECONDS)
                    || (skyLightSettings.capture === 'live' && ((skyMoved && taking.since > LIVE_CAPTURE_SECONDS) || (volumetric && state.clouds > 0.005 && taking.since > CLOUD_CAPTURE_SECONDS) || (worldClock.changing && taking.since > LIVE_CAPTURE_SECONDS)));
                if (wanted && (skyLightSettings.source === 'sky' || skyLightImage)) {
                    if (!changed && taking.settle > 0 && taking.since > SETTLED_CAPTURE_SECONDS) taking.settle -= 1;
                    taking.since = 0;
                    taking.sunY = now.sun.y;
                    taking.sunX = now.sun.x;
                    const tint = linearFromHex(skyLightSettings.tint);
                    const lower = linearFromHex(skyLightSettings.lowerColor);
                    const texture = skyRenderer.captureSkyLight(gl, drawing.time, skyLightSettings.resolution, skyLightSettings.lowerSolid, lower, tint, skyLightImage);
                    if (scene.environment !== texture) scene.environment = texture;
                }
                scene.environmentIntensity = skyLightSettings.intensity * SKY_LIGHT_GAIN * (1 + NIGHT_SHADE_LIFT * nightAir);
            }

            // What the older path does for the rest: clouds drawn flat, lightning, rain and snow, wet ground.
            if (useClouds === 'layer') clouds.update(camera, now, state, worldClock.flash, delta);
            else clouds.object.visible = false;
            night.object.visible = false;
            bolt.update(camera, strike, worldClock.flash);
            if (sampler) {
                weatherCover.centre(_cameraPosition.x, _cameraPosition.z);
                weatherCover.refresh(COVER_SAMPLES_PER_FRAME, sampler);
            }
            precipitation.update(delta, camera, state, sampler ? weatherCover : null, Math.min(1, now.light + worldClock.flash));
            if (worldClock.wetness > 0.001 || worldClock.snowCover > 0.001) surfacesWet.current = true;
            if (surfacesWet.current && frame.current++ % SURFACE_SCAN_FRAMES === 0) patchWeatherSurfaces(scene);
            setSurfaceWeather(worldClock.wetness, worldClock.snowCover, sampler ? weatherCover : null);
            // Without a Sky Light the plain reflection rig still follows the day.
            if (!skyLit) {
                const darkNow = now.daylight < 0.2;
                if (darkNow !== isNight) setNight(darkNow);
                const reflectionsNow = Math.round(0.8 * (0.3 + 0.7 * Math.max(now.light, 0.15)) * 20) / 20;
                if (reflectionsNow !== reflections) setReflections(reflectionsNow);
            }
            return;
        }

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
        // For screen effects that work with the light: light shafts, sunlit haze.
        publishSkyLight(now.sun, _sunColor, config.sunIntensity * now.sunIntensity, fog.density, fog.color);

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
                <SunLight direction={FALLBACK_SUN_DIRECTION} intensity={1.2} cascaded />
                <DistanceShadows direction={FALLBACK_SUN_DIRECTION} distance={DEFAULT_SHADOW_DISTANCE} />
                <LocalEnvironment />
            </>
        );
    }

    return (
        <>
            {/* Atmosphere; the sun's place and haze are set every frame */}
            {skyDome ? <primitive object={skyDome} /> : (
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
            )}
            <primitive object={night.object} />
            <primitive object={clouds.object} />
            <primitive object={bolt.object} />
            <primitive object={precipitation.object} />

            {/* Sun, a faint moon opposite it, and lightning: always there, dark when idle, so lit materials never recompile */}
            <SunLight direction={sunDirection} light={sun} cascaded={(config.shadowDistance ?? DEFAULT_SHADOW_DISTANCE) > 0} />
            {/* Shadows past the sun's own map, out to the shadow distance (after the sun, which is tried first) */}
            <DistanceShadows direction={sunDirection} distance={config.shadowDistance ?? DEFAULT_SHADOW_DISTANCE} sun={sun} />
            <directionalLight ref={moon} color="#9db4ff" intensity={0} />
            <directionalLight ref={flash} color="#c8d8ff" intensity={0} />

            {/* Fill: sky-coloured from above, earth-coloured from below, so shaded sides still read */}
            <hemisphereLight ref={fill} />

            {/* Environment Reflections (Synced roughly to time); a Sky Light captures the sky instead */}
            {!skyLit && <LocalEnvironment night={isNight} intensity={reflections} />}
        </>
    );
};
