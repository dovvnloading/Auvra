import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import type { TexturingGpu as TextureGpu } from '../../gpu/texturingGpu';
import { anyIn, bool, colorIn, float, grayIn, int, onePass, out, select, seed } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';
import { FLOOD_ANY, FLOOD_BOX_VERTEX, FLOOD_CHANGED, FLOOD_HOOK, FLOOD_JUMP, FLOOD_RESULT, FLOOD_SEAMS, FLOOD_START } from '../flood';
import { gaussianBlur } from './transform';

/**
 * Distance, edges and islands. Distances come from jump flooding: every pixel learns the nearest
 * pixel of a set in a dozen passes, wrapping round the edges so a tiling image stays tiling.
 */

const TORUS_DISTANCE = `vec2 torusDelta(vec2 a, vec2 b, vec2 size) { vec2 d = abs(a - b); return min(d, size - d); }`;

/**
 * For every pixel, the place of the nearest pixel where `isSeed` holds (in pixels), in .xy, with
 * .z 1 where any was found. `seedTest` is GLSL reading `texture(mask, vUv)` into a bool.
 */
export const jumpFlood = async (gpu: TextureGpu, mask: GpuImage | THREE.Texture, width: number, height: number, seedTest: string): Promise<GpuImage> => {
    let current = gpu.image(width, height, 'color', 32);
    await gpu.pass(current, {
        fragment: `void main() { vec4 m = texture(mask, vUv); outColor = (${seedTest}) ? vec4(gl_FragCoord.xy, 1.0, 0.0) : vec4(0.0); }`,
        inputs: { mask },
    });
    let step = 1;
    while (step * 2 < Math.max(width, height)) step *= 2;
    const steps: number[] = [];
    for (; step >= 1; step = Math.floor(step / 2)) steps.push(step);
    steps.push(1);
    for (const jump of steps) {
        const next = gpu.image(width, height, 'color', 32);
        await gpu.pass(next, {
            fragment: `uniform int uJump;
${TORUS_DISTANCE}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 best = texelFetch(source, p, 0);
    float bestDistance = best.z > 0.0 ? dot(torusDelta(best.xy, gl_FragCoord.xy, uSize), torusDelta(best.xy, gl_FragCoord.xy, uSize)) : 1e30;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            vec4 q = texelWrap(source, p + ivec2(x, y) * uJump);
            if (q.z <= 0.0) continue;
            vec2 d = torusDelta(q.xy, gl_FragCoord.xy, uSize);
            float dd = dot(d, d);
            if (dd < bestDistance) { bestDistance = dd; best = q; }
        }
    }
    outColor = best;
}`,
            inputs: { source: current },
            uniforms: { uJump: jump },
            cost: 9,
        });
        gpu.release(current);
        current = next;
    }
    return current;
};

const seedOf = (invert: boolean, threshold = 0.5): string => (invert ? `m.r < ${threshold.toFixed(4)}` : `m.r >= ${threshold.toFixed(4)}`);

/** Distance in pixels from each pixel to the nearest seed, as a 32-bit grey image. */
export const distanceField = async (gpu: TextureGpu, mask: GpuImage, width: number, height: number, invert: boolean): Promise<GpuImage> => {
    const nearest = await jumpFlood(gpu, mask, width, height, seedOf(invert));
    const distance = gpu.image(width, height, 'gray', 32);
    await gpu.pass(distance, {
        fragment: `${TORUS_DISTANCE}\nvoid main() { vec4 q = texelFetch(nearest, ivec2(gl_FragCoord.xy), 0); outColor = vec4(q.z > 0.0 ? length(torusDelta(q.xy, gl_FragCoord.xy, uSize)) : 1e6); }`,
        inputs: { nearest },
    });
    gpu.release(nearest);
    return distance;
};

/** A grey input at the node's size (a mask needs its own pixels, not resampled ones). */
export const atSize = async (context: NodeRunContext, key: string): Promise<GpuImage | null> => {
    const input = context.input(key);
    if (!input) return null;
    if (input.width === context.width && input.height === context.height && input.kind === 'gray') return context.gpu.retain(input);
    const sized = context.image('gray', context.width, context.height, 16);
    await context.pass(sized, `void main() { outColor = vec4(g_${key}(vUv)); }`);
    return sized;
};

const emptyResult = (context: NodeRunContext, value = 0) => {
    const image = context.image(context.outputKind('out'));
    context.gpu.clear(image, [value, value, value, 1]);
    return image;
};

// ---------------------------------------------------------------------------
// Flood fill: islands of a mask, labelled on the GPU (flood.ts)
// ---------------------------------------------------------------------------

/** Rounds of hooking and jumping between checks of whether the labels have settled. */
const ROUNDS_A_CHECK = 6;
/** Checks at most: past that the labels are kept as they are (only very winding islands get there). */
const MOST_CHECKS = 40;

/** True when any pixel differs between two label images: halved to one pixel on the GPU, and only that read. */
const labelsChanged = async (gpu: TextureGpu, before: GpuImage, after: GpuImage): Promise<boolean> => {
    let level = gpu.image(after.width, after.height, 'gray', 8);
    await gpu.pass(level, { fragment: FLOOD_CHANGED, inputs: { before, labels: after } });
    while (level.width > 1 || level.height > 1) {
        const half = gpu.image(Math.max(1, Math.ceil(level.width / 2)), Math.max(1, Math.ceil(level.height / 2)), 'gray', 8);
        await gpu.pass(half, { fragment: FLOOD_ANY, inputs: { source: level } });
        gpu.release(level);
        level = half;
    }
    const value = await gpu.readPixelLater(level, 0, 0);
    gpu.release(level);
    return Boolean(value && value[0] > 0.5);
};

/** Each pixel's island label (its root's place) in .xy, .z 1 inside the mask: hooking and pointer jumping until settled. */
const labelIslandsGpu = async (context: NodeRunContext, mask: GpuImage, threshold: number): Promise<GpuImage> => {
    const { gpu, width, height } = context;
    const wrapAxes = [context.tiling[0] ? 1 : 0, context.tiling[1] ? 1 : 0];
    let labels = gpu.image(width, height, 'color', 32);
    await gpu.pass(labels, { fragment: FLOOD_START, inputs: { mask }, uniforms: { uThreshold: threshold, uGray: mask.kind === 'gray' ? 1 : 0 } });
    const step = async (fragment: string): Promise<void> => {
        const next = gpu.image(width, height, 'color', 32);
        await gpu.pass(next, { fragment, inputs: { labels }, uniforms: { uWrapAxes: wrapAxes } });
        gpu.release(labels);
        labels = next;
    };
    for (let check = 0; check < MOST_CHECKS; check++) {
        for (let round = 0; round < ROUNDS_A_CHECK - 1; round++) { await step(FLOOD_HOOK); await step(FLOOD_JUMP); await step(FLOOD_JUMP); }
        const before = gpu.retain(labels);
        await step(FLOOD_HOOK);
        await step(FLOOD_JUMP);
        await step(FLOOD_JUMP);
        const changed = await labelsChanged(gpu, before, labels);
        gpu.release(before);
        if (!changed) break;
    }
    return labels;
};

/**
 * GLSL reading the flood fill data an image holds: local place in its island's box, its random value
 * (negative outside), and the box's size (as parts of the image, packed); with the box's size in pixels
 * and its corner and middle (pixels) worked out from them.
 */
const FLOOD_READ = `vec4 flood(vec2 uv) { return texelFetch(t_in, ivec2(uv * vec2(textureSize(t_in, 0))), 0); }
vec2 floodBoxSize(vec4 f) { return vec2(floor(f.a / 4096.0), mod(f.a, 4096.0)) / 4095.0; }
vec2 floodBoxPixels(vec4 f) { return max(floodBoxSize(f) * uSize, vec2(1.0)); }
vec2 floodBoxCorner(vec4 f) { return floor(gl_FragCoord.xy - f.xy * floodBoxPixels(f) + 0.5); }`;

export const DISTANCE_NODES: TexNodeDef[] = [
    {
        type: 'distance',
        label: 'Distance',
        category: 'Edges and distance',
        description: 'Fades out from the white parts of a mask over a distance. With a source wired in, also spreads the source\'s colours outward from the mask.',
        keywords: ['glow', 'spread', 'propagate', 'falloff', 'dilate colour', 'voronoi fill'],
        inputs: [grayIn('mask', 'Mask'), anyIn('source', 'Source to spread')],
        outputs: [out('gray', 'out', 'Distance'), out('any', 'spread', 'Spread')],
        params: [float('distance', 'Distance', 0.1, 0, 1, { step: 0.001 }), bool('inside', 'Measure inside instead', false)],
        sizeFrom: 'input',
        kindFrom: 'source',
        async run(context) {
            const mask = await atSize(context, 'mask');
            const result = context.image('gray');
            const spread = context.image(context.outputKind('spread'));
            if (!mask) {
                context.gpu.clear(result, [0, 0, 0, 1]);
                context.gpu.clear(spread, [0, 0, 0, 1]);
                return { out: result, spread };
            }
            const inside = Boolean(context.params.inside);
            const nearest = await jumpFlood(context.gpu, mask, context.width, context.height, seedOf(inside));
            const maxPixels = Math.max(1e-3, Number(context.params.distance) * context.width);
            await context.pass(result, `uniform sampler2D nearest;\nuniform float uMax;\n${TORUS_DISTANCE}
void main() { vec4 q = texelFetch(nearest, ivec2(gl_FragCoord.xy), 0); float d = q.z > 0.0 ? length(torusDelta(q.xy, gl_FragCoord.xy, uSize)) : 1e6; outColor = vec4(saturate(1.0 - d / uMax)); }`, { inputs: { nearest }, uniforms: { uMax: maxPixels } });
            await context.pass(spread, `uniform sampler2D nearest;
void main() { vec4 q = texelFetch(nearest, ivec2(gl_FragCoord.xy), 0); outColor = q.z > 0.0 ? c_source((q.xy) / uSize) : vec4(0.0, 0.0, 0.0, 1.0); }`, { inputs: { nearest } });
            context.gpu.release(nearest);
            context.gpu.release(mask);
            return { out: result, spread };
        },
    },
    {
        type: 'bevel',
        label: 'Bevel',
        category: 'Edges and distance',
        description: 'Turns a mask into a raised shape whose edges slope over a width, straight, smooth or round.',
        keywords: ['chamfer', 'round edges', 'height from mask', 'inflate'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [float('width', 'Width', 0.02, 0, 0.5, { step: 0.001 }), select('profile', 'Shape', 'smooth', [['linear', 'Straight'], ['smooth', 'Smooth'], ['round', 'Round'], ['concave', 'Hollow']]), bool('outside', 'Slope outward', false)],
        sizeFrom: 'input',
        async run(context) {
            const mask = await atSize(context, 'mask');
            if (!mask) return { out: emptyResult(context) };
            const outward = Boolean(context.params.outside);
            const distance = await distanceField(context.gpu, mask, context.width, context.height, !outward);
            const result = context.image('gray');
            await context.pass(result, `uniform sampler2D distanceMap;\nuniform sampler2D maskMap;\nuniform float uWidth;
void main() {
    float d = texture(distanceMap, vUv).r;
    bool inMask = texture(maskMap, vUv).r >= 0.5;
    float t = ${outward ? 'inMask ? 1.0 : saturate(1.0 - d / uWidth)' : 'inMask ? saturate(d / uWidth) : 0.0'};
    if (p_profile == 1) t = t * t * (3.0 - 2.0 * t);
    else if (p_profile == 2) t = sqrt(1.0 - (1.0 - t) * (1.0 - t));
    else if (p_profile == 3) t = t * t;
    outColor = vec4(t);
}`, { inputs: { distanceMap: distance, maskMap: mask }, uniforms: { uWidth: Math.max(0.5, Number(context.params.width) * context.width) } });
            context.gpu.release(distance);
            context.gpu.release(mask);
            return { out: result };
        },
    },
    {
        type: 'morphology',
        label: 'Grow or shrink',
        category: 'Edges and distance',
        description: 'Grows the white parts of a mask outward, or shrinks them inward, by a distance.',
        keywords: ['dilate', 'erode', 'expand', 'contract', 'morphology'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('gray')],
        params: [select('mode', 'Do', 'grow', [['grow', 'Grow'], ['shrink', 'Shrink']]), float('distance', 'Distance', 0.01, 0, 0.5, { step: 0.001 })],
        sizeFrom: 'input',
        async run(context) {
            const mask = await atSize(context, 'mask');
            if (!mask) return { out: emptyResult(context) };
            const grow = context.params.mode !== 'shrink';
            const distance = await distanceField(context.gpu, mask, context.width, context.height, !grow);
            const result = context.image('gray');
            await context.pass(result, `uniform sampler2D distanceMap;\nuniform float uRadius;
void main() { float d = texture(distanceMap, vUv).r; outColor = vec4(${grow ? '1.0 - smoothstep(uRadius - 0.5, uRadius + 0.5, d)' : 'smoothstep(uRadius - 0.5, uRadius + 0.5, d)'}); }`, { inputs: { distanceMap: distance }, uniforms: { uRadius: Number(context.params.distance) * context.width } });
            context.gpu.release(distance);
            context.gpu.release(mask);
            return { out: result };
        },
    },
    {
        type: 'edgeDetect',
        label: 'Edge detect',
        category: 'Edges and distance',
        description: 'Draws lines of a chosen width along the borders between different values: the outlines of tiles, cells or an ID map.',
        keywords: ['outline', 'border', 'contour', 'edges'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('gray')],
        params: [float('width', 'Width', 0.005, 0, 0.1, { step: 0.0005 }), float('tolerance', 'Tolerance', 0.05, 0, 1), float('softness', 'Softness', 0.5, 0, 1)],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            if (!input) return { out: emptyResult(context) };
            const edges = context.image('gray', context.width, context.height, 8);
            await context.pass(edges, `void main() {
    // Borders between pixels of the input, not of this node.
    vec2 texel = 1.0 / vec2(textureSize(t_in, 0));
    vec4 c = c_in(vUv);
    float d = max(max(distance(c, c_in(vUv + vec2(texel.x, 0.0))), distance(c, c_in(vUv - vec2(texel.x, 0.0)))), max(distance(c, c_in(vUv + vec2(0.0, texel.y))), distance(c, c_in(vUv - vec2(0.0, texel.y)))));
    outColor = vec4(step(p_tolerance + 1e-4, d));
}`);
            const distance = await distanceField(context.gpu, edges, context.width, context.height, false);
            context.gpu.release(edges);
            const result = context.image('gray');
            await context.pass(result, `uniform sampler2D distanceMap;\nuniform float uWidth;
void main() { float d = texture(distanceMap, vUv).r; outColor = vec4(1.0 - smoothstep(uWidth * (1.0 - p_softness) - 0.5, uWidth + 0.5, d)); }`, { inputs: { distanceMap: distance }, uniforms: { uWidth: Math.max(0.5, Number(context.params.width) * context.width) } });
            context.gpu.release(distance);
            return { out: result };
        },
    },
    {
        type: 'floodFill',
        label: 'Flood fill',
        category: 'Edges and distance',
        description: 'Finds every separate white island of a mask (tiles, cells, planks), all on the GPU, so the Flood fill nodes after it can give each its own value, colour, gradient, index, position or pattern. Where the image tiles, an island over an edge is one island.',
        keywords: ['islands', 'connected', 'label', 'per tile', 'shape id'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('color', 'out', 'Islands')],
        params: [float('threshold', 'Threshold', 0.5, 0.01, 0.99)],
        sizeFrom: 'input',
        async run(context) {
            const mask = context.input('mask');
            const { width, height } = context;
            // Full float, so the random value every island gets (24 bits of it) is kept exactly.
            const result = context.image('color', width, height, 32);
            if (!mask) { context.gpu.clear(result, [0, 0, -1, 0]); return { out: result }; }
            const labels = await labelIslandsGpu(context, mask, Number(context.params.threshold) || 0.5);
            const wrapAxes = [context.tiling[0] ? 1 : 0, context.tiling[1] ? 1 : 0];
            // Each island's box: every pixel adds its offset from the root into the root, largest each way.
            // Where the image tiles, once for each place offsets can wrap round (the narrowest box wins), so
            // an island more than half the picture across gets its own box.
            const seams = wrapAxes[0] || wrapAxes[1] ? FLOOD_SEAMS : [0.5];
            const boxes: GpuImage[] = [];
            for (const seam of seams) {
                const box = context.image('color', width, height, 32);
                await context.gpu.drawInstances(box, {
                    count: width * height, points: true, varyings: ['vec4 vBox'], vertex: FLOOD_BOX_VERTEX, fragment: 'void main() { outColor = vBox; }',
                    inputs: { labels }, uniforms: { uWidth: width, uWrapAxes: wrapAxes, uSeam: new THREE.Vector2(seam, seam) }, stack: 'max', clear: [-1e9, -1e9, -1e9, -1e9],
                });
                boxes.push(box);
            }
            const seamVector = new THREE.Vector4(...[0, 1, 2, 3].map((index) => seams[Math.min(index, seams.length - 1)]));
            await context.gpu.pass(result, {
                fragment: FLOOD_RESULT,
                inputs: { labels, boxes0: boxes[0], boxes1: boxes[1] ?? boxes[0], boxes2: boxes[2] ?? boxes[0], boxes3: boxes[3] ?? boxes[0] },
                uniforms: { uWrapAxes: wrapAxes, uSeamCount: seams.length, uSeamsX: seamVector, uSeamsY: seamVector },
            });
            context.gpu.release(labels);
            return { out: result };
        },
    },
    onePass({
        type: 'floodRandomGray',
        label: 'Flood fill to random grey',
        category: 'Edges and distance',
        description: 'Gives every island from a Flood fill its own random grey.',
        keywords: ['per tile value', 'random luminance'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('gray')],
        params: [seed()],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() { vec4 f = flood(vUv); outColor = vec4(f.b < 0.0 ? 0.0 : hashF(f.b, uSeed)); }`,
    }),
    onePass({
        type: 'floodRandomColor',
        label: 'Flood fill to random colour',
        category: 'Edges and distance',
        description: 'Gives every island from a Flood fill its own random colour, as an ID map.',
        keywords: ['id map', 'per tile colour'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('color')],
        params: [seed()],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() { vec4 f = flood(vUv); outColor = f.b < 0.0 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(hashF(f.b, uSeed), hashF(f.b, uSeed + 1.0), hashF(f.b, uSeed + 2.0), 1.0); }`,
    }),
    onePass({
        type: 'floodGradient',
        label: 'Flood fill to gradient',
        category: 'Edges and distance',
        description: 'Runs a gradient across every island from a Flood fill, each at its own angle if you like: grain direction per plank, slope per tile.',
        keywords: ['per tile gradient', 'slope per island'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('gray')],
        params: [float('angle', 'Angle (degrees)', 0, -360, 360, { step: 1 }), float('angleRandom', 'Angle randomness', 0, 0, 1), float('strengthRandom', 'Strength randomness', 0, 0, 1), seed()],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0); return; }
    float a = radians(p_angle) + (hashF(f.b, uSeed) - 0.5) * TAU * p_angleRandom;
    vec2 d = vec2(cos(a), sin(a));
    float t = dot(f.xy - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
    float strength = 1.0 - hashF(f.b, uSeed + 3.0) * p_strengthRandom;
    outColor = vec4(saturate(mix(0.5, t, strength)));
}`,
    }),
    onePass({
        type: 'floodSize',
        label: 'Flood fill to size',
        category: 'Edges and distance',
        description: 'Each island from a Flood fill as bright as it is big.',
        keywords: ['bounding box size', 'island size'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('gray')],
        params: [float('scale', 'Scale', 1, 0.1, 10)],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() { vec4 f = flood(vUv); vec2 box = floodBoxPixels(f); outColor = vec4(f.b < 0.0 ? 0.0 : saturate(max(box.x, box.y) / max(uSize.x, uSize.y) * p_scale)); }`,
    }),
    onePass({
        type: 'floodBox',
        label: 'Flood fill to bounding box',
        category: 'Edges and distance',
        description: 'Each island from a Flood fill as bright as its bounding box is wide, tall, its larger side, or its area (as parts of the image).',
        keywords: ['bounding box', 'bbox', 'island width', 'island height', 'per tile size'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('gray')],
        params: [select('measure', 'Measure', 'larger', [['width', 'Width'], ['height', 'Height'], ['larger', 'Larger side'], ['area', 'Area']]), float('scale', 'Scale', 1, 0.1, 10)],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0); return; }
    vec2 box = floodBoxSize(f);
    float v = p_measure == 0 ? box.x : p_measure == 1 ? box.y : p_measure == 2 ? max(box.x, box.y) : box.x * box.y;
    outColor = vec4(saturate(v * p_scale));
}`,
    }),
    onePass({
        type: 'floodIndex',
        label: 'Flood fill to index',
        category: 'Edges and distance',
        description: 'Numbers the islands from a Flood fill in order, by where their boxes start (row by row from the bottom), as greys from black to white.',
        keywords: ['island index', 'order', 'per tile number', 'id'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('gray')],
        params: [],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0); return; }
    vec2 corner = mod(floodBoxCorner(f), uSize);
    outColor = vec4((corner.y * uSize.x + corner.x + 1.0) / (uSize.x * uSize.y));
}`,
    }),
    onePass({
        type: 'floodPosition',
        label: 'Flood fill to position',
        category: 'Edges and distance',
        description: 'Gives every island from a Flood fill the place of its middle, as red (across) and green (down) from 0 to 1: for sampling a picture once per island.',
        keywords: ['island position', 'centre', 'per tile position', 'sample per tile'],
        inputs: [colorIn('in', 'Flood fill')],
        outputs: [out('color')],
        params: [],
        sizeFrom: 'input',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 middle = floodBoxCorner(f) + floodBoxPixels(f) * 0.5;
    outColor = vec4(fract(middle / uSize), 0.0, 1.0);
}`,
    }),
    onePass({
        type: 'floodMapper',
        label: 'Flood fill mapper',
        category: 'Edges and distance',
        description: 'Fits a pattern into every island from a Flood fill, each turned (by any angle), scaled, flipped and offset at random.',
        keywords: ['per tile pattern', 'map pattern to tiles'],
        inputs: [colorIn('in', 'Flood fill'), anyIn('pattern', 'Pattern', 'white')],
        outputs: [out('any')],
        params: [
            float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
            float('rotationRandom', 'Turn randomness', 0, 0, 1),
            float('scale', 'Scale', 1, 0.05, 8),
            float('scaleRandom', 'Scale randomness', 0, 0, 1),
            bool('flipX', 'Flip across at random', false),
            bool('flipY', 'Flip down at random', false),
            float('offsetRandom', 'Offset randomness', 0, 0, 1),
            float('brightnessRandom', 'Brightness randomness', 0, 0, 1),
            seed(),
        ],
        sizeFrom: 'input',
        kindFrom: 'pattern',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 p = f.xy - 0.5;
    if (p_flipX == 1 && hashF(f.b, uSeed + 5.0) < 0.5) p.x = -p.x;
    if (p_flipY == 1 && hashF(f.b, uSeed + 6.0) < 0.5) p.y = -p.y;
    p = rotate2(radians(p_rotation) + (hashF(f.b, uSeed) - 0.5) * TAU * p_rotationRandom) * p;
    p /= max(p_scale * (1.0 - hashF(f.b, uSeed + 4.0) * p_scaleRandom), 1e-3);
    p += 0.5 + (vec2(hashF(f.b, uSeed + 1.0), hashF(f.b, uSeed + 2.0)) - 0.5) * p_offsetRandom;
    vec4 v = c_pattern(fract(p));
    v.rgb *= 1.0 - hashF(f.b, uSeed + 3.0) * p_brightnessRandom;
    outColor = v;
}`,
    }),

    // ---- height and normals ----
    onePass({
        type: 'normalFromHeight',
        label: 'Normal from height',
        category: 'Height and normals',
        description: 'A tangent-space normal map from a height map: how a raised surface would catch the light. With the graph\'s size in the world set, slopes are measured per metre, so the same heights make the same bumps at any picture size.',
        keywords: ['normal', 'height to normal', 'bump'],
        inputs: [grayIn('in', 'Height', 'mid')],
        outputs: [out('color')],
        params: [float('intensity', 'Strength', 4, 0, 64, { softMax: 20 }), select('format', 'Format', 'opengl', [['opengl', 'Green up (OpenGL)'], ['directx', 'Green down (DirectX)']])],
        sizeFrom: 'input',
        preview: 'normal',
        cost: () => 8,
        glsl: `void main() {
    // Steps of one pixel of the height map, not of this node: a size change here only resamples the result.
    vec2 inputSize = vec2(textureSize(t_in, 0));
    vec2 t = 1.0 / inputSize;
    float tl = g_in(vUv + vec2(-t.x, t.y)), tc = g_in(vUv + vec2(0.0, t.y)), tr = g_in(vUv + t);
    float ml = g_in(vUv - vec2(t.x, 0.0)), mr = g_in(vUv + vec2(t.x, 0.0));
    float bl = g_in(vUv - t), bc = g_in(vUv - vec2(0.0, t.y)), br = g_in(vUv + vec2(t.x, -t.y));
    // Sobel, as slope per unit of the image so the strength reads the same at any size, then per metre
    // of the graph's size in the world (one metre when it has none).
    float dx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) / 8.0 * inputSize.x / 64.0 / uWorld.x;
    float dy = ((tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br)) / 8.0 * inputSize.y / 64.0 / uWorld.y;
    vec3 n = normalize(vec3(-dx * p_intensity, -dy * p_intensity, 1.0));
    if (p_format == 1) n.y = -n.y;
    outColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
    }),
    onePass({
        type: 'normalCombine',
        label: 'Normal combine',
        category: 'Height and normals',
        description: 'Lays the detail of one normal map over another, keeping both.',
        keywords: ['normal blend', 'detail normal', 'reoriented', 'rnm'],
        inputs: [colorIn('base', 'Base', 'normal'), colorIn('detail', 'Detail', 'normal'), grayIn('mask', 'Mask', 'white')],
        outputs: [out('color')],
        params: [select('mode', 'Method', 'reoriented', [['reoriented', 'Reoriented (best)'], ['whiteout', 'Whiteout'], ['linear', 'Simple mix']]), float('strength', 'Detail strength', 1, 0, 2)],
        sizeFrom: 'input',
        preview: 'normal',
        glsl: `void main() {
    vec3 a = c_base(vUv).xyz * 2.0 - 1.0;
    vec3 b = c_detail(vUv).xyz * 2.0 - 1.0;
    b.xy *= p_strength * g_mask(vUv);
    b = normalize(b);
    vec3 n;
    if (p_mode == 0) {
        vec3 t = a + vec3(0.0, 0.0, 1.0);
        vec3 u = b * vec3(-1.0, -1.0, 1.0);
        n = t * dot(t, u) / max(t.z, 1e-4) - u;
    } else if (p_mode == 1) n = vec3(a.xy + b.xy, a.z * b.z);
    else n = a + vec3(b.xy, 0.0);
    outColor = vec4(normalize(n) * 0.5 + 0.5, 1.0);
}`,
    }),
    onePass({
        type: 'normalAdjust',
        label: 'Normal adjust',
        category: 'Height and normals',
        description: 'Makes a normal map stronger or flatter, flips its green for the other convention, or renormalises it.',
        keywords: ['normal intensity', 'flip green', 'invert normal', 'normalize', 'directx'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('color')],
        params: [float('strength', 'Strength', 1, 0, 8), bool('flipGreen', 'Flip green', false), bool('flipRed', 'Flip red', false)],
        sizeFrom: 'input',
        preview: 'normal',
        glsl: `void main() {
    vec3 n = c_in(vUv).xyz * 2.0 - 1.0;
    n.xy *= p_strength;
    if (p_flipGreen == 1) n.y = -n.y;
    if (p_flipRed == 1) n.x = -n.x;
    outColor = vec4(normalize(vec3(n.xy, max(n.z, 1e-3))) * 0.5 + 0.5, 1.0);
}`,
    }),
    {
        type: 'curvature',
        label: 'Curvature',
        category: 'Height and normals',
        description: 'From a normal map, bright where the surface bulges out (edges) and dark where it dips in (creases). The radius takes in broader shapes. The same at any picture size; with the graph\'s size in the world set, measured per metre.',
        keywords: ['convex', 'concave', 'edges', 'cavity', 'curvature smooth'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('gray')],
        params: [float('intensity', 'Strength', 1, 0, 16), float('radius', 'Radius', 0, 0, 0.05, { step: 0.0005 })],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            let normal = input ? context.gpu.retain(input) : null;
            const radius = Number(context.params.radius) || 0;
            if (normal && radius > 0) {
                const blurred = await gaussianBlur(context, normal, radius * normal.width / 3, 16);
                context.gpu.release(normal);
                normal = blurred;
            }
            const result = context.image('gray');
            await context.gpu.pass(result, {
                fragment: `uniform float uIntensity;\nuniform float uScale;\nuniform vec2 uWorld;
void main() {
    vec2 size = vec2(textureSize(source, 0));
    vec2 t = 1.0 / size;
    // Change of the normal per unit of the picture (as it reads across two pixels at 1024), per metre.
    vec2 across = size / 1024.0 / uWorld;
    float dx = (texture(source, vUv + vec2(t.x, 0.0)).x - texture(source, vUv - vec2(t.x, 0.0)).x) * across.x;
    float dy = (texture(source, vUv + vec2(0.0, t.y)).y - texture(source, vUv - vec2(0.0, t.y)).y) * across.y;
    outColor = vec4(saturate(0.5 + (dx + dy) * uIntensity * uScale));
}`,
                inputs: { source: normal ?? context.gpu.constant('normal') },
                uniforms: { uIntensity: Number(context.params.intensity), uScale: 1 + radius * 200, uWorld: new THREE.Vector2(context.world[0], context.world[1]) },
                cost: 4,
            });
            context.gpu.release(normal);
            return { out: result };
        },
    },
    onePass({
        type: 'aoFromHeight',
        label: 'Ambient occlusion from height',
        category: 'Height and normals',
        description: 'Darkens the dips of a height map that light would struggle to reach.',
        keywords: ['ao', 'occlusion', 'cavity', 'hbao', 'shadow'],
        inputs: [grayIn('in', 'Height')],
        outputs: [out('gray')],
        params: [float('depth', 'Height depth', 0.1, 0, 1), float('radius', 'Radius', 0.05, 0.001, 0.5, { step: 0.001 }), float('intensity', 'Strength', 1, 0, 4), int('quality', 'Quality', 2, 1, 4)],
        sizeFrom: 'input',
        cost: (params) => 8 * Number(params.quality) * 8 * Number(params.quality),
        glsl: `void main() {
    int directions = 4 + 4 * p_quality;
    int steps = 4 + 4 * p_quality;
    float h0 = g_in(vUv) * p_depth;
    float jitter = hash1(ivec2(gl_FragCoord.xy), 7.0);
    float occlusion = 0.0;
    for (int d = 0; d < 20; d++) {
        if (d >= directions) break;
        float a = (float(d) + jitter) / float(directions) * TAU;
        vec2 dir = vec2(cos(a), sin(a));
        float horizon = 0.0;
        for (int s = 1; s <= 20; s++) {
            if (s > steps) break;
            float r = p_radius * (float(s) - 0.5 * jitter) / float(steps);
            float h = g_in(vUv + dir * r) * p_depth;
            // Rise over run, the run in metres of the graph's size in the world.
            float elevation = (h - h0) / (r * length(dir * uWorld));
            horizon = max(horizon, elevation);
        }
        // sin(atan(x)) without the trig.
        occlusion += horizon / sqrt(1.0 + horizon * horizon);
    }
    outColor = vec4(saturate(1.0 - occlusion / float(directions) * p_intensity));
}`,
    }),
    {
        type: 'normalToHeight',
        label: 'Height from normal',
        category: 'Height and normals',
        description: 'Rebuilds a height map that would give a normal map, solving coarse to fine, stretched to fill black to white.',
        keywords: ['normal to height', 'integrate', 'reconstruct height'],
        inputs: [colorIn('in', 'Normal', 'normal')],
        outputs: [out('gray')],
        params: [float('intensity', 'Contrast', 1, 0, 8), int('iterations', 'Quality', 24, 4, 96)],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            const result = context.image('gray');
            if (!input) { context.gpu.clear(result, [0.5, 0.5, 0.5, 1]); return { out: result }; }
            const gpu = context.gpu;
            // Slopes (height per full-size pixel) at every level, finest first.
            const slopes: GpuImage[] = [];
            let level = gpu.image(context.width, context.height, 'color', 32);
            await gpu.pass(level, {
                // As Normal from height measures them: per metre of the graph's size in the world.
                fragment: 'uniform vec2 uWorld;\nvoid main() { vec3 n = texture(source, vUv).xyz * 2.0 - 1.0; n.z = max(n.z, 0.05); outColor = vec4(-n.xy / n.z * uWorld / max(uSize.x, uSize.y) * 64.0, 0.0, 1.0); }',
                inputs: { source: input },
                uniforms: { uWorld: new THREE.Vector2(context.world[0], context.world[1]) },
            });
            slopes.push(level);
            while (level.width > 16 && level.height > 16) {
                const next = gpu.image(level.width >> 1, level.height >> 1, 'color', 32);
                // Twice as far per pixel, so twice the slope.
                await gpu.pass(next, { fragment: 'void main() { outColor = texture(source, vUv) * vec4(2.0, 2.0, 1.0, 1.0); }', inputs: { source: level } });
                slopes.push(next);
                level = next;
            }
            let height: GpuImage | null = null;
            const iterations = Math.round(Number(context.params.iterations) || 24);
            for (let index = slopes.length - 1; index >= 0; index--) {
                const slope = slopes[index];
                let current = gpu.image(slope.width, slope.height, 'gray', 32);
                // Heights keep their value from level to level (only slopes grow with the pixel size).
                if (height) await gpu.pass(current, { fragment: 'void main() { outColor = vec4(texture(source, vUv).r); }', inputs: { source: height } });
                else gpu.clear(current, [0, 0, 0, 1]);
                gpu.release(height);
                for (let step = 0; step < iterations * (index === slopes.length - 1 ? 4 : 1); step++) {
                    const next = gpu.image(slope.width, slope.height, 'gray', 32);
                    await gpu.pass(next, {
                        fragment: `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float l = texelWrap(h, p - ivec2(1, 0)).r, r = texelWrap(h, p + ivec2(1, 0)).r, d = texelWrap(h, p - ivec2(0, 1)).r, u = texelWrap(h, p + ivec2(0, 1)).r;
    float divergence = (texelWrap(s, p + ivec2(1, 0)).x - texelWrap(s, p - ivec2(1, 0)).x + texelWrap(s, p + ivec2(0, 1)).y - texelWrap(s, p - ivec2(0, 1)).y) * 0.5;
    outColor = vec4((l + r + d + u - divergence) * 0.25);
}`,
                        inputs: { h: current, s: slope },
                        cost: 8,
                    });
                    gpu.release(current);
                    current = next;
                }
                height = current;
            }
            for (const slope of slopes) gpu.release(slope);
            // The solution floats up and down as a whole and its height depends on how strong the normal
            // map was: stretch it to fill black to white, so nothing is cut off. Lowest and highest first.
            let range = gpu.image((height!.width + 1) >> 1, (height!.height + 1) >> 1, 'color', 32);
            const gather = (first: boolean) => `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy) * 2;
    ivec2 last = textureSize(source, 0) - 1;
    vec2 a = texelFetch(source, min(p, last), 0).${first ? 'rr' : 'rg'};
    vec2 b = texelFetch(source, min(p + ivec2(1, 0), last), 0).${first ? 'rr' : 'rg'};
    vec2 c = texelFetch(source, min(p + ivec2(0, 1), last), 0).${first ? 'rr' : 'rg'};
    vec2 d = texelFetch(source, min(p + ivec2(1, 1), last), 0).${first ? 'rr' : 'rg'};
    outColor = vec4(min(min(a.x, b.x), min(c.x, d.x)), max(max(a.y, b.y), max(c.y, d.y)), 0.0, 1.0);
}`;
            await gpu.pass(range, { fragment: gather(true), inputs: { source: height! } });
            while (range.width > 1 || range.height > 1) {
                const next = gpu.image((range.width + 1) >> 1, (range.height + 1) >> 1, 'color', 32);
                await gpu.pass(next, { fragment: gather(false), inputs: { source: range } });
                gpu.release(range);
                range = next;
            }
            await gpu.pass(result, {
                fragment: `uniform float uContrast;
void main() {
    vec2 span = texelFetch(range, ivec2(0), 0).rg;
    float h = span.y - span.x > 1e-6 ? (texture(source, vUv).r - span.x) / (span.y - span.x) : 0.5;
    outColor = vec4(saturate(0.5 + (h - 0.5) * uContrast));
}`,
                inputs: { source: height!, range },
                uniforms: { uContrast: Number(context.params.intensity) },
            });
            gpu.release(range);
            gpu.release(height);
            return { out: result };
        },
    },
];
