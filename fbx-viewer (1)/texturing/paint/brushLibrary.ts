import * as THREE from 'three';
import type { BrushSettings } from './strokes';
import { PARTICLE_PRESETS, readParticles, type ParticleSettings } from './particles';
import { readGraphStamp } from './graphStamps';

/**
 * THE BRUSH AND ALPHA LIBRARY
 *
 * Brushes are kept as presets of how a brush feels (size, softness, flow, spacing, jitter, pressure,
 * its shape or alpha, how it lays paint on), never what it paints or where: values, channels, symmetry
 * and the stencil stay as they are when a preset is picked. Built-in presets come first; presets saved
 * by name are kept in this browser. Alphas are the brush's shape: the round and square ones, built-in
 * pictures made here, or any picture in the project.
 */

/** The settings a preset carries. */
export const PRESET_KEYS = [
    'size', 'hardness', 'flow', 'opacity', 'spacing', 'angle', 'followStroke', 'angleJitter', 'sizeJitter', 'scatter', 'flowJitter',
    'pressureSize', 'pressureFlow', 'pressureCurve', 'tiltAngle', 'lazy', 'shape', 'alphaTexture', 'mode', 'buildUp', 'particles', 'graphStamp',
] as const satisfies ReadonlyArray<keyof BrushSettings>;

export type PresetKey = typeof PRESET_KEYS[number];
export type PresetSettings = Partial<Pick<BrushSettings, PresetKey>>;

export interface BrushPreset { id: string; name: string; settings: PresetSettings; builtIn?: boolean }

/** Built-in alphas: pictures made here, named by id. */
export const BUILT_IN_ALPHAS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'builtin:grain', name: 'Grain' },
    { id: 'builtin:splatter', name: 'Splatter' },
    { id: 'builtin:scratches', name: 'Scratches' },
    { id: 'builtin:bristles', name: 'Bristles' },
    { id: 'builtin:ring', name: 'Ring' },
    { id: 'builtin:star', name: 'Star' },
];

export const isBuiltInAlpha = (id: string): boolean => BUILT_IN_ALPHAS.some((alpha) => alpha.id === id);

const LINEAR: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];

/** Pressure curves to pick from: how pen pressure turns into size or flow (a curve from 0,0 to 1,1). */
export const PRESSURE_CURVES: ReadonlyArray<{ id: string; name: string; curve: [number, number, number, number] }> = [
    { id: 'linear', name: 'Even', curve: LINEAR },
    { id: 'soft', name: 'Soft (a light touch does a lot)', curve: [0.1, 0.45, 0.35, 0.95] },
    { id: 'verySoft', name: 'Very soft', curve: [0, 0.75, 0.15, 1] },
    { id: 'firm', name: 'Firm (press to build up)', curve: [0.55, 0.05, 0.9, 0.6] },
    { id: 'veryFirm', name: 'Very firm', curve: [0.8, 0, 1, 0.3] },
];

export const BUILT_IN_BRUSHES: readonly BrushPreset[] = [
    { id: 'builtin:soft', name: 'Soft round', builtIn: true, settings: { shape: 'round', hardness: 0.15, flow: 0.6, spacing: 0.1, sizeJitter: 0, angleJitter: 0, scatter: 0, flowJitter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:hard', name: 'Hard round', builtIn: true, settings: { shape: 'round', hardness: 0.95, flow: 1, spacing: 0.08, sizeJitter: 0, angleJitter: 0, scatter: 0, flowJitter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:square', name: 'Square', builtIn: true, settings: { shape: 'square', hardness: 0.9, flow: 1, spacing: 0.1, sizeJitter: 0, angleJitter: 0, scatter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:airbrush', name: 'Airbrush', builtIn: true, settings: { shape: 'round', hardness: 0, flow: 0.12, spacing: 0.06, sizeJitter: 0, scatter: 0, mode: 'paint', buildUp: true } },
    { id: 'builtin:ink', name: 'Ink', builtIn: true, settings: { shape: 'round', hardness: 0.9, flow: 1, spacing: 0.05, pressureSize: true, pressureCurve: [0.55, 0.05, 0.9, 0.6], sizeJitter: 0, scatter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:chalk', name: 'Chalk', builtIn: true, settings: { shape: 'picture', alphaTexture: 'builtin:grain', hardness: 0.5, flow: 0.7, spacing: 0.25, sizeJitter: 0.2, angleJitter: 1, scatter: 0.1, mode: 'paint', buildUp: false } },
    { id: 'builtin:spatter', name: 'Spatter', builtIn: true, settings: { shape: 'picture', alphaTexture: 'builtin:splatter', hardness: 0.6, flow: 0.9, spacing: 0.6, sizeJitter: 0.5, angleJitter: 1, scatter: 0.8, flowJitter: 0.5, mode: 'paint', buildUp: false } },
    { id: 'builtin:scratches', name: 'Scratches', builtIn: true, settings: { shape: 'picture', alphaTexture: 'builtin:scratches', hardness: 0.7, flow: 1, spacing: 0.4, followStroke: true, angleJitter: 0.1, sizeJitter: 0.2, scatter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:bristles', name: 'Dry bristles', builtIn: true, settings: { shape: 'picture', alphaTexture: 'builtin:bristles', hardness: 0.6, flow: 0.8, spacing: 0.05, followStroke: true, angleJitter: 0, sizeJitter: 0, scatter: 0, mode: 'paint', buildUp: false } },
    { id: 'builtin:blur', name: 'Blur', builtIn: true, settings: { shape: 'round', hardness: 0.3, flow: 1, spacing: 0.1, mode: 'blur', buildUp: false } },
    { id: 'builtin:sharpen', name: 'Sharpen', builtIn: true, settings: { shape: 'round', hardness: 0.3, flow: 1, spacing: 0.1, mode: 'sharpen', buildUp: false } },
    { id: 'builtin:smudge', name: 'Smudge', builtIn: true, settings: { shape: 'round', hardness: 0.4, flow: 1, spacing: 0.08, mode: 'smudge', buildUp: false } },
    { id: 'builtin:clone', name: 'Clone', builtIn: true, settings: { shape: 'round', hardness: 0.6, flow: 1, spacing: 0.1, mode: 'clone', buildUp: false } },
    // Particle brushes: the dabs throw particles that run, fall or bounce, painting along their paths.
    { id: 'builtin:drips', name: 'Drips', builtIn: true, settings: { shape: 'round', hardness: 0.7, flow: 1, spacing: 0.5, sizeJitter: 0.3, scatter: 0, mode: 'paint', buildUp: false, particles: particlePreset('drips') } },
    { id: 'builtin:leaks', name: 'Leaks', builtIn: true, settings: { shape: 'round', hardness: 0.3, flow: 0.6, spacing: 0.8, sizeJitter: 0.2, scatter: 0.3, mode: 'paint', buildUp: false, particles: particlePreset('leaks') } },
    { id: 'builtin:dust', name: 'Dust', builtIn: true, settings: { shape: 'round', hardness: 0.4, flow: 0.5, spacing: 0.6, sizeJitter: 0.5, scatter: 0.5, mode: 'paint', buildUp: false, particles: particlePreset('dust') } },
    { id: 'builtin:splashes', name: 'Splashes', builtIn: true, settings: { shape: 'picture', alphaTexture: 'builtin:splatter', hardness: 0.6, flow: 1, spacing: 1, sizeJitter: 0.4, angleJitter: 1, scatter: 0, mode: 'paint', buildUp: false, particles: particlePreset('splashes') } },
];

/** The particle settings of a particle preset. */
function particlePreset(id: string): ParticleSettings {
    return structuredClone(PARTICLE_PRESETS.find((preset) => preset.id === id)!.settings);
}

/** A preset of how `brush` feels now, called `name`. */
export const presetFrom = (brush: BrushSettings, name: string, id = `brush:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`): BrushPreset => ({
    id,
    name: name.trim().slice(0, 48) || 'Brush',
    settings: Object.fromEntries(PRESET_KEYS.map((key) => [key, structuredClone(brush[key])])) as PresetSettings,
});

/** The brush with a preset's settings; what it paints, symmetry and the stencil stay. */
export const applyPreset = (brush: BrushSettings, preset: BrushPreset): BrushSettings => {
    const next = { ...brush };
    for (const key of PRESET_KEYS) {
        const value = preset.settings[key];
        if (value !== undefined) (next as Record<string, unknown>)[key] = structuredClone(value);
    }
    // A preset without particles is a plain brush: particles go off.
    if (preset.settings.particles === undefined && next.particles?.enabled) next.particles = { ...next.particles, enabled: false };
    return next;
};

/** What kind each preset setting holds, for reading stored presets. */
const DEFAULT_KINDS: Record<PresetKey, unknown> = {
    size: 0, hardness: 0, flow: 0, opacity: 0, spacing: 0, angle: 0, followStroke: false, angleJitter: 0, sizeJitter: 0, scatter: 0, flowJitter: 0,
    pressureSize: false, pressureFlow: false, pressureCurve: [], tiltAngle: false, lazy: 0, shape: '', alphaTexture: '', mode: '', buildUp: false, particles: {}, graphStamp: {},
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Presets read back from storage, made safe: unknown settings and settings of the wrong kind are left out. */
export const readPresets = (raw: unknown): BrushPreset[] => {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 200).flatMap((item): BrushPreset[] => {
        const preset = item as Partial<BrushPreset> | null;
        if (!preset || typeof preset.id !== 'string' || typeof preset.name !== 'string' || !preset.settings || typeof preset.settings !== 'object') return [];
        const settings: Record<string, unknown> = {};
        for (const key of PRESET_KEYS) {
            const value = (preset.settings as Record<string, unknown>)[key];
            if (value === undefined) continue;
            const kind = typeof DEFAULT_KINDS[key];
            if (key === 'pressureCurve') {
                if (Array.isArray(value) && value.length === 4 && value.every(finite)) settings[key] = value.map((v) => Math.min(1, Math.max(0, v)));
            } else if (key === 'particles') {
                if (value && typeof value === 'object' && !Array.isArray(value)) settings[key] = readParticles(value);
            } else if (key === 'graphStamp') {
                const stamp = readGraphStamp(value);
                if (stamp) settings[key] = stamp;
            } else if (kind === 'number' ? finite(value) : typeof value === kind) settings[key] = value;
        }
        return [{ id: preset.id.slice(0, 64), name: preset.name.slice(0, 48) || 'Brush', settings: settings as PresetSettings }];
    });
};

/** Where saved presets are kept in this browser. */
export const PRESETS_KEY = 'auvra.paint.brushes';

export const loadPresets = (): BrushPreset[] => {
    try {
        return readPresets(JSON.parse(window.localStorage.getItem(PRESETS_KEY) ?? '[]'));
    } catch {
        return [];
    }
};

export const savePresets = (presets: readonly BrushPreset[]): boolean => {
    try {
        window.localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
        return true;
    } catch {
        return false;
    }
};

/** Steady noise in 0..1 for whole-number places. */
const noise = (x: number, y: number, seed: number): number => {
    let h = Math.imul(x * 374761393 + y * 668265263 + seed * 2246822519, 3266489917);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967295;
};

/** Smooth noise: steady noise blended between whole places. */
const smooth = (x: number, y: number, seed: number): number => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = noise(ix, iy, seed), b = noise(ix + 1, iy, seed), c = noise(ix, iy + 1, seed), d = noise(ix + 1, iy + 1, seed);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};

/**
 * A built-in alpha's brightness, `size` × `size` values in 0..1 (rows from the bottom), fading to nothing
 * at its edge; null for an id that is not one.
 */
export const alphaPixels = (id: string, size = 128): Float32Array | null => {
    if (!isBuiltInAlpha(id)) return null;
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size * 2 - 1;
            const v = (y + 0.5) / size * 2 - 1;
            const r = Math.hypot(u, v);
            const fade = Math.min(1, Math.max(0, (1 - r) / 0.25));
            let value = 0;
            switch (id) {
                case 'builtin:grain': {
                    const grain = smooth(x / 3, y / 3, 1) * 0.6 + smooth(x / 9, y / 9, 2) * 0.4;
                    value = Math.min(1, Math.max(0, (grain - 0.35) * 2.2)) * fade;
                    break;
                }
                case 'builtin:splatter': {
                    // Drops of several sizes round a middle blot.
                    let drop = r < 0.42 ? 1 : 0;
                    for (let k = 0; k < 18; k++) {
                        const angle = noise(k, 0, 7) * Math.PI * 2;
                        const reach = 0.35 + noise(k, 1, 7) * 0.55;
                        const radius = 0.03 + noise(k, 2, 7) * 0.09;
                        if (Math.hypot(u - Math.cos(angle) * reach, v - Math.sin(angle) * reach) < radius) drop = 1;
                    }
                    value = drop * (0.75 + 0.25 * smooth(x / 4, y / 4, 3)) * Math.min(1, Math.max(0, (1 - r) / 0.08));
                    break;
                }
                case 'builtin:scratches': {
                    let line = 0;
                    for (let k = 0; k < 9; k++) {
                        const angle = (noise(k, 3, 11) - 0.5) * 0.5;
                        const offset = (noise(k, 4, 11) - 0.5) * 1.4;
                        const distance = Math.abs(-Math.sin(angle) * u + Math.cos(angle) * v - offset);
                        line = Math.max(line, Math.max(0, 1 - distance / (0.01 + noise(k, 5, 11) * 0.025)));
                    }
                    value = line * fade;
                    break;
                }
                case 'builtin:bristles': {
                    const streak = smooth(x / 1.5, y / 40, 13);
                    value = Math.min(1, Math.max(0, (streak - 0.3) * 2)) * fade;
                    break;
                }
                case 'builtin:ring':
                    value = Math.max(0, 1 - Math.abs(r - 0.7) / 0.12);
                    break;
                case 'builtin:star': {
                    const angle = Math.atan2(v, u);
                    const edge = 0.45 + 0.45 * Math.pow(Math.abs(Math.cos(angle * 2.5)), 3);
                    value = Math.min(1, Math.max(0, (edge - r) / 0.04));
                    break;
                }
            }
            out[y * size + x] = value;
        }
    }
    return out;
};

const alphaTextures = new Map<string, THREE.DataTexture>();

/** A built-in alpha as a texture for the brush (made once), or null for an id that is not one. */
export const builtInAlphaTexture = (id: string): THREE.DataTexture | null => {
    let texture = alphaTextures.get(id);
    if (texture) return texture;
    const pixels = alphaPixels(id);
    if (!pixels) return null;
    const size = Math.sqrt(pixels.length);
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i++) {
        const value = Math.round(pixels[i] * 255);
        rgba.set([value, value, value, 255], i * 4);
    }
    texture = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    alphaTextures.set(id, texture);
    return texture;
};
