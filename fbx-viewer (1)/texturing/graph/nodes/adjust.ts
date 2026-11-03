import { BLEND_MODES, BLEND_MODE_LABELS } from '../../gpu/glslLibrary';
import { anyIn, bool, color, colorIn, curve, float, grayIn, int, onePass, out, ramp, select } from '../nodeKit';
import type { TexNodeDef } from '../types';

/** Changing values and colours, and putting images together. */

const BLEND_OPTIONS = BLEND_MODES.map((mode) => [mode, BLEND_MODE_LABELS[mode]] as [string, string]);

/** A colour from an input as the kind it is: a grey image keeps one value in every channel. */
const SAMPLE_IN = 'vec4 v = c_in(vUv);';

export const ADJUST_NODES: TexNodeDef[] = [
    onePass({
        type: 'levels',
        label: 'Levels',
        category: 'Adjustments',
        description: 'Sets the input range that becomes black and white, the midtones, and the output range.',
        keywords: ['range', 'contrast', 'gamma', 'remap'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('inLow', 'Input black', 0, 0, 1), float('inHigh', 'Input white', 1, 0, 1), float('mid', 'Midtones', 0.5, 0.01, 0.99), float('outLow', 'Output black', 0, 0, 1), float('outHigh', 'Output white', 1, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    ${SAMPLE_IN}
    vec3 t = saturate((v.rgb - p_inLow) / max(p_inHigh - p_inLow, 1e-5));
    float gamma = log(0.5) / log(p_mid);
    t = pow(t, vec3(gamma));
    outColor = vec4(mix(vec3(p_outLow), vec3(p_outHigh), t), v.a);
}`,
    }),
    onePass({
        type: 'curves',
        label: 'Curves',
        category: 'Adjustments',
        description: 'Remaps values through a curve you draw, for all channels together and each on its own.',
        keywords: ['curve', 'tone', 'remap'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [curve('curve', 'Curve')],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    ${SAMPLE_IN}
    outColor = vec4(curveValue(p_curve, v.r, 0), curveValue(p_curve, v.g, 1), curveValue(p_curve, v.b, 2), curveValue(p_curve, v.a, 3));
}`,
    }),
    {
        type: 'autoLevels',
        label: 'Auto levels',
        category: 'Adjustments',
        description: 'Stretches the image so its darkest value becomes black and its brightest white.',
        keywords: ['normalize', 'stretch', 'range', 'equalize'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) {
                context.gpu.clear(result, [0, 0, 0, 1]);
                return { out: result };
            }
            // Halve the image until it is one pixel, keeping each block's lowest and highest value.
            let level = context.image('color', Math.max(1, input.width >> 1), Math.max(1, input.height >> 1), 32);
            await context.gpu.pass(level, {
                fragment: `void main() { vec2 texel = 1.0 / vec2(textureSize(source, 0)); float lo = 1e9; float hi = -1e9;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) { vec4 v = texture(source, vUv + (vec2(x, y) - 0.5) * texel); float g = ${input.kind === 'gray' ? 'v.r' : 'luma(v.rgb)'}; lo = min(lo, g); hi = max(hi, g); }
    outColor = vec4(lo, hi, 0.0, 1.0); }`,
                inputs: { source: input },
                cost: 4,
            });
            while (level.width > 1 || level.height > 1) {
                const next = context.image('color', Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), 32);
                await context.gpu.pass(next, {
                    fragment: `void main() { ivec2 size = textureSize(source, 0); ivec2 base = ivec2(gl_FragCoord.xy) * 2; float lo = 1e9; float hi = -1e9;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) { ivec2 p = min(base + ivec2(x, y), size - 1); vec4 v = texelFetch(source, p, 0); lo = min(lo, v.r); hi = max(hi, v.g); }
    outColor = vec4(lo, hi, 0.0, 1.0); }`,
                    inputs: { source: level },
                    cost: 4,
                });
                context.gpu.release(level);
                level = next;
            }
            await context.pass(result, `uniform sampler2D range;
void main() { vec2 r = texelFetch(range, ivec2(0), 0).rg; vec4 v = c_in(vUv); outColor = vec4(saturate((v.rgb - r.x) / max(r.y - r.x, 1e-5)), v.a); }`, { inputs: { range: level } });
            context.gpu.release(level);
            return { out: result };
        },
    },
    onePass({
        type: 'brightnessContrast',
        label: 'Brightness and contrast',
        category: 'Adjustments',
        description: 'Brightens or darkens, and pushes values towards or away from the middle.',
        keywords: ['brightness', 'contrast'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('brightness', 'Brightness', 0, -1, 1), float('contrast', 'Contrast', 0, -1, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    ${SAMPLE_IN}
    float k = p_contrast >= 0.0 ? 1.0 / max(1.0 - p_contrast, 1e-3) : 1.0 + p_contrast;
    outColor = vec4(saturate((v.rgb - 0.5) * k + 0.5 + p_brightness), v.a);
}`,
    }),
    onePass({
        type: 'invert',
        label: 'Invert',
        category: 'Adjustments',
        description: 'Black becomes white and white black.',
        keywords: ['negative', 'flip', 'one minus'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [bool('alpha', 'Invert alpha too', false)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() { ${SAMPLE_IN} outColor = vec4(1.0 - v.rgb, p_alpha == 1 ? 1.0 - v.a : v.a); }`,
    }),
    onePass({
        type: 'threshold',
        label: 'Threshold',
        category: 'Adjustments',
        description: 'Everything above a value turns white and everything below black, with a soft edge if you like.',
        keywords: ['binary', 'cutoff', 'mask', 'step'],
        inputs: [grayIn('in', 'Input')],
        outputs: [out('gray')],
        params: [float('value', 'Threshold', 0.5, 0, 1), float('softness', 'Softness', 0, 0, 1)],
        sizeFrom: 'input',
        glsl: `void main() { float g = g_in(vUv); float s = max(p_softness * 0.5, 1e-4); outColor = vec4(smoothstep(p_value - s, p_value + s, g)); }`,
    }),
    onePass({
        type: 'histogramScan',
        label: 'Histogram scan',
        category: 'Adjustments',
        description: 'Picks a band of values to turn into a mask: slide the position to grow or shrink it, and set how hard its edge is.',
        keywords: ['histogram', 'scan', 'mask', 'select range'],
        inputs: [grayIn('in', 'Input')],
        outputs: [out('gray')],
        params: [float('position', 'Position', 0.5, 0, 1), float('contrast', 'Contrast', 0.5, 0, 1), bool('invert', 'Invert position', false)],
        sizeFrom: 'input',
        glsl: `void main() {
    float g = g_in(vUv);
    float width = (1.0 - p_contrast) * 0.5 + 1e-4;
    float position = p_invert == 1 ? 1.0 - p_position : p_position;
    float centre = mix(1.0 + width, -width, position);
    float v = saturate((g - centre) / (2.0 * width) + 0.5);
    outColor = vec4(p_invert == 1 ? 1.0 - v : v);
}`,
    }),
    onePass({
        type: 'histogramRange',
        label: 'Histogram range',
        category: 'Adjustments',
        description: 'Squeezes all values into a narrower band around a chosen point.',
        keywords: ['compress', 'range'],
        inputs: [grayIn('in', 'Input')],
        outputs: [out('gray')],
        params: [float('range', 'Range', 0.5, 0, 1), float('position', 'Position', 0.5, 0, 1)],
        sizeFrom: 'input',
        glsl: `void main() { float g = g_in(vUv); outColor = vec4(saturate(mix(p_position, g, p_range))); }`,
    }),
    onePass({
        type: 'posterize',
        label: 'Posterize',
        category: 'Adjustments',
        description: 'Rounds values to a few steps.',
        keywords: ['quantize', 'steps', 'bands'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [int('steps', 'Steps', 4, 2, 64)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() { ${SAMPLE_IN} float n = float(p_steps - 1); outColor = vec4(floor(v.rgb * n + 0.5) / n, v.a); }`,
    }),
    onePass({
        type: 'clamp',
        label: 'Clamp',
        category: 'Adjustments',
        description: 'Keeps values between a lowest and a highest.',
        keywords: ['limit', 'min max'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('low', 'Lowest', 0, 0, 1), float('high', 'Highest', 1, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() { ${SAMPLE_IN} outColor = vec4(clamp(v.rgb, p_low, p_high), v.a); }`,
    }),
    onePass({
        type: 'gradientMap',
        label: 'Gradient map',
        category: 'Adjustments',
        description: 'Colours a grey image: each value takes the colour at that point of a gradient.',
        keywords: ['colorize', 'ramp', 'lookup', 'tint', 'gradient'],
        inputs: [grayIn('in', 'Input')],
        outputs: [out('color')],
        params: [ramp('ramp', 'Gradient', [{ position: 0, color: [0.09, 0.07, 0.06, 1] }, { position: 0.5, color: [0.45, 0.32, 0.22, 1] }, { position: 1, color: [0.92, 0.84, 0.7, 1] }])],
        sizeFrom: 'input',
        glsl: `void main() { outColor = sampleRamp(g_in(vUv), p_ramp_colors, p_ramp_positions, p_ramp_count); }`,
    }),
    onePass({
        type: 'grayscale',
        label: 'To grey',
        category: 'Adjustments',
        description: 'A colour image as grey: by brightness, by one channel, or the brightest or average of its channels.',
        keywords: ['grayscale', 'desaturate', 'luminance', 'channel'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('gray')],
        params: [select('mode', 'From', 'luminance', [['luminance', 'Brightness'], ['average', 'Average'], ['max', 'Brightest channel'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['a', 'Alpha']])],
        sizeFrom: 'input',
        glsl: `void main() {
    vec4 v = c_in(vUv);
    float g = p_mode == 0 ? luma(v.rgb) : p_mode == 1 ? (v.r + v.g + v.b) / 3.0 : p_mode == 2 ? max(v.r, max(v.g, v.b)) : p_mode == 3 ? v.r : p_mode == 4 ? v.g : p_mode == 5 ? v.b : v.a;
    outColor = vec4(g);
}`,
    }),
    onePass({
        type: 'hsl',
        label: 'Hue, saturation, lightness',
        category: 'Adjustments',
        description: 'Turns hues round the colour wheel, and makes colours more or less vivid, lighter or darker.',
        keywords: ['hue', 'saturation', 'lightness', 'hsv', 'colour shift'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [float('hue', 'Hue shift', 0, -0.5, 0.5), float('saturation', 'Saturation', 0, -1, 1), float('lightness', 'Lightness', 0, -1, 1)],
        sizeFrom: 'input',
        glsl: `void main() {
    vec4 v = c_in(vUv);
    vec3 hsl = rgbToHsl(saturate(v.rgb));
    hsl.x = fract(hsl.x + p_hue);
    hsl.y = saturate(p_saturation >= 0.0 ? mix(hsl.y, 1.0, p_saturation * hsl.y) : hsl.y * (1.0 + p_saturation));
    hsl.z = saturate(p_lightness >= 0.0 ? mix(hsl.z, 1.0, p_lightness) : hsl.z * (1.0 + p_lightness));
    outColor = vec4(hslToRgb(hsl), v.a);
}`,
    }),
    onePass({
        type: 'colorToMask',
        label: 'Colour to mask',
        category: 'Adjustments',
        description: 'White where the image is near a chosen colour.',
        keywords: ['select colour', 'key', 'id mask', 'chroma'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('gray')],
        params: [color('color', 'Colour', [1, 0, 0, 1]), float('range', 'Range', 0.1, 0, 1), float('softness', 'Softness', 0.05, 0, 1)],
        sizeFrom: 'input',
        glsl: `void main() { float d = distance(c_in(vUv).rgb, p_color.rgb); outColor = vec4(1.0 - smoothstep(p_range, p_range + p_softness + 1e-4, d)); }`,
    }),
    onePass({
        type: 'replaceColor',
        label: 'Replace colour',
        category: 'Adjustments',
        description: 'Shifts colours near one colour towards another, keeping their shading.',
        keywords: ['swap colour', 'recolour'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('color')],
        params: [color('from', 'Colour', [1, 0, 0, 1]), color('to', 'Becomes', [0, 0, 1, 1]), float('range', 'Range', 0.25, 0, 1)],
        sizeFrom: 'input',
        glsl: `void main() {
    vec4 v = c_in(vUv);
    float w = 1.0 - smoothstep(0.0, p_range + 1e-4, distance(v.rgb, p_from.rgb));
    outColor = vec4(saturate(v.rgb + (p_to.rgb - p_from.rgb) * w), v.a);
}`,
    }),
    {
        type: 'splitChannels',
        label: 'Split channels',
        category: 'Utility',
        description: 'A colour image as four grey images: red, green, blue and alpha.',
        keywords: ['rgba split', 'separate', 'channels', 'extract'],
        inputs: [colorIn('in', 'Input')],
        outputs: [out('gray', 'r', 'Red'), out('gray', 'g', 'Green'), out('gray', 'b', 'Blue'), out('gray', 'a', 'Alpha')],
        params: [],
        sizeFrom: 'input',
        async run(context) {
            const result: Record<string, ReturnType<typeof context.image>> = {};
            for (const [index, key] of ['r', 'g', 'b', 'a'].entries()) {
                result[key] = context.image('gray');
                await context.pass(result[key], `void main() { outColor = vec4(c_in(vUv)[${index}]); }`);
            }
            return result;
        },
    },
    onePass({
        type: 'mergeChannels',
        label: 'Merge channels',
        category: 'Utility',
        description: 'Four grey images as the red, green, blue and alpha of one colour image (packing maps).',
        keywords: ['rgba merge', 'combine', 'pack', 'orm'],
        inputs: [grayIn('r', 'Red'), grayIn('g', 'Green'), grayIn('b', 'Blue'), grayIn('a', 'Alpha', 'white')],
        outputs: [out('color')],
        params: [],
        sizeFrom: 'input',
        glsl: `void main() { outColor = vec4(g_r(vUv), g_g(vUv), g_b(vUv), g_a(vUv)); }`,
    }),
    onePass({
        type: 'channelShuffle',
        label: 'Shuffle channels',
        category: 'Utility',
        description: 'Builds a colour image taking each channel from any channel of two inputs.',
        keywords: ['swizzle', 'channel swap'],
        inputs: [colorIn('a', 'Image A'), colorIn('b', 'Image B')],
        outputs: [out('color')],
        params: (['r', 'g', 'b', 'a'] as const).map((key, index) =>
            select(key, `${['Red', 'Green', 'Blue', 'Alpha'][index]} from`, ['ar', 'ag', 'ab', 'aa'][index], [['ar', 'A red'], ['ag', 'A green'], ['ab', 'A blue'], ['aa', 'A alpha'], ['br', 'B red'], ['bg', 'B green'], ['bb', 'B blue'], ['ba', 'B alpha'], ['zero', 'Black'], ['one', 'White']])),
        sizeFrom: 'input',
        glsl: `float pick(int choice, vec4 a, vec4 b) { if (choice < 4) return a[choice]; if (choice < 8) return b[choice - 4]; return choice == 8 ? 0.0 : 1.0; }
void main() { vec4 a = c_a(vUv); vec4 b = c_b(vUv); outColor = vec4(pick(p_r, a, b), pick(p_g, a, b), pick(p_b, a, b), pick(p_a, a, b)); }`,
    }),

    // ---- blending ----
    onePass({
        type: 'blend',
        label: 'Blend',
        category: 'Blending',
        description: 'Lays the foreground over the background by a blend mode, as strongly as the opacity and mask allow.',
        keywords: ['mix', 'layer', 'composite', 'multiply', 'overlay', 'screen', 'add', 'subtract', 'lerp'],
        inputs: [anyIn('foreground', 'Foreground'), anyIn('background', 'Background'), grayIn('mask', 'Mask', 'white')],
        outputs: [out('any')],
        params: [select('mode', 'Blend mode', 'normal', BLEND_OPTIONS), float('opacity', 'Opacity', 1, 0, 1), bool('useAlpha', 'Foreground alpha counts', true), bool('clampResult', 'Keep within 0 to 1', true)],
        sizeFrom: 'input',
        kindFrom: ['foreground', 'background'],
        glsl: `void main() {
    vec4 fg = c_foreground(vUv);
    vec4 bg = c_background(vUv);
    if (p_useAlpha == 0) fg.a = 1.0;
    vec4 r = blendOver(fg, bg, p_mode, p_opacity * g_mask(vUv));
    if (p_clampResult == 1) r = clamp(r, 0.0, 1.0);
    outColor = r;
}`,
    }),
    {
        type: 'heightBlend',
        label: 'Height blend',
        category: 'Blending',
        description: 'Joins two height maps where the taller one shows through, giving a natural edge (sand between stones). Also gives the mask of where the top one won.',
        keywords: ['height lerp', 'height mix', 'depth blend'],
        inputs: [grayIn('top', 'Top height'), grayIn('bottom', 'Bottom height'), grayIn('mask', 'Opacity', 'white')],
        outputs: [out('gray', 'out', 'Height'), out('gray', 'mask', 'Mask')],
        params: [float('offset', 'Height offset', 0.5, 0, 1), float('contrast', 'Contrast', 0.9, 0, 1)],
        sizeFrom: 'input',
        async run(context) {
            const shared = `float topWins() { float top = g_top(vUv) * g_mask(vUv) + (p_offset - 0.5) * 2.0; float bottom = g_bottom(vUv); float soft = max(1.0 - p_contrast, 0.002); return saturate((top - bottom) / soft + 0.5); }`;
            const height = context.image('gray');
            const mask = context.image('gray');
            await context.pass(height, `${shared}\nvoid main() { float t = topWins(); outColor = vec4(mix(g_bottom(vUv), max(g_top(vUv), g_bottom(vUv)), t)); }`);
            await context.pass(mask, `${shared}\nvoid main() { outColor = vec4(topWins()); }`);
            return { out: height, mask };
        },
    },
    {
        type: 'switch',
        label: 'Switch',
        category: 'Utility',
        description: 'Passes on one of two inputs, chosen by a setting (often a graph parameter).',
        keywords: ['choose', 'select', 'if', 'toggle'],
        inputs: [anyIn('a', 'When off'), anyIn('b', 'When on')],
        outputs: [out('any')],
        params: [bool('on', 'On', false)],
        sizeFrom: 'input',
        kindFrom: ['a', 'b'],
        async run(context) {
            const chosen = context.input(context.params.on ? 'b' : 'a');
            if (chosen && chosen.kind === context.outputKind('out')) return { out: context.gpu.retain(chosen) };
            const image = context.image(context.outputKind('out'));
            await context.pass(image, `void main() { outColor = ${context.params.on ? 'c_b' : 'c_a'}(vUv); }`);
            return { out: image };
        },
    },
];
