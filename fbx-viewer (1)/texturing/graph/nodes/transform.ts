import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { anyIn, bool, colorIn, float, grayIn, int, onePass, out, select, vec2 } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';

/** Moving, repeating and bending images, and blurring and sharpening them. */

/** Widest Gaussian (in pixels) blurred at full size; wider ones are blurred on a smaller copy. */
const MAX_SIGMA = 12;

const GAUSS_1D = `uniform vec2 uStep;
uniform float uSigma;
void main() {
    int taps = int(ceil(uSigma * 3.0));
    float total = 1.0;
    vec4 sum = texture(source, vUv);
    for (int i = 1; i <= 40; i++) {
        if (i > taps) break;
        float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
        sum += (texture(source, vUv + uStep * float(i)) + texture(source, vUv - uStep * float(i))) * w;
        total += 2.0 * w;
    }
    outColor = sum / total;
}`;

/**
 * A Gaussian blur of `sigma` pixels (of the input's size), wrapping round the edges so a tiling image
 * stays tiling. Returned at the input's size.
 */
export const gaussianBlur = async (context: Pick<NodeRunContext, 'gpu'>, input: GpuImage, sigma: number, precision = input.precision): Promise<GpuImage> => {
    const gpu = context.gpu;
    let source = gpu.retain(input);
    let factor = 1;
    // Halve until the blur is small enough to sample directly.
    while (sigma / factor > MAX_SIGMA && source.width > 8 && source.height > 8) {
        const half = gpu.image(Math.max(1, source.width >> 1), Math.max(1, source.height >> 1), input.kind, precision);
        await gpu.pass(half, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source } });
        gpu.release(source);
        source = half;
        factor *= 2;
    }
    const s = sigma / factor;
    if (s >= 0.25) {
        const across = gpu.image(source.width, source.height, input.kind, precision);
        await gpu.pass(across, { fragment: GAUSS_1D, inputs: { source }, uniforms: { uStep: new THREE.Vector2(1 / source.width, 0), uSigma: s }, cost: Math.ceil(s * 6) + 1 });
        const down = gpu.image(source.width, source.height, input.kind, precision);
        await gpu.pass(down, { fragment: GAUSS_1D, inputs: { source: across }, uniforms: { uStep: new THREE.Vector2(0, 1 / source.height), uSigma: s }, cost: Math.ceil(s * 6) + 1 });
        gpu.release(across);
        gpu.release(source);
        source = down;
    }
    if (source.width === input.width && source.height === input.height) return source;
    const full = gpu.image(input.width, input.height, input.kind, precision);
    await gpu.pass(full, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source } });
    gpu.release(source);
    return full;
};

/** A blur radius set as a share of the image's width, in pixels of `image`. */
const sigmaOf = (radius: unknown, image: GpuImage): number => (Number(radius) || 0) * image.width / 3;

export const TRANSFORM_NODES: TexNodeDef[] = [
    onePass({
        type: 'transform',
        label: 'Transform',
        category: 'Transforms',
        description: 'Moves, turns and scales the image, repeating it or leaving empty space around it.',
        keywords: ['move', 'offset', 'rotate', 'scale', 'translate', 'transformation 2d'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [vec2('offset', 'Offset', [0, 0], -1, 1), float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }), vec2('scale', 'Scale', [1, 1], 0.01, 16), bool('repeat', 'Repeat', true)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 p = vUv - 0.5 - p_offset;
    p = rotate2(radians(p_rotation)) * p;
    p = p / max(abs(p_scale), vec2(1e-4)) * sign(p_scale + 1e-9) + 0.5;
    if (p_repeat == 0 && (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0)) { outColor = vec4(0.0); return; }
    outColor = c_in(p);
}`,
    }),
    onePass({
        type: 'tile',
        label: 'Repeat',
        category: 'Transforms',
        description: 'Repeats the image a whole number of times each way, with an optional shift every other row.',
        keywords: ['tile', 'repeat', 'tiling'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [int('x', 'Across', 2, 1, 64), int('y', 'Down', 2, 1, 64), float('rowOffset', 'Row shift', 0, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 p = vUv * vec2(p_x, p_y);
    p.x += mod(floor(p.y), 2.0) * p_rowOffset;
    outColor = c_in(fract(p));
}`,
    }),
    onePass({
        type: 'mirror',
        label: 'Mirror',
        category: 'Transforms',
        description: 'Reflects one half (or one quarter) of the image onto the rest.',
        keywords: ['symmetry', 'reflect', 'flip'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('mode', 'Mirror', 'leftToRight', [['leftToRight', 'Left onto right'], ['rightToLeft', 'Right onto left'], ['topToBottom', 'Top onto bottom'], ['bottomToTop', 'Bottom onto top'], ['corner', 'One corner onto all'], ['flipX', 'Flip across'], ['flipY', 'Flip down']])],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 p = vUv;
    if (p_mode == 0) p.x = p.x > 0.5 ? 1.0 - p.x : p.x;
    else if (p_mode == 1) p.x = p.x < 0.5 ? 1.0 - p.x : p.x;
    else if (p_mode == 2) p.y = p.y < 0.5 ? 1.0 - p.y : p.y;
    else if (p_mode == 3) p.y = p.y > 0.5 ? 1.0 - p.y : p.y;
    else if (p_mode == 4) { p.x = p.x > 0.5 ? 1.0 - p.x : p.x; p.y = p.y < 0.5 ? 1.0 - p.y : p.y; }
    else if (p_mode == 5) p.x = 1.0 - p.x;
    else p.y = 1.0 - p.y;
    outColor = c_in(p);
}`,
    }),
    onePass({
        type: 'makeTile',
        label: 'Make it tile',
        category: 'Transforms',
        description: 'Hides the seams of an image that does not tile by blending a shifted copy in along its edges.',
        keywords: ['seamless', 'tileable', 'make tile', 'photo'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('width', 'Blend width', 0.2, 0.01, 0.5), float('softness', 'Softness', 0.6, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 d = min(vUv, 1.0 - vUv);
    float edge = min(d.x, d.y);
    float w = smoothstep(p_width, p_width * (1.0 - p_softness), edge);
    outColor = mix(c_in(vUv), c_in(fract(vUv + 0.5)), w);
}`,
    }),
    onePass({
        type: 'polar',
        label: 'Polar coordinates',
        category: 'Transforms',
        description: 'Wraps the image round the centre (rows become rings), or unwraps rings into rows.',
        keywords: ['cartesian to polar', 'polar to cartesian', 'radial', 'circular'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [select('direction', 'Direction', 'toPolar', [['toPolar', 'Rows into rings'], ['fromPolar', 'Rings into rows']]), int('repeat', 'Repeat round', 1, 1, 32)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 p;
    if (p_direction == 0) {
        vec2 c = vUv - 0.5;
        p = vec2(fract(atan(c.y, c.x) / TAU * float(p_repeat) + 0.5), length(c) * 2.0);
        if (p.y > 1.0) { outColor = vec4(0.0); return; }
    } else {
        float a = (vUv.x - 0.5) * TAU / float(p_repeat);
        p = vec2(cos(a), sin(a)) * vUv.y * 0.5 + 0.5;
    }
    outColor = c_in(p);
}`,
    }),
    onePass({
        type: 'swirl',
        label: 'Swirl',
        category: 'Warps',
        description: 'Twists the image around its centre.',
        keywords: ['twirl', 'twist', 'vortex'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('amount', 'Amount (turns)', 0.5, -4, 4), float('radius', 'Radius', 0.5, 0.01, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() {
    vec2 c = vUv - 0.5;
    float r = length(c);
    float t = saturate(1.0 - r / p_radius);
    c = rotate2(t * t * p_amount * TAU) * c;
    outColor = c_in(c + 0.5);
}`,
    }),
    onePass({
        type: 'warp',
        label: 'Warp',
        category: 'Warps',
        description: 'Pushes the image along the slopes of a grey image: noise wired in gives an organic wobble.',
        keywords: ['distort', 'displace', 'slope', 'gradient warp'],
        inputs: [anyIn('in', 'Input'), grayIn('gradient', 'Slopes from', 'mid')],
        outputs: [out('any')],
        params: [float('intensity', 'Strength', 0.05, 0, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 5,
        glsl: `void main() {
    vec2 texel = 1.0 / vec2(textureSize(t_gradient, 0));
    vec2 slope = vec2(g_gradient(vUv + vec2(texel.x, 0.0)) - g_gradient(vUv - vec2(texel.x, 0.0)), g_gradient(vUv + vec2(0.0, texel.y)) - g_gradient(vUv - vec2(0.0, texel.y)));
    // Slope per unit of the image, so the push is the same at any size.
    slope = slope / (2.0 * texel) * 0.01;
    outColor = c_in(vUv + slope * p_intensity);
}`,
    }),
    onePass({
        type: 'directionalWarp',
        label: 'Directional warp',
        category: 'Warps',
        description: 'Pushes each pixel in one direction, as far as a grey image says.',
        keywords: ['offset by map', 'displace direction', 'shift'],
        inputs: [anyIn('in', 'Input'), grayIn('amount', 'How far', 'mid')],
        outputs: [out('any')],
        params: [float('angle', 'Direction (degrees)', 0, -360, 360, { step: 1 }), float('intensity', 'Strength', 0.1, -1, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() { float a = radians(p_angle); outColor = c_in(vUv + vec2(cos(a), sin(a)) * g_amount(vUv) * p_intensity); }`,
    }),
    onePass({
        type: 'vectorWarp',
        label: 'Vector warp',
        category: 'Warps',
        description: 'Pushes each pixel by the direction in a colour image (red across, green down, mid grey none), such as a flow map or a normal map.',
        keywords: ['flow map', 'vector map', 'uv offset'],
        inputs: [anyIn('in', 'Input'), colorIn('vector', 'Directions', 'mid')],
        outputs: [out('any')],
        params: [float('intensity', 'Strength', 0.1, -1, 1)],
        sizeFrom: 'input',
        kindFrom: 'in',
        glsl: `void main() { vec2 v = c_vector(vUv).rg * 2.0 - 1.0; outColor = c_in(vUv + v * p_intensity); }`,
    }),
    onePass({
        type: 'slopeBlur',
        label: 'Slope blur',
        category: 'Warps',
        description: 'Smears the image downhill (or uphill) along a grey image\'s slopes: melted, eroded and dripping looks.',
        keywords: ['erosion', 'smear', 'melt', 'slope'],
        inputs: [anyIn('in', 'Input'), grayIn('slope', 'Slopes from', 'mid')],
        outputs: [out('any')],
        params: [float('intensity', 'Distance', 0.03, -0.3, 0.3), int('samples', 'Steps', 16, 2, 48), select('mode', 'Keeps', 'blur', [['blur', 'Average'], ['min', 'Darkest'], ['max', 'Brightest']])],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => Number(params.samples) * 5,
        glsl: `void main() {
    vec2 texel = 1.0 / vec2(textureSize(t_slope, 0));
    vec2 p = vUv;
    vec4 sum = c_in(p);
    vec4 lo = sum;
    vec4 hi = sum;
    float taken = 1.0;
    float stepLength = p_intensity / float(p_samples);
    for (int i = 0; i < 48; i++) {
        if (i >= p_samples) break;
        vec2 g = vec2(g_slope(p + vec2(texel.x, 0.0)) - g_slope(p - vec2(texel.x, 0.0)), g_slope(p + vec2(0.0, texel.y)) - g_slope(p - vec2(0.0, texel.y)));
        float len = length(g);
        if (len < 1e-6) break;
        p -= g / len * stepLength;
        vec4 v = c_in(p);
        sum += v;
        taken += 1.0;
        lo = min(lo, v);
        hi = max(hi, v);
    }
    // Flat ground stops the walk early: average what was gathered.
    outColor = p_mode == 0 ? sum / taken : p_mode == 1 ? lo : hi;
}`,
    }),

    // ---- blurs and sharpening ----
    {
        type: 'blur',
        label: 'Blur',
        category: 'Blurs and sharpening',
        description: 'A smooth Gaussian blur. The radius is a share of the image, so it looks the same at any size.',
        keywords: ['gaussian', 'soften', 'blur hq', 'smooth'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('radius', 'Radius', 0.01, 0, 0.25, { step: 0.001 })],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            if (!input) { const empty = context.image(context.outputKind('out')); context.gpu.clear(empty, [0, 0, 0, 1]); return { out: empty }; }
            const blurred = await gaussianBlur(context, input, sigmaOf(context.params.radius, input), context.precision);
            if (blurred.width === context.width && blurred.height === context.height) return { out: blurred };
            const sized = context.image(context.outputKind('out'));
            context.gpu.copy(blurred, sized);
            context.gpu.release(blurred);
            return { out: sized };
        },
    },
    onePass({
        type: 'directionalBlur',
        label: 'Directional blur',
        category: 'Blurs and sharpening',
        description: 'Blurs along one direction only, like motion.',
        keywords: ['motion blur', 'streak blur'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('angle', 'Direction (degrees)', 0, -360, 360, { step: 1 }), float('length', 'Length', 0.05, 0, 0.5), int('samples', 'Samples', 24, 4, 64), bool('oneSided', 'One side only', false)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: (params) => Number(params.samples),
        glsl: `void main() {
    float a = radians(p_angle);
    vec2 dir = vec2(cos(a), sin(a)) * p_length;
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 64; i++) {
        if (i >= p_samples) break;
        float t = float(i) / float(p_samples - 1);
        t = p_oneSided == 1 ? t : t - 0.5;
        sum += c_in(vUv + dir * t);
    }
    outColor = sum / float(p_samples);
}`,
    }),
    onePass({
        type: 'variableBlur',
        label: 'Blur by mask',
        category: 'Blurs and sharpening',
        description: 'Blurs more where a grey image is bright and not at all where it is black.',
        keywords: ['non uniform blur', 'variable blur', 'depth of field'],
        inputs: [anyIn('in', 'Input'), grayIn('amount', 'Blur amount', 'white')],
        outputs: [out('any')],
        params: [float('radius', 'Most radius', 0.02, 0, 0.2, { step: 0.001 })],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 33,
        glsl: `void main() {
    float r = p_radius * g_amount(vUv);
    vec4 sum = c_in(vUv);
    float total = 1.0;
    // A Vogel spiral of 32 points over the disc.
    for (int i = 0; i < 32; i++) {
        float t = (float(i) + 0.5) / 32.0;
        float a = float(i) * 2.39996323;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(t) * r;
        float w = exp(-t * 2.0);
        sum += c_in(vUv + o) * w;
        total += w;
    }
    outColor = sum / total;
}`,
    }),
    onePass({
        type: 'sharpen',
        label: 'Sharpen',
        category: 'Blurs and sharpening',
        description: 'Makes fine detail crisper.',
        keywords: ['unsharp mask', 'crisp', 'detail'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('amount', 'Amount', 0.5, 0, 4)],
        sizeFrom: 'input',
        kindFrom: 'in',
        cost: () => 5,
        glsl: `void main() {
    // A pixel of the input, not of this node: a size change here only resamples the result.
    vec2 texel = 1.0 / vec2(textureSize(t_in, 0));
    vec4 c = c_in(vUv);
    vec4 around = (c_in(vUv + vec2(texel.x, 0.0)) + c_in(vUv - vec2(texel.x, 0.0)) + c_in(vUv + vec2(0.0, texel.y)) + c_in(vUv - vec2(0.0, texel.y))) * 0.25;
    outColor = vec4(c.rgb + (c.rgb - around.rgb) * p_amount, c.a);
}`,
    }),
    {
        type: 'highpass',
        label: 'High pass',
        category: 'Blurs and sharpening',
        description: 'Keeps only detail finer than the radius, around mid grey: takes broad light and dark out of a photo.',
        keywords: ['highpass', 'detail', 'flatten'],
        inputs: [anyIn('in', 'Input')],
        outputs: [out('any')],
        params: [float('radius', 'Radius', 0.02, 0.001, 0.25, { step: 0.001 })],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            const result = context.image(context.outputKind('out'));
            if (!input) { context.gpu.clear(result, [0.5, 0.5, 0.5, 1]); return { out: result }; }
            const blurred = await gaussianBlur(context, input, sigmaOf(context.params.radius, input), 16);
            await context.pass(result, `uniform sampler2D blurred;\nvoid main() { vec4 v = c_in(vUv); vec4 b = texture(blurred, vUv); ${input.kind === 'gray' ? 'b = vec4(b.rrr, 1.0);' : ''} outColor = vec4(saturate(v.rgb - b.rgb + 0.5), v.a); }`, { inputs: { blurred } });
            context.gpu.release(blurred);
            return { out: result };
        },
    },
    onePass({
        type: 'emboss',
        label: 'Emboss',
        category: 'Height and normals',
        description: 'Lights a grey image from one side, as though it were raised.',
        keywords: ['relief', 'light', 'shade'],
        inputs: [grayIn('in', 'Height')],
        outputs: [out('gray')],
        params: [float('angle', 'Light from (degrees)', 45, -360, 360, { step: 1 }), float('intensity', 'Strength', 4, 0, 32)],
        sizeFrom: 'input',
        cost: () => 4,
        glsl: `void main() {
    // Slopes across a pixel of the input, as slope per unit of the image: the same look at any size of this node.
    vec2 inputSize = vec2(textureSize(t_in, 0));
    vec2 texel = 1.0 / inputSize;
    vec2 g = vec2(g_in(vUv + vec2(texel.x, 0.0)) - g_in(vUv - vec2(texel.x, 0.0)), g_in(vUv + vec2(0.0, texel.y)) - g_in(vUv - vec2(0.0, texel.y)));
    g *= inputSize.x / 512.0;
    float a = radians(p_angle);
    outColor = vec4(saturate(0.5 + dot(g, vec2(cos(a), sin(a))) * p_intensity));
}`,
    }),
];
