import React, { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { ComponentDefinition, ComponentRenderProps } from './types';

// --- SETTINGS ---

export type ParticlePreset = 'smoke' | 'sparks' | 'fire' | 'dust' | 'custom';

export const PARTICLE_PRESET_IDS: readonly ParticlePreset[] = ['smoke', 'sparks', 'fire', 'dust', 'custom'];

/** The fields a named preset supplies; Custom reads them from the component instead. */
export interface ParticleLook {
    /** Seconds a particle lives; one emission cycle lasts this long too. */
    lifetime: number;
    /** Launch speed in m/s. */
    speed: number;
    /** Half-angle in degrees of the launch cone around the emitter's local +Y (180 = every direction). */
    spread: number;
    /** Sprite size in metres at birth. */
    size: number;
    colorStart: string;
    colorEnd: string;
    /** World-down acceleration in m/s^2; negative values make particles rise. */
    gravity: number;
}

/** How a preset draws and moves, beyond the editable fields. */
export interface ParticleStyle {
    blending: 'additive' | 'normal';
    opacity: number;
    /** Size multiplier reached at the end of a particle's life. */
    sizeEnd: number;
    /** Velocity damping per second (exponential). */
    drag: number;
    /** Radius of the sphere, in the owner's local units, that particles spawn in. */
    radius: number;
    /** Sideways sway in metres, applied on the GPU. */
    wobble: number;
    /** 0..1 random spread applied to lifetime and speed. */
    variance: number;
    /** 0 = soft round puff, towards 1 = hard-edged dot. */
    softness: number;
}

export interface ParticleSettings extends ParticleLook, ParticleStyle {
    preset: ParticlePreset;
    /** Particles per second emitted during a cycle. */
    rate: number;
    /** Particles emitted at once at the start of each cycle. */
    burst: number;
    /** Repeat the cycle forever; otherwise emit for one cycle and let the particles die out. */
    loop: boolean;
}

export const PARTICLE_PRESETS: Record<Exclude<ParticlePreset, 'custom'>, ParticleLook & ParticleStyle> = {
    smoke: {
        lifetime: 3, speed: 0.8, spread: 20, size: 0.6, colorStart: '#a0a0a0', colorEnd: '#4a4a4a', gravity: -0.3,
        blending: 'normal', opacity: 0.45, sizeEnd: 3, drag: 0.6, radius: 0.1, wobble: 0.25, variance: 0.3, softness: 0
    },
    sparks: {
        lifetime: 0.8, speed: 6, spread: 35, size: 0.08, colorStart: '#fff2b0', colorEnd: '#ff5a00', gravity: 9.8,
        blending: 'additive', opacity: 1, sizeEnd: 0.3, drag: 0.4, radius: 0.02, wobble: 0, variance: 0.4, softness: 0.35
    },
    fire: {
        lifetime: 0.9, speed: 1.2, spread: 12, size: 0.5, colorStart: '#ffd27a', colorEnd: '#c2200a', gravity: -2,
        blending: 'additive', opacity: 0.8, sizeEnd: 0.25, drag: 0.8, radius: 0.15, wobble: 0.06, variance: 0.3, softness: 0
    },
    dust: {
        lifetime: 5, speed: 0.15, spread: 180, size: 0.06, colorStart: '#d8cbb0', colorEnd: '#b8a888', gravity: 0.02,
        blending: 'normal', opacity: 0.6, sizeEnd: 1, drag: 0.2, radius: 1.5, wobble: 0.2, variance: 0.5, softness: 0.2
    }
};

const CUSTOM_STYLE: ParticleStyle = {
    blending: 'normal', opacity: 0.9, sizeEnd: 1, drag: 0, radius: 0, wobble: 0, variance: 0.2, softness: 0.1
};

const DEFAULT_PRESET: ParticlePreset = 'smoke';
const DEFAULT_LOOK: ParticleLook = PARTICLE_PRESETS.smoke;
const EMISSION_DEFAULTS = { rate: 20, burst: 0, loop: true };

const MAX_RATE = 1000;
const MAX_BURST = 1000;
const MIN_LIFETIME = 0.05;
const MAX_LIFETIME = 30;
/** Longest step the simulation takes in one frame, so resuming from a pause or a stalled tab does not jump. */
export const MAX_PARTICLE_STEP = 0.1;
/** Particle budget per emitter during play. */
export const RUNTIME_PARTICLE_LIMIT = 4096;
/** Smaller budget per emitter in the editor, which previews every emitter at once. */
export const EDITOR_PARTICLE_LIMIT = 256;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readNumber = (props: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
    const value = props[key];
    return clamp(typeof value === 'number' && Number.isFinite(value) ? value : fallback, min, max);
};

const readColor = (props: Record<string, unknown>, key: string, fallback: string): string => {
    const value = props[key];
    return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
};

const isPreset = (value: unknown): value is ParticlePreset =>
    typeof value === 'string' && (PARTICLE_PRESET_IDS as readonly string[]).includes(value);

/**
 * Stored component props to simulation settings. A named preset supplies the look (lifetime, speed,
 * spread, size, colours, gravity) and style; Custom reads the look from the props. Rate, burst and
 * loop always come from the props. Missing or out-of-range values fall back or clamp.
 */
export const resolveParticleSettings = (props: Record<string, unknown>): ParticleSettings => {
    const preset = isPreset(props.preset) ? props.preset : DEFAULT_PRESET;
    const emission = {
        preset,
        rate: readNumber(props, 'rate', EMISSION_DEFAULTS.rate, 0, MAX_RATE),
        burst: Math.round(readNumber(props, 'burst', EMISSION_DEFAULTS.burst, 0, MAX_BURST)),
        loop: typeof props.loop === 'boolean' ? props.loop : EMISSION_DEFAULTS.loop
    };
    if (preset !== 'custom') return { ...PARTICLE_PRESETS[preset], ...emission };
    return {
        ...CUSTOM_STYLE,
        lifetime: readNumber(props, 'lifetime', DEFAULT_LOOK.lifetime, MIN_LIFETIME, MAX_LIFETIME),
        speed: readNumber(props, 'speed', DEFAULT_LOOK.speed, 0, 100),
        spread: readNumber(props, 'spread', DEFAULT_LOOK.spread, 0, 180),
        size: readNumber(props, 'size', DEFAULT_LOOK.size, 0.01, 20),
        colorStart: readColor(props, 'colorStart', DEFAULT_LOOK.colorStart),
        colorEnd: readColor(props, 'colorEnd', DEFAULT_LOOK.colorEnd),
        gravity: readNumber(props, 'gravity', DEFAULT_LOOK.gravity, -100, 100),
        ...emission
    };
};

/** Particles alive at once, at most, for these settings (before any budget). */
const estimateAlive = (settings: ParticleSettings): number => {
    const longest = settings.lifetime * (1 + settings.variance);
    // A looping burst can overlap the previous cycles' bursts while they die out.
    const generations = settings.loop ? Math.ceil(longest / settings.lifetime) + 1 : 1;
    return settings.rate * longest + settings.burst * generations;
};

/**
 * Scales rate and burst down so the emitter stays within `limit` particles, keeping its look and
 * timing; settings already within budget come back unchanged.
 */
export const fitParticleBudget = (settings: ParticleSettings, limit: number): ParticleSettings => {
    const alive = estimateAlive(settings);
    if (alive <= limit) return settings;
    const scale = limit / alive;
    return { ...settings, rate: settings.rate * scale, burst: Math.floor(settings.burst * scale) };
};

/** Pool size for these settings: a power of two (so small edits rarely reallocate), capped at `limit`. */
export const particleCapacity = (settings: ParticleSettings, limit: number): number => {
    const needed = Math.max(16, Math.ceil(estimateAlive(settings)) + 8);
    return Math.max(1, Math.min(Math.floor(limit), 2 ** Math.ceil(Math.log2(needed))));
};

// --- SIMULATION ---

/**
 * Fixed-capacity particle storage. Live particles are packed into [0, count) so the arrays upload
 * to the GPU as-is (positions, life, seeds are vertex attributes).
 */
export interface ParticlePool {
    readonly capacity: number;
    count: number;
    /** World-space xyz per particle. */
    readonly positions: Float32Array;
    readonly velocities: Float32Array;
    readonly ages: Float32Array;
    readonly lifetimes: Float32Array;
    /** age / lifetime, 0..1. */
    readonly life: Float32Array;
    /** Per-particle random 0..1 for size, tint and sway variation. */
    readonly seeds: Float32Array;
    /** Seconds into the current emission cycle. */
    cycleTime: number;
    /** Fractional particles owed by the continuous rate. */
    carry: number;
    burstPending: boolean;
    /** A non-looping emitter has finished its cycle and emits nothing more. */
    finished: boolean;
}

export const createParticlePool = (capacity: number): ParticlePool => {
    const size = Math.max(1, Math.floor(capacity));
    return {
        capacity: size,
        count: 0,
        positions: new Float32Array(size * 3),
        velocities: new Float32Array(size * 3),
        ages: new Float32Array(size),
        lifetimes: new Float32Array(size),
        life: new Float32Array(size),
        seeds: new Float32Array(size),
        cycleTime: 0,
        carry: 0,
        burstPending: true,
        finished: false
    };
};

/** Clears every particle and restarts emission from the beginning of a cycle. */
export const resetParticlePool = (pool: ParticlePool): void => {
    pool.count = 0;
    pool.cycleTime = 0;
    pool.carry = 0;
    pool.burstPending = true;
    pool.finished = false;
};

const removeParticle = (pool: ParticlePool, index: number) => {
    const last = pool.count - 1;
    if (index !== last) {
        const a = index * 3;
        const b = last * 3;
        for (let k = 0; k < 3; k++) {
            pool.positions[a + k] = pool.positions[b + k];
            pool.velocities[a + k] = pool.velocities[b + k];
        }
        pool.ages[index] = pool.ages[last];
        pool.lifetimes[index] = pool.lifetimes[last];
        pool.life[index] = pool.life[last];
        pool.seeds[index] = pool.seeds[last];
    }
    pool.count = last;
};

const vary = (value: number, variance: number, r: number) => value * (1 + variance * (2 * r - 1));

/**
 * Spawns one particle `age` seconds old. `matrix` is the emitter's column-major world matrix
 * (THREE.Matrix4.elements); without one the emitter sits at the origin, unrotated.
 */
const spawnParticle = (
    pool: ParticlePool,
    settings: ParticleSettings,
    matrix: ArrayLike<number> | null,
    random: () => number,
    age: number
) => {
    if (pool.count >= pool.capacity) return;
    const lifetime = Math.max(MIN_LIFETIME, vary(settings.lifetime, settings.variance, random()));
    if (age >= lifetime) return;

    // Offset uniformly inside the spawn sphere, in the owner's local space.
    let ox = 0, oy = 0, oz = 0;
    if (settings.radius > 0) {
        const cosA = 2 * random() - 1;
        const sinA = Math.sqrt(1 - cosA * cosA);
        const phiA = 2 * Math.PI * random();
        const r = settings.radius * Math.cbrt(random());
        ox = r * sinA * Math.cos(phiA);
        oy = r * cosA;
        oz = r * sinA * Math.sin(phiA);
    }

    // Direction uniformly inside the cone around local +Y.
    const cosMax = Math.cos(THREE.MathUtils.degToRad(settings.spread));
    const cosT = 1 - random() * (1 - cosMax);
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = 2 * Math.PI * random();
    let dx = sinT * Math.cos(phi), dy = cosT, dz = sinT * Math.sin(phi);

    let px = ox, py = oy, pz = oz;
    if (matrix) {
        const m = matrix;
        px = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
        py = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
        pz = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
        const wx = m[0] * dx + m[4] * dy + m[8] * dz;
        const wy = m[1] * dx + m[5] * dy + m[9] * dz;
        const wz = m[2] * dx + m[6] * dy + m[10] * dz;
        const length = Math.hypot(wx, wy, wz);
        if (length > 1e-9) {
            dx = wx / length;
            dy = wy / length;
            dz = wz / length;
        }
    }

    const speed = Math.max(0, vary(settings.speed, settings.variance, random()));
    const i = pool.count;
    const v = i * 3;
    // Placed where it would be after `age` seconds of flight, so emission is smooth within a frame.
    const vx = dx * speed;
    const vy = dy * speed - settings.gravity * age;
    const vz = dz * speed;
    pool.velocities[v] = vx;
    pool.velocities[v + 1] = vy;
    pool.velocities[v + 2] = vz;
    pool.positions[v] = px + vx * age;
    pool.positions[v + 1] = py + (dy * speed - 0.5 * settings.gravity * age) * age;
    pool.positions[v + 2] = pz + vz * age;
    pool.ages[i] = age;
    pool.lifetimes[i] = lifetime;
    pool.life[i] = age / lifetime;
    pool.seeds[i] = random();
    pool.count = i + 1;
};

/**
 * Advances the emitter by `dt` seconds (clamped to MAX_PARTICLE_STEP): ages, moves and retires
 * particles, then emits the cycle's burst and its continuous rate. Mutates only `pool`, and is
 * deterministic for a given `random`.
 */
export const stepParticles = (
    pool: ParticlePool,
    settings: ParticleSettings,
    dt: number,
    matrix: ArrayLike<number> | null = null,
    random: () => number = Math.random
): void => {
    const step = Number.isFinite(dt) ? clamp(dt, 0, MAX_PARTICLE_STEP) : 0;

    const damping = settings.drag > 0 ? Math.exp(-settings.drag * step) : 1;
    const fall = settings.gravity * step;
    let i = 0;
    while (i < pool.count) {
        const age = pool.ages[i] + step;
        if (age >= pool.lifetimes[i]) {
            removeParticle(pool, i);
            continue;
        }
        const v = i * 3;
        pool.velocities[v] *= damping;
        pool.velocities[v + 1] = (pool.velocities[v + 1] - fall) * damping;
        pool.velocities[v + 2] *= damping;
        pool.positions[v] += pool.velocities[v] * step;
        pool.positions[v + 1] += pool.velocities[v + 1] * step;
        pool.positions[v + 2] += pool.velocities[v + 2] * step;
        pool.ages[i] = age;
        pool.life[i] = age / pool.lifetimes[i];
        i++;
    }

    // Emission walks the step in cycle segments so a cycle boundary inside a frame is exact.
    // `left` is the time still to cover, which is also the age of anything emitted at that moment.
    const cycle = Math.max(MIN_LIFETIME, settings.lifetime);
    let left = step;
    while (!pool.finished) {
        if (pool.burstPending) {
            pool.burstPending = false;
            for (let k = 0; k < settings.burst; k++) spawnParticle(pool, settings, matrix, random, left);
        }
        if (left <= 0) break;
        const active = Math.min(left, cycle - pool.cycleTime);
        pool.carry += settings.rate * active;
        const due = Math.floor(pool.carry);
        pool.carry -= due;
        // Spread the due particles evenly across the segment, oldest first.
        for (let k = 0; k < due; k++) spawnParticle(pool, settings, matrix, random, left - active * (k + 0.5) / due);
        pool.cycleTime += active;
        left -= active;
        if (pool.cycleTime >= cycle - 1e-9) {
            pool.cycleTime = 0;
            if (settings.loop) {
                pool.burstPending = true;
            } else {
                pool.finished = true;
                pool.carry = 0;
            }
        }
    }
};

// --- RENDERING ---

const VERTEX_SHADER = /* glsl */ `
uniform float uSize;
uniform float uSizeEnd;
uniform float uViewportHeight;
uniform float uWobble;
uniform float uOpacity;
uniform vec3 uColorStart;
uniform vec3 uColorEnd;
attribute float aLife;
attribute float aSeed;
varying vec4 vColor;

void main() {
    float phase = aSeed * 6.2831853;
    vec3 p = position;
    p.x += sin(aLife * 9.0 + phase) * uWobble * aLife;
    p.z += cos(aLife * 7.0 + phase * 1.7) * uWobble * aLife;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // World-size sprites: perspective divides by depth, orthographic does not.
    float size = uSize * mix(1.0, uSizeEnd, aLife) * (0.75 + 0.5 * aSeed);
    float depth = projectionMatrix[2][3] == -1.0 ? max(-mvPosition.z, 0.0001) : 1.0;
    gl_PointSize = min(size * projectionMatrix[1][1] * 0.5 * uViewportHeight / depth, 512.0);

    float fade = smoothstep(0.0, 0.08, aLife) * (1.0 - smoothstep(0.55, 1.0, aLife));
    vColor = vec4(mix(uColorStart, uColorEnd, aLife) * (0.85 + 0.3 * aSeed), uOpacity * fade);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uSoftness;
varying vec4 vColor;

void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float d = dot(c, c);
    if (d > 1.0) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(uSoftness, 1.0, d)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const createParticleMaterial = () => new THREE.ShaderMaterial({
    uniforms: {
        uSize: { value: 1 },
        uSizeEnd: { value: 1 },
        uViewportHeight: { value: 1 },
        uWobble: { value: 0 },
        uOpacity: { value: 1 },
        uSoftness: { value: 0 },
        uColorStart: { value: new THREE.Color() },
        uColorEnd: { value: new THREE.Color() }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false
});

const applyParticleStyle = (material: THREE.ShaderMaterial, settings: ParticleSettings) => {
    const u = material.uniforms;
    u.uSize.value = settings.size;
    u.uSizeEnd.value = settings.sizeEnd;
    u.uWobble.value = settings.wobble;
    u.uOpacity.value = settings.opacity;
    u.uSoftness.value = settings.softness;
    (u.uColorStart.value as THREE.Color).set(settings.colorStart);
    (u.uColorEnd.value as THREE.Color).set(settings.colorEnd);
    material.blending = settings.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
};

const dynamicAttribute = (array: Float32Array, itemSize: number) =>
    new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);

/**
 * Points whose vertices are already in world space: the owner's transform is applied when a
 * particle spawns, so trails stay behind a moving owner. The world matrix therefore stays
 * identity, and particles are never raycast (they must not steal editor clicks).
 */
class WorldSpacePoints extends THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    constructor(pool: ParticlePool, material: THREE.ShaderMaterial) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', dynamicAttribute(pool.positions, 3));
        geometry.setAttribute('aLife', dynamicAttribute(pool.life, 1));
        geometry.setAttribute('aSeed', dynamicAttribute(pool.seeds, 1));
        geometry.setDrawRange(0, 0);
        // three sorts transparent draws by this centre. Left null, it would be computed once, lazily, over the
        // zero-filled pool and stay at the origin; ParticlesRender keeps it on the emitter instead.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
        super(geometry, material);
        this.matrixAutoUpdate = false;
        this.matrixWorldAutoUpdate = false;
        this.frustumCulled = false;
    }

    override updateMatrixWorld(): void {}

    override updateWorldMatrix(): void {}

    override raycast(): void {}
}

const UPLOADED_ATTRIBUTES: [name: string, itemSize: number][] = [['position', 3], ['aLife', 1], ['aSeed', 1]];

const ParticlesRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const editor = mode === 'editor';
    const settings = useMemo(() => {
        const resolved = resolveParticleSettings(component.props);
        // The editor replays one-shot emitters so their burst stays visible while authoring.
        return fitParticleBudget(editor ? { ...resolved, loop: true } : resolved, editor ? EDITOR_PARTICLE_LIMIT : RUNTIME_PARTICLE_LIMIT);
    }, [component.props, editor]);
    const capacity = particleCapacity(settings, editor ? EDITOR_PARTICLE_LIMIT : RUNTIME_PARTICLE_LIMIT);

    const material = useMemo(createParticleMaterial, []);
    const pool = useMemo(() => createParticlePool(capacity), [capacity]);
    const points = useMemo(() => new WorldSpacePoints(pool, material), [pool, material]);

    // Layout effect: the style is in place before the first frame draws any particle.
    useLayoutEffect(() => applyParticleStyle(material, settings), [material, settings]);
    useEffect(() => () => points.geometry.dispose(), [points]);
    useEffect(() => () => material.dispose(), [material]);

    useFrame((state, delta) => {
        // The owner's transform group: spawn at its current world transform.
        const owner = points.parent;
        if (!owner) return;
        owner.updateWorldMatrix(true, false);
        stepParticles(pool, settings, delta, owner.matrixWorld.elements);

        material.uniforms.uViewportHeight.value = state.size.height * state.viewport.dpr;
        const geometry = points.geometry;
        // Depth-sort point for transparent layering: the emitter (world space, as matrixWorld stays identity).
        geometry.boundingSphere?.center.setFromMatrixPosition(owner.matrixWorld);
        geometry.setDrawRange(0, pool.count);
        if (pool.count === 0) return;
        for (const [name, itemSize] of UPLOADED_ATTRIBUTES) {
            const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, pool.count * itemSize);
            attribute.needsUpdate = true;
        }
    });

    return <primitive object={points} />;
};

// --- DEFINITION ---

export const PARTICLES_COMPONENT: ComponentDefinition = {
    type: 'particles',
    label: 'Particles',
    description: 'Emits particles from the object\'s origin along its local up (+Y) axis, left behind in the world as it moves. '
        + 'A named preset sets lifetime, speed, spread, size, colours and gravity; choose Custom to use those fields. '
        + 'Rate, Burst and Loop always apply, and one cycle lasts one lifetime.',
    props: [
        {
            key: 'preset', label: 'Preset', type: 'select', default: DEFAULT_PRESET,
            options: [
                { label: 'Smoke', value: 'smoke' },
                { label: 'Sparks', value: 'sparks' },
                { label: 'Fire', value: 'fire' },
                { label: 'Dust', value: 'dust' },
                { label: 'Custom', value: 'custom' }
            ]
        },
        { key: 'rate', label: 'Rate (per s)', type: 'number', default: EMISSION_DEFAULTS.rate, min: 0, max: MAX_RATE, step: 1 },
        { key: 'lifetime', label: 'Lifetime (s)', type: 'number', default: DEFAULT_LOOK.lifetime, min: MIN_LIFETIME, max: MAX_LIFETIME, step: 0.05 },
        { key: 'speed', label: 'Speed (m/s)', type: 'number', default: DEFAULT_LOOK.speed, min: 0, max: 100, step: 0.1 },
        { key: 'spread', label: 'Spread (deg)', type: 'number', default: DEFAULT_LOOK.spread, min: 0, max: 180, step: 1 },
        { key: 'size', label: 'Size (m)', type: 'number', default: DEFAULT_LOOK.size, min: 0.01, max: 20, step: 0.01 },
        { key: 'colorStart', label: 'Start Color', type: 'color', default: DEFAULT_LOOK.colorStart },
        { key: 'colorEnd', label: 'End Color', type: 'color', default: DEFAULT_LOOK.colorEnd },
        { key: 'gravity', label: 'Gravity (m/s^2)', type: 'number', default: DEFAULT_LOOK.gravity, min: -100, max: 100, step: 0.1 },
        { key: 'burst', label: 'Burst', type: 'number', default: EMISSION_DEFAULTS.burst, min: 0, max: MAX_BURST, step: 1 },
        { key: 'loop', label: 'Loop', type: 'boolean', default: EMISSION_DEFAULTS.loop }
    ],
    Render: ParticlesRender
};
