/**
 * PARTICLE EFFECTS
 *
 * What a Particles component emits, as data: when and how many (rate, rate over distance, bursts),
 * from where (a point, sphere, cone, box, ring, line or the object's own surface), how each starts
 * (lifetime, speed, size, rotation, colour), how it changes over its life (colour and alpha
 * gradient, size and speed curves), what moves it (gravity, drag, wind, turbulence, a vortex), what
 * it does when it hits the world, what it sets off (sub-emitters), and how it is drawn (sprite or
 * flipbook, billboard, stretched along its motion, flat, upright or as a ribbon, blended or added,
 * with an optional light), and whether it runs on the CPU or the GPU. Stored props resolve to an
 * effect here, every field defaulted and in range; components saved before effects existed keep
 * their look.
 */

export type Range = [number, number];
export type Vec3 = [number, number, number];

export interface GradientStop {
    /** 0-1 through the particle's life. */
    t: number;
    color: string;
    alpha: number;
}

export interface Gradient {
    stops: GradientStop[];
}

/** A curve over a particle's life: [t 0-1, value] points, joined by straight lines. */
export interface Curve {
    points: [number, number][];
}

export type ParticleShapeKind = 'point' | 'sphere' | 'hemisphere' | 'cone' | 'box' | 'circle' | 'edge' | 'mesh';
export const PARTICLE_SHAPES: readonly ParticleShapeKind[] = ['point', 'sphere', 'hemisphere', 'cone', 'box', 'circle', 'edge', 'mesh'];

export interface ParticleShape {
    kind: ParticleShapeKind;
    /** Sphere, hemisphere, cone base and circle radius, metres. */
    radius: number;
    /** Half-angle of the launch cone around the emitter's up (+Y), degrees. */
    angle: number;
    /** Box extents, and the edge's length along X, metres. */
    size: Vec3;
    /** 0 emits from the shape's surface only, 1 from anywhere inside it. */
    volume: number;
    /** 0 launches along the shape's own direction, 1 in random directions. */
    randomDirection: number;
    /** The direction cones open around, in the object's space (up by default; down for rain). */
    axis: Vec3;
}

export interface ParticleBurst {
    /** Seconds into each cycle. */
    time: number;
    count: number;
}

export type ParticleCollisionMode = 'none' | 'world';
export const PARTICLE_COLLISION_MODES: readonly ParticleCollisionMode[] = ['none', 'world'];

export interface ParticleCollision {
    mode: ParticleCollisionMode;
    /** Share of the speed into the surface kept on the bounce, 0-1. */
    bounce: number;
    /** Share of the speed along the surface lost on each hit, 0-1. */
    friction: number;
    /** Retire a particle when it hits. */
    kill: boolean;
}

export type SubEmitterTrigger = 'death' | 'collision';
export const SUB_EMITTER_TRIGGERS: readonly SubEmitterTrigger[] = ['death', 'collision'];

/** Another Particles component on the same object, set off where this emitter's particles die or hit. */
export interface SubEmitter {
    trigger: SubEmitterTrigger;
    /** The target component's id. */
    target: string;
    count: number;
    /** Share of the particle's velocity the new ones start with, 0-1. */
    inheritVelocity: number;
}

export type ParticleRenderMode = 'billboard' | 'stretched' | 'horizontal' | 'vertical' | 'ribbon';
export const PARTICLE_RENDER_MODES: readonly ParticleRenderMode[] = ['billboard', 'stretched', 'horizontal', 'vertical', 'ribbon'];

export type ParticleBlending = 'alpha' | 'additive';
export const PARTICLE_BLENDINGS: readonly ParticleBlending[] = ['alpha', 'additive'];

export type ParticleFrameMode = 'life' | 'fps' | 'random';
export const PARTICLE_FRAME_MODES: readonly ParticleFrameMode[] = ['life', 'fps', 'random'];

/** Sprites made in the engine; a texture asset is named `texture:<id>`. */
export type BuiltinSprite = 'soft' | 'smoke' | 'spark' | 'glow' | 'ring' | 'star' | 'flame' | 'droplet' | 'snowflake' | 'leaf' | 'square' | 'debris';
export const BUILTIN_SPRITES: readonly BuiltinSprite[] = ['soft', 'smoke', 'spark', 'glow', 'ring', 'star', 'flame', 'droplet', 'snowflake', 'leaf', 'square', 'debris'];

export interface ParticleRender {
    mode: ParticleRenderMode;
    sprite: string;
    /** Flipbook grid of the sprite (a built-in sprite's own grid when it has one). */
    columns: number;
    rows: number;
    frameMode: ParticleFrameMode;
    /** Flipbook frames per second, for the 'fps' frame mode. */
    fps: number;
    blending: ParticleBlending;
    /** Brightness multiplier; above 1 it glows with bloom. */
    emissive: number;
    /** Stretched mode: extra length per m/s of speed, in particle sizes. */
    stretch: number;
    /** Sort back to front (alpha blending only). */
    sort: boolean;
}

export interface ParticleLight {
    enabled: boolean;
    color: string;
    /** Candela at full strength. */
    intensity: number;
    /** Metres. */
    range: number;
    /** 0 steady, 1 flickering like fire. */
    flicker: number;
}

export type ParticleSpace = 'world' | 'local';

/**
 * CPU: up to RUNTIME_PARTICLE_LIMIT particles, with every feature. GPU: up to GPU_PARTICLE_LIMIT,
 * simulated and drawn on the graphics card, without sub-emitters, ribbons or sorting, colliding with
 * the ground under the emitter rather than with every surface.
 */
export type ParticleSimulationMode = 'cpu' | 'gpu';
export const PARTICLE_SIMULATION_MODES: readonly ParticleSimulationMode[] = ['cpu', 'gpu'];

export interface ParticleEffect {
    /** Where the particles are simulated: see ParticleSimulationMode. */
    simulation: ParticleSimulationMode;
    /** Seconds per cycle; bursts are timed within it. */
    duration: number;
    loop: boolean;
    /** Starts as if it had already run a cycle (looping effects). */
    prewarm: boolean;
    /** Seconds before it starts emitting. */
    delay: number;
    /** Particles per second. */
    rate: number;
    /** Particles per metre the emitter moves: trails. */
    rateOverDistance: number;
    bursts: ParticleBurst[];
    /** Most particles alive at once. */
    maxParticles: number;
    shape: ParticleShape;
    /** World: particles stay where they were left as the emitter moves. Local: they move with it. */
    space: ParticleSpace;
    lifetime: Range;
    /** m/s. */
    speed: Range;
    /** Metres. */
    size: Range;
    /** Degrees. */
    rotation: Range;
    /** Degrees per second. */
    spin: Range;
    /** Each particle's colour is picked between these two. */
    startColor: [string, string];
    /** Share of the emitter's own velocity particles start with, 0-1. */
    inheritVelocity: number;
    /** m/s² downwards; negative rises. */
    gravity: number;
    /** Velocity damping per second. */
    drag: number;
    /** m/s² of world acceleration. */
    wind: Vec3;
    /** m/s² of swirling noise, and the size of its swirls (metres). */
    turbulence: number;
    turbulenceScale: number;
    /** Radians per second the particles circle the emitter's up axis. */
    orbit: number;
    colorOverLife: Gradient;
    sizeOverLife: Curve;
    speedOverLife: Curve;
    collision: ParticleCollision;
    subEmitters: SubEmitter[];
    render: ParticleRender;
    light: ParticleLight;
}

// ---------------------------------------------------------------------------
// Gradients and curves
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const unit = (value: number): number => clamp(value, 0, 1);

const parseHex = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

/** sRGB 0-1 to linear, as the renderer works in linear light. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A colour as linear RGB. */
export const linearColor = (hex: string, out: Float32Array | number[] = [0, 0, 0], offset = 0): Float32Array | number[] => {
    const [r, g, b] = parseHex(HEX.test(hex) ? hex : '#ffffff');
    out[offset] = toLinear(r);
    out[offset + 1] = toLinear(g);
    out[offset + 2] = toLinear(b);
    return out;
};

/** Samples taken across a gradient or curve when it is baked for the simulation. */
export const BAKE_SAMPLES = 64;

/** A gradient baked to BAKE_SAMPLES linear RGBA samples. */
export const bakeGradient = (gradient: Gradient): Float32Array => {
    const out = new Float32Array(BAKE_SAMPLES * 4);
    const stops = gradient.stops.length ? gradient.stops : [{ t: 0, color: '#ffffff', alpha: 1 }];
    const colors = stops.map(stop => linearColor(stop.color));
    for (let i = 0; i < BAKE_SAMPLES; i++) {
        const t = i / (BAKE_SAMPLES - 1);
        let next = stops.findIndex(stop => stop.t >= t);
        if (next === -1) next = stops.length - 1;
        const prev = Math.max(0, next - 1);
        const a = stops[prev];
        const b = stops[next];
        const span = b.t - a.t;
        const f = next === prev || span <= 1e-6 ? (t >= b.t ? 1 : 0) : unit((t - a.t) / span);
        for (let c = 0; c < 3; c++) out[i * 4 + c] = colors[prev][c] + (colors[next][c] - colors[prev][c]) * f;
        out[i * 4 + 3] = a.alpha + (b.alpha - a.alpha) * f;
    }
    return out;
};

/** A curve baked to BAKE_SAMPLES values. */
export const bakeCurve = (curve: Curve): Float32Array => {
    const out = new Float32Array(BAKE_SAMPLES);
    const points = curve.points.length ? curve.points : [[0, 1] as [number, number]];
    for (let i = 0; i < BAKE_SAMPLES; i++) out[i] = evaluateCurve(points, i / (BAKE_SAMPLES - 1));
    return out;
};

/** A curve's value at `t` (0-1), held flat before its first point and after its last. */
export const evaluateCurve = (points: readonly [number, number][], t: number): number => {
    if (points.length === 0) return 1;
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
        const [t1, v1] = points[i];
        if (t <= t1) {
            const [t0, v0] = points[i - 1];
            return t1 - t0 <= 1e-6 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
        }
    }
    return points[points.length - 1][1];
};

/** A baked table's sample at life `t` (0-1). */
export const sampleBaked = (table: Float32Array, t: number, stride = 1, channel = 0): number => {
    const index = Math.round(unit(t) * (BAKE_SAMPLES - 1));
    return table[index * stride + channel];
};

// ---------------------------------------------------------------------------
// Defaults and sanitizing
// ---------------------------------------------------------------------------

const DEFAULT_SHAPE: ParticleShape = { kind: 'cone', radius: 0.1, angle: 20, size: [1, 1, 1], volume: 1, randomDirection: 0, axis: [0, 1, 0] };

const DEFAULT_RENDER: ParticleRender = {
    mode: 'billboard', sprite: 'smoke', columns: 1, rows: 1, frameMode: 'random', fps: 12,
    blending: 'alpha', emissive: 1, stretch: 0.15, sort: true,
};

const DEFAULT_LIGHT: ParticleLight = { enabled: false, color: '#ffb060', intensity: 30, range: 6, flicker: 0.3 };

/** The default effect: a soft column of smoke. */
export const DEFAULT_PARTICLE_EFFECT: ParticleEffect = {
    simulation: 'cpu',
    duration: 3, loop: true, prewarm: false, delay: 0,
    rate: 20, rateOverDistance: 0, bursts: [], maxParticles: 400,
    shape: DEFAULT_SHAPE, space: 'world',
    lifetime: [2.4, 3.6], speed: [0.6, 1], size: [0.5, 0.8], rotation: [0, 360], spin: [-20, 20],
    startColor: ['#a8a8a8', '#8c8c8c'], inheritVelocity: 0,
    gravity: -0.3, drag: 0.6, wind: [0, 0, 0], turbulence: 0.3, turbulenceScale: 2, orbit: 0,
    colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0 }, { t: 0.1, color: '#ffffff', alpha: 0.5 }, { t: 0.6, color: '#d8d8d8', alpha: 0.35 }, { t: 1, color: '#a0a0a0', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.6], [1, 3]] },
    speedOverLife: { points: [[0, 1], [1, 1]] },
    collision: { mode: 'none', bounce: 0.3, friction: 0.4, kill: false },
    subEmitters: [],
    render: DEFAULT_RENDER,
    light: DEFAULT_LIGHT,
};

/** Most particles one emitter keeps alive in play, and in the editor's preview of every emitter at once. */
export const RUNTIME_PARTICLE_LIMIT = 20000;
export const EDITOR_PARTICLE_LIMIT = 600;
/** The same for GPU emitters: their particles live in textures up to 1024 × 1024. */
export const GPU_PARTICLE_LIMIT = 1024 * 1024;
export const EDITOR_GPU_PARTICLE_LIMIT = 131072;

/** Most particles an emitter keeps, emits per second and in one burst, by where it simulates. */
export const particleLimits = (simulation: ParticleSimulationMode): { particles: number; rate: number; burst: number } =>
    simulation === 'gpu' ? { particles: GPU_PARTICLE_LIMIT, rate: 1000000, burst: GPU_PARTICLE_LIMIT } : { particles: RUNTIME_PARTICLE_LIMIT, rate: 5000, burst: 5000 };

const num = (value: unknown, fallback: number, min: number, max: number): number =>
    clamp(typeof value === 'number' && Number.isFinite(value) ? value : fallback, min, max);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const color = (value: unknown, fallback: string): string => (typeof value === 'string' && HEX.test(value) ? value : fallback);
const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
    typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

const range = (value: unknown, fallback: Range, min: number, max: number): Range => {
    if (!Array.isArray(value) || value.length < 2) return [...fallback];
    const a = num(value[0], fallback[0], min, max);
    const b = num(value[1], fallback[1], min, max);
    return a <= b ? [a, b] : [b, a];
};

const vec3 = (value: unknown, fallback: Vec3, min: number, max: number): Vec3 =>
    Array.isArray(value) && value.length === 3
        ? [num(value[0], fallback[0], min, max), num(value[1], fallback[1], min, max), num(value[2], fallback[2], min, max)]
        : [...fallback];

const gradient = (value: unknown, fallback: Gradient): Gradient => {
    const stops = Array.isArray(record(value).stops) ? (record(value).stops as unknown[]) : null;
    if (!stops || stops.length === 0) return { stops: fallback.stops.map(stop => ({ ...stop })) };
    return {
        stops: stops.slice(0, 8).map(entry => {
            const stop = record(entry);
            return { t: num(stop.t, 0, 0, 1), color: color(stop.color, '#ffffff'), alpha: num(stop.alpha, 1, 0, 1) };
        }).sort((a, b) => a.t - b.t),
    };
};

const curve = (value: unknown, fallback: Curve, min: number, max: number): Curve => {
    const points = Array.isArray(record(value).points) ? (record(value).points as unknown[]) : null;
    if (!points || points.length === 0) return { points: fallback.points.map(([t, v]) => [t, v] as [number, number]) };
    return {
        points: points.slice(0, 8)
            .filter((point): point is unknown[] => Array.isArray(point) && point.length >= 2)
            .map(point => [num(point[0], 0, 0, 1), num(point[1], 1, min, max)] as [number, number])
            .sort((a, b) => a[0] - b[0]),
    };
};

const sprite = (value: unknown, fallback: string): string =>
    typeof value === 'string' && ((BUILTIN_SPRITES as readonly string[]).includes(value) || /^texture:.+/.test(value)) ? value : fallback;

/** An effect from stored data, every field defaulted, clamped and in order. */
export const sanitizeParticleEffect = (value: unknown, base: ParticleEffect = DEFAULT_PARTICLE_EFFECT): ParticleEffect => {
    const e = record(value);
    const shape = record(e.shape);
    const collision = record(e.collision);
    const render = record(e.render);
    const light = record(e.light);
    const start = Array.isArray(e.startColor) ? e.startColor : [];
    const simulation = choice(e.simulation, PARTICLE_SIMULATION_MODES, base.simulation);
    const limits = particleLimits(simulation);
    return {
        simulation,
        duration: num(e.duration, base.duration, 0.05, 120),
        loop: bool(e.loop, base.loop),
        prewarm: bool(e.prewarm, base.prewarm),
        delay: num(e.delay, base.delay, 0, 60),
        rate: num(e.rate, base.rate, 0, limits.rate),
        rateOverDistance: num(e.rateOverDistance, base.rateOverDistance, 0, 200),
        bursts: (Array.isArray(e.bursts) ? e.bursts : base.bursts).slice(0, 8).map(entry => {
            const burst = record(entry);
            return { time: num(burst.time, 0, 0, 120), count: Math.round(num(burst.count, 10, 0, limits.burst)) };
        }),
        maxParticles: Math.round(num(e.maxParticles, base.maxParticles, 1, limits.particles)),
        shape: {
            kind: choice(shape.kind, PARTICLE_SHAPES, base.shape.kind),
            radius: num(shape.radius, base.shape.radius, 0, 1000),
            angle: num(shape.angle, base.shape.angle, 0, 180),
            size: vec3(shape.size, base.shape.size, 0, 1000),
            volume: num(shape.volume, base.shape.volume, 0, 1),
            randomDirection: num(shape.randomDirection, base.shape.randomDirection, 0, 1),
            axis: vec3(shape.axis, base.shape.axis, -1, 1),
        },
        space: choice(e.space, ['world', 'local'] as const, base.space),
        lifetime: range(e.lifetime, base.lifetime, 0.02, 60),
        speed: range(e.speed, base.speed, 0, 500),
        size: range(e.size, base.size, 0.001, 100),
        rotation: range(e.rotation, base.rotation, -360, 360),
        spin: range(e.spin, base.spin, -2000, 2000),
        startColor: [color(start[0], base.startColor[0]), color(start[1], base.startColor[1])],
        inheritVelocity: num(e.inheritVelocity, base.inheritVelocity, 0, 1),
        gravity: num(e.gravity, base.gravity, -100, 100),
        drag: num(e.drag, base.drag, 0, 50),
        wind: vec3(e.wind, base.wind, -200, 200),
        turbulence: num(e.turbulence, base.turbulence, 0, 200),
        turbulenceScale: num(e.turbulenceScale, base.turbulenceScale, 0.05, 100),
        orbit: num(e.orbit, base.orbit, -50, 50),
        colorOverLife: gradient(e.colorOverLife, base.colorOverLife),
        sizeOverLife: curve(e.sizeOverLife, base.sizeOverLife, 0, 50),
        speedOverLife: curve(e.speedOverLife, base.speedOverLife, 0, 10),
        collision: {
            mode: choice(collision.mode, PARTICLE_COLLISION_MODES, base.collision.mode),
            bounce: num(collision.bounce, base.collision.bounce, 0, 1),
            friction: num(collision.friction, base.collision.friction, 0, 1),
            kill: bool(collision.kill, base.collision.kill),
        },
        subEmitters: (Array.isArray(e.subEmitters) ? e.subEmitters : base.subEmitters).slice(0, 4).map(entry => {
            const sub = record(entry);
            return {
                trigger: choice(sub.trigger, SUB_EMITTER_TRIGGERS, 'death'),
                target: typeof sub.target === 'string' ? sub.target : '',
                count: Math.round(num(sub.count, 5, 1, 500)),
                inheritVelocity: num(sub.inheritVelocity, 0.3, 0, 1),
            };
        }),
        render: {
            mode: choice(render.mode, PARTICLE_RENDER_MODES, base.render.mode),
            sprite: sprite(render.sprite, base.render.sprite),
            columns: Math.round(num(render.columns, base.render.columns, 1, 16)),
            rows: Math.round(num(render.rows, base.render.rows, 1, 16)),
            frameMode: choice(render.frameMode, PARTICLE_FRAME_MODES, base.render.frameMode),
            fps: num(render.fps, base.render.fps, 0, 120),
            blending: choice(render.blending, PARTICLE_BLENDINGS, base.render.blending),
            emissive: num(render.emissive, base.render.emissive, 0, 50),
            stretch: num(render.stretch, base.render.stretch, 0, 10),
            sort: bool(render.sort, base.render.sort),
        },
        light: {
            enabled: bool(light.enabled, base.light.enabled),
            color: color(light.color, base.light.color),
            intensity: num(light.intensity, base.light.intensity, 0, 100000),
            range: num(light.range, base.light.range, 0.1, 500),
            flicker: num(light.flicker, base.light.flicker, 0, 1),
        },
    };
};

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const fade = (color: string, peak: number, end = color): Gradient => ({
    stops: [{ t: 0, color, alpha: 0 }, { t: 0.1, color, alpha: peak }, { t: 0.7, color: end, alpha: peak * 0.7 }, { t: 1, color: end, alpha: 0 }],
});

type EffectOverrides = Omit<Partial<ParticleEffect>, 'render' | 'shape' | 'light' | 'collision'> & {
    render?: Partial<ParticleRender>;
    shape?: Partial<ParticleShape>;
    light?: Partial<ParticleLight>;
    collision?: Partial<ParticleCollision>;
};

const effect = (overrides: EffectOverrides): ParticleEffect =>
    sanitizeParticleEffect({
        ...DEFAULT_PARTICLE_EFFECT,
        ...overrides,
        shape: { ...DEFAULT_PARTICLE_EFFECT.shape, ...overrides.shape },
        render: { ...DEFAULT_PARTICLE_EFFECT.render, ...overrides.render },
        light: { ...DEFAULT_PARTICLE_EFFECT.light, ...overrides.light },
        collision: { ...DEFAULT_PARTICLE_EFFECT.collision, ...overrides.collision },
    });

export const PARTICLE_PRESETS = {
    smoke: effect({}),
    fire: effect({
        rate: 45, lifetime: [0.6, 1.1], speed: [1, 1.8], size: [0.45, 0.7], gravity: -2.5, drag: 1, turbulence: 1.2, turbulenceScale: 0.8,
        shape: { kind: 'circle', radius: 0.25, angle: 10, volume: 1 }, startColor: ['#ffd27a', '#ffb347'],
        colorOverLife: { stops: [{ t: 0, color: '#fff2c0', alpha: 0 }, { t: 0.08, color: '#ffd27a', alpha: 0.9 }, { t: 0.5, color: '#ff7a1a', alpha: 0.7 }, { t: 1, color: '#801000', alpha: 0 }] },
        sizeOverLife: { points: [[0, 0.8], [0.4, 1], [1, 0.3]] },
        render: { sprite: 'flame', blending: 'additive', emissive: 3, frameMode: 'life', sort: false },
        light: { enabled: true, color: '#ff9a40', intensity: 40, range: 7, flicker: 0.5 },
    }),
    sparks: effect({
        rate: 0, loop: true, duration: 1.2, bursts: [{ time: 0, count: 40 }], lifetime: [0.4, 0.9], speed: [4, 9], size: [0.04, 0.07],
        shape: { kind: 'point', angle: 35 }, gravity: 9.8, drag: 0.4, turbulence: 0, startColor: ['#fff2b0', '#ffd27a'],
        colorOverLife: { stops: [{ t: 0, color: '#fff6d0', alpha: 1 }, { t: 0.5, color: '#ffae30', alpha: 1 }, { t: 1, color: '#ff4000', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 0.4]] },
        collision: { mode: 'world', bounce: 0.4, friction: 0.3 },
        render: { mode: 'stretched', sprite: 'spark', blending: 'additive', emissive: 4, stretch: 0.45, sort: false },
    }),
    dust: effect({
        rate: 25, lifetime: [4, 6], speed: [0.05, 0.2], size: [0.04, 0.08], gravity: 0.02, drag: 0.2, turbulence: 0.15,
        shape: { kind: 'box', size: [3, 2, 3], randomDirection: 1 }, startColor: ['#d8cbb0', '#c8b898'],
        colorOverLife: fade('#d8cbb0', 0.6, '#b8a888'), sizeOverLife: { points: [[0, 1], [1, 1]] },
        render: { sprite: 'soft' },
    }),
    explosion: effect({
        rate: 0, loop: false, duration: 2, bursts: [{ time: 0, count: 60 }], lifetime: [0.5, 1.4], speed: [3, 9], size: [0.8, 1.6],
        shape: { kind: 'sphere', radius: 0.4, volume: 1 }, gravity: -1, drag: 3, turbulence: 2, startColor: ['#ffe8a0', '#ffb040'],
        colorOverLife: { stops: [{ t: 0, color: '#fff4d0', alpha: 1 }, { t: 0.15, color: '#ffa030', alpha: 0.9 }, { t: 0.4, color: '#803010', alpha: 0.7 }, { t: 1, color: '#202020', alpha: 0 }] },
        sizeOverLife: { points: [[0, 0.5], [0.3, 1.4], [1, 2.2]] },
        render: { sprite: 'smoke', blending: 'alpha', emissive: 2.5 },
        light: { enabled: true, color: '#ffa040', intensity: 400, range: 18, flicker: 0.2 },
    }),
    embers: effect({
        rate: 12, lifetime: [2, 4], speed: [0.5, 1.5], size: [0.03, 0.06], gravity: -0.8, drag: 0.3, turbulence: 1.5, turbulenceScale: 1.2,
        shape: { kind: 'circle', radius: 0.4 }, startColor: ['#ffb040', '#ff7020'],
        colorOverLife: fade('#ffb040', 1, '#ff3000'), sizeOverLife: { points: [[0, 1], [1, 0.5]] },
        render: { sprite: 'glow', blending: 'additive', emissive: 5, sort: false },
    }),
    magic: effect({
        rate: 40, lifetime: [1, 2], speed: [0.2, 0.6], size: [0.08, 0.16], gravity: -0.3, drag: 0.5, turbulence: 0.6, orbit: 2,
        shape: { kind: 'circle', radius: 0.6, volume: 0 }, startColor: ['#9ad8ff', '#d6a0ff'],
        colorOverLife: fade('#c8e8ff', 1, '#a060ff'), sizeOverLife: { points: [[0, 0.3], [0.2, 1], [1, 0]] },
        render: { sprite: 'star', blending: 'additive', emissive: 4, sort: false },
        light: { enabled: true, color: '#a0c8ff', intensity: 15, range: 5, flicker: 0.1 },
    }),
    rain: effect({
        rate: 1500, lifetime: [0.9, 1.1], speed: [11, 13], size: [0.02, 0.03], gravity: 0, drag: 0, turbulence: 0, maxParticles: 4000,
        shape: { kind: 'box', size: [30, 0.1, 30], angle: 2, axis: [0, -1, 0] }, startColor: ['#c0d4e8', '#a8c0d8'],
        colorOverLife: { stops: [{ t: 0, color: '#c8dcf0', alpha: 0.5 }, { t: 1, color: '#c8dcf0', alpha: 0.5 }] },
        sizeOverLife: { points: [[0, 1], [1, 1]] },
        collision: { mode: 'world', kill: true },
        // Streaks about half a metre long at falling speed, as rain looks to the eye.
        render: { mode: 'stretched', sprite: 'droplet', stretch: 3, sort: false },
    }),
    snow: effect({
        rate: 300, lifetime: [6, 9], speed: [0.8, 1.4], size: [0.03, 0.06], gravity: 0, drag: 0.1, turbulence: 0.4, turbulenceScale: 3, maxParticles: 3000,
        shape: { kind: 'box', size: [30, 0.1, 30], angle: 25, axis: [0, -1, 0] }, startColor: ['#ffffff', '#eef4ff'],
        colorOverLife: fade('#ffffff', 0.9), sizeOverLife: { points: [[0, 1], [1, 1]] },
        collision: { mode: 'world', kill: true },
        render: { sprite: 'snowflake', sort: false },
    }),
    steam: effect({
        rate: 18, lifetime: [1.5, 2.5], speed: [0.8, 1.4], size: [0.25, 0.4], gravity: -0.6, drag: 0.8, turbulence: 0.5,
        shape: { kind: 'cone', radius: 0.08, angle: 12 }, startColor: ['#ffffff', '#f0f0f0'],
        colorOverLife: fade('#ffffff', 0.35), sizeOverLife: { points: [[0, 0.5], [1, 3.5]] },
        render: { sprite: 'smoke' },
    }),
    leaves: effect({
        rate: 4, lifetime: [5, 8], speed: [0.3, 0.6], size: [0.1, 0.16], gravity: 0.6, drag: 0.6, turbulence: 0.8, turbulenceScale: 2.5, spin: [-180, 180],
        shape: { kind: 'box', size: [6, 0.5, 6], randomDirection: 1 }, startColor: ['#c88a2a', '#8a5a1a'],
        colorOverLife: fade('#ffffff', 1), sizeOverLife: { points: [[0, 1], [1, 1]] },
        collision: { mode: 'world', bounce: 0, friction: 1 },
        render: { sprite: 'leaf', sort: false },
    }),
    confetti: effect({
        rate: 0, loop: false, duration: 4, bursts: [{ time: 0, count: 150 }], lifetime: [2.5, 4], speed: [5, 9], size: [0.05, 0.08], spin: [-720, 720],
        shape: { kind: 'point', angle: 30 }, gravity: 4, drag: 1.6, turbulence: 1, startColor: ['#ff4060', '#40c0ff'],
        colorOverLife: fade('#ffffff', 1), sizeOverLife: { points: [[0, 1], [1, 1]] },
        render: { sprite: 'square', sort: false },
    }),
    fireflies: effect({
        rate: 3, lifetime: [4, 7], speed: [0.1, 0.3], size: [0.04, 0.06], gravity: 0, drag: 0.5, turbulence: 0.6, turbulenceScale: 1.5,
        shape: { kind: 'box', size: [6, 2, 6], randomDirection: 1 }, startColor: ['#d8ff70', '#a8ff50'],
        colorOverLife: { stops: [{ t: 0, color: '#d8ff70', alpha: 0 }, { t: 0.3, color: '#d8ff70', alpha: 1 }, { t: 0.5, color: '#d8ff70', alpha: 0.2 }, { t: 0.7, color: '#d8ff70', alpha: 1 }, { t: 1, color: '#d8ff70', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 1]] },
        render: { sprite: 'glow', blending: 'additive', emissive: 6, sort: false },
    }),
    waterfall: effect({
        rate: 220, lifetime: [1.2, 1.8], speed: [2, 3], size: [0.3, 0.5], gravity: 9.8, drag: 0.4, turbulence: 0.6, maxParticles: 1500,
        shape: { kind: 'edge', size: [3, 0, 0], angle: 8 }, startColor: ['#e8f4ff', '#d0e4f4'],
        colorOverLife: fade('#f0f8ff', 0.45), sizeOverLife: { points: [[0, 0.5], [1, 2.5]] },
        render: { sprite: 'smoke' },
    }),
    muzzleFlash: effect({
        rate: 0, loop: false, duration: 0.2, bursts: [{ time: 0, count: 6 }], lifetime: [0.04, 0.08], speed: [0.5, 2], size: [0.15, 0.3],
        shape: { kind: 'point', angle: 8 }, gravity: 0, drag: 0, turbulence: 0, startColor: ['#fff0b0', '#ffc060'],
        colorOverLife: { stops: [{ t: 0, color: '#fff8d0', alpha: 1 }, { t: 1, color: '#ff8020', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 1.4]] },
        render: { mode: 'stretched', sprite: 'flame', blending: 'additive', emissive: 6, stretch: 0.3, sort: false },
        light: { enabled: true, color: '#ffc070', intensity: 300, range: 8, flicker: 0 },
    }),
    shockwave: effect({
        rate: 0, loop: false, duration: 1, bursts: [{ time: 0, count: 1 }], lifetime: [0.6, 0.6], speed: [0, 0], size: [0.5, 0.5],
        shape: { kind: 'point', angle: 0 }, gravity: 0, drag: 0, turbulence: 0, rotation: [0, 0], spin: [0, 0], startColor: ['#ffffff', '#ffffff'],
        colorOverLife: { stops: [{ t: 0, color: '#d8ecff', alpha: 0.9 }, { t: 1, color: '#d8ecff', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 18]] },
        render: { mode: 'horizontal', sprite: 'ring', blending: 'additive', emissive: 2, sort: false },
    }),
    trail: effect({
        rate: 0, rateOverDistance: 6, lifetime: [0.6, 0.6], speed: [0, 0], size: [0.25, 0.25], gravity: 0, drag: 0, turbulence: 0,
        shape: { kind: 'point', angle: 0 }, startColor: ['#80d0ff', '#80d0ff'],
        colorOverLife: { stops: [{ t: 0, color: '#c0ecff', alpha: 0.9 }, { t: 1, color: '#4080ff', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 0.1]] },
        render: { mode: 'ribbon', sprite: 'soft', blending: 'additive', emissive: 3, sort: false },
    }),
    debris: effect({
        rate: 0, loop: false, duration: 3, bursts: [{ time: 0, count: 30 }], lifetime: [1.5, 2.5], speed: [3, 7], size: [0.08, 0.18], spin: [-540, 540],
        shape: { kind: 'sphere', radius: 0.3, volume: 1 }, gravity: 9.8, drag: 0.2, turbulence: 0, startColor: ['#6a5a4a', '#4a4038'],
        colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 1 }, { t: 0.85, color: '#ffffff', alpha: 1 }, { t: 1, color: '#ffffff', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 1]] },
        collision: { mode: 'world', bounce: 0.35, friction: 0.5 },
        render: { sprite: 'debris', sort: false },
    }),
    // Effects too big for the CPU, simulated on the GPU.
    fountain: effect({
        simulation: 'gpu', rate: 40000, maxParticles: 150000, lifetime: [2.5, 3.5], speed: [9, 11], size: [0.03, 0.05], rotation: [0, 0], spin: [0, 0],
        shape: { kind: 'cone', radius: 0.15, angle: 8, volume: 1 }, gravity: 9.8, drag: 0.15, turbulence: 0.3, turbulenceScale: 2,
        startColor: ['#bfe6ff', '#ffffff'], colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0.9 }, { t: 0.8, color: '#a8d8ff', alpha: 0.7 }, { t: 1, color: '#80c0ff', alpha: 0 }] },
        sizeOverLife: { points: [[0, 1], [1, 0.6]] },
        collision: { mode: 'world', bounce: 0.3, friction: 0.2 },
        render: { sprite: 'glow', blending: 'additive', emissive: 2, sort: false },
    }),
    swarm: effect({
        simulation: 'gpu', rate: 50000, maxParticles: 250000, lifetime: [3, 5], speed: [0.5, 1.5], size: [0.03, 0.06], rotation: [0, 0], spin: [0, 0],
        shape: { kind: 'sphere', radius: 3, volume: 1 }, gravity: 0, drag: 0.4, turbulence: 6, turbulenceScale: 1.5, orbit: 0.8,
        startColor: ['#7fd6ff', '#d08cff'], colorOverLife: fade('#c8ecff', 1, '#a060ff'), sizeOverLife: { points: [[0, 0.3], [0.2, 1], [1, 0]] },
        render: { sprite: 'glow', blending: 'additive', emissive: 3, sort: false },
    }),
    downpour: effect({
        simulation: 'gpu', rate: 120000, maxParticles: 140000, lifetime: [0.9, 1.1], speed: [11, 13], size: [0.015, 0.025], gravity: 0, drag: 0, turbulence: 0,
        shape: { kind: 'box', size: [60, 0.1, 60], angle: 2, axis: [0, -1, 0] }, startColor: ['#c0d4e8', '#a8c0d8'],
        colorOverLife: { stops: [{ t: 0, color: '#c8dcf0', alpha: 0.45 }, { t: 1, color: '#c8dcf0', alpha: 0.45 }] },
        sizeOverLife: { points: [[0, 1], [1, 1]] },
        collision: { mode: 'world', kill: true },
        render: { mode: 'stretched', sprite: 'droplet', stretch: 3, sort: false },
    }),
} satisfies Record<string, ParticleEffect>;

export type ParticlePresetId = keyof typeof PARTICLE_PRESETS;
export const PARTICLE_PRESET_IDS = Object.keys(PARTICLE_PRESETS) as ParticlePresetId[];

export const PARTICLE_PRESET_LABELS: Record<ParticlePresetId, string> = {
    smoke: 'Smoke', fire: 'Fire', sparks: 'Sparks', dust: 'Dust motes', explosion: 'Explosion', embers: 'Embers', magic: 'Magic',
    rain: 'Rain', snow: 'Snow', steam: 'Steam', leaves: 'Falling leaves', confetti: 'Confetti', fireflies: 'Fireflies',
    waterfall: 'Waterfall mist', muzzleFlash: 'Muzzle flash', shockwave: 'Shockwave', trail: 'Trail', debris: 'Debris',
    fountain: 'Fountain (GPU)', swarm: 'Swarm (GPU)', downpour: 'Downpour (GPU)',
};

const isPreset = (value: unknown): value is ParticlePresetId =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(PARTICLE_PRESETS, value);

/**
 * A component's effect from its stored props. An `effect` object (written by the Particles
 * inspector) wins; otherwise the effect of its `preset`, with what the older plain fields say:
 * Rate, Burst and Loop always, and for the Custom preset its lifetime, speed, spread, size,
 * colours and gravity.
 */
export const resolveParticleEffect = (props: Record<string, unknown>): ParticleEffect => {
    const base = isPreset(props.preset) ? PARTICLE_PRESETS[props.preset] : DEFAULT_PARTICLE_EFFECT;
    if (props.effect && typeof props.effect === 'object') return sanitizeParticleEffect(props.effect, base);
    const legacy: Partial<ParticleEffect> = {};
    if (typeof props.rate === 'number') legacy.rate = props.rate;
    if (typeof props.loop === 'boolean') legacy.loop = props.loop;
    if (typeof props.burst === 'number') legacy.bursts = props.burst > 0 ? [{ time: 0, count: props.burst }] : [];
    if (props.preset === 'custom') {
        const lifetime = typeof props.lifetime === 'number' ? props.lifetime : 3;
        const speed = typeof props.speed === 'number' ? props.speed : 0.8;
        const size = typeof props.size === 'number' ? props.size : 0.6;
        Object.assign(legacy, {
            duration: lifetime,
            lifetime: [lifetime * 0.8, lifetime * 1.2],
            speed: [speed * 0.8, speed * 1.2],
            size: [size * 0.85, size * 1.15],
            gravity: typeof props.gravity === 'number' ? props.gravity : -0.3,
            shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point', angle: typeof props.spread === 'number' ? props.spread : 20 },
            colorOverLife: {
                stops: [
                    { t: 0, color: color(props.colorStart, '#a0a0a0'), alpha: 0 },
                    { t: 0.08, color: color(props.colorStart, '#a0a0a0'), alpha: 0.9 },
                    { t: 0.6, color: color(props.colorEnd, '#4a4a4a'), alpha: 0.7 },
                    { t: 1, color: color(props.colorEnd, '#4a4a4a'), alpha: 0 },
                ],
            },
            startColor: ['#ffffff', '#ffffff'],
            sizeOverLife: { points: [[0, 1], [1, 1]] },
            render: { ...DEFAULT_PARTICLE_EFFECT.render, sprite: 'soft' },
        });
    }
    return sanitizeParticleEffect({ ...base, ...legacy }, base);
};

/** Particles alive at once, at most, for an effect (before its cap). */
export const estimateParticles = (effect: ParticleEffect): number => {
    const longest = effect.lifetime[1];
    const burst = effect.bursts.reduce((sum, entry) => sum + entry.count, 0);
    const cycles = effect.loop ? Math.ceil(longest / Math.max(0.05, effect.duration)) + 1 : 1;
    return effect.rate * longest + burst * cycles + effect.rateOverDistance * 40 * longest;
};
