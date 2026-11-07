import * as THREE from 'three';
import {
    TAU, blueNoiseTile, disorderAt, fbm, hash1, hash3, mix, perlin, ringPlace, saturate, scratchField, simplex4, smoothstep, spotField, step, strandNoise, valueNoise, worley, wrap,
} from '../noiseMath';
import { tileSafeDirection } from '../safeTransform';
import { bool, float, int, out, seed, select } from '../nodeKit';
import type { TexNodeDef } from '../types';

/**
 * NOISES AND GRUNGES
 *
 * Generators of natural-looking randomness: clouds, simplex, blue noise, dirt, spots, crystal, fibres,
 * moisture, liquid, plasma, caustics, noise and scratches running in a direction, and a set of grunge
 * maps. Every one tiles (each lattice wraps where the picture repeats; a node set not to tile, in its
 * size, bit depth and tiling settings, does not), and many have a Disorder setting that pushes the
 * pattern about by smooth noise. Each shader has its CPU twin below (REFERENCES), for the tests.
 */

/** Building blocks the shaders share (their CPU twins are in noiseMath.ts). */
export const NOISE_GLSL = `float fbmNoise(vec2 uv, int scale, int octaves, float roughness, float seed) {
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    int s = scale;
    for (int o = 0; o < 12; o++) {
        if (o >= octaves) break;
        sum += perlin(uv * float(s), tilePeriod(ivec2(s)), seed + float(o) * 13.17) * amplitude;
        total += amplitude;
        amplitude *= roughness;
        s *= 2;
    }
    return sum / max(total, 1e-5);
}
vec2 disorderAt(vec2 uv, float amount) {
    if (amount <= 0.0) return uv;
    ivec2 period = tilePeriod(ivec2(3));
    return uv + vec2(perlin(uv * 3.0, period, uSeed + 91.7), perlin(uv * 3.0 + 0.5, period, uSeed + 37.3)) * amount * 0.15;
}
float strandNoise(vec2 q, ivec2 period, float seed, float sharpness) {
    return pow(valueNoise(q, period, seed), mix(1.0, 6.0, sharpness));
}
float spotField(vec2 p, ivec2 period, float density, float size, float variation, float softness, float seed, bool randomBrightness) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    float value = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            ivec2 cell = wrapCell(i + ivec2(ox, oy), period);
            if (hash1(cell, seed + 2.9) > density) continue;
            vec3 r = hash3(cell, seed);
            vec2 centre = vec2(float(ox), float(oy)) + 0.5 + (r.xy - 0.5) * (1.0 - size);
            float radius = size * 0.5 * mix(1.0, r.z, variation);
            float spot = 1.0 - smoothstep(radius * (1.0 - softness) - 1e-4, radius, length(f - centre));
            value = max(value, spot * (randomBrightness ? hash1(cell, seed + 7.7) : 1.0));
        }
    }
    return value;
}
float scratchField(vec2 q, ivec2 period, float density, float span, float thickness, float variation, float seed) {
    ivec2 i = ivec2(floor(q));
    float value = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -3; ox <= 0; ox++) {
            ivec2 cell = i + ivec2(ox, oy);
            ivec2 wrapped = wrapCell(cell, period);
            if (hash1(wrapped, seed + 5.5) > density) continue;
            vec3 r = hash3(wrapped, seed);
            float start = float(cell.x) + r.x;
            float reach = min(3.0, span) * (0.4 + 0.6 * r.y);
            float t = (q.x - start) / reach;
            if (t < 0.0 || t > 1.0) continue;
            float lineY = float(cell.y) + 0.15 + 0.7 * r.z;
            float width = thickness * 0.5 * (1.0 - abs(t * 2.0 - 1.0));
            float line = 1.0 - smoothstep(width * 0.5, width + 1e-3, abs(q.y - lineY));
            value = max(value, line * mix(1.0, hash1(wrapped, seed + 9.1), variation));
        }
    }
    return value;
}
vec2 alongFrame(vec2 uv, ivec2 direction, int along, int across) {
    vec2 d = vec2(direction);
    return vec2(dot(uv, d) * float(along), dot(uv, vec2(-d.y, d.x)) * float(across));
}`;

/** The CPU twin of alongFrame: a place in the frame of a whole-numbered direction. */
const alongFrame = (u: number, v: number, direction: readonly number[], along: number, across: number): [number, number] =>
    [(u * direction[0] + v * direction[1]) * along, (-u * direction[1] + v * direction[0]) * across];

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const whole = (params: Params, key: string, fallback: number): number => Math.round(num(params, key, fallback));

/** A one-pass generator over the shared building blocks; `uniforms` work out what the shader needs from the settings. */
const generator = (definition: Omit<TexNodeDef, 'run' | 'sizeFrom'> & {
    glsl: string;
    cost?: (params: Params) => number;
    uniforms?: (params: Params) => Record<string, unknown>;
}): TexNodeDef => {
    const { glsl, cost, uniforms, ...rest } = definition;
    return {
        ...rest,
        sizeFrom: 'graph',
        // Settings turned into uniforms here are read on the CPU; the others only in the shader.
        settingsInShader: !uniforms,
        async run(context) {
            const key = rest.outputs[0].key;
            const image = context.image(context.outputKind(key));
            await context.pass(image, `${NOISE_GLSL}\n${glsl}`, { cost: cost?.(context.params) ?? 4, ...(uniforms ? { uniforms: uniforms(context.params) } : {}) });
            return { [key]: image };
        },
    };
};

const disorder = (fallback = 0) => float('disorder', 'Disorder', fallback, 0, 1, { hint: 'Pushes the pattern about by smooth noise, so it looks less regular. It still tiles.' });
const direction = () => float('angle', 'Direction (degrees)', 0, -180, 180, { step: 1, hint: 'Snapped to the nearest direction a repeating picture stays seamless along (the inspector says which).' });

// ---- grunge looks ----

/** The grunge maps, in the order of the look setting. */
export const GRUNGE_LOOKS: ReadonlyArray<{ key: string; label: string; description: string }> = [
    { key: 'splatter', label: 'Splatter', description: 'Dirt flicked on: drops of every size, thicker in patches.' },
    { key: 'rust', label: 'Rust', description: 'Rusty blotches with fine grain inside them.' },
    { key: 'concrete', label: 'Concrete', description: 'Fine cement grain with small pits.' },
    { key: 'leaks', label: 'Leaks', description: 'Streaks running down from patches above.' },
    { key: 'speckles', label: 'Speckles', description: 'Fine dots of every brightness.' },
    { key: 'blotches', label: 'Blotches', description: 'Soft broad patches.' },
    { key: 'peeling', label: 'Peeling', description: 'Hard-edged patches with raised rims, like peeling paint.' },
    { key: 'cracks', label: 'Cracks', description: 'A network of thin wandering cracks.' },
    { key: 'smudges', label: 'Smudges', description: 'Wiped, swirling smears.' },
    { key: 'dust', label: 'Dust', description: 'A fine haze with specks.' },
    { key: 'stains', label: 'Water stains', description: 'Patches ringed with tide lines.' },
    { key: 'spangle', label: 'Spangle', description: 'Crystal patches of different brightness, like galvanised metal.' },
    { key: 'grain', label: 'Grain', description: 'Fine grain over soft variation.' },
    { key: 'scratched', label: 'Scratched', description: 'Fine scratches running two ways.' },
];

const GRUNGE_GLSL = `void main() {
    vec2 uv = disorderAt(vUv, p_disorder);
    int s = p_scale;
    float t = 1.0 - p_amount;
    float base = fbmNoise(uv, s, 6, 0.6, uSeed) * 0.5 + 0.5;
    float v = 0.0;
    if (p_look == 0) {
        float big = spotField(uv * float(s * 4), tilePeriod(ivec2(s * 4)), p_amount, 0.6, 1.0, 0.2, uSeed + 1.0, false);
        float small = spotField(uv * float(s * 12), tilePeriod(ivec2(s * 12)), p_amount, 0.45, 1.0, 0.3, uSeed + 2.0, false);
        v = max(big, small * 0.8) * smoothstep(0.3, 0.6, base);
    } else if (p_look == 1) {
        v = smoothstep(t - 0.1, t + 0.1, base) * (0.6 + 0.4 * (fbmNoise(uv, s * 8, 3, 0.5, uSeed + 2.0) * 0.5 + 0.5));
    } else if (p_look == 2) {
        float grain = fbmNoise(uv, s * 4, 6, 0.65, uSeed) * 0.5 + 0.5;
        float pits = spotField(uv * float(s * 16), tilePeriod(ivec2(s * 16)), p_amount * 0.5, 0.3, 1.0, 0.3, uSeed + 3.0, false);
        v = grain * (1.0 - 0.5 * pits);
    } else if (p_look == 3) {
        float streak = valueNoise(vec2(uv.x * float(s * 16), uv.y * float(s)), tilePeriod(ivec2(s * 16, s)), uSeed + 4.0);
        v = streak * smoothstep(t - 0.15, t + 0.15, base);
    } else if (p_look == 4) {
        v = spotField(uv * float(s * 24), tilePeriod(ivec2(s * 24)), p_amount, 0.5, 1.0, 0.2, uSeed + 5.0, true);
    } else if (p_look == 5) {
        v = smoothstep(t - 0.25, t + 0.25, fbmNoise(uv, s, 3, 0.5, uSeed) * 0.5 + 0.5);
    } else if (p_look == 6) {
        float e = fbmNoise(uv, s * 2, 5, 0.55, uSeed) * 0.5 + 0.5;
        float rim = 1.0 - smoothstep(0.0, 0.03, abs(e - t));
        v = step(t, e) * 0.7 + rim * 0.3;
    } else if (p_look == 7) {
        vec3 w = worley(disorderAt(uv, 0.6) * float(s * 2), tilePeriod(ivec2(s * 2)), 1.0, 0, uSeed + 6.0);
        v = (1.0 - smoothstep(0.0, 0.06, w.y - w.x)) * smoothstep(t - 0.3, t + 0.3, base);
    } else if (p_look == 8) {
        v = 0.5 + (fbmNoise(disorderAt(uv, 1.0), s, 4, 0.4, uSeed + 7.0) * 0.5) * 0.8;
    } else if (p_look == 9) {
        float haze = fbmNoise(uv, s * 16, 3, 0.5, uSeed + 8.0) * 0.5 + 0.5;
        v = haze * 0.4 + spotField(uv * float(s * 32), tilePeriod(ivec2(s * 32)), p_amount * 0.6, 0.3, 1.0, 0.3, uSeed + 9.0, true) * 0.6;
    } else if (p_look == 10) {
        float m = fbmNoise(uv, s, 4, 0.5, uSeed + 10.0) * 0.5 + 0.5;
        float ring = fract(m * 4.0) - 0.5;
        v = exp(-ring * ring / 0.0128) * smoothstep(t - 0.15, t + 0.15, m);
    } else if (p_look == 11) {
        vec3 w = worley(uv * float(s * 2), tilePeriod(ivec2(s * 2)), 1.0, 0, uSeed + 11.0);
        v = (0.4 + 0.6 * w.z) * smoothstep(0.0, 0.04, w.y - w.x);
    } else if (p_look == 12) {
        float fine = valueNoise(uv * float(s * 64), tilePeriod(ivec2(s * 64)), uSeed + 12.0);
        v = 0.5 + (fine - 0.5) * 0.6 + (base - 0.5) * 0.4;
    } else {
        float a = scratchField(uv * vec2(float(s * 4), float(s * 24)), tilePeriod(ivec2(s * 4, s * 24)), p_amount * 0.5, 2.0, 0.12, 0.5, uSeed + 13.0);
        vec2 q = alongFrame(uv, ivec2(1, 1), s * 4, s * 24);
        float b = scratchField(q, tilePeriod(ivec2(s * 4, s * 24)), p_amount * 0.4, 2.0, 0.12, 0.5, uSeed + 14.0);
        v = max(a, b);
    }
    outColor = vec4(saturate((v - 0.5) * p_contrast + 0.5));
}`;

const grungeReference = (u0: number, v0: number, params: Params, seedValue: number): number => {
    const [u, v] = disorderAt(u0, v0, num(params, 'disorder', 0), seedValue);
    const s = whole(params, 'scale', 4);
    const amount = num(params, 'amount', 0.5);
    const t = 1 - amount;
    const look = Math.max(0, GRUNGE_LOOKS.findIndex((item) => item.key === params.look));
    const base = fbm(u, v, s, 6, 0.6, seedValue) * 0.5 + 0.5;
    const spots = (n: number, density: number, size: number, softness: number, salt: number, random = false) => spotField(u * n, v * n, n, n, density, size, 1, softness, seedValue + salt, random);
    let value: number;
    switch (look) {
        case 0: value = Math.max(spots(s * 4, amount, 0.6, 0.2, 1), spots(s * 12, amount, 0.45, 0.3, 2) * 0.8) * smoothstep(0.3, 0.6, base); break;
        case 1: value = smoothstep(t - 0.1, t + 0.1, base) * (0.6 + 0.4 * (fbm(u, v, s * 8, 3, 0.5, seedValue + 2) * 0.5 + 0.5)); break;
        case 2: value = (fbm(u, v, s * 4, 6, 0.65, seedValue) * 0.5 + 0.5) * (1 - 0.5 * spots(s * 16, amount * 0.5, 0.3, 0.3, 3)); break;
        case 3: value = valueNoise(u * s * 16, v * s, s * 16, s, seedValue + 4) * smoothstep(t - 0.15, t + 0.15, base); break;
        case 4: value = spots(s * 24, amount, 0.5, 0.2, 5, true); break;
        case 5: value = smoothstep(t - 0.25, t + 0.25, fbm(u, v, s, 3, 0.5, seedValue) * 0.5 + 0.5); break;
        case 6: {
            const e = fbm(u, v, s * 2, 5, 0.55, seedValue) * 0.5 + 0.5;
            value = step(t, e) * 0.7 + (1 - smoothstep(0, 0.03, Math.abs(e - t))) * 0.3;
            break;
        }
        case 7: {
            const [wu, wv] = disorderAt(u, v, 0.6, seedValue);
            const w = worley(wu * s * 2, wv * s * 2, s * 2, s * 2, 1, 0, seedValue + 6);
            value = (1 - smoothstep(0, 0.06, w[1] - w[0])) * smoothstep(t - 0.3, t + 0.3, base);
            break;
        }
        case 8: {
            const [wu, wv] = disorderAt(u, v, 1, seedValue);
            value = 0.5 + fbm(wu, wv, s, 4, 0.4, seedValue + 7) * 0.5 * 0.8;
            break;
        }
        case 9: value = (fbm(u, v, s * 16, 3, 0.5, seedValue + 8) * 0.5 + 0.5) * 0.4 + spots(s * 32, amount * 0.6, 0.3, 0.3, 9, true) * 0.6; break;
        case 10: {
            const m = fbm(u, v, s, 4, 0.5, seedValue + 10) * 0.5 + 0.5;
            const ring = m * 4 - Math.floor(m * 4) - 0.5;
            value = Math.exp(-ring * ring / 0.0128) * smoothstep(t - 0.15, t + 0.15, m);
            break;
        }
        case 11: {
            const w = worley(u * s * 2, v * s * 2, s * 2, s * 2, 1, 0, seedValue + 11);
            value = (0.4 + 0.6 * w[2]) * smoothstep(0, 0.04, w[1] - w[0]);
            break;
        }
        case 12: value = 0.5 + (valueNoise(u * s * 64, v * s * 64, s * 64, s * 64, seedValue + 12) - 0.5) * 0.6 + (base - 0.5) * 0.4; break;
        default: {
            const a = scratchField(u * s * 4, v * s * 24, s * 4, s * 24, amount * 0.5, 2, 0.12, 0.5, seedValue + 13);
            const [qx, qy] = alongFrame(u, v, [1, 1], s * 4, s * 24);
            value = Math.max(a, scratchField(qx, qy, s * 4, s * 24, amount * 0.4, 2, 0.12, 0.5, seedValue + 14));
        }
    }
    return saturate((value - 0.5) * num(params, 'contrast', 1) + 0.5);
};

// ---- blue noise ----

const blueTiles = new Map<number, THREE.DataTexture>();
const BLUE_SIZE = 64;
/** The blue noise square for a seed, made once and kept. */
const blueTexture = (seedValue: number): THREE.DataTexture => {
    let texture = blueTiles.get(seedValue);
    if (!texture) {
        texture = new THREE.DataTexture(blueNoiseTile(BLUE_SIZE, seedValue), BLUE_SIZE, BLUE_SIZE, THREE.RedFormat, THREE.FloatType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        blueTiles.set(seedValue, texture);
        if (blueTiles.size > 16) { const [oldest, gone] = blueTiles.entries().next().value!; gone.dispose(); blueTiles.delete(oldest); }
    }
    return texture;
};
const blueCache = new Map<number, Float32Array>();
const blueValues = (seedValue: number): Float32Array => {
    let values = blueCache.get(seedValue);
    if (!values) { values = blueNoiseTile(BLUE_SIZE, seedValue); blueCache.set(seedValue, values); }
    return values;
};

// ---- the nodes ----

export const NOISE_NODES: TexNodeDef[] = [
    generator({
        type: 'clouds',
        label: 'Clouds',
        category: 'Noises',
        description: 'Soft billowing clouds: octaves of smooth noise, with how much of the sky they cover and how soft their edges are.',
        keywords: ['clouds', 'sky', 'fog', 'smoke', 'fbm', 'soft noise'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('scale', 'Scale', 4, 1, 64, { softMax: 16 }), int('octaves', 'Detail', 6, 1, 10), float('roughness', 'Roughness', 0.55, 0, 1),
            float('cover', 'Cover', 0.5, 0, 1), float('softness', 'Softness', 0.6, 0, 1), disorder(), seed(),
        ],
        cost: (params) => num(params, 'octaves', 6) * 4,
        glsl: `void main() {
    vec2 uv = disorderAt(vUv, p_disorder);
    float v = fbmNoise(uv, p_scale, p_octaves, p_roughness, uSeed) * 0.5 + 0.5;
    float t = 1.0 - p_cover;
    float s = max(p_softness * 0.5, 0.002);
    outColor = vec4(smoothstep(t - s, t + s, v));
}`,
    }),
    generator({
        type: 'simplexNoise',
        label: 'Simplex noise',
        category: 'Noises',
        description: 'Smooth noise without the grid lines gradient noise can show, in octaves. It tiles by running round a ring each way.',
        keywords: ['simplex', 'smooth noise', 'organic', 'fbm'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 4, 1, 64, { softMax: 16 }), int('octaves', 'Detail', 1, 1, 8), float('roughness', 'Roughness', 0.5, 0, 1), float('contrast', 'Contrast', 1, 0, 4), seed()],
        cost: (params) => num(params, 'octaves', 1) * 12,
        glsl: `const float F4 = 0.309016994374947;
const float G4 = 0.138196601125011;
float simplexGradient(ivec4 c, vec4 d, float seed) {
    uint h = hashU(uvec3(uint(c.x), uint(c.y), hashU(uvec3(uint(c.z), uint(c.w), floatBitsToUint(seed)))));
    int g = int(h & 31u);
    int zero = g >> 3;
    vec3 signs = vec3((g & 1) == 0 ? 1.0 : -1.0, (g & 2) == 0 ? 1.0 : -1.0, (g & 4) == 0 ? 1.0 : -1.0);
    vec4 gradient = zero == 0 ? vec4(0.0, signs) : zero == 1 ? vec4(signs.x, 0.0, signs.yz) : zero == 2 ? vec4(signs.xy, 0.0, signs.z) : vec4(signs, 0.0);
    return dot(gradient, d);
}
float simplex4(vec4 p, float seed) {
    float s = (p.x + p.y + p.z + p.w) * F4;
    vec4 i = floor(p + s);
    float t = (i.x + i.y + i.z + i.w) * G4;
    vec4 x0 = p - (i - t);
    vec4 rank = vec4(0.0);
    if (x0.x > x0.y) rank.x += 1.0; else rank.y += 1.0;
    if (x0.x > x0.z) rank.x += 1.0; else rank.z += 1.0;
    if (x0.x > x0.w) rank.x += 1.0; else rank.w += 1.0;
    if (x0.y > x0.z) rank.y += 1.0; else rank.z += 1.0;
    if (x0.y > x0.w) rank.y += 1.0; else rank.w += 1.0;
    if (x0.z > x0.w) rank.z += 1.0; else rank.w += 1.0;
    ivec4 base = ivec4(i);
    float n = 0.0;
    for (int k = 0; k < 5; k++) {
        vec4 offset = k == 0 ? vec4(0.0) : k == 1 ? step(2.5, rank) : k == 2 ? step(1.5, rank) : k == 3 ? step(0.5, rank) : vec4(1.0);
        vec4 x = x0 - offset + float(k) * G4;
        float weight = 0.6 - dot(x, x);
        if (weight <= 0.0) continue;
        weight *= weight;
        n += weight * weight * simplexGradient(base + ivec4(offset), x, seed);
    }
    return 27.0 * n;
}
void main() {
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    float scale = float(p_scale);
    for (int o = 0; o < 8; o++) {
        if (o >= p_octaves) break;
        // Round a ring each way the picture repeats (its edges meet), else straight on.
        float r = scale / TAU;
        vec2 across = uTiles.x == 1 ? vec2(cos(TAU * vUv.x), sin(TAU * vUv.x)) * r : vec2(vUv.x * scale, 0.0);
        vec2 down = uTiles.y == 1 ? vec2(cos(TAU * vUv.y), sin(TAU * vUv.y)) * r : vec2(vUv.y * scale, 0.0);
        sum += simplex4(vec4(across, down), uSeed + float(o) * 7.77) * amplitude;
        total += amplitude;
        amplitude *= p_roughness;
        scale *= 2.0;
    }
    outColor = vec4(saturate(0.5 + 0.5 * sum / max(total, 1e-5) * p_contrast));
}`,
    }),
    {
        type: 'blueNoise',
        label: 'Blue noise',
        category: 'Noises',
        description: 'Random values spread evenly, with no clumps or gaps: for dithering, and for scattering that looks natural. Scale is how many 64-pixel squares of it fit across.',
        keywords: ['blue noise', 'dither', 'even random', 'void and cluster'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 16, 1, 128), seed()],
        sizeFrom: 'graph',
        async run(context) {
            const image = context.image('gray');
            await context.pass(image, 'uniform sampler2D tile;\nvoid main() { outColor = vec4(texture(tile, fract(vUv * float(p_scale))).r); }', { inputs: { tile: blueTexture(context.seed) } });
            return { out: image };
        },
    },
    generator({
        type: 'dirt',
        label: 'Dirt',
        category: 'Noises',
        description: 'Grime gathered in patches, with specks scattered about.',
        keywords: ['dirt', 'grime', 'grunge', 'specks', 'soil'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('scale', 'Scale', 4, 1, 32), float('amount', 'Amount', 0.5, 0, 1), float('specks', 'Specks', 0.4, 0, 1), float('speckSize', 'Speck size', 0.25, 0.02, 0.5),
            disorder(0.2), seed(),
        ],
        cost: () => 50,
        glsl: `void main() {
    vec2 uv = disorderAt(vUv, p_disorder);
    float blotch = fbmNoise(uv, p_scale, 6, 0.6, uSeed) * 0.5 + 0.5;
    float t = 1.0 - p_amount;
    float dirt = smoothstep(t - 0.15, t + 0.15, blotch);
    int n = p_scale * 8;
    vec3 w = worley(uv * float(n), tilePeriod(ivec2(n)), 1.0, 0, uSeed + 5.3);
    float speck = (1.0 - smoothstep(p_speckSize * 0.5, p_speckSize, w.x)) * step(1.0 - p_specks, w.z);
    outColor = vec4(saturate(max(dirt, speck)));
}`,
    }),
    generator({
        type: 'spots',
        label: 'Spots',
        category: 'Noises',
        description: 'Round spots scattered about, of sizes you choose, solid or soft.',
        keywords: ['spots', 'dots', 'polka', 'drops', 'circles', 'scatter'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('scale', 'Scale', 8, 1, 128, { softMax: 32 }), float('density', 'How many', 0.7, 0, 1), float('size', 'Size', 0.6, 0.05, 1), float('variation', 'Size variety', 0.5, 0, 1),
            float('softness', 'Softness', 0.3, 0, 1), bool('bright', 'Random brightness', false), seed(),
        ],
        cost: () => 12,
        glsl: `void main() {
    float v = spotField(vUv * float(p_scale), tilePeriod(ivec2(p_scale)), p_density, p_size, p_variation, p_softness, uSeed, p_bright == 1);
    outColor = vec4(v);
}`,
    }),
    generator({
        type: 'crystal',
        label: 'Crystal',
        category: 'Noises',
        description: 'Flat facets meeting at sharp edges, each tilted its own way, like broken crystal or stone.',
        keywords: ['crystal', 'facets', 'shards', 'gem', 'voronoi', 'faceted'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 6, 1, 64, { softMax: 24 }), float('jitter', 'Randomness', 1, 0, 1), float('facets', 'Facet tilt', 0.8, 0, 2), float('edges', 'Edge darkening', 0.3, 0, 1), seed()],
        cost: () => 25,
        glsl: `void main() {
    vec2 p = vUv * float(p_scale);
    ivec2 period = tilePeriod(ivec2(p_scale));
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    vec2 nearest = vec2(0.0);
    ivec2 nearestCell = ivec2(0);
    for (int oy = -2; oy <= 2; oy++) {
        for (int ox = -2; ox <= 2; ox++) {
            ivec2 cell = wrapCell(i + ivec2(ox, oy), period);
            vec2 point = vec2(float(ox), float(oy)) + 0.5 + (hash2(cell, uSeed) - 0.5) * p_jitter;
            float d = length(point - f);
            if (d < d1) { d2 = d1; d1 = d; nearest = point; nearestCell = cell; }
            else if (d < d2) { d2 = d; }
        }
    }
    vec3 r = hash3(nearestCell, uSeed + 4.1);
    float a = r.x * TAU;
    float facet = r.z + dot(f - nearest, vec2(cos(a), sin(a))) * p_facets;
    float edge = smoothstep(0.0, max(p_edges * 0.3, 1e-3), d2 - d1);
    outColor = vec4(saturate(facet * mix(1.0, edge, p_edges)));
}`,
    }),
    generator({
        type: 'fibres',
        label: 'Fibres',
        category: 'Noises',
        description: 'Thin strands running one way, wavy and overlapping: paper, cloth, wood fibre, hair.',
        keywords: ['fibres', 'fibers', 'strands', 'hair', 'paper', 'cloth', 'fur'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('across', 'Strands across', 96, 4, 512), int('along', 'Breaks along', 3, 1, 32), float('waviness', 'Waviness', 0.3, 0, 1), float('thickness', 'Fineness', 0.5, 0, 1),
            int('layers', 'Layers', 3, 1, 4), select('direction', 'Running', 'down', [['down', 'Down'], ['across', 'Across']]), disorder(), seed(),
        ],
        cost: (params) => num(params, 'layers', 3) * 4,
        glsl: `void main() {
    vec2 uv = disorderAt(vUv, p_disorder);
    vec2 st = p_direction == 0 ? uv : uv.yx;
    float wave = perlin(st * 2.0, tilePeriod(ivec2(2)), uSeed + 3.3);
    float sum = 0.0;
    for (int l = 0; l < 4; l++) {
        if (l >= p_layers) break;
        int across = p_across * (l + 1);
        vec2 q = vec2(st.x * float(across) + wave * p_waviness * float(across) * 0.05, st.y * float(p_along));
        sum += strandNoise(q, tilePeriod(ivec2(across, p_along)), uSeed + float(l) * 11.3, p_thickness);
    }
    outColor = vec4(saturate(sum / float(p_layers) * 1.5));
}`,
    }),
    generator({
        type: 'moisture',
        label: 'Moisture',
        category: 'Noises',
        description: 'Damp patches with tide lines round their edges, where water has dried.',
        keywords: ['moisture', 'wet', 'damp', 'water', 'tide lines', 'stains'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 3, 1, 32), float('amount', 'Amount', 0.5, 0, 1), float('rim', 'Tide lines', 0.6, 0, 1), float('rimWidth', 'Tide line width', 0.05, 0.005, 0.3), disorder(0.3), seed()],
        cost: () => 20,
        glsl: `void main() {
    vec2 uv = disorderAt(vUv, p_disorder);
    float m = fbmNoise(uv, p_scale, 5, 0.55, uSeed) * 0.5 + 0.5;
    float t = 1.0 - p_amount;
    float body = smoothstep(t - 0.02, t + 0.02, m);
    float d = (m - t) / max(p_rimWidth, 1e-3);
    float rim = exp(-d * d);
    outColor = vec4(saturate(body * 0.6 + rim * p_rim));
}`,
    }),
    generator({
        type: 'liquid',
        label: 'Liquid',
        category: 'Noises',
        description: 'Swirling flows, like marble, oil on water or stirred paint: noise pushed about by noise, twice over.',
        keywords: ['liquid', 'marble', 'swirl', 'flow', 'domain warp', 'oil', 'paint'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 3, 1, 32), float('warp', 'Swirl', 0.4, 0, 2), int('octaves', 'Detail', 4, 1, 8), float('contrast', 'Contrast', 1, 0, 4), seed()],
        cost: (params) => num(params, 'octaves', 4) * 20,
        glsl: `void main() {
    vec2 q = vec2(fbmNoise(vUv, p_scale, p_octaves, 0.5, uSeed), fbmNoise(vUv, p_scale, p_octaves, 0.5, uSeed + 5.2));
    vec2 at = vUv + q * p_warp;
    vec2 r = vec2(fbmNoise(at, p_scale, p_octaves, 0.5, uSeed + 1.7), fbmNoise(at, p_scale, p_octaves, 0.5, uSeed + 9.2));
    float v = fbmNoise(vUv + r * p_warp, p_scale, p_octaves, 0.5, uSeed + 3.1);
    outColor = vec4(saturate(0.5 + 0.5 * v * p_contrast));
}`,
    }),
    generator({
        type: 'plasma',
        label: 'Plasma',
        category: 'Noises',
        description: 'Smooth rolling bands from waves crossing one another and bending each other.',
        keywords: ['plasma', 'waves', 'interference', 'psychedelic', 'bands'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 3, 1, 16), int('waves', 'Waves', 4, 1, 8), float('warp', 'Bend', 1, 0, 4), seed()],
        cost: (params) => num(params, 'waves', 4),
        glsl: `void main() {
    float sum = 0.0;
    float range = float(2 * p_scale + 1);
    for (int k = 0; k < 8; k++) {
        if (k >= p_waves) break;
        vec3 r = hash3(ivec2(k, 7), uSeed);
        vec3 q = hash3(ivec2(k, 13), uSeed);
        // Whole numbers of waves across and down, so it repeats with the picture.
        vec2 frequency = vec2(floor(r.x * range) - float(p_scale), floor(r.y * float(p_scale)) + 1.0);
        vec2 bend = vec2(floor(q.x * range) - float(p_scale), floor(q.y * range) - float(p_scale));
        sum += sin(TAU * dot(frequency, vUv) + r.z * TAU + p_warp * sin(TAU * dot(bend, vUv) + q.z * TAU));
    }
    outColor = vec4(0.5 + 0.5 * sum / float(p_waves));
}`,
    }),
    generator({
        type: 'caustics',
        label: 'Caustics',
        category: 'Noises',
        description: 'The bright wavering net of light under rippling water.',
        keywords: ['caustics', 'water light', 'pool', 'underwater', 'ripples'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 5, 1, 32), float('sharpness', 'Sharpness', 3, 1, 8), float('warp', 'Waver', 0.3, 0, 1), int('layers', 'Layers', 2, 1, 2), float('brightness', 'Brightness', 1, 0, 2), seed()],
        cost: (params) => num(params, 'layers', 2) * 25,
        glsl: `float causticLayer(vec2 uv, int scale, float seed) {
    vec3 w = worley(uv * float(scale), tilePeriod(ivec2(scale)), 1.0, 0, seed);
    return pow(saturate(1.0 - (w.y - w.x) * 2.0), p_sharpness);
}
void main() {
    vec2 uv = disorderAt(vUv, p_warp);
    float v = causticLayer(uv, p_scale, uSeed);
    if (p_layers > 1) v = v * 0.6 + causticLayer(uv + 0.37, p_scale * 2, uSeed + 3.0) * 0.4;
    outColor = vec4(saturate(v * p_brightness));
}`,
    }),
    generator({
        type: 'directionalNoise',
        label: 'Directional noise',
        category: 'Noises',
        description: 'Noise stretched along a direction of your choice: grain, brushing and streaks at an angle, still seamless.',
        keywords: ['directional', 'anisotropic', 'angle', 'brushed', 'grain', 'streaks'],
        inputs: [],
        outputs: [out('gray')],
        params: [direction(), int('along', 'Breaks along', 4, 1, 128), int('across', 'Lines across', 64, 1, 512), int('octaves', 'Detail', 3, 1, 8), float('sharpness', 'Sharpness', 0, 0, 1), seed()],
        cost: (params) => num(params, 'octaves', 3) * 4,
        uniforms: (params) => ({ uDir: tileSafeDirection(num(params, 'angle', 0)).step }),
        glsl: `uniform ivec2 uDir;
void main() {
    float sum = 0.0;
    float total = 0.0;
    float amplitude = 1.0;
    int along = p_along;
    int across = p_across;
    for (int o = 0; o < 8; o++) {
        if (o >= p_octaves) break;
        vec2 q = alongFrame(vUv, uDir, along, across);
        sum += strandNoise(q, tilePeriod(ivec2(along, across)), uSeed + float(o) * 7.31, p_sharpness) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        along *= 2;
        across *= 2;
    }
    outColor = vec4(sum / total);
}`,
    }),
    generator({
        type: 'directionalScratches',
        label: 'Directional scratches',
        category: 'Noises',
        description: 'Fine scratches running one way, of random lengths and brightness, tapering at both ends.',
        keywords: ['scratches', 'directional', 'brushed', 'wear', 'lines', 'scuffs'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            direction(), float('density', 'How many', 0.4, 0, 1), float('length', 'Length', 2, 0.3, 3), float('thickness', 'Thickness', 0.15, 0.01, 0.6),
            int('along', 'Cells along', 8, 1, 64), int('across', 'Cells across', 48, 1, 256), float('variation', 'Brightness variety', 0.5, 0, 1), seed(),
        ],
        cost: () => 12,
        uniforms: (params) => ({ uDir: tileSafeDirection(num(params, 'angle', 0)).step }),
        glsl: `uniform ivec2 uDir;
void main() {
    vec2 q = alongFrame(vUv, uDir, p_along, p_across);
    outColor = vec4(scratchField(q, tilePeriod(ivec2(p_along, p_across)), p_density, p_length, p_thickness, p_variation, uSeed));
}`,
    }),
    {
        ...generator({
            type: 'grunge',
            label: 'Grunge',
            category: 'Noises',
            description: 'A set of grunge maps for wear and dirt: splatter, rust, concrete, leaks, speckles, blotches, peeling, cracks, smudges, dust, water stains, spangle, grain and scratches.',
            keywords: ['grunge', 'dirt', 'wear', 'rust', 'stains', 'grime', 'weathering'],
            inputs: [],
            outputs: [out('gray')],
            params: [
                select('look', 'Look', 'splatter', GRUNGE_LOOKS.map((look) => [look.key, look.label] as [string, string])),
                int('scale', 'Scale', 4, 1, 32), float('amount', 'Amount', 0.5, 0, 1), float('contrast', 'Contrast', 1, 0, 4), disorder(0.2), seed(),
            ],
            cost: () => 60,
            glsl: GRUNGE_GLSL,
        }),
        variants: GRUNGE_LOOKS.map((look) => ({ key: look.key, label: `Grunge: ${look.label.toLowerCase()}`, description: look.description, params: { look: look.key } })),
    },
];

/**
 * The CPU twins of the shaders, a place (0 to 1 across and down) to a value, for the nodes' settings
 * (their defaults filled in) and the shader seed. They tile where the shaders do.
 */
export const NOISE_REFERENCES: Record<string, (u: number, v: number, params: Params, seed: number) => number> = {
    clouds: (u0, v0, params, s) => {
        const [u, v] = disorderAt(u0, v0, num(params, 'disorder', 0), s);
        const value = fbm(u, v, whole(params, 'scale', 4), whole(params, 'octaves', 6), num(params, 'roughness', 0.55), s) * 0.5 + 0.5;
        const t = 1 - num(params, 'cover', 0.5);
        const soft = Math.max(num(params, 'softness', 0.6) * 0.5, 0.002);
        return smoothstep(t - soft, t + soft, value);
    },
    simplexNoise: (u, v, params, s) => {
        let sum = 0;
        let amplitude = 1;
        let total = 0;
        let scale = whole(params, 'scale', 4);
        for (let o = 0; o < whole(params, 'octaves', 1); o++) {
            sum += simplex4(ringPlace(u, v, scale, [true, true]), Math.fround(s + o * 7.77)) * amplitude;
            total += amplitude;
            amplitude *= num(params, 'roughness', 0.5);
            scale *= 2;
        }
        return saturate(0.5 + 0.5 * sum / Math.max(total, 1e-5) * num(params, 'contrast', 1));
    },
    blueNoise: (u, v, params, s) => {
        const tile = blueValues(s);
        const scale = whole(params, 'scale', 16);
        const x = Math.floor((u * scale - Math.floor(u * scale)) * BLUE_SIZE) % BLUE_SIZE;
        const y = Math.floor((v * scale - Math.floor(v * scale)) * BLUE_SIZE) % BLUE_SIZE;
        return tile[y * BLUE_SIZE + x];
    },
    dirt: (u0, v0, params, s) => {
        const [u, v] = disorderAt(u0, v0, num(params, 'disorder', 0.2), s);
        const scale = whole(params, 'scale', 4);
        const t = 1 - num(params, 'amount', 0.5);
        const dirt = smoothstep(t - 0.15, t + 0.15, fbm(u, v, scale, 6, 0.6, s) * 0.5 + 0.5);
        const n = scale * 8;
        const w = worley(u * n, v * n, n, n, 1, 0, Math.fround(s + 5.3));
        const size = num(params, 'speckSize', 0.25);
        const speck = (1 - smoothstep(size * 0.5, size, w[0])) * step(1 - num(params, 'specks', 0.4), w[2]);
        return saturate(Math.max(dirt, speck));
    },
    spots: (u, v, params, s) => {
        const scale = whole(params, 'scale', 8);
        return spotField(u * scale, v * scale, scale, scale, num(params, 'density', 0.7), num(params, 'size', 0.6), num(params, 'variation', 0.5), num(params, 'softness', 0.3), s, Boolean(params.bright));
    },
    crystal: (u, v, params, s) => {
        const scale = whole(params, 'scale', 6);
        const x = u * scale;
        const y = v * scale;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        let d1 = 8;
        let d2 = 8;
        let nearest = [0, 0];
        let cell = [0, 0];
        const jitter = num(params, 'jitter', 1);
        for (let oy = -2; oy <= 2; oy++) {
            for (let ox = -2; ox <= 2; ox++) {
                const cx = wrap(ix + ox, scale);
                const cy = wrap(iy + oy, scale);
                const h = [hash1(cx, cy, s), hash1(cx, cy, Math.fround(s + 17.137))];
                const px = ox + 0.5 + (h[0] - 0.5) * jitter;
                const py = oy + 0.5 + (h[1] - 0.5) * jitter;
                const d = Math.hypot(px - fx, py - fy);
                if (d < d1) { d2 = d1; d1 = d; nearest = [px, py]; cell = [cx, cy]; } else if (d < d2) d2 = d;
            }
        }
        const r = hash3(cell[0], cell[1], s + 4.1);
        const a = r[0] * TAU;
        const facet = r[2] + ((fx - nearest[0]) * Math.cos(a) + (fy - nearest[1]) * Math.sin(a)) * num(params, 'facets', 0.8);
        const edges = num(params, 'edges', 0.3);
        const edge = smoothstep(0, Math.max(edges * 0.3, 1e-3), d2 - d1);
        return saturate(facet * mix(1, edge, edges));
    },
    fibres: (u0, v0, params, s) => {
        const [u, v] = disorderAt(u0, v0, num(params, 'disorder', 0), s);
        const [x, y] = params.direction === 'across' ? [v, u] : [u, v];
        const wave = perlin(x * 2, y * 2, 2, 2, Math.fround(s + 3.3));
        const layers = whole(params, 'layers', 3);
        const along = whole(params, 'along', 3);
        let sum = 0;
        for (let l = 0; l < layers; l++) {
            const across = whole(params, 'across', 96) * (l + 1);
            sum += strandNoise(x * across + wave * num(params, 'waviness', 0.3) * across * 0.05, y * along, across, along, Math.fround(s + l * 11.3), num(params, 'thickness', 0.5));
        }
        return saturate(sum / layers * 1.5);
    },
    moisture: (u0, v0, params, s) => {
        const [u, v] = disorderAt(u0, v0, num(params, 'disorder', 0.3), s);
        const m = fbm(u, v, whole(params, 'scale', 3), 5, 0.55, s) * 0.5 + 0.5;
        const t = 1 - num(params, 'amount', 0.5);
        const body = smoothstep(t - 0.02, t + 0.02, m);
        const d = (m - t) / Math.max(num(params, 'rimWidth', 0.05), 1e-3);
        return saturate(body * 0.6 + Math.exp(-d * d) * num(params, 'rim', 0.6));
    },
    liquid: (u, v, params, s) => {
        const scale = whole(params, 'scale', 3);
        const octaves = whole(params, 'octaves', 4);
        const warp = num(params, 'warp', 0.4);
        const q = [fbm(u, v, scale, octaves, 0.5, s), fbm(u, v, scale, octaves, 0.5, s + 5.2)];
        const r = [fbm(u + q[0] * warp, v + q[1] * warp, scale, octaves, 0.5, s + 1.7), fbm(u + q[0] * warp, v + q[1] * warp, scale, octaves, 0.5, s + 9.2)];
        return saturate(0.5 + 0.5 * fbm(u + r[0] * warp, v + r[1] * warp, scale, octaves, 0.5, s + 3.1) * num(params, 'contrast', 1));
    },
    plasma: (u, v, params, s) => {
        const scale = whole(params, 'scale', 3);
        const waves = whole(params, 'waves', 4);
        const range = 2 * scale + 1;
        let sum = 0;
        for (let k = 0; k < waves; k++) {
            const r = hash3(k, 7, s);
            const q = hash3(k, 13, s);
            const frequency = [Math.floor(r[0] * range) - scale, Math.floor(r[1] * scale) + 1];
            const bend = [Math.floor(q[0] * range) - scale, Math.floor(q[1] * range) - scale];
            sum += Math.sin(TAU * (frequency[0] * u + frequency[1] * v) + r[2] * TAU + num(params, 'warp', 1) * Math.sin(TAU * (bend[0] * u + bend[1] * v) + q[2] * TAU));
        }
        return 0.5 + 0.5 * sum / waves;
    },
    caustics: (u0, v0, params, s) => {
        const [u, v] = disorderAt(u0, v0, num(params, 'warp', 0.3), s);
        const sharpness = num(params, 'sharpness', 3);
        const layer = (x: number, y: number, scale: number, salt: number) => {
            const w = worley(x * scale, y * scale, scale, scale, 1, 0, Math.fround(s + salt));
            return Math.pow(saturate(1 - (w[1] - w[0]) * 2), sharpness);
        };
        const scale = whole(params, 'scale', 5);
        let value = layer(u, v, scale, 0);
        if (whole(params, 'layers', 2) > 1) value = value * 0.6 + layer(u + 0.37, v + 0.37, scale * 2, 3) * 0.4;
        return saturate(value * num(params, 'brightness', 1));
    },
    directionalNoise: (u, v, params, s) => {
        const dir = tileSafeDirection(num(params, 'angle', 0)).step;
        let along = whole(params, 'along', 4);
        let across = whole(params, 'across', 64);
        let sum = 0;
        let total = 0;
        let amplitude = 1;
        for (let o = 0; o < whole(params, 'octaves', 3); o++) {
            const [x, y] = alongFrame(u, v, dir, along, across);
            sum += strandNoise(x, y, along, across, Math.fround(s + o * 7.31), num(params, 'sharpness', 0)) * amplitude;
            total += amplitude;
            amplitude *= 0.5;
            along *= 2;
            across *= 2;
        }
        return sum / total;
    },
    directionalScratches: (u, v, params, s) => {
        const dir = tileSafeDirection(num(params, 'angle', 0)).step;
        const along = whole(params, 'along', 8);
        const across = whole(params, 'across', 48);
        const [x, y] = alongFrame(u, v, dir, along, across);
        return scratchField(x, y, along, across, num(params, 'density', 0.4), num(params, 'length', 2), num(params, 'thickness', 0.15), num(params, 'variation', 0.5), s);
    },
    grunge: grungeReference,
};

/** The direction a node running one way runs at, snapped so it still tiles (for the inspector to say). */
export const runningDirection = (params: Params): number => tileSafeDirection(num(params, 'angle', 0)).degrees;
