import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import {
    MATERIAL_CHANNELS, MATERIAL_CHANNEL_KINDS, MATERIAL_CHANNEL_LABELS, MATERIAL_DEFAULTS, MATERIAL_GLSL, MATERIAL_PRECISION, materialResults, tilingTransform,
    type MaterialChannelName, type MaterialImages,
} from '../material';
import { bool, color, colorIn, float, grayIn, materialIn, materialOut, out, vec2 } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';

/**
 * MATERIAL NODES
 *
 * Nodes whose wires carry a whole material: making one from separate channels, splitting it again,
 * blending two (with a mask, or by height), blending several, switching, moving and adjusting one.
 * Each works channel by channel: a channel neither side carries stays left out, one side lacks reads
 * as its default. Normals blend as directions; a height blend works out its weights once.
 */

type Bindings = { inputs: Record<string, GpuImage | THREE.Texture>; uniforms: Record<string, unknown> };

/** A fresh picture for one channel of the material a node makes, at the node's size. */
const channelImage = (context: NodeRunContext, channel: MaterialChannelName): GpuImage =>
    context.image(MATERIAL_CHANNEL_KINDS[channel], context.width, context.height, MATERIAL_PRECISION[channel]);

/** GLSL reading a channel picture bound as `name` (r_name(uv)), or the channel's default where the material has none. */
const reader = (name: string, channel: MaterialChannelName): string => {
    const gray = MATERIAL_CHANNEL_KINDS[channel] === 'gray';
    return `uniform int h_${name};\nuniform vec4 d_${name};\nvec4 r_${name}(vec2 uv) { if (h_${name} == 0) return d_${name}; vec4 v = texture(${name}, uv); return ${gray ? 'vec4(v.rrr, 1.0)' : 'v'}; }`;
};

const bind = (context: NodeRunContext, into: Bindings, name: string, channel: MaterialChannelName, image: GpuImage | undefined): void => {
    into.inputs[name] = image ?? context.gpu.constant('black');
    into.uniforms[`h_${name}`] = image ? 1 : 0;
    const value = MATERIAL_DEFAULTS[channel];
    into.uniforms[`d_${name}`] = new THREE.Vector4(value[0], value[1], value[2], value[3]);
};

/** How a channel's value is written: a grey channel keeps its value in every component. */
const write = (channel: MaterialChannelName, value: string): string =>
    (MATERIAL_CHANNEL_KINDS[channel] === 'gray' ? `outColor = vec4(vec3((${value}).r), 1.0);` : `outColor = ${value};`);

const kept = (context: NodeRunContext, images: MaterialImages | null): MaterialImages => {
    const result: MaterialImages = {};
    for (const channel of MATERIAL_CHANNELS) {
        const image = images?.[channel];
        if (image) result[channel] = context.gpu.retain(image);
    }
    return result;
};

/**
 * Two materials blended channel by channel by the weight `weight` (GLSL, 0 for the bottom, 1 for the
 * top), with `extra` bound for it. Heights blend by `height` when given; normals always as directions.
 */
const blendTwo = async (
    context: NodeRunContext,
    bottom: MaterialImages | null,
    top: MaterialImages | null,
    weight: string,
    extra: (into: Bindings) => void,
    height?: string,
): Promise<MaterialImages> => {
    const result: MaterialImages = {};
    for (const channel of MATERIAL_CHANNELS) {
        const a = bottom?.[channel];
        const b = top?.[channel];
        if (!a && !b) continue;
        const target = channelImage(context, channel);
        const into: Bindings = { inputs: {}, uniforms: {} };
        bind(context, into, 'mA', channel, a);
        bind(context, into, 'mB', channel, b);
        extra(into);
        const mixed = channel === 'normal' ? 'mixNormals(r_mA(vUv), r_mB(vUv), t)'
            : channel === 'height' && height ? height
                : 'mix(r_mA(vUv), r_mB(vUv), t)';
        await context.pass(target, `${MATERIAL_GLSL}\n${reader('mA', channel)}\n${reader('mB', channel)}\nvoid main() { float t = ${weight}; ${write(channel, mixed)} }`, into);
        result[channel] = target;
    }
    return result;
};

const MAKE: TexNodeDef = {
    type: 'makeMaterial',
    label: 'Make material',
    category: 'Materials',
    description: 'Puts separate channels (base colour, normal, roughness...) on one material wire. Base colour, roughness and metallic take the values set here when nothing is wired; other channels left unwired read as their defaults.',
    keywords: ['material', 'combine', 'pack channels', 'pbr', 'surface'],
    inputs: [
        colorIn('baseColor', 'Base colour'), colorIn('normal', 'Normal', 'normal'), grayIn('roughness', 'Roughness', 'mid'), grayIn('metallic', 'Metallic'),
        grayIn('height', 'Height', 'mid'), grayIn('ambientOcclusion', 'Ambient occlusion', 'white'), colorIn('emissive', 'Emissive'), grayIn('opacity', 'Opacity', 'white'),
    ],
    outputs: [materialOut()],
    params: [
        color('baseColorValue', 'Base colour (when unwired)', [0.5, 0.5, 0.5, 1]),
        float('roughnessValue', 'Roughness (when unwired)', 0.5, 0, 1),
        float('metallicValue', 'Metallic (when unwired)', 0, 0, 1),
    ],
    sizeFrom: 'input',
    bypass: false,
    async run(context) {
        const made: MaterialImages = {};
        for (const channel of MATERIAL_CHANNELS) {
            const image = context.input(channel);
            const kind = MATERIAL_CHANNEL_KINDS[channel];
            if (image) {
                if (image.kind === kind && image.width === context.width && image.height === context.height) {
                    made[channel] = context.gpu.retain(image);
                    continue;
                }
                const target = channelImage(context, channel);
                await context.pass(target, `void main() { ${kind === 'gray' ? `outColor = vec4(vec3(g_${channel}(vUv)), 1.0);` : `outColor = c_${channel}(vUv);`} }`);
                made[channel] = target;
                continue;
            }
            const value = channel === 'baseColor' ? context.params.baseColorValue as [number, number, number, number]
                : channel === 'roughness' ? [Number(context.params.roughnessValue), Number(context.params.roughnessValue), Number(context.params.roughnessValue), 1] as [number, number, number, number]
                    : channel === 'metallic' ? [Number(context.params.metallicValue), Number(context.params.metallicValue), Number(context.params.metallicValue), 1] as [number, number, number, number]
                        : null;
            if (!value) continue;
            const target = channelImage(context, channel);
            context.gpu.clear(target, [value[0], value[1], value[2], 1]);
            made[channel] = target;
        }
        return materialResults('out', made);
    },
};

const SPLIT: TexNodeDef = {
    type: 'splitMaterial',
    label: 'Split material',
    category: 'Materials',
    description: 'Takes a material wire apart into its channels; a channel the material does not carry comes out as its default.',
    keywords: ['material', 'separate', 'unpack channels', 'channels'],
    inputs: [materialIn('material', 'Material')],
    outputs: MATERIAL_CHANNELS.map((channel) => out(MATERIAL_CHANNEL_KINDS[channel], channel, MATERIAL_CHANNEL_LABELS[channel])),
    params: [],
    sizeFrom: 'input',
    bypass: false,
    async run(context) {
        const material = context.material('material');
        const results: Record<string, GpuImage> = {};
        for (const channel of MATERIAL_CHANNELS) {
            const image = material?.[channel];
            if (image) { results[channel] = context.gpu.retain(image); continue; }
            const filled = channelImage(context, channel);
            context.gpu.clear(filled, MATERIAL_DEFAULTS[channel]);
            results[channel] = filled;
        }
        return results;
    },
};

const BLEND: TexNodeDef = {
    type: 'materialBlend',
    label: 'Material blend',
    category: 'Materials',
    description: 'Lays one material over another where the mask is white, every channel at once; normals blend as directions.',
    keywords: ['material', 'mix', 'layer', 'mask', 'lerp'],
    inputs: [materialIn('background', 'Background'), materialIn('foreground', 'Foreground'), grayIn('mask', 'Mask', 'white')],
    outputs: [materialOut()],
    params: [float('opacity', 'Opacity', 1, 0, 1)],
    sizeFrom: 'input',
    main: 'background',
    async run(context) {
        const background = context.material('background');
        const foreground = context.material('foreground');
        if (!foreground) return materialResults('out', kept(context, background));
        return materialResults('out', await blendTwo(context, background, foreground, 'saturate(g_mask(vUv) * p_opacity)', () => undefined));
    },
};

const HEIGHT_BLEND: TexNodeDef = {
    type: 'materialHeightBlend',
    label: 'Height blend of two materials',
    category: 'Materials',
    description: 'Joins two materials where the taller one shows through (stones poking out of sand), every channel by the same weights, worked out once from their heights. Also gives the mask of where the top won.',
    keywords: ['material', 'height lerp', 'height mix', 'depth blend', 'material height blend'],
    inputs: [materialIn('bottom', 'Bottom'), materialIn('top', 'Top'), grayIn('mask', 'Opacity', 'white')],
    outputs: [materialOut(), out('gray', 'mask', 'Mask')],
    params: [float('offset', 'Height offset', 0.5, 0, 1), float('contrast', 'Contrast', 0.9, 0, 1)],
    sizeFrom: 'input',
    main: 'bottom',
    async run(context) {
        const bottom = context.material('bottom');
        const top = context.material('top');
        // Where the top shows, once, from the two heights: every channel blends by it.
        const weight = context.image('gray', context.width, context.height, 16);
        if (!top) {
            context.gpu.clear(weight, [0, 0, 0, 1]);
            return { ...materialResults('out', kept(context, bottom)), mask: weight };
        }
        const heights: Bindings = { inputs: {}, uniforms: {} };
        bind(context, heights, 'hA', 'height', bottom?.height);
        bind(context, heights, 'hB', 'height', top.height);
        await context.pass(weight, `${MATERIAL_GLSL}
${reader('hA', 'height')}
${reader('hB', 'height')}
void main() { outColor = vec4(vec3(heightWeight(r_hB(vUv).r, r_hA(vUv).r, g_mask(vUv), p_offset, p_contrast)), 1.0); }`, heights);
        const material = await blendTwo(context, bottom, top, 'texture(weights, vUv).r', (into) => { into.inputs.weights = weight; }, 'vec4(vec3(blendedHeight(r_mB(vUv).r, r_mA(vUv).r, t)), 1.0)');
        return { ...materialResults('out', material), mask: weight };
    },
};

const MULTI_BLEND: TexNodeDef = {
    type: 'materialMultiBlend',
    label: 'Blend several materials',
    category: 'Materials',
    description: 'Lays up to three materials over a base in turn, each where its own mask is white.',
    keywords: ['material', 'layers', 'multi blend', 'mask', 'stack'],
    inputs: [
        materialIn('m1', 'Base'),
        materialIn('m2', 'Material 2'), grayIn('mask2', 'Mask 2'),
        materialIn('m3', 'Material 3'), grayIn('mask3', 'Mask 3'),
        materialIn('m4', 'Material 4'), grayIn('mask4', 'Mask 4'),
    ],
    outputs: [materialOut()],
    params: [],
    sizeFrom: 'input',
    main: 'm1',
    async run(context) {
        const layers = [context.material('m1'), context.material('m2'), context.material('m3'), context.material('m4')];
        if (!layers[1] && !layers[2] && !layers[3]) return materialResults('out', kept(context, layers[0]));
        const result: MaterialImages = {};
        for (const channel of MATERIAL_CHANNELS) {
            if (!layers.some((layer) => layer?.[channel])) continue;
            const target = channelImage(context, channel);
            const into: Bindings = { inputs: {}, uniforms: {} };
            const steps: string[] = [];
            layers.forEach((layer, index) => {
                bind(context, into, `m${index + 1}`, channel, layer?.[channel]);
                if (index === 0) return;
                into.uniforms[`on${index + 1}`] = layer ? 1 : 0;
                const t = `(on${index + 1} == 1 ? g_mask${index + 1}(vUv) : 0.0)`;
                steps.push(channel === 'normal' ? `v = mixNormals(v, r_m${index + 1}(vUv), ${t});` : `v = mix(v, r_m${index + 1}(vUv), ${t});`);
            });
            const readers = layers.map((_, index) => reader(`m${index + 1}`, channel)).join('\n');
            await context.pass(target, `${MATERIAL_GLSL}\n${readers}\nuniform int on2;\nuniform int on3;\nuniform int on4;
void main() { vec4 v = r_m1(vUv); ${steps.join(' ')} ${write(channel, 'v')} }`, into);
            result[channel] = target;
        }
        return materialResults('out', result);
    },
};

const SWITCH: TexNodeDef = {
    type: 'materialSwitch',
    label: 'Material switch',
    category: 'Materials',
    description: 'Passes on one of two materials, chosen by a setting (often a graph parameter).',
    keywords: ['material', 'choose', 'select', 'if', 'toggle'],
    inputs: [materialIn('a', 'When off'), materialIn('b', 'When on')],
    outputs: [materialOut()],
    params: [bool('on', 'On', false)],
    sizeFrom: 'input',
    async run(context) {
        return materialResults('out', kept(context, context.material(context.params.on ? 'b' : 'a')));
    },
};

const TRANSFORM: TexNodeDef = {
    type: 'materialTransform',
    label: 'Material transform',
    category: 'Materials',
    description: 'Moves, turns and repeats a whole material; its normals turn with it. Keeping tiling holds the repeats whole and the turn to quarter turns, so the material still tiles.',
    keywords: ['material', 'move', 'offset', 'rotate', 'scale', 'tile', 'repeat'],
    inputs: [materialIn('material', 'Material')],
    outputs: [materialOut()],
    params: [
        vec2('offset', 'Offset', [0, 0], -1, 1),
        float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
        vec2('repeats', 'Repeats', [1, 1], -16, 16, { step: 0.05 }),
        bool('keepTiling', 'Keep tiling', true, { hint: 'Repeats stay whole and the turn stays a quarter turn, so the material still tiles.' }),
    ],
    sizeFrom: 'input',
    main: 'material',
    async run(context) {
        const material = context.material('material');
        const given = context.params.repeats as [number, number];
        const shape = tilingTransform([Number(given?.[0]) || 1, Number(given?.[1]) || 1], Number(context.params.rotation) || 0, context.params.keepTiling !== false);
        const result: MaterialImages = {};
        for (const channel of MATERIAL_CHANNELS) {
            const image = material?.[channel];
            if (!image) continue;
            const target = channelImage(context, channel);
            const into: Bindings = { inputs: {}, uniforms: { uTurn: shape.degrees, uRepeats: new THREE.Vector2(shape.repeats[0], shape.repeats[1]) } };
            bind(context, into, 'm', channel, image);
            const value = channel === 'normal' ? 'turnNormal(r_m(fract(p)), uTurn, uRepeats)' : 'r_m(fract(p))';
            await context.pass(target, `${MATERIAL_GLSL}\n${reader('m', channel)}\nuniform float uTurn;\nuniform vec2 uRepeats;
void main() {
    vec2 p = vUv - 0.5 - p_offset;
    p = rotate2(radians(uTurn)) * p;
    p = p * uRepeats + 0.5;
    ${write(channel, value)}
}`, into);
            result[channel] = target;
        }
        return materialResults('out', result);
    },
};

const ADJUST: TexNodeDef = {
    type: 'materialAdjust',
    label: 'Material adjust',
    category: 'Materials',
    description: 'Changes a whole material at once: the colour (hue, vividness, lightness), how rough it is, and how deep its height and normals read.',
    keywords: ['material', 'adjust', 'tweak', 'hue', 'roughness', 'height strength', 'normal strength'],
    inputs: [materialIn('material', 'Material')],
    outputs: [materialOut()],
    params: [
        float('hue', 'Hue shift', 0, -0.5, 0.5),
        float('saturation', 'Saturation', 0, -1, 1),
        float('lightness', 'Lightness', 0, -1, 1),
        float('roughness', 'Roughness', 0, -1, 1, { hint: 'Above 0 rougher, below 0 smoother.' }),
        float('heightStrength', 'Height strength', 1, 0, 4),
        float('normalStrength', 'Normal strength', 1, 0, 4),
    ],
    sizeFrom: 'input',
    main: 'material',
    async run(context) {
        const material = context.material('material');
        const p = context.params;
        const colour = Number(p.hue) !== 0 || Number(p.saturation) !== 0 || Number(p.lightness) !== 0;
        const changes: Partial<Record<MaterialChannelName, string>> = {
            ...(colour ? {
                baseColor: `vec4 adjusted(vec4 v) {
    vec3 hsl = rgbToHsl(saturate(v.rgb));
    hsl.x = fract(hsl.x + p_hue);
    hsl.y = saturate(p_saturation >= 0.0 ? mix(hsl.y, 1.0, p_saturation * hsl.y) : hsl.y * (1.0 + p_saturation));
    hsl.z = saturate(p_lightness >= 0.0 ? mix(hsl.z, 1.0, p_lightness) : hsl.z * (1.0 + p_lightness));
    return vec4(hslToRgb(hsl), v.a);
}`,
            } : {}),
            ...(Number(p.roughness) !== 0 ? { roughness: 'vec4 adjusted(vec4 v) { return vec4(vec3(adjustRoughness(v.r, p_roughness)), 1.0); }' } : {}),
            ...(Number(p.heightStrength) !== 1 ? { height: 'vec4 adjusted(vec4 v) { return vec4(vec3(saturate(0.5 + (v.r - 0.5) * p_heightStrength)), 1.0); }' } : {}),
            ...(Number(p.normalStrength) !== 1 ? { normal: 'vec4 adjusted(vec4 v) { return scaleNormal(v, p_normalStrength); }' } : {}),
        };
        const result: MaterialImages = {};
        for (const channel of MATERIAL_CHANNELS) {
            const image = material?.[channel];
            const change = changes[channel];
            // Unchanged channels pass as they are; a changed one the material lacks is made from its default.
            if (!change) { if (image) result[channel] = context.gpu.retain(image); continue; }
            if (!material) continue;
            const target = channelImage(context, channel);
            const into: Bindings = { inputs: {}, uniforms: {} };
            bind(context, into, 'm', channel, image);
            await context.pass(target, `${MATERIAL_GLSL}\n${reader('m', channel)}\n${change}\nvoid main() { ${write(channel, 'adjusted(r_m(vUv))')} }`, into);
            result[channel] = target;
        }
        return materialResults('out', result);
    },
};

export const MATERIAL_NODES: TexNodeDef[] = [MAKE, SPLIT, BLEND, HEIGHT_BLEND, MULTI_BLEND, SWITCH, TRANSFORM, ADJUST];
