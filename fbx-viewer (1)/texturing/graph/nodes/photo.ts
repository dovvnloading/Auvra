import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { anyIn, bool, colorIn, float, grayIn, int, out, seed, select, vec2 } from '../nodeKit';
import { growFromExample } from '../quilting';
import { seamMasks, softenMask, type Picture } from '../seamCut';
import type { NodeRunContext, TexNodeDef } from '../types';
import { gaussianBlur } from './transform';

/**
 * PHOTO AND SCAN PROCESSING
 *
 * (Also growing a larger tiling picture from a small example: quilting.ts.)
 *
 * Making a photo tile by cutting along its least visible joins (seamCut.ts), and doing it with the
 * band width chosen and the light evened out first; a clone patch that takes on the light where it
 * lands; a colour equalizer that evens out light across a photo; an atlas splitter; and lighting
 * removal, which takes baked-in occlusion and shading out of a photo's colour using its occlusion and
 * height. Every one keeps (or makes) a tiling picture: they read their input pixel by pixel or with
 * wrapping, and their blurs wrap.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const whole = (params: Params, key: string, fallback: number): number => Math.round(num(params, key, fallback));

/** The largest side the joins are looked for on: a smaller copy of the picture, read back. */
const SEARCH_SIZE = 512;

/** A picture's colour read back as numbers (0 to 1, bottom row first), at most SEARCH_SIZE a side. */
const readSmall = async (context: NodeRunContext, input: GpuImage, limit = SEARCH_SIZE, size?: { width: number; height: number }): Promise<Picture | null> => {
    const width = size?.width ?? Math.min(input.width, limit);
    const height = size?.height ?? Math.min(input.height, limit);
    const small = context.gpu.image(width, height, 'color', 8);
    // Each small pixel is the average of a 4 x 4 spread over the pixels it covers.
    await context.gpu.pass(small, {
        fragment: `uniform int uGray;
void main() {
    vec4 sum = vec4(0.0);
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) sum += texture(source, fract(vUv + (vec2(float(i), float(j)) - 1.5) / (4.0 * uSize)));
    sum /= 16.0;
    outColor = uGray == 1 ? vec4(sum.rrr, 1.0) : vec4(sum.rgb, 1.0);
}`,
        inputs: { source: input },
        uniforms: { uGray: input.kind === 'gray' ? 1 : 0 },
    });
    const bytes = await context.gpu.readRgba8Later(small);
    context.gpu.release(small);
    if (!bytes) return null;
    const channels = input.kind === 'gray' ? 1 : 3;
    const data = new Float32Array(width * height * channels);
    for (let i = 0; i < width * height; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = bytes[i * 4 + c] / 255;
    return { data, width, height, channels };
};

/** The two band masks packed as a texture (red: the upright band, green: the level band), read with wrapping. */
const maskTexture = (upright: Float32Array, level: Float32Array, width: number, height: number): THREE.DataTexture => {
    const bytes = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
        bytes[i * 2] = Math.round(Math.min(1, Math.max(0, upright[i])) * 255);
        bytes[i * 2 + 1] = Math.round(Math.min(1, Math.max(0, level[i])) * 255);
    }
    const texture = new THREE.DataTexture(bytes, width, height, THREE.RGFormat, THREE.UnsignedByteType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
};

/** The picture made to tile on the GPU at full size, from the masks of its bands (see seamCut.ts). */
const SEAM_COMPOSE = `uniform sampler2D masks;
uniform float uSharp;
vec4 readWrapped(vec2 p) { return texture(t_in, fract(p)); }
float cutEdge(float m) { return uSharp > 0.0 ? smoothstep(0.5 - uSharp, 0.5 + uSharp, m) : m; }
vec4 firstPass(vec2 q) {
    float m = cutEdge(texture(masks, fract(q)).r);
    return mix(readWrapped(q + 0.5), readWrapped(q + vec2(0.0, 0.5)), m);
}
void main() {
    vec2 q = vUv - 0.5;
    float m = cutEdge(texture(masks, fract(q)).g);
    outColor = mix(firstPass(q), firstPass(q + vec2(0.0, 0.5)), m);
}`;

const CROSS_FADE = `void main() {
    vec2 d = min(vUv, 1.0 - vUv);
    float edge = min(d.x, d.y);
    float w = smoothstep(p_width, p_width * (1.0 - p_softness), edge);
    outColor = mix(texture(t_in, vUv), texture(t_in, fract(vUv + 0.5)), w);
}`;

/** Finds the joins of `picture` with bands `bandShare` of its size wide, and draws `input` made to tile into `result`. */
const drawSeamCut = async (context: NodeRunContext, input: GpuImage, picture: Picture, bandShare: number, feather: number, result: GpuImage): Promise<number> => {
    const masks = seamMasks(picture, (bandShare * Math.min(picture.width, picture.height)) / 2);
    // A soft edge `feather` pixels (of the full picture) wide: blurred on the small masks when that is a
    // pixel or more of theirs, else sharpened from their own one-pixel ramp.
    const scale = input.width / picture.width;
    const radius = feather / scale;
    const upright = radius >= 1 ? softenMask(masks.upright, picture.width, picture.height, radius) : masks.upright;
    const level = radius >= 1 ? softenMask(masks.level, picture.width, picture.height, radius) : masks.level;
    const texture = maskTexture(upright, level, picture.width, picture.height);
    try {
        const sharp = radius >= 1 || scale <= 1 ? 0 : Math.min(0.5, (0.5 * Math.max(feather, 1)) / scale);
        await context.pass(result, SEAM_COMPOSE, { inputs: { masks: texture }, uniforms: { uSharp: sharp }, cost: 6 });
    } finally {
        texture.dispose();
    }
    return masks.cost;
};

/** The average of an image (one pixel, full float), by halving two by two. */
const averageOf = async (context: NodeRunContext, image: GpuImage): Promise<GpuImage> => {
    let level = context.gpu.retain(image);
    while (level.width > 1 || level.height > 1) {
        const next = context.gpu.image(Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), image.kind, 32);
        await context.gpu.pass(next, {
            fragment: `void main() { ivec2 size = textureSize(source, 0); ivec2 base = ivec2(gl_FragCoord.xy) * 2; vec4 sum = vec4(0.0);
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) sum += texelFetch(source, min(base + ivec2(x, y), size - 1), 0);
    outColor = sum * 0.25; }`,
            inputs: { source: level },
        });
        context.gpu.release(level);
        level = next;
    }
    return level;
};

/** Light evened out: each pixel scaled by the picture's average over its surroundings' (a wrapping blur `size` of the picture wide). */
const EVEN_LIGHT = `uniform sampler2D low;
uniform sampler2D mean;
uniform int uGray;
uniform int uChannels;
uniform float uAmount;
vec3 readOf(sampler2D pic, vec2 p) { vec4 c = texture(pic, p); return uGray == 1 ? c.rrr : c.rgb; }
void main() {
    vec4 c = texture(t_in, vUv);
    vec3 colour = uGray == 1 ? c.rrr : c.rgb;
    vec3 around = readOf(low, vUv);
    vec3 overall = uGray == 1 ? texelFetch(mean, ivec2(0), 0).rrr : texelFetch(mean, ivec2(0), 0).rgb;
    vec3 gain = uChannels == 1 ? overall / max(around, vec3(1e-4)) : vec3(luma(overall) / max(luma(around), 1e-4));
    colour *= mix(vec3(1.0), clamp(gain, vec3(0.0), vec3(8.0)), uAmount);
    outColor = uGray == 1 ? vec4(colour.r, colour.r, colour.r, c.a) : vec4(colour, c.a);
}`;

/** `input` with its light evened out, as a new image of its kind and size. */
const evenLight = async (context: NodeRunContext, input: GpuImage, size: number, amount: number, channels: boolean): Promise<GpuImage> => {
    const low = await gaussianBlur(context, input, Math.max(0.5, (size * input.width) / 3), 16);
    const mean = await averageOf(context, low);
    const result = context.gpu.image(input.width, input.height, input.kind, input.precision);
    await context.gpu.pass(result, {
        fragment: EVEN_LIGHT.replace(/t_in/g, 'source'),
        inputs: { source: input, low, mean },
        uniforms: { uGray: input.kind === 'gray' ? 1 : 0, uChannels: channels ? 1 : 0, uAmount: amount },
    });
    context.gpu.release(low);
    context.gpu.release(mean);
    return result;
};

/** Band widths Smart auto tile tries, as shares of the picture. */
export const AUTO_BANDS = [0.12, 0.2, 0.3, 0.4] as const;

/** The narrowest band whose joins are about as hidden (within 15%) as the best: wider bands replace more of the photo. */
export const pickBand = (costs: readonly number[]): number => {
    const best = Math.min(...costs);
    const index = costs.findIndex((cost) => cost <= best * 1.15 + 1e-6);
    return Math.max(0, index);
};

const lightingRemovalNeeds = (context: NodeRunContext) => ({ occlusion: context.input('occlusion'), height: context.input('height') });

/** The largest side Grow from example lays its patches out at (the GPU then draws the result at any size). */
const GROW_SIZE = 256;

/**
 * The grown picture at full size: each pixel the example read where its patch moves it, the four nearest
 * map pixels blended (each with its own move), so cuts are soft over one map pixel and never double up.
 */
const GROWN = `uniform sampler2D offsets;
uniform vec2 uMap;
uniform vec2 uExample;
vec4 fromCell(vec2 at, vec2 cell) {
    vec2 wrapped = mod(cell, uMap);
    vec2 move = texelFetch(offsets, ivec2(wrapped), 0).xy;
    return texture(t_in, clamp((at - cell + wrapped + move) / uExample, vec2(0.0), vec2(1.0)));
}
void main() {
    vec2 at = vUv * uMap;
    vec2 p = at - 0.5;
    vec2 base = floor(p);
    vec2 f = p - base;
    vec4 a = fromCell(at, base);
    vec4 b = fromCell(at, base + vec2(1.0, 0.0));
    vec4 c = fromCell(at, base + vec2(0.0, 1.0));
    vec4 d = fromCell(at, base + vec2(1.0, 1.0));
    outColor = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

export const PHOTO_NODES: TexNodeDef[] = [
    {
        type: 'growFromExample',
        label: 'Grow from example',
        category: 'Photo and scans',
        description: 'Grows a larger, tiling picture from a small example: patches of it, each from where it matches what is already laid, joined along their least visible cuts, so it reads as more of the same with no grid of repeats.',
        keywords: ['grow from example', 'texture synthesis', 'example based', 'quilting', 'extend texture', 'more of the same', 'tile from sample'],
        inputs: [anyIn('in', 'Example')],
        outputs: [out('any')],
        params: [
            float('exampleSize', 'Example size', 0.35, 0.1, 1, { hint: 'How much of the result the example spans: smaller makes its features smaller and the result more varied.' }),
            float('patch', 'Patch size', 0.35, 0.1, 0.8, { hint: 'A patch\'s side, as a share of the example: larger keeps more of its structure together.' }),
            float('overlap', 'Overlap', 0.25, 0.1, 0.5, { hint: 'How much of each patch overlaps those before it, for its cut to wander through.' }),
            float('randomness', 'Randomness', 0.3, 0, 1, { hint: '0 always takes the best match; more picks among good ones, for more variety.' }),
            seed(),
        ],
        sizeFrom: 'graph',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const mapWidth = Math.min(GROW_SIZE, result.width);
            const mapHeight = Math.min(GROW_SIZE, result.height);
            const exampleWidth = Math.max(8, Math.round(mapWidth * num(context.params, 'exampleSize', 0.35)));
            const exampleHeight = Math.max(8, Math.round(exampleWidth * (input.height / input.width)));
            const example = await readSmall(context, input, SEARCH_SIZE, { width: exampleWidth, height: exampleHeight });
            if (!example) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const map = growFromExample(example, {
                width: mapWidth, height: mapHeight, patch: num(context.params, 'patch', 0.35) * Math.min(exampleWidth, exampleHeight),
                overlap: num(context.params, 'overlap', 0.25), randomness: num(context.params, 'randomness', 0.3), seed: context.seed,
            });
            const texture = new THREE.DataTexture(map.offset, mapWidth, mapHeight, THREE.RGFormat, THREE.FloatType);
            texture.minFilter = texture.magFilter = THREE.NearestFilter;
            texture.needsUpdate = true;
            try {
                await context.pass(result, GROWN, {
                    inputs: { offsets: texture },
                    uniforms: { uMap: new THREE.Vector2(mapWidth, mapHeight), uExample: new THREE.Vector2(exampleWidth, exampleHeight) },
                    cost: 6,
                });
            } finally {
                texture.dispose();
            }
            return { out: result };
        },
    },
    {
        type: 'makeTile',
        label: 'Make it tile',
        category: 'Photo and scans',
        description: 'Makes a photo or any picture tile. It cuts the edges together along the joins where they match best, so nothing shows twice; or cross-fades a shifted copy in, the old way.',
        keywords: ['seamless', 'tileable', 'make tile', 'photo', 'make it tile', 'seam', 'graph cut', 'patch'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            select('method', 'How', 'seams', [['seams', 'Cut along the best joins'], ['blend', 'Cross-fade']]),
            float('width', 'Band width', 0.2, 0.05, 0.45, { hint: 'How much of the picture each join may wander through: wider finds better joins and replaces more.' }),
            float('feather', 'Soft edge (pixels)', 2, 0, 16, { step: 0.5, showIf: (p) => p.method !== 'blend' }),
            float('softness', 'Softness', 0.6, 0, 1, { showIf: (p) => p.method === 'blend' }),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            if (context.params.method === 'blend') {
                await context.pass(result, CROSS_FADE);
                return { out: result };
            }
            const picture = await readSmall(context, input);
            if (!picture) { await context.pass(result, CROSS_FADE); return { out: result }; }
            await drawSeamCut(context, input, picture, num(context.params, 'width', 0.2), num(context.params, 'feather', 2), result);
            return { out: result };
        },
    },
    {
        type: 'smartAutoTile',
        label: 'Smart auto tile',
        category: 'Photo and scans',
        description: 'Makes a photo tile with no settings to tune: evens out its light first, tries several band widths and keeps the narrowest whose joins hide as well as the best.',
        keywords: ['auto tile', 'smart tile', 'seamless photo', 'make tileable', 'automatic'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            float('evenLight', 'Even out light', 1, 0, 1, { hint: 'How much of the light\'s slow change across the photo is taken out first.' }),
            float('lightSize', 'Light changes over', 0.3, 0.05, 1, { hint: 'How big the patches of uneven light are, as a share of the picture.' }),
            float('feather', 'Soft edge (pixels)', 2, 0, 16, { step: 0.5 }),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const amount = num(context.params, 'evenLight', 1);
            const source = amount > 0 ? await evenLight(context, input, num(context.params, 'lightSize', 0.3), amount, false) : context.gpu.retain(input);
            try {
                // The band chosen on a small copy, the joins then found on a larger one.
                const tiny = await readSmall(context, source, 128);
                const picture = await readSmall(context, source);
                if (!tiny || !picture) { context.gpu.copy(source, result); return { out: result }; }
                const costs = AUTO_BANDS.map((share) => seamMasks(tiny, (share * Math.min(tiny.width, tiny.height)) / 2).cost);
                const band = AUTO_BANDS[pickBand(costs)];
                // Drawn from the evened copy: the kit binds the node's own input, so the compose reads `source` instead.
                const masks = seamMasks(picture, (band * Math.min(picture.width, picture.height)) / 2);
                const feather = num(context.params, 'feather', 2);
                const scale = input.width / picture.width;
                const radius = feather / scale;
                const texture = maskTexture(
                    radius >= 1 ? softenMask(masks.upright, picture.width, picture.height, radius) : masks.upright,
                    radius >= 1 ? softenMask(masks.level, picture.width, picture.height, radius) : masks.level,
                    picture.width, picture.height,
                );
                try {
                    const sharp = radius >= 1 || scale <= 1 ? 0 : Math.min(0.5, (0.5 * Math.max(feather, 1)) / scale);
                    await context.gpu.pass(result, { fragment: SEAM_COMPOSE.replace(/t_in/g, 'source'), inputs: { source, masks: texture }, uniforms: { uSharp: sharp }, cost: 6 });
                } finally {
                    texture.dispose();
                }
            } finally {
                context.gpu.release(source);
            }
            return { out: result };
        },
    },
    {
        type: 'clonePatch',
        label: 'Clone patch',
        category: 'Photo and scans',
        description: 'Copies a patch of the photo from one place onto another, turned and sized as you like, and lets it take on the light where it lands so it blends in.',
        keywords: ['clone patch', 'clone stamp', 'heal', 'patch', 'cover flaw', 'retouch'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            vec2('from', 'From', [0.3, 0.5], 0, 1), vec2('to', 'To', [0.7, 0.5], 0, 1), float('size', 'Size', 0.15, 0.005, 0.5),
            float('rotation', 'Turn (degrees)', 0, -180, 180, { step: 1 }), float('scale', 'Scale', 1, 0.25, 4),
            select('shape', 'Shape', 'circle', [['circle', 'Round'], ['square', 'Square']]), float('softness', 'Soft edge', 0.4, 0, 1),
            float('matchLight', 'Take on the light', 1, 0, 1, { hint: 'Swaps the patch\'s own broad light for the light where it lands, keeping its detail.' }),
            bool('flip', 'Mirror the patch', false),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const low = await gaussianBlur(context, input, Math.max(0.5, (num(context.params, 'size', 0.15) * input.width) / 3), 16);
            try {
                await context.pass(result, `uniform sampler2D low;
void main() {
    vec2 d = vUv - p_to;
    d -= floor(d + 0.5);
    float reach = p_shape == 1 ? max(abs(d.x), abs(d.y)) : length(d);
    float m = 1.0 - smoothstep(p_size * (1.0 - p_softness) - 1e-4, p_size, reach);
    vec2 local = rotate2(-radians(p_rotation)) * d / max(p_scale, 1e-3);
    if (p_flip == 1) local.x = -local.x;
    vec2 from = fract(p_from + local);
    vec4 piece = texture(t_in, from);
    piece.rgb += (texture(low, fract(vUv)).rgb - texture(low, from).rgb) * p_matchLight;
    outColor = mix(texture(t_in, vUv), piece, m);
}`, { inputs: { low }, cost: 3 });
            } finally {
                context.gpu.release(low);
            }
            return { out: result };
        },
    },
    {
        type: 'colourEqualizer',
        label: 'Colour equalizer',
        category: 'Photo and scans',
        description: 'Evens out light across a photo: brighter and darker patches, and a slow change from one side to the other, are brought to the photo\'s overall level, keeping its detail.',
        keywords: ['colour equalizer', 'color equalizer', 'even light', 'flatten lighting', 'remove gradient', 'delight', 'vignette'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [
            float('size', 'Light changes over', 0.3, 0.02, 1, { hint: 'How big the patches of uneven light are, as a share of the picture: smaller evens out finer changes, and starts to flatten detail.' }),
            float('amount', 'Amount', 1, 0, 1),
            select('by', 'Evens out', 'brightness', [['brightness', 'Brightness only'], ['channels', 'Each colour too']]),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0, 0, 0, 0]); return { out: result }; }
            const evened = await evenLight(context, input, num(context.params, 'size', 0.3), num(context.params, 'amount', 1), context.params.by === 'channels');
            context.gpu.copy(evened, result);
            context.gpu.release(evened);
            return { out: result };
        },
    },
    {
        type: 'atlasSplitter',
        label: 'Atlas splitter',
        category: 'Photo and scans',
        description: 'Takes one piece out of an atlas laid out in a grid, counted from the top left, and fills the picture with it, trimmed by a margin if you like.',
        keywords: ['atlas splitter', 'split atlas', 'sprite sheet', 'grid cell', 'extract tile', 'pick from atlas'],
        inputs: [anyIn('in', 'Atlas')],
        outputs: [out('any')],
        params: [
            int('columns', 'Columns', 4, 1, 64), int('rows', 'Rows', 4, 1, 64), int('piece', 'Piece', 1, 1, 4096, { hint: 'Counted along the rows from the top left, starting at 1.' }),
            float('margin', 'Trim each side', 0, 0, 0.45, { hint: 'A share of the piece trimmed off every side (gutters, padding).' }),
            bool('keepShape', 'Keep its shape', false, { hint: 'Fits a piece that is not square into the picture without stretching, leaving clear space round it.' }),
        ],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const result = context.image(context.outputKind('out'));
            const columns = Math.max(1, whole(context.params, 'columns', 4));
            const rows = Math.max(1, whole(context.params, 'rows', 4));
            const index = Math.min(columns * rows, Math.max(1, whole(context.params, 'piece', 1))) - 1;
            const input = context.input('in');
            const cellAspect = input ? (input.width / columns) / (input.height / rows) : 1;
            await context.pass(result, `uniform vec4 uCell;
uniform vec2 uFit;
void main() {
    vec2 local = (vUv - 0.5) / uFit + 0.5;
    if (local.x < 0.0 || local.y < 0.0 || local.x > 1.0 || local.y > 1.0) { outColor = vec4(0.0); return; }
    local = p_margin + local * (1.0 - 2.0 * p_margin);
    outColor = texture(t_in, uCell.xy + local * uCell.zw);
}`, {
                uniforms: {
                    // The piece's box in the atlas (pictures keep their bottom row first: row 0 from the top is the highest).
                    uCell: new THREE.Vector4((index % columns) / columns, (rows - 1 - Math.floor(index / columns)) / rows, 1 / columns, 1 / rows),
                    uFit: context.params.keepShape ? new THREE.Vector2(cellAspect >= 1 ? 1 : cellAspect, cellAspect >= 1 ? 1 / cellAspect : 1) : new THREE.Vector2(1, 1),
                },
            });
            return { out: result };
        },
    },
    {
        type: 'lightingRemoval',
        label: 'Lighting removal',
        category: 'Photo and scans',
        description: 'Takes baked-in lighting out of a scanned colour: divides out its occlusion, and the shading its height explains (the light\'s direction is found from the photo itself), leaving the flat colour.',
        keywords: ['lighting removal', 'delight', 'occlusion cancellation', 'ao cancellation', 'remove shading', 'albedo from photo', 'flatten'],
        inputs: [colorIn('in', 'Colour'), grayIn('occlusion', 'Occlusion', 'white'), grayIn('height', 'Height', 'mid')],
        outputs: [out('color')],
        params: [
            float('occlusionAmount', 'Occlusion taken out', 1, 0, 1),
            float('floor', 'Darkest occlusion trusted', 0.35, 0.05, 1, { hint: 'Occlusion darker than this lifts the colour no further, and towards black it is trusted less and less, so speckled or noisy occlusion cannot blow the colour out.' }),
            float('shadingAmount', 'Shading taken out', 1, 0, 1),
            float('depth', 'Height depth', 0.05, 0.001, 0.5, { hint: 'How deep the height\'s full range is, as a share of the picture: sets how steep its slopes are.' }),
        ],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            const result = context.image('color');
            if (!input) { context.gpu.clear(result, [0, 0, 0, 1]); return { out: result }; }
            const { height, occlusion } = lightingRemovalNeeds(context);
            const gpu = context.gpu;
            // The input's own range, each channel: what comes out stays within it (or a little above).
            const range = await inputRange(context, input);
            // Speckled occlusion lifts specks into white flecks: say so.
            if (occlusion) {
                const speckle = await occlusionSpeckleOf(context, occlusion);
                if (speckle !== null && speckle > SPECKLED) context.note?.('Speckled occlusion: its occlusion is very speckled, so this lifts the colour only where it is sure. Smooth the occlusion first (a blur, or a cleaner bake) for a flatter colour.');
            }
            // Colour with its occlusion divided out (lifting at most to the trusted floor, less as occlusion nears
            // black), the result kept in the input's range, and the slopes of the height (wrapping).
            const SLOPES = `uniform sampler2D lowest;
uniform sampler2D highest;
vec2 slopeAt(vec2 p) {
    vec2 t = 1.0 / vec2(textureSize(t_height, 0));
    float dx = (g_height(p + vec2(t.x, 0.0)) - g_height(p - vec2(t.x, 0.0))) * 0.5 / t.x;
    float dy = (g_height(p + vec2(0.0, t.y)) - g_height(p - vec2(0.0, t.y))) * 0.5 / t.y;
    return vec2(dx, dy) * p_depth;
}
vec3 unoccluded(vec2 p) {
    vec3 c = c_in(p).rgb;
    float ao = w_occlusion == 1 ? mix(1.0, g_occlusion(p), p_occlusionAmount) : 1.0;
    float trust = smoothstep(0.0, p_floor, ao);
    return c * mix(1.0, 1.0 / max(ao, p_floor), trust);
}
vec3 inRange(vec3 c) {
    vec3 low = texelFetch(lowest, ivec2(0), 0).rgb;
    vec3 high = texelFetch(highest, ivec2(0), 0).rgb;
    return clamp(c, low, high + (high - low) * ${RANGE_HEADROOM.toFixed(2)} + ${RANGE_MARGIN.toFixed(2)});
}
vec3 normalAt(vec2 p) { vec2 s = slopeAt(p); return normalize(vec3(-s, 1.0)); }`;
            const bounds = { lowest: range.low, highest: range.high };
            try {
                if (!height || num(context.params, 'shadingAmount', 1) <= 0) {
                    await context.pass(result, `${SLOPES}\nvoid main() { outColor = vec4(inRange(unoccluded(vUv)), c_in(vUv).a); }`, { inputs: bounds, cost: 2 });
                    return { out: result };
                }
                await shadingRemoved(context, input, result, SLOPES, bounds);
            } finally {
                gpu.release(range.low);
                gpu.release(range.high);
            }
            return { out: result };
        },
    },
];

/** How speckled (the average distance from its 3 x 3 neighbourhood's mean) occlusion must be for Lighting removal to say so. */
export const SPECKLED = 0.12;
/** How far above the input's brightest Lighting removal may go: a share of the input's range, and a little more. */
const RANGE_HEADROOM = 0.1;
const RANGE_MARGIN = 0.02;

/** The input's darkest and brightest value in each channel (one pixel each, full float), by halving two by two. */
const inputRange = async (context: NodeRunContext, input: GpuImage): Promise<{ low: GpuImage; high: GpuImage }> => {
    const gpu = context.gpu;
    const reduce = async (pick: 'min' | 'max'): Promise<GpuImage> => {
        let level = context.gpu.image(input.width, input.height, 'color', 32);
        await context.pass(level, 'void main() { outColor = c_in(vUv); }');
        while (level.width > 1 || level.height > 1) {
            const next = gpu.image(Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), 'color', 32);
            await gpu.pass(next, {
                fragment: `void main() { ivec2 size = textureSize(source, 0); ivec2 base = ivec2(gl_FragCoord.xy) * 2; vec4 v = texelFetch(source, min(base, size - 1), 0);
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) v = ${pick}(v, texelFetch(source, min(base + ivec2(x, y), size - 1), 0));
    outColor = v; }`,
                inputs: { source: level },
            });
            gpu.release(level);
            level = next;
        }
        return level;
    };
    return { low: await reduce('min'), high: await reduce('max') };
};

/** How speckled occlusion is: the average distance of each pixel from its 3 x 3 neighbourhood's mean (wrapping). */
const occlusionSpeckleOf = async (context: NodeRunContext, occlusion: GpuImage): Promise<number | null> => {
    const differences = context.gpu.image(occlusion.width, occlusion.height, 'color', 32);
    await context.pass(differences, `void main() {
    vec2 t = 1.0 / vec2(textureSize(t_occlusion, 0));
    float sum = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sum += g_occlusion(vUv + vec2(float(x), float(y)) * t);
    float d = abs(g_occlusion(vUv) - sum / 9.0);
    outColor = vec4(d, d, d, 1.0);
}`, { cost: 9 });
    const mean = await averageOf(context, differences);
    context.gpu.release(differences);
    const value = await context.gpu.readPixelLater(mean, 0, 0);
    context.gpu.release(mean);
    return value ? value[0] : null;
};

/** The CPU twin of the speckle measure, on grey values (bottom row first). */
export const occlusionSpeckle = (values: ArrayLike<number>, width: number, height: number): number => {
    let total = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += values[((y + dy + height) % height) * width + ((x + dx + width) % width)];
            total += Math.abs(values[y * width + x] - sum / 9);
        }
    }
    return total / (width * height);
};

/**
 * The CPU twin of Lighting removal without shading: the colour lifted by its occlusion (at most to the
 * trusted floor, less as occlusion nears black), kept within the input's range in each channel.
 */
export const occlusionLifted = (colour: readonly number[], occlusion: number, params: Readonly<Record<string, unknown>>, range: { low: readonly number[]; high: readonly number[] }): number[] => {
    const floor = num(params, 'floor', 0.35);
    const ao = 1 + (occlusion - 1) * num(params, 'occlusionAmount', 1);
    const t = Math.min(1, Math.max(0, ao / floor));
    const trust = t * t * (3 - 2 * t);
    const gain = 1 + (1 / Math.max(ao, floor) - 1) * trust;
    return colour.map((c, i) => Math.min(range.high[i] + (range.high[i] - range.low[i]) * RANGE_HEADROOM + RANGE_MARGIN, Math.max(range.low[i], c * gain)));
};

/** Lighting removal's shading step: the light's direction fitted from the photo, its shading divided out, kept in range. */
const shadingRemoved = async (context: NodeRunContext, input: GpuImage, result: GpuImage, SLOPES: string, bounds: { lowest: GpuImage; highest: GpuImage }): Promise<void> => {
    const gpu = context.gpu;
    // The light's direction: brightness = mean + a * nx + b * ny fitted over the picture by least squares.
    const first = context.image('color', input.width, input.height, 32);
    const second = context.image('color', input.width, input.height, 32);
    await context.pass(first, `${SLOPES}\nvoid main() { vec3 n = normalAt(vUv); float l = luma(unoccluded(vUv)); outColor = vec4(n.x, n.y, l, n.x * n.x); }`, { inputs: bounds, cost: 6 });
    await context.pass(second, `${SLOPES}\nvoid main() { vec3 n = normalAt(vUv); float l = luma(unoccluded(vUv)); outColor = vec4(n.y * n.y, n.x * n.y, l * n.x, l * n.y); }`, { inputs: bounds, cost: 6 });
    const sumsA = await averageOf(context, first);
    const sumsB = await averageOf(context, second);
    gpu.release(first);
    gpu.release(second);
    const [a, b] = await Promise.all([gpu.readPixelLater(sumsA, 0, 0), gpu.readPixelLater(sumsB, 0, 0)]);
    gpu.release(sumsA);
    gpu.release(sumsB);
    const fit = a && b ? shadingFit({ nx: a[0], ny: a[1], l: a[2], nxx: a[3], nyy: b[0], nxy: b[1], lnx: b[2], lny: b[3] }) : { a: 0, b: 0, mean: 1, nx: 0, ny: 0 };
    await context.pass(result, `${SLOPES}
uniform vec4 uFit;
uniform float uMean;
void main() {
    vec3 n = normalAt(vUv);
    float shade = 1.0 + (uFit.x * (n.x - uFit.z) + uFit.y * (n.y - uFit.w)) / max(uMean, 1e-3);
    vec3 c = unoccluded(vUv) / max(mix(1.0, shade, p_shadingAmount), 0.2);
    outColor = vec4(inRange(c), c_in(vUv).a);
}`, { inputs: bounds, uniforms: { uFit: new THREE.Vector4(fit.a, fit.b, fit.nx, fit.ny), uMean: fit.mean }, cost: 6 });
};

/** Averages over the picture of the normal's slopes and brightness, and their products. */
export interface ShadingSums { nx: number; ny: number; l: number; nxx: number; nyy: number; nxy: number; lnx: number; lny: number }

/**
 * The least-squares fit brightness = mean + a (nx - mean nx) + b (ny - mean ny): how much the light
 * brightens slopes facing each way, from the picture's own averages.
 */
export const shadingFit = (s: ShadingSums): { a: number; b: number; mean: number; nx: number; ny: number } => {
    const vxx = s.nxx - s.nx * s.nx;
    const vyy = s.nyy - s.ny * s.ny;
    const vxy = s.nxy - s.nx * s.ny;
    const cx = s.lnx - s.l * s.nx;
    const cy = s.lny - s.l * s.ny;
    const det = vxx * vyy - vxy * vxy;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { a: 0, b: 0, mean: s.l, nx: s.nx, ny: s.ny };
    return { a: (cx * vyy - cy * vxy) / det, b: (cy * vxx - cx * vxy) / det, mean: s.l, nx: s.nx, ny: s.ny };
};

/** Where Atlas splitter reads the atlas for a place of its picture (no trim, no fitting). */
export const atlasPlace = (u: number, v: number, columns: number, rows: number, piece: number, margin = 0): [number, number] => {
    const index = Math.min(columns * rows, Math.max(1, piece)) - 1;
    const x0 = (index % columns) / columns;
    const y0 = (rows - 1 - Math.floor(index / columns)) / rows;
    return [x0 + (margin + u * (1 - 2 * margin)) / columns, y0 + (margin + v * (1 - 2 * margin)) / rows];
};
