/**
 * GLSL helper functions material graph nodes call (materialNodes.ts). A compiled graph includes only
 * the helpers its nodes asked for (and what those need), in both the vertex and the fragment shader.
 * Every name starts with `mg` so it cannot meet three's own.
 */

interface GlslHelper {
    /** Helpers this one calls. */
    needs?: readonly string[];
    source: string;
}

const HELPERS: Record<string, GlslHelper> = {
    // --- Hashing: pcg3d (Jarzynski and Olano, "Hash Functions for GPU Rendering", 2020) ---
    mgPcg3: {
        source: `
uvec3 mgPcg3(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}`,
    },
    mgHash33: {
        needs: ['mgPcg3'],
        source: `
vec3 mgHash33(vec3 cell) {
    return vec3(mgPcg3(uvec3(ivec3(floor(cell))))) * (1.0 / 4294967295.0);
}`,
    },
    mgGradient3: {
        needs: ['mgHash33'],
        source: `
vec3 mgGradient3(vec3 cell) {
    return normalize(mgHash33(cell) * 2.0 - 1.0 + vec3(1e-4));
}`,
    },

    // --- Noise, each from 0 to 1 ---
    // The value noise the first Noise node used, kept so materials made with it look the same.
    mgLegacyNoise: {
        source: `
float mgLegacyHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float mgLegacyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mgLegacyHash(i), mgLegacyHash(i + vec2(1.0, 0.0)), u.x),
               mix(mgLegacyHash(i + vec2(0.0, 1.0)), mgLegacyHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,
    },
    mgValueNoise: {
        needs: ['mgHash33'],
        source: `
float mgValueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = mgHash33(i).x, b = mgHash33(i + vec3(1, 0, 0)).x, c = mgHash33(i + vec3(0, 1, 0)).x, d = mgHash33(i + vec3(1, 1, 0)).x;
    float e = mgHash33(i + vec3(0, 0, 1)).x, f1 = mgHash33(i + vec3(1, 0, 1)).x, g = mgHash33(i + vec3(0, 1, 1)).x, h = mgHash33(i + vec3(1, 1, 1)).x;
    return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}`,
    },
    mgGradientNoise: {
        needs: ['mgGradient3'],
        source: `
float mgGradientNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(mgGradient3(i), f);
    float n100 = dot(mgGradient3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
    float n010 = dot(mgGradient3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
    float n110 = dot(mgGradient3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
    float n001 = dot(mgGradient3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
    float n101 = dot(mgGradient3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
    float n011 = dot(mgGradient3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
    float n111 = dot(mgGradient3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
    float n = mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
    return clamp(n * 0.9 + 0.5, 0.0, 1.0);
}`,
    },
    mgSimplexNoise: {
        needs: ['mgGradient3'],
        source: `
float mgSimplexNoise(vec3 p) {
    vec3 s = floor(p + dot(p, vec3(1.0 / 3.0)));
    vec3 x0 = p - s + dot(s, vec3(1.0 / 6.0));
    vec3 e = step(vec3(0.0), x0 - x0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 x1 = x0 - i1 + 1.0 / 6.0;
    vec3 x2 = x0 - i2 + 1.0 / 3.0;
    vec3 x3 = x0 - 0.5;
    vec4 w = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 d = vec4(dot(mgGradient3(s), x0), dot(mgGradient3(s + i1), x1), dot(mgGradient3(s + i2), x2), dot(mgGradient3(s + 1.0), x3));
    w *= w;
    w *= w;
    return clamp(dot(d, w) * 16.0 + 0.5, 0.0, 1.0);
}`,
    },
    mgVoronoi: {
        needs: ['mgHash33'],
        source: `
void mgVoronoi(vec3 p, float jitter, out float nearest, out float second, out vec3 cell) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    cell = vec3(0.0);
    for (int z = -1; z <= 1; z++) {
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec3 offset = vec3(float(x), float(y), float(z));
                vec3 h = mgHash33(i + offset);
                vec3 r = offset + h * jitter - f;
                float d = dot(r, r);
                if (d < d1) { d2 = d1; d1 = d; cell = h; }
                else if (d < d2) { d2 = d; }
            }
        }
    }
    nearest = sqrt(d1);
    second = sqrt(d2);
}`,
    },

    // --- Colour ---
    mgRgbToHsv: {
        source: `
vec3 mgRgbToHsv(vec3 c) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = c.g < c.b ? vec4(c.bg, k.wz) : vec4(c.gb, k.xy);
    vec4 q = c.r < p.x ? vec4(p.xyw, c.r) : vec4(c.r, p.yzx);
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}`,
    },
    mgHsvToRgb: {
        source: `
vec3 mgHsvToRgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}`,
    },
    mgLuminance: {
        source: `
float mgLuminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}`,
    },
    mgOverlay: {
        source: `
vec3 mgOverlay(vec3 base, vec3 blend) {
    return mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), step(0.5, base));
}`,
    },
    mgSoftLight: {
        source: `
vec3 mgSoftLight(vec3 base, vec3 blend) {
    vec3 dark = base - (1.0 - 2.0 * blend) * base * (1.0 - base);
    vec3 d = mix(((16.0 * base - 12.0) * base + 4.0) * base, sqrt(max(base, 0.0)), step(0.25, base));
    vec3 light = base + (2.0 * blend - 1.0) * (d - base);
    return mix(dark, light, step(0.5, blend));
}`,
    },
    mgRamp: {
        source: `
vec3 mgRamp(vec4 stops[${8}], float t, int mode) {
    if (t <= stops[0].w) return stops[0].rgb;
    for (int i = 1; i < ${8}; i++) {
        if (t <= stops[i].w) {
            float f = clamp((t - stops[i - 1].w) / max(stops[i].w - stops[i - 1].w, 1e-5), 0.0, 1.0);
            if (mode == 1) f = 0.0;
            else if (mode == 2) f = f * f * (3.0 - 2.0 * f);
            return mix(stops[i - 1].rgb, stops[i].rgb, f);
        }
    }
    return stops[${8} - 1].rgb;
}`,
    },

    // --- Normals and tangent space ---
    // Reoriented normal mapping (Barré-Brisebois and Hill, 2012) on tangent-space normals.
    mgNormalBlend: {
        source: `
vec3 mgNormalBlend(vec3 base, vec3 detail) {
    vec3 t = base + vec3(0.0, 0.0, 1.0);
    vec3 u = detail * vec3(-1.0, -1.0, 1.0);
    return normalize(t * dot(t, u) / t.z - u);
}`,
    },
    // A tangent-space normal from a height, through the height's and the UV's screen-space derivatives.
    mgNormalFromHeight: {
        source: `
vec3 mgNormalFromHeight(float height, vec2 uv, float strength) {
    vec2 dhd = vec2(dFdx(height), dFdy(height));
    vec2 duvx = dFdx(uv);
    vec2 duvy = dFdy(uv);
    float det = duvx.x * duvy.y - duvx.y * duvy.x;
    if (abs(det) < 1e-12) return vec3(0.0, 0.0, 1.0);
    // dh/du and dh/dv, solving dh/dx = dh/du du/dx + dh/dv dv/dx (and the same in y).
    vec2 grad = vec2(dhd.x * duvy.y - dhd.y * duvx.y, dhd.y * duvx.x - dhd.x * duvy.x) / det;
    return normalize(vec3(-grad * strength, 1.0));
}`,
    },
    // The surface's tangent frame (tangent, bitangent, normal; view space) from derivatives, for
    // meshes with or without tangents.
    mgTangentFrame: {
        source: `
mat3 mgTangentFrame(vec3 position, vec3 normal, vec2 uv) {
    vec3 dp1 = dFdx(position);
    vec3 dp2 = dFdy(position);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, normal);
    vec3 dp1perp = cross(normal, dp1);
    vec3 t = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
    float scale = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
    return mat3(t * scale, b * scale, normal);
}`,
    },
};

/** The helpers' GLSL, dependencies first, for the names asked for. */
export const helperSource = (names: Iterable<string>): string => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
        if (seen.has(name)) return;
        const helper = HELPERS[name];
        if (!helper) throw new Error(`No material GLSL helper ${name}.`);
        seen.add(name);
        for (const need of helper.needs ?? []) visit(need);
        ordered.push(helper.source);
    };
    for (const name of names) visit(name);
    return ordered.join('\n');
};

export const hasHelper = (name: string): boolean => name in HELPERS;
