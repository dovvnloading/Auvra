import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySceneSky, pauseSceneSky, setSceneSky, SKY_SCENE_UNIFORMS, type SceneSky } from '../../runtime/lighting/skyScene';
import {
    atmosphereCoefficients, cloudThreshold, eyeAdaptation, GROUND_RADIUS, horizonColour, overcastSky, skyAmbient, skyRadiance, sunlightAt, transmittance,
} from '../../runtime/sky/atmosphere';
import { blendHours, blendSkyLook, mixHex, setWorldSkyPreset, skyDirector, skyLookOf, skyLookOfPreset } from '../../runtime/sky/skyDirector';
import {
    applySkyPreset, matchesSkyPreset, newSkyConfig, skyPreset, skyPresetFromName, skyPresetSwatch, SKY_PRESETS,
} from '../../runtime/sky/skyPresets';
import {
    DEFAULT_ATMOSPHERE, resolveAtmosphere, resolveClouds, resolveNight, resolveSkyImage, resolveSkyLight, skyModel, sunSize, sunTilt,
} from '../../runtime/sky/skySettings';
import { skyLighting, createSkyLighting, NO_WEATHER, sunDirection, worldClock } from '../../runtime/weather';
import { WORLD_NODE_DEFINITIONS } from '../../hooks/levelBlueprintNodes/world';

/*
 * The sky: what the air does to light, the ready-made skies, heading from one to another in play, and what
 * every lit material reads from it. How it looks is checked in the Sky Lab.
 */

const earth = atmosphereCoefficients(DEFAULT_ATMOSPHERE);
const rgb = (): [number, number, number] => [0, 0, 0];

describe('the air', () => {
    it('lets nearly all light through straight up, turns it red low down, and none through the ground', () => {
        const overhead = transmittance(earth, GROUND_RADIUS + 0.001, 1, rgb());
        const low = transmittance(earth, GROUND_RADIUS + 0.001, 0.03, rgb());
        const down = transmittance(earth, GROUND_RADIUS + 0.001, -0.5, rgb());
        expect(overhead[0]).toBeGreaterThan(0.8);
        expect(overhead[2]).toBeGreaterThan(0.5);
        // The low sun: red survives, blue barely does.
        expect(low[0]).toBeGreaterThan(low[1]);
        expect(low[1]).toBeGreaterThan(low[2]);
        expect(low[2]).toBeLessThan(0.1);
        expect(down).toEqual([0, 0, 0]);
    });

    it('is blue overhead by day and warm toward a low sun', () => {
        const noon = { x: 0, y: 1, z: 0 };
        const up = skyRadiance(earth, { x: 0, y: 1, z: 0 }, noon, 0.002, rgb());
        expect(up[2]).toBeGreaterThan(up[1]);
        expect(up[1]).toBeGreaterThan(up[0]);
        const low = { x: 0.999, y: 0.04, z: 0 };
        const towardSun = skyRadiance(earth, { x: 0.999, y: 0.04, z: 0 }, low, 0.002, rgb());
        expect(towardSun[0]).toBeGreaterThan(towardSun[2]);
    });

    it('whitens with haze and darkens after sunset, with the sun gone', () => {
        const sun = { x: 0.5, y: 0.7, z: 0.5 };
        const view = { x: 0, y: 0.5, z: 0.866 };
        const clear = skyRadiance(earth, view, sun, 0.002, rgb());
        const hazy = skyRadiance(atmosphereCoefficients({ ...DEFAULT_ATMOSPHERE, haze: 12 }), view, sun, 0.002, rgb());
        expect(hazy[0] / hazy[2]).toBeGreaterThan(clear[0] / clear[2]);
        const night = skyRadiance(earth, view, { x: 0, y: -0.9, z: 0.43 }, 0.002, rgb());
        expect(night[2]).toBeLessThan(clear[2] * 0.01);
    });

    it('takes a tint on what it scatters, and gives a horizon and a sky average with the same colour', () => {
        const dusty = atmosphereCoefficients({ ...DEFAULT_ATMOSPHERE, rayleighTint: '#ff0000' });
        expect(dusty.rayleigh[1]).toBeCloseTo(0, 8);
        const sun = { x: 0, y: 0.8, z: 0.6 };
        const horizon = horizonColour(earth, sun, 0.002, rgb());
        const ambient = skyAmbient(earth, sun, 0.002, rgb());
        expect(horizon.every(c => c > 0)).toBe(true);
        expect(ambient[2]).toBeGreaterThan(ambient[0]);
    });

    it('colours the sunlight that reaches the ground', () => {
        const noon = sunlightAt(earth, 1, 0.002, rgb());
        const evening = sunlightAt(earth, 0.08, 0.002, rgb());
        expect(evening[0] / evening[2]).toBeGreaterThan(noon[0] / noon[2]);
    });

    it('is exposed for by the eye as the light falls, and leaves full day alone', () => {
        expect(eyeAdaptation(1)).toBeCloseTo(1, 6);
        expect(eyeAdaptation(0.1)).toBeGreaterThan(eyeAdaptation(0.5));
        expect(eyeAdaptation(-0.1)).toBeGreaterThan(eyeAdaptation(0.1));
        // Fully open once it is dark: the same however far below the horizon the sun is.
        expect(eyeAdaptation(-0.5)).toBe(eyeAdaptation(-0.9));
    });

    it('dims under heavy cloud only, and forms clouds by coverage', () => {
        expect(overcastSky(0.3)).toBe(1);
        expect(overcastSky(1)).toBeLessThan(0.5);
        expect(cloudThreshold(0)).toBeGreaterThan(cloudThreshold(1));
        // Half the sky: about the middle of the weather map's spread.
        expect(cloudThreshold(0.5)).toBeCloseTo(0.48, 2);
    });
});

describe('the sun path', () => {
    it('leans without changing when the sun rises or sets, and stays where it was with no lean', () => {
        const flat = sunDirection(10, 0.2, { x: 0, y: 0, z: 0 });
        const same = sunDirection(10, 0.2, { x: 0, y: 0, z: 0 }, 0);
        expect(same).toEqual(flat);
        const noon = sunDirection(12, 0, { x: 0, y: 0, z: 0 }, 40);
        expect(noon.y).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 6);
        expect(Math.hypot(noon.x, noon.y, noon.z)).toBeCloseTo(1, 6);
        expect(sunDirection(6, 0, { x: 0, y: 0, z: 0 }, 40).y).toBeCloseTo(0, 6);
        expect(sunDirection(18, 0, { x: 0, y: 0, z: 0 }, 40).y).toBeCloseTo(0, 6);
        expect(skyLighting(12, 0, NO_WEATHER, createSkyLighting(), 40).sun.y).toBeCloseTo(noon.y, 6);
    });
});

describe('the clouds\' noise', () => {
    it('is filtered and has mips, on the texture a 3D target really uses', () => {
        const source = readFileSync(resolve(process.cwd(), 'components/Environment/sky/SkyRenderer.ts'), 'utf8');
        expect(source).toMatch(/texture\.minFilter = THREE\.LinearMipmapLinearFilter/);
        // Three does not make mips for 3D targets: an empty mip reads as no cloud at all, past a few kilometres.
        expect(source).toMatch(/generateMipmap\(context\.TEXTURE_3D\)/);
    });
});

describe('sky settings', () => {
    it('are made whole and in range', () => {
        expect(resolveAtmosphere({ rayleigh: 100, haze: -1, rayleighTint: 'blue', hazeGlow: 2 })).toMatchObject({ rayleigh: 8, haze: 0, rayleighTint: '#ffffff', hazeGlow: 0.98 });
        expect(resolveClouds({ quality: 'ultra', altitude: 1 })).toMatchObject({ quality: 'medium', altitude: 200 });
        expect(resolveNight({ moonPhase: 3, glow: '#123456' })).toMatchObject({ moonPhase: 1, glow: '#123456' });
        expect(resolveSkyImage({ textureId: ' sky ', brightness: -2 })).toMatchObject({ textureId: 'sky', brightness: 0 });
        expect(sunTilt({ sunTilt: 200 })).toBe(80);
        expect(sunSize({})).toBe(1);
    });

    it('take a bad sun colour as white, from what a sky saved', () => {
        expect(skyLookOf({ ...newSkyConfig(), sunColor: 'orange' }).sunColor).toBe('#ffffff');
        expect(skyLookOf({ ...newSkyConfig(), sunColor: '#ff8800' }).sunColor).toBe('#ff8800');
    });

    it('keep a sky saved before them as it was: Classic, its Sky Light off', () => {
        expect(skyModel({})).toBe('classic');
        expect(skyModel({ model: 'nonsense' as never })).toBe('classic');
        expect(resolveSkyLight(undefined).enabled).toBe(false);
        const set = resolveSkyLight({ resolution: 300 });
        expect(set.enabled).toBe(true);
        expect(set.resolution).toBe(128);
    });
});

describe('sky presets', () => {
    it('have their own ids and names, and are found by either', () => {
        const ids = SKY_PRESETS.map(preset => preset.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(SKY_PRESETS.map(preset => preset.label)).size).toBe(ids.length);
        expect(ids.length).toBeGreaterThanOrEqual(20);
        for (const preset of SKY_PRESETS) {
            expect(skyPresetFromName(preset.id)).toBe(preset);
            expect(skyPresetFromName(` ${preset.label.toUpperCase()} `)).toBe(preset);
        }
        expect(skyPresetFromName('no such sky')).toBeNull();
    });

    it('make a whole sky that still reads as themselves, until something changes', () => {
        const base = newSkyConfig();
        for (const preset of SKY_PRESETS) {
            const config = applySkyPreset(base, preset);
            expect(config.model).toBe('atmosphere');
            expect(config.preset).toBe(preset.id);
            expect(config.skyLight?.enabled).toBe(true);
            expect(matchesSkyPreset(config)).toBe(true);
        }
        const sunset = applySkyPreset(base, skyPreset('sunset')!);
        expect(matchesSkyPreset({ ...sunset, timeOfDay: 3 })).toBe(false);
        expect(matchesSkyPreset({ ...sunset, atmosphere: { ...sunset.atmosphere, haze: 30 } })).toBe(false);
        // The cloud quality is about the machine, not the look.
        expect(matchesSkyPreset({ ...sunset, cloudLayer: { ...sunset.cloudLayer, quality: 'high' } })).toBe(true);
    });

    it('keep what is the level\'s own: the cloud quality, Sky Light, shadow distance and day length', () => {
        const own = { ...newSkyConfig(), shadowDistance: 900, dayLength: 12, cloudLayer: { quality: 'low' as const }, skyLight: { enabled: false } };
        const next = applySkyPreset(own, skyPreset('thunderstorm')!);
        expect(next.shadowDistance).toBe(900);
        expect(next.dayLength).toBe(12);
        expect(next.cloudLayer?.quality).toBe('low');
        expect(next.skyLight?.enabled).toBe(false);
        expect(next.weather?.preset).toBe('storm');
    });

    it('give a new Sky Sphere the atmosphere and its Sky Light', () => {
        const config = newSkyConfig();
        expect(config.model).toBe('atmosphere');
        expect(resolveSkyLight(config.skyLight).enabled).toBe(true);
    });

    it('draw a swatch of themselves', () => {
        const day = skyPresetSwatch(skyPreset('clear-noon')!);
        expect(day).toMatch(/^linear-gradient\(to bottom, rgb\(/);
        expect(day).not.toBe(skyPresetSwatch(skyPreset('dust-world')!));
    });
});

describe('heading from one sky to another', () => {
    beforeEach(() => {
        skyDirector.reset();
        worldClock.reset(10, 0, null, null);
    });

    it('blends every part of the look', () => {
        const a = skyLookOfPreset(skyPreset('clear-noon')!, 'medium');
        const b = skyLookOfPreset(skyPreset('dust-world')!, 'medium');
        const half = blendSkyLook(a, b, 0.5);
        expect(half.atmosphere.haze).toBeCloseTo((a.atmosphere.haze + b.atmosphere.haze) / 2, 6);
        expect(half.sunIntensity).toBeCloseTo((a.sunIntensity + b.sunIntensity) / 2, 6);
        expect(blendSkyLook(a, b, 0).atmosphere.rayleighTint).toBe(a.atmosphere.rayleighTint);
        expect(blendSkyLook(a, b, 1).atmosphere.rayleighTint).toBe(b.atmosphere.rayleighTint);
        expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    });

    it('turns the sun the short way round, and moves the clock forward', () => {
        const a = { ...skyLookOfPreset(skyPreset('clear-noon')!, 'medium'), azimuth: 0.95 };
        const b = { ...a, azimuth: 0.05 };
        expect(blendSkyLook(a, b, 0.5).azimuth).toBeCloseTo(1, 6);
        expect(blendHours(22, 2, 0.5)).toBeCloseTo(0, 6);
        expect(blendHours(10, 18, 0.5)).toBeCloseTo(14, 6);
    });

    it('stays on the level\'s own sky until told, then gets there and stays', () => {
        const base = skyLookOf(newSkyConfig());
        expect(skyDirector.step(base, 0.1)).toBe(base);
        expect(setWorldSkyPreset('Thunderstorm', 10)).toBe(true);
        expect(setWorldSkyPreset('no such sky', 10)).toBe(false);
        const midway = skyDirector.step(base, 5);
        const storm = skyPreset('thunderstorm')!;
        expect(midway.clouds.thickness).toBeGreaterThan(base.clouds.thickness);
        expect(midway.clouds.thickness).toBeLessThan(storm.clouds!.thickness!);
        skyDirector.step(base, 5);
        const there = skyDirector.step(base, 1);
        expect(there.clouds.thickness).toBeCloseTo(storm.clouds!.thickness!, 6);
        // Once there it is the same look each frame, so nothing downstream works it out again.
        expect(skyDirector.step(base, 1)).toBe(there);
        // Its weather has been set going too, and the clock left alone.
        expect(worldClock.preset).toBe('storm');
        expect(worldClock.hours).toBeCloseTo(10, 6);
        skyDirector.reset();
        expect(skyDirector.step(base, 0.1)).toBe(base);
    });

    it('keeps the level\'s cloud quality, and moves the hour only when asked', () => {
        const base = skyLookOf({ ...newSkyConfig(), cloudLayer: { quality: 'low' } });
        setWorldSkyPreset('sunset', 0, true);
        const there = skyDirector.step(base, 0.1);
        expect(there.clouds.quality).toBe('low');
        expect(worldClock.hours).toBeCloseTo(skyPreset('sunset')!.hour, 6);
    });
});

describe('what lit materials read from the sky', () => {
    const sky = (): SceneSky => ({
        fogScale: [2, 3, 4], fogFollowsSky: true, fogShare: 0.5, fogGrey: 0.25, lightOn: true, occlusion: 1, occlusionFloor: 0.1, reflections: 0.8,
        areaX: -64, areaZ: -32, areaSize: 256, areaY: 5, cloudTiling: 0.00005, cloudDriftU: 0.1, cloudDriftV: 0.2, cloudThreshold: 0.5,
        cloudLeanX: 0.3, cloudLeanZ: 0.4, cloudHeight: 2000, cloudStrength: 0.7,
    });
    const u = SKY_SCENE_UNIFORMS;

    it('is in the shared chunks, ready before any material compiles', () => {
        expect(THREE.ShaderChunk.lights_pars_begin).toContain('auvraSkyVisibility');
        expect(THREE.ShaderChunk.lights_fragment_maps).toContain('auvraSeen');
        expect(THREE.ShaderChunk.fog_fragment).toContain('auvraSkyColour');
        expect(THREE.ShaderLib.standard.uniforms.auvraSkyLight).toBeDefined();
    });

    it('survives the copy each material makes of its uniforms: every one reads the same values and atlas', () => {
        const copy = THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms);
        expect(copy.auvraSkyFog.value).toBe(u.auvraSkyFog.value);
        expect(copy.auvraSkyLight.value).toBe(u.auvraSkyLight.value);
        expect(copy.auvraSkyAtlas.value[0]).toBe(u.auvraSkyAtlas.value[0]);
    });

    it('belongs to the scene that set it: another scene draws without it', () => {
        const own = new THREE.Scene();
        const other = new THREE.Scene();
        const stop = setSceneSky(own, sky());
        applySceneSky(own);
        expect(u.auvraSkyFog.value.w).toBe(1.5);
        expect(u.auvraSkyFogGrey.value.x).toBe(0.25);
        expect(u.auvraSkyLight.value.w).toBe(1);
        expect(u.auvraSkyArea.value.z).toBeCloseTo(1 / 256, 8);
        expect(u.auvraCloudSun.value.w).toBe(0.7);
        applySceneSky(other);
        expect(u.auvraSkyFog.value.w).toBe(0);
        expect(u.auvraSkyLight.value.w).toBe(0);
        expect(u.auvraCloudSun.value.w).toBe(0);
        stop();
        applySceneSky(own);
        expect(u.auvraSkyLight.value.w).toBe(0);
    });

    it('steps aside for a bake, which must see the real occlusion and no passing cloud', () => {
        const scene = new THREE.Scene();
        const stop = setSceneSky(scene, sky());
        const resume = pauseSceneSky(scene);
        applySceneSky(scene);
        expect(u.auvraSkyLight.value.w).toBe(0);
        expect(u.auvraCloudSun.value.w).toBe(0);
        resume();
        applySceneSky(scene);
        expect(u.auvraSkyLight.value.w).toBe(1);
        stop();
    });

    it('keeps fog drawn as the sky is through thick mist, when the weather has taken all its colour', () => {
        const scene = new THREE.Scene();
        const stop = setSceneSky(scene, { ...sky(), fogShare: 0 });
        applySceneSky(scene);
        expect(u.auvraSkyFog.value.w).toBe(1);
        stop();
        const plain = setSceneSky(scene, { ...sky(), fogFollowsSky: false });
        applySceneSky(scene);
        expect(u.auvraSkyFog.value.w).toBe(0);
        plain();
    });

    it('is set as each scene starts drawing', () => {
        const scene = new THREE.Scene();
        const stop = setSceneSky(scene, sky());
        (scene.onBeforeRender as unknown as () => void)();
        expect(u.auvraSkyLight.value.w).toBe(1);
        stop();
    });
});

describe('level scripts', () => {
    it('have a node for it', () => {
        const node = WORLD_NODE_DEFINITIONS.find(definition => definition.type === 'SetSkyPreset');
        expect(node?.title).toBe('Set Sky Preset');
    });
});
