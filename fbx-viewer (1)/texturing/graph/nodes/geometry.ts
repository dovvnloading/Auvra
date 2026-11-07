import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import type { TexturingGpu as TextureGpu } from '../../gpu/texturingGpu';
import { TRANSFORM_READ, tileSafeMatrix, transformMatrix, type Mat2 } from '../safeTransform';
import { bool, color, colorIn, float, grayIn, int, out, seed, select, vec2 } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';
import { atSize, distanceField } from './distance';
import { gaussianBlur } from './transform';

/**
 * GEOMETRY EFFECTS AND NORMALS
 *
 * Smooth bevels, distance in a direction, curvature over a radius, occlusion, shadows and bent
 * normals traced over a height, glow, outlines, glows and shadows of shapes, reaction-diffusion and
 * diffusion, and normal tools: uncombine, turn the vectors, transform a normal map, and a height from
 * normals solved by multigrid. Everything reading round a pixel wraps where the picture tiles. The
 * normal maths and the multigrid have CPU twins below, for the tests.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);

const aborted = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

/** A one-pass node; `uniforms` work out what the shader needs from the settings. */
const onePassWith = (definition: Omit<TexNodeDef, 'run'> & { glsl: string; cost?: (params: Params) => number; uniforms?: (params: Params) => Record<string, unknown> }): TexNodeDef => {
    const { glsl, cost, uniforms, ...rest } = definition;
    return {
        ...rest,
        settingsInShader: !uniforms,
        async run(context) {
            const key = rest.outputs[0].key;
            const image = context.image(context.outputKind(key));
            await context.pass(image, glsl, { cost: cost?.(context.params) ?? 4, ...(uniforms ? { uniforms: uniforms(context.params) } : {}) });
            return { [key]: image };
        },
    };
};

/** Each mask pixel's signed distance to the shape's edge in pixels (negative inside), from the two distance fields. */
const signedDistance = async (context: NodeRunContext, key: string): Promise<{ inside: GpuImage; outside: GpuImage; mask: GpuImage } | null> => {
    const mask = await atSize(context, key);
    if (!mask) return null;
    const outside = await distanceField(context.gpu, mask, context.width, context.height, false);
    const inside = await distanceField(context.gpu, mask, context.width, context.height, true);
    return { inside, outside, mask };
};
const releaseAll = (gpu: TextureGpu, ...images: Array<GpuImage | null | undefined>) => { for (const image of images) gpu.release(image); };

const RNM_GLSL = `vec3 reoriented(vec3 base, vec3 detail) {
    vec3 t = base + vec3(0.0, 0.0, 1.0);
    vec3 u = detail * vec3(-1.0, -1.0, 1.0);
    return t * dot(t, u) / max(t.z, 1e-4) - u;
}`;

/** The reoriented blend: `detail` laid over `base` (both unit directions), as Normal combine does. */
export const reoriented = (base: readonly number[], detail: readonly number[]): number[] => {
    const t = [base[0], base[1], base[2] + 1];
    const u = [-detail[0], -detail[1], detail[2]];
    const dot = t[0] * u[0] + t[1] * u[1] + t[2] * u[2];
    return [0, 1, 2].map((k) => t[k] * dot / Math.max(t[2], 1e-4) - u[k]);
};
const unit = (v: readonly number[]): number[] => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
/** A combined normal's detail again: the combined one turned back by the base (the base mirrored across, laid over it). */
export const uncombined = (combined: readonly number[], base: readonly number[]): number[] => {
    const b = unit(base);
    return unit(reoriented([-b[0], -b[1], b[2]], unit(combined)));
};
/** A normal map's vector after its picture is read through `m` (from the result to the input): the slopes go through m's transpose. */
export const transformedNormal = (n: readonly number[], m: Mat2): number[] => unit([m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], n[2]]);

// ---- multigrid ----

/**
 * The height whose slopes a normal map gives, on a periodic grid: the divergence of the slopes is the
 * height's Laplacian, solved by multigrid V-cycles (smooth, take the leftover to a coarser grid, solve
 * it there, bring the correction back, smooth again). The CPU twin of the GPU solver.
 */
export const solvePoisson = (f: Float64Array, n: number, cycles: number): Float64Array => {
    const at = (grid: Float64Array, size: number, x: number, y: number) => grid[((y % size) + size) % size * size + ((x % size) + size) % size];
    const smooth = (h: Float64Array, rhs: Float64Array, size: number, spacing: number, times: number) => {
        for (let pass = 0; pass < times; pass++) {
            const next = new Float64Array(h.length);
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const around = at(h, size, x - 1, y) + at(h, size, x + 1, y) + at(h, size, x, y - 1) + at(h, size, x, y + 1);
                    const jacobi = (around - spacing * spacing * rhs[y * size + x]) / 4;
                    next[y * size + x] = 0.2 * h[y * size + x] + 0.8 * jacobi;
                }
            }
            h.set(next);
        }
    };
    const cycle = (h: Float64Array, rhs: Float64Array, size: number, spacing: number) => {
        if (size <= 8) { smooth(h, rhs, size, spacing, 60); return; }
        smooth(h, rhs, size, spacing, 3);
        const half = size / 2;
        const coarse = new Float64Array(half * half);
        for (let y = 0; y < half; y++) {
            for (let x = 0; x < half; x++) {
                let sum = 0;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const px = x * 2 + dx;
                        const py = y * 2 + dy;
                        const around = at(h, size, px - 1, py) + at(h, size, px + 1, py) + at(h, size, px, py - 1) + at(h, size, px, py + 1);
                        sum += rhs[py * size + px] - (around - 4 * h[py * size + px]) / (spacing * spacing);
                    }
                }
                coarse[y * half + x] = sum / 4;
            }
        }
        const correction = new Float64Array(half * half);
        cycle(correction, coarse, half, spacing * 2);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                // Bilinear from the coarse grid's cell centres, wrapping.
                const cx = (x + 0.5) / 2 - 0.5;
                const cy = (y + 0.5) / 2 - 0.5;
                const x0 = Math.floor(cx);
                const y0 = Math.floor(cy);
                const fx = cx - x0;
                const fy = cy - y0;
                const value = (at(correction, half, x0, y0) * (1 - fx) + at(correction, half, x0 + 1, y0) * fx) * (1 - fy)
                    + (at(correction, half, x0, y0 + 1) * (1 - fx) + at(correction, half, x0 + 1, y0 + 1) * fx) * fy;
                h[y * size + x] += value;
            }
        }
        smooth(h, rhs, size, spacing, 3);
    };
    const h = new Float64Array(n * n);
    for (let k = 0; k < cycles; k++) cycle(h, f, n, 1);
    return h;
};

const SMOOTH_GLSL = `uniform float uSpacing;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float around = texelWrap(h, p - ivec2(1, 0)).r + texelWrap(h, p + ivec2(1, 0)).r + texelWrap(h, p - ivec2(0, 1)).r + texelWrap(h, p + ivec2(0, 1)).r;
    float jacobi = (around - uSpacing * uSpacing * texelFetch(rhs, p, 0).r) / 4.0;
    outColor = vec4(0.2 * texelFetch(h, p, 0).r + 0.8 * jacobi);
}`;
const RESTRICT_GLSL = `uniform float uSpacing;
void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * 2;
    float sum = 0.0;
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            ivec2 p = base + ivec2(dx, dy);
            float around = texelWrap(h, p - ivec2(1, 0)).r + texelWrap(h, p + ivec2(1, 0)).r + texelWrap(h, p - ivec2(0, 1)).r + texelWrap(h, p + ivec2(0, 1)).r;
            sum += texelFetch(rhs, p, 0).r - (around - 4.0 * texelFetch(h, p, 0).r) / (uSpacing * uSpacing);
        }
    }
    outColor = vec4(sum / 4.0);
}`;
const PROLONG_GLSL = `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 c = (vec2(p) + 0.5) / 2.0 - 0.5;
    ivec2 c0 = ivec2(floor(c));
    vec2 f = c - vec2(c0);
    float value = mix(mix(texelWrap(coarse, c0).r, texelWrap(coarse, c0 + ivec2(1, 0)).r, f.x), mix(texelWrap(coarse, c0 + ivec2(0, 1)).r, texelWrap(coarse, c0 + ivec2(1, 1)).r, f.x), f.y);
    outColor = vec4(texelFetch(h, p, 0).r + value);
}`;

/** The GPU multigrid: one V-cycle on grids `size` across at `spacing`, h and rhs full float grey. */
const gpuCycle = async (gpu: TextureGpu, h: GpuImage, rhs: GpuImage, spacing: number, signal: AbortSignal): Promise<GpuImage> => {
    if (signal.aborted) throw aborted();
    const smooth = async (current: GpuImage, times: number): Promise<GpuImage> => {
        let result = current;
        for (let k = 0; k < times; k++) {
            const next = gpu.image(result.width, result.height, 'gray', 32);
            gpu.passNow(next, { fragment: SMOOTH_GLSL, inputs: { h: result, rhs }, uniforms: { uSpacing: spacing } });
            gpu.release(result);
            result = next;
        }
        return result;
    };
    if (h.width <= 8 || h.height <= 8) return smooth(h, 60);
    let current = await smooth(h, 3);
    const half = gpu.image(Math.max(1, h.width >> 1), Math.max(1, h.height >> 1), 'gray', 32);
    gpu.passNow(half, { fragment: RESTRICT_GLSL, inputs: { h: current, rhs }, uniforms: { uSpacing: spacing } });
    let correction = gpu.image(half.width, half.height, 'gray', 32);
    gpu.clear(correction, [0, 0, 0, 1]);
    correction = await gpuCycle(gpu, correction, half, spacing * 2, signal);
    gpu.release(half);
    const corrected = gpu.image(current.width, current.height, 'gray', 32);
    gpu.passNow(corrected, { fragment: PROLONG_GLSL, inputs: { h: current, coarse: correction } });
    gpu.release(correction);
    gpu.release(current);
    current = await smooth(corrected, 3);
    // Let the page breathe between levels.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return current;
};

/** The lowest and highest value of a grey image in a 1×1 image (red lowest, green highest). */
const valueRange = async (gpu: TextureGpu, source: GpuImage): Promise<GpuImage> => {
    const gather = (first: boolean) => `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy) * 2;
    ivec2 last = textureSize(source, 0) - 1;
    vec2 a = texelFetch(source, min(p, last), 0).${first ? 'rr' : 'rg'};
    vec2 b = texelFetch(source, min(p + ivec2(1, 0), last), 0).${first ? 'rr' : 'rg'};
    vec2 c = texelFetch(source, min(p + ivec2(0, 1), last), 0).${first ? 'rr' : 'rg'};
    vec2 d = texelFetch(source, min(p + ivec2(1, 1), last), 0).${first ? 'rr' : 'rg'};
    outColor = vec4(min(min(a.x, b.x), min(c.x, d.x)), max(max(a.y, b.y), max(c.y, d.y)), 0.0, 1.0);
}`;
    let range = gpu.image((source.width + 1) >> 1, (source.height + 1) >> 1, 'color', 32);
    gpu.passNow(range, { fragment: gather(true), inputs: { source } });
    while (range.width > 1 || range.height > 1) {
        const next = gpu.image((range.width + 1) >> 1, (range.height + 1) >> 1, 'color', 32);
        gpu.passNow(next, { fragment: gather(false), inputs: { source: range } });
        gpu.release(range);
        range = next;
    }
    return range;
};

// ---- tracing over a height ----

const TRACE_GLSL = `vec4 traceOpen(vec2 uv, float h0, float a, float sinE, int steps) {
    vec2 dir = vec2(cos(a), sin(a));
    float cosE = sqrt(max(1.0 - sinE * sinE, 1e-6));
    float rise = sinE / cosE;
    for (int s = 1; s <= 32; s++) {
        if (s > steps) break;
        float t = float(s) / float(steps);
        float run = p_distance * t * t;
        if (g_in(uv + dir * run) * p_depth > h0 + run * rise) return vec4(0.0);
    }
    return vec4(dir * cosE, sinE, 1.0);
}`;

export const GEOMETRY_NODES: TexNodeDef[] = [
    {
        type: 'smoothBevel',
        label: 'Smooth bevel',
        category: 'Edges and distance',
        description: 'Turns a mask into a raised shape with smoothly rounded edges and corners, the bevel softened as if worn.',
        keywords: ['smooth bevel', 'rounded bevel', 'fillet', 'soft edges', 'inflate', 'pillow'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [float('width', 'Width', 0.03, 0.002, 0.5, { step: 0.001 }), float('smoothness', 'Smoothness', 0.5, 0, 1), select('profile', 'Shape', 'round', [['round', 'Round'], ['smooth', 'Smooth'], ['linear', 'Straight']])],
        sizeFrom: 'input',
        async run(context) {
            const mask = await atSize(context, 'mask');
            const result = context.image('gray', context.width, context.height, 16);
            if (!mask) { context.gpu.clear(result, [0, 0, 0, 1]); return { out: result }; }
            const gpu = context.gpu;
            const width = Math.max(1, num(context.params, 'width', 0.03) * context.width);
            const inside = await distanceField(gpu, mask, context.width, context.height, true);
            const raised = gpu.image(context.width, context.height, 'gray', 16);
            await gpu.pass(raised, {
                fragment: `uniform float uWidth;\nuniform int uProfile;\nvoid main() {
    float t = texture(mask, vUv).r >= 0.5 ? clamp(texture(inside, vUv).r / uWidth, 0.0, 1.0) : 0.0;
    if (uProfile == 0) t = sqrt(1.0 - (1.0 - t) * (1.0 - t));
    else if (uProfile == 1) t = t * t * (3.0 - 2.0 * t);
    outColor = vec4(t);
}`,
                inputs: { mask, inside }, uniforms: { uWidth: width, uProfile: ['round', 'smooth', 'linear'].indexOf(String(context.params.profile)) },
            });
            releaseAll(gpu, inside, mask);
            const sigma = width * num(context.params, 'smoothness', 0.5) * 0.5;
            const softened = sigma >= 0.3 ? await gaussianBlur(context, raised, sigma) : gpu.retain(raised);
            await gpu.pass(result, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: softened } });
            releaseAll(gpu, softened, raised);
            return { out: result };
        },
    },
    onePassWith({
        type: 'directionalDistance',
        label: 'Directional distance',
        category: 'Edges and distance',
        description: 'How far each pixel is from the mask looking back along a direction: black at the mask, brightening to white at the farthest distance. Long shadows and drips.',
        keywords: ['directional distance', 'distance along', 'cast', 'long shadow', 'streak from shape'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [float('angle', 'Direction (degrees)', -90, -180, 180, { step: 1 }), float('distance', 'Farthest', 0.2, 0.005, 1, { step: 0.001 }), int('steps', 'Steps', 48, 8, 128)],
        sizeFrom: 'input',
        cost: (params) => num(params, 'steps', 48),
        glsl: `void main() {
    float a = radians(p_angle);
    vec2 d = vec2(cos(a), sin(a));
    if (g_mask(vUv) >= 0.5) { outColor = vec4(0.0); return; }
    float found = 1.0;
    for (int k = 1; k <= 128; k++) {
        if (k > p_steps) break;
        float t = float(k) / float(p_steps);
        if (g_mask(vUv - d * t * p_distance) >= 0.5) { found = t; break; }
    }
    outColor = vec4(found);
}`,
    }),
    onePassWith({
        type: 'smoothCurvature',
        label: 'Smooth curvature',
        category: 'Height and normals',
        description: 'Curvature from a normal map taken over a radius, so broad shapes count as well as fine edges and the result is smooth, not speckled.',
        keywords: ['smooth curvature', 'curvature', 'convex', 'concave', 'edges', 'cavity'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('gray')],
        params: [float('radius', 'Radius (pixels)', 8, 1, 32), float('strength', 'Strength', 1, 0, 8)],
        sizeFrom: 'input',
        cost: () => 20,
        glsl: `void main() {
    vec2 size = vec2(textureSize(t_in, 0));
    vec2 texel = 1.0 / size;
    float sum = 0.0;
    float total = 0.0;
    for (int k = 0; k < 6; k++) {
        float r = pow(2.0, float(k));
        if (r > p_radius) break;
        float w = 1.0 / (1.0 + float(k));
        vec2 o = texel * r;
        float dx = (c_in(vUv + vec2(o.x, 0.0)).x - c_in(vUv - vec2(o.x, 0.0)).x) / (2.0 * o.x) / uWorld.x;
        float dy = (c_in(vUv + vec2(0.0, o.y)).y - c_in(vUv - vec2(0.0, o.y)).y) / (2.0 * o.y) / uWorld.y;
        sum += (dx + dy) / 512.0 * w;
        total += w;
    }
    outColor = vec4(clamp(0.5 + sum / max(total, 1e-5) * p_strength, 0.0, 1.0));
}`,
    }),
    onePassWith({
        type: 'tracedOcclusion',
        label: 'Occlusion from height (traced)',
        category: 'Height and normals',
        description: 'How much open sky each pixel of a height map sees, found by tracing rays over it in every direction and up the sky: deep, accurate ambient occlusion.',
        keywords: ['ray traced ao', 'ambient occlusion', 'occlusion', 'traced', 'cavity', 'shadowing'],
        inputs: [grayIn('in', 'Height')],
        outputs: [out('gray')],
        params: [int('rays', 'Rays', 24, 4, 64), float('distance', 'Reach', 0.08, 0.005, 0.5, { step: 0.001 }), float('depth', 'Height depth', 0.15, 0, 1), int('steps', 'Steps a ray', 12, 4, 32), seed()],
        sizeFrom: 'input',
        cost: (params) => num(params, 'rays', 24) * num(params, 'steps', 12),
        glsl: `${TRACE_GLSL}
void main() {
    float h0 = g_in(vUv) * p_depth;
    float jitter = hash1(ivec2(gl_FragCoord.xy), uSeed);
    float open = 0.0;
    for (int r = 0; r < 64; r++) {
        if (r >= p_rays) break;
        float f = fract((float(r) + jitter) / float(p_rays) * 7.31 + jitter);
        // Up the sky weighted by how square-on light from there falls.
        open += traceOpen(vUv, h0, float(r) * 2.39996323 + jitter * TAU, sqrt(f), p_steps).w;
    }
    outColor = vec4(open / float(p_rays));
}`,
    }),
    onePassWith({
        type: 'heightShadow',
        label: 'Shadows from height',
        category: 'Height and normals',
        description: 'The shadows a light at an angle casts over a height map, traced toward the light; a larger light gives softer edges.',
        keywords: ['shadow', 'cast shadow', 'self shadow', 'sun', 'height shadow'],
        inputs: [grayIn('in', 'Height')],
        outputs: [out('gray')],
        params: [float('azimuth', 'Light from (degrees round)', 45, -180, 180, { step: 1 }), float('elevation', 'Light height (degrees)', 30, 2, 88, { step: 1 }), float('depth', 'Height depth', 0.15, 0, 1), float('distance', 'Reach', 0.2, 0.01, 1, { step: 0.001 }), float('softness', 'Light size (degrees)', 4, 0, 30), int('steps', 'Steps', 32, 8, 64), seed()],
        sizeFrom: 'input',
        cost: (params) => num(params, 'steps', 32) * 4,
        glsl: `void main() {
    float h0 = g_in(vUv) * p_depth;
    float lit = 0.0;
    for (int k = 0; k < 4; k++) {
        vec2 jitter = (hash2(ivec2(gl_FragCoord.xy) + ivec2(k * 7, 0), uSeed) - 0.5) * radians(p_softness);
        float az = radians(p_azimuth) + jitter.x;
        float el = clamp(radians(p_elevation) + jitter.y, 0.01, 1.55);
        vec2 dir = vec2(cos(az), sin(az));
        float rise = tan(el);
        float open = 1.0;
        for (int s = 1; s <= 64; s++) {
            if (s > p_steps) break;
            float run = p_distance * float(s) / float(p_steps);
            if (g_in(vUv + dir * run) * p_depth > h0 + run * rise) { open = 0.0; break; }
        }
        lit += open;
    }
    outColor = vec4(lit * 0.25);
}`,
    }),
    {
        type: 'glow',
        label: 'Glow',
        category: 'Edges and distance',
        description: 'Bright parts bleed light round them: added onto the picture, or the glow alone.',
        keywords: ['glow', 'bloom', 'halo', 'light bleed', 'emissive'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [float('threshold', 'Brighter than', 0.6, 0, 1), float('radius', 'Radius', 0.03, 0.001, 0.3, { step: 0.001 }), float('strength', 'Strength', 1, 0, 4), color('tint', 'Tint', [1, 1, 1, 1]), select('mode', 'Gives', 'add', [['add', 'The picture with its glow'], ['only', 'The glow alone']])],
        sizeFrom: 'input',
        async run(context) {
            const gpu = context.gpu;
            const bright = gpu.image(context.width, context.height, 'color', 16);
            await context.pass(bright, 'void main() { vec4 c = c_in(vUv); outColor = vec4(c.rgb * smoothstep(p_threshold, p_threshold + 0.1, luma(c.rgb)), 1.0); }');
            const glow = await gaussianBlur(context, bright, num(context.params, 'radius', 0.03) * context.width / 3);
            gpu.release(bright);
            const result = context.image('color');
            await context.pass(result, `uniform sampler2D glow;
void main() { vec3 g = texture(glow, vUv).rgb * p_strength * p_tint.rgb; vec4 c = c_in(vUv); outColor = p_mode == 1 ? vec4(g, 1.0) : vec4(c.rgb + g, c.a); }`, { inputs: { glow } });
            gpu.release(glow);
            return { out: result };
        },
    },
    {
        type: 'shapeOutline',
        label: 'Shape outline',
        category: 'Edges and distance',
        description: 'A line round the edge of a mask\'s shapes: inside the edge, on it or outside it, as wide as you set.',
        keywords: ['outline', 'stroke', 'border', 'edge line', 'contour'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [float('width', 'Width', 0.01, 0.001, 0.2, { step: 0.001 }), select('position', 'Lies', 'centre', [['inside', 'Inside the edge'], ['centre', 'On the edge'], ['outside', 'Outside the edge']]), float('softness', 'Softness (pixels)', 1, 0, 8)],
        sizeFrom: 'input',
        async run(context) {
            const fields = await signedDistance(context, 'mask');
            const result = context.image('gray');
            if (!fields) { context.gpu.clear(result, [0, 0, 0, 1]); return { out: result }; }
            await context.pass(result, `uniform sampler2D inside;\nuniform sampler2D outside;\nuniform sampler2D maskMap;\nuniform float uWidth;
void main() {
    float sd = texture(maskMap, vUv).r >= 0.5 ? -texture(inside, vUv).r : texture(outside, vUv).r;
    float low = p_position == 0 ? -uWidth : p_position == 1 ? -uWidth * 0.5 : 0.0;
    float high = low + uWidth;
    float soft = max(p_softness, 0.01);
    outColor = vec4(smoothstep(low - soft, low, sd) * (1.0 - smoothstep(high, high + soft, sd)));
}`, { inputs: { inside: fields.inside, outside: fields.outside, maskMap: fields.mask }, uniforms: { uWidth: num(context.params, 'width', 0.01) * context.width } });
            releaseAll(context.gpu, fields.inside, fields.outside, fields.mask);
            return { out: result };
        },
    },
    {
        type: 'shapeGlow',
        label: 'Shape glow',
        category: 'Edges and distance',
        description: 'A glow fading out round a mask\'s shapes (or in from their edges), as far and as steeply as you set.',
        keywords: ['outer glow', 'inner glow', 'shape glow', 'halo', 'aura'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [float('size', 'Size', 0.05, 0.001, 0.5, { step: 0.001 }), float('falloff', 'Falloff', 1.5, 0.2, 6), select('side', 'Glows', 'outside', [['outside', 'Outward'], ['inside', 'Inward']]), float('strength', 'Strength', 1, 0, 2)],
        sizeFrom: 'input',
        async run(context) {
            const fields = await signedDistance(context, 'mask');
            const result = context.image('gray');
            if (!fields) { context.gpu.clear(result, [0, 0, 0, 1]); return { out: result }; }
            await context.pass(result, `uniform sampler2D inside;\nuniform sampler2D outside;\nuniform sampler2D maskMap;\nuniform float uReach;
void main() {
    bool inMask = texture(maskMap, vUv).r >= 0.5;
    float d = p_side == 1 ? (inMask ? texture(inside, vUv).r : 1e6) : (inMask ? 1e6 : texture(outside, vUv).r);
    outColor = vec4(clamp(pow(clamp(1.0 - d / uReach, 0.0, 1.0), p_falloff) * p_strength, 0.0, 1.0));
}`, { inputs: { inside: fields.inside, outside: fields.outside, maskMap: fields.mask }, uniforms: { uReach: num(context.params, 'size', 0.05) * context.width } });
            releaseAll(context.gpu, fields.inside, fields.outside, fields.mask);
            return { out: result };
        },
    },
    {
        type: 'shapeShadow',
        label: 'Shape shadow',
        category: 'Edges and distance',
        description: 'A drop shadow of a mask\'s shapes: moved by an offset and blurred, outside the shapes only if you like.',
        keywords: ['drop shadow', 'shadow', 'shape shadow', 'cast', 'offset shadow'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [vec2('offset', 'Offset', [0.02, -0.02], -0.5, 0.5), float('blur', 'Blur', 0.02, 0, 0.3, { step: 0.001 }), float('opacity', 'Strength', 0.8, 0, 1), bool('outsideOnly', 'Outside the shapes only', true)],
        sizeFrom: 'input',
        async run(context) {
            const gpu = context.gpu;
            const moved = gpu.image(context.width, context.height, 'gray', 16);
            await context.pass(moved, 'void main() { outColor = vec4(g_mask(vUv - p_offset)); }');
            const sigma = num(context.params, 'blur', 0.02) * context.width / 3;
            const shadow = sigma >= 0.3 ? await gaussianBlur(context, moved, sigma) : gpu.retain(moved);
            gpu.release(moved);
            const result = context.image('gray');
            await context.pass(result, `uniform sampler2D shadow;
void main() { outColor = vec4(texture(shadow, vUv).r * p_opacity * (p_outsideOnly == 1 ? 1.0 - step(0.5, g_mask(vUv)) : 1.0)); }`, { inputs: { shadow } });
            gpu.release(shadow);
            return { out: result };
        },
    },
    {
        type: 'reactionDiffusion',
        label: 'Reaction-diffusion',
        category: 'Patterns',
        description: 'Two chemicals spreading and reacting until they settle into spots, stripes, mazes or coral, depending on how fast one is fed and the other dies off. Seeds from a mask, or at random.',
        keywords: ['reaction diffusion', 'turing pattern', 'gray scott', 'coral', 'maze', 'organic pattern', 'leopard'],
        inputs: [grayIn('seed', 'Seeds')],
        outputs: [out('gray')],
        params: [
            select('look', 'Look', 'coral', [['coral', 'Coral'], ['spots', 'Spots'], ['mazes', 'Mazes'], ['holes', 'Holes'], ['custom', 'Set by hand']]),
            float('feed', 'Feed', 0.0545, 0.01, 0.1, { step: 0.0005, showIf: (params) => params.look === 'custom' }),
            float('kill', 'Die-off', 0.062, 0.04, 0.07, { step: 0.0005, showIf: (params) => params.look === 'custom' }),
            int('steps', 'Steps', 2000, 100, 8000, { hint: 'More steps let the pattern settle further (and take longer).' }),
            int('scale', 'Pattern size', 2, 1, 4, { hint: 'Larger works the pattern out on a coarser grid, so its marks are bigger.' }),
            seed(),
        ],
        sizeFrom: 'graph',
        async run(context) {
            const gpu = context.gpu;
            const looks: Record<string, [number, number]> = { coral: [0.0545, 0.062], spots: [0.035, 0.065], mazes: [0.029, 0.057], holes: [0.039, 0.058] };
            const [feed, kill] = looks[String(context.params.look)] ?? [num(context.params, 'feed', 0.0545), num(context.params, 'kill', 0.062)];
            const shrink = 2 ** (Math.max(1, Math.min(4, Math.round(num(context.params, 'scale', 2)))) - 1);
            const width = Math.max(32, Math.round(context.width / shrink));
            const height = Math.max(32, Math.round(context.height / shrink));
            let state = gpu.image(width, height, 'color', 32);
            await context.pass(state, `void main() {
    float b = w_seed == 1 ? step(0.5, g_seed(vUv)) : step(0.985, hash1(ivec2(floor(gl_FragCoord.xy / 3.0)), uSeed));
    outColor = vec4(1.0, b, 0.0, 1.0);
}`);
            const STEP = `uniform float uFeed;
uniform float uKill;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 c = texelWrap(state, p).rg;
    vec2 near = texelWrap(state, p + ivec2(1, 0)).rg + texelWrap(state, p - ivec2(1, 0)).rg + texelWrap(state, p + ivec2(0, 1)).rg + texelWrap(state, p - ivec2(0, 1)).rg;
    vec2 corners = texelWrap(state, p + ivec2(1, 1)).rg + texelWrap(state, p - ivec2(1, 1)).rg + texelWrap(state, p + ivec2(1, -1)).rg + texelWrap(state, p + ivec2(-1, 1)).rg;
    vec2 lap = near * 0.2 + corners * 0.05 - c;
    float a = c.r;
    float b = c.g;
    float abb = a * b * b;
    outColor = vec4(clamp(a + lap.r - abb + uFeed * (1.0 - a), 0.0, 1.0), clamp(b + 0.5 * lap.g + abb - (uKill + uFeed) * b, 0.0, 1.0), 0.0, 1.0);
}`;
            const steps = Math.max(1, Math.round(num(context.params, 'steps', 2000)));
            for (let k = 0; k < steps; k++) {
                const next = gpu.image(width, height, 'color', 32);
                gpu.passNow(next, { fragment: STEP, inputs: { state }, uniforms: { uFeed: feed, uKill: kill } });
                gpu.release(state);
                state = next;
                if (k % 200 === 199) {
                    if (context.signal.aborted) { gpu.release(state); throw aborted(); }
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
            const result = context.image('gray');
            await context.gpu.pass(result, { fragment: 'void main() { outColor = vec4(clamp(texture(state, vUv).g * 3.0, 0.0, 1.0)); }', inputs: { state } });
            gpu.release(state);
            return { out: result };
        },
    },
    {
        type: 'diffusion',
        label: 'Diffusion',
        category: 'Edges and distance',
        description: 'Fills the empty parts of a picture with colour spread smoothly from the parts that hold some: what is see-through (or black in the mask) is filled from round it.',
        keywords: ['diffusion', 'fill gaps', 'push pull', 'dilate colour', 'inpaint', 'bleed'],
        inputs: [colorIn('in', 'Input'), grayIn('mask', 'Holds colour', 'white')],
        outputs: [out('color')],
        params: [select('known', 'Holds colour where', 'alpha', [['alpha', 'It is not see-through'], ['mask', 'The mask is white']])],
        sizeFrom: 'input',
        async run(context) {
            const gpu = context.gpu;
            // Colours weighted by how much each pixel holds, halved down to one pixel, then filled back up:
            // each level keeps what it holds and takes the rest from the level below it.
            let level = gpu.image(context.width, context.height, 'color', 32);
            await context.pass(level, 'void main() { vec4 c = c_in(vUv); float w = clamp(p_known == 1 ? g_mask(vUv) : c.a, 0.0, 1.0); outColor = vec4(c.rgb * w, w); }');
            const levels: GpuImage[] = [level];
            while (level.width > 1 || level.height > 1) {
                const next = gpu.image(Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), 'color', 32);
                gpu.passNow(next, {
                    fragment: `void main() { ivec2 p = ivec2(gl_FragCoord.xy) * 2; vec4 s = texelWrap(source, p) + texelWrap(source, p + ivec2(1, 0)) + texelWrap(source, p + ivec2(0, 1)) + texelWrap(source, p + ivec2(1, 1)); outColor = s / 4.0; }`,
                    inputs: { source: level },
                });
                levels.push(next);
                level = next;
            }
            let filled = gpu.image(1, 1, 'color', 32);
            gpu.passNow(filled, { fragment: 'void main() { vec4 c = texelFetch(source, ivec2(0), 0); outColor = vec4(c.a > 1e-6 ? c.rgb / c.a : vec3(0.0), 1.0); }', inputs: { source: levels[levels.length - 1] } });
            for (let k = levels.length - 2; k >= 0; k--) {
                const next = gpu.image(levels[k].width, levels[k].height, 'color', 32);
                gpu.passNow(next, {
                    fragment: `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 own = texelFetch(level, p, 0);
    vec2 c = (vec2(p) + 0.5) / 2.0 - 0.5;
    ivec2 c0 = ivec2(floor(c));
    vec2 f = c - vec2(c0);
    vec3 below = mix(mix(texelWrap(coarse, c0).rgb, texelWrap(coarse, c0 + ivec2(1, 0)).rgb, f.x), mix(texelWrap(coarse, c0 + ivec2(0, 1)).rgb, texelWrap(coarse, c0 + ivec2(1, 1)).rgb, f.x), f.y);
    outColor = vec4(own.rgb + (1.0 - clamp(own.a, 0.0, 1.0)) * below, 1.0);
}`,
                    inputs: { level: levels[k], coarse: filled },
                });
                gpu.release(filled);
                filled = next;
            }
            for (const image of levels) gpu.release(image);
            const result = context.image('color');
            await gpu.pass(result, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: filled } });
            gpu.release(filled);
            return { out: result };
        },
    },
    onePassWith({
        type: 'normalUncombine',
        label: 'Normal uncombine',
        category: 'Height and normals',
        description: 'Takes a base normal map back out of a combined one, leaving the detail that was laid over it (the reverse of Normal combine\'s reoriented blend).',
        keywords: ['normal uncombine', 'remove normal', 'detail normal', 'subtract normal', 'separate normals'],
        inputs: [colorIn('combined', 'Combined', 'normal'), colorIn('base', 'Base', 'normal')],
        outputs: [out('color')],
        params: [],
        sizeFrom: 'input',
        preview: 'normal',
        glsl: `${RNM_GLSL}
void main() {
    vec3 n = normalize(c_combined(vUv).xyz * 2.0 - 1.0);
    vec3 b = normalize(c_base(vUv).xyz * 2.0 - 1.0);
    outColor = vec4(normalize(reoriented(vec3(-b.x, -b.y, b.z), n)) * 0.5 + 0.5, 1.0);
}`,
    }),
    onePassWith({
        type: 'normalRotation',
        label: 'Normal vector rotation',
        category: 'Height and normals',
        description: 'Turns the directions a normal map holds (not its picture), so it still lights right after its picture was turned; by an angle, and by a map if wired.',
        keywords: ['rotate normals', 'normal rotation', 'turn normal vectors', 'normal direction'],
        inputs: [colorIn('in', 'Normal', 'normal'), grayIn('turn', 'Turn by map', 'mid')],
        outputs: [out('color')],
        params: [float('angle', 'Turn (degrees)', 90, -360, 360, { step: 1 }), float('range', 'Map turn (degrees)', 180, 0, 360, { step: 1 })],
        sizeFrom: 'input',
        preview: 'normal',
        glsl: `void main() {
    vec3 n = c_in(vUv).xyz * 2.0 - 1.0;
    float a = radians(p_angle + (g_turn(vUv) - 0.5) * 2.0 * p_range);
    n.xy = rotate2(a) * n.xy;
    outColor = vec4(normalize(n) * 0.5 + 0.5, 1.0);
}`,
    }),
    onePassWith({
        type: 'normalTransform',
        label: 'Normal transform',
        category: 'Height and normals',
        description: 'Moves, turns and scales a normal map and turns, mirrors and steepens its directions to match, so it lights as the transformed surface would. Keep it seamless snaps to a turn and size that tile.',
        keywords: ['normal transform', 'transform normal map', 'rotate normal map', 'scale normal', 'mirror normal'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('color')],
        params: [vec2('offset', 'Offset', [0, 0], -1, 1), float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }), vec2('scale', 'Scale', [1, 1], -16, 16), bool('safe', 'Keep it seamless', false)],
        sizeFrom: 'input',
        preview: 'normal',
        uniforms: (params) => {
            const exact = transformMatrix(num(params, 'rotation', 0), (params.scale as number[]) ?? [1, 1]);
            return { uMatrix: new THREE.Vector4(...(params.safe ? tileSafeMatrix(exact) : exact)) };
        },
        glsl: `${TRANSFORM_READ}
void main() {
    vec3 n = c_in(transformed(vUv)).xyz * 2.0 - 1.0;
    // Slopes go through the transpose of the matrix the picture is read through.
    vec2 xy = vec2(uMatrix.x * n.x + uMatrix.z * n.y, uMatrix.y * n.x + uMatrix.w * n.y);
    outColor = vec4(normalize(vec3(xy, n.z)) * 0.5 + 0.5, 1.0);
}`,
    }),
    onePassWith({
        type: 'bentNormalFromHeight',
        label: 'Bent normals from height',
        category: 'Height and normals',
        description: 'The average open direction over each pixel of a height map, traced like occlusion: a normal bent toward where light can come from, for better shading in crevices.',
        keywords: ['bent normal', 'bent normals', 'occlusion direction', 'sky direction'],
        inputs: [grayIn('in', 'Height')],
        outputs: [out('color')],
        params: [int('rays', 'Rays', 24, 4, 64), float('distance', 'Reach', 0.08, 0.005, 0.5, { step: 0.001 }), float('depth', 'Height depth', 0.15, 0, 1), int('steps', 'Steps a ray', 12, 4, 32), seed()],
        sizeFrom: 'input',
        preview: 'normal',
        cost: (params) => num(params, 'rays', 24) * num(params, 'steps', 12),
        glsl: `${TRACE_GLSL}
void main() {
    float h0 = g_in(vUv) * p_depth;
    float jitter = hash1(ivec2(gl_FragCoord.xy), uSeed);
    vec3 sum = vec3(0.0);
    for (int r = 0; r < 64; r++) {
        if (r >= p_rays) break;
        float f = fract((float(r) + jitter) / float(p_rays) * 7.31 + jitter);
        sum += traceOpen(vUv, h0, float(r) * 2.39996323 + jitter * TAU, sqrt(f), p_steps).xyz;
    }
    vec3 n = length(sum) > 1e-5 ? normalize(sum) : vec3(0.0, 0.0, 1.0);
    outColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
    }),
    {
        type: 'normalToHeightHQ',
        label: 'Height from normal (high quality)',
        category: 'Height and normals',
        description: 'Rebuilds the height a normal map came from, solved properly by multigrid (each cycle takes the error down at every scale), stretched to fill black to white. Slower than Height from normal, and truer.',
        keywords: ['normal to height', 'high quality', 'multigrid', 'integrate', 'reconstruct height', 'poisson'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('gray')],
        params: [int('cycles', 'Cycles', 4, 1, 12), float('intensity', 'Contrast', 1, 0, 8)],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            const result = context.image('gray');
            if (!input) { context.gpu.clear(result, [0.5, 0.5, 0.5, 1]); return { out: result }; }
            const gpu = context.gpu;
            const width = context.width;
            const height = context.height;
            // The slopes' divergence (the height's Laplacian), in pixels.
            const slopes = gpu.image(width, height, 'color', 32);
            await gpu.pass(slopes, { fragment: 'void main() { vec3 n = texture(source, vUv).xyz * 2.0 - 1.0; n.z = max(n.z, 0.05); outColor = vec4(-n.xy / n.z, 0.0, 1.0); }', inputs: { source: input } });
            const rhs = gpu.image(width, height, 'gray', 32);
            gpu.passNow(rhs, {
                fragment: 'void main() { ivec2 p = ivec2(gl_FragCoord.xy); outColor = vec4((texelWrap(s, p + ivec2(1, 0)).x - texelWrap(s, p - ivec2(1, 0)).x + texelWrap(s, p + ivec2(0, 1)).y - texelWrap(s, p - ivec2(0, 1)).y) * 0.5); }',
                inputs: { s: slopes },
            });
            gpu.release(slopes);
            let solved = gpu.image(width, height, 'gray', 32);
            gpu.clear(solved, [0, 0, 0, 1]);
            const cycles = Math.max(1, Math.round(num(context.params, 'cycles', 4)));
            for (let k = 0; k < cycles; k++) solved = await gpuCycle(gpu, solved, rhs, 1, context.signal);
            gpu.release(rhs);
            const range = await valueRange(gpu, solved);
            await context.pass(result, `uniform sampler2D solved;
uniform sampler2D range;
void main() {
    vec2 span = texelFetch(range, ivec2(0), 0).rg;
    float h = span.y - span.x > 1e-6 ? (texture(solved, vUv).r - span.x) / (span.y - span.x) : 0.5;
    outColor = vec4(clamp(0.5 + (h - 0.5) * p_intensity, 0.0, 1.0));
}`, { inputs: { solved, range } });
            releaseAll(gpu, range, solved);
            return { out: result };
        },
    },
];
