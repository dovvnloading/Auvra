import * as THREE from 'three';
import { hash1, smoothstep } from '../noiseMath';
import { SEAM_BLEND, TRANSFORM_READ, blendedSample, transformPlace, type Mat2 } from '../safeTransform';
import { anyIn, bool, colorIn, float, grayIn, int, out, seed, select, vec2 } from '../nodeKit';
import type { TexNodeDef } from '../types';

/**
 * BLURS, WARPS AND TRANSFORMS
 *
 * Anisotropic, non-uniform, radial and median blurs and edge-preserving smoothing; warps in many
 * directions, by a direction map, and a vector morph; skew, symmetry, trapezoid and quad transforms,
 * rotation by a map, auto crop, clone and noise upscale. Nodes that read their input around a pixel
 * read it through the kit (c_in), which wraps where the node tiles, so a tiling picture stays tiling.
 * Nodes that move the picture about have their CPU twins below (FILTER_REFERENCES).
 */

type Params = Readonly<Record<string, unknown>>;
type Read = (u: number, v: number) => number;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const whole = (params: Params, key: string, fallback: number): number => Math.round(num(params, key, fallback));
const pair = (params: Params, key: string, fallback: [number, number]): [number, number] => (Array.isArray(params[key]) ? [Number((params[key] as number[])[0]), Number((params[key] as number[])[1])] : fallback);
const fract = (x: number) => x - Math.floor(x);

/** A one-pass filter; `uniforms` work out what the shader needs from the settings. */
const filter = (definition: Omit<TexNodeDef, 'run'> & { glsl: string; cost?: (params: Params) => number; uniforms?: (params: Params) => Record<string, unknown> }): TexNodeDef => {
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

/** The shaders of the filters reading around each pixel, for the tests to see they read through the kit. */
export const FILTER_SHADERS: Record<string, string> = {};
const kept = (type: string, glsl: string): string => { FILTER_SHADERS[type] = glsl; return glsl; };

const SYMMETRIES = ['across', 'down', 'four', 'eight', 'kaleidoscope'] as const;

/** Where a symmetry reads its input for a place: a mirror's own half, or a kaleidoscope's first slice. */
const symmetryPlace = (u: number, v: number, params: Params): [number, number] => {
    const mode = Math.max(0, SYMMETRIES.indexOf(params.mode as typeof SYMMETRIES[number]));
    if (mode === 0) return [u < 0.5 ? u : 1 - u, v];
    if (mode === 1) return [u, v < 0.5 ? v : 1 - v];
    if (mode === 2) return [u < 0.5 ? u : 1 - u, v < 0.5 ? v : 1 - v];
    if (mode === 3) {
        // Both ways, then over the diagonal: eight-fold, and still seamless.
        const a = u < 0.5 ? u : 1 - u;
        const b = v < 0.5 ? v : 1 - v;
        return b > a ? [b, a] : [a, b];
    }
    const n = whole(params, 'repeats', 1);
    const cellX = Math.floor(u * n);
    const cellY = Math.floor(v * n);
    const [cx, cy] = pair(params, 'centre', [0.5, 0.5]);
    const px = fract(u * n) - cx;
    const py = fract(v * n) - cy;
    const turn = num(params, 'angle', 0) * Math.PI / 180;
    const slice = Math.PI * 2 / Math.max(2, whole(params, 'segments', 6));
    let a = Math.atan2(py, px) - turn;
    a -= slice * Math.floor(a / slice);
    if (a > slice / 2) a = slice - a;
    const r = Math.hypot(px, py);
    return [(cellX + cx + r * Math.cos(a + turn)) / n, (cellY + cy + r * Math.sin(a + turn)) / n];
};

/** Where a rotation by a map reads its input: turned about its cell's middle (or the picture's) by the map. */
const mapRotationPlace = (u: number, v: number, turnMap: number, params: Params): [number, number] => {
    const n = params.around === 'centre' ? 1 : whole(params, 'cells', 4);
    const cx = (Math.floor(u * n) + 0.5) / n;
    const cy = (Math.floor(v * n) + 0.5) / n;
    const a = (turnMap - 0.5) * 2 * num(params, 'range', 90) * Math.PI / 180;
    const dx = u - cx;
    const dy = v - cy;
    return [cx + Math.cos(a) * dx - Math.sin(a) * dy, cy + Math.sin(a) * dx + Math.cos(a) * dy];
};

/** The clone's mask at a place: inside the stamp at its destination, the short way round where it tiles. */
const cloneMask = (u: number, v: number, params: Params): number => {
    const [tx, ty] = pair(params, 'to', [0.7, 0.5]);
    let dx = u - tx;
    let dy = v - ty;
    dx -= Math.round(dx);
    dy -= Math.round(dy);
    const size = num(params, 'size', 0.15);
    const d = params.shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
    return 1 - smoothstep(size * (1 - num(params, 'softness', 0.3)) - 1e-4, size, d);
};

/** A noise upscale's copies: each twice as fine, turned a whole quarter and shifted by the seed. */
const upscaleCopies = (octaves: number, seedValue: number): Array<{ turn: number; shift: [number, number] }> =>
    Array.from({ length: octaves }, (_, k) => ({ turn: Math.floor(hash1(k, 3, seedValue) * 4) % 4, shift: [hash1(k, 5, seedValue), hash1(k, 7, seedValue)] as [number, number] }));

/** The inverse of a bilinear patch: where (s, t) a place lies in the quad with corners a (s0 t0), b (s1 t0), c (s0 t1), d (s1 t1). */
export const inverseBilinear = (p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): [number, number] => {
    const cross = (x: readonly number[], y: readonly number[]) => x[0] * y[1] - x[1] * y[0];
    const e = [p[0] - a[0], p[1] - a[1]];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const ac = [c[0] - a[0], c[1] - a[1]];
    const twist = [d[0] - b[0] - c[0] + a[0], d[1] - b[1] - c[1] + a[1]];
    const k2 = cross(ac, twist);
    const k1 = cross(ac, ab) - cross(e, twist);
    const k0 = -cross(e, ab);
    let t: number;
    if (Math.abs(k2) < 1e-9) t = Math.abs(k1) < 1e-12 ? 0 : -k0 / k1;
    else {
        const root = Math.sqrt(Math.max(0, k1 * k1 - 4 * k2 * k0));
        const t1 = (-k1 + root) / (2 * k2);
        const t2 = (-k1 - root) / (2 * k2);
        t = t1 >= -1e-6 && t1 <= 1 + 1e-6 ? t1 : t2;
    }
    const bx = ab[0] + twist[0] * t;
    const by = ab[1] + twist[1] * t;
    const s = Math.abs(bx) > Math.abs(by) ? (e[0] - ac[0] * t) / bx : (e[1] - ac[1] * t) / by;
    return [s, t];
};

const INVERSE_BILINEAR_GLSL = `float cross2(vec2 x, vec2 y) { return x.x * y.y - x.y * y.x; }
vec2 inverseBilinear(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
    vec2 e = p - a;
    vec2 ab = b - a;
    vec2 ac = c - a;
    vec2 twist = d - b - c + a;
    float k2 = cross2(ac, twist);
    float k1 = cross2(ac, ab) - cross2(e, twist);
    float k0 = -cross2(e, ab);
    float t;
    if (abs(k2) < 1e-9) t = abs(k1) < 1e-12 ? 0.0 : -k0 / k1;
    else {
        float root = sqrt(max(0.0, k1 * k1 - 4.0 * k2 * k0));
        float t1 = (-k1 + root) / (2.0 * k2);
        float t2 = (-k1 - root) / (2.0 * k2);
        t = (t1 >= -1e-6 && t1 <= 1.0 + 1e-6) ? t1 : t2;
    }
    vec2 bt = ab + twist * t;
    float s = abs(bt.x) > abs(bt.y) ? (e.x - ac.x * t) / bt.x : (e.y - ac.y * t) / bt.y;
    return vec2(s, t);
}`;

/** The skew's matrix from the result to the input: a step down slides it across by the amount (or the other way). */
export const skewMatrix = (amount: number, axis: string): Mat2 => (axis === 'down' ? [1, 0, amount, 1] : [1, amount, 0, 1]);

export const FILTER_NODES: TexNodeDef[] = [
    // ---- blurs ----
    filter({
        type: 'anisotropicBlur',
        label: 'Anisotropic blur',
        category: 'Blurs and sharpening',
        description: 'Blurs more along one direction than across it: a soft smear at an angle, as brushing or motion leaves.',
        keywords: ['anisotropic blur', 'stretched blur', 'directional blur', 'elliptical blur', 'smear'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('angle', 'Direction (degrees)', 0, -180, 180, { step: 1 }), float('along', 'Along', 0.05, 0, 0.3, { step: 0.001 }), float('across', 'Across', 0.01, 0, 0.1, { step: 0.001 }), int('samples', 'Quality', 8, 2, 16)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => (num(params, 'samples', 8) * 2 + 1) * (Math.max(1, Math.round(num(params, 'samples', 8) / 3)) * 2 + 1),
        glsl: kept('anisotropicBlur', `void main() {
    float a = radians(p_angle);
    vec2 d = vec2(cos(a), sin(a));
    vec2 side = vec2(-d.y, d.x);
    int m = max(1, p_samples / 3);
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -16; i <= 16; i++) {
        if (i < -p_samples || i > p_samples) continue;
        float s = float(i) / float(p_samples);
        for (int j = -6; j <= 6; j++) {
            if (j < -m || j > m) continue;
            float t = float(j) / float(m);
            float w = exp(-2.0 * (s * s + t * t));
            sum += c_in(vUv + d * s * p_along + side * t * p_across) * w;
            total += w;
        }
    }
    outColor = sum / total;
}`),
    }),
    filter({
        type: 'nonUniformBlur',
        label: 'Non-uniform blur',
        category: 'Blurs and sharpening',
        description: 'A blur whose size follows a grey map (wired into Size), and whose shape can stretch along a direction map: sharp in places, smeared in others.',
        keywords: ['non-uniform blur', 'map blur', 'variable blur', 'depth of field', 'blur by map'],
        inputs: [anyIn('in', 'Input'), grayIn('amount', 'Size', 'white'), grayIn('direction', 'Direction')],
        outputs: [out('any')],
        params: [float('radius', 'Most radius', 0.03, 0, 0.2, { step: 0.001 }), float('stretch', 'Stretch along the direction', 0, 0, 0.95), int('samples', 'Samples', 24, 4, 64)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => num(params, 'samples', 24),
        glsl: kept('nonUniformBlur', `void main() {
    float r = p_radius * g_amount(vUv);
    float a = g_direction(vUv) * TAU;
    vec2 d = vec2(cos(a), sin(a));
    vec2 side = vec2(-d.y, d.x);
    vec4 sum = c_in(vUv);
    float total = 1.0;
    for (int k = 0; k < 64; k++) {
        if (k >= p_samples) break;
        float f = (float(k) + 0.5) / float(p_samples);
        float g = float(k) * 2.39996323;
        vec2 o = vec2(cos(g), sin(g)) * sqrt(f) * r;
        // Squashed across the direction by the stretch.
        o = d * dot(o, d) + side * dot(o, side) * (1.0 - p_stretch);
        float w = exp(-2.0 * f);
        sum += c_in(vUv + o) * w;
        total += w;
    }
    outColor = sum / total;
}`),
    }),
    filter({
        type: 'radialBlur',
        label: 'Radial blur',
        category: 'Blurs and sharpening',
        description: 'Blurs out from a centre (zooming) or round it (spinning).',
        keywords: ['radial blur', 'zoom blur', 'spin blur', 'rotational blur', 'speed'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('mode', 'Blurs', 'zoom', [['zoom', 'Out from the centre'], ['spin', 'Round the centre']]), vec2('centre', 'Centre', [0.5, 0.5], 0, 1), float('amount', 'Amount', 0.2, 0, 1), int('samples', 'Samples', 24, 4, 64)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => num(params, 'samples', 24),
        glsl: kept('radialBlur', `void main() {
    vec2 d = vUv - p_centre;
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int k = 0; k < 64; k++) {
        if (k >= p_samples) break;
        float t = float(k) / float(max(p_samples - 1, 1));
        vec2 at = p_mode == 1 ? p_centre + rotate2((t - 0.5) * p_amount) * d : p_centre + d * (1.0 - p_amount * t);
        float w = 1.0 - 0.5 * t;
        sum += c_in(at) * w;
        total += w;
    }
    outColor = sum / total;
}`),
    }),
    filter({
        type: 'medianBlur',
        label: 'Median blur',
        category: 'Blurs and sharpening',
        description: 'Each pixel the middle value of those round it: takes out specks and noise while keeping edges sharp.',
        keywords: ['median', 'despeckle', 'denoise', 'noise reduction', 'remove specks'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('size', 'Size', 'small', [['small', '3 × 3'], ['large', '5 × 5']]), select('by', 'Middle of', 'brightness', [['brightness', 'Brightness (keeps colours together)'], ['channels', 'Each channel']])],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 30,
        glsl: kept('medianBlur', `void main() {
    int r = p_size == 1 ? 2 : 1;
    int count = (2 * r + 1) * (2 * r + 1);
    vec4 s[25];
    float l[25];
    vec2 texel = 1.0 / uSize;
    int n = 0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            if (abs(x) > r || abs(y) > r) continue;
            s[n] = c_in(vUv + vec2(float(x), float(y)) * texel);
            l[n] = luma(s[n].rgb);
            n++;
        }
    }
    int middle = count / 2;
    if (p_by == 0) {
        vec4 pick = s[0];
        for (int i = 0; i < 25; i++) {
            if (i >= count) break;
            int below = 0;
            int same = 0;
            for (int j = 0; j < 25; j++) {
                if (j >= count) break;
                if (l[j] < l[i]) below++;
                else if (l[j] == l[i] && j < i) same++;
            }
            if (below + same == middle) pick = s[i];
        }
        outColor = pick;
        return;
    }
    vec4 result = vec4(0.0);
    for (int c = 0; c < 4; c++) {
        for (int i = 0; i < 25; i++) {
            if (i >= count) break;
            int rank = 0;
            for (int j = 0; j < 25; j++) {
                if (j >= count) break;
                if (s[j][c] < s[i][c] || (s[j][c] == s[i][c] && j < i)) rank++;
            }
            if (rank == middle) result[c] = s[i][c];
        }
    }
    outColor = result;
}`),
    }),
    filter({
        type: 'smoothKeepEdges',
        label: 'Edge-preserving smooth',
        category: 'Blurs and sharpening',
        description: 'Smooths flat areas while keeping edges crisp: pixels only blend with neighbours of a similar colour.',
        keywords: ['bilateral', 'edge preserving', 'surface blur', 'smart blur', 'denoise', 'smooth'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('radius', 'Radius (pixels)', 4, 1, 16), float('edges', 'Edge sensitivity', 0.1, 0.01, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 169,
        glsl: kept('smoothKeepEdges', `void main() {
    vec4 centre = c_in(vUv);
    vec2 texel = p_radius / 6.0 / uSize;
    vec4 sum = vec4(0.0);
    float total = 0.0;
    float range = max(p_edges * p_edges * 2.0, 1e-5);
    for (int y = -6; y <= 6; y++) {
        for (int x = -6; x <= 6; x++) {
            vec4 c = c_in(vUv + vec2(float(x), float(y)) * texel);
            vec4 d = c - centre;
            float w = exp(-float(x * x + y * y) / 18.0) * exp(-dot(d, d) / range);
            sum += c * w;
            total += w;
        }
    }
    outColor = sum / total;
}`),
    }),
    // ---- warps ----
    filter({
        type: 'multiDirectionalWarp',
        label: 'Multi-directional warp',
        category: 'Warps',
        description: 'Pushes the picture several ways at once by a grey map and blends the copies (or keeps the darkest or brightest): smears, frays and melted edges.',
        keywords: ['multi directional warp', 'smear', 'fray', 'spread', 'warp many ways'],
        inputs: [anyIn('in', 'Input'), grayIn('intensity', 'How far', 'white')],
        outputs: [out('any')],
        params: [float('amount', 'Distance', 0.03, 0, 0.3, { step: 0.001 }), int('directions', 'Directions', 4, 2, 16), float('angle', 'Turn (degrees)', 0, -180, 180, { step: 1 }), select('mode', 'Keeps', 'average', [['average', 'Their blend'], ['min', 'The darkest'], ['max', 'The brightest']])],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => num(params, 'directions', 4),
        glsl: kept('multiDirectionalWarp', `void main() {
    float k = g_intensity(vUv) * p_amount;
    vec4 sum = vec4(0.0);
    vec4 lo = vec4(1e9);
    vec4 hi = vec4(-1e9);
    for (int i = 0; i < 16; i++) {
        if (i >= p_directions) break;
        float a = radians(p_angle) + TAU * float(i) / float(p_directions);
        vec4 c = c_in(vUv + vec2(cos(a), sin(a)) * k);
        sum += c;
        lo = min(lo, c);
        hi = max(hi, c);
    }
    outColor = p_mode == 1 ? lo : p_mode == 2 ? hi : sum / float(p_directions);
}`),
    }),
    filter({
        type: 'mapDirectionalWarp',
        label: 'Directional warp by map',
        category: 'Warps',
        description: 'Pushes each pixel in a direction a grey map gives (black to white turning a full circle, or less), as far as a second map says.',
        keywords: ['directional warp', 'warp by map', 'angle map', 'flow', 'non-uniform warp'],
        inputs: [anyIn('in', 'Input'), grayIn('direction', 'Direction'), grayIn('intensity', 'How far', 'white')],
        outputs: [out('any')],
        params: [float('amount', 'Distance', 0.05, -0.5, 0.5, { step: 0.001 }), float('angle', 'Turn (degrees)', 0, -180, 180, { step: 1 }), float('spread', 'Direction range (degrees)', 360, 0, 360, { step: 1 })],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: kept('mapDirectionalWarp', `void main() {
    float a = radians(p_angle + g_direction(vUv) * p_spread);
    outColor = c_in(vUv + vec2(cos(a), sin(a)) * g_intensity(vUv) * p_amount);
}`),
    }),
    filter({
        type: 'vectorMorph',
        label: 'Vector morph',
        category: 'Warps',
        description: 'Flows the picture along a vector map (red across, green down, mid grey still) in small steps, so it bends smoothly instead of tearing.',
        keywords: ['vector morph', 'flow', 'advect', 'smear along', 'vector field'],
        inputs: [anyIn('in', 'Input'), colorIn('vector', 'Vectors', 'mid')],
        outputs: [out('any')],
        params: [float('amount', 'Distance', 0.1, -1, 1, { step: 0.001 }), int('steps', 'Steps', 12, 1, 32)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => num(params, 'steps', 12) + 1,
        glsl: kept('vectorMorph', `void main() {
    vec2 p = vUv;
    for (int i = 0; i < 32; i++) {
        if (i >= p_steps) break;
        vec2 v = c_vector(p).rg * 2.0 - 1.0;
        p -= v * p_amount / float(p_steps);
    }
    outColor = c_in(p);
}`),
    }),
    // ---- transforms ----
    filter({
        type: 'skew',
        label: 'Skew',
        category: 'Transforms',
        description: 'Slants the picture: each row slides across in step with how far down it is (or each column down). Keep it seamless blends the seams so it still tiles.',
        keywords: ['skew', 'shear', 'slant', 'italic', 'oblique'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('amount', 'Slant', 0.3, -2, 2), select('axis', 'Slides', 'across', [['across', 'Rows across'], ['down', 'Columns down']]), vec2('offset', 'Offset', [0, 0], -1, 1), bool('seamless', 'Keep it seamless', true), float('blend', 'Seam blend', 0.15, 0.01, 0.5, { showIf: (params) => Boolean(params.seamless) })],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 4,
        uniforms: (params) => ({ uMatrix: new THREE.Vector4(...skewMatrix(num(params, 'amount', 0.3), String(params.axis))), uBlend: num(params, 'blend', 0.15) }),
        glsl: `${TRANSFORM_READ}
vec4 transformedColour(vec2 uv) { return texture(t_in, fract(transformed(uv))); }
${SEAM_BLEND}
void main() { outColor = p_seamless == 1 ? blended(vUv) : c_in(transformed(vUv)); }`,
    }),
    filter({
        type: 'symmetry',
        label: 'Symmetry',
        category: 'Transforms',
        description: 'Makes the picture symmetrical: mirrored across, down, both ways, eight ways (both and over the diagonals), or a kaleidoscope of mirrored slices round a centre. The mirrors keep a tiling picture seamless.',
        keywords: ['symmetry', 'kaleidoscope', 'mirror', 'radial symmetry', 'reflect'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            select('mode', 'Symmetry', 'across', [['across', 'Left onto right'], ['down', 'Bottom onto top'], ['four', 'Both ways'], ['eight', 'Eight ways'], ['kaleidoscope', 'Kaleidoscope']]),
            int('segments', 'Slices', 6, 2, 32, { showIf: (params) => params.mode === 'kaleidoscope' }),
            vec2('centre', 'Centre', [0.5, 0.5], 0, 1, { showIf: (params) => params.mode === 'kaleidoscope' }),
            float('angle', 'Turn (degrees)', 0, -180, 180, { step: 1, showIf: (params) => params.mode === 'kaleidoscope' }),
            int('repeats', 'Repeats', 1, 1, 16, { showIf: (params) => params.mode === 'kaleidoscope' }),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `vec2 symmetric(vec2 uv) {
    if (p_mode == 0) return vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y);
    if (p_mode == 1) return vec2(uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y);
    if (p_mode == 2) return vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y);
    if (p_mode == 3) {
        vec2 m = vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y);
        return m.y > m.x ? m.yx : m;
    }
    float n = float(p_repeats);
    vec2 cell = floor(uv * n);
    vec2 p = fract(uv * n) - p_centre;
    float turn = radians(p_angle);
    float slice = TAU / float(max(2, p_segments));
    float a = atan(p.y, p.x) - turn;
    a -= slice * floor(a / slice);
    if (a > slice * 0.5) a = slice - a;
    return (cell + p_centre + length(p) * vec2(cos(a + turn), sin(a + turn))) / n;
}
void main() { outColor = c_in(symmetric(vUv)); }`,
    }),
    filter({
        type: 'trapezoid',
        label: 'Trapezoid',
        category: 'Transforms',
        description: 'Narrows or widens the picture toward the top, as if tilted away: a keystone. What falls outside is see-through, or the picture repeats.',
        keywords: ['trapezoid', 'keystone', 'perspective', 'taper', 'tilt'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('top', 'Top width', 0.6, 0.05, 2), float('bottom', 'Bottom width', 1, 0.05, 2), float('shift', 'Top shift', 0, -1, 1), bool('repeat', 'Repeat', false)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    float width = mix(p_bottom, p_top, vUv.y);
    vec2 p = vec2((vUv.x - 0.5 - p_shift * vUv.y) / width + 0.5, vUv.y);
    if (p_repeat == 0 && (p.x < 0.0 || p.x > 1.0)) { outColor = vec4(0.0); return; }
    outColor = c_in(p);
}`,
    }),
    filter({
        type: 'quadTransform',
        label: 'Quad transform',
        category: 'Transforms',
        description: 'Places the picture into any four-cornered shape: drag each corner where it should go. What falls outside is see-through, or the picture repeats.',
        keywords: ['quad', 'corner pin', 'four corners', 'perspective', 'distort'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            vec2('topLeft', 'Top left', [0, 1], -1, 2), vec2('topRight', 'Top right', [1, 1], -1, 2),
            vec2('bottomLeft', 'Bottom left', [0, 0], -1, 2), vec2('bottomRight', 'Bottom right', [1, 0], -1, 2), bool('repeat', 'Repeat', false),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `${INVERSE_BILINEAR_GLSL}
void main() {
    vec2 st = inverseBilinear(vUv, p_bottomLeft, p_bottomRight, p_topLeft, p_topRight);
    if (p_repeat == 0 && (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0 || st.x != st.x)) { outColor = vec4(0.0); return; }
    outColor = c_in(st);
}`,
    }),
    filter({
        type: 'mapRotation',
        label: 'Rotate by map',
        category: 'Transforms',
        description: 'Turns the picture by an amount a grey map gives at each place (mid grey none, black and white the most either way), about each cell\'s middle or the picture\'s.',
        keywords: ['non-uniform rotation', 'rotate by map', 'swirl by map', 'twist', 'turn map'],
        inputs: [anyIn('in', 'Input'), grayIn('rotation', 'Turn', 'mid')],
        outputs: [out('any')],
        params: [float('range', 'Most turn (degrees)', 90, 0, 360, { step: 1 }), select('around', 'About', 'cells', [['cells', 'Each cell\'s middle'], ['centre', 'The picture\'s middle']]), int('cells', 'Cells', 4, 1, 64, { showIf: (params) => params.around !== 'centre' })],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    float n = p_around == 1 ? 1.0 : float(p_cells);
    vec2 centre = (floor(vUv * n) + 0.5) / n;
    float a = (g_rotation(vUv) - 0.5) * 2.0 * radians(p_range);
    outColor = c_in(centre + rotate2(a) * (vUv - centre));
}`,
    }),
    {
        type: 'autoCrop',
        label: 'Auto crop',
        category: 'Transforms',
        description: 'Finds the box round what the picture holds (what is not see-through, or not dark) and stretches that box to fill, with a margin if you like.',
        keywords: ['auto crop', 'trim', 'fit to content', 'bounding box', 'crop'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('by', 'Holds', 'alpha', [['alpha', 'What is not see-through'], ['brightness', 'What is not dark']]), float('threshold', 'Threshold', 0.05, 0, 1), float('margin', 'Margin', 0, 0, 0.5)],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const gpu = context.gpu;
            // Each pixel that holds something gives its place; halved two by two, the smallest and largest are kept.
            let level = context.image('color', input.width, input.height, 32);
            await gpu.pass(level, {
                fragment: `uniform int uBy;\nuniform float uThreshold;\nvoid main() { vec4 c = texture(source, vUv); float held = uBy == 0 ? c.a : luma(c.rgb); outColor = held > uThreshold ? vec4(vUv, vUv) : vec4(1e9, 1e9, -1e9, -1e9); }`,
                inputs: { source: input }, uniforms: { uBy: context.params.by === 'brightness' ? 1 : 0, uThreshold: num(context.params, 'threshold', 0.05) },
            });
            while (level.width > 1 || level.height > 1) {
                const next = context.image('color', Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), 32);
                await gpu.pass(next, {
                    fragment: `void main() { ivec2 size = textureSize(source, 0); ivec2 base = ivec2(gl_FragCoord.xy) * 2; vec4 box = vec4(1e9, 1e9, -1e9, -1e9);
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) { vec4 v = texelFetch(source, min(base + ivec2(x, y), size - 1), 0); box = vec4(min(box.xy, v.xy), max(box.zw, v.zw)); }
    outColor = box; }`,
                    inputs: { source: level },
                });
                gpu.release(level);
                level = next;
            }
            await context.pass(result, `uniform sampler2D box;
void main() {
    vec4 b = texelFetch(box, ivec2(0), 0);
    if (b.x > b.z) { outColor = c_in(vUv); return; }
    vec2 low = b.xy - p_margin;
    vec2 high = b.zw + p_margin;
    outColor = texture(t_in, low + vUv * (high - low));
}`, { inputs: { box: level } });
            return { out: result };
        },
    },
    filter({
        type: 'clone',
        label: 'Clone',
        category: 'Transforms',
        description: 'Copies a round (or square) patch of the picture from one place onto another, its edge soft: covers a flaw, or repeats a feature.',
        keywords: ['clone', 'stamp', 'copy patch', 'heal', 'duplicate area'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [vec2('from', 'From', [0.3, 0.5], 0, 1), vec2('to', 'To', [0.7, 0.5], 0, 1), float('size', 'Size', 0.15, 0.005, 0.5), float('softness', 'Softness', 0.3, 0, 1), select('shape', 'Shape', 'circle', [['circle', 'Round'], ['square', 'Square']])],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 d = vUv - p_to;
    d -= floor(d + 0.5);
    float distanceTo = p_shape == 1 ? max(abs(d.x), abs(d.y)) : length(d);
    float m = 1.0 - smoothstep(p_size * (1.0 - p_softness) - 1e-4, p_size, distanceTo);
    outColor = mix(c_in(vUv), c_in(vUv - p_to + p_from), m);
}`,
    }),
    {
        type: 'noiseUpscale',
        label: 'Noise upscale',
        category: 'Transforms',
        description: 'Adds finer detail to a picture from itself: copies twice, four times... as fine, each turned and shifted at random, blended in fainter.',
        keywords: ['noise upscale', 'detail', 'self similar', 'enlarge', 'add detail'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [int('octaves', 'Finer copies', 3, 1, 6), float('roughness', 'Roughness', 0.5, 0, 1), seed()],
        sizeFrom: 'input',
        kindFrom: 'in',
        settingsInShader: true,
        async run(context) {
            const image = context.image(context.outputKind('out'));
            const copies = upscaleCopies(6, context.seed);
            await context.pass(image, `uniform vec4 uTurns[2];
uniform vec4 uShifts[3];
vec2 turned(vec2 p, int turn) { return turn == 1 ? vec2(-p.y, p.x) : turn == 2 ? -p : turn == 3 ? vec2(p.y, -p.x) : p; }
void main() {
    vec4 sum = c_in(vUv);
    float total = 1.0;
    float amplitude = 1.0;
    float scale = 1.0;
    for (int k = 0; k < 6; k++) {
        if (k >= p_octaves) break;
        amplitude *= p_roughness;
        scale *= 2.0;
        int turn = int(uTurns[k / 4][k % 4] + 0.5);
        vec2 shift = k % 2 == 0 ? uShifts[k / 2].xy : uShifts[k / 2].zw;
        sum += c_in(turned(vUv * scale, turn) + shift) * amplitude;
        total += amplitude;
    }
    outColor = sum / total;
}`, {
                uniforms: {
                    uTurns: [0, 1].map((group) => new THREE.Vector4(...[0, 1, 2, 3].map((index) => copies[group * 4 + index]?.turn ?? 0))),
                    uShifts: [0, 1, 2].map((group) => new THREE.Vector4(...copies[group * 2].shift, ...copies[group * 2 + 1].shift)),
                },
                cost: num(context.params, 'octaves', 3) + 1,
            });
            return { out: image };
        },
    },
];

/** The CPU twins of the nodes that move the picture about: the result at a place from a reader of the input. */
export const FILTER_REFERENCES: Record<string, (read: Read, u: number, v: number, params: Params, seed: number, maps?: Record<string, Read>) => number> = {
    skew: (read, u, v, params) => {
        const m = skewMatrix(num(params, 'amount', 0.3), String(params.axis));
        const offset = pair(params, 'offset', [0, 0]);
        const at = (x: number, y: number) => read(...transformPlace(m, offset, x, y));
        return params.seamless === false ? at(u, v) : blendedSample(at, u, v, num(params, 'blend', 0.15));
    },
    symmetry: (read, u, v, params) => read(...symmetryPlace(u, v, params)),
    mapRotation: (read, u, v, params, _seed, maps) => read(...mapRotationPlace(u, v, maps?.rotation?.(u, v) ?? 0.5, params)),
    clone: (read, u, v, params) => {
        const [fx, fy] = pair(params, 'from', [0.3, 0.5]);
        const [tx, ty] = pair(params, 'to', [0.7, 0.5]);
        const m = cloneMask(u, v, params);
        return read(u, v) * (1 - m) + read(u - tx + fx, v - ty + fy) * m;
    },
    noiseUpscale: (read, u, v, params, seedValue) => {
        const copies = upscaleCopies(6, seedValue);
        let sum = read(u, v);
        let total = 1;
        let amplitude = 1;
        let scale = 1;
        for (let k = 0; k < whole(params, 'octaves', 3); k++) {
            amplitude *= num(params, 'roughness', 0.5);
            scale *= 2;
            const x = u * scale;
            const y = v * scale;
            const [tx, ty] = copies[k].turn === 1 ? [-y, x] : copies[k].turn === 2 ? [-x, -y] : copies[k].turn === 3 ? [y, -x] : [x, y];
            sum += read(tx + copies[k].shift[0], ty + copies[k].shift[1]) * amplitude;
            total += amplitude;
        }
        return sum / total;
    },
};
