import { TAU, fract, hash1, saturate, smoothstep, wrap } from '../noiseMath';
import { tileSafeDirection } from '../safeTransform';
import { bool, float, int, out, seed, select, vec2 } from '../nodeKit';
import type { TexNodeDef } from '../types';

/**
 * PATTERNS
 *
 * Stripes, starbursts, arc pavement, triangle grids, woven cloth, and radial, axial and circular
 * gradients. Each tiles: counts are whole numbers, directions are snapped to ones a repeating picture
 * stays seamless along, and shapes made once a cell repeat with their cells. Each shader has its CPU
 * twin below (PATTERN_REFERENCES), for the tests.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const whole = (params: Params, key: string, fallback: number): number => Math.round(num(params, key, fallback));
const pair = (params: Params, key: string, fallback: [number, number]): [number, number] => (Array.isArray(params[key]) ? [Number((params[key] as number[])[0]), Number((params[key] as number[])[1])] : fallback);
const optionIndex = (params: Params, key: string, options: readonly string[]): number => Math.max(0, options.indexOf(String(params[key])));

/** A one-pass pattern; `uniforms` work out what the shader needs from the settings. */
const pattern = (definition: Omit<TexNodeDef, 'run' | 'sizeFrom'> & { glsl: string; cost?: number; uniforms?: (params: Params) => Record<string, unknown> }): TexNodeDef => {
    const { glsl, cost, uniforms, ...rest } = definition;
    return {
        ...rest,
        sizeFrom: 'graph',
        settingsInShader: !uniforms,
        async run(context) {
            const key = rest.outputs[0].key;
            const image = context.image(context.outputKind(key));
            await context.pass(image, glsl, { cost: cost ?? 2, ...(uniforms ? { uniforms: uniforms(context.params) } : {}) });
            return { [key]: image };
        },
    };
};

const PROFILES = ['square', 'sine', 'saw'] as const;
const FALLOFFS = ['linear', 'smooth', 'sphere'] as const;
const WEAVES = ['plain', 'twill', 'satin', 'basket'] as const;
/** How many threads a weave's pattern takes before it repeats. */
const WEAVE_REPEAT = [2, 4, 5, 4];

const falloffGlsl = `float falloff(float t, int kind) {
    t = saturate(t);
    if (kind == 1) return t * t * (3.0 - 2.0 * t);
    if (kind == 2) return sqrt(1.0 - (1.0 - t) * (1.0 - t));
    return t;
}`;
const falloff = (t0: number, kind: number): number => {
    const t = saturate(t0);
    return kind === 1 ? t * t * (3 - 2 * t) : kind === 2 ? Math.sqrt(1 - (1 - t) * (1 - t)) : t;
};

// ---- arc pavement ----

/** The stone of an arc pavement at a place in cells (scales overlapping row on row, each split into rings of stones). */
const ARC_GLSL = `vec3 arcStone(vec2 p, ivec2 period, int rings, float segments, float gap, float seed) {
    // Scales sit a row apart, every other row shifted half a scale; a later row lies over the one before.
    int row = int(floor(p.y));
    for (int dj = 1; dj >= -1; dj--) {
        int j = row + dj;
        float shift = (((j % 2) + 2) % 2 == 1) ? 0.5 : 0.0;
        int i = int(floor(p.x - shift + 0.5));
        for (int di = -1; di <= 1; di++) {
            // Rows lie half a fan apart: heights count half.
            vec2 d = vec2(p.x - (float(i + di) + shift), (p.y - float(j)) * 0.5);
            float r = length(d) / 0.75;
            if (r >= 1.0 || d.y > 0.0) continue;
            ivec2 cell = wrapCell(ivec2(i + di, j), period);
            float ringT = r * float(rings);
            int ring = int(floor(ringT));
            float angle = atan(-d.y, d.x) / 3.14159265;
            float count = max(1.0, floor(segments * (float(ring) + 1.0) / float(rings) + 0.5));
            float segT = angle * count;
            int segment = int(floor(segT));
            float edge = min(min(fract(ringT), 1.0 - fract(ringT)) / float(rings), min(fract(segT), 1.0 - fract(segT)) / count * r * 3.14159265);
            float stone = hash1(ivec2(cell.x * 64 + ring, cell.y * 64 + segment), seed);
            return vec3(stone, smoothstep(gap * 0.5, gap * 0.5 + 0.01, edge * 0.75), 1.0);
        }
    }
    return vec3(0.0);
}`;

const arcStone = (px: number, py: number, periodX: number, periodY: number, rings: number, segments: number, gap: number, s: number): [number, number, number] => {
    const row = Math.floor(py);
    for (let dj = 1; dj >= -1; dj--) {
        const j = row + dj;
        const shift = ((j % 2) + 2) % 2 === 1 ? 0.5 : 0;
        const i = Math.floor(px - shift + 0.5);
        for (let di = -1; di <= 1; di++) {
            const dx = px - (i + di + shift);
            const dy = (py - j) * 0.5;
            const r = Math.hypot(dx, dy) / 0.75;
            if (r >= 1 || dy > 0) continue;
            const cx = wrap(i + di, periodX);
            const cy = wrap(j, periodY);
            const ringT = r * rings;
            const ring = Math.floor(ringT);
            const angle = Math.atan2(-dy, dx) / Math.PI;
            const count = Math.max(1, Math.floor(segments * (ring + 1) / rings + 0.5));
            const segT = angle * count;
            const segment = Math.floor(segT);
            const edge = Math.min(Math.min(fract(ringT), 1 - fract(ringT)) / rings, Math.min(fract(segT), 1 - fract(segT)) / count * r * Math.PI);
            const stone = hash1(cx * 64 + ring, cy * 64 + segment, s);
            return [stone, smoothstep(gap * 0.5, gap * 0.5 + 0.01, edge * 0.75), 1];
        }
    }
    return [0, 0, 0];
};

// ---- triangle grid ----

const TRIANGLE_GLSL = `vec3 triangleAt(vec2 p, ivec2 period, float seed) {
    int row = int(floor(p.y));
    float shift = (((row % 2) + 2) % 2 == 1) ? 0.5 : 0.0;
    float x = p.x + shift;
    int i = int(floor(x));
    float fx = fract(x);
    float fy = fract(p.y);
    float side = 0.5 * (1.0 - fy) - abs(fx - 0.5);
    int index;
    float edge;
    if (side >= 0.0) {
        index = 2 * i;
        edge = min(fy, side * 0.894);
    } else {
        index = fx < 0.5 ? 2 * i - 1 : 2 * i + 1;
        edge = min(1.0 - fy, -side * 0.894);
    }
    return vec3(hash1(wrapCell(ivec2(index, row), period), seed), edge, side >= 0.0 ? 1.0 : 0.0);
}`;

const triangleAt = (px: number, py: number, columns: number, rows: number, s: number): [number, number, number] => {
    const row = Math.floor(py);
    const shift = ((row % 2) + 2) % 2 === 1 ? 0.5 : 0;
    const x = px + shift;
    const i = Math.floor(x);
    const fx = x - i;
    const fy = py - row;
    const side = 0.5 * (1 - fy) - Math.abs(fx - 0.5);
    const index = side >= 0 ? 2 * i : fx < 0.5 ? 2 * i - 1 : 2 * i + 1;
    const edge = side >= 0 ? Math.min(fy, side * 0.894) : Math.min(1 - fy, -side * 0.894);
    return [hash1(wrap(index, 2 * columns), wrap(row, rows), s), edge, side >= 0 ? 1 : 0];
};

// ---- weave ----

const WEAVE_GLSL = `bool verticalOnTop(int i, int j, int kind) {
    if (kind == 1) return ((i + j) % 4 + 4) % 4 < 2;
    if (kind == 2) return ((i * 2 + j) % 5 + 5) % 5 == 0;
    if (kind == 3) return ((i / 2 + j / 2) % 2) == 0;
    return ((i + j) % 2) == 0;
}
int weaveCount(int count, int kind) {
    int repeat = kind == 0 ? 2 : kind == 2 ? 5 : 4;
    return ((count + repeat - 1) / repeat) * repeat;
}
vec2 weaveAt(vec2 uv, int count, int kind, float width) {
    int n = weaveCount(count, kind);
    vec2 p = uv * float(n);
    ivec2 cell = ivec2(floor(p));
    cell = ((cell % n) + n) % n;
    vec2 f = fract(p);
    float half_ = width * 0.5;
    float acrossV = (f.x - 0.5) / half_;
    float acrossH = (f.y - 0.5) / half_;
    float profileV = sqrt(saturate(1.0 - acrossV * acrossV));
    float profileH = sqrt(saturate(1.0 - acrossH * acrossH));
    bool inV = abs(f.x - 0.5) < half_;
    bool inH = abs(f.y - 0.5) < half_;
    bool top = verticalOnTop(cell.x, cell.y, kind);
    if (top) {
        if (inV) return vec2(profileV * (0.6 + 0.4 * sin(3.14159265 * f.y)), 1.0);
        if (inH) return vec2(profileH * 0.5, 0.5);
    } else {
        if (inH) return vec2(profileH * (0.6 + 0.4 * sin(3.14159265 * f.x)), 0.5);
        if (inV) return vec2(profileV * 0.5, 1.0);
    }
    return vec2(0.0);
}`;

const verticalOnTop = (i: number, j: number, kind: number): boolean => {
    const m = (a: number, b: number) => ((a % b) + b) % b;
    if (kind === 1) return m(i + j, 4) < 2;
    if (kind === 2) return m(i * 2 + j, 5) === 0;
    if (kind === 3) return (Math.trunc(i / 2) + Math.trunc(j / 2)) % 2 === 0;
    return (i + j) % 2 === 0;
};
/** Threads a weave has across, made a whole number of its pattern's repeats (so it tiles). */
export const weaveCount = (count: number, kind: number): number => {
    const repeat = WEAVE_REPEAT[kind] ?? 2;
    return Math.ceil(count / repeat) * repeat;
};
const weaveAt = (u: number, v: number, count: number, kind: number, width: number): [number, number] => {
    const n = weaveCount(count, kind);
    const px = u * n;
    const py = v * n;
    const i = wrap(Math.floor(px), n);
    const j = wrap(Math.floor(py), n);
    const fx = px - Math.floor(px);
    const fy = py - Math.floor(py);
    const half = width * 0.5;
    const acrossV = (fx - 0.5) / half;
    const acrossH = (fy - 0.5) / half;
    const profileV = Math.sqrt(saturate(1 - acrossV * acrossV));
    const profileH = Math.sqrt(saturate(1 - acrossH * acrossH));
    const inV = Math.abs(fx - 0.5) < half;
    const inH = Math.abs(fy - 0.5) < half;
    if (verticalOnTop(i, j, kind)) {
        if (inV) return [profileV * (0.6 + 0.4 * Math.sin(Math.PI * fy)), 1];
        if (inH) return [profileH * 0.5, 0.5];
    } else {
        if (inH) return [profileH * (0.6 + 0.4 * Math.sin(Math.PI * fx)), 0.5];
        if (inV) return [profileV * 0.5, 1];
    }
    return [0, 0];
};

const repeats = () => int('repeats', 'Repeats', 1, 1, 64, { hint: 'How many times it repeats across and down.' });

export const PATTERN_NODES: TexNodeDef[] = [
    pattern({
        type: 'stripes',
        label: 'Stripes',
        category: 'Patterns',
        description: 'Parallel stripes at any angle (snapped to one that stays seamless), hard, soft, rounded or ramped, straight or wavy.',
        keywords: ['stripes', 'lines', 'bands', 'pinstripe', 'zebra', 'wavy lines'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('count', 'Stripes', 8, 1, 256, { softMax: 64 }),
            float('angle', 'Direction (degrees)', 0, -180, 180, { step: 1, hint: 'Snapped to the nearest direction a repeating picture stays seamless along.' }),
            select('profile', 'Shape', 'square', [['square', 'Hard or soft'], ['sine', 'Rounded'], ['saw', 'Ramp']]),
            float('width', 'Width', 0.5, 0, 1), float('softness', 'Softness', 0.1, 0, 1),
            float('wave', 'Wave', 0, 0, 1), int('waves', 'Waves along', 2, 1, 32),
        ],
        uniforms: (params) => ({ uDir: tileSafeDirection(num(params, 'angle', 0)).step }),
        glsl: `uniform ivec2 uDir;
void main() {
    vec2 d = vec2(uDir);
    float q = dot(vUv, d) * float(p_count) + p_wave * 0.25 * sin(TAU * dot(vUv, vec2(-d.y, d.x)) * float(p_waves));
    float v;
    if (p_profile == 1) v = 0.5 + 0.5 * cos(TAU * q);
    else if (p_profile == 2) v = fract(q);
    else {
        float c = abs(fract(q) - 0.5);
        float soft = max(p_softness * 0.25, 1e-4);
        v = 1.0 - smoothstep(p_width * 0.5 - soft, p_width * 0.5 + soft, c);
    }
    outColor = vec4(v);
}`,
    }),
    pattern({
        type: 'starburst',
        label: 'Starburst',
        category: 'Patterns',
        description: 'Rays from a centre, straight or twisted, fading out or not; repeated across and down.',
        keywords: ['starburst', 'rays', 'sunburst', 'radial lines', 'spokes'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('rays', 'Rays', 12, 1, 128), float('width', 'Ray width', 0.5, 0, 1), float('softness', 'Softness', 0.2, 0, 1),
            float('twist', 'Twist', 0, -4, 4), float('fade', 'Fade outward', 0.5, 0, 1), repeats(),
        ],
        glsl: `void main() {
    vec2 p = fract(vUv * float(p_repeats)) - 0.5;
    float r = length(p);
    float a = atan(p.y, p.x) / TAU + 0.5 + p_twist * r;
    float c = abs(fract(a * float(p_rays)) - 0.5);
    float soft = max(p_softness * 0.25, 1e-4);
    float v = 1.0 - smoothstep(p_width * 0.5 - soft, p_width * 0.5 + soft, c);
    outColor = vec4(v * (1.0 - smoothstep(0.0, 0.7071, r) * p_fade));
}`,
    }),
    pattern({
            type: 'arcPavement',
            label: 'Arc pavement',
            category: 'Patterns',
            description: 'Cobblestones laid in overlapping fans, row on row, each fan rings of small stones.',
            keywords: ['arc pavement', 'fan', 'cobbles', 'scallop', 'cobblestone', 'paving', 'fish scale'],
            inputs: [],
            outputs: [out('gray')],
            params: [int('columns', 'Fans across', 4, 1, 32), int('rows', 'Rows', 8, 2, 64, { step: 2, hint: 'Kept even, so the shifted rows meet at the edges.' }), int('rings', 'Rings a fan', 4, 1, 12), float('segments', 'Stones in the outer ring', 9, 1, 32), float('gap', 'Gap', 0.04, 0, 0.2), seed()],
            cost: 9,
            glsl: `${ARC_GLSL}
void main() {
    int rows = ((p_rows + 1) / 2) * 2;
    vec2 p = vUv * vec2(float(p_columns), float(rows));
    vec3 s = arcStone(p, tilePeriod(ivec2(p_columns, rows)), p_rings, p_segments, p_gap, uSeed);
    outColor = vec4(s.z > 0.5 ? (0.35 + 0.65 * s.x) * s.y : 0.0);
}`,
        }),
    pattern({
        type: 'triangleGrid',
        label: 'Triangle grid',
        category: 'Patterns',
        description: 'Rows of triangles pointing up and down, each its own shade, with gaps between them.',
        keywords: ['triangles', 'triangle grid', 'tri tiles', 'geometric', 'mosaic'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('columns', 'Across', 6, 1, 64), int('rows', 'Rows', 6, 2, 64, { step: 2, hint: 'Kept even, so the shifted rows meet at the edges.' }), float('gap', 'Gap', 0.04, 0, 0.3), float('variation', 'Shade variety', 0.6, 0, 1), seed()],
        glsl: `${TRIANGLE_GLSL}
void main() {
    int rows = ((p_rows + 1) / 2) * 2;
    vec3 t = triangleAt(vUv * vec2(float(p_columns), float(rows)), tilePeriod(ivec2(2 * p_columns, rows)), uSeed);
    float shade = 1.0 - p_variation + p_variation * t.x;
    outColor = vec4(shade * smoothstep(p_gap * 0.5, p_gap * 0.5 + 0.02, t.y));
}`,
    }),
    {
        type: 'weaveGenerator',
        label: 'Weave generator',
        category: 'Patterns',
        description: 'Woven cloth: threads over and under in plain, twill, satin or basket weave, as a height and as which way each visible thread runs.',
        keywords: ['weave', 'cloth', 'fabric', 'twill', 'satin', 'basket', 'textile', 'threads'],
        inputs: [],
        outputs: [out('gray', 'out', 'Height'), out('gray', 'threads', 'Thread direction')],
        params: [
            int('count', 'Threads across', 16, 2, 256, { softMax: 64, hint: 'Rounded up to whole repeats of the weave, so it tiles.' }),
            select('weave', 'Weave', 'plain', [['plain', 'Plain'], ['twill', 'Twill'], ['satin', 'Satin'], ['basket', 'Basket']]),
            float('width', 'Thread width', 0.8, 0.1, 1),
        ],
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const height = context.image('gray');
            const threads = context.image('gray');
            await context.pass(height, `${WEAVE_GLSL}\nvoid main() { outColor = vec4(weaveAt(vUv, p_count, p_weave, p_width).x); }`, { cost: 2 });
            await context.pass(threads, `${WEAVE_GLSL}\nvoid main() { outColor = vec4(weaveAt(vUv, p_count, p_weave, p_width).y); }`, { cost: 2 });
            return { out: height, threads };
        },
    },
    pattern({
        type: 'radialGradient',
        label: 'Radial gradient',
        category: 'Patterns',
        description: 'A gradient sweeping round a centre, black to white once (or more) round.',
        keywords: ['radial gradient', 'angle gradient', 'sweep', 'conic', 'angular'],
        inputs: [],
        outputs: [out('gray')],
        params: [vec2('centre', 'Centre', [0.5, 0.5], 0, 1), float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }), int('turns', 'Sweeps round', 1, 1, 32), bool('mirror', 'There and back', false), repeats()],
        glsl: `void main() {
    vec2 p = fract(vUv * float(p_repeats)) - p_centre;
    float a = fract((atan(p.y, p.x) / TAU + 0.5 + p_rotation / 360.0) * float(p_turns));
    outColor = vec4(p_mirror == 1 ? 1.0 - abs(a * 2.0 - 1.0) : a);
}`,
    }),
    pattern({
        type: 'axialGradient',
        label: 'Axial gradient',
        category: 'Patterns',
        description: 'A gradient out both ways from a line through the centre: white on the line, fading to black either side.',
        keywords: ['axial gradient', 'reflected gradient', 'mirrored gradient', 'band', 'ridge'],
        inputs: [],
        outputs: [out('gray')],
        params: [vec2('centre', 'Centre', [0.5, 0.5], 0, 1), float('angle', 'Line direction (degrees)', 0, -360, 360, { step: 1 }), float('spread', 'Spread', 0.5, 0.01, 2), select('falloff', 'Falloff', 'linear', [['linear', 'Straight'], ['smooth', 'Smooth'], ['sphere', 'Rounded']]), repeats()],
        glsl: `${falloffGlsl}
void main() {
    vec2 p = fract(vUv * float(p_repeats)) - p_centre;
    float a = radians(p_angle);
    float across = abs(dot(p, vec2(-sin(a), cos(a))));
    outColor = vec4(falloff(1.0 - across / p_spread, p_falloff));
}`,
    }),
    pattern({
        type: 'circularGradient',
        label: 'Circular gradient',
        category: 'Patterns',
        description: 'A gradient out from a centre in circles (or ovals): white in the middle, black at the radius, or rings.',
        keywords: ['circular gradient', 'radial falloff', 'disc', 'vignette', 'rings', 'spherical'],
        inputs: [],
        outputs: [out('gray')],
        params: [vec2('centre', 'Centre', [0.5, 0.5], 0, 1), float('radius', 'Radius', 0.5, 0.01, 2), vec2('stretch', 'Stretch', [1, 1], 0.1, 4), select('falloff', 'Falloff', 'linear', [['linear', 'Straight'], ['smooth', 'Smooth'], ['sphere', 'Rounded']]), int('rings', 'Rings', 1, 1, 32), repeats()],
        glsl: `${falloffGlsl}
void main() {
    vec2 p = (fract(vUv * float(p_repeats)) - p_centre) / max(p_stretch, vec2(1e-3));
    float t = length(p) / p_radius;
    float v = p_rings > 1 ? 1.0 - fract(t * float(p_rings)) : 1.0 - t;
    outColor = vec4(falloff(v, p_falloff));
}`,
    }),
];

/** The CPU twins of the shaders: a place to a value, for the settings (defaults filled in) and the shader seed. */
export const PATTERN_REFERENCES: Record<string, (u: number, v: number, params: Params, seed: number) => number> = {
    stripes: (u, v, params) => {
        const [a, b] = tileSafeDirection(num(params, 'angle', 0)).step;
        const q = (u * a + v * b) * whole(params, 'count', 8) + num(params, 'wave', 0) * 0.25 * Math.sin(TAU * (-u * b + v * a) * whole(params, 'waves', 2));
        const profile = optionIndex(params, 'profile', PROFILES);
        if (profile === 1) return 0.5 + 0.5 * Math.cos(TAU * q);
        if (profile === 2) return fract(q);
        const c = Math.abs(fract(q) - 0.5);
        const soft = Math.max(num(params, 'softness', 0.1) * 0.25, 1e-4);
        const width = num(params, 'width', 0.5);
        return 1 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, c);
    },
    starburst: (u, v, params) => {
        const n = whole(params, 'repeats', 1);
        const px = fract(u * n) - 0.5;
        const py = fract(v * n) - 0.5;
        const r = Math.hypot(px, py);
        const a = Math.atan2(py, px) / TAU + 0.5 + num(params, 'twist', 0) * r;
        const c = Math.abs(fract(a * whole(params, 'rays', 12)) - 0.5);
        const soft = Math.max(num(params, 'softness', 0.2) * 0.25, 1e-4);
        const width = num(params, 'width', 0.5);
        return (1 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, c)) * (1 - smoothstep(0, 0.7071, r) * num(params, 'fade', 0.5));
    },
    arcPavement: (u, v, params, s) => {
        const columns = whole(params, 'columns', 4);
        const rows = Math.ceil(whole(params, 'rows', 8) / 2) * 2;
        const [stone, edge, inside] = arcStone(u * columns, v * rows, columns, rows, whole(params, 'rings', 4), num(params, 'segments', 9), num(params, 'gap', 0.04), s);
        return inside > 0.5 ? (0.35 + 0.65 * stone) * edge : 0;
    },
    triangleGrid: (u, v, params, s) => {
        const columns = whole(params, 'columns', 6);
        const rows = Math.ceil(whole(params, 'rows', 6) / 2) * 2;
        const [shade, edge] = triangleAt(u * columns, v * rows, columns, rows, s);
        const variation = num(params, 'variation', 0.6);
        const gap = num(params, 'gap', 0.04);
        return (1 - variation + variation * shade) * smoothstep(gap * 0.5, gap * 0.5 + 0.02, edge);
    },
    weaveGenerator: (u, v, params) => weaveAt(u, v, whole(params, 'count', 16), optionIndex(params, 'weave', WEAVES), num(params, 'width', 0.8))[0],
    weaveThreads: (u, v, params) => weaveAt(u, v, whole(params, 'count', 16), optionIndex(params, 'weave', WEAVES), num(params, 'width', 0.8))[1],
    radialGradient: (u, v, params) => {
        const n = whole(params, 'repeats', 1);
        const [cx, cy] = pair(params, 'centre', [0.5, 0.5]);
        const px = fract(u * n) - cx;
        const py = fract(v * n) - cy;
        const a = fract((Math.atan2(py, px) / TAU + 0.5 + num(params, 'rotation', 0) / 360) * whole(params, 'turns', 1));
        return params.mirror ? 1 - Math.abs(a * 2 - 1) : a;
    },
    axialGradient: (u, v, params) => {
        const n = whole(params, 'repeats', 1);
        const [cx, cy] = pair(params, 'centre', [0.5, 0.5]);
        const px = fract(u * n) - cx;
        const py = fract(v * n) - cy;
        const a = num(params, 'angle', 0) * Math.PI / 180;
        const across = Math.abs(-px * Math.sin(a) + py * Math.cos(a));
        return falloff(1 - across / num(params, 'spread', 0.5), optionIndex(params, 'falloff', FALLOFFS));
    },
    circularGradient: (u, v, params) => {
        const n = whole(params, 'repeats', 1);
        const [cx, cy] = pair(params, 'centre', [0.5, 0.5]);
        const [sx, sy] = pair(params, 'stretch', [1, 1]);
        const px = (fract(u * n) - cx) / Math.max(sx, 1e-3);
        const py = (fract(v * n) - cy) / Math.max(sy, 1e-3);
        const t = Math.hypot(px, py) / num(params, 'radius', 0.5);
        const rings = whole(params, 'rings', 1);
        return falloff(rings > 1 ? 1 - fract(t * rings) : 1 - t, optionIndex(params, 'falloff', FALLOFFS));
    },
};

