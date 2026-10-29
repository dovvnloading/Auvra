import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
    blendWeather, copyWeather, createSkyLighting, flashEnvelope, formatHours, hoursPerSecond, matchesPreset,
    NO_WEATHER, sanitizeWeather, setWorldTime, setWorldWeather, skyLighting, SOUND_SPEED, steadyWetness,
    sunDirection, weatherFromPreset, weatherGrip, weatherKindFromName, WEATHER_PRESETS, WorldClock, worldClock,
    worldTime, worldWeather, wrapHours, type WeatherState,
} from '../../runtime/weather';
import { OPEN_SKY, WeatherCover } from '../../runtime/weatherCover';
import { isWeatherPatched, patchWeatherMaterial, patchWeatherSurfaces, setSurfaceWeather, WEATHER_UNIFORMS } from '../../runtime/weatherSurfaces';
import { Precipitation } from '../../runtime/precipitation';
import { thunderShape, weatherSoundValues, WEATHER_PARAMS } from '../../runtime/WeatherAudio';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { parseScriptCommand, scriptEnvironmentState } from '../../runtime/scripting/ScriptRuntime';
import { createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';
import type { ScriptSnapshot } from '../../runtime/scripting/protocol';

vi.mock('../../components/Scripting/ScriptInspector', () => ({ ScriptInspector: () => null }));
// Sprites are drawn on a canvas, which the test DOM has none of.
vi.mock('../../runtime/particleSprites', async importOriginal => ({
    ...(await importOriginal<typeof import('../../runtime/particleSprites')>()),
    builtinSpriteTexture: () => new THREE.Texture(),
}));

const seeded = (seed = 1) => {
    let state = seed;
    return () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
    };
};

const RAIN = WEATHER_PRESETS.rain;

describe('weather settings', () => {
    it('is none for a sky saved before there was weather, and made whole and in range otherwise', () => {
        expect(sanitizeWeather(undefined)).toBeNull();
        expect(sanitizeWeather('rain')).toBeNull();
        expect(sanitizeWeather({ preset: 'rain' })).toEqual(weatherFromPreset('rain'));
        const odd = sanitizeWeather({ preset: 'hail', clouds: 3, rain: -1, wind: 99, windDirection: -90, lightning: Number.NaN })!;
        expect(odd.preset).toBe('clear');
        expect([odd.clouds, odd.rain, odd.wind, odd.windDirection, odd.lightning]).toEqual([1, 0, 40, 270, WEATHER_PRESETS.clear.lightning]);
    });

    it('knows when its values are still its preset', () => {
        expect(matchesPreset(weatherFromPreset('storm'))).toBe(true);
        expect(matchesPreset({ ...weatherFromPreset('storm'), rain: 0.5 })).toBe(false);
    });

    it('blends value by value, the wind turning the short way round', () => {
        const from: WeatherState = { ...NO_WEATHER, windDirection: 350 };
        const to: WeatherState = { ...RAIN, windDirection: 10 };
        const half = blendWeather(from, to, 0.5, { ...NO_WEATHER });
        expect(half.rain).toBeCloseTo(RAIN.rain / 2);
        expect(half.clouds).toBeCloseTo(RAIN.clouds / 2);
        expect(half.windDirection).toBeCloseTo(0);
        expect(blendWeather(from, to, 2, { ...NO_WEATHER }).rain).toBe(RAIN.rain);
    });

    it("copies a weather's values and nothing else", () => {
        const out = copyWeather(weatherFromPreset('snow'), { ...NO_WEATHER });
        expect(out).toEqual(WEATHER_PRESETS.snow);
        expect('preset' in out).toBe(false);
    });

    it('finds presets by id or label, in any case', () => {
        expect(weatherKindFromName('Rain')).toBe('rain');
        expect(weatherKindFromName(' thunderstorm ')).toBe('storm');
        expect(weatherKindFromName('BLIZZARD')).toBe('blizzard');
        expect(weatherKindFromName('hail')).toBeNull();
    });
});

describe('the sun and the light', () => {
    it('rises at 6, stands overhead at noon and sets at 18, its path turned by the azimuth', () => {
        const at = (hours: number, azimuth = 0) => sunDirection(hours, azimuth, { x: 0, y: 0, z: 0 });
        expect(at(12).y).toBeCloseTo(1);
        expect(at(6).y).toBeCloseTo(0);
        expect(at(6).x).toBeCloseTo(1);
        expect(at(18).x).toBeCloseTo(-1);
        expect(at(0).y).toBeCloseTo(-1);
        expect(at(6, 0.25).z).toBeCloseTo(-1);
    });

    it('wraps hours and moves them by the day length', () => {
        expect(wrapHours(25)).toBe(1);
        expect(wrapHours(-1)).toBe(23);
        expect(hoursPerSecond(0)).toBe(0);
        expect(hoursPerSecond(24)).toBeCloseTo(1 / 60);
        expect(formatHours(14.08)).toBe('14:04');
    });

    it('lights the day, darkens the night and shows stars only on a clear night', () => {
        const noon = skyLighting(12, 0.25, NO_WEATHER, createSkyLighting());
        expect(noon.daylight).toBe(1);
        expect(noon.sunIntensity).toBeCloseTo(1);
        expect(noon.stars).toBe(0);
        expect(noon.sunTint).toEqual([1, 1, 1]);
        const night = skyLighting(0, 0.25, NO_WEATHER, createSkyLighting());
        expect(night.daylight).toBe(0);
        expect(night.sunIntensity).toBe(0);
        expect(night.moonIntensity).toBeGreaterThan(0.9);
        expect(night.stars).toBeCloseTo(1);
        expect(night.ambient).toBeLessThan(noon.ambient);
        const cloudyNight = skyLighting(0, 0.25, WEATHER_PRESETS.overcast, createSkyLighting());
        expect(cloudyNight.stars).toBeLessThan(0.05);
        // Low sun is warm.
        const sunset = skyLighting(17.6, 0.25, NO_WEATHER, createSkyLighting());
        expect(sunset.sunTint[2]).toBeLessThan(sunset.sunTint[0] * 0.6);
    });

    it('dims the sun under cloud, fills the shade instead, and thickens the fog in weather', () => {
        const clear = skyLighting(12, 0.25, NO_WEATHER, createSkyLighting());
        const overcast = skyLighting(12, 0.25, WEATHER_PRESETS.overcast, createSkyLighting());
        const storm = skyLighting(12, 0.25, WEATHER_PRESETS.storm, createSkyLighting());
        expect(overcast.sunIntensity).toBeLessThan(0.3);
        expect(overcast.ambient).toBeGreaterThan(clear.ambient);
        expect(storm.light).toBeLessThan(0.35);
        expect(clear.light).toBe(1);
        expect(storm.fogDensity).toBeGreaterThan(overcast.fogDensity);
        expect(clear.fogDensity).toBe(0);
        expect(storm.weatherFogAmount).toBeGreaterThan(0.5);
        // A storm's grey is darker than an overcast day's.
        expect(storm.weatherFog[0]).toBeLessThan(overcast.weatherFog[0]);
    });
});

describe('the world clock', () => {
    it('starts with the ground as wet and snowy as its weather leaves it', () => {
        const clock = new WorldClock();
        clock.reset(9, 0, weatherFromPreset('rain'), 'rain');
        expect(clock.wetness).toBeCloseTo(steadyWetness(RAIN));
        expect(clock.preset).toBe('rain');
        expect('preset' in clock.weather).toBe(false);
        clock.reset(9, 0, null, null);
        expect(clock.weather).toEqual(NO_WEATHER);
        expect(clock.wetness).toBe(0);
    });

    it('moves the hour through a day of the set length, round past midnight', () => {
        const clock = new WorldClock();
        clock.reset(23.5, 24, null, null);
        for (let i = 0; i < 60; i++) clock.step(1);
        expect(clock.hours).toBeCloseTo(0.5);
        clock.setDayLength(0);
        clock.step(10);
        expect(clock.hours).toBeCloseTo(0.5);
    });

    it('changes the weather over its transition, eased, or at once', () => {
        const clock = new WorldClock();
        clock.reset(12, 0, null, null);
        clock.setWeather(RAIN, 10, 'rain');
        expect(clock.changing).toBe(true);
        for (let i = 0; i < 5; i++) clock.step(1);
        expect(clock.weather.rain).toBeCloseTo(RAIN.rain / 2);
        for (let i = 0; i < 5; i++) clock.step(1);
        expect(clock.weather.rain).toBeCloseTo(RAIN.rain);
        expect(clock.changing).toBe(false);
        const version = clock.version;
        clock.setWeather(NO_WEATHER, 0, null);
        expect(clock.weather.rain).toBe(0);
        expect(clock.version).toBe(version + 1);
    });

    it('soaks the ground while it rains and dries it after; snow settles and melts', () => {
        const clock = new WorldClock();
        clock.reset(12, 0, null, null);
        clock.setWeather(WEATHER_PRESETS.storm, 0, 'storm');
        for (let i = 0; i < 10; i++) clock.step(1);
        const soaking = clock.wetness;
        expect(soaking).toBeGreaterThan(0.1);
        for (let i = 0; i < 120; i++) clock.step(1);
        expect(clock.wetness).toBe(1);
        clock.setWeather(NO_WEATHER, 0, 'clear');
        for (let i = 0; i < 30; i++) clock.step(1);
        expect(clock.wetness).toBeLessThan(1);
        expect(clock.wetness).toBeGreaterThan(0.3);
        clock.setWeather(WEATHER_PRESETS.blizzard, 0, 'blizzard');
        for (let i = 0; i < 100; i++) clock.step(1);
        expect(clock.snowCover).toBe(1);
        clock.setWeather(NO_WEATHER, 0, 'clear');
        for (let i = 0; i < 100; i++) clock.step(1);
        expect(clock.snowCover).toBeLessThan(1);
        expect(clock.snowCover).toBeGreaterThan(0.8);
    });

    it('strikes lightning as often as the weather says, flashing then rumbling after the sound arrives', () => {
        const clock = new WorldClock();
        clock.reset(12, 0, null, null);
        clock.setWeather({ ...WEATHER_PRESETS.storm, lightning: 30 }, 0, 'storm');
        const random = seeded(7);
        let strikes = 0;
        let lastId = -1;
        let brightest = 0;
        for (let i = 0; i < 60 * 60; i++) {
            clock.step(1 / 60, random);
            brightest = Math.max(brightest, clock.flash);
            if (clock.strike && clock.strike.id !== lastId) {
                lastId = clock.strike.id;
                strikes++;
                expect(clock.strike.distance).toBeGreaterThanOrEqual(250);
                expect(clock.strike.distance).toBeLessThanOrEqual(3000);
            }
        }
        // About one every two seconds over a minute.
        expect(strikes).toBeGreaterThan(15);
        expect(strikes).toBeLessThan(50);
        expect(brightest).toBeGreaterThan(0.3);
        clock.setWeather(NO_WEATHER, 0, 'clear');
        for (let i = 0; i < 60 * 15; i++) clock.step(1 / 60, random);
        expect(clock.strike).toBeNull();
        expect(clock.flash).toBe(0);
    });

    it('flashes, flickers and fades', () => {
        expect(flashEnvelope(-0.1)).toBe(0);
        expect(flashEnvelope(0.03)).toBe(1);
        expect(flashEnvelope(0.1)).toBeLessThan(0.3);
        expect(flashEnvelope(0.15)).toBeGreaterThan(0.8);
        expect(flashEnvelope(0.8)).toBeLessThan(0.01);
        expect(SOUND_SPEED).toBe(343);
    });

    it('is set and read by level scripts and scripts through the shared clock', () => {
        worldClock.reset(10, 0, null, null);
        expect(setWorldWeather('Thunderstorm', 0)).toBe(true);
        expect(worldWeather().preset).toBe('storm');
        expect(worldWeather().rain).toBe(1);
        expect(setWorldWeather('hail', 0)).toBe(false);
        setWorldTime({ hours: 23 });
        expect(worldTime().night).toBe(true);
        setWorldTime({ hours: 12, dayLength: 30 });
        expect(worldTime()).toMatchObject({ hours: 12, night: false });
        expect(worldTime().light).toBeLessThan(0.35);
        expect(worldClock.dayLength).toBe(30);
        expect(scriptEnvironmentState()).toMatchObject({ hours: 12, weather: 'storm', rain: 1 });
        worldClock.reset(14, 0, null, null);
    });
});

describe('tyres in the weather', () => {
    it('keeps dry grip dry, loses some on a wet road and less on loose ground, and most under snow', () => {
        expect(weatherGrip('asphalt', 0, 0)).toBe(1);
        expect(weatherGrip('asphalt', 1, 0)).toBeCloseTo(0.7);
        expect(weatherGrip('dirt', 1, 0)).toBeCloseTo(0.85);
        expect(weatherGrip('asphalt', 0, 1)).toBeCloseTo(0.3);
        expect(weatherGrip('snow', 1, 1)).toBe(1);
        expect(weatherGrip('ice', 1, 0)).toBe(1);
    });
});

describe('weather cover', () => {
    const roof: (x: number, z: number) => number | null = (x, z) => (Math.abs(x) < 3 && Math.abs(z) < 3 ? 4 : 0);

    it('samples what is overhead round the camera, unsampled cells first', () => {
        const cover = new WeatherCover(8, 1);
        cover.centre(0, 0);
        expect([cover.originX, cover.originZ]).toEqual([-4, -4]);
        expect(cover.heightAt(0, 0)).toBe(OPEN_SKY);
        expect(cover.refresh(64, roof)).toBe(64);
        expect(cover.heightAt(0.5, 0.5)).toBe(4);
        expect(cover.heightAt(3.5, 0.5)).toBe(0);
        expect(cover.heightAt(50, 0)).toBe(OPEN_SKY);
        expect(cover.sheltered(0.5, 1, 0.5)).toBe(true);
        expect(cover.sheltered(0.5, 4, 0.5)).toBe(false);
        expect(cover.sheltered(3.5, 0.1, 0.5)).toBe(false);
    });

    it('keeps the heights still under it as it moves, and bumps its version only when one changes', () => {
        const cover = new WeatherCover(8, 1);
        cover.centre(0, 0);
        cover.refresh(64, roof);
        const version = cover.version;
        cover.refresh(64, roof);
        expect(cover.version).toBe(version);
        cover.centre(2, 0);
        expect(cover.heightAt(0.5, 0.5)).toBe(4);
        expect(cover.heightAt(5.5, 0.5)).toBe(OPEN_SKY);
        const sampled: number[] = [];
        cover.refresh(8, (x, z) => { sampled.push(x); return roof(x, z); });
        expect(sampled.every(x => x > 3)).toBe(true);
    });
});

describe('weather on surfaces', () => {
    it('patches lit materials once, keeping their own patch and a program key of their own', () => {
        const material = new THREE.MeshStandardMaterial();
        const key = material.customProgramCacheKey();
        expect(patchWeatherMaterial(material)).toBe(true);
        expect(isWeatherPatched(material)).toBe(true);
        expect(material.customProgramCacheKey()).not.toBe(key);
        const shader = {
            uniforms: {} as Record<string, THREE.IUniform>,
            vertexShader: THREE.ShaderLib.physical.vertexShader,
            fragmentShader: THREE.ShaderLib.physical.fragmentShader,
        };
        material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
        expect(shader.vertexShader).toContain('vWeatherWorld =');
        expect(shader.fragmentShader).toContain('weatherOpen()');
        expect(shader.uniforms.uWeatherWetness).toBe(WEATHER_UNIFORMS.uWeatherWetness);

        const terrain = new THREE.MeshStandardMaterial();
        const own = vi.fn();
        terrain.onBeforeCompile = own;
        expect(patchWeatherMaterial(terrain)).toBe(false);
        terrain.userData.weatherSurface = true;
        expect(patchWeatherMaterial(terrain)).toBe(true);
        terrain.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
        expect(own).toHaveBeenCalled();

        expect(patchWeatherMaterial(new THREE.MeshBasicMaterial())).toBe(false);
        const opted = new THREE.MeshStandardMaterial();
        opted.userData.noWeather = true;
        expect(patchWeatherMaterial(opted)).toBe(false);
    });

    it('patches a scene as it finds new materials, and sets the shared weather', () => {
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
        expect(patchWeatherSurfaces(scene)).toBe(1);
        expect(patchWeatherSurfaces(scene)).toBe(0);
        const cover = new WeatherCover();
        cover.centre(0, 0);
        cover.refresh(Infinity, () => 3);
        setSurfaceWeather(0.6, 0.2, cover);
        expect(WEATHER_UNIFORMS.uWeatherWetness.value).toBe(0.6);
        expect(WEATHER_UNIFORMS.uWeatherSnow.value).toBe(0.2);
        expect(WEATHER_UNIFORMS.uWeatherCoverOn.value).toBe(1);
        expect((WEATHER_UNIFORMS.uWeatherCover.value as THREE.DataTexture).image.data?.[0]).toBe(3);
        setSurfaceWeather(0, 0, null);
        expect(WEATHER_UNIFORMS.uWeatherCoverOn.value).toBe(0);
    });
});

describe('precipitation', () => {
    const camera = () => {
        const view = new THREE.PerspectiveCamera();
        view.position.set(0, 2, 0);
        view.updateMatrixWorld();
        return view;
    };

    it('rains round the camera as hard as the weather says, never under cover, splashing where it lands', () => {
        const rain = new Precipitation(seeded(3));
        const cover = new WeatherCover(64, 1);
        cover.centre(0, 0);
        // A roof 4 m up over a 6 m square round the camera; open ground at 0 elsewhere.
        cover.refresh(Infinity, (x, z) => (Math.abs(x) < 3 && Math.abs(z) < 3 ? 4 : 0));
        const view = camera();
        for (let i = 0; i < 180; i++) rain.update(1 / 60, view, WEATHER_PRESETS.storm, cover, 1);
        const alive = rain.alive;
        expect(alive.rain).toBeGreaterThan(2000);
        expect(alive.splashes).toBeGreaterThan(0);
        const drops = (rain.object.children[0].children[0] as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
        const positions = drops.getAttribute('iPosition').array;
        for (let i = 0; i < drops.instanceCount; i++) {
            const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
            if (Math.abs(x) < 2.5 && Math.abs(z) < 2.5) expect(y).toBeGreaterThan(3.5);
            // Kept within the box round the camera.
            expect(Math.abs(x)).toBeLessThanOrEqual(16.01);
        }
        rain.dispose();
    });

    it('snows without splashing, and stops when the weather clears', () => {
        const snow = new Precipitation(seeded(5));
        const view = camera();
        for (let i = 0; i < 120; i++) snow.update(1 / 60, view, WEATHER_PRESETS.snow, null, 1);
        expect(snow.alive.snow).toBeGreaterThan(500);
        expect(snow.alive.splashes).toBe(0);
        for (let i = 0; i < 60 * 40; i++) snow.update(1 / 10, view, NO_WEATHER, null, 1);
        expect(snow.alive.snow).toBe(0);
        snow.dispose();
    });
});

describe('the sound of the weather', () => {
    it('hisses with the rain (muffled under cover), blows with the wind, and thunders lower and longer far off', () => {
        const out = new Float64Array(WEATHER_PARAMS);
        weatherSoundValues(out, NO_WEATHER, false, 0.5);
        expect(out[0]).toBe(0);
        expect(out[3]).toBe(0);
        weatherSoundValues(out, WEATHER_PRESETS.storm, false, 0.5);
        const open = out[0];
        expect(open).toBeGreaterThan(0.25);
        expect(out[3]).toBeGreaterThan(0);
        weatherSoundValues(out, WEATHER_PRESETS.storm, true, 0.5);
        expect(out[0]).toBeLessThan(open);
        expect(out[1]).toBeLessThan(2000);
        const near = thunderShape(300);
        const far = thunderShape(2800);
        expect(near.level).toBeGreaterThan(far.level);
        expect(near.cutoff).toBeGreaterThan(far.cutoff);
        expect(far.length).toBeGreaterThan(near.length);
    });
});

describe('time and weather in level and gameplay scripts', () => {
    const run = (type: WorldNodeType, inputs: Record<string, unknown>, extra: Partial<WorldNodeServices>) => {
        const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
        const node: FlowNode = {
            id: type, type,
            inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
            outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
            data: { ...definition.data },
        };
        const nodeState: Record<string, unknown> = {};
        const services: WorldNodeServices = {
            spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
            applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
            vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
        };
        WORLD_NODE_EXECUTORS[type]!(node, {
            evaluate: name => (name in inputs ? inputs[name] : node.data?.[`default_${name}`] ?? null),
            fire: () => undefined,
            schedule: () => undefined,
            nodeState,
            services,
        });
        return (pin: string) => flowNodeOutputValue(nodeState, pin);
    };

    it('sets and reads the hour, the day length and the weather from the level script', () => {
        const setTimeOfDay = vi.fn();
        run('SetTimeOfDay', { Hours: 19.5 }, { setTimeOfDay });
        expect(setTimeOfDay).toHaveBeenCalledWith(19.5);
        const setDayLength = vi.fn();
        run('SetDayLength', { Minutes: -5 }, { setDayLength });
        expect(setDayLength).toHaveBeenCalledWith(0);
        const time = run('GetTimeOfDay', {}, { timeOfDay: () => ({ hours: 21, light: 0.05, night: true }) });
        expect([time('Hours'), time('Light'), time('Is Night')]).toEqual([21, 0.05, true]);
        const setWeather = vi.fn(() => true);
        expect(run('SetWeather', { Weather: 'Storm', Seconds: 30 }, { setWeather })('Set')).toBe(true);
        expect(setWeather).toHaveBeenCalledWith('Storm', 30);
        expect(run('SetWeather', { Weather: 'Storm' }, {})('Set')).toBe(false);
        const weather = run('GetWeather', {}, { weather: () => ({ preset: 'rain', clouds: 0.9, rain: 0.5, snow: 0, fog: 0.1, wind: 5, wetness: 0.8, snowCover: 0 }) });
        expect([weather('Weather'), weather('Rain'), weather('Mist'), weather('Wetness')]).toEqual(['rain', 0.5, 0.1, 0.8]);
    });

    it('lets gameplay scripts read and change them, through validated commands', () => {
        const snapshot = (frame: number): ScriptSnapshot => ({
            frame, time: 0, delta: 0.1, objects: [{ id: 'gate', name: 'gate', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
            player: null, input: {}, variables: {}, events: [], raycasts: {}, net: { connected: false, isHost: true, selfId: null, peers: [] },
            environment: { hours: 20, light: 0.1, night: true, weather: 'rain', clouds: 0.9, rain: 0.55, snow: 0, fog: 0.1, wind: 5, wetness: 0.9, snowCover: 0 },
        });
        expect(isScriptSnapshot(snapshot(0))).toBe(true);
        expect(isScriptSnapshot({ ...snapshot(0), environment: { hours: 'noon' } })).toBe(false);
        const host = createScriptHost();
        host.load([{
            id: 's', objectId: 'gate',
            source: "function onUpdate(ctx) { if (ctx.timeOfDay().night && ctx.weather().rain > 0.5) { ctx.setWeather('Clear', 30); ctx.setTimeOfDay(30); ctx.setDayLength(12); } }",
        }], source => source, snapshot(0));
        const commands = host.frame(snapshot(1)).filter(command => ['setWeather', 'setTimeOfDay', 'setDayLength'].includes(command.type));
        expect(commands).toEqual([
            { type: 'setWeather', weather: 'clear', seconds: 30 },
            { type: 'setTimeOfDay', hours: 6 },
            { type: 'setDayLength', minutes: 12 },
        ]);
        expect(parseScriptCommand({ type: 'setWeather', weather: 'storm', seconds: 5 })).toEqual({ type: 'setWeather', weather: 'storm', seconds: 5 });
        expect(parseScriptCommand({ type: 'setWeather', weather: 'hail', seconds: 5 })).toBeNull();
        expect(parseScriptCommand({ type: 'setTimeOfDay', hours: 24 })).toBeNull();
        expect(parseScriptCommand({ type: 'setDayLength', minutes: -1 })).toBeNull();
    });
});
