/**
 * GLSL every texturing pass can call (GLSL ES 3.00). Noises take a whole-number `period` in cells
 * and repeat after it, so everything a texture graph makes tiles.
 */

export const BLEND_MODES = [
    'normal', 'add', 'subtract', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'divide',
    'difference', 'darken', 'lighten', 'linearBurn', 'colorBurn', 'colorDodge', 'linearLight', 'addSub',
    'hue', 'saturation', 'color', 'luminosity',
] as const;
export type BlendMode = typeof BLEND_MODES[number];

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
    normal: 'Normal (copy)', add: 'Add', subtract: 'Subtract', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay',
    softLight: 'Soft light', hardLight: 'Hard light', divide: 'Divide', difference: 'Difference', darken: 'Darken (min)',
    lighten: 'Lighten (max)', linearBurn: 'Linear burn', colorBurn: 'Colour burn', colorDodge: 'Colour dodge',
    linearLight: 'Linear light', addSub: 'Add / subtract', hue: 'Hue', saturation: 'Saturation', color: 'Colour', luminosity: 'Luminosity',
};

export const blendModeIndex = (mode: unknown): number => {
    const index = BLEND_MODES.indexOf(mode as BlendMode);
    return index < 0 ? 0 : index;
};

export const GLSL_LIBRARY = /* glsl */ `
#define PI 3.14159265358979
#define TAU 6.28318530717959

float saturate(float v) { return clamp(v, 0.0, 1.0); }
vec3 saturate(vec3 v) { return clamp(v, 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---- hashes (integer, so the same on every GPU) ----
uint hashU(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}
uint hashU(uvec2 v) { return hashU(v.x ^ hashU(v.y + 0x9e3779b9u)); }
uint hashU(uvec3 v) { return hashU(v.x ^ hashU(v.y ^ hashU(v.z + 0x85ebca6bu))); }
float hash1(ivec2 p, float seed) { return float(hashU(uvec3(uvec2(p), floatBitsToUint(seed)))) / 4294967295.0; }
float hash1(ivec3 p, float seed) { return float(hashU(uvec3(p) ^ uvec3(0u, 0u, floatBitsToUint(seed) * 747796405u))) / 4294967295.0; }
vec2 hash2(ivec2 p, float seed) { return vec2(hash1(p, seed), hash1(p, seed + 17.137)); }
vec3 hash3(ivec2 p, float seed) { return vec3(hash1(p, seed), hash1(p, seed + 17.137), hash1(p, seed + 41.773)); }
float hashF(float x, float seed) { return float(hashU(uvec2(floatBitsToUint(x), floatBitsToUint(seed)))) / 4294967295.0; }

ivec2 wrapCell(ivec2 c, ivec2 period) { return ((c % period) + period) % period; }

// ---- gradient (Perlin) noise, tiling every period cells; about -1..1 ----
vec2 gradientAt(ivec2 cell, ivec2 period, float seed) {
    float a = hash1(wrapCell(cell, period), seed) * TAU;
    return vec2(cos(a), sin(a));
}
float perlin(vec2 p, ivec2 period, float seed) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(gradientAt(i, period, seed), f);
    float b = dot(gradientAt(i + ivec2(1, 0), period, seed), f - vec2(1.0, 0.0));
    float c = dot(gradientAt(i + ivec2(0, 1), period, seed), f - vec2(0.0, 1.0));
    float d = dot(gradientAt(i + ivec2(1, 1), period, seed), f - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.41421356;
}

// ---- value noise, 0..1 ----
float valueNoise(vec2 p, ivec2 period, float seed) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash1(wrapCell(i, period), seed);
    float b = hash1(wrapCell(i + ivec2(1, 0), period), seed);
    float c = hash1(wrapCell(i + ivec2(0, 1), period), seed);
    float d = hash1(wrapCell(i + ivec2(1, 1), period), seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---- cellular (Worley): x nearest distance, y second nearest, z the nearest cell's random value ----
float cellDistance(vec2 d, int metric) {
    if (metric == 1) return abs(d.x) + abs(d.y);
    if (metric == 2) return max(abs(d.x), abs(d.y));
    return length(d);
}
vec3 worley(vec2 p, ivec2 period, float jitter, int metric, float seed) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    float id = 0.0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            ivec2 cell = i + ivec2(x, y);
            ivec2 wrapped = wrapCell(cell, period);
            vec2 point = vec2(x, y) + 0.5 + (hash2(wrapped, seed) - 0.5) * jitter;
            float d = cellDistance(point - f, metric);
            if (d < d1) { d2 = d1; d1 = d; id = hash1(wrapped, seed + 3.71); }
            else if (d < d2) { d2 = d; }
        }
    }
    return vec3(d1, d2, id);
}

// ---- colour ----
vec3 rgbToHsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    float d = maxC - minC;
    if (d < 1e-6) return vec3(0.0, 0.0, l);
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    float h;
    if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    return vec3(h / 6.0, s, l);
}
float hueToRgb(float p, float q, float t) {
    t = fract(t);
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}
vec3 hslToRgb(vec3 hsl) {
    if (hsl.y < 1e-6) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(hueToRgb(p, q, hsl.x + 1.0 / 3.0), hueToRgb(p, q, hsl.x), hueToRgb(p, q, hsl.x - 1.0 / 3.0));
}
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// ---- blending: a over b by the mode ----
vec3 setLum(vec3 c, float l) {
    c += l - luma(c);
    float lo = luma(c);
    float mn = min(c.r, min(c.g, c.b));
    float mx = max(c.r, max(c.g, c.b));
    if (mn < 0.0) c = lo + (c - lo) * lo / max(lo - mn, 1e-6);
    if (mx > 1.0) c = lo + (c - lo) * (1.0 - lo) / max(mx - lo, 1e-6);
    return c;
}
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight1(float b, float a) {
    if (a <= 0.5) return b - (1.0 - 2.0 * a) * b * (1.0 - b);
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * a - 1.0) * (d - b);
}
vec3 blendColor(vec3 a, vec3 b, int mode) {
    if (mode == 0) return a;
    if (mode == 1) return a + b;
    if (mode == 2) return b - a;
    if (mode == 3) return a * b;
    if (mode == 4) return 1.0 - (1.0 - a) * (1.0 - b);
    if (mode == 5) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b));
    if (mode == 6) return vec3(softLight1(b.r, a.r), softLight1(b.g, a.g), softLight1(b.b, a.b));
    if (mode == 7) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
    if (mode == 8) return b / max(a, 1e-4);
    if (mode == 9) return abs(a - b);
    if (mode == 10) return min(a, b);
    if (mode == 11) return max(a, b);
    if (mode == 12) return a + b - 1.0;
    if (mode == 13) return 1.0 - (1.0 - b) / max(a, 1e-4);
    if (mode == 14) return b / max(1.0 - a, 1e-4);
    if (mode == 15) return b + 2.0 * a - 1.0;
    if (mode == 16) return b + (a - 0.5) * 2.0 * 0.5;
    if (mode == 17) return setLum(setSat(a, sat(b)), luma(b));
    if (mode == 18) return setLum(setSat(b, sat(a)), luma(b));
    if (mode == 19) return setLum(a, luma(b));
    if (mode == 20) return setLum(b, luma(a));
    return a;
}
vec4 blendOver(vec4 fg, vec4 bg, int mode, float opacity) {
    vec3 mixed = blendColor(fg.rgb, bg.rgb, mode);
    float a = fg.a * opacity;
    return vec4(mix(bg.rgb, mode == 0 ? fg.rgb : mixed, a), max(bg.a, a));
}
float blendGray(float a, float b, int mode) { return blendColor(vec3(a), vec3(b), mode).r; }

// ---- 2D helpers ----
mat2 rotate2(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
vec4 texelWrap(sampler2D s, ivec2 p) { ivec2 size = textureSize(s, 0); return texelFetch(s, ((p % size) + size) % size, 0); }

// ---- ramps (a gradient of up to 16 stops in uniform arrays) ----
vec4 sampleRamp(float t, vec4 colors[16], float positions[16], int count) {
    if (count <= 0) return vec4(t, t, t, 1.0);
    if (t <= positions[0]) return colors[0];
    for (int i = 1; i < 16; i++) {
        if (i >= count) break;
        if (t <= positions[i]) {
            float span = max(positions[i] - positions[i - 1], 1e-5);
            return mix(colors[i - 1], colors[i], (t - positions[i - 1]) / span);
        }
    }
    return colors[count - 1];
}
`;
