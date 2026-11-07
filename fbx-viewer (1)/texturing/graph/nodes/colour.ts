import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { hash1, saturate, smoothstep } from '../noiseMath';
import { anyIn, bool, color, colorIn, float, int, out, ramp, seed, select } from '../nodeKit';
import type { NodeRunContext, TexNodeDef, TexParamDef } from '../types';

/**
 * ADJUSTMENTS AND COLOUR
 *
 * Histogram select, shift and equalize; a channel mixer; colour match; colour lookup from a strip
 * picture; mapping to a palette; quantizing to a few colours found in the picture; ID colours to a
 * mask; and levels for each channel on its own. Each works pixel by pixel (some from figures read off
 * the whole picture first), so what tiles going in tiles coming out. Their CPU twins are below.
 */

type Params = Readonly<Record<string, unknown>>;
type Rgba = [number, number, number, number];
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const luma = (c: readonly number[]): number => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

// ---- figures read off the whole picture ----

/** The input drawn small (8-bit colour, grey spread to colour) and read back, for figures about it. */
const readSmall = async (context: NodeRunContext, source: GpuImage, size = 64): Promise<Uint8Array | null> => {
    const small = context.image('color', size, size, 8);
    await context.gpu.pass(small, {
        fragment: source.kind === 'gray' ? 'void main() { float v = texture(source, vUv).r; outColor = vec4(v, v, v, 1.0); }' : 'void main() { outColor = vec4(texture(source, vUv).rgb, 1.0); }',
        inputs: { source },
    });
    return context.gpu.readRgba8Later(small);
};

/**
 * For each channel (red, green, blue, then brightness), the share of pixels at or below each of 256
 * steps, stretched so the darkest present step is 0: mapping through it spreads the values evenly.
 */
export const equalizeTables = (pixels: ArrayLike<number>): Float32Array[] => {
    const counts = [0, 1, 2, 3].map(() => new Float64Array(256));
    const total = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
        counts[0][pixels[i]]++;
        counts[1][pixels[i + 1]]++;
        counts[2][pixels[i + 2]]++;
        counts[3][Math.min(255, Math.round(luma([pixels[i], pixels[i + 1], pixels[i + 2]])))]++;
    }
    return counts.map((count) => {
        const table = new Float32Array(256);
        let running = 0;
        let lowest = -1;
        for (let step = 0; step < 256; step++) {
            running += count[step];
            if (lowest < 0 && count[step] > 0) lowest = running;
            table[step] = running;
        }
        const span = Math.max(1, total - lowest);
        for (let step = 0; step < 256; step++) table[step] = Math.max(0, (table[step] - lowest) / span);
        return table;
    });
};

/** Each channel's mean and spread (standard deviation), 0 to 1. */
export const colourFigures = (pixels: ArrayLike<number>): { mean: [number, number, number]; spread: [number, number, number] } => {
    const sum = [0, 0, 0];
    const squares = [0, 0, 0];
    const count = Math.max(1, pixels.length / 4);
    for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const value = pixels[i + c] / 255;
            sum[c] += value;
            squares[c] += value * value;
        }
    }
    const mean = sum.map((value) => value / count) as [number, number, number];
    const spread = squares.map((value, c) => Math.sqrt(Math.max(0, value / count - mean[c] * mean[c]))) as [number, number, number];
    return { mean, spread };
};

/** How far apart two colours look (green counts most, blue least). */
const colourDistance = (a: readonly number[], b: readonly number[]): number =>
    0.3 * (a[0] - b[0]) ** 2 + 0.59 * (a[1] - b[1]) ** 2 + 0.11 * (a[2] - b[2]) ** 2;

/** The palette colour nearest a colour. */
export const nearestColour = (colour: readonly number[], palette: ReadonlyArray<readonly number[]>): readonly number[] => {
    let best = palette[0] ?? colour;
    let distance = Infinity;
    for (const candidate of palette) {
        const d = colourDistance(colour, candidate);
        if (d < distance) { distance = d; best = candidate; }
    }
    return best;
};

/**
 * `count` colours that stand for a picture's (k-means: start from colours spread through the picture,
 * then move each to the middle of the colours nearest it, a dozen times), the same for a seed.
 */
export const quantizePalette = (pixels: ArrayLike<number>, count: number, seedValue: number): number[][] => {
    const colours: number[][] = [];
    for (let i = 0; i < pixels.length; i += 4) colours.push([pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255]);
    if (!colours.length) return [[0, 0, 0]];
    const k = Math.max(1, Math.min(16, Math.round(count), colours.length));
    // Spread the starting colours: each next one far from those chosen (the first by the seed).
    const centres: number[][] = [colours[Math.floor(hash1(0, 0, seedValue) * colours.length) % colours.length].slice()];
    while (centres.length < k) {
        let far = colours[0];
        let farthest = -1;
        for (const colour of colours) {
            const d = Math.min(...centres.map((centre) => colourDistance(colour, centre)));
            if (d > farthest) { farthest = d; far = colour; }
        }
        centres.push(far.slice());
    }
    for (let round = 0; round < 12; round++) {
        const sums = centres.map(() => [0, 0, 0, 0]);
        for (const colour of colours) {
            let best = 0;
            let distance = Infinity;
            centres.forEach((centre, index) => { const d = colourDistance(colour, centre); if (d < distance) { distance = d; best = index; } });
            sums[best][0] += colour[0];
            sums[best][1] += colour[1];
            sums[best][2] += colour[2];
            sums[best][3]++;
        }
        sums.forEach((sum, index) => { if (sum[3]) centres[index] = [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]]; });
    }
    return centres;
};

// ---- shared shader parts ----

const NEAREST_GLSL = `const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float colourDistance(vec3 a, vec3 b) { vec3 d = a - b; return dot(d * d, vec3(0.3, 0.59, 0.11)); }
vec3 paletteColour(vec3 c, float dither) {
    vec3 first = PALETTE[0].rgb;
    vec3 second = first;
    float d1 = 1e9;
    float d2 = 1e9;
    for (int i = 0; i < 16; i++) {
        if (i >= PALETTE_COUNT) break;
        float d = colourDistance(c, PALETTE[i].rgb);
        if (d < d1) { d2 = d1; second = first; d1 = d; first = PALETTE[i].rgb; }
        else if (d < d2) { d2 = d; second = PALETTE[i].rgb; }
    }
    if (dither > 0.0 && d2 < 1e8) {
        ivec2 p = ivec2(gl_FragCoord.xy) % 4;
        float threshold = (BAYER[p.y * 4 + p.x] + 0.5) / 16.0;
        float closeness = sqrt(d1) / max(sqrt(d1) + sqrt(d2), 1e-5);
        if (closeness * 2.0 * dither > threshold) return second;
    }
    return first;
}`;

const level = (prefix: string, label: string): TexParamDef[] => [
    float(`${prefix}InLow`, 'Input black', 0, 0, 1, { group: label }), float(`${prefix}InHigh`, 'Input white', 1, 0, 1, { group: label }),
    float(`${prefix}Mid`, 'Midtones', 0.5, 0.01, 0.99, { group: label }), float(`${prefix}OutLow`, 'Output black', 0, 0, 1, { group: label }),
    float(`${prefix}OutHigh`, 'Output white', 1, 0, 1, { group: label }),
];
const levelOf = (x: number, params: Params, prefix: string): number => {
    const low = num(params, `${prefix}InLow`, 0);
    const high = num(params, `${prefix}InHigh`, 1);
    const t = Math.pow(saturate((x - low) / Math.max(high - low, 1e-5)), Math.log(0.5) / Math.log(num(params, `${prefix}Mid`, 0.5)));
    return num(params, `${prefix}OutLow`, 0) + (num(params, `${prefix}OutHigh`, 1) - num(params, `${prefix}OutLow`, 0)) * t;
};

const mixer = (key: string, label: string, fallback: number, group: string) => float(key, label, fallback, -2, 2, { group, softMax: 2 });
const MIXER_ROWS: Array<[string, string]> = [['r', 'Red out'], ['g', 'Green out'], ['b', 'Blue out']];

const DEFAULT_PALETTE = [
    { position: 0, color: [0.11, 0.1, 0.13, 1] as [number, number, number, number] }, { position: 0.25, color: [0.36, 0.25, 0.2, 1] as [number, number, number, number] },
    { position: 0.5, color: [0.62, 0.48, 0.32, 1] as [number, number, number, number] }, { position: 0.75, color: [0.45, 0.55, 0.42, 1] as [number, number, number, number] },
    { position: 1, color: [0.88, 0.85, 0.76, 1] as [number, number, number, number] },
];

/** A passed-through result for a node with nothing wired in. */
const blank = (context: NodeRunContext) => {
    const image = context.image(context.outputKind('out'));
    context.gpu.clear(image, [0, 0, 0, 1]);
    return { out: image };
};

export const COLOUR_NODES: TexNodeDef[] = [
    {
        type: 'histogramSelect',
        label: 'Histogram select',
        category: 'Adjustments',
        description: 'A mask of the pixels whose brightness lies near a value: pick out the darks, the mids or the lights.',
        keywords: ['histogram select', 'value range', 'band', 'luminance key', 'select brightness'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('gray')],
        params: [float('position', 'Brightness', 0.5, 0, 1), float('range', 'Range', 0.2, 0, 1), float('softness', 'Softness', 0.1, 0, 1)],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const image = context.image('gray');
            await context.pass(image, 'void main() { float d = abs(g_in(vUv) - p_position); float h = p_range * 0.5; outColor = vec4(1.0 - smoothstep(h, h + p_softness + 1e-4, d)); }');
            return { out: image };
        },
    },
    {
        type: 'histogramShift',
        label: 'Histogram shift',
        category: 'Adjustments',
        description: 'Moves every value up by an amount, those going past white coming round from black: shifts bands of a height or a gradient along.',
        keywords: ['histogram shift', 'offset values', 'wrap', 'cycle', 'rotate values'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('shift', 'Shift', 0.25, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        settingsInShader: true,
        async run(context) {
            const image = context.image(context.outputKind('out'));
            await context.pass(image, 'void main() { vec4 v = c_in(vUv); vec3 x = v.rgb + p_shift; outColor = vec4(x - step(1.0 + 1e-6, x), v.a); }');
            return { out: image };
        },
    },
    {
        type: 'histogramEqualize',
        label: 'Histogram equalize',
        category: 'Adjustments',
        description: 'Spreads the values evenly from black to white, so every brightness is used about as much: brings out detail in flat pictures.',
        keywords: ['histogram equalize', 'equalise', 'normalize', 'contrast', 'spread values'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('mode', 'Spreads', 'brightness', [['brightness', 'Brightness (keeps colours)'], ['channels', 'Each channel']]), float('amount', 'Amount', 1, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            if (!input) return blank(context);
            const pixels = await readSmall(context, input, 128);
            const image = context.image(context.outputKind('out'));
            if (!pixels) { await context.gpu.pass(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: input } }); return { out: image }; }
            const tables = equalizeTables(pixels);
            const table = new Float32Array(256 * 4);
            for (let step = 0; step < 256; step++) for (let c = 0; c < 4; c++) table[step * 4 + c] = tables[c][step];
            const texture = new THREE.DataTexture(table, 256, 1, THREE.RGBAFormat, THREE.FloatType);
            texture.minFilter = texture.magFilter = THREE.LinearFilter;
            texture.needsUpdate = true;
            try {
                await context.pass(image, `uniform sampler2D tables;
vec4 tableAt(float x) { return texture(tables, vec2(saturate(x) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)); }
void main() {
    vec4 v = c_in(vUv);
    vec3 spread;
    if (p_mode == 1) spread = vec3(tableAt(v.r).r, tableAt(v.g).g, tableAt(v.b).b);
    else { float y = luma(v.rgb); float to = tableAt(y).a; spread = y > 1e-4 ? saturate(v.rgb * (to / y)) : vec3(to); }
    outColor = vec4(mix(v.rgb, spread, p_amount), v.a);
}`, { inputs: { tables: texture } });
            } finally {
                texture.dispose();
            }
            return { out: image };
        },
    },
    {
        type: 'channelMixer',
        label: 'Channel mixer',
        category: 'Adjustments',
        description: 'Makes each output channel from a mix of the input\'s red, green and blue, plus a constant: swap, blend or tint channels, or make a custom grey.',
        keywords: ['channel mixer', 'mix channels', 'swap channels', 'colour matrix', 'monochrome'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [
            ...MIXER_ROWS.flatMap(([row, group]) => [
                mixer(`${row}r`, 'From red', row === 'r' ? 1 : 0, group), mixer(`${row}g`, 'From green', row === 'g' ? 1 : 0, group),
                mixer(`${row}b`, 'From blue', row === 'b' ? 1 : 0, group), mixer(`${row}c`, 'Plus', 0, group),
            ]),
            bool('monochrome', 'Grey (every channel the red out)', false), bool('clamp', 'Keep within 0 to 1', true),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const image = context.image('color');
            await context.pass(image, `void main() {
    vec4 v = c_in(vUv);
    vec3 r = vec3(dot(v.rgb, vec3(p_rr, p_rg, p_rb)) + p_rc, dot(v.rgb, vec3(p_gr, p_gg, p_gb)) + p_gc, dot(v.rgb, vec3(p_br, p_bg, p_bb)) + p_bc);
    if (p_monochrome == 1) r = vec3(r.r);
    outColor = vec4(p_clamp == 1 ? clamp(r, 0.0, 1.0) : r, v.a);
}`);
            return { out: image };
        },
    },
    {
        type: 'colourMatch',
        label: 'Colour match',
        category: 'Adjustments',
        description: 'Shifts a picture\'s colours to match another\'s (wired into Reference): their average colour and how far they spread. With nothing wired there, matches the colour you set.',
        keywords: ['colour match', 'color match', 'match colours', 'colour transfer', 'grade', 'tone match'],
        inputs: [colorIn('in', 'Input'), colorIn('reference', 'Reference')],
        outputs: [out('color')],
        params: [color('target', 'Colour to match (no reference)', [0.55, 0.42, 0.3, 1]), bool('spread', 'Match the spread too', true), float('amount', 'Amount', 1, 0, 1)],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            if (!input) return blank(context);
            const reference = context.input('reference');
            const source = await readSmall(context, input);
            const target = reference ? await readSmall(context, reference) : null;
            const from = source ? colourFigures(source) : { mean: [0.5, 0.5, 0.5] as [number, number, number], spread: [0.2, 0.2, 0.2] as [number, number, number] };
            const goal = target ? colourFigures(target) : { mean: (context.params.target as number[]).slice(0, 3) as [number, number, number], spread: from.spread };
            const image = context.image('color');
            await context.pass(image, `uniform vec3 uFromMean;
uniform vec3 uFromSpread;
uniform vec3 uToMean;
uniform vec3 uToSpread;
void main() {
    vec4 v = c_in(vUv);
    vec3 matched = p_spread == 1 ? (v.rgb - uFromMean) / max(uFromSpread, vec3(1e-3)) * uToSpread + uToMean : v.rgb - uFromMean + uToMean;
    outColor = vec4(mix(v.rgb, saturate(matched), p_amount), v.a);
}`, { uniforms: { uFromMean: new THREE.Vector3(...from.mean), uFromSpread: new THREE.Vector3(...from.spread), uToMean: new THREE.Vector3(...goal.mean), uToSpread: new THREE.Vector3(...goal.spread) } });
            return { out: image };
        },
    },
    {
        type: 'colourLookup',
        label: 'Colour lookup',
        category: 'Adjustments',
        description: 'Recolours through a lookup strip picture (wired into Strip): a row of squares, each a slice of blue, red across and green down, as colour grading tools make them.',
        keywords: ['colour lookup', 'lut', 'look up table', 'grade', 'colour grading', 'strip'],
        inputs: [colorIn('in', 'Input'), colorIn('lut', 'Strip')],
        outputs: [out('color')],
        params: [float('amount', 'Amount', 1, 0, 1), bool('greenUp', 'Green runs up', false)],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const image = context.image('color');
            await context.pass(image, `void main() {
    vec4 v = c_in(vUv);
    if (w_lut == 0) { outColor = v; return; }
    float n = float(textureSize(t_lut, 0).y);
    vec3 c = clamp(v.rgb, 0.0, 1.0) * (n - 1.0);
    float blue = floor(c.b);
    float nextBlue = min(blue + 1.0, n - 1.0);
    float green = p_greenUp == 1 ? n - 1.0 - c.g : c.g;
    vec2 at0 = vec2((blue * n + c.r + 0.5) / (n * n), (green + 0.5) / n);
    vec2 at1 = vec2((nextBlue * n + c.r + 0.5) / (n * n), (green + 0.5) / n);
    vec3 looked = mix(texture(t_lut, at0).rgb, texture(t_lut, at1).rgb, c.b - blue);
    outColor = vec4(mix(v.rgb, looked, p_amount), v.a);
}`);
            return { out: image };
        },
    },
    {
        type: 'palette',
        label: 'Palette',
        category: 'Adjustments',
        description: 'Recolours each pixel with the nearest of a set of colours (the gradient\'s stops, wherever they sit), with dithering between the two nearest if you like.',
        keywords: ['palette', 'limited colours', 'indexed', 'retro', 'nearest colour', 'dither'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [ramp('colours', 'Colours', DEFAULT_PALETTE), float('dither', 'Dithering', 0, 0, 1), float('amount', 'Amount', 1, 0, 1)],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const image = context.image('color');
            await context.pass(image, `#define PALETTE p_colours_colors
#define PALETTE_COUNT p_colours_count
${NEAREST_GLSL}
void main() { vec4 v = c_in(vUv); outColor = vec4(mix(v.rgb, paletteColour(v.rgb, p_dither), p_amount), v.a); }`);
            return { out: image };
        },
    },
    {
        type: 'quantize',
        label: 'Quantize colours',
        category: 'Adjustments',
        description: 'Reduces a picture to a few colours it is mostly made of, found from the picture itself, with dithering if you like.',
        keywords: ['quantize', 'quantise', 'reduce colours', 'k-means', 'posterize colour', 'colour count'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [int('count', 'Colours', 6, 2, 16), float('dither', 'Dithering', 0, 0, 1), seed()],
        sizeFrom: 'input',
        async run(context) {
            const input = context.input('in');
            if (!input) return blank(context);
            const pixels = await readSmall(context, input);
            const palette = pixels ? quantizePalette(pixels, num(context.params, 'count', 6), context.seed) : [[0, 0, 0]];
            const image = context.image('color');
            const uniforms = { uPalette: Array.from({ length: 16 }, (_, i) => new THREE.Vector4(...(palette[Math.min(i, palette.length - 1)]), 1)), uCount: palette.length };
            await context.pass(image, `uniform vec4 uPalette[16];
uniform int uCount;
#define PALETTE uPalette
#define PALETTE_COUNT uCount
${NEAREST_GLSL}
void main() { vec4 v = c_in(vUv); outColor = vec4(paletteColour(v.rgb, p_dither), v.a); }`, { uniforms });
            return { out: image };
        },
    },
    {
        type: 'idToMask',
        label: 'ID to mask',
        category: 'Adjustments',
        description: 'A mask from an ID colour map: white where it holds the colours you pick (up to four), or where IDs are kept at random by a share and a seed.',
        keywords: ['id to mask', 'id mask', 'colour id', 'material id', 'select id', 'random id'],
        inputs: [colorIn('in', 'ID colours')],
        outputs: [out('gray')],
        params: [
            select('mode', 'Keeps', 'picked', [['picked', 'The colours picked'], ['random', 'IDs at random']]),
            int('count', 'Colours picked', 1, 1, 4, { showIf: (params) => params.mode !== 'random' }),
            color('colour1', 'Colour 1', [1, 0, 0, 1], { showIf: (params) => params.mode !== 'random' }),
            color('colour2', 'Colour 2', [0, 1, 0, 1], { showIf: (params) => params.mode !== 'random' && Number(params.count) >= 2 }),
            color('colour3', 'Colour 3', [0, 0, 1, 1], { showIf: (params) => params.mode !== 'random' && Number(params.count) >= 3 }),
            color('colour4', 'Colour 4', [1, 1, 0, 1], { showIf: (params) => params.mode !== 'random' && Number(params.count) >= 4 }),
            float('tolerance', 'Tolerance', 0.04, 0, 0.5, { showIf: (params) => params.mode !== 'random' }),
            float('fraction', 'Share kept', 0.5, 0, 1, { showIf: (params) => params.mode === 'random' }),
            seed(),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const image = context.image('gray');
            await context.pass(image, `float picked(vec3 c, vec4 colour) { return 1.0 - smoothstep(p_tolerance, p_tolerance + 0.02, distance(c, colour.rgb)); }
void main() {
    vec3 c = c_in(vUv).rgb;
    float v = 0.0;
    if (p_mode == 1) {
        // Each ID colour kept or not by its own random number; black (no ID) never.
        ivec3 q = ivec3(floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5));
        v = (q.x + q.y + q.z) == 0 ? 0.0 : step(hash1(ivec2(q.x * 256 + q.y, q.z), uSeed), p_fraction);
    } else {
        v = picked(c, p_colour1);
        if (p_count >= 2) v = max(v, picked(c, p_colour2));
        if (p_count >= 3) v = max(v, picked(c, p_colour3));
        if (p_count >= 4) v = max(v, picked(c, p_colour4));
    }
    outColor = vec4(v);
}`);
            return { out: image };
        },
    },
    {
        type: 'levelsPerChannel',
        label: 'Levels per channel',
        category: 'Adjustments',
        description: 'Levels for red, green, blue and alpha each on their own: input range, midtones and output range per channel.',
        keywords: ['levels', 'per channel', 'rgb levels', 'channel levels', 'colour balance'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [...level('r', 'Red'), ...level('g', 'Green'), ...level('b', 'Blue'), ...level('a', 'Alpha')],
        sizeFrom: 'input',
        kindFrom: 'in',
        settingsInShader: true,
        async run(context) {
            const image = context.image(context.outputKind('out'));
            await context.pass(image, `float level(float x, float inLow, float inHigh, float mid, float outLow, float outHigh) {
    float t = pow(saturate((x - inLow) / max(inHigh - inLow, 1e-5)), log(0.5) / log(mid));
    return mix(outLow, outHigh, t);
}
void main() {
    vec4 v = c_in(vUv);
    outColor = vec4(level(v.r, p_rInLow, p_rInHigh, p_rMid, p_rOutLow, p_rOutHigh), level(v.g, p_gInLow, p_gInHigh, p_gMid, p_gOutLow, p_gOutHigh),
        level(v.b, p_bInLow, p_bInHigh, p_bMid, p_bOutLow, p_bOutHigh), level(v.a, p_aInLow, p_aInHigh, p_aMid, p_aOutLow, p_aOutHigh));
}`);
            return { out: image };
        },
    },
];

/** What a lookup strip gives for a colour (`read` gives the strip's colour at a pixel place, rows from the top). */
export const lookupStrip = (colour: readonly number[], n: number, read: (x: number, y: number) => readonly number[], greenUp = false): number[] => {
    const c = colour.slice(0, 3).map((value) => saturate(value) * (n - 1));
    const blue = Math.floor(c[2]);
    const nextBlue = Math.min(blue + 1, n - 1);
    const green = greenUp ? n - 1 - c[1] : c[1];
    // Bilinear within a square, as the GPU reads it.
    const at = (slice: number) => {
        const x = slice * n + c[0];
        const x0 = Math.floor(x);
        const y0 = Math.floor(green);
        const fx = x - x0;
        const fy = green - y0;
        const x1 = Math.min(x0 + 1, slice * n + n - 1);
        const y1 = Math.min(y0 + 1, n - 1);
        return [0, 1, 2].map((k) => (read(x0, y0)[k] * (1 - fx) + read(x1, y0)[k] * fx) * (1 - fy) + (read(x0, y1)[k] * (1 - fx) + read(x1, y1)[k] * fx) * fy);
    };
    const a = at(blue);
    const b = at(nextBlue);
    const t = c[2] - blue;
    return a.map((value, k) => value + (b[k] - value) * t);
};

/** The CPU twins of the pixel maths (figures about the whole picture given, where a node reads them). */
export const COLOUR_REFERENCES = {
    histogramSelect: (c: readonly number[], params: Params): number => {
        const half = num(params, 'range', 0.2) * 0.5;
        return 1 - smoothstep(half, half + num(params, 'softness', 0.1) + 1e-4, Math.abs(luma(c) - num(params, 'position', 0.5)));
    },
    histogramShift: (c: readonly number[], params: Params): Rgba => {
        const shifted = c.slice(0, 3).map((value) => { const x = value + num(params, 'shift', 0.25); return x >= 1 + 1e-6 ? x - 1 : x; });
        return [shifted[0], shifted[1], shifted[2], c[3] ?? 1];
    },
    channelMixer: (c: readonly number[], params: Params): Rgba => {
        const row = (r: string) => c[0] * num(params, `${r}r`, r === 'r' ? 1 : 0) + c[1] * num(params, `${r}g`, r === 'g' ? 1 : 0) + c[2] * num(params, `${r}b`, r === 'b' ? 1 : 0) + num(params, `${r}c`, 0);
        let out = [row('r'), row('g'), row('b')];
        if (params.monochrome) out = [out[0], out[0], out[0]];
        if (params.clamp !== false) out = out.map(saturate);
        return [out[0], out[1], out[2], c[3] ?? 1];
    },
    levelsPerChannel: (c: readonly number[], params: Params): Rgba => [levelOf(c[0], params, 'r'), levelOf(c[1], params, 'g'), levelOf(c[2], params, 'b'), levelOf(c[3] ?? 1, params, 'a')],
    idToMask: (c: readonly number[], params: Params, seedValue: number): number => {
        if (params.mode === 'random') {
            const q = c.slice(0, 3).map((value) => Math.floor(saturate(value) * 255 + 0.5));
            return q[0] + q[1] + q[2] === 0 ? 0 : (num(params, 'fraction', 0.5) >= hash1(q[0] * 256 + q[1], q[2], seedValue) ? 1 : 0);
        }
        const tolerance = num(params, 'tolerance', 0.04);
        let value = 0;
        for (let k = 1; k <= Math.round(num(params, 'count', 1)); k++) {
            const colour = params[`colour${k}`] as number[];
            const d = Math.hypot(c[0] - colour[0], c[1] - colour[1], c[2] - colour[2]);
            value = Math.max(value, 1 - smoothstep(tolerance, tolerance + 0.02, d));
        }
        return value;
    },
    equalize: (c: readonly number[], tables: Float32Array[], mode: 'brightness' | 'channels'): number[] => {
        const at = (table: Float32Array, x: number) => {
            const position = saturate(x) * 255;
            const low = Math.floor(position);
            const high = Math.min(255, low + 1);
            return table[low] + (table[high] - table[low]) * (position - low);
        };
        if (mode === 'channels') return [at(tables[0], c[0]), at(tables[1], c[1]), at(tables[2], c[2])];
        const y = luma(c);
        const to = at(tables[3], y);
        return y > 1e-4 ? c.slice(0, 3).map((value) => saturate(value * to / y)) : [to, to, to];
    },
    colourMatch: (c: readonly number[], from: ReturnType<typeof colourFigures>, to: ReturnType<typeof colourFigures>, spread = true): number[] =>
        c.slice(0, 3).map((value, k) => saturate(spread ? (value - from.mean[k]) / Math.max(from.spread[k], 1e-3) * to.spread[k] + to.mean[k] : value - from.mean[k] + to.mean[k])),
    palette: (c: readonly number[], palette: ReadonlyArray<readonly number[]>): readonly number[] => nearestColour(c, palette),
};
