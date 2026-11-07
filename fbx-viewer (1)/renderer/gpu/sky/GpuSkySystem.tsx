import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { DEFAULT_SKY_CONFIG } from "../../../components/Environment/SkySystem";
import { dayPreview } from "../../../components/Environment/sky/dayPreview";
import { CloudLayer, LightningBolt, NightSky } from "../../../components/Environment/sky/skyObjects";
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";
import { localLightPanels } from "../../../components/Scene/localEnvironmentCapture";
import { useGameContent } from "../../../runtime/GameContentContext";
import { publishDaylight, publishSkyLight } from "../../../runtime/daylight";
import { ShadowDetailContext, useLookDistance } from "../../../runtime/lighting/DistanceShadowLights";
import { DEFAULT_SHADOW_DISTANCE, nearShadowReach } from "../../../runtime/lighting/distanceShadows";
import { usePhysicsAvailable, usePhysicsQueries, type PhysicsQueries } from "../../../runtime/physics";
import { GpuPrecipitation } from "../effects/precipitation";
import {
  atmosphereCoefficients, cloudThreshold, eyeAdaptation, horizonColour, linearFromHex, MOON_ANGULAR_RADIUS, overcastSky, SKY_EXPOSURE, skyAmbient, sunlightAt, SUN_ANGULAR_RADIUS,
} from "../../../runtime/sky/atmosphere";
import { skyDirector, skyLookOf, type SkyLook } from "../../../runtime/sky/skyDirector";
import { resolveSkyImage, resolveSkyLight, skyModel } from "../../../runtime/sky/skySettings";
import { createSkyLighting, sanitizeWeather, windVelocity, worldClock } from "../../../runtime/weather";
import { COVER_SAMPLES_PER_FRAME, weatherCover, type CoverSampler } from "../../../runtime/weatherCover";
import { setSurfaceWeather } from "../../../runtime/weatherSurfaces";
import { stepWind } from "../../../runtime/wind";
import type { LevelObject, SkyConfig } from "../../../types";
import { isGpuRenderer, type GpuRendererApi } from "../frame";
import { WEATHER_TILES_PER_KM } from "./cloudMap";
import { skyPassFor } from "./SkyPass";
import { SKY_SETTINGS, type GpuBolt, type GpuFlatClouds, type GpuNightSky, type GpuRigPanel, type GpuSkySettings, type Rgb } from "./skySettings";

/**
 * THE LEVEL'S SKY, ON THE GPU RENDERER
 *
 * What SkySystem does for WebGL: finds the level's Sky Sphere, runs the clock and the weather, sets the sun, moon, fill,
 * fog and lightning on the scene, and works out the numbers the sky is drawn from. They are the same numbers, worked out
 * the same way; here they go to the sky pass as renderer settings "sky" rather than to a dome in the scene.
 *
 * Shadows are the shadow pass's: it fits its own cascades to the first directional light that casts, so the sun here only
 * says which way the light comes from, and "shadows.distance" and "shadows.look" say how far they reach.
 */

/** How far the sun and moon lights sit, for their direction. */
const LIGHT_DISTANCE = 100;
/** How far the sun's light stands from what it lights: only its direction counts. */
const SUN_DISTANCE = 800;
const SUN_SHADOW_MAP_SIZE = 2048;
const LOW_DETAIL_SHADOW_MAP_SIZE = 1024;
const SUN_SHADOW_BIAS = -0.0002;
const SUN_SHADOW_NORMAL_BIAS = 0.03;
const FALLBACK_SUN_DIRECTION = new THREE.Vector3(10, 20, 10);
/** A hemisphere light lights only half as much as an ambient one at the same intensity on average. */
const HEMISPHERE_FILL_SCALE = 1.6;
/** Sky fog density as authored (0.02 by default) to FogExp2's: half. */
const FOG_DENSITY_SCALE = 0.5;
/** Lightning's light at its brightest, against the sky's Sun Intensity. */
const LIGHTNING_INTENSITY = 2.2;
/** Below this height the sun gives no light and the moon takes over: the two never light the scene at once. */
const SUN_GONE = -0.012;
const WIND_ON_CLOUDS = 3;
const CLOUD_BRIGHTNESS = 1;
/**
 * The Sky Light's strength at Intensity 1. Picture-making keeps shade well above what a strict ratio to direct sun would
 * give, and more so at night, when the eye has adapted to the dark.
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
/** The plain lighting rig's strength with no sky to follow. */
const RIG_INTENSITY = 0.8;

const _sunColor = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _black = new THREE.Color(0, 0, 0);
const _key = new THREE.Vector3();
const _sunUnit = new THREE.Vector3();
const _moonUnit = new THREE.Vector3();
const _skyColour = new THREE.Color();
const _rgb: Rgb = [0, 0, 0];
const _sunlight: Rgb = [0, 0, 0];
const _horizon: Rgb = [0, 0, 0];
const _ambient: Rgb = [0, 0, 0];
const _tint = new THREE.Color();
const _authoredFog = new THREE.Color();
const _weatherFog = new THREE.Color();
const _cameraPosition = new THREE.Vector3();
const _towardSun = new THREE.Vector3();
const FLASH_FOG = new THREE.Color(0.75, 0.8, 0.95);

const smoothstep = THREE.MathUtils.smoothstep;

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
    new THREE.TextureLoader().load(url, (next) => {
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

/**
 * Down from high above (x, z) to the first fixed surface: what covers that spot from the weather. Dynamic and kinematic
 * bodies (characters, vehicles) are not cover.
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

/** The sun's light: follows the camera at a distance, so its target is always somewhere sensible, and faces the way it is told. */
const GpuSunLight: React.FC<{
  direction: THREE.Vector3;
  intensity?: number;
  light?: React.MutableRefObject<THREE.DirectionalLight | null>;
}> = ({ direction, intensity, light: outer }) => {
  const camera = useThree((state) => state.camera);
  const own = useRef<THREE.DirectionalLight | null>(null);
  const light = outer ?? own;
  const target = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const sun = light.current;
    if (!sun) return;
    camera.getWorldPosition(target.position);
    sun.position.copy(target.position).addScaledVector(_towardSun.copy(direction).normalize(), SUN_DISTANCE);
  });
  return (
    <>
      <primitive object={target} />
      <directionalLight
        ref={light}
        target={target}
        {...(intensity === undefined ? {} : { intensity })}
        castShadow
        shadow-bias={SUN_SHADOW_BIAS}
        shadow-normalBias={SUN_SHADOW_NORMAL_BIAS}
        shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
      />
    </>
  );
};

const makeFrame = (coefficients: SkyFrame["coefficients"]): SkyFrame => ({
  time: 0,
  coefficients,
  sun: new THREE.Vector3(0, 1, 0),
  moon: new THREE.Vector3(0, -1, 0),
  moonLight: 0,
  glow: [0, 0, 0],
  viewHeight: 0.002,
  skyScale: [1, 1, 1],
  cloudScale: [1, 1, 1],
  skyGrey: 0,
  sunRadiance: [0, 0, 0],
  sunRadius: SUN_ANGULAR_RADIUS,
  moonRadiance: [0, 0, 0],
  moonRadius: MOON_ANGULAR_RADIUS,
  moonPhase: 0.5,
  stars: 0,
  milkyWay: 0,
  starAngle: 0,
  flash: 0,
  clouds: { quality: "off", coverage: 0, base: 1.5, depth: 2.2, density: 1, detail: 0.5, scale: 1, offsetX: 0, offsetZ: 0, key: new THREE.Vector3(0, 1, 0), keyStrength: 1, ambient: [0, 0, 0], groundAmbient: [0, 0, 0] },
  flatCloud: [0, 0, 0],
  flatCover: 0,
  panorama: null,
  panoramaTurn: 0,
  panoramaScale: [1, 1, 1],
});

const makeSettings = (frame: SkyFrame): GpuSkySettings => ({
  model: "none",
  frame,
  classic: { sunPosition: new THREE.Vector3(0, LIGHT_DISTANCE, 0), turbidity: 8, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.7 },
  night: null,
  flatClouds: null,
  bolt: null,
  capture: { request: 0, source: "rig", resolution: 64, lowerSolid: false, lower: [0, 0, 0], tint: [1, 1, 1], image: null, rig: [], diffuseScale: RIG_INTENSITY, specularScale: RIG_INTENSITY },
  scene: {
    fogScale: [1, 1, 1], fogFollowsSky: false, fogShare: 0, fogGrey: 0, lightOn: false, occlusion: 0, occlusionFloor: 0,
    cloudTiling: 0, cloudDriftU: 0, cloudDriftV: 0, cloudThreshold: 1, cloudLeanX: 0, cloudLeanZ: 0, cloudHeight: 0, cloudStrength: 0,
  },
  visibilityOn: false,
  visibilityHalfSide: 128,
});

/** The rig's panels, with their colours as a shader reads them. */
const rigPanels = (night: boolean): GpuRigPanel[] => localLightPanels(night).map((panel) => ({
  color: new THREE.Color(panel.color),
  intensity: panel.intensity,
  position: panel.position,
  scale: panel.scale,
}));

const nightOf = (sky: NightSky, out: GpuNightSky): GpuNightSky => {
  const stars = sky.object.children[0] as THREE.Points;
  const moon = sky.object.children[1] as THREE.Mesh;
  const starUniforms = (stars.material as THREE.ShaderMaterial).uniforms;
  out.starPositions = stars.geometry.getAttribute("position").array as Float32Array;
  out.starSizes = stars.geometry.getAttribute("aSize").array as Float32Array;
  out.starBrightness = stars.geometry.getAttribute("aBrightness").array as Float32Array;
  out.starOpacity = stars.visible ? starUniforms.uOpacity.value as number : 0;
  out.starTime = starUniforms.uTime.value as number;
  out.moonDirection.copy(moon.position).normalize();
  out.moonOpacity = moon.visible ? (moon.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number : 0;
  return out;
};

const flatCloudsOf = (layer: CloudLayer, out: GpuFlatClouds): GpuFlatClouds | null => {
  if (!layer.object.visible) return null;
  const u = (layer.object.material as THREE.ShaderMaterial).uniforms;
  out.coverage = u.uCoverage.value as number;
  out.storm = u.uStorm.value as number;
  out.light = u.uLight.value as number;
  out.flash = u.uFlash.value as number;
  out.offset = u.uOffset.value as THREE.Vector2;
  out.sunDirection = u.uSunDirection.value as THREE.Vector3;
  out.sunColor = u.uSunColor.value as THREE.Color;
  out.horizon = u.uHorizon.value as THREE.Color;
  out.shade = u.uShade.value as THREE.Color;
  return out;
};

const boltOf = (bolt: LightningBolt, out: GpuBolt): GpuBolt | null => {
  if (!bolt.object.visible) return null;
  const { geometry } = bolt.object;
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  out.positions = positions.array as Float32Array;
  out.edges = geometry.getAttribute("aEdge").array as Float32Array;
  out.indices = geometry.index!.array;
  out.version = positions.version;
  out.brightness = (bolt.object.material as THREE.ShaderMaterial).uniforms.uBrightness.value as number;
  return out;
};

interface GpuSkySystemProps {
  levelObjects: LevelObject[];
  /**
   * In play: time moves through the day and the weather changes (and the level's scripts may change them); rain and snow
   * stop at what covers them. In the editor the sky shows the level as set.
   */
  live?: boolean;
}

const GpuSky: React.FC<GpuSkySystemProps & { renderer: GpuRendererApi }> = ({ renderer, levelObjects, live = false }) => {
  const skyObject = useMemo(() => levelObjects.find((object) => object.type === "sky_sphere"), [levelObjects]);
  const config: SkyConfig = skyObject?.skyConfig || DEFAULT_SKY_CONFIG;
  const weather = useMemo(() => sanitizeWeather(config.weather), [config.weather]);
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const physics = usePhysicsAvailable();
  const queries = usePhysicsQueries();
  const detail = useContext(ShadowDetailContext);
  const orbitDistance = useLookDistance();

  // What the sky is made of, past the clock and the weather. A level without a Sky Sphere keeps the plain editor light.
  const model = skyObject ? skyModel(config) : "classic";
  const atmospheric = model !== "classic";
  const ownLook = useMemo(() => skyLookOf(config), [config]);
  const lastLook = useRef<{ look: SkyLook; coefficients: ReturnType<typeof atmosphereCoefficients> } | null>(null);
  const skyLightSettings = useMemo(() => resolveSkyLight(config.skyLight), [config.skyLight]);
  const panoramaSettings = useMemo(() => resolveSkyImage(config.panorama), [config.panorama]);
  const skyLit = atmospheric && skyLightSettings.enabled;
  const { textures } = useGameContent();
  const panoramaTexture = textures.find((texture) => texture.id === panoramaSettings.textureId) ?? textures.find((texture) => texture.name === panoramaSettings.textureId);
  const panorama = usePanorama(panoramaTexture?.url);
  const skyLightImage = skyLightSettings.source === "image" ? panorama : null;
  const skyLightKey = useMemo(() => JSON.stringify([model, config.panorama, skyLightSettings, config.atmosphere, config.cloudLayer, config.timeOfDay, config.azimuth, config.sunTilt, config.sunColor, config.sunIntensity, config.weather, config.night, skyLightImage?.uuid]), [model, skyLightSettings, config, skyLightImage]);
  const capture = useRef({ key: "", since: 0, settle: 0, sunY: NaN, sunX: NaN, cloudsReady: false, rig: "" });
  const cloudDrift = useRef({ x: 0, z: 0 });
  /** Colours the model works out when the sun moves, not every frame. */
  const modelColours = useRef({ sunX: NaN, sunY: NaN, sunZ: NaN, coefficients: null as unknown, horizon: [0, 0, 0] as Rgb, ambient: [0, 0, 0] as Rgb });
  const settings = useMemo(() => makeSettings(makeFrame(atmosphereCoefficients(ownLook.atmosphere))), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The clock starts from the sky as set: in the editor whenever it is edited, in play once.
  const resetKey = live
    ? `${skyObject?.id ?? ""}`
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
  const sun = useRef<THREE.DirectionalLight | null>(null);
  const moon = useRef<THREE.DirectionalLight>(null);
  const flash = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.HemisphereLight>(null);
  const fog = useMemo(() => new THREE.FogExp2("#050505", 0.01), []);
  const background = useMemo(() => new THREE.Color("#050505"), []);
  const clouds = useMemo(() => new CloudLayer(), []);
  const night = useMemo(() => new NightSky(), []);
  const bolt = useMemo(() => new LightningBolt(), []);
  const precipitation = useMemo(() => new GpuPrecipitation(renderer, scene), [renderer, scene]);
  const nightOut = useMemo<GpuNightSky>(() => ({ starPositions: new Float32Array(0), starSizes: new Float32Array(0), starBrightness: new Float32Array(0), starOpacity: 0, starTime: 0, moonDirection: new THREE.Vector3(0, -1, 0), moonOpacity: 0 }), []);
  const flatOut = useMemo<GpuFlatClouds>(() => ({ coverage: 0, storm: 0, light: 1, flash: 0, offset: new THREE.Vector2(), sunDirection: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), horizon: new THREE.Color(), shade: new THREE.Color() }), []);
  const boltOut = useMemo<GpuBolt>(() => ({ positions: new Float32Array(0), edges: new Float32Array(0), indices: [], version: -1, brightness: 0 }), []);
  const sampler = useMemo(
    () => (live && physics ? coverSampler(queries, () => camera.getWorldPosition(_cameraPosition).y + 150) : null),
    [live, physics, queries, camera],
  );

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

  // The sky's fog and the background behind it are set on the scene directly, every frame: attached as elements, the
  // no-sky fallback's fog detaching after them would clear them.
  useEffect(() => () => {
    if (scene.fog === fog) scene.fog = null;
    if (scene.background === background) scene.background = null;
  }, [scene, fog, background]);

  // The pass, and the settings it reads, for as long as the level is here.
  const pass = useMemo(() => skyPassFor(renderer), [renderer]);
  useLayoutEffect(() => {
    renderer.settings.set(SKY_SETTINGS, settings);
    return () => {
      if (renderer.settings.get(SKY_SETTINGS) === settings) renderer.settings.delete(SKY_SETTINGS);
      renderer.settings.delete("shadows.distance");
      renderer.settings.delete("shadows.look");
      renderer.settings.delete("shadows.resolution");
      pass.releaseSky();
    };
  }, [renderer, settings, pass]);

  /** Asks for the plain rig's light, when it differs from what was last asked for. */
  const askForRig = (rigNight: boolean, intensity: number): void => {
    const taking = capture.current;
    const key = `${rigNight}/${intensity}`;
    const request = settings.capture;
    if (request.source !== "rig" || taking.rig !== key) {
      taking.rig = key;
      request.source = "rig";
      request.resolution = 64;
      request.rig = rigPanels(rigNight);
      request.tint = [1, 1, 1];
      request.lowerSolid = false;
      request.image = null;
      request.specularScale = intensity;
      request.request += 1;
    }
    request.diffuseScale = intensity;
  };

  useFrame((rootState, delta) => {
    if (live) worldClock.step(delta);
    else if (dayPreview.speed > 0 && dayPreview.time !== rootState.clock.elapsedTime) {
      dayPreview.time = rootState.clock.elapsedTime;
      worldClock.setHours(worldClock.hours + delta * dayPreview.speed);
    }
    // The wind blows in the editor too, so foliage and cloth can be seen moving as they will.
    stepWind(delta);
    renderer.settings.set("shadows.distance", config.shadowDistance ?? DEFAULT_SHADOW_DISTANCE);
    renderer.settings.set("shadows.look", orbitDistance());
    renderer.settings.set("shadows.resolution", detail === "low" ? LOW_DETAIL_SHADOW_MAP_SIZE : SUN_SHADOW_MAP_SIZE);

    settings.night = null;
    settings.flatClouds = null;
    settings.bolt = null;
    settings.scene.lightOn = false;
    settings.scene.cloudStrength = 0;
    settings.visibilityOn = false;

    if (!skyObject) {
      publishDaylight(1);
      setSurfaceWeather(0, 0, null);
      publishSkyLight(FALLBACK_SUN_DIRECTION, _white, 0.6, 0, _black);
      settings.model = "none";
      askForRig(false, RIG_INTENSITY);
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
      const sunFade = smoothstep(now.sun.y, SUN_GONE, 0.04);
      const falling = Math.max(state.rain, state.snow);
      const phaseLight = (1 - Math.cos(nightSettings.moonPhase * Math.PI * 2)) / 2;
      const moonFade = smoothstep(_moonUnit.y, 0, 0.06) * (1 - smoothstep(now.sun.y, SUN_GONE - 0.04, SUN_GONE));
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

      const nightAir = 1 - smoothstep(now.sun.y, -0.2, 0.02);
      linearFromHex(nightSettings.glow, _rgb);
      // The eye opens as the light falls: the sun and the sky it lights both read brighter than they are.
      const adapted = eyeAdaptation(now.sun.y);
      const skyPerUnit = (NIGHT_AIR_LIGHT / Math.max(strength, 1e-3)) / adapted;
      const moonSky = (nightSettings.moonBrightness * phaseLight * 0.07 * moonFade) / adapted;
      const glow: Rgb = [_rgb[0] * nightAir * skyPerUnit, _rgb[1] * nightAir * skyPerUnit, _rgb[2] * nightAir * skyPerUnit];
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
      const followsSky = (config.fogMode ?? "custom") === "sky";
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
      settings.model = "atmosphere";
      const drawing = settings.frame;
      const useClouds = model === "atmosphere" ? cloudSettings.quality : "off";
      const lowDetail = detail === "low" && useClouds !== "off" && useClouds !== "layer";
      drawing.time = rootState.clock.elapsedTime;
      drawing.coefficients = coefficients;
      drawing.sun.copy(_sunUnit);
      drawing.moon.copy(_moonUnit);
      drawing.moonLight = moonSky;
      drawing.glow = glow;
      drawing.viewHeight = viewHeight;
      drawing.skyScale = [skyScale * tintR, skyScale * tintG, skyScale * tintB];
      drawing.skyGrey = 0.8 * smoothstep(state.clouds, 0.55, 1);
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
      cloudsNow.quality = lowDetail ? "low" : useClouds;
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
      drawing.flatCover = useClouds === "layer" ? smoothstep(state.clouds, 0.35, 1) * 0.85 : 0;
      drawing.flatCloud = [_ambient[0] * skyScale * 0.8, _ambient[1] * skyScale * 0.8, _ambient[2] * skyScale * 0.8];
      drawing.panorama = model === "image" ? panorama : null;
      drawing.panoramaTurn = (panoramaSettings.rotation * Math.PI) / 180;
      drawing.panoramaScale = [panoramaSettings.brightness, panoramaSettings.brightness, panoramaSettings.brightness];

      // What every lit material reads from the sky.
      const shared = settings.scene;
      shared.fogScale = drawing.skyScale;
      shared.fogFollowsSky = followsSky && model === "atmosphere";
      shared.fogShare = 1 - now.weatherFogAmount;
      shared.fogGrey = drawing.skyGrey;
      const volumetric = cloudsNow.quality === "low" || cloudsNow.quality === "medium" || cloudsNow.quality === "high";
      shared.cloudTiling = WEATHER_TILES_PER_KM / 1000 / cloudSettings.scale;
      shared.cloudDriftU = (cloudDrift.current.x * WEATHER_TILES_PER_KM) / cloudSettings.scale;
      shared.cloudDriftV = (cloudDrift.current.z * WEATHER_TILES_PER_KM) / cloudSettings.scale;
      shared.cloudThreshold = cloudThreshold(state.clouds);
      const rising = Math.max(_key.y, 0.08);
      shared.cloudLeanX = _key.x / rising;
      shared.cloudLeanZ = _key.z / rising;
      shared.cloudHeight = cloudSettings.altitude + cloudSettings.thickness * 0.35;
      // Heavy cloud has already dimmed the light all over; the patches show under broken cloud.
      shared.cloudStrength = volumetric && state.clouds > 0.005 ? cloudSettings.shadows * (1 - smoothstep(state.clouds, 0.7, 1)) : 0;

      // The Sky Light.
      if (skyLit) {
        shared.lightOn = true;
        shared.occlusion = skyLightSettings.occlusion;
        shared.occlusionFloor = skyLightSettings.occlusionFloor;
        if (skyLightSettings.occlusion > 0) {
          settings.visibilityOn = true;
          settings.visibilityHalfSide = Math.max(skyLightSettings.occlusionRange, nearShadowReach(orbitDistance()) * 1.5);
        }
        const taking = capture.current;
        taking.since += delta;
        const changed = taking.key !== skyLightKey;
        if (changed) {
          taking.key = skyLightKey;
          taking.settle = 2;
        }
        // Clouds that have only now got their shader: take them in, once their map has filled.
        const cloudsReady = pass.cloudsReady;
        if (cloudsReady !== taking.cloudsReady) {
          taking.cloudsReady = cloudsReady;
          taking.settle = 2;
          taking.since = 0;
        }
        const skyMoved = Math.abs(now.sun.y - taking.sunY) + Math.abs(now.sun.x - taking.sunX) > 0.0015;
        const request = settings.capture;
        const wanted = !pass.hasSkyCapture || changed
          || (taking.settle > 0 && taking.since > SETTLED_CAPTURE_SECONDS)
          || (skyLightSettings.capture === "live" && ((skyMoved && taking.since > LIVE_CAPTURE_SECONDS) || (volumetric && state.clouds > 0.005 && taking.since > CLOUD_CAPTURE_SECONDS) || (worldClock.changing && taking.since > LIVE_CAPTURE_SECONDS)));
        if (wanted && (skyLightSettings.source === "sky" || skyLightImage)) {
          if (!changed && taking.settle > 0 && taking.since > SETTLED_CAPTURE_SECONDS) taking.settle -= 1;
          taking.since = 0;
          taking.sunY = now.sun.y;
          taking.sunX = now.sun.x;
          taking.rig = "";
          request.source = skyLightImage ? "image" : "sky";
          request.resolution = skyLightSettings.resolution;
          request.tint = linearFromHex(skyLightSettings.tint);
          request.lower = linearFromHex(skyLightSettings.lowerColor);
          request.lowerSolid = skyLightSettings.lowerSolid;
          request.image = skyLightImage;
          // A reflection shows the sky as it is, without what the shade is lifted by.
          request.specularScale = skyLightSettings.intensity * skyLightSettings.reflections;
          request.request += 1;
        }
        request.diffuseScale = skyLightSettings.intensity * SKY_LIGHT_GAIN * (1 + NIGHT_SHADE_LIFT * nightAir);
      } else {
        // Without a Sky Light the plain reflection rig still follows the day.
        askForRig(now.daylight < 0.2, Math.round(0.8 * (0.3 + 0.7 * Math.max(now.light, 0.15)) * 20) / 20);
      }

      // What the older path does for the rest: clouds drawn flat, lightning, rain and snow, wet ground.
      if (useClouds === "layer") {
        clouds.update(camera, now, state, worldClock.flash, delta);
        settings.flatClouds = flatCloudsOf(clouds, flatOut);
      }
      bolt.update(camera, strike, worldClock.flash);
      settings.bolt = boltOf(bolt, boltOut);
      if (sampler) {
        weatherCover.centre(_cameraPosition.x, _cameraPosition.z);
        weatherCover.refresh(COVER_SAMPLES_PER_FRAME, sampler);
      }
      precipitation.update(delta, camera, state, sampler ? weatherCover : null, Math.min(1, now.light + worldClock.flash));
      setSurfaceWeather(worldClock.wetness, worldClock.snowCover, sampler ? weatherCover : null);
      return;
    }

    // The classic sky's own colour: the sun's place, hazier under cloud.
    settings.model = "classic";
    const classic = settings.classic;
    classic.sunPosition.copy(sunDirection);
    classic.turbidity = config.turbidity + state.clouds * 6 + state.fog * 6;
    classic.rayleigh = config.rayleigh * (1 - 0.6 * state.clouds * state.clouds);
    classic.mieCoefficient = config.mieCoefficient;
    classic.mieDirectionalG = config.mieDirectionalG;

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
    if ((config.fogMode ?? "custom") === "sky") _authoredFog.setRGB(now.horizon[0], now.horizon[1], now.horizon[2]);
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
    settings.flatClouds = flatCloudsOf(clouds, flatOut);
    night.update(camera, now, delta);
    settings.night = nightOf(night, nightOut);
    bolt.update(camera, strike, worldClock.flash);
    settings.bolt = boltOf(bolt, boltOut);
    if (sampler) {
      camera.getWorldPosition(_cameraPosition);
      weatherCover.centre(_cameraPosition.x, _cameraPosition.z);
      weatherCover.refresh(COVER_SAMPLES_PER_FRAME, sampler);
    }
    precipitation.update(delta, camera, state, sampler ? weatherCover : null, Math.min(1, now.light + worldClock.flash));
    setSurfaceWeather(worldClock.wetness, worldClock.snowCover, sampler ? weatherCover : null);

    // Reflections dim with the light; the night rig takes over after dark.
    askForRig(now.daylight < 0.2, Math.round(0.8 * (0.3 + 0.7 * Math.max(now.light, 0.15)) * 20) / 20);
  }, -1);

  // Standard editor lighting if no sky object exists.
  if (!skyObject) {
    return (
      <>
        <color attach="background" args={["#050505"]} />
        <fog attach="fog" args={["#050505", 10, 60]} />
        <ambientLight intensity={0.4} />
        <GpuSunLight direction={FALLBACK_SUN_DIRECTION} intensity={1.2} />
      </>
    );
  }

  return (
    <>
      <primitive object={precipitation.object} />
      {/* Sun, a faint moon opposite it, and lightning: always there, dark when idle. */}
      <GpuSunLight direction={sunDirection} light={sun} />
      <directionalLight ref={moon} color="#9db4ff" intensity={0} />
      <directionalLight ref={flash} color="#c8d8ff" intensity={0} />
      {/* Fill: sky-coloured from above, earth-coloured from below, so shaded sides still read. */}
      <hemisphereLight ref={fill} />
    </>
  );
};

/**
 * The level's sky on the GPU renderer. On any other renderer it draws nothing: SkySystem is the one that goes there.
 * Goes under the level's canvas, where SkySystem goes.
 */
export const GpuSkySystem: React.FC<GpuSkySystemProps> = (props) => {
  const gl = useThree((state) => state.gl);
  if (!isGpuRenderer(gl)) return null;
  return <GpuSky {...props} renderer={gl} />;
};
