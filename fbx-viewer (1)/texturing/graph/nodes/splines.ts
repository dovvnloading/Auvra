import * as THREE from 'three';
import { hash3 } from '../noiseMath';
import { anyIn, bool, float, grayIn, out, seed } from '../nodeKit';
import {
    nearestOn, pathLength, placementsAlong, readPoints, resample, segmentsOf, simplify, smoothPath, traceOutlines, wrapOffsets,
    type Point, type Segment,
} from '../curves';
import type { NodeRunContext, TexNodeDef, TexParamDef } from '../types';

/**
 * SPLINES AND PATHS
 *
 * Curves placed and dragged in the 2D view (their points are settings: click the view to add one,
 * drag one to move it, Alt-click one to take it away): a curve drawn as a stroke and filled, a band
 * bridging two curves, a picture laid along a curve, copies of a picture scattered along one, a list
 * of points drawn as dots or stamps, and a mask's outlines traced into paths and drawn. A curve that
 * runs over the picture's edge comes back on the other side where the node tiles, so it stays tiling.
 * The curves' maths is in curves.ts; the shaders read their segments from a small float texture.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);

/** A list of points edited in the 2D view. */
export const points = (key: string, label: string, value: Point[], extra: Partial<TexParamDef> = {}): TexParamDef => ({ key, label, kind: 'points', default: value, ...extra });

const DEFAULT_CURVE: Point[] = [[0.15, 0.3], [0.38, 0.72], [0.62, 0.28], [0.85, 0.7]];

/** The node's curve as a polyline, from its points and smoothing. */
export const curveOf = (params: Params, key = 'points', closedKey = 'closed'): Point[] =>
    smoothPath(readPoints(params[key], DEFAULT_CURVE), Boolean(params[closedKey]), num(params, 'smoothness', 1));

/** Segments as a float texture: row 0 their ends (a.x, a.y, b.x, b.y), row 1 (start, length, path, path length). */
export const segmentTexture = (segments: readonly Segment[]): THREE.DataTexture => {
    const count = Math.max(1, segments.length);
    const data = new Float32Array(count * 2 * 4);
    segments.forEach((segment, i) => {
        data.set([segment.a[0], segment.a[1], segment.b[0], segment.b[1]], i * 4);
        data.set([segment.start, segment.length, segment.path, segment.pathLength], (count + i) * 4);
    });
    const texture = new THREE.DataTexture(data, count, 2, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
};

/** Offsets as the shaders take them: up to nine, as vec4s. */
export const offsetUniforms = (offsets: readonly Point[]) => ({
    uOffsets: Array.from({ length: 9 }, (_, i) => new THREE.Vector4(offsets[i]?.[0] ?? 0, offsets[i]?.[1] ?? 0, 0, 0)),
    uOffsetCount: Math.min(9, offsets.length),
});

/** Nearest point of the segments, and the winding number round a place, with the picture's copies of the curve. */
export const CURVE_GLSL = `uniform sampler2D segs;
uniform int uSegs;
uniform vec4 uOffsets[9];
uniform int uOffsetCount;
// The nearest point as (distance, length along its path, side, segment); hitPath gives that segment's path and its length.
vec4 nearestOnCurve(vec2 p) {
    vec4 hit = vec4(1e9, 0.0, 1.0, 0.0);
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = p + uOffsets[k].xy;
        for (int i = 0; i < 8192; i++) {
            if (i >= uSegs) break;
            vec4 s = texelFetch(segs, ivec2(i, 0), 0);
            vec2 e = s.zw - s.xy;
            float t = clamp(dot(q - s.xy, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
            vec2 d = q - (s.xy + e * t);
            float dist = length(d);
            if (dist < hit.x) {
                vec4 info = texelFetch(segs, ivec2(i, 1), 0);
                hit = vec4(dist, info.x + t * info.y, e.x * d.y - e.y * d.x >= 0.0 ? 1.0 : -1.0, float(i));
            }
        }
    }
    return hit;
}
vec2 hitPath(vec4 hit) { return texelFetch(segs, ivec2(int(hit.w), 1), 0).zw; }
float windingOf(vec2 p) {
    float winding = 0.0;
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = p + uOffsets[k].xy;
        for (int i = 0; i < 8192; i++) {
            if (i >= uSegs) break;
            vec4 s = texelFetch(segs, ivec2(i, 0), 0);
            float side = (s.z - s.x) * (q.y - s.y) - (s.w - s.y) * (q.x - s.x);
            if (s.y <= q.y) { if (s.w > q.y && side > 0.0) winding += 1.0; }
            else if (s.w <= q.y && side < 0.0) winding -= 1.0;
        }
    }
    return winding;
}
float pixelSize() { return 1.0 / min(uSize.x, uSize.y); }`;

/** A pass over the node's curve segments; the texture is let go of once drawn. */
const curvePass = async (context: NodeRunContext, target: Parameters<NodeRunContext['pass']>[0], glsl: string, segments: readonly Segment[], reach: number, extra: { inputs?: Record<string, THREE.Texture>; uniforms?: Record<string, unknown> } = {}): Promise<void> => {
    const texture = segmentTexture(segments);
    const offsets = wrapOffsets(segments, reach, context.tiling);
    try {
        await context.pass(target, `${CURVE_GLSL}\n${glsl}`, {
            inputs: { segs: texture, ...(extra.inputs ?? {}) },
            uniforms: { uSegs: segments.length, ...offsetUniforms(offsets), ...(extra.uniforms ?? {}) },
            cost: Math.ceil((Math.max(1, segments.length) * offsets.length) / 8) + 2,
        });
    } finally {
        texture.dispose();
    }
};

const width = (fallback = 0.02) => float('width', 'Width', fallback, 0.0005, 0.5, { softMax: 0.2, step: 0.0005 });
const smoothness = () => float('smoothness', 'Smoothing', 1, 0, 1, { hint: 'From straight lines between the points to a smooth curve through them.' });
const closed = (fallback = false) => bool('closed', 'Closed', fallback, { hint: 'Joins the last point back to the first.' });

/** The stroke's half width along the curve (`t` from 0 to 1), narrowing to its ends by the taper. */
export const strokeHalfWidth = (fullWidth: number, taper: number, t: number): number => (fullWidth / 2) * (1 + (Math.sqrt(Math.max(0, 4 * t * (1 - t))) - 1) * taper);

/** Copies placed along a curve as a float texture: row 0 (x, y, angle, size), row 1 (random grey, across offset, 0, 0). */
const placementTexture = (rows: ReadonlyArray<{ at: Point; angle: number; size: number; grey: number }>): THREE.DataTexture => {
    const count = Math.max(1, rows.length);
    const data = new Float32Array(count * 2 * 4);
    rows.forEach((row, i) => {
        data.set([row.at[0], row.at[1], row.angle, row.size], i * 4);
        data.set([row.grey, 0, 0, 0], (count + i) * 4);
    });
    const texture = new THREE.DataTexture(data, count, 2, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
};

/** Copies stamped at places: the input picture (or a soft dot), turned and sized, the topmost kept. */
const STAMPS_GLSL = `uniform sampler2D stamps;
uniform int uStamps;
uniform vec4 uOffsets[9];
uniform int uOffsetCount;
uniform int uWhat;
void main() {
    vec4 best = vec4(0.0);
    float id = 0.0;
    float covered = 0.0;
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = vUv + uOffsets[k].xy;
        for (int i = 0; i < 4096; i++) {
            if (i >= uStamps) break;
            vec4 s = texelFetch(stamps, ivec2(i, 0), 0);
            vec2 d = q - s.xy;
            if (dot(d, d) > s.w * s.w) continue;
            vec2 local = rotate2(-s.z) * d / max(s.w, 1e-5) + 0.5;
            if (local.x < 0.0 || local.y < 0.0 || local.x > 1.0 || local.y > 1.0) continue;
            vec4 c;
            float m;
            if (w_pattern == 1) { c = c_pattern(local); m = c.a * (uGrayPattern == 1 ? c.r : 1.0); }
            else { float r = length(local - 0.5) * 2.0; m = 1.0 - smoothstep(1.0 - max(p_softness, 0.002), 1.0, r); c = vec4(1.0); }
            if (m > 0.001) { best = vec4(c.rgb, max(best.a, m)); covered = max(covered, m); id = texelFetch(stamps, ivec2(i, 1), 0).r; }
        }
    }
    if (uWhat == 1) outColor = vec4(vec3(id * step(0.001, covered)), 1.0);
    else if (uWhat == 2) outColor = vec4(vec3(covered), 1.0);
    else outColor = uGrayOut == 1 ? vec4(vec3(covered), 1.0) : vec4(best.rgb, best.a);
}`;

const stampPass = async (context: NodeRunContext, target: Parameters<NodeRunContext['pass']>[0], rows: ReadonlyArray<{ at: Point; angle: number; size: number; grey: number }>, what: 0 | 1 | 2, grayOut: boolean): Promise<void> => {
    const texture = placementTexture(rows);
    const reach = Math.max(0, ...rows.map((row) => row.size));
    const segments = rows.map((row) => ({ a: row.at, b: row.at, start: 0, length: 0, path: 0, pathLength: 0 }));
    const offsets = wrapOffsets(segments, reach, context.tiling);
    const pattern = context.input('pattern');
    try {
        await context.pass(target, `uniform int uGrayPattern;\nuniform int uGrayOut;\n${STAMPS_GLSL}`, {
            inputs: { stamps: texture },
            uniforms: { uStamps: rows.length, ...offsetUniforms(offsets), uWhat: what, uGrayPattern: pattern?.kind === 'gray' ? 1 : 0, uGrayOut: grayOut ? 1 : 0 },
            cost: Math.ceil((Math.max(1, rows.length) * offsets.length) / 16) + 2,
        });
    } finally {
        texture.dispose();
    }
};

/** The values of a grey picture read back small (at most `limit` a side), for tracing its outlines. */
const readGrey = async (context: NodeRunContext, image: NonNullable<ReturnType<NodeRunContext['input']>>, limit: number): Promise<{ values: Float32Array; width: number; height: number } | null> => {
    const w = Math.min(image.width, limit);
    const h = Math.min(image.height, limit);
    const small = context.gpu.image(w, h, 'color', 8);
    await context.gpu.pass(small, {
        fragment: `uniform int uGray;
void main() {
    vec4 sum = vec4(0.0);
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) sum += texture(source, fract(vUv + (vec2(float(i), float(j)) - 0.5) / (2.0 * uSize)));
    sum *= 0.25;
    float v = uGray == 1 ? sum.r : luma(sum.rgb);
    outColor = vec4(v, v, v, 1.0);
}`,
        inputs: { source: image },
        uniforms: { uGray: image.kind === 'gray' ? 1 : 0 },
    });
    const bytes = await context.gpu.readRgba8Later(small);
    context.gpu.release(small);
    if (!bytes) return null;
    const values = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) values[i] = bytes[i * 4] / 255;
    return { values, width: w, height: h };
};

/** The most segments traced outlines keep; more are simplified harder until they fit. */
const MAX_TRACED = 4096;

/** A mask's outlines as paths: traced, simplified within `tolerance` (picture units), and smoothed. */
export const outlinePaths = (values: Float32Array, w: number, h: number, level: number, tolerance: number, smoothing: number): Point[][] => {
    const traced = traceOutlines(values, w, h, level).filter((path) => pathLength(path) > 3 / Math.max(w, h));
    let limit = Math.max(tolerance, 0.25 / Math.max(w, h));
    for (let tries = 0; tries < 8; tries++) {
        const simplified = traced.map((path) => simplify(path, limit)).filter((path) => path.length >= 3);
        // A loop that closes on itself smooths round; one running round the whole repeating picture stays open at its ends.
        const paths = smoothing > 0 ? simplified.map((path) => {
            const first = path[0];
            const last = path[path.length - 1];
            const loop = Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
            return loop ? smoothPath(path.slice(0, -1), true, smoothing, 4) : smoothPath(path, false, smoothing, 4);
        }) : simplified;
        const count = paths.reduce((sum, path) => sum + path.length - 1, 0);
        if (count <= MAX_TRACED || tries === 7) return paths;
        limit *= 2;
    }
    return [];
};

const STROKE_GLSL = `uniform float uTaper;
uniform float uDash;
uniform float uGap;
uniform int uWhat;
uniform int uClosedFill;
uniform vec4 uClose;
float closingDistance(vec2 p) {
    float best = 1e9;
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = p + uOffsets[k].xy;
        vec2 e = uClose.zw - uClose.xy;
        float t = clamp(dot(q - uClose.xy, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
        best = min(best, length(q - (uClose.xy + e * t)));
    }
    return best;
}
float closingWinding(vec2 p) {
    float winding = 0.0;
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = p + uOffsets[k].xy;
        vec4 s = uClose;
        float side = (s.z - s.x) * (q.y - s.y) - (s.w - s.y) * (q.x - s.x);
        if (s.y <= q.y) { if (s.w > q.y && side > 0.0) winding += 1.0; }
        else if (s.w <= q.y && side < 0.0) winding -= 1.0;
    }
    return winding;
}
void main() {
    vec4 hit = nearestOnCurve(vUv);
    vec2 path = hitPath(hit);
    float aa = pixelSize();
    float t = path.y > 0.0 ? hit.y / path.y : 0.0;
    float halfWidth = p_width * 0.5 * (1.0 + (sqrt(max(0.0, 4.0 * t * (1.0 - t))) - 1.0) * uTaper);
    float soft = max(halfWidth * p_softness, aa);
    float stroke = 1.0 - smoothstep(halfWidth - soft, halfWidth + aa * 0.5, hit.x);
    if (uDash > 0.0) {
        float period = uDash + uGap;
        float phase = mod(hit.y, period);
        stroke *= step(phase, uDash);
    }
    if (uWhat == 0) { outColor = vec4(vec3(stroke), 1.0); return; }
    if (uWhat == 2) { outColor = vec4(vec3(t * step(0.001, stroke)), 1.0); return; }
    float winding = windingOf(vUv) + (uClosedFill == 1 ? closingWinding(vUv) : 0.0);
    float edge = min(hit.x, uClosedFill == 1 ? closingDistance(vUv) : 1e9);
    float inside = abs(winding) > 0.5 ? 1.0 : 0.0;
    float fill = clamp(0.5 + (inside > 0.5 ? edge : -edge) / aa, 0.0, 1.0);
    outColor = vec4(vec3(fill), 1.0);
}`;

export const SPLINE_NODES: TexNodeDef[] = [
    {
        type: 'curve',
        label: 'Curve',
        category: 'Splines and paths',
        description: 'A curve through points you place in the 2D view, drawn as a stroke (tapered or dashed if you like), filled, and as a gradient along its length.',
        keywords: ['curve', 'spline', 'path', 'line', 'stroke', 'bezier', 'draw line', 'fill shape', 'render curve', 'fill curve'],
        inputs: [],
        outputs: [out('gray', 'out', 'Stroke'), out('gray', 'fill', 'Fill'), out('gray', 'along', 'Along')],
        params: [
            points('points', 'Points', DEFAULT_CURVE), closed(), smoothness(), width(0.02), float('softness', 'Soft edge', 0.1, 0, 1),
            float('taper', 'Taper to the ends', 0, 0, 1), float('dash', 'Dash length', 0, 0, 0.5, { step: 0.001, hint: '0 draws it unbroken.' }),
            float('gap', 'Gap', 0.02, 0.001, 0.5, { step: 0.001, showIf: (p) => num(p, 'dash', 0) > 0 }),
        ],
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const path = curveOf(context.params);
            const segments = segmentsOf([path]);
            const isClosed = Boolean(context.params.closed);
            const first = path[0] ?? [0, 0];
            const last = path[path.length - 1] ?? [0, 0];
            const uniforms = {
                uTaper: num(context.params, 'taper', 0), uDash: num(context.params, 'dash', 0), uGap: num(context.params, 'gap', 0.02),
                uClosedFill: isClosed ? 0 : 1, uClose: new THREE.Vector4(last[0], last[1], first[0], first[1]),
            };
            const reach = num(context.params, 'width', 0.02);
            const result: Record<string, ReturnType<NodeRunContext['image']>> = {};
            for (const [key, what] of [['out', 0], ['fill', 1], ['along', 2]] as const) {
                const image = context.image('gray');
                await curvePass(context, image, STROKE_GLSL, segments, reach, { uniforms: { ...uniforms, uWhat: what } });
                result[key] = image;
            }
            return result;
        },
    },
    {
        type: 'curveBridge',
        label: 'Bridge between curves',
        category: 'Splines and paths',
        description: 'Fills the band between two curves you place in the 2D view, with gradients across it (from the first curve to the second) and along it, for roads, rivers and ribbons.',
        keywords: ['bridge', 'between curves', 'band', 'ribbon', 'road', 'river', 'loft', 'sweep'],
        inputs: [],
        outputs: [out('gray', 'out', 'Band'), out('gray', 'across', 'Across'), out('gray', 'along', 'Along')],
        params: [
            points('curveA', 'First curve', [[0.1, 0.35], [0.4, 0.45], [0.65, 0.25], [0.9, 0.4]]),
            points('curveB', 'Second curve', [[0.1, 0.65], [0.38, 0.8], [0.62, 0.6], [0.9, 0.72]]),
            smoothness(), float('steps', 'Detail', 64, 4, 256, { step: 1, hint: 'How many pieces the band is built of along its length.' }),
        ],
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const n = Math.max(4, Math.round(num(context.params, 'steps', 64)));
            const smooth = num(context.params, 'smoothness', 1);
            const a = resample(smoothPath(readPoints(context.params.curveA), false, smooth), n + 1);
            const b = resample(smoothPath(readPoints(context.params.curveB), false, smooth), n + 1);
            // Each quad as a "segment" pair: row 0 its first curve's edge, row 1 its second's.
            const quads = Array.from({ length: n }, (_, i) => ({ a: a[i], b: a[i + 1], start: 0, length: 0, path: 0, pathLength: 0, c: b[i], d: b[i + 1] }));
            const data = new Float32Array(n * 2 * 4);
            quads.forEach((quad, i) => {
                data.set([quad.a[0], quad.a[1], quad.b[0], quad.b[1]], i * 4);
                data.set([quad.c[0], quad.c[1], quad.d[0], quad.d[1]], (n + i) * 4);
            });
            const texture = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
            texture.minFilter = texture.magFilter = THREE.NearestFilter;
            texture.needsUpdate = true;
            const all = [...quads, ...quads.map((quad) => ({ ...quad, a: quad.c, b: quad.d }))];
            const offsets = wrapOffsets(all, 0.01, context.tiling);
            const result: Record<string, ReturnType<NodeRunContext['image']>> = {};
            try {
                for (const [key, what] of [['out', 0], ['across', 1], ['along', 2]] as const) {
                    const image = context.image('gray');
                    await context.pass(image, `uniform sampler2D quads;
uniform int uQuads;
uniform vec4 uOffsets[9];
uniform int uOffsetCount;
uniform int uWhat;
float crossOf(vec2 x, vec2 y) { return x.x * y.y - x.y * y.x; }
vec2 quadPlace(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
    vec2 e = b - a; vec2 f = c - a; vec2 g = a - b - c + d; vec2 h = p - a;
    float k2 = crossOf(g, f); float k1 = crossOf(e, f) + crossOf(h, g); float k0 = crossOf(h, e);
    float t0 = -1.0; float t1 = -1.0;
    if (abs(k2) < 1e-10) { if (abs(k1) > 1e-12) t0 = -k0 / k1; }
    else { float disc = k1 * k1 - 4.0 * k2 * k0; if (disc >= 0.0) { float r = sqrt(disc); t0 = (-k1 - r) / (2.0 * k2); t1 = (-k1 + r) / (2.0 * k2); } }
    for (int j = 0; j < 2; j++) {
        float t = j == 0 ? t0 : t1;
        if (t < -1e-4 || t > 1.0001) continue;
        vec2 across = e + g * t;
        float s = dot(h - f * t, across) / max(dot(across, across), 1e-12);
        if (s >= -1e-4 && s <= 1.0001) return vec2(s, t);
    }
    return vec2(-1.0);
}
void main() {
    vec2 found = vec2(-1.0);
    float index = 0.0;
    for (int k = 0; k < 9; k++) {
        if (k >= uOffsetCount) break;
        vec2 q = vUv + uOffsets[k].xy;
        for (int i = 0; i < 1024; i++) {
            if (i >= uQuads) break;
            vec4 first = texelFetch(quads, ivec2(i, 0), 0);
            vec4 second = texelFetch(quads, ivec2(i, 1), 0);
            vec2 st = quadPlace(q, first.xy, first.zw, second.xy, second.zw);
            if (st.x >= 0.0) { found = st; index = float(i); }
        }
    }
    float inside = found.x >= 0.0 ? 1.0 : 0.0;
    float across = clamp(found.y, 0.0, 1.0);
    float along = (index + clamp(found.x, 0.0, 1.0)) / float(uQuads);
    if (uWhat == 1) outColor = vec4(vec3(across * inside), 1.0);
    else if (uWhat == 2) outColor = vec4(vec3(along * inside), 1.0);
    else outColor = vec4(vec3(inside), 1.0);
}`, { inputs: { quads: texture }, uniforms: { uQuads: n, ...offsetUniforms(offsets), uWhat: what }, cost: Math.ceil((n * offsets.length) / 8) + 2 });
                    result[key] = image;
                }
            } finally {
                texture.dispose();
            }
            return result;
        },
    },
    {
        type: 'curveMap',
        label: 'Picture along a curve',
        category: 'Splines and paths',
        description: 'Lays a picture along a curve you place in the 2D view, its width across the curve and repeating along it: a rope, a trim, a strip of stitching or a road.',
        keywords: ['picture along curve', 'texture along path', 'map along spline', 'rope', 'trim', 'stitching', 'path texture'],
        inputs: [anyIn('pattern', 'Picture', 'white')],
        outputs: [out('any', 'out', 'Picture'), out('gray', 'mask', 'Mask')],
        params: [
            points('points', 'Points', DEFAULT_CURVE), closed(), smoothness(), width(0.08), float('repeats', 'Repeats along', 4, 0.1, 128, { softMax: 32, hint: 'How many times the picture repeats along the whole curve.' }),
            bool('fit', 'Whole repeats', true, { hint: 'Rounds the repeats so the picture meets up at the ends of a closed curve.' }),
            bool('flip', 'Flip across', false), float('softness', 'Soft sides', 0.05, 0, 1),
        ],
        sizeFrom: 'graph',
        kindFrom: 'pattern',
        settingsInShader: true,
        async run(context) {
            const path = curveOf(context.params);
            const segments = segmentsOf([path]);
            const repeats = context.params.fit ? Math.max(1, Math.round(num(context.params, 'repeats', 4))) : num(context.params, 'repeats', 4);
            const picture = context.image(context.outputKind('out'));
            const mask = context.image('gray');
            const glsl = `uniform float uRepeats;
uniform int uWhat;
void main() {
    vec4 hit = nearestOnCurve(vUv);
    vec2 path = hitPath(hit);
    float aa = pixelSize();
    float halfWidth = p_width * 0.5;
    float m = 1.0 - smoothstep(halfWidth - max(halfWidth * p_softness, aa), halfWidth + aa * 0.5, hit.x);
    float across = (p_flip == 1 ? -hit.z : hit.z) * hit.x / max(p_width, 1e-5) + 0.5;
    float along = path.y > 0.0 ? hit.y / path.y * uRepeats : 0.0;
    if (uWhat == 1) { outColor = vec4(vec3(m), 1.0); return; }
    vec4 c = texture(t_pattern, vec2(fract(along), clamp(across, 0.0, 1.0)));
    outColor = vec4(c.rgb, c.a * m);
}`;
            await curvePass(context, picture, glsl, segments, num(context.params, 'width', 0.08), { uniforms: { uRepeats: repeats, uWhat: 0 } });
            await curvePass(context, mask, glsl, segments, num(context.params, 'width', 0.08), { uniforms: { uRepeats: repeats, uWhat: 1 } });
            return { out: picture, mask };
        },
    },
    {
        type: 'curveScatter',
        label: 'Scatter along curves',
        category: 'Splines and paths',
        description: 'Places copies of a picture (or soft dots) along a curve you place in the 2D view, spaced evenly, turned to follow it, with random sizes, turns and shifts.',
        keywords: ['scatter along curve', 'scatter along path', 'stamp along', 'beads', 'chain', 'footprints', 'stitches'],
        inputs: [anyIn('pattern', 'Picture', 'white')],
        outputs: [out('any', 'out', 'Copies'), out('gray', 'id', 'Random grey'), out('gray', 'mask', 'Mask')],
        params: [
            points('points', 'Points', DEFAULT_CURVE), closed(), smoothness(),
            float('spacing', 'Spacing', 0.06, 0.002, 1, { softMax: 0.3, step: 0.001 }), float('size', 'Size', 0.05, 0.001, 1, { softMax: 0.3, step: 0.001 }),
            float('sizeRandom', 'Size randomness', 0, 0, 1), bool('follow', 'Turn with the curve', true), float('turn', 'Turn (degrees)', 0, -180, 180, { step: 1 }),
            float('turnRandom', 'Turn randomness (degrees)', 0, 0, 180, { step: 1 }), float('shiftRandom', 'Shift across', 0, 0, 0.5, { step: 0.001, hint: 'How far each copy may stray to either side of the curve.' }),
            float('softness', 'Dot softness', 0.3, 0, 1), seed(),
        ],
        sizeFrom: 'graph',
        kindFrom: 'pattern',
        settingsInShader: true,
        async run(context) {
            const rows = scatterRows(context.params, context.seed);
            const kind = context.outputKind('out');
            const copies = context.image(kind);
            const id = context.image('gray');
            const mask = context.image('gray');
            await stampPass(context, copies, rows, 0, kind === 'gray');
            await stampPass(context, id, rows, 1, true);
            await stampPass(context, mask, rows, 2, true);
            return { out: copies, id, mask };
        },
    },
    {
        type: 'pointList',
        label: 'Points',
        category: 'Splines and paths',
        description: 'Points you place one by one in the 2D view, each drawn as a soft dot or a copy of a picture, with a random grey for each.',
        keywords: ['points', 'point list', 'dots', 'markers', 'place by hand', 'stamps', 'pins'],
        inputs: [anyIn('pattern', 'Picture', 'white')],
        outputs: [out('any', 'out', 'Dots'), out('gray', 'id', 'Random grey')],
        params: [
            points('points', 'Points', [[0.25, 0.3], [0.5, 0.7], [0.75, 0.4]]),
            float('size', 'Size', 0.08, 0.001, 1, { softMax: 0.4, step: 0.001 }), float('sizeRandom', 'Size randomness', 0, 0, 1),
            float('turnRandom', 'Turn randomness (degrees)', 0, 0, 180, { step: 1 }), float('softness', 'Dot softness', 0.4, 0, 1), seed(),
        ],
        sizeFrom: 'graph',
        kindFrom: 'pattern',
        settingsInShader: true,
        async run(context) {
            const list = readPoints(context.params.points);
            const size = num(context.params, 'size', 0.08);
            const rows = list.map((at, i) => {
                const r = hash3(i, 17, context.seed);
                return { at, angle: ((r[1] - 0.5) * 2 * num(context.params, 'turnRandom', 0) * Math.PI) / 180, size: size * (1 - num(context.params, 'sizeRandom', 0) * r[0]), grey: r[2] };
            });
            const kind = context.outputKind('out');
            const dots = context.image(kind);
            const id = context.image('gray');
            await stampPass(context, dots, rows, 0, kind === 'gray');
            await stampPass(context, id, rows, 1, true);
            return { out: dots, id };
        },
    },
    {
        type: 'maskToPaths',
        label: 'Mask to paths',
        category: 'Splines and paths',
        description: 'Traces the outlines of a mask into smooth paths and draws them as strokes, with a gradient along each path and a random grey for each: outlines, contour lines, stitching round a shape.',
        keywords: ['mask to paths', 'outline', 'trace', 'contour', 'vectorize', 'edge path', 'stroke outline'],
        inputs: [grayIn('in', 'Mask')],
        outputs: [out('gray', 'out', 'Stroke'), out('gray', 'along', 'Along'), out('gray', 'id', 'Random grey')],
        params: [
            float('level', 'Level', 0.5, 0.01, 0.99), width(0.01), float('softness', 'Soft edge', 0.2, 0, 1),
            float('simplify', 'Simplify', 0.002, 0, 0.05, { step: 0.0005, hint: 'How far a path may stray from the outline to drop points.' }), float('smoothness', 'Smoothing', 0.5, 0, 1),
            float('dash', 'Dash length', 0, 0, 0.5, { step: 0.001 }), float('gap', 'Gap', 0.01, 0.001, 0.5, { step: 0.001, showIf: (p) => num(p, 'dash', 0) > 0 }), seed(),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const input = context.input('in');
            const results = { out: context.image('gray'), along: context.image('gray'), id: context.image('gray') };
            if (!input) { for (const image of Object.values(results)) context.gpu.clear(image, [0, 0, 0, 1]); return results; }
            const read = await readGrey(context, input, 256);
            if (!read) { for (const image of Object.values(results)) context.gpu.clear(image, [0, 0, 0, 1]); return results; }
            const paths = outlinePaths(read.values, read.width, read.height, num(context.params, 'level', 0.5), num(context.params, 'simplify', 0.002), num(context.params, 'smoothness', 0.5));
            const segments = segmentsOf(paths);
            const glsl = `uniform float uDash;
uniform float uGap;
uniform int uWhat;
uniform float uSeedValue;
void main() {
    vec4 hit = nearestOnCurve(vUv);
    vec2 path = hitPath(hit);
    float aa = pixelSize();
    float halfWidth = p_width * 0.5;
    float m = 1.0 - smoothstep(halfWidth - max(halfWidth * p_softness, aa), halfWidth + aa * 0.5, hit.x);
    if (uDash > 0.0) m *= step(mod(hit.y, uDash + uGap), uDash);
    if (uWhat == 1) outColor = vec4(vec3((path.y > 0.0 ? hit.y / path.y : 0.0) * step(0.001, m)), 1.0);
    else if (uWhat == 2) outColor = vec4(vec3(hash1(ivec2(int(path.x), 7), uSeedValue) * step(0.001, m)), 1.0);
    else outColor = vec4(vec3(m), 1.0);
}`;
            const common = { uDash: num(context.params, 'dash', 0), uGap: num(context.params, 'gap', 0.01), uSeedValue: context.seed };
            await curvePass(context, results.out, glsl, segments, num(context.params, 'width', 0.01), { uniforms: { ...common, uWhat: 0 } });
            await curvePass(context, results.along, glsl, segments, num(context.params, 'width', 0.01), { uniforms: { ...common, uWhat: 1 } });
            await curvePass(context, results.id, glsl, segments, num(context.params, 'width', 0.01), { uniforms: { ...common, uWhat: 2 } });
            return results;
        },
    },
];

/** Where Scatter along curves puts each copy: along the curve, turned, sized and shifted at random by its seed. */
export const scatterRows = (params: Params, seedValue: number): Array<{ at: Point; angle: number; size: number; grey: number }> => {
    const path = curveOf(params);
    const placed = placementsAlong(path, num(params, 'spacing', 0.06), Boolean(params.closed));
    const size = num(params, 'size', 0.05);
    const turn = (num(params, 'turn', 0) * Math.PI) / 180;
    const turnRandom = (num(params, 'turnRandom', 0) * Math.PI) / 180;
    return placed.map((place, i) => {
        const r = hash3(i, 3, seedValue);
        const shift = (r[2] - 0.5) * 2 * num(params, 'shiftRandom', 0);
        const normal: Point = [-Math.sin(place.angle), Math.cos(place.angle)];
        return {
            at: [place.at[0] + normal[0] * shift, place.at[1] + normal[1] * shift],
            angle: (params.follow === false ? 0 : place.angle) + turn + (r[1] - 0.5) * 2 * turnRandom,
            size: size * (1 - num(params, 'sizeRandom', 0) * r[0]),
            grey: hash3(i, 9, seedValue)[0],
        };
    });
};

/** The point-list settings of a node kind, for the 2D view's handles. */
export const POINT_SETTINGS = (definition: TexNodeDef): TexParamDef[] => definition.params.filter((param) => param.kind === 'points');

/** The CPU twin of a Curve's stroke (no dashes): its coverage at a place, the curve repeating where the picture tiles. */
export const strokeAt = (params: Params, u: number, v: number, tiling: readonly [boolean, boolean], pixel = 1 / 1024): number => {
    const segments = segmentsOf([curveOf(params)]);
    const offsets = wrapOffsets(segments, num(params, 'width', 0.02), tiling);
    const hit = nearestOn([u, v], segments, offsets);
    const t = hit.pathLength > 0 ? hit.along / hit.pathLength : 0;
    const halfWidth = strokeHalfWidth(num(params, 'width', 0.02), num(params, 'taper', 0), t);
    const soft = Math.max(halfWidth * num(params, 'softness', 0.1), pixel);
    const low = halfWidth - soft;
    const high = halfWidth + pixel * 0.5;
    const x = Math.min(1, Math.max(0, (hit.distance - low) / (high - low)));
    return 1 - x * x * (3 - 2 * x);
};
