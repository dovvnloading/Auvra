import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useBeforePhysicsStep, useRapier } from '@react-three/rapier';
import type { RapierCollider, RapierContext } from '@react-three/rapier';
import type { LevelComponent } from '../../types';
import { objectIdFromRigidBody, usePhysicsAvailable } from '../physicsQueries';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

type Vec3 = [number, number, number];
type RapierModule = RapierContext['rapier'];
type RapierWorld = RapierContext['world'];

/** A water component's settings, read from its props with defaults and ranges applied. */
export interface WaterSettings {
    /** Extent along the object's local X and Z (Y is ignored). */
    size: Vec3;
    color: string;
    opacity: number;
    /** Crest height of the largest wave, m. */
    waveHeight: number;
    /** Wavelength of the largest wave, m. */
    waveLength: number;
    /** Multiplies how fast waves travel. */
    waveSpeed: number;
    /** 0..1, how much white foam the crests get. */
    foam: number;
    roughness: number;
    buoyancy: boolean;
    /** Water density, kg/m^3. */
    density: number;
    /** Slows bodies moving in the water. */
    drag: number;
}

export const WATER_DEFAULTS: WaterSettings = {
    size: [50, 0, 50], color: '#1b5e7a', opacity: 0.85, waveHeight: 0.25, waveLength: 8, waveSpeed: 1,
    foam: 0.4, roughness: 0.08, buoyancy: true, density: 1000, drag: 1,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (component: LevelComponent, key: keyof WaterSettings, min: number, max: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : WATER_DEFAULTS[key] as number;
};

export const resolveWaterSettings = (component: LevelComponent): WaterSettings => {
    const size = component.props.size;
    const extent = (index: number) => (Array.isArray(size) && typeof size[index] === 'number' && Number.isFinite(size[index])
        ? clamp(size[index] as number, 0.1, 10000) : WATER_DEFAULTS.size[index]);
    const color = typeof component.props.color === 'string' && /^#[0-9a-f]{6}$/i.test(component.props.color) ? component.props.color : WATER_DEFAULTS.color;
    return {
        size: [extent(0), 0, extent(2)],
        color,
        opacity: number(component, 'opacity', 0.05, 1),
        waveHeight: number(component, 'waveHeight', 0, 10),
        waveLength: number(component, 'waveLength', 0.5, 500),
        waveSpeed: number(component, 'waveSpeed', 0, 10),
        foam: number(component, 'foam', 0, 1),
        roughness: number(component, 'roughness', 0, 1),
        buoyancy: typeof component.props.buoyancy === 'boolean' ? component.props.buoyancy : WATER_DEFAULTS.buoyancy,
        density: number(component, 'density', 1, 20000),
        drag: number(component, 'drag', 0, 20),
    };
};

// --- WAVES ---

/** The three summed waves: share of the wave height, share of the wavelength, travel direction (radians). */
const WAVES: readonly [number, number, number][] = [[0.55, 1, 0.3], [0.3, 0.61, 1.9], [0.15, 0.37, 3.6]];
const GRAVITY = 9.81;

interface Wave { amplitude: number; k: number; omega: number; dx: number; dz: number }

/** Wave parameters for the settings: amplitude, wavenumber, angular speed (deep-water dispersion) and direction. */
export const waveSet = (settings: Pick<WaterSettings, 'waveHeight' | 'waveLength' | 'waveSpeed'>): Wave[] =>
    WAVES.map(([height, length, angle]) => {
        const k = (2 * Math.PI) / (settings.waveLength * length);
        return { amplitude: settings.waveHeight * height, k, omega: settings.waveSpeed * Math.sqrt(GRAVITY * k), dx: Math.cos(angle), dz: Math.sin(angle) };
    });

/** Surface height above the water's own plane at local (x, z) and time t. */
export const waveOffset = (waves: readonly Wave[], x: number, z: number, t: number): number => {
    let height = 0;
    for (const wave of waves) height += wave.amplitude * Math.sin(wave.k * (wave.dx * x + wave.dz * z) - wave.omega * t);
    return height;
};

/**
 * Upward buoyant force (N) on a shape of `volume` m^3 whose vertical half-extent is `halfHeight`,
 * centred `depth` m below the surface (negative: above it): the weight of the water it displaces.
 */
export const buoyancyForce = (volume: number, halfHeight: number, depth: number, density: number): number => {
    if (!(volume > 0)) return 0;
    const span = Math.max(halfHeight, 1e-3) * 2;
    const submerged = clamp((depth + span / 2) / span, 0, 1);
    return density * GRAVITY * volume * submerged;
};

// --- RENDERING ---

const VERTEX_HEADER = /* glsl */ `
uniform float uTime;
uniform vec4 uWaves[3];
uniform vec3 uWaveDirs[3];
varying float vWaveHeight;
float waveHeightAt(vec2 p) {
    float h = 0.0;
    for (int i = 0; i < 3; i++) h += uWaves[i].x * sin(uWaves[i].y * dot(uWaveDirs[i].xz, p) - uWaves[i].z * uTime);
    return h;
}
vec2 waveSlopeAt(vec2 p) {
    vec2 s = vec2(0.0);
    for (int i = 0; i < 3; i++) s += uWaves[i].x * uWaves[i].y * uWaveDirs[i].xz * cos(uWaves[i].y * dot(uWaveDirs[i].xz, p) - uWaves[i].z * uTime);
    return s;
}
`;

const FRAGMENT_HEADER = /* glsl */ `
uniform float uFoam;
uniform float uWaveTop;
varying float vWaveHeight;
`;

const createWaterMaterial = (uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial => {
    const material = new THREE.MeshStandardMaterial({ transparent: true, metalness: 0.1, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
            .replace('#include <beginnormal_vertex>', 'vec2 waveSlope = waveSlopeAt(position.xz);\nvec3 objectNormal = normalize(vec3(-waveSlope.x, 1.0, -waveSlope.y));')
            .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\nvWaveHeight = waveHeightAt(position.xz);\ntransformed.y += vWaveHeight;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
            .replace('#include <color_fragment>', '#include <color_fragment>\nfloat crest = uWaveTop > 0.0 ? smoothstep(0.35, 1.0, vWaveHeight / uWaveTop) : 0.0;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 1.0), crest * uFoam);\ndiffuseColor.a = mix(diffuseColor.a, 1.0, crest * uFoam);');
    };
    return material;
};

/** Grid density: about 8 quads per wavelength, at most 256 per side. */
const segmentsFor = (extent: number, waveLength: number) => clamp(Math.ceil((extent / waveLength) * 8), 1, 256);

const WaterSurface: React.FC<{ settings: WaterSettings }> = ({ settings }) => {
    const [sizeX, , sizeZ] = settings.size;
    const geometry = useMemo(() => {
        const plane = new THREE.PlaneGeometry(sizeX, sizeZ, segmentsFor(sizeX, settings.waveLength), segmentsFor(sizeZ, settings.waveLength));
        plane.rotateX(-Math.PI / 2);
        return plane;
    }, [sizeX, sizeZ, settings.waveLength]);
    const uniforms = useMemo(() => ({
        uTime: { value: 0 },
        uWaves: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uWaveDirs: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uFoam: { value: 0 },
        uWaveTop: { value: 0 },
    }), []);
    const material = useMemo(() => createWaterMaterial(uniforms), [uniforms]);

    useEffect(() => {
        const waves = waveSet(settings);
        waves.forEach((wave, index) => {
            uniforms.uWaves.value[index].set(wave.amplitude, wave.k, wave.omega, 0);
            uniforms.uWaveDirs.value[index].set(wave.dx, 0, wave.dz);
        });
        uniforms.uFoam.value = settings.foam;
        uniforms.uWaveTop.value = waves.reduce((sum, wave) => sum + wave.amplitude, 0);
        material.color.set(settings.color);
        material.opacity = settings.opacity;
        material.roughness = settings.roughness;
    }, [material, settings, uniforms]);

    useEffect(() => () => geometry.dispose(), [geometry]);
    useEffect(() => () => material.dispose(), [material]);

    useFrame(({ clock }) => {
        uniforms.uTime.value = clock.elapsedTime;
    });

    return <mesh geometry={geometry} material={material} receiveShadow renderOrder={1} userData={{ auvraWaterSurface: true }} />;
};

// --- BUOYANCY ---

const _local = new THREE.Vector3();

/** The vertical half-extent of a collider's shape (rotation ignored), for how much of it is under water. */
const colliderHalfHeight = (collider: RapierCollider, shapes: RapierModule['ShapeType']): number => {
    switch (collider.shape.type) {
        case shapes.Cuboid: return collider.halfExtents().y;
        case shapes.Ball: return collider.radius();
        case shapes.Capsule: return collider.halfHeight() + collider.radius();
        case shapes.Cylinder:
        case shapes.Cone: return collider.halfHeight();
        default: return Math.cbrt(Math.max(collider.volume(), 0)) / 2;
    }
};

/** One water volume as buoyancy sees it: its world-to-local matrix, settings, waves, time and owning object. */
export interface WaterVolume {
    worldToLocal: THREE.Matrix4;
    settings: WaterSettings;
    waves: readonly Wave[];
    time: number;
    ownerId: string;
}

/**
 * Applies one physics step (`dt` seconds) of buoyancy and drag from `water` to every dynamic body in
 * `world` whose colliders are inside the water's extent.
 */
export const applyWaterForces = (world: RapierWorld, shapes: RapierModule['ShapeType'], water: WaterVolume, dt: number): void => {
    const { settings, waves, time, ownerId } = water;
    const halfX = settings.size[0] / 2;
    const halfZ = settings.size[2] / 2;
    world.forEachRigidBody((body) => {
        if (!body.isDynamic() || objectIdFromRigidBody(body) === ownerId) return;
        let force = 0;
        let submerged = 0;
        for (let i = 0; i < body.numColliders(); i++) {
            const collider = body.collider(i);
            if (collider.isSensor()) continue;
            const centre = collider.translation();
            _local.set(centre.x, centre.y, centre.z).applyMatrix4(water.worldToLocal);
            if (Math.abs(_local.x) > halfX || Math.abs(_local.z) > halfZ) continue;
            const depth = waveOffset(waves, _local.x, _local.z, time) - _local.y;
            const volume = collider.volume();
            const lift = buoyancyForce(volume, colliderHalfHeight(collider, shapes), depth, settings.density);
            if (lift > 0) {
                force += lift;
                submerged = Math.max(submerged, Math.min(1, lift / (settings.density * GRAVITY * Math.max(volume, 1e-9))));
            }
        }
        if (force <= 0) return;
        body.applyImpulse({ x: 0, y: force * dt, z: 0 }, true);
        // Water resists motion in proportion to how much of the body is in it.
        const damping = Math.min(1, settings.drag * submerged * dt);
        const linear = body.linvel();
        const angular = body.angvel();
        const mass = body.mass();
        body.applyImpulse({ x: -linear.x * mass * damping, y: -linear.y * mass * damping, z: -linear.z * mass * damping }, true);
        body.setAngvel({ x: angular.x * (1 - damping), y: angular.y * (1 - damping), z: angular.z * (1 - damping) }, true);
    });
};

const WaterBuoyancy: React.FC<{ settings: WaterSettings; host: React.RefObject<THREE.Object3D | null>; ownerId: string }> = ({ settings, host, ownerId }) => {
    const { rapier } = useRapier();
    const waves = useMemo(() => waveSet(settings), [settings]);
    const time = useRef(0);
    const worldToLocal = useMemo(() => new THREE.Matrix4(), []);
    useFrame(({ clock }) => { time.current = clock.elapsedTime; });

    useBeforePhysicsStep((world) => {
        const water = host.current;
        if (!water) return;
        water.updateWorldMatrix(true, false);
        worldToLocal.copy(water.matrixWorld).invert();
        applyWaterForces(world, rapier.ShapeType, { worldToLocal, settings, waves, time: time.current, ownerId }, world.timestep);
    });
    return null;
};

const WaterRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const host = useContext(ComponentHostContext);
    const physicsAvailable = usePhysicsAvailable();
    const settings = useMemo(() => resolveWaterSettings(component), [component]);
    return (
        <>
            <WaterSurface settings={settings} />
            {mode === 'runtime' && settings.buoyancy && physicsAvailable && host && <WaterBuoyancy settings={settings} host={host} ownerId={object.id} />}
        </>
    );
};

export const WATER_COMPONENT: ComponentDefinition = {
    type: 'water',
    label: 'Water',
    description: 'An animated water surface with reflections and foam; dynamic rigid bodies float in it.',
    props: [
        { key: 'size', label: 'Size (X, -, Z)', type: 'vector3', default: WATER_DEFAULTS.size, min: 0.1, max: 10000, step: 1 },
        { key: 'color', label: 'Color', type: 'color', default: WATER_DEFAULTS.color },
        { key: 'opacity', label: 'Opacity', type: 'number', default: WATER_DEFAULTS.opacity, min: 0.05, max: 1, step: 0.05 },
        { key: 'waveHeight', label: 'Wave Height (m)', type: 'number', default: WATER_DEFAULTS.waveHeight, min: 0, max: 10, step: 0.05 },
        { key: 'waveLength', label: 'Wavelength (m)', type: 'number', default: WATER_DEFAULTS.waveLength, min: 0.5, max: 500, step: 0.5 },
        { key: 'waveSpeed', label: 'Wave Speed', type: 'number', default: WATER_DEFAULTS.waveSpeed, min: 0, max: 10, step: 0.1 },
        { key: 'foam', label: 'Foam', type: 'number', default: WATER_DEFAULTS.foam, min: 0, max: 1, step: 0.05 },
        { key: 'roughness', label: 'Roughness', type: 'number', default: WATER_DEFAULTS.roughness, min: 0, max: 1, step: 0.01 },
        { key: 'buoyancy', label: 'Buoyancy', type: 'boolean', default: WATER_DEFAULTS.buoyancy },
        { key: 'density', label: 'Density (kg/m3)', type: 'number', default: WATER_DEFAULTS.density, min: 1, max: 20000, step: 50 },
        { key: 'drag', label: 'Drag', type: 'number', default: WATER_DEFAULTS.drag, min: 0, max: 20, step: 0.1 },
    ],
    Render: WaterRender,
};
