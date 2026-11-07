import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { MATERIAL_CHANNELS, MATERIAL_DEFAULTS, materialKey, materialResults, outputChannelOf, type MaterialImages } from '../material';
import { NAMED_RECEIVE_TYPE, NAMED_SEND_TYPE } from '../namedLinks';
import { anyIn, color, colorIn, float, onePass, out, select, vec2 } from '../nodeKit';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, outputNodeKind, type GraphParameter, type NodeRunContext, type OutputChannel, type PortKind, type TexNodeDef, type TexParamDef } from '../types';
import { parameterSetting } from '../parameters';

/** Where a graph starts and ends, the model's baked maps, project pictures and hand-written pixels. */

export const INPUT_NODE_TYPE = 'input';
export const OUTPUT_NODE_TYPE = 'output';
export const SUBGRAPH_NODE_TYPE = 'subgraph';
/** Runs a graph of the project a number of times, each pass's results fed into the next. */
export const ITERATE_NODE_TYPE = 'iterate';
/** Nodes that run another graph of the project. */
export const GRAPH_USING_TYPES: ReadonlySet<string> = new Set([SUBGRAPH_NODE_TYPE, ITERATE_NODE_TYPE]);
export const MESH_MAP_NODE_TYPE = 'meshMap';
/** A point a wire passes through on the canvas; it changes nothing. */
export const REROUTE_NODE_TYPE = 'reroute';
/** A graph's input that takes a whole material, and its output that gives one: for graphs used as nodes. */
export const MATERIAL_INPUT_NODE_TYPE = 'materialInput';
export const MATERIAL_OUTPUT_NODE_TYPE = 'materialOutput';

/**
 * A sub-graph node's own random seed and whether each copy varies, kept under names no graph
 * parameter can have (parameter names are letters, digits and underscores).
 */
export const SUBGRAPH_SEED_KEY = '$seed';
export const SUBGRAPH_VARY_KEY = '$vary';

/** Nodes that read the model's mesh maps (`mesh:...` images) when nothing is wired in their place. */
export const MESH_READING_NODE_TYPES: ReadonlySet<string> = new Set([
    MESH_MAP_NODE_TYPE, 'triplanar', 'directionMask', 'axisGradient', 'blendMeshNormals', 'noise3d',
    // The weathering nodes (nodes/weathering.ts, which reads this file, so they are named here).
    'edgeWear', 'damage', 'notches', 'meshDirt', 'clothWear', 'leatherWear', 'metalWear', 'meshDust', 'grease', 'meshLeaks', 'drippingRust', 'sunBleach', 'maskBuilder',
]);

/**
 * Roughly how many samples each pixel of hand-written code takes: its reads of inputs and noise
 * functions, times the loops round them (a loop's bound when it is written as a number, else 32).
 * Heavy code is then drawn in bands across frames, like the other heavy nodes, instead of in one
 * draw long enough at 4K or 8K for the system to reset the GPU.
 */
export const pixelProcessorCost = (code: string): number => {
    const reads = (code.match(/\b(?:c_[abcd]|g_[abcd]|texture|texelFetch|texelWrap)\s*\(/g) ?? []).length;
    const noises = (code.match(/\b(?:perlin|valueNoise)\s*\(/g) ?? []).length * 6 + (code.match(/\bworley\s*\(/g) ?? []).length * 40;
    let loops = 1;
    for (const match of code.matchAll(/\b(?:for|while)\s*\(([^)]*)\)/g)) {
        const bound = /<=?\s*(\d+)/.exec(match[1]);
        loops = Math.min(4096, loops * Math.min(256, Math.max(2, bound ? Number(bound[1]) : 32)));
    }
    return Math.min(1024, Math.max(16, (reads + noises + 4) * loops));
};

/** Maps baked from a model, as texture graphs read them (see texturing/bake). */
export const MESH_MAPS = ['ambientOcclusion', 'curvature', 'normal', 'worldNormal', 'position', 'thickness', 'id', 'height'] as const;
export type MeshMapName = typeof MESH_MAPS[number];
export const MESH_MAP_LABELS: Record<MeshMapName, string> = {
    ambientOcclusion: 'Ambient occlusion', curvature: 'Curvature', normal: 'Normal (tangent space)', worldNormal: 'Normal (world space)',
    position: 'Position', thickness: 'Thickness', id: 'ID colours', height: 'Height',
};
export const MESH_MAP_KIND: Record<MeshMapName, PortKind> = {
    ambientOcclusion: 'gray', curvature: 'gray', normal: 'color', worldNormal: 'color', position: 'color', thickness: 'gray', id: 'color', height: 'gray',
};

/**
 * Maps a bake can keep besides those, when asked for in its settings (texturing/bake's EXTRA_MAPS, by
 * the same names): cavity, bent normals, and colour, opacity and materials carried over from a
 * high-poly model. Mesh map nodes read them the same way, under the same kind of key.
 */
export const EXTRA_MESH_MAPS = ['cavity', 'bentNormal', 'color', 'opacity', 'material'] as const;
export type ExtraMeshMapName = typeof EXTRA_MESH_MAPS[number];
/** Every map a Mesh map node can read. */
export const ALL_MESH_MAPS: readonly AnyMeshMapName[] = [...MESH_MAPS, ...EXTRA_MESH_MAPS];
export type AnyMeshMapName = MeshMapName | ExtraMeshMapName;
export const ANY_MESH_MAP_LABELS: Record<AnyMeshMapName, string> = {
    ...MESH_MAP_LABELS,
    cavity: 'Cavity', bentNormal: 'Bent normal', color: 'Colour from the high-poly model', opacity: 'Opacity from the high-poly model', material: 'Materials from the high-poly model',
};
export const ANY_MESH_MAP_KIND: Record<AnyMeshMapName, PortKind> = {
    ...MESH_MAP_KIND, cavity: 'gray', bentNormal: 'color', color: 'color', opacity: 'gray', material: 'color',
};
const isMeshMap = (value: unknown): value is AnyMeshMapName => (ALL_MESH_MAPS as readonly unknown[]).includes(value);

/** What a mesh map reads as when no model is there to bake it from (or the bake did not keep it). */
const MESH_MAP_STAND_IN: Record<AnyMeshMapName, string> = {
    ambientOcclusion: 'vec4(1.0)', curvature: 'vec4(0.5)', normal: 'vec4(0.5, 0.5, 1.0, 1.0)', worldNormal: 'vec4(0.5, 1.0, 0.5, 1.0)',
    position: 'vec4(vUv, 0.5, 1.0)', thickness: 'vec4(0.5)', id: 'vec4(0.0, 0.0, 0.0, 1.0)', height: 'vec4(0.5)',
    cavity: 'vec4(0.5)', bentNormal: 'vec4(0.5, 0.5, 1.0, 1.0)', color: 'vec4(0.5, 0.5, 0.5, 1.0)', opacity: 'vec4(1.0)', material: 'vec4(0.0, 0.0, 0.0, 1.0)',
};

export const meshMapKey = (name: AnyMeshMapName): string => `mesh:${name}`;

/** An image of the node's size and `kind` holding `source` (an image or a project texture). */
const imageFrom = async (context: NodeRunContext, source: GpuImage | THREE.Texture, kind: PortKind): Promise<GpuImage> => {
    const asImage = source as GpuImage;
    if (asImage.target && asImage.kind === kind && asImage.width === context.width && asImage.height === context.height) return context.gpu.retain(asImage);
    const image = context.image(kind);
    const gray = asImage.target ? asImage.kind === 'gray' : false;
    // Colour into grey keeps its brightness, not just its red.
    await context.gpu.pass(image, {
        fragment: gray ? 'void main() { float v = texture(source, vUv).r; outColor = vec4(v, v, v, 1.0); }'
            : kind === 'gray' ? 'void main() { vec4 c = texture(source, vUv); outColor = vec4(vec3(luma(c.rgb)), c.a); }'
                : 'void main() { outColor = texture(source, vUv); }',
        inputs: { source },
    });
    return image;
};

/** A Bitmap's crop as corner and size (parts of the picture), kept inside the picture. */
export const bitmapCrop = (from: unknown, size: unknown): [number, number, number, number] => {
    const corner = Array.isArray(from) ? from.map(Number) : [0, 0];
    const extent = Array.isArray(size) ? size.map(Number) : [1, 1];
    const x = Math.min(0.999, Math.max(0, corner[0] || 0));
    const y = Math.min(0.999, Math.max(0, corner[1] || 0));
    return [x, y, Math.min(1 - x, Math.max(0.001, extent[0] || 1)), Math.min(1 - y, Math.max(0.001, extent[1] || 1))];
};

/**
 * How much of the cropped picture a step across the node spans, each way: 1 each for stretching; for
 * fitting inside, the picture's long side fills the node and the rest is see-through; for filling,
 * its short side fills the node and the rest is cut. `aspect` is the cropped picture's width over its
 * height, `nodeAspect` the node's.
 */
export const bitmapScale = (fit: string, aspect: number, nodeAspect: number): [number, number] => {
    if (fit !== 'fit' && fit !== 'fill' || !(aspect > 0) || !(nodeAspect > 0)) return [1, 1];
    const wider = aspect > nodeAspect;
    if (fit === 'fit') return wider ? [1, aspect / nodeAspect] : [nodeAspect / aspect, 1];
    return wider ? [nodeAspect / aspect, 1] : [1, aspect / nodeAspect];
};

/** A world space normal or position: wired in, else the model's own map, else a stand-in. */
const meshInput = (context: NodeRunContext, key: string, map: MeshMapName): GpuImage | THREE.Texture | null => context.input(key) ?? context.external(meshMapKey(map));

/**
 * The lowest and highest value of one axis (0, 1, 2 for x, y, z) of a position image, in the red and
 * green of a 1×1 image: halved two by two on the GPU until one texel is left. A baked position map is
 * padded past its islands with their own values, so the empty space adds nothing outside the model.
 */
const axisRange = async (context: NodeRunContext, source: GpuImage | THREE.Texture, axis: number): Promise<GpuImage> => {
    const gpu = context.gpu;
    const asImage = source as GpuImage;
    const picture = (source as THREE.Texture).image as { width?: number; height?: number } | undefined;
    const width = asImage.target ? asImage.width : Math.max(1, picture?.width ?? 1);
    const height = asImage.target ? asImage.height : Math.max(1, picture?.height ?? 1);
    const gather = (first: boolean) => `uniform int uAxis;
float pick(vec4 v) { return uAxis == 0 ? v.x : uAxis == 1 ? v.y : v.z; }
vec2 span(ivec2 at, ivec2 last) { vec4 v = texelFetch(source, min(at, last), 0); return ${first ? 'vec2(pick(v))' : 'v.rg'}; }
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy) * 2;
    ivec2 last = textureSize(source, 0) - 1;
    vec2 a = span(p, last), b = span(p + ivec2(1, 0), last), c = span(p + ivec2(0, 1), last), d = span(p + ivec2(1, 1), last);
    outColor = vec4(min(min(a.x, b.x), min(c.x, d.x)), max(max(a.y, b.y), max(c.y, d.y)), 0.0, 1.0);
}`;
    let range = gpu.image((width + 1) >> 1 || 1, (height + 1) >> 1 || 1, 'color', 32);
    await gpu.pass(range, { fragment: gather(true), inputs: { source }, uniforms: { uAxis: axis } });
    while (range.width > 1 || range.height > 1) {
        const next = gpu.image(Math.max(1, (range.width + 1) >> 1), Math.max(1, (range.height + 1) >> 1), 'color', 32);
        await gpu.pass(next, { fragment: gather(false), inputs: { source: range }, uniforms: { uAxis: axis } });
        gpu.release(range);
        range = next;
    }
    return range;
};

const DEFAULT_LOOKS: ReadonlyArray<[string, string]> = [['black', 'Black'], ['white', 'White'], ['mid', 'Mid grey'], ['normal', 'Flat normal']];

/** A named link's end: what comes in goes out as it is (black when nothing does). */
const passOn = async (context: NodeRunContext): Promise<Record<string, GpuImage>> => {
    const input = context.input('in');
    if (input) return { out: context.gpu.retain(input) };
    const image = context.image(context.outputKind('out'));
    context.gpu.clear(image, [0, 0, 0, 1]);
    return { out: image };
};

export const IO_NODES: TexNodeDef[] = [
    {
        type: INPUT_NODE_TYPE,
        label: 'Graph input',
        category: 'Inputs and outputs',
        description: 'An image the graph takes in when it is used inside another graph or on a model.',
        keywords: ['input', 'parameter image', 'socket'],
        inputs: [],
        outputs: [out('any')],
        params: [
            { key: 'name', label: 'Name', kind: 'string', default: 'input' },
            select('kind', 'Kind', 'color', [['color', 'Colour'], ['gray', 'Grey']]),
            select('fallback', 'Without one', 'black', DEFAULT_LOOKS),
            { key: 'visibleIf', label: 'Shown when', kind: 'string', default: '', hint: 'On a node using this graph, its pin shows only while this formula of the graph\'s parameters holds ("mode == 1"); empty: always.' },
        ],
        sizeFrom: 'graph',
        kindOf: (params) => (params.kind === 'gray' ? 'gray' : 'color'),
        async run(context) {
            const kind = context.outputKind('out');
            const given = context.external(String(context.params.name || 'input'));
            if (given) return { out: await imageFrom(context, given, kind) };
            const fallback = context.params.fallback;
            const value = fallback === 'white' ? 'vec4(1.0)' : fallback === 'mid' ? 'vec4(0.5, 0.5, 0.5, 1.0)' : fallback === 'normal' ? 'vec4(0.5, 0.5, 1.0, 1.0)' : 'vec4(0.0, 0.0, 0.0, 1.0)';
            const image = context.image(kind);
            await context.gpu.pass(image, { fragment: `void main() { outColor = ${value}; }` });
            return { out: image };
        },
    },
    {
        type: OUTPUT_NODE_TYPE,
        label: 'Output',
        category: 'Inputs and outputs',
        description: 'One of the images the graph gives: a channel of the material (base colour, normal, roughness...) or a named image for another graph. Wire a whole material into it and it keeps its own channel of it.',
        keywords: ['output', 'result', 'channel', 'base colour', 'roughness', 'metallic', 'normal'],
        inputs: [{ ...anyIn('in', 'Image or material'), material: true }],
        outputs: [],
        params: [
            select('channel', 'Channel', 'baseColor', OUTPUT_CHANNELS.map((channel) => [channel, OUTPUT_CHANNEL_LABELS[channel]] as [string, string])),
            { key: 'name', label: 'Name', kind: 'string', default: '' },
            select('kind', 'Kind', 'color', [['color', 'Colour'], ['gray', 'Grey']], {
                showIf: (params) => params.channel === 'custom',
                hint: 'What the image is: grey for masks and heights, so graphs using this one get a grey pin.',
            }),
            { key: 'visibleIf', label: 'Shown when', kind: 'string', default: '', hint: 'On a node using this graph, its pin shows only while this formula of the graph\'s parameters holds ("mode == 1"); empty: always.' },
        ],
        sizeFrom: 'input',
        async run(context) {
            const channel = (OUTPUT_CHANNELS as readonly string[]).includes(String(context.params.channel)) ? context.params.channel as OutputChannel : 'custom';
            const kind = outputNodeKind(context.params);
            // A material wired in: its channel for this output (a named image takes its base colour, or height when grey).
            const material = context.material('in');
            const kept = material ? outputChannelOf(channel, kind) : null;
            const input = kept ? material?.[kept] ?? null : context.input('in');
            if (!input && kept) {
                const image = context.image(kind);
                context.gpu.clear(image, MATERIAL_DEFAULTS[kept]);
                return { out: image };
            }
            if (!input) {
                const image = context.image(kind);
                const value = channel === 'normal' ? [0.5, 0.5, 1, 1] : channel === 'roughness' ? [0.5, 0.5, 0.5, 1] : channel === 'ambientOcclusion' || channel === 'opacity' ? [1, 1, 1, 1] : channel === 'height' ? [0.5, 0.5, 0.5, 1] : [0, 0, 0, 1];
                context.gpu.clear(image, value as [number, number, number, number]);
                return { out: image };
            }
            return { out: await imageFrom(context, input, kind) };
        },
    },
    {
        type: MESH_MAP_NODE_TYPE,
        label: 'Mesh map',
        category: 'Mesh maps',
        description: 'A map baked from the model being painted: occlusion, curvature, normals, position, thickness or IDs, and when the bake kept them, cavity, bent normals, and colour, opacity and materials carried over from a high-poly model. Smart masks and materials are built on these.',
        keywords: ['baked', 'ao', 'curvature', 'world normal', 'position', 'thickness', 'id', 'mesh', 'cavity', 'bent normal', 'high poly', 'transfer'],
        inputs: [],
        outputs: [out('any')],
        params: [select('map', 'Map', 'ambientOcclusion', ALL_MESH_MAPS.map((name) => [name, ANY_MESH_MAP_LABELS[name]] as [string, string]))],
        sizeFrom: 'graph',
        kindOf: (params) => ANY_MESH_MAP_KIND[isMeshMap(params.map) ? params.map : 'ambientOcclusion'],
        async run(context) {
            const name: AnyMeshMapName = isMeshMap(context.params.map) ? context.params.map : 'ambientOcclusion';
            const kind = ANY_MESH_MAP_KIND[name];
            const baked = context.external(meshMapKey(name));
            if (baked) return { out: await imageFrom(context, baked, kind) };
            const image = context.image(kind);
            await context.gpu.pass(image, { fragment: `void main() { outColor = ${MESH_MAP_STAND_IN[name]}; }` });
            return { out: image };
        },
    },
    {
        type: 'bitmap',
        label: 'Bitmap',
        category: 'Inputs and outputs',
        description: 'A picture from the project\'s texture library, cropped and fitted to the node. 16-bit and floating-point pictures are read at their depth, and the node keeps it.',
        keywords: ['image', 'texture', 'photo', 'picture', 'file', 'exr', 'height map', 'crop'],
        inputs: [],
        outputs: [out('color')],
        params: [
            { key: 'texture', label: 'Picture', kind: 'texture', default: '' },
            select('colour', 'Colours', 'stored', [['stored', 'As the file holds them'], ['toLinear', 'sRGB file, read linear'], ['toSrgb', 'Linear file, read as sRGB']], {
                hint: 'Most colour pictures hold sRGB, which graphs work in as it is. Turn it linear for maths that needs light values, or turn a linear file (an EXR colour) to sRGB.',
            }),
            vec2('cropFrom', 'Crop corner (from the top left)', [0, 0], 0, 1),
            vec2('cropSize', 'Crop size', [1, 1], 0.001, 1),
            select('fit', 'Fitting', 'stretch', [['stretch', 'Stretch to the node'], ['fit', 'Fit inside (see-through around)'], ['fill', 'Fill (cut to fit)']]),
        ],
        sizeFrom: 'graph',
        precisionOf: (params, texture) => {
            const picture = typeof params.texture === 'string' && params.texture ? texture(params.texture) : null;
            const depth = Number(picture?.userData?.auvraDepth) || 8;
            return depth >= 32 ? 32 : depth >= 16 ? 16 : undefined;
        },
        async run(context) {
            const image = context.image('color');
            const id = typeof context.params.texture === 'string' ? context.params.texture : '';
            const picture = id ? context.texture(id) : null;
            const source = picture?.image as { width?: number; height?: number } | undefined;
            const crop = bitmapCrop(context.params.cropFrom, context.params.cropSize);
            const aspect = source?.width && source.height ? (source.width * crop[2]) / (source.height * crop[3]) : 1;
            const scale = bitmapScale(String(context.params.fit), aspect, context.width / context.height);
            const colour = context.params.colour === 'toLinear' ? 1 : context.params.colour === 'toSrgb' ? 2 : 0;
            await context.pass(image, `uniform vec2 uScale;
uniform vec4 uCrop;
uniform int uColour;
void main() {
    if (p_texture_ok == 0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    // Where on the cropped picture this pixel is, as it is fitted to the node.
    vec2 q = (vUv - 0.5) * uScale + 0.5;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { outColor = vec4(0.0); return; }
    vec4 c = texture(p_texture, uCrop.xy + q * uCrop.zw);
    if (p_texture_srgb == 1) c.rgb = linearToSrgb(c.rgb);
    if (uColour == 1) c.rgb = srgbToLinear(c.rgb); else if (uColour == 2) c.rgb = linearToSrgb(c.rgb);
    outColor = c;
}`, { uniforms: { uScale: new THREE.Vector2(scale[0], scale[1]), uCrop: new THREE.Vector4(...crop), uColour: colour } });
            return { out: image };
        },
    },
    {
        type: MATERIAL_INPUT_NODE_TYPE,
        label: 'Graph input: material',
        category: 'Inputs and outputs',
        description: 'A whole material the graph takes in when it is used inside another graph (a material wire into its node).',
        keywords: ['input', 'material input', 'socket', 'sub-graph'],
        inputs: [],
        outputs: [{ key: 'out', label: 'Material', kind: 'material' }],
        params: [{ key: 'name', label: 'Name', kind: 'string', default: 'material' }, { key: 'visibleIf', label: 'Shown when', kind: 'string', default: '', hint: 'On a node using this graph, its pin shows only while this formula of the graph\'s parameters holds ("mode == 1"); empty: always.' }],
        sizeFrom: 'graph',
        async run(context) {
            const name = String(context.params.name || 'material');
            const given: MaterialImages = {};
            for (const channel of MATERIAL_CHANNELS) {
                const image = context.external(materialKey(name, channel));
                if (image) given[channel] = await imageFrom(context, image, (image as GpuImage).kind ?? 'color');
            }
            return materialResults('out', given);
        },
    },
    {
        type: MATERIAL_OUTPUT_NODE_TYPE,
        label: 'Output: whole material',
        category: 'Inputs and outputs',
        description: 'A whole material the graph gives when it is used inside another graph: its node gets a material pin.',
        keywords: ['output', 'material output', 'sub-graph', 'result'],
        inputs: [{ key: 'in', label: 'Material', kind: 'material' }],
        outputs: [],
        params: [{ key: 'name', label: 'Name', kind: 'string', default: '' }, { key: 'visibleIf', label: 'Shown when', kind: 'string', default: '', hint: 'On a node using this graph, its pin shows only while this formula of the graph\'s parameters holds ("mode == 1"); empty: always.' }],
        sizeFrom: 'input',
        async run(context) {
            const material = context.material('in');
            const kept: MaterialImages = {};
            for (const channel of MATERIAL_CHANNELS) { const image = material?.[channel]; if (image) kept[channel] = context.gpu.retain(image); }
            return materialResults('out', kept);
        },
    },
    {
        type: NAMED_SEND_TYPE,
        label: 'Named link: send',
        category: 'Utility',
        description: 'Sends what is wired into it under a name: every Named link: receive of that name gives it out, however far away, with no wire across the graph.',
        keywords: ['send', 'named link', 'portal', 'wireless', 'jump', 'teleport', 'pass'],
        inputs: [anyIn('in', 'In')],
        outputs: [{ ...out('any'), hidden: true }],
        params: [{ key: 'name', label: 'Name', kind: 'string', default: 'link' }],
        sizeFrom: 'input',
        kindFrom: 'in',
        bypass: false,
        run: passOn,
    },
    {
        type: NAMED_RECEIVE_TYPE,
        label: 'Named link: receive',
        category: 'Utility',
        description: 'Gives out what the Named link: send of the same name takes in.',
        keywords: ['receive', 'named link', 'portal', 'wireless', 'jump', 'teleport', 'get'],
        inputs: [{ ...anyIn('in', 'In'), hidden: true }],
        outputs: [out('any')],
        params: [{ key: 'name', label: 'Name', kind: 'string', default: 'link' }],
        sizeFrom: 'input',
        kindFrom: 'in',
        bypass: false,
        run: passOn,
    },
    {
        type: REROUTE_NODE_TYPE,
        label: 'Reroute point',
        category: 'Utility',
        description: 'A point a wire passes through, to lead it round other nodes. It changes nothing.',
        keywords: ['reroute', 'dot', 'elbow', 'wire point', 'knot'],
        inputs: [anyIn('in', 'In')],
        outputs: [out('any')],
        params: [],
        sizeFrom: 'input',
        kindFrom: 'in',
        async run(context) {
            const input = context.input('in');
            if (input) return { out: context.gpu.retain(input) };
            const image = context.image(context.outputKind('out'));
            context.gpu.clear(image, [0, 0, 0, 1]);
            return { out: image };
        },
    },
    onePass({
        type: 'uniformColor',
        label: 'Colour',
        category: 'Utility',
        description: 'One colour everywhere.',
        keywords: ['uniform', 'solid', 'constant', 'fill', 'flat colour'],
        inputs: [],
        outputs: [out('color')],
        params: [color('color', 'Colour', [0.5, 0.5, 0.5, 1])],
        sizeFrom: 'graph',
        glsl: 'void main() { outColor = p_color; }',
    }),
    onePass({
        type: 'uniformValue',
        label: 'Value',
        category: 'Utility',
        description: 'One grey value everywhere.',
        keywords: ['uniform', 'constant', 'grey', 'number'],
        inputs: [],
        outputs: [out('gray')],
        params: [float('value', 'Value', 0.5, 0, 1)],
        sizeFrom: 'graph',
        glsl: 'void main() { outColor = vec4(p_value); }',
    }),
    {
        type: 'triplanar',
        label: 'Triplanar projection',
        category: 'Mesh maps',
        description: 'Lays a tiling pattern onto the model from three sides at once, so it has no UV seams or stretching. Uses the model\'s position and world normal maps.',
        keywords: ['triplanar', 'box projection', 'seamless', 'project'],
        inputs: [anyIn('pattern', 'Pattern'), colorIn('position', 'Position'), colorIn('normal', 'World normal')],
        outputs: [out('any')],
        params: [float('scale', 'Scale', 4, 0.05, 100, { softMax: 30 }), float('sharpness', 'Blend sharpness', 4, 1, 32), float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 })],
        sizeFrom: 'graph',
        kindFrom: 'pattern',
        anyDefault: 'gray',
        async run(context) {
            const image = context.image(context.outputKind('out'));
            const position = meshInput(context, 'position', 'position');
            const normal = meshInput(context, 'normal', 'worldNormal');
            await context.pass(image, `uniform sampler2D posMap;\nuniform sampler2D norMap;\nuniform int hasPos;\nuniform int hasNor;
void main() {
    vec3 p = hasPos == 1 ? texture(posMap, vUv).xyz : vec3(vUv, 0.5);
    vec3 n = hasNor == 1 ? normalize(texture(norMap, vUv).xyz * 2.0 - 1.0) : vec3(0.0, 0.0, 1.0);
    vec3 w = pow(abs(n), vec3(p_sharpness));
    w /= max(w.x + w.y + w.z, 1e-5);
    mat2 r = rotate2(radians(p_rotation));
    vec3 q = p * p_scale;
    vec4 x = c_pattern(fract(r * q.zy));
    vec4 y = c_pattern(fract(r * q.xz));
    vec4 z = c_pattern(fract(r * q.xy));
    outColor = x * w.x + y * w.y + z * w.z;
}`, { inputs: { posMap: position ?? context.gpu.constant('black'), norMap: normal ?? context.gpu.constant('normal') }, uniforms: { hasPos: position ? 1 : 0, hasNor: normal ? 1 : 0 } });
            return { out: image };
        },
    },
    {
        type: 'directionMask',
        label: 'Direction mask',
        category: 'Mesh maps',
        description: 'White where the surface faces a direction: up for dust and snow, down for grime, any way for light from one side.',
        keywords: ['world normal', 'facing', 'dust', 'snow', 'top', 'slope mask'],
        inputs: [colorIn('normal', 'World normal')],
        outputs: [out('gray')],
        params: [select('direction', 'Facing', 'up', [['up', 'Up'], ['down', 'Down'], ['x', 'Right'], ['-x', 'Left'], ['z', 'Front'], ['-z', 'Back'], ['custom', 'Another way']]), vec2('angles', 'Turn and tilt (degrees)', [0, 45], -180, 180, { showIf: (p) => p.direction === 'custom' }), float('spread', 'Spread', 0.5, 0, 1), float('contrast', 'Contrast', 0.5, 0, 1)],
        sizeFrom: 'graph',
        async run(context) {
            const image = context.image('gray');
            const normal = meshInput(context, 'normal', 'worldNormal');
            const angles = (Array.isArray(context.params.angles) ? context.params.angles : [0, 45]) as number[];
            const yaw = (angles[0] * Math.PI) / 180;
            const pitch = (angles[1] * Math.PI) / 180;
            const preset: Record<string, [number, number, number]> = { up: [0, 1, 0], down: [0, -1, 0], x: [1, 0, 0], '-x': [-1, 0, 0], z: [0, 0, 1], '-z': [0, 0, -1] };
            const direction = preset[String(context.params.direction)] ?? [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
            await context.pass(image, `uniform sampler2D norMap;\nuniform vec3 uDirection;
void main() {
    vec3 n = normalize(texture(norMap, vUv).xyz * 2.0 - 1.0);
    float d = dot(n, normalize(uDirection));
    float lo = mix(0.95, -0.95, p_spread);
    float width = mix(0.6, 0.01, p_contrast);
    outColor = vec4(smoothstep(lo - width * 0.5, lo + width * 0.5, d));
}`, { inputs: { norMap: normal ?? context.gpu.constant('normal') }, uniforms: { uDirection: new THREE.Vector3(direction[0], direction[1], direction[2]) } });
            return { out: image };
        },
    },
    {
        type: 'axisGradient',
        label: 'Position gradient',
        category: 'Mesh maps',
        description: 'A gradient up (or across) the model from its position map, from the model\'s lowest point to its highest along the way chosen: grime gathering low down, fading paint, wet edges.',
        keywords: ['height gradient', 'world position', 'bottom up', 'top down'],
        inputs: [colorIn('position', 'Position')],
        outputs: [out('gray')],
        params: [select('axis', 'Along', 'y', [['x', 'Across (X)'], ['y', 'Up (Y)'], ['z', 'Front to back (Z)']]), float('position', 'Position', 0.5, 0, 1), float('width', 'Fade width', 0.3, 0.001, 1), select('invert', 'White at', 'bottom', [['bottom', 'The low end'], ['top', 'The high end']])],
        sizeFrom: 'graph',
        async run(context) {
            const image = context.image('gray');
            const position = meshInput(context, 'position', 'position');
            // Position is measured in one cube round the whole model, so a model's shorter sides fill only
            // part of 0..1: the gradient runs from the lowest to the highest place along the axis instead.
            const axis = context.params.axis === 'x' ? 0 : context.params.axis === 'z' ? 2 : 1;
            const range = position ? await axisRange(context, position, axis) : null;
            try {
                await context.pass(image, `uniform sampler2D posMap;
uniform sampler2D rangeMap;
uniform int uNormalise;
void main() {
    vec3 p = texture(posMap, vUv).xyz;
    float v = p_axis == 0 ? p.x : p_axis == 1 ? p.y : p.z;
    if (uNormalise == 1) {
        vec2 span = texelFetch(rangeMap, ivec2(0), 0).rg;
        v = span.y - span.x > 1e-6 ? (v - span.x) / (span.y - span.x) : 0.5;
    }
    float t = smoothstep(p_position - p_width * 0.5, p_position + p_width * 0.5, v);
    outColor = vec4(p_invert == 0 ? 1.0 - t : t);
}`, { inputs: { posMap: position ?? context.gpu.constant('mid'), rangeMap: range ?? context.gpu.constant('black') }, uniforms: { uNormalise: range ? 1 : 0 } });
            } finally {
                context.gpu.release(range);
            }
            return { out: image };
        },
    },
    {
        type: 'blendMeshNormals',
        label: 'Normal with mesh detail',
        category: 'Mesh maps',
        description: 'The model\'s baked normal map with a detail normal map laid over it, as the final normal of a painted model.',
        keywords: ['baked normal', 'combine', 'mesh normal'],
        inputs: [colorIn('detail', 'Detail normal', 'normal')],
        outputs: [out('color')],
        params: [float('strength', 'Detail strength', 1, 0, 2)],
        sizeFrom: 'graph',
        preview: 'normal',
        async run(context) {
            const image = context.image('color');
            const baked = context.external(meshMapKey('normal'));
            await context.pass(image, `uniform sampler2D baseMap;
void main() {
    vec3 a = texture(baseMap, vUv).xyz * 2.0 - 1.0;
    vec3 b = c_detail(vUv).xyz * 2.0 - 1.0;
    b.xy *= p_strength;
    vec3 t = a + vec3(0.0, 0.0, 1.0);
    vec3 u = normalize(b) * vec3(-1.0, -1.0, 1.0);
    outColor = vec4(normalize(t * dot(t, u) / max(t.z, 1e-4) - u) * 0.5 + 0.5, 1.0);
}`, { inputs: { baseMap: baked ?? context.gpu.constant('normal') } });
            return { out: image };
        },
    },
];

/**
 * The settings a sub-graph node shows: the graph's own exposed parameters, under their groups, with
 * their words, ranges and steps, each shown only while its condition holds for the node's values.
 */
export const subgraphParamDefs = (parameters: readonly GraphParameter[]): TexParamDef[] => parameters.map((parameter) => parameterSetting(parameter, parameters));

