import * as THREE from 'three';
import type { GpuImage, PassInput } from '../../gpu/textureGpu';
import {
    PLACE_WIDTH, SCATTER_PROFILES, SCATTER_SHAPES, SCATTER_VARYINGS, SCATTER_VERTEX, SHAPE_GLSL, STACK_CHOICES, densityPoints, packCopies, picturePoints, poissonDisc,
    randomSource, type Point2, type ScatterCopy, type StackChoice,
} from '../scatter';
import { anyIn, bool, colorIn, float, grayIn, int, out, select, seed, vec2 } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';

/**
 * SCATTER NODES
 *
 * Tile sampler (a grid of copies whose size, turn, place, mask, colour and pattern can each follow a
 * map, up to six patterns, mirrored at random), Shape scatter (copies placed as a Poisson disc, by a
 * density map or where a picture is white, never overlapping if asked, with a 3D turn), Tile
 * generator (a plain grid of shapes or a pattern) and Atlas scatter (copies of the pictures in a grid
 * of them). All draw their copies in one instanced pass (scatter.ts), and give each pixel its copy's
 * ID, random value and local UV.
 */

const MAX_COPIES = 20000;
const PATTERN_KEYS = ['pattern', 'pattern2', 'pattern3', 'pattern4', 'pattern5', 'pattern6'] as const;

type Source =
    | { kind: 'shapes'; shape: number; profile: number; bevel: number }
    | { kind: 'patterns'; images: GpuImage[] }
    | { kind: 'atlas'; image: GpuImage; columns: number; rows: number };

/** GLSL giving a copy's colour and height at its local point, from its pattern number. */
const sourceGlsl = (source: Source): string => {
    if (source.kind === 'shapes') {
        return `${SHAPE_GLSL}
uniform int uShape;
uniform int uProfile;
uniform float uBevel;
vec4 copyColour(int pattern, vec2 local) { return vec4(vec3(builtInShape(uShape, local * 2.0 - 1.0, uProfile, uBevel)), 1.0); }
float copyHeight(int pattern, vec2 local) { return copyColour(pattern, local).r; }`;
    }
    if (source.kind === 'atlas') {
        return `uniform ivec2 uAtlas;
uniform int uAtlasGray;
vec4 copyColour(int pattern, vec2 local) {
    // Cells counted from the top left, as the grid is read.
    vec2 cell = vec2(float(pattern % uAtlas.x), float(uAtlas.y - 1 - pattern / uAtlas.x));
    vec4 v = texture(atlas, (cell + clamp(local, 0.002, 0.998)) / vec2(uAtlas));
    return uAtlasGray == 1 ? vec4(v.rrr, 1.0) : v;
}
float copyHeight(int pattern, vec2 local) { vec4 v = copyColour(pattern, local); return luma(v.rgb) * v.a; }`;
    }
    const reads = source.images.map((_, index) => `${index ? 'else ' : ''}if (pattern == ${index}) v = texture(pat${index}, at);`).join('\n    ');
    return `uniform int uGray[6];
vec4 copyColour(int pattern, vec2 local) {
    vec2 at = clamp(local, 0.0, 1.0);
    vec4 v = texture(pat0, at);
    ${reads}
    return uGray[clamp(pattern, 0, 5)] == 1 ? vec4(v.rrr, 1.0) : v;
}
float copyHeight(int pattern, vec2 local) { vec4 v = copyColour(pattern, local); return luma(v.rgb) * v.a; }`;
};

const sourceInputs = (source: Source): Record<string, PassInput> => {
    if (source.kind === 'patterns') return Object.fromEntries(source.images.map((image, index) => [`pat${index}`, image]));
    if (source.kind === 'atlas') return { atlas: source.image };
    return {};
};

const sourceUniforms = (source: Source): Record<string, unknown> => {
    if (source.kind === 'patterns') return { uGray: Array.from({ length: 6 }, (_, index) => (source.images[index]?.kind === 'gray' ? 1 : 0)) };
    if (source.kind === 'atlas') return { uAtlas: [Math.max(1, source.columns), Math.max(1, source.rows)], uAtlasGray: source.image.kind === 'gray' ? 1 : 0 };
    return { uShape: source.shape, uProfile: source.profile, uBevel: source.bevel };
};

/** The drawing pass's fragment for the winners: each pixel's copy, its local point and its height. */
const WINNER = `void main() {
    float v = copyHeight(vPattern, vLocal) * vBright;
    if (v <= 0.0005) discard;
    float h = saturate(v + vLift);
    gl_FragDepth = 1.0 - h * 0.999;
    outColor = vec4(float(vCopy) + 1.0, vLocal, h);
}`;

/** The drawing pass's fragment when copies are the brightest or add up: the value itself. */
const VALUE = `uniform int uColour;
uniform int uHasColourMap;
void main() {
    vec4 c = copyColour(vPattern, vLocal);
    float h = luma(c.rgb) * c.a;
    if (h <= 0.0005) discard;
    vec3 tint = uHasColourMap == 1 ? texture(colourMap, fract(vCentre)).rgb : vec3(1.0);
    outColor = uColour == 1 ? vec4(c.rgb * vBright * tint, c.a) : vec4(vec3(saturate(h * vBright + vLift)), 1.0);
}`;

/** A pixel's result from its winning copy: its colour (or height), ID colour, random value or local UV. */
const RESOLVE = `uniform int uPlaceWidth;
uniform int uWhat;
uniform int uColour;
uniform int uHasColourMap;
uniform float uSeed;
void main() {
    vec4 w = texelFetch(winners, ivec2(gl_FragCoord.xy), 0);
    int copy = int(w.x + 0.5) - 1;
    if (copy < 0) { outColor = uWhat == 0 && uColour == 1 ? vec4(0.0) : vec4(0.0, 0.0, 0.0, 1.0); return; }
    ivec2 at = ivec2(copy % uPlaceWidth, copy / uPlaceWidth);
    vec4 a = texelFetch(place0, at, 0);
    vec4 b = texelFetch(place1, at, 0);
    vec4 c = texelFetch(place2, at, 0);
    if (uWhat == 1) { outColor = vec4(hash3(ivec2(copy, 7), uSeed + 9.0), 1.0); return; }
    if (uWhat == 2) { outColor = vec4(vec3(b.z), 1.0); return; }
    if (uWhat == 3) { outColor = vec4(w.yz, 0.0, 1.0); return; }
    if (uColour == 0) { outColor = vec4(vec3(w.w), 1.0); return; }
    vec4 v = copyColour(int(b.y + 0.5), w.yz);
    vec3 tint = uHasColourMap == 1 ? texture(colourMap, fract(a.xy)).rgb : vec3(1.0);
    outColor = vec4(v.rgb * c.z * tint, v.a);
}`;

interface Placement { textures: [PassInput, PassInput, PassInput]; width: number; count: number }

/** Draws placed copies; gives the composite and each pixel's copy ID colour, random value and local UV. */
const drawScatter = async (context: NodeRunContext, placement: Placement, source: Source, stack: StackChoice, colourMap: GpuImage | null): Promise<Record<string, GpuImage>> => {
    const gpu = context.gpu;
    const glsl = sourceGlsl(source);
    const inputs: Record<string, PassInput> = { place0: placement.textures[0], place1: placement.textures[1], place2: placement.textures[2], ...sourceInputs(source) };
    const uniforms: Record<string, unknown> = { uPlaceWidth: placement.width, ...sourceUniforms(source) };
    const wrap: [boolean, boolean] = [context.tiling[0], context.tiling[1]];
    const winners = context.image('color', context.width, context.height, 32);
    await gpu.drawInstances(winners, { count: placement.count, varyings: SCATTER_VARYINGS, vertex: SCATTER_VERTEX, fragment: `${glsl}\n${WINNER}`, inputs, uniforms, stack: stack === 'over' ? 'over' : 'higher', wrap });
    const colour = context.outputKind('out') === 'color';
    const tint = { colourMap: colourMap ?? gpu.constant('white') };
    const result = context.image(context.outputKind('out'));
    const shared = { ...uniforms, uColour: colour ? 1 : 0, uHasColourMap: colourMap ? 1 : 0, uSeed: context.seed };
    if (stack === 'max' || stack === 'add') {
        await gpu.drawInstances(result, { count: placement.count, varyings: SCATTER_VARYINGS, vertex: SCATTER_VERTEX, fragment: `${glsl}\n${VALUE}`, inputs: { ...inputs, ...tint }, uniforms: shared, stack, wrap, clear: [0, 0, 0, colour ? 0 : 1] });
    } else {
        await gpu.pass(result, { fragment: `${glsl}\n${RESOLVE}`, inputs: { winners, ...inputs, ...tint }, uniforms: { ...shared, uWhat: 0 } });
    }
    const follow = async (what: number, kind: 'color' | 'gray', precision: 8 | 16) => {
        const image = context.image(kind, context.width, context.height, precision);
        await gpu.pass(image, { fragment: `${glsl}\n${RESOLVE}`, inputs: { winners, ...inputs, ...tint }, uniforms: { ...shared, uWhat: what } });
        return image;
    };
    return { out: result, id: await follow(1, 'color', 8), random: await follow(2, 'gray', 16), uv: await follow(3, 'color', 16) };
};

/** Copies placed here, as the float textures the drawing pass reads (let go once drawn). */
const uploaded = (copies: readonly ScatterCopy[]): { placement: Placement; dispose: () => void } => {
    const packed = packCopies(copies.slice(0, MAX_COPIES));
    const textures = packed.data.map((data) => {
        const texture = new THREE.DataTexture(data, packed.width, packed.height, THREE.RGBAFormat, THREE.FloatType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        return texture;
    }) as [THREE.DataTexture, THREE.DataTexture, THREE.DataTexture];
    return { placement: { textures, width: packed.width, count: Math.min(copies.length, MAX_COPIES) }, dispose: () => textures.forEach((texture) => texture.dispose()) };
};

/** A picture read small (its red, 0 to 1, the bottom row first), for placing copies by it. */
const readSmall = async (context: NodeRunContext, image: GpuImage | null, size: number): Promise<Float32Array | null> => {
    if (!image) return null;
    const small = context.image('color', size, size, 8);
    await context.gpu.pass(small, { fragment: 'void main() { float v = texture(source, vUv).r; outColor = vec4(v, v, v, 1.0); }', inputs: { source: image } });
    const pixels = await context.gpu.readRgba8Later(small);
    if (!pixels) return null;
    const values = new Float32Array(size * size);
    for (let i = 0; i < values.length; i++) values[i] = pixels[i * 4] / 255;
    return values;
};

const shapeNumber = (value: unknown) => Math.max(0, SCATTER_SHAPES.findIndex(([key]) => key === value));
const profileNumber = (value: unknown) => Math.max(0, SCATTER_PROFILES.findIndex(([key]) => key === value));
const stackOf = (value: unknown): StackChoice => (STACK_CHOICES.some(([key]) => key === value) ? value as StackChoice : 'higher');
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const pair = (value: unknown, fallback: Point2): Point2 => (Array.isArray(value) ? [num(value[0], fallback[0]), num(value[1], fallback[1])] : fallback);

/** The settings every scatter has for each copy's look. */
const COPY_PARAMS = [
    float('size', 'Size', 0.8, 0, 3),
    vec2('stretch', 'Stretch', [1, 1], 0.05, 4),
    float('sizeRandom', 'Size randomness', 0.2, 0, 1),
    float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
    float('rotationRandom', 'Turn randomness', 0, 0, 1),
    bool('mirrorX', 'Mirror across at random', false),
    bool('mirrorY', 'Mirror down at random', false),
    float('brightnessRandom', 'Brightness randomness', 0, 0, 1),
    select('combine', 'Where copies overlap', 'higher', STACK_CHOICES, { hint: 'Higher wins: the taller copy shows. Brightest wins and Add up mix overlaps; Each on top lays later copies over earlier.' }),
];

const SHAPE_PARAMS = [
    select('shape', 'Built-in shape', 'disc', SCATTER_SHAPES, { hint: 'Drawn when no pattern is wired in.' }),
    select('profile', 'Height', 'natural', SCATTER_PROFILES),
    float('bevel', 'Bevel', 0.2, 0.01, 1, { showIf: (p) => p.profile === 'extruded' }),
];

const OUTPUTS = [out('any'), out('color', 'id', 'Copy ID'), out('gray', 'random', 'Random value'), out('color', 'uv', 'Local UV')];

/** One copy from random numbers: its look from the shared copy settings. */
const copyFrom = (params: Readonly<Record<string, unknown>>, at: Point2, unit: Point2, random: () => number, patterns: number, tilt = 0): ScatterCopy => {
    const size = num(params.size, 0.8) * (1 - random() * num(params.sizeRandom, 0));
    const stretch = pair(params.stretch, [1, 1]);
    const tiltAngle = (tilt * Math.PI) / 180;
    return {
        x: at[0],
        y: at[1],
        halfWidth: size * stretch[0] * 0.5 * unit[0],
        halfHeight: size * stretch[1] * 0.5 * unit[1],
        turn: (num(params.rotation, 0) * Math.PI) / 180 + (random() - 0.5) * Math.PI * 2 * num(params.rotationRandom, 0),
        pattern: patterns > 1 ? Math.min(patterns - 1, Math.floor(random() * patterns)) : 0,
        random: random(),
        mirrorX: params.mirrorX === true && random() < 0.5,
        mirrorY: params.mirrorY === true && random() < 0.5,
        tiltX: (random() * 2 - 1) * tiltAngle,
        tiltY: (random() * 2 - 1) * tiltAngle,
        brightness: 1 - random() * num(params.brightnessRandom, 0),
        lift: 0,
    };
};

const TILE_PLACEMENT = `uniform int uPlaceWidth;
uniform int uCount;
uniform int uPatterns;
void copyAt(int i, out vec4 a, out vec4 b, out vec4 c) {
    ivec2 grid = ivec2(p_columns, p_rows);
    ivec2 id = ivec2(i % grid.x, i / grid.x);
    vec2 centre = vec2(id) + 0.5 + (hash2(id, uSeed + 1.0) - 0.5) * p_positionRandom;
    // By the row, so shapes over the top and bottom edges stay whole with an odd number of rows.
    centre.x += mod(float(id.y), 2.0) * p_offset;
    vec2 uv = centre / vec2(grid);
    if (w_offsetMap == 1) { centre += c_offsetMap(fract(uv)).rg - 0.5; uv = centre / vec2(grid); }
    vec2 look = fract(uv);
    float scale = p_size * (1.0 - hash1(id, uSeed + 2.0) * p_sizeRandom) * g_scaleMap(look);
    bool keep = scale > 0.0 && hash1(id, uSeed + 11.0) >= p_dropRandom && g_maskMap(look) >= 0.5;
    float angle = radians(p_rotation) + (hash1(id, uSeed + 3.0) - 0.5) * TAU * p_rotationRandom + g_rotationMap(look) * TAU;
    int pattern = 0;
    if (uPatterns > 1) {
        float pick = p_patternChoice == 1 ? saturate(g_patternMap(look)) : p_patternChoice == 2 ? (float(i % uPatterns) + 0.5) / float(uPatterns) : hash1(id, uSeed + 6.0);
        pattern = min(uPatterns - 1, int(floor(pick * float(uPatterns))));
    }
    int flags = (p_mirrorX == 1 && hash1(id, uSeed + 7.0) < 0.5 ? 1 : 0) + (p_mirrorY == 1 && hash1(id, uSeed + 8.0) < 0.5 ? 2 : 0);
    a = vec4(uv, keep ? scale * p_stretch * 0.5 / vec2(grid) : vec2(0.0));
    b = vec4(angle, float(pattern), hash1(id, uSeed + 5.0), float(flags));
    c = vec4(0.0, 0.0, 1.0 - hash1(id, uSeed + 4.0) * p_brightnessRandom, 0.0);
}`;

const TILE_SAMPLER: TexNodeDef = {
    type: 'tileSampler',
    label: 'Tile sampler',
    category: 'Patterns',
    description: 'Places up to six patterns (or a built-in shape) on a grid, each copy moved, turned, sized, mirrored and brightened at random; size, turn, place, mask, colour and which pattern can each follow a map. Rivets, pebbles, leaves, debris. Also gives each copy\'s ID, random value and local UV.',
    keywords: ['scatter', 'splatter', 'instances', 'stamp', 'rivets', 'pebbles', 'distribute'],
    inputs: [
        ...PATTERN_KEYS.map((key, index) => anyIn(key, index ? `Pattern ${index + 1}` : 'Pattern')),
        grayIn('scaleMap', 'Size map', 'white'), grayIn('rotationMap', 'Turn map', 'black'), colorIn('offsetMap', 'Place map', 'mid'),
        grayIn('maskMap', 'Mask map', 'white'), anyIn('colorMap', 'Colour map', 'white'), grayIn('patternMap', 'Pattern map', 'black'),
    ],
    outputs: OUTPUTS,
    params: [
        ...SHAPE_PARAMS,
        int('columns', 'Across', 8, 1, 128),
        int('rows', 'Down', 8, 1, 128),
        ...COPY_PARAMS,
        float('positionRandom', 'Position randomness', 0.3, 0, 2),
        float('offset', 'Row offset', 0, 0, 1),
        float('dropRandom', 'Leave out at random', 0, 0, 1),
        select('patternChoice', 'Which pattern', 'random', [['random', 'At random'], ['map', 'By the pattern map'], ['order', 'In turn']]),
        seed(),
    ],
    sizeFrom: 'graph',
    kindFrom: [...PATTERN_KEYS, 'colorMap'],
    async run(context) {
        const columns = Math.max(1, Math.round(num(context.params.columns, 8)));
        const rows = Math.max(1, Math.round(num(context.params.rows, 8)));
        const count = columns * rows;
        const width = Math.min(PLACE_WIDTH, count);
        const height = Math.ceil(count / width);
        const patterns = PATTERN_KEYS.map((key) => context.input(key)).filter((image): image is GpuImage => Boolean(image));
        const place = [0, 1, 2].map(() => context.image('color', width, height, 32)) as [GpuImage, GpuImage, GpuImage];
        for (const [index, part] of ['a', 'b', 'c'].entries()) {
            await context.pass(place[index], `${TILE_PLACEMENT}\nvoid main() {
    ivec2 at = ivec2(gl_FragCoord.xy);
    int i = at.y * uPlaceWidth + at.x;
    if (i >= uCount) { outColor = vec4(0.0); return; }
    vec4 a; vec4 b; vec4 c;
    copyAt(i, a, b, c);
    outColor = ${part};
}`, { uniforms: { uPlaceWidth: width, uCount: count, uPatterns: patterns.length } });
        }
        const source: Source = patterns.length ? { kind: 'patterns', images: patterns } : { kind: 'shapes', shape: shapeNumber(context.params.shape), profile: profileNumber(context.params.profile), bevel: num(context.params.bevel, 0.2) };
        return drawScatter(context, { textures: place, width, count }, source, stackOf(context.params.combine), context.input('colorMap'));
    },
};

const SHAPE_SCATTER: TexNodeDef = {
    type: 'shapeScatter',
    label: 'Shape scatter',
    category: 'Patterns',
    description: 'Scatters shapes, a picture or raised heights as a Poisson disc (evenly, never closer than a spacing), by a density map, or where a placement picture is white, never overlapping if asked; each copy turned in 3D, sized and flipped at random. Also gives each copy\'s ID, random value and local UV.',
    keywords: ['scatter', 'poisson', 'splatter', 'stones', 'pebbles', 'density', 'no overlap', 'shape splatter'],
    inputs: [anyIn('pattern', 'Picture'), grayIn('densityMap', 'Density map', 'white'), grayIn('placementMap', 'Placement picture', 'black'), anyIn('colorMap', 'Colour map', 'white')],
    outputs: OUTPUTS,
    params: [
        select('placement', 'Placement', 'poisson', [['poisson', 'Evenly (Poisson disc)'], ['density', 'By the density map'], ['picture', 'Where the placement picture is white']]),
        float('spacing', 'Spacing', 0.08, 0.01, 0.5, { showIf: (p) => p.placement !== 'picture' }),
        int('count', 'Copies at most', 400, 1, MAX_COPIES, { showIf: (p) => p.placement === 'density' }),
        bool('noOverlap', 'Never overlapping', true, { showIf: (p) => p.placement !== 'picture' }),
        ...SHAPE_PARAMS,
        ...COPY_PARAMS.map((param) => (param.key === 'size' ? float('size', 'Size', 0.07, 0.005, 1) : param)),
        float('tilt', 'Tilt at random (degrees)', 0, 0, 70, { hint: 'A 3D turn: each copy leans by up to this much, one side standing higher.' }),
        seed(),
    ],
    sizeFrom: 'graph',
    kindFrom: ['pattern', 'colorMap'],
    async run(context) {
        const p = context.params;
        const random = randomSource(context.seed);
        const wrap = context.tiling[0] && context.tiling[1];
        const picture = context.input('pattern');
        const stretch = pair(p.stretch, [1, 1]);
        // How wide a copy can be, so copies set never to overlap are kept that far apart.
        const round = !picture && [0, 4].includes(shapeNumber(p.shape));
        const widest = num(p.size, 0.07) * Math.max(stretch[0], stretch[1]) * (round ? 1 : Math.SQRT2);
        const spacing = p.noOverlap === true ? Math.max(num(p.spacing, 0.08), widest) : num(p.spacing, 0.08);
        let points: Point2[];
        if (p.placement === 'density') {
            const values = await readSmall(context, context.input('densityMap'), 128);
            points = values ? densityPoints(values, 128, 128, Math.round(num(p.count, 400)), context.seed, p.noOverlap === true ? widest : 0, wrap)
                : densityPoints(new Float32Array([1]), 1, 1, Math.round(num(p.count, 400)), context.seed, p.noOverlap === true ? widest : 0, wrap);
        } else if (p.placement === 'picture') {
            const values = await readSmall(context, context.input('placementMap'), 64);
            points = values ? picturePoints(values, 64, 64) : [];
        } else {
            points = poissonDisc(spacing, context.seed, wrap, MAX_COPIES);
        }
        const copies = points.map((at) => copyFrom(p, at, [1, 1], random, 1, num(p.tilt, 0)));
        const { placement, dispose } = uploaded(copies);
        try {
            const source: Source = picture ? { kind: 'patterns', images: [picture] } : { kind: 'shapes', shape: shapeNumber(p.shape), profile: profileNumber(p.profile), bevel: num(p.bevel, 0.2) };
            return await drawScatter(context, placement, source, stackOf(p.combine), context.input('colorMap'));
        } finally {
            dispose();
        }
    },
};

const TILE_GENERATOR: TexNodeDef = {
    type: 'tileGenerator',
    label: 'Tile generator',
    category: 'Patterns',
    description: 'A grid of shapes (or a pattern): tiles, bricks, studs. Every other row can shift; each tile can be moved, sized, turned, mirrored, brightened or left out at random.',
    keywords: ['tiles', 'bricks', 'grid', 'studs', 'tile generator', 'pavement'],
    inputs: [anyIn('pattern', 'Pattern')],
    outputs: OUTPUTS,
    params: [
        ...SHAPE_PARAMS.map((param) => (param.key === 'shape' ? select('shape', 'Shape', 'square', SCATTER_SHAPES, { hint: 'Drawn when no pattern is wired in.' }) : param.key === 'profile' ? select('profile', 'Height', 'flat', SCATTER_PROFILES) : param)),
        int('columns', 'Across', 8, 1, 256),
        int('rows', 'Down', 8, 1, 256),
        ...COPY_PARAMS.map((param) => (param.key === 'size' ? float('size', 'Size', 0.9, 0, 2) : param.key === 'sizeRandom' ? float('sizeRandom', 'Size randomness', 0, 0, 1) : param)),
        float('positionRandom', 'Position randomness', 0, 0, 1),
        float('offset', 'Row offset', 0.5, 0, 1),
        float('dropRandom', 'Leave out at random', 0, 0, 1),
        seed(),
    ],
    sizeFrom: 'graph',
    kindFrom: 'pattern',
    async run(context) {
        const p = context.params;
        const columns = Math.max(1, Math.round(num(p.columns, 8)));
        const rows = Math.max(1, Math.round(num(p.rows, 8)));
        const copies: ScatterCopy[] = [];
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < columns; x++) {
                const random = randomSource(context.seed * 65537 + y * 4099 + x);
                if (random() < num(p.dropRandom, 0)) continue;
                const jitter = num(p.positionRandom, 0);
                const at: Point2 = [(x + 0.5 + (y % 2) * num(p.offset, 0) + (random() - 0.5) * jitter) / columns, (y + 0.5 + (random() - 0.5) * jitter) / rows];
                copies.push(copyFrom(p, at, [1 / columns, 1 / rows], random, 1));
            }
        }
        const { placement, dispose } = uploaded(copies);
        try {
            const pattern = context.input('pattern');
            const source: Source = pattern ? { kind: 'patterns', images: [pattern] } : { kind: 'shapes', shape: shapeNumber(p.shape), profile: profileNumber(p.profile), bevel: num(p.bevel, 0.2) };
            return await drawScatter(context, placement, source, stackOf(p.combine), null);
        } finally {
            dispose();
        }
    },
};

const ATLAS_SCATTER: TexNodeDef = {
    type: 'atlasScatter',
    label: 'Atlas scatter',
    category: 'Patterns',
    description: 'Scatters the pictures of an atlas (a grid of pictures in one image: leaves, stones, decals), each copy one of them at random, on a grid or evenly as a Poisson disc.',
    keywords: ['atlas', 'scatter', 'decals', 'leaves', 'sprites', 'grid of pictures'],
    inputs: [anyIn('atlas', 'Atlas', 'white'), anyIn('colorMap', 'Colour map', 'white')],
    outputs: OUTPUTS,
    params: [
        int('atlasColumns', 'Atlas columns', 4, 1, 16),
        int('atlasRows', 'Atlas rows', 4, 1, 16),
        int('cells', 'Pictures used', 16, 1, 256, { hint: 'The first so many pictures of the atlas, from the top left, row by row.' }),
        select('placement', 'Placement', 'poisson', [['poisson', 'Evenly (Poisson disc)'], ['grid', 'On a grid']]),
        float('spacing', 'Spacing', 0.1, 0.01, 0.5, { showIf: (p) => p.placement !== 'grid' }),
        int('columns', 'Across', 6, 1, 128, { showIf: (p) => p.placement === 'grid' }),
        int('rows', 'Down', 6, 1, 128, { showIf: (p) => p.placement === 'grid' }),
        ...COPY_PARAMS.map((param) => (param.key === 'size' ? float('size', 'Size', 0.12, 0.005, 1) : param)),
        seed(),
    ],
    sizeFrom: 'graph',
    kindFrom: ['atlas', 'colorMap'],
    async run(context) {
        const p = context.params;
        const atlas = context.input('atlas');
        const atlasColumns = Math.max(1, Math.round(num(p.atlasColumns, 4)));
        const atlasRows = Math.max(1, Math.round(num(p.atlasRows, 4)));
        const cells = Math.max(1, Math.min(atlasColumns * atlasRows, Math.round(num(p.cells, 16))));
        const random = randomSource(context.seed);
        let points: Point2[];
        let unit: Point2 = [1, 1];
        if (p.placement === 'grid') {
            const columns = Math.max(1, Math.round(num(p.columns, 6)));
            const rows = Math.max(1, Math.round(num(p.rows, 6)));
            points = [];
            for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) points.push([(x + 0.5) / columns, (y + 0.5) / rows]);
            unit = [1 / columns, 1 / rows];
        } else {
            points = poissonDisc(num(p.spacing, 0.1), context.seed, context.tiling[0] && context.tiling[1], MAX_COPIES);
        }
        const copies = points.map((at) => copyFrom(p, at, unit, random, cells));
        const { placement, dispose } = uploaded(copies);
        try {
            if (!atlas) {
                const empty = context.image(context.outputKind('out'));
                context.gpu.clear(empty, [0, 0, 0, context.outputKind('out') === 'color' ? 0 : 1]);
                const blank = (kind: 'color' | 'gray') => { const image = context.image(kind); context.gpu.clear(image, [0, 0, 0, 1]); return image; };
                return { out: empty, id: blank('color'), random: blank('gray'), uv: blank('color') };
            }
            return await drawScatter(context, placement, { kind: 'atlas', image: atlas, columns: atlasColumns, rows: atlasRows }, stackOf(p.combine), context.input('colorMap'));
        } finally {
            dispose();
        }
    },
};

export const SCATTER_NODES: TexNodeDef[] = [TILE_SAMPLER, SHAPE_SCATTER, TILE_GENERATOR, ATLAS_SCATTER];
