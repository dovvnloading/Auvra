import { float, grayIn, int, out, select, vec2 } from '../nodeKit';
import { segmentsOf, wrapOffsets, type Point } from '../curves';
import { fitToPicture, parseSvg } from '../svgPaths';
import type { TexNodeDef } from '../types';
import { CURVE_GLSL, offsetUniforms, segmentTexture } from './splines';

/**
 * VECTOR SHAPES
 *
 * Shapes drawn from exact signed distances, so their edges are clean at any size: polygons, stars,
 * rounded boxes and ellipses with rounded corners or as outlines; booleans between any two shapes'
 * distances (union, subtract, intersect, exclude, each hard or smooth); and shapes read from SVG.
 * Every one gives a mask and its distance, written as 0.5 at the edge, rising inside by DISTANCE_SCALE
 * a unit of the picture, so shapes combine exactly and their distances feed the other distance nodes.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const pair = (params: Params, key: string, fallback: Point): Point => (Array.isArray(params[key]) ? [Number((params[key] as number[])[0]), Number((params[key] as number[])[1])] : fallback);

/** How a distance (picture units, negative inside) is written: 0.5 at the edge, this much a unit inward. */
export const DISTANCE_SCALE = 2;
export const encodeDistance = (d: number): number => 0.5 - d * DISTANCE_SCALE;
export const decodeDistance = (value: number): number => (0.5 - value) / DISTANCE_SCALE;

export const VECTOR_SHAPES = ['polygon', 'star', 'box', 'ellipse'] as const;

const SHAPE_GLSL = `float polygonDistance(vec2 p, float r, float n) {
    float sector = TAU / n;
    float a = mod(atan(p.x, p.y) + PI / n + sector * 0.5, sector) - sector * 0.5;
    vec2 q = length(p) * vec2(cos(a), abs(sin(a)));
    float apothem = r * cos(PI / n);
    float halfEdge = r * sin(PI / n);
    vec2 nearest = vec2(apothem, clamp(q.y, -halfEdge, halfEdge));
    return length(q - nearest) * (q.x > apothem ? 1.0 : -1.0);
}
float starDistance(vec2 p, float r, float inner, float n) {
    float sector = TAU / n;
    float a = abs(mod(atan(p.x, p.y) + sector * 0.5, sector) - sector * 0.5);
    vec2 q = length(p) * vec2(sin(a), cos(a));
    vec2 tip = vec2(0.0, r);
    vec2 valley = inner * r * vec2(sin(sector * 0.5), cos(sector * 0.5));
    vec2 e = valley - tip;
    float t = clamp(dot(q - tip, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    float d = length(q - (tip + e * t));
    float side = e.x * (q.y - tip.y) - e.y * (q.x - tip.x);
    return side < 0.0 ? -d : d;
}
float boxDistance(vec2 p, float k) {
    vec2 q = abs(p) - vec2(1.0) + k;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - k;
}
float shapeDistance(vec2 p) {
    float k = clamp(p_rounding, 0.0, 0.99);
    if (p_shape == 0) return polygonDistance(p, 1.0 - k, float(p_sides)) - k;
    if (p_shape == 1) return starDistance(p, 1.0 - k, p_inner, float(p_sides)) - k;
    if (p_shape == 2) return boxDistance(p, k);
    return length(p) - 1.0;
}`;

/** The CPU twins of the shape distances, in the shape's own units (its edge at 1). */
export const shapeDistance = (p: Point, shape: typeof VECTOR_SHAPES[number], sides: number, inner: number, rounding: number): number => {
    const k = Math.min(0.99, Math.max(0, rounding));
    const length = Math.hypot(p[0], p[1]);
    const mod = (x: number, y: number) => x - y * Math.floor(x / y);
    if (shape === 'polygon') {
        const n = sides;
        const r = 1 - k;
        const sector = (Math.PI * 2) / n;
        const a = mod(Math.atan2(p[0], p[1]) + Math.PI / n + sector / 2, sector) - sector / 2;
        const q: Point = [length * Math.cos(a), length * Math.abs(Math.sin(a))];
        const apothem = r * Math.cos(Math.PI / n);
        const halfEdge = r * Math.sin(Math.PI / n);
        const ny = Math.min(halfEdge, Math.max(-halfEdge, q[1]));
        return Math.hypot(q[0] - apothem, q[1] - ny) * (q[0] > apothem ? 1 : -1) - k;
    }
    if (shape === 'star') {
        const n = sides;
        const r = 1 - k;
        const sector = (Math.PI * 2) / n;
        const a = Math.abs(mod(Math.atan2(p[0], p[1]) + sector / 2, sector) - sector / 2);
        const q: Point = [length * Math.sin(a), length * Math.cos(a)];
        const tip: Point = [0, r];
        const valley: Point = [inner * r * Math.sin(sector / 2), inner * r * Math.cos(sector / 2)];
        const e: Point = [valley[0] - tip[0], valley[1] - tip[1]];
        const t = Math.min(1, Math.max(0, ((q[0] - tip[0]) * e[0] + (q[1] - tip[1]) * e[1]) / Math.max(e[0] ** 2 + e[1] ** 2, 1e-12)));
        const d = Math.hypot(q[0] - tip[0] - e[0] * t, q[1] - tip[1] - e[1] * t);
        const side = e[0] * (q[1] - tip[1]) - e[1] * (q[0] - tip[0]);
        return (side < 0 ? -d : d) - k;
    }
    if (shape === 'box') {
        const qx = Math.abs(p[0]) - 1 + k;
        const qy = Math.abs(p[1]) - 1 + k;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - k;
    }
    return length - 1;
};

/**
 * A Vector shape's distance at a place, in picture units (negative inside), as its shader works it out:
 * the place in its tile, moved, turned and sized into the shape's own units, and back.
 */
export const vectorShapeAt = (params: Params, u: number, v: number): number => {
    const repeat = Math.max(1, Math.round(num(params, 'tiling', 1)));
    const centre = pair(params, 'centre', [0.5, 0.5]);
    const stretch = pair(params, 'stretch', [1, 1]);
    const size = num(params, 'size', 0.8);
    const a = (-num(params, 'rotation', 0) * Math.PI) / 180;
    const fract = (x: number) => x - Math.floor(x);
    const lx = (fract((u - centre[0] + 0.5) * repeat) - 0.5) * 2;
    const ly = (fract((v - centre[1] + 0.5) * repeat) - 0.5) * 2;
    const turned: Point = [Math.cos(a) * lx - Math.sin(a) * ly, Math.sin(a) * lx + Math.cos(a) * ly];
    const p: Point = [turned[0] / Math.max(size * stretch[0], 1e-5), turned[1] / Math.max(size * stretch[1], 1e-5)];
    const shape = (VECTOR_SHAPES as readonly string[]).includes(String(params.shape)) ? params.shape as typeof VECTOR_SHAPES[number] : 'polygon';
    let d = shapeDistance(p, shape, Math.max(3, Math.round(num(params, 'sides', 6))), num(params, 'inner', 0.5), num(params, 'rounding', 0)) * (size * Math.min(stretch[0], stretch[1])) / (2 * repeat);
    const outline = num(params, 'outline', 0);
    if (outline > 0) d = Math.abs(d) - outline / 2;
    return d;
};

export const BOOLEAN_OPERATIONS = ['union', 'subtract', 'intersect', 'exclude'] as const;

/** A smooth minimum of two distances: within `k` of each other they round into one another. */
const smoothMin = (a: number, b: number, k: number): number => {
    if (k <= 0) return Math.min(a, b);
    const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
    return b + (a - b) * h - k * h * (1 - h);
};

/** Two distances combined (picture units, negative inside), as Shape boolean does. */
export const combineDistances = (a: number, b: number, operation: typeof BOOLEAN_OPERATIONS[number], smooth: number): number => {
    switch (operation) {
        case 'subtract': return -smoothMin(-a, b, smooth);
        case 'intersect': return -smoothMin(-a, -b, smooth);
        // Inside one but not both: outside the overlap (max of the two, turned round) and inside the union.
        case 'exclude': return Math.max(smoothMin(a, b, smooth), smoothMin(-a, -b, smooth));
        default: return smoothMin(a, b, smooth);
    }
};

const MASK_AND_DISTANCE = `void writeShape(float d) {
    if (p_outline > 0.0) d = abs(d) - p_outline * 0.5;
    float aa = 1.0 / min(uSize.x, uSize.y);
    if (uWhat == 1) outColor = vec4(vec3(0.5 - d * ${DISTANCE_SCALE.toFixed(1)}), 1.0);
    else outColor = vec4(vec3(clamp(0.5 - d / aa, 0.0, 1.0)), 1.0);
}`;

export const VECTOR_NODES: TexNodeDef[] = [
    {
        type: 'vectorShape',
        label: 'Vector shape',
        category: 'Shapes',
        description: 'A polygon, star, rounded box or ellipse with clean edges at any size, its corners rounded or drawn as an outline, once or repeated; also gives its distance, for Shape boolean.',
        keywords: ['vector shape', 'polygon', 'star', 'rounded rectangle', 'rounded box', 'ellipse', 'hexagon', 'sdf 2d', 'outline shape', 'rounded corners'],
        inputs: [],
        outputs: [out('gray', 'out', 'Mask'), out('gray', 'distance', 'Distance')],
        params: [
            select('shape', 'Shape', 'polygon', [['polygon', 'Polygon'], ['star', 'Star'], ['box', 'Rounded box'], ['ellipse', 'Ellipse']]),
            int('sides', 'Sides or points', 6, 3, 64, { showIf: (p) => p.shape === 'polygon' || p.shape === 'star' }),
            float('inner', 'Inner size', 0.5, 0.05, 1, { showIf: (p) => p.shape === 'star' }),
            float('rounding', 'Round the corners', 0, 0, 0.9), float('outline', 'Outline width', 0, 0, 0.5, { step: 0.001, hint: '0 fills the shape.' }),
            vec2('centre', 'Centre', [0.5, 0.5], 0, 1), float('size', 'Size', 0.8, 0, 2), vec2('stretch', 'Stretch', [1, 1], 0.05, 4),
            float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }), int('tiling', 'Repeat', 1, 1, 64),
        ],
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const result: Record<string, ReturnType<typeof context.image>> = {};
            for (const [key, what] of [['out', 0], ['distance', 1]] as const) {
                const image = context.image('gray');
                await context.pass(image, `${SHAPE_GLSL}
uniform int uWhat;
${MASK_AND_DISTANCE}
void main() {
    float n = float(p_tiling);
    vec2 local = (fract((vUv - p_centre + 0.5) * n) - 0.5) * 2.0;
    vec2 p = rotate2(-radians(p_rotation)) * local / max(p_size * p_stretch, vec2(1e-5));
    writeShape(shapeDistance(p) * p_size * min(p_stretch.x, p_stretch.y) / (2.0 * n));
}`, { uniforms: { uWhat: what }, cost: 2 });
                result[key] = image;
            }
            return result;
        },
    },
    {
        type: 'shapeBoolean',
        label: 'Shape boolean',
        category: 'Shapes',
        description: 'Combines two shapes by their distances: joined, one cut from the other, only where they overlap, or only where they do not, each with a hard or a smooth join; rounds or outlines the result.',
        keywords: ['boolean', 'union', 'subtract', 'difference', 'intersect', 'exclude', 'xor', 'smooth union', 'combine shapes', 'csg'],
        inputs: [grayIn('a', 'Distance A', 'black'), grayIn('b', 'Distance B', 'black')],
        outputs: [out('gray', 'out', 'Mask'), out('gray', 'distance', 'Distance')],
        params: [
            select('operation', 'Combine', 'union', [['union', 'Join'], ['subtract', 'Cut B from A'], ['intersect', 'Where both are'], ['exclude', 'Where one is but not both']]),
            float('smooth', 'Smooth join', 0, 0, 0.25, { step: 0.001, hint: 'How far the shapes round into each other where they meet.' }),
            float('grow', 'Grow or shrink', 0, -0.25, 0.25, { step: 0.001 }), float('outline', 'Outline width', 0, 0, 0.5, { step: 0.001, hint: '0 fills the shape.' }),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const result: Record<string, ReturnType<typeof context.image>> = {};
            for (const [key, what] of [['out', 0], ['distance', 1]] as const) {
                const image = context.image('gray');
                await context.pass(image, `uniform int uWhat;
${MASK_AND_DISTANCE}
float smoothMin(float a, float b, float k) {
    if (k <= 0.0) return min(a, b);
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}
void main() {
    float a = (0.5 - g_a(vUv)) / ${DISTANCE_SCALE.toFixed(1)};
    float b = (0.5 - g_b(vUv)) / ${DISTANCE_SCALE.toFixed(1)};
    float d;
    if (p_operation == 1) d = -smoothMin(-a, b, p_smooth);
    else if (p_operation == 2) d = -smoothMin(-a, -b, p_smooth);
    else if (p_operation == 3) d = max(smoothMin(a, b, p_smooth), smoothMin(-a, -b, p_smooth));
    else d = smoothMin(a, b, p_smooth);
    writeShape(d - p_grow);
}`, { uniforms: { uWhat: what }, cost: 1 });
                result[key] = image;
            }
            return result;
        },
    },
    {
        type: 'svgShape',
        label: 'SVG shape',
        category: 'Shapes',
        description: 'Draws a shape from an SVG drawing: paste the text of an SVG file (paths, polygons, rectangles, circles and ellipses, with their transforms) or just a path\'s "d" data. It is fitted into the picture.',
        keywords: ['svg', 'svg path', 'vector import', 'path data', 'logo', 'icon', 'vector image', 'import vector'],
        inputs: [],
        outputs: [out('gray', 'out', 'Mask'), out('gray', 'distance', 'Distance')],
        params: [
            {
                key: 'svg', label: 'SVG', kind: 'string', default: 'M 50 5 L 61 39 L 97 39 L 68 61 L 79 95 L 50 74 L 21 95 L 32 61 L 3 39 L 39 39 Z',
                hint: 'The text of an SVG file, or a path\'s d data.', multiline: { accept: '.svg,image/svg+xml,text/plain', limit: 500000 },
            },
            float('margin', 'Margin', 0.1, 0, 0.45), select('rule', 'Fill rule', 'nonzero', [['nonzero', 'Non-zero'], ['evenodd', 'Even-odd (holes alternate)']]),
            float('outline', 'Outline width', 0, 0, 0.5, { step: 0.001, hint: '0 fills the shape.' }),
        ],
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const paths = fitToPicture(parseSvg(String(context.params.svg ?? '')), num(context.params, 'margin', 0.1));
            // Every outline closed for filling; open lines are drawn by their outline width only.
            const closedPaths = paths.map((path) => (path.closed || path.points.length < 3 ? path.points : [...path.points, path.points[0]]));
            const segments = segmentsOf(closedPaths);
            const texture = segmentTexture(segments);
            const offsets = wrapOffsets(segments, num(context.params, 'outline', 0), context.tiling);
            const result: Record<string, ReturnType<typeof context.image>> = {};
            try {
                for (const [key, what] of [['out', 0], ['distance', 1]] as const) {
                    const image = context.image('gray');
                    await context.pass(image, `${CURVE_GLSL}
uniform int uWhat;
${MASK_AND_DISTANCE}
void main() {
    if (uSegs == 0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    CurveHit hit = nearestOnCurve(vUv);
    float winding = windingOf(vUv);
    bool inside = p_rule == 1 ? mod(abs(winding), 2.0) > 0.5 : abs(winding) > 0.5;
    writeShape(inside ? -hit.dist : hit.dist);
}`, { inputs: { segs: texture }, uniforms: { uWhat: what, uSegs: segments.length, ...offsetUniforms(offsets) }, cost: Math.ceil(Math.max(1, segments.length) / 4) + 2 });
                    result[key] = image;
                }
            } finally {
                texture.dispose();
            }
            return result;
        },
    },
];

/** Whether SVG shape's fill rule counts a place with this winding number as inside. */
export const insideByRule = (winding: number, rule: 'nonzero' | 'evenodd'): boolean => (rule === 'evenodd' ? Math.abs(winding) % 2 === 1 : winding !== 0);
