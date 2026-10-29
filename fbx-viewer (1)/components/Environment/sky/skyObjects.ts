import * as THREE from 'three';
import type { LightningStrike, SkyLighting, WeatherState } from '../../../runtime/weather';
import { windVelocity } from '../../../runtime/weather';
import {
    BOLT_FRAGMENT, BOLT_VERTEX, CLOUD_FRAGMENT, CLOUD_VERTEX, MOON_FRAGMENT, MOON_VERTEX,
    SKY_RENDER_ORDER, skyMaterial, STAR_FRAGMENT, STAR_VERTEX,
} from './skyShaders';

/**
 * What the sky shows besides its own colour: a cloud layer, stars and the moon at night, and
 * lightning bolts. Each follows the camera; the sky updates them every frame from its light.
 */

const SKY_RADIUS = 1000;
/** How far the clouds drift per metre the wind moves (in their texture's units). */
const CLOUD_DRIFT = 0.0012;

const _camera = new THREE.Vector3();

export class CloudLayer {
    readonly object: THREE.Mesh;
    private readonly material: THREE.ShaderMaterial;
    private readonly offset = new THREE.Vector2();

    constructor() {
        this.material = skyMaterial(CLOUD_VERTEX, CLOUD_FRAGMENT, {
            uCoverage: { value: 0 },
            uStorm: { value: 0 },
            uLight: { value: 1 },
            uFlash: { value: 0 },
            uOffset: { value: this.offset },
            uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
            uSunColor: { value: new THREE.Color(1, 1, 1) },
            uHorizon: { value: new THREE.Color(0.5, 0.6, 0.7) },
            uShade: { value: new THREE.Color(0.6, 0.63, 0.68) },
        }, false);
        this.object = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), this.material);
        this.object.name = 'SkyClouds';
        this.object.renderOrder = SKY_RENDER_ORDER.clouds;
        this.object.frustumCulled = false;
        this.object.userData.noWeather = true;
    }

    update(camera: THREE.Camera, lighting: SkyLighting, weather: WeatherState, flash: number, dt: number): void {
        this.object.position.copy(camera.getWorldPosition(_camera));
        this.object.visible = weather.clouds > 0.005;
        if (!this.object.visible) return;
        const u = this.material.uniforms;
        const [wx, wz] = windVelocity(weather);
        this.offset.x += wx * dt * CLOUD_DRIFT;
        this.offset.y += wz * dt * CLOUD_DRIFT;
        u.uCoverage.value = weather.clouds;
        u.uStorm.value = Math.max(weather.rain, weather.snow, weather.lightning > 0 ? 0.8 : 0);
        // Lit by the sun by day; by night only faintly, by the moon and the town.
        u.uLight.value = 0.045 + 0.955 * Math.min(1, lighting.daylight * 1.15);
        u.uFlash.value = flash;
        (u.uSunDirection.value as THREE.Vector3).set(lighting.sun.x, lighting.sun.y, lighting.sun.z);
        (u.uSunColor.value as THREE.Color).setRGB(lighting.sunTint[0], lighting.sunTint[1], lighting.sunTint[2]).multiplyScalar(0.55 + 0.45 * lighting.daylight);
        (u.uHorizon.value as THREE.Color).setRGB(lighting.horizon[0], lighting.horizon[1], lighting.horizon[2]);
        const grey = 0.62 - 0.32 * Math.max(weather.rain, weather.snow) * weather.clouds - 0.12 * (weather.lightning > 0 ? 1 : 0);
        (u.uShade.value as THREE.Color).setRGB(grey, grey * 1.03, grey * 1.1);
    }

    dispose(): void {
        this.object.geometry.dispose();
        this.material.dispose();
    }
}

const STAR_COUNT = 2600;

export class NightSky {
    readonly object = new THREE.Group();
    private readonly stars: THREE.Points;
    private readonly starMaterial: THREE.ShaderMaterial;
    private readonly moon: THREE.Mesh;
    private readonly moonMaterial: THREE.ShaderMaterial;
    private time = 0;

    constructor(random: () => number = Math.random) {
        const positions = new Float32Array(STAR_COUNT * 3);
        const sizes = new Float32Array(STAR_COUNT);
        const brightness = new Float32Array(STAR_COUNT);
        for (let i = 0; i < STAR_COUNT; i++) {
            // Even over the sphere; a few bright, most faint.
            const y = random() * 1.1 - 0.1;
            const angle = random() * Math.PI * 2;
            const ring = Math.sqrt(Math.max(0, 1 - y * y));
            positions.set([Math.cos(angle) * ring * SKY_RADIUS, y * SKY_RADIUS, Math.sin(angle) * ring * SKY_RADIUS], i * 3);
            const magnitude = random() ** 3;
            sizes[i] = 1.2 + magnitude * 2.6;
            brightness[i] = 0.35 + magnitude * 1.6;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
        this.starMaterial = skyMaterial(STAR_VERTEX, STAR_FRAGMENT, { uOpacity: { value: 0 }, uTime: { value: 0 } }, true);
        this.stars = new THREE.Points(geometry, this.starMaterial);
        this.stars.name = 'SkyStars';
        this.stars.renderOrder = SKY_RENDER_ORDER.stars;
        this.stars.frustumCulled = false;

        this.moonMaterial = skyMaterial(MOON_VERTEX, MOON_FRAGMENT, { uOpacity: { value: 0 } }, true);
        this.moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.moonMaterial);
        this.moon.name = 'SkyMoon';
        this.moon.renderOrder = SKY_RENDER_ORDER.moon;
        this.moon.frustumCulled = false;
        this.object.add(this.stars, this.moon);
        this.object.name = 'NightSky';
        this.object.userData.noWeather = true;
    }

    update(camera: THREE.Camera, lighting: SkyLighting, dt: number): void {
        this.object.position.copy(camera.getWorldPosition(_camera));
        this.time += dt;
        const stars = lighting.stars;
        this.stars.visible = stars > 0.01;
        this.starMaterial.uniforms.uOpacity.value = stars;
        this.starMaterial.uniforms.uTime.value = this.time;
        // The moon rides opposite the sun, a little off its path so it is not hidden behind the sun's glow by day.
        const mx = -lighting.sun.x, my = -lighting.sun.y, mz = -lighting.sun.z + 0.15;
        const length = Math.hypot(mx, my, mz) || 1;
        this.moon.position.set((mx / length) * SKY_RADIUS * 0.9, (my / length) * SKY_RADIUS * 0.9, (mz / length) * SKY_RADIUS * 0.9);
        this.moon.lookAt(_camera);
        const size = SKY_RADIUS * 0.9 * 0.09;
        this.moon.scale.set(size, size, size);
        const moon = Math.min(1, stars * 1.6 + lighting.moonIntensity * 0.3) * (my > -0.05 ? 1 : 0);
        this.moon.visible = moon > 0.01;
        this.moonMaterial.uniforms.uOpacity.value = moon;
    }

    dispose(): void {
        this.stars.geometry.dispose();
        this.starMaterial.dispose();
        this.moon.geometry.dispose();
        this.moonMaterial.dispose();
    }
}

const BOLT_SEGMENTS = 28;
const BOLT_BRANCHES = 3;
const BOLT_BRANCH_SEGMENTS = 9;
/** Where on the sky a bolt is drawn, m from the camera (it is at infinity; this sets its size). */
const BOLT_RADIUS = 900;

/** A seeded random source, so a strike's bolt keeps its shape. */
const seeded = (seed: number) => {
    let state = Math.floor(seed * 2 ** 31) || 1;
    return () => {
        state = (state * 48271) % 2147483647;
        return state / 2147483647;
    };
};

/** A lightning bolt, drawn on the sky toward the strike for as long as it flashes. */
export class LightningBolt {
    readonly object: THREE.Mesh;
    private readonly material: THREE.ShaderMaterial;
    private readonly positions: Float32Array;
    private readonly edges: Float32Array;
    private strikeId = -1;

    constructor() {
        const quads = BOLT_SEGMENTS + BOLT_BRANCHES * BOLT_BRANCH_SEGMENTS;
        this.positions = new Float32Array(quads * 4 * 3);
        this.edges = new Float32Array(quads * 4);
        const indices: number[] = [];
        for (let q = 0; q < quads; q++) indices.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aEdge', new THREE.BufferAttribute(this.edges, 1).setUsage(THREE.DynamicDrawUsage));
        geometry.setIndex(indices);
        this.material = skyMaterial(BOLT_VERTEX, BOLT_FRAGMENT, { uBrightness: { value: 0 } }, true);
        this.object = new THREE.Mesh(geometry, this.material);
        this.object.name = 'LightningBolt';
        this.object.renderOrder = SKY_RENDER_ORDER.bolt;
        this.object.frustumCulled = false;
        this.object.visible = false;
        this.object.userData.noWeather = true;
    }

    update(camera: THREE.Camera, strike: LightningStrike | null, flash: number): void {
        this.object.position.copy(camera.getWorldPosition(_camera));
        // Only strikes near enough to see under the clouds draw a bolt; the rest only light the sky.
        const visible = !!strike && flash > 0.04 && strike.distance < 2200;
        this.object.visible = visible;
        if (!visible || !strike) return;
        this.material.uniforms.uBrightness.value = flash * Math.min(1, 900 / strike.distance);
        if (strike.id !== this.strikeId) {
            this.strikeId = strike.id;
            this.build(strike);
        }
    }

    private build(strike: LightningStrike): void {
        const random = seeded(strike.seed);
        const forward = new THREE.Vector3(Math.sin(strike.bearing), 0, Math.cos(strike.bearing));
        const side = new THREE.Vector3(forward.z, 0, -forward.x);
        // From the cloud base down to the ground, jagged; distant bolts look lower and thinner.
        const top = BOLT_RADIUS * (0.2 + 0.1 * random()) * Math.min(1.4, 900 / strike.distance + 0.4);
        const width = 2.2 + 3 * Math.min(1, 700 / strike.distance);
        let quad = 0;
        const strand = (start: THREE.Vector3, drop: number, segments: number, wander: number, thickness: number) => {
            const point = start.clone();
            for (let s = 0; s < segments; s++) {
                const next = point.clone();
                next.y -= drop / segments;
                next.addScaledVector(side, (random() - 0.5) * wander);
                this.writeQuad(quad++, point, next, side, thickness * (1 - (s / segments) * 0.4));
                point.copy(next);
            }
            return point;
        };
        const start = forward.clone().multiplyScalar(BOLT_RADIUS).setY(top);
        const trunk: THREE.Vector3[] = [];
        const point = start.clone();
        for (let s = 0; s < BOLT_SEGMENTS; s++) {
            const next = point.clone();
            next.y -= (top + 4) / BOLT_SEGMENTS;
            next.addScaledVector(side, (random() - 0.5) * 22);
            this.writeQuad(quad++, point, next, side, width);
            trunk.push(next.clone());
            point.copy(next);
        }
        for (let b = 0; b < BOLT_BRANCHES; b++) {
            const from = trunk[Math.floor(random() * BOLT_SEGMENTS * 0.6)];
            strand(from, top * (0.15 + random() * 0.2), BOLT_BRANCH_SEGMENTS, 30, width * 0.45);
        }
        const geometry = this.object.geometry;
        geometry.getAttribute('position').needsUpdate = true;
        geometry.getAttribute('aEdge').needsUpdate = true;
    }

    private writeQuad(index: number, a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, width: number): void {
        const half = width / 2;
        const corners = [
            [a, -1], [a, 1], [b, -1], [b, 1],
        ] as const;
        corners.forEach(([point, edge], k) => {
            const v = (index * 4 + k) * 3;
            this.positions[v] = point.x + side.x * half * edge;
            this.positions[v + 1] = point.y;
            this.positions[v + 2] = point.z + side.z * half * edge;
            this.edges[index * 4 + k] = edge;
        });
    }

    dispose(): void {
        this.object.geometry.dispose();
        this.material.dispose();
    }
}
