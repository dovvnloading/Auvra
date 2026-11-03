import { anyIn, bool, colorIn, float, grayIn, int, onePass, out, seed, select, vec2 } from '../nodeKit';
import type { TexNodeDef } from '../types';

/** Noises, patterns and shapes: nodes that make an image from nothing (or shape what they are given). */

const NOISE_KINDS: ReadonlyArray<[string, string]> = [['perlin', 'Gradient (Perlin)'], ['value', 'Value'], ['cells', 'Cells']];
const FRACTAL_STYLES: ReadonlyArray<[string, string]> = [['fbm', 'Smooth'], ['ridged', 'Ridged'], ['billow', 'Billowy'], ['turbulence', 'Turbulent']];

export const GENERATOR_NODES: TexNodeDef[] = [
    onePass({
        type: 'perlinNoise',
        label: 'Perlin noise',
        category: 'Noises',
        description: 'Smooth gradient noise that tiles. Scale is how many cells fit across.',
        keywords: ['gradient noise', 'perlin', 'smooth'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scale', 'Scale', 8, 1, 256, { softMax: 64 }), float('contrast', 'Contrast', 1, 0, 4), seed()],
        sizeFrom: 'graph',
        glsl: `void main() {
    float n = perlin(vUv * float(p_scale), ivec2(p_scale), uSeed);
    outColor = vec4(saturate(0.5 + 0.5 * n * p_contrast));
}`,
    }),
    onePass({
        type: 'fractalSum',
        label: 'Fractal noise',
        category: 'Noises',
        description: 'Octaves of noise added together, each twice as fine and fainter by the roughness: clouds, grunge, terrain.',
        keywords: ['fbm', 'clouds', 'fractal sum', 'turbulence', 'ridged', 'grunge', 'octaves'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            select('noise', 'Noise', 'perlin', NOISE_KINDS),
            select('style', 'Style', 'fbm', FRACTAL_STYLES),
            int('scale', 'Scale', 4, 1, 128, { softMax: 32 }),
            int('octaves', 'Octaves', 6, 1, 12),
            float('roughness', 'Roughness', 0.5, 0, 1),
            float('contrast', 'Contrast', 1, 0, 4),
            seed(),
        ],
        sizeFrom: 'graph',
        cost: (params) => Number(params.octaves) * (params.noise === 'cells' ? 25 : 4),
        glsl: `float octave(vec2 p, ivec2 period, float s) {
    if (p_noise == 0) return perlin(p, period, s);
    if (p_noise == 1) return valueNoise(p, period, s) * 2.0 - 1.0;
    return 1.0 - 2.0 * saturate(worley(p, period, 1.0, 0, s).x * 1.4);
}
void main() {
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    int scale = p_scale;
    for (int o = 0; o < 12; o++) {
        if (o >= p_octaves) break;
        float n = octave(vUv * float(scale), ivec2(scale), uSeed + float(o) * 13.17);
        if (p_style == 1) n = 1.0 - 2.0 * abs(n);
        else if (p_style == 2) n = 2.0 * abs(n) - 1.0;
        else if (p_style == 3) n = abs(n) * 2.0 - 1.0;
        sum += n * amplitude;
        total += amplitude;
        amplitude *= p_roughness;
        scale *= 2;
    }
    float v = sum / max(total, 1e-5);
    if (p_style == 1) v = v * v * sign(v);
    outColor = vec4(saturate(0.5 + 0.5 * v * p_contrast));
}`,
    }),
    onePass({
        type: 'cells',
        label: 'Cells',
        category: 'Noises',
        description: 'Cellular (Worley) noise: distance to scattered points. Gives cells, stones, scales and cracks.',
        keywords: ['worley', 'voronoi', 'cellular', 'stones', 'cracks', 'crystal'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('scale', 'Scale', 8, 1, 256, { softMax: 64 }),
            float('jitter', 'Randomness', 1, 0, 1),
            select('metric', 'Distance', 'euclidean', [['euclidean', 'Round'], ['manhattan', 'Diamond'], ['chebyshev', 'Square']]),
            select('mode', 'Shows', 'f1', [['f1', 'Distance to nearest'], ['f1inv', 'Bumps'], ['f2', 'Distance to second'], ['edges', 'Cell edges'], ['value', 'Random value per cell']]),
            float('contrast', 'Contrast', 1, 0, 4),
            seed(),
        ],
        sizeFrom: 'graph',
        cost: () => 25,
        glsl: `void main() {
    vec3 w = worley(vUv * float(p_scale), ivec2(p_scale), p_jitter, p_metric, uSeed);
    float v;
    if (p_mode == 0) v = w.x;
    else if (p_mode == 1) v = 1.0 - w.x;
    else if (p_mode == 2) v = w.y;
    else if (p_mode == 3) v = (w.y - w.x);
    else v = w.z;
    if (p_mode != 4) v = (v - 0.5) * p_contrast + 0.5;
    outColor = vec4(saturate(v));
}`,
    }),
    onePass({
        type: 'whiteNoise',
        label: 'White noise',
        category: 'Noises',
        description: 'A random value for every pixel.',
        keywords: ['random', 'grain', 'static'],
        inputs: [],
        outputs: [out('gray')],
        params: [seed()],
        sizeFrom: 'graph',
        glsl: `void main() { outColor = vec4(hash1(ivec2(gl_FragCoord.xy), uSeed)); }`,
    }),
    onePass({
        type: 'anisotropicNoise',
        label: 'Streaks',
        category: 'Noises',
        description: 'Noise stretched along one direction: brushed metal, wood grain, scratches in a direction, rain streaks.',
        keywords: ['anisotropic', 'brushed', 'streak', 'grain', 'stretched'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('scaleX', 'Across', 128, 1, 512), int('scaleY', 'Along', 4, 1, 128), int('octaves', 'Octaves', 3, 1, 8), float('smoothness', 'Smoothness', 1, 0, 1), seed()],
        sizeFrom: 'graph',
        cost: (params) => Number(params.octaves) * 4,
        glsl: `void main() {
    float sum = 0.0;
    float total = 0.0;
    float amplitude = 1.0;
    ivec2 period = ivec2(p_scaleX, p_scaleY);
    for (int o = 0; o < 8; o++) {
        if (o >= p_octaves) break;
        vec2 p = vUv * vec2(period);
        ivec2 i = ivec2(floor(p));
        vec2 f = fract(p);
        f.x = mix(step(0.5, f.x), f.x * f.x * (3.0 - 2.0 * f.x), p_smoothness);
        f.y = f.y * f.y * (3.0 - 2.0 * f.y);
        float s = uSeed + float(o) * 7.31;
        float a = hash1(wrapCell(i, period), s);
        float b = hash1(wrapCell(i + ivec2(1, 0), period), s);
        float c = hash1(wrapCell(i + ivec2(0, 1), period), s);
        float d = hash1(wrapCell(i + ivec2(1, 1), period), s);
        sum += mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        period *= 2;
    }
    outColor = vec4(sum / total);
}`,
    }),
    onePass({
        type: 'noise3d',
        label: '3D noise',
        category: 'Mesh maps',
        description: 'Fractal noise in 3D, read at each pixel\'s place on the model, so it runs across UV seams unbroken. Wire a position map in.',
        keywords: ['3d', 'solid', 'seamless', 'world', 'position'],
        inputs: [colorIn('position', 'Position')],
        outputs: [out('gray')],
        params: [float('scale', 'Scale', 6, 0.1, 200, { softMax: 50 }), int('octaves', 'Octaves', 5, 1, 10), float('roughness', 'Roughness', 0.5, 0, 1), select('style', 'Style', 'fbm', FRACTAL_STYLES), float('contrast', 'Contrast', 1, 0, 4), seed()],
        sizeFrom: 'input',
        cost: (params) => Number(params.octaves) * 8,
        glsl: `vec3 grad3(ivec3 c, float s) {
    float a = hash1(c, s) * TAU;
    float z = hash1(c, s + 9.1) * 2.0 - 1.0;
    float r = sqrt(1.0 - z * z);
    return vec3(r * cos(a), r * sin(a), z);
}
float perlin3(vec3 p, float s) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(grad3(i, s), f);
    float n100 = dot(grad3(i + ivec3(1, 0, 0), s), f - vec3(1, 0, 0));
    float n010 = dot(grad3(i + ivec3(0, 1, 0), s), f - vec3(0, 1, 0));
    float n110 = dot(grad3(i + ivec3(1, 1, 0), s), f - vec3(1, 1, 0));
    float n001 = dot(grad3(i + ivec3(0, 0, 1), s), f - vec3(0, 0, 1));
    float n101 = dot(grad3(i + ivec3(1, 0, 1), s), f - vec3(1, 0, 1));
    float n011 = dot(grad3(i + ivec3(0, 1, 1), s), f - vec3(0, 1, 1));
    float n111 = dot(grad3(i + ivec3(1, 1, 1), s), f - vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 1.6;
}
void main() {
    vec3 p = w_position == 1 ? c_position(vUv).xyz : vec3(vUv, 0.0);
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    float scale = p_scale;
    for (int o = 0; o < 10; o++) {
        if (o >= p_octaves) break;
        float n = perlin3(p * scale + float(o) * 17.3, uSeed + float(o));
        if (p_style == 1) n = 1.0 - 2.0 * abs(n);
        else if (p_style >= 2) n = 2.0 * abs(n) - 1.0;
        sum += n * amplitude;
        total += amplitude;
        amplitude *= p_roughness;
        scale *= 2.0;
    }
    outColor = vec4(saturate(0.5 + 0.5 * sum / total * p_contrast));
}`,
    }),

    // ---- shapes and patterns ----
    onePass({
        type: 'shape',
        label: 'Shape',
        category: 'Shapes',
        description: 'One shape, or a grid of them: squares, discs, polygons, stars, rings and soft bumps.',
        keywords: ['square', 'circle', 'disc', 'polygon', 'star', 'ring', 'bell', 'gaussian', 'pyramid', 'cone', 'hemisphere'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            select('shape', 'Shape', 'disc', [['square', 'Square'], ['disc', 'Disc'], ['polygon', 'Polygon'], ['star', 'Star'], ['ring', 'Ring'], ['bell', 'Soft bump'], ['paraboloid', 'Dome'], ['hemisphere', 'Hemisphere'], ['pyramid', 'Pyramid'], ['cone', 'Cone'], ['gradient', 'Gradient'], ['wave', 'Wave']]),
            int('tiling', 'Repeat', 1, 1, 64),
            float('size', 'Size', 0.8, 0, 2),
            vec2('stretch', 'Stretch', [1, 1], 0.05, 4),
            float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
            float('softness', 'Softness', 0.02, 0, 1),
            int('sides', 'Sides', 6, 3, 16, { showIf: (p) => p.shape === 'polygon' || p.shape === 'star' }),
            float('inner', 'Inner size', 0.5, 0, 1, { showIf: (p) => p.shape === 'star' || p.shape === 'ring' }),
        ],
        sizeFrom: 'graph',
        glsl: `float polygonDistance(vec2 p, float n) {
    float a = atan(p.x, p.y) + PI;
    float r = TAU / n;
    return cos(floor(0.5 + a / r) * r - a) * length(p);
}
float edge(float d) { return 1.0 - smoothstep(1.0 - p_softness - 1e-4, 1.0 + 1e-4, d); }
void main() {
    vec2 p = (fract(vUv * float(p_tiling)) - 0.5) * 2.0;
    p = rotate2(-radians(p_rotation)) * p;
    p /= max(vec2(p_size) * p_stretch, vec2(1e-4));
    float r = length(p);
    float v;
    if (p_shape == 0) v = edge(max(abs(p.x), abs(p.y)));
    else if (p_shape == 1) v = edge(r);
    else if (p_shape == 2) v = edge(polygonDistance(p, float(p_sides)));
    else if (p_shape == 3) {
        float a = atan(p.y, p.x);
        float sector = TAU / float(p_sides);
        float t = abs(mod(a + sector * 0.5, sector) - sector * 0.5) / (sector * 0.5);
        float limit = mix(1.0, max(p_inner, 0.05), t);
        v = edge(r / limit);
    }
    else if (p_shape == 4) v = edge(r) * (1.0 - edge(r / max(p_inner, 1e-3)));
    else if (p_shape == 5) v = exp(-r * r * 4.0);
    else if (p_shape == 6) v = saturate(1.0 - r * r);
    else if (p_shape == 7) v = sqrt(saturate(1.0 - r * r));
    else if (p_shape == 8) v = saturate(1.0 - max(abs(p.x), abs(p.y)));
    else if (p_shape == 9) v = saturate(1.0 - r);
    else if (p_shape == 10) v = saturate(p.x * 0.5 + 0.5);
    else v = 0.5 + 0.5 * cos(p.x * PI);
    outColor = vec4(v);
}`,
    }),
    onePass({
        type: 'gradient',
        label: 'Linear gradient',
        category: 'Shapes',
        description: 'A ramp from black to white across the image, at any angle, repeated or mirrored.',
        keywords: ['ramp', 'linear', 'gradient', 'mirror'],
        inputs: [],
        outputs: [out('gray')],
        params: [float('angle', 'Angle (degrees)', 0, -360, 360, { step: 1 }), int('repeat', 'Repeat', 1, 1, 64), bool('mirror', 'Mirrored', false)],
        sizeFrom: 'graph',
        glsl: `void main() {
    float a = radians(p_angle);
    float t = dot(vUv - 0.5, vec2(cos(a), sin(a)));
    float span = abs(cos(a)) + abs(sin(a));
    t = t / max(span, 1e-4) + 0.5;
    t = t * float(p_repeat);
    t = p_mirror == 1 ? 1.0 - abs(fract(t) * 2.0 - 1.0) : (p_repeat == 1 ? t : fract(t));
    outColor = vec4(saturate(t));
}`,
    }),
    onePass({
        type: 'checker',
        label: 'Checker',
        category: 'Patterns',
        description: 'Alternating squares.',
        keywords: ['checkerboard', 'chess'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('tiling', 'Squares across', 8, 1, 256)],
        sizeFrom: 'graph',
        glsl: `void main() { ivec2 c = ivec2(floor(vUv * float(p_tiling))); outColor = vec4(float((c.x + c.y) & 1)); }`,
    }),
    onePass({
        type: 'tiles',
        label: 'Tiles and bricks',
        category: 'Patterns',
        description: 'Rows of tiles or bricks with mortar between them, each tile its own height, with bevelled edges.',
        keywords: ['bricks', 'tile generator', 'pavers', 'planks', 'mortar', 'wall', 'floor'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('columns', 'Across', 4, 1, 128),
            int('rows', 'Down', 8, 1, 128),
            float('offset', 'Row offset', 0.5, 0, 1),
            float('offsetRandom', 'Row offset randomness', 0, 0, 1),
            float('gap', 'Gap', 0.04, 0, 0.5),
            float('bevel', 'Bevel', 0.15, 0, 1),
            select('profile', 'Bevel shape', 'smooth', [['linear', 'Straight'], ['smooth', 'Smooth'], ['round', 'Round']]),
            float('corner', 'Corner rounding', 0, 0, 1),
            float('heightRandom', 'Height randomness', 0.3, 0, 1),
            float('sizeRandom', 'Size randomness', 0, 0, 1),
            seed(),
        ],
        sizeFrom: 'graph',
        cost: () => 9,
        glsl: `void main() {
    vec2 grid = vec2(p_columns, p_rows);
    vec2 p = vUv * grid;
    float row = floor(p.y);
    ivec2 rowCell = wrapCell(ivec2(0, int(row)), ivec2(p_columns, p_rows));
    float shift = mod(row, 2.0) * p_offset + (hash1(rowCell, uSeed + 2.1) - 0.5) * p_offsetRandom;
    p.x += shift;
    vec2 cell = floor(p);
    vec2 local = fract(p);
    ivec2 id = wrapCell(ivec2(cell), ivec2(p_columns, p_rows));
    // Gap and bevel in tile units, the same thickness both ways.
    vec2 cellSize = 1.0 / grid;
    float unit = min(cellSize.x, cellSize.y);
    float shrink = (hash1(id, uSeed + 5.3)) * p_sizeRandom * 0.25;
    vec2 half_ = 0.5 - (p_gap * 0.5 * unit) / cellSize - shrink;
    vec2 d = abs(local - 0.5);
    float cornerRadius = p_corner * min(half_.x, half_.y);
    vec2 q = d - (half_ - cornerRadius);
    float outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cornerRadius;
    // Distance inside the tile, in tile units.
    float inside = -outside * min(cellSize.x, cellSize.y) / unit;
    float bevelWidth = max(p_bevel * 0.5 * min(half_.x, half_.y), 1e-4);
    float t = saturate(inside / bevelWidth);
    if (p_profile == 1) t = t * t * (3.0 - 2.0 * t);
    else if (p_profile == 2) t = sqrt(1.0 - (1.0 - t) * (1.0 - t));
    float height = 1.0 - hash1(id, uSeed) * p_heightRandom;
    outColor = vec4(outside > 0.0 ? 0.0 : t * height);
}`,
    }),
    onePass({
        type: 'hexTiles',
        label: 'Hexagons',
        category: 'Patterns',
        description: 'A honeycomb of hexagonal tiles with gaps and bevels.',
        keywords: ['hexagon', 'honeycomb', 'hex'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('rows', 'Rows', 6, 1, 64), float('gap', 'Gap', 0.06, 0, 0.5), float('bevel', 'Bevel', 0.3, 0, 1), float('heightRandom', 'Height randomness', 0.2, 0, 1), seed()],
        sizeFrom: 'graph',
        glsl: `float hexDistance(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }
void main() {
    // Columns are rounded so hexagons stay close to regular and the image still repeats exactly.
    vec2 r = vec2(1.0, 1.7320508);
    float across = max(1.0, floor(float(p_rows) * 1.7320508 + 0.5));
    vec2 p = vUv * vec2(across, float(p_rows) * r.y);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 centre = p - g;
    ivec2 id = wrapCell(ivec2(floor(centre.x * 2.0 + 0.5), floor(centre.y / 0.8660254 + 0.5)), ivec2(int(across) * 2, p_rows * 2));
    float inside = 0.5 - hexDistance(g) - p_gap * 0.5;
    float t = saturate(inside / max(p_bevel * 0.5, 1e-4));
    t = t * t * (3.0 - 2.0 * t);
    float height = 1.0 - hash1(id, uSeed) * p_heightRandom;
    outColor = vec4(inside <= 0.0 ? 0.0 : t * height);
}`,
    }),
    onePass({
        type: 'weave',
        label: 'Weave',
        category: 'Patterns',
        description: 'Threads passing over and under each other: cloth, carbon fibre, wicker.',
        keywords: ['fabric', 'cloth', 'carbon', 'wicker', 'basket', 'twill'],
        inputs: [],
        outputs: [out('gray')],
        params: [int('tiling', 'Threads across', 8, 1, 256), float('width', 'Thread width', 0.85, 0.05, 1), float('roundness', 'Roundness', 1, 0, 1), select('pattern', 'Pattern', 'plain', [['plain', 'Plain'], ['twill', 'Twill']])],
        sizeFrom: 'graph',
        glsl: `float thread(float across, float along, bool over) {
    float d = abs(across - 0.5) * 2.0 / p_width;
    if (d > 1.0) return 0.0;
    float profile = mix(1.0, sqrt(1.0 - d * d), p_roundness);
    float dip = 0.5 + 0.5 * cos(along * TAU);
    float lift = over ? mix(0.55, 1.0, 1.0 - dip) : mix(0.55, 1.0, dip);
    return profile * lift;
}
void main() {
    vec2 p = vUv * float(p_tiling);
    ivec2 c = ivec2(floor(p));
    vec2 f = fract(p);
    int phase = p_pattern == 0 ? (c.x + c.y) & 1 : ((c.x + c.y) / 2) & 1;
    bool warpOver = phase == 0;
    float warp = thread(f.x, f.y * 0.5 + float(c.y & 1) * 0.5, warpOver);
    float weft = thread(f.y, f.x * 0.5 + float(c.x & 1) * 0.5, !warpOver);
    outColor = vec4(warpOver ? max(warp, weft * 0.6) : max(weft, warp * 0.6));
}`,
    }),
    onePass({
        type: 'scratches',
        label: 'Scratches',
        category: 'Patterns',
        description: 'Thin random strokes: scratches, cuts and fibres, mostly along one direction or any way.',
        keywords: ['scratch', 'scuff', 'lines', 'wear', 'fibres'],
        inputs: [],
        outputs: [out('gray')],
        params: [
            int('density', 'Amount', 8, 1, 64),
            int('perCell', 'Per patch', 3, 1, 8),
            float('length', 'Length', 0.6, 0.05, 2),
            float('width', 'Width', 0.012, 0.001, 0.1, { step: 0.001 }),
            float('angle', 'Direction (degrees)', 30, -180, 180, { step: 1 }),
            float('angleRandom', 'Direction randomness', 0.3, 0, 1),
            float('brightnessRandom', 'Brightness randomness', 0.6, 0, 1),
            seed(),
        ],
        sizeFrom: 'graph',
        cost: (params) => 9 * Number(params.perCell),
        glsl: `float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = saturate(dot(pa, ba) / max(dot(ba, ba), 1e-8));
    return length(pa - ba * h);
}
void main() {
    float cells = float(p_density);
    vec2 p = vUv * cells;
    ivec2 i = ivec2(floor(p));
    float value = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            ivec2 cell = i + ivec2(x, y);
            ivec2 wrapped = wrapCell(cell, ivec2(p_density));
            for (int k = 0; k < 8; k++) {
                if (k >= p_perCell) break;
                float s = uSeed + float(k) * 3.7;
                vec2 centre = vec2(cell) + hash2(wrapped, s);
                float angle = radians(p_angle) + (hash1(wrapped, s + 1.3) - 0.5) * TAU * p_angleRandom;
                float len = p_length * (0.4 + 0.6 * hash1(wrapped, s + 2.9));
                vec2 dir = vec2(cos(angle), sin(angle)) * len * 0.5;
                float d = segment(p, centre - dir, centre + dir);
                float w = p_width * cells * (0.5 + hash1(wrapped, s + 4.1));
                float along = saturate(dot(p - (centre - dir), dir) / max(dot(dir, dir) * 2.0, 1e-6));
                float taper = sin(along * PI);
                float line = (1.0 - smoothstep(0.0, w * taper + 1e-4, d)) * mix(1.0, hash1(wrapped, s + 6.7), p_brightnessRandom);
                value = max(value, line);
            }
        }
    }
    outColor = vec4(value);
}`,
    }),
    {
        ...onePass({
            type: 'tileSampler',
            label: 'Tile sampler',
            category: 'Patterns',
            description: 'Places a pattern (or a built-in shape) on a grid, each copy moved, turned, sized and brightened at random. Rivets, pebbles, leaves, debris.',
            keywords: ['scatter', 'splatter', 'instances', 'stamp', 'rivets', 'pebbles', 'distribute'],
            inputs: [anyIn('pattern', 'Pattern'), grayIn('scaleMap', 'Size map', 'white'), grayIn('maskMap', 'Mask map', 'white'), anyIn('colorMap', 'Colour map', 'white')],
            outputs: [out('any')],
            params: [
                select('shape', 'Built-in shape', 'disc', [['square', 'Square'], ['disc', 'Disc'], ['bell', 'Soft bump'], ['paraboloid', 'Dome'], ['pyramid', 'Pyramid']], { hint: 'Used when no pattern is wired in.' }),
                int('columns', 'Across', 8, 1, 128),
                int('rows', 'Down', 8, 1, 128),
                float('size', 'Size', 0.8, 0, 3),
                vec2('stretch', 'Stretch', [1, 1], 0.05, 4),
                float('sizeRandom', 'Size randomness', 0.2, 0, 1),
                float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
                float('rotationRandom', 'Turn randomness', 0, 0, 1),
                float('positionRandom', 'Position randomness', 0.3, 0, 2),
                float('offset', 'Row offset', 0, 0, 1),
                float('brightnessRandom', 'Brightness randomness', 0, 0, 1),
                float('dropRandom', 'Leave out at random', 0, 0, 1),
                select('combine', 'Overlaps', 'max', [['max', 'Brightest wins'], ['add', 'Add up'], ['over', 'Each on top']]),
                seed(),
            ],
            sizeFrom: 'graph',
            kindFrom: ['pattern', 'colorMap'],
            cost: () => 25,
            glsl: `float builtIn(vec2 p) {
    float r = length(p);
    if (p_shape == 0) return step(max(abs(p.x), abs(p.y)), 1.0);
    if (p_shape == 1) return 1.0 - smoothstep(0.96, 1.0, r);
    if (p_shape == 2) return exp(-r * r * 4.0) * step(r, 1.0);
    if (p_shape == 3) return saturate(1.0 - r * r);
    return saturate(1.0 - max(abs(p.x), abs(p.y)));
}
void main() {
    vec2 grid = vec2(p_columns, p_rows);
    vec2 p = vUv * grid;
    ivec2 base = ivec2(floor(p));
    vec4 result = vec4(0.0);
    float extent = p_size * (1.0 + p_sizeRandom) * max(p_stretch.x, p_stretch.y) * 0.75 + p_positionRandom * 0.5 + p_offset;
    int reach = int(clamp(ceil(extent), 1.0, 3.0));
    float topOrder = -1.0;
    for (int y = -3; y <= 3; y++) {
        if (abs(y) > reach) continue;
        for (int x = -3; x <= 3; x++) {
            if (abs(x) > reach) continue;
            ivec2 cell = base + ivec2(x, y);
            ivec2 id = wrapCell(cell, ivec2(p_columns, p_rows));
            if (hash1(id, uSeed + 11.0) < p_dropRandom) continue;
            vec2 centre = vec2(cell) + 0.5 + (hash2(id, uSeed + 1.0) - 0.5) * p_positionRandom;
            centre.x += mod(float(cell.y), 2.0) * p_offset;
            vec2 cellUv = centre / grid;
            float scale = p_size * (1.0 - hash1(id, uSeed + 2.0) * p_sizeRandom) * g_scaleMap(fract(cellUv));
            if (scale <= 0.0) continue;
            if (g_maskMap(fract(cellUv)) < 0.5) continue;
            float angle = radians(p_rotation) + (hash1(id, uSeed + 3.0) - 0.5) * TAU * p_rotationRandom;
            vec2 local = rotate2(-angle) * (p - centre) / (scale * p_stretch * 0.5);
            if (abs(local.x) > 1.0 || abs(local.y) > 1.0) continue;
            vec4 v = w_pattern == 1 ? c_pattern(local * 0.5 + 0.5) : vec4(vec3(builtIn(local)), 1.0);
            float brightness = 1.0 - hash1(id, uSeed + 4.0) * p_brightnessRandom;
            v.rgb *= brightness * c_colorMap(fract(cellUv)).rgb;
            float order = hash1(id, uSeed + 5.0);
            if (p_combine == 0) result = max(result, v);
            else if (p_combine == 1) result += v;
            else if (order > topOrder && luma(v.rgb) > 0.0) { result = v; topOrder = order; }
        }
    }
    outColor = result;
}`,
        }),
    },
];
