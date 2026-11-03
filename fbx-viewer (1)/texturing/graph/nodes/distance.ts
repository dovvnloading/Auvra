import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../../gpu/textureGpu';
import { anyIn, bool, colorIn, float, grayIn, int, onePass, out, select, seed } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';
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
const distanceField = async (gpu: TextureGpu, mask: GpuImage, width: number, height: number, invert: boolean): Promise<GpuImage> => {
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
const atSize = async (context: NodeRunContext, key: string): Promise<GpuImage | null> => {
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
// Flood fill: islands of a mask, labelled on the CPU (exact, and fast enough at editing sizes)
// ---------------------------------------------------------------------------

export interface FloodIslands {
    /** Island number + 1 for each pixel, 0 outside; bottom row first. */
    labels: Float32Array;
    /** Per island: left, bottom, width, height in pixels (an island may wrap round the edges). */
    boxes: Float32Array;
    count: number;
}

/** Labels the white islands of a mask, joining across the edges as the tiled image does. */
export const labelIslands = (mask: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = 4): FloodIslands => {
    const total = width * height;
    const labels = new Float32Array(total);
    const wrapX = new Int8Array(total);
    const wrapY = new Int8Array(total);
    const queue = new Int32Array(total);
    const boxes: number[] = [];
    let count = 0;
    for (let start = 0; start < total; start++) {
        if (labels[start] || mask[start * stride] < 128) continue;
        count++;
        labels[start] = count;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const y = (index - x) / width;
            const ux = x + wrapX[index] * width;
            const uy = y + wrapY[index] * height;
            if (ux < minX) minX = ux;
            if (ux > maxX) maxX = ux;
            if (uy < minY) minY = uy;
            if (uy > maxY) maxY = uy;
            for (let k = 0; k < 4; k++) {
                let nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
                let ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
                let kx = wrapX[index];
                let ky = wrapY[index];
                if (nx < 0) { nx += width; kx--; } else if (nx >= width) { nx -= width; kx++; }
                if (ny < 0) { ny += height; ky--; } else if (ny >= height) { ny -= height; ky++; }
                const neighbour = ny * width + nx;
                if (labels[neighbour] || mask[neighbour * stride] < 128) continue;
                labels[neighbour] = count;
                wrapX[neighbour] = Math.max(-127, Math.min(127, kx));
                wrapY[neighbour] = Math.max(-127, Math.min(127, ky));
                queue[tail++] = neighbour;
            }
        }
        const left = ((minX % width) + width) % width;
        const bottom = ((minY % height) + height) % height;
        boxes.push(left, bottom, Math.min(width, maxX - minX + 1), Math.min(height, maxY - minY + 1));
    }
    return { labels, boxes: new Float32Array(boxes), count };
};

const TABLE_WIDTH = 2048;

/** GLSL reading the flood fill data an image holds: local place in its island, its random value, its size. */
const FLOOD_READ = `vec4 flood(vec2 uv) { return c_in(uv); }`;

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
    vec2 texel = 1.0 / uSize;
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
        description: 'Finds every separate white island of a mask (tiles, cells, planks) so the Flood fill nodes after it can give each its own value, colour or gradient.',
        keywords: ['islands', 'connected', 'label', 'per tile', 'shape id'],
        inputs: [grayIn('mask', 'Mask')],
        outputs: [out('color', 'out', 'Islands')],
        params: [float('threshold', 'Threshold', 0.5, 0.01, 0.99)],
        sizeFrom: 'input',
        async run(context) {
            const mask = context.input('mask');
            const result = context.image('color', context.width, context.height, 16);
            if (!mask) { context.gpu.clear(result, [0, 0, -1, 0]); return { out: result }; }
            // A crisp black and white copy at the node's size, read back.
            const binary = context.image('color', context.width, context.height, 8);
            await context.pass(binary, `void main() { outColor = vec4(step(${Number(context.params.threshold).toFixed(4)}, g_mask(vUv))); }`);
            const pixels = context.gpu.readRgba8(binary, context.width, context.height, 'raw', false);
            context.gpu.release(binary);
            const islands = labelIslands(pixels, context.width, context.height);
            const labels = context.image('gray', context.width, context.height, 32);
            context.gpu.write(labels, islands.labels);
            const rows = Math.max(1, Math.ceil(islands.count / TABLE_WIDTH));
            const table = new Float32Array(TABLE_WIDTH * rows * 4);
            table.set(islands.boxes);
            const tableTexture = new THREE.DataTexture(table, TABLE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
            tableTexture.minFilter = tableTexture.magFilter = THREE.NearestFilter;
            tableTexture.needsUpdate = true;
            await context.gpu.pass(result, {
                fragment: `void main() {
    float id = texelFetch(labels, ivec2(gl_FragCoord.xy), 0).r;
    if (id < 0.5) { outColor = vec4(0.0, 0.0, -1.0, 0.0); return; }
    int index = int(id + 0.5) - 1;
    vec4 box = texelFetch(boxes, ivec2(index % ${TABLE_WIDTH}, index / ${TABLE_WIDTH}), 0);
    vec2 p = floor(gl_FragCoord.xy);
    vec2 local = (mod(p - box.xy, uSize) + 0.5) / max(box.zw, vec2(1.0));
    // A random value from where the island starts, so it stays the same as the mask changes elsewhere.
    float random = hash1(ivec2(box.xy), 4.123);
    outColor = vec4(local, random, max(box.z, box.w) / max(uSize.x, uSize.y));
}`,
                inputs: { labels, boxes: tableTexture },
            });
            context.gpu.release(labels);
            tableTexture.dispose();
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
        glsl: `${FLOOD_READ}\nvoid main() { vec4 f = flood(vUv); outColor = vec4(f.b < 0.0 ? 0.0 : saturate(f.a * p_scale)); }`,
    }),
    onePass({
        type: 'floodMapper',
        label: 'Flood fill mapper',
        category: 'Edges and distance',
        description: 'Fits a pattern into every island from a Flood fill, each turned and offset at random.',
        keywords: ['per tile pattern', 'map pattern to tiles'],
        inputs: [colorIn('in', 'Flood fill'), anyIn('pattern', 'Pattern', 'white')],
        outputs: [out('any')],
        params: [float('rotationRandom', 'Turn randomness', 0, 0, 1), float('offsetRandom', 'Offset randomness', 0, 0, 1), float('brightnessRandom', 'Brightness randomness', 0, 0, 1), seed()],
        sizeFrom: 'input',
        kindFrom: 'pattern',
        glsl: `${FLOOD_READ}\nvoid main() {
    vec4 f = flood(vUv);
    if (f.b < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 p = f.xy - 0.5;
    p = rotate2(floor(hashF(f.b, uSeed) * 4.0 * p_rotationRandom) * PI * 0.5) * p;
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
        description: 'A tangent-space normal map from a height map: how a raised surface would catch the light.',
        keywords: ['normal', 'height to normal', 'bump'],
        inputs: [grayIn('in', 'Height', 'mid')],
        outputs: [out('color')],
        params: [float('intensity', 'Strength', 4, 0, 64, { softMax: 20 }), select('format', 'Format', 'opengl', [['opengl', 'Green up (OpenGL)'], ['directx', 'Green down (DirectX)']])],
        sizeFrom: 'input',
        preview: 'normal',
        cost: () => 8,
        glsl: `void main() {
    vec2 t = 1.0 / uSize;
    float tl = g_in(vUv + vec2(-t.x, t.y)), tc = g_in(vUv + vec2(0.0, t.y)), tr = g_in(vUv + t);
    float ml = g_in(vUv - vec2(t.x, 0.0)), mr = g_in(vUv + vec2(t.x, 0.0));
    float bl = g_in(vUv - t), bc = g_in(vUv - vec2(0.0, t.y)), br = g_in(vUv + vec2(t.x, -t.y));
    // Sobel, as slope per unit of the image so the strength reads the same at any size.
    float dx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) / 8.0 * uSize.x / 64.0;
    float dy = ((tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br)) / 8.0 * uSize.y / 64.0;
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
        description: 'From a normal map, bright where the surface bulges out (edges) and dark where it dips in (creases). The radius takes in broader shapes.',
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
                fragment: `uniform float uIntensity;\nuniform float uScale;
void main() {
    vec2 t = 1.0 / vec2(textureSize(source, 0));
    float dx = texture(source, vUv + vec2(t.x, 0.0)).x - texture(source, vUv - vec2(t.x, 0.0)).x;
    float dy = texture(source, vUv + vec2(0.0, t.y)).y - texture(source, vUv - vec2(0.0, t.y)).y;
    outColor = vec4(saturate(0.5 + (dx + dy) * uIntensity * uScale));
}`,
                inputs: { source: normal ?? context.gpu.constant('normal') },
                uniforms: { uIntensity: Number(context.params.intensity), uScale: 1 + radius * 200 },
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
            float elevation = (h - h0) / r;
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
                fragment: 'void main() { vec3 n = texture(source, vUv).xyz * 2.0 - 1.0; n.z = max(n.z, 0.05); outColor = vec4(-n.xy / n.z / max(uSize.x, uSize.y) * 64.0, 0.0, 1.0); }',
                inputs: { source: input },
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
