import type * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { disorderAt, fbm, saturate, scratchField, smoothstep, step, valueNoise, worley } from '../noiseMath';
import { bool, colorIn, float, grayIn, out, seed } from '../nodeKit';
import type { NodeRunContext, TexNodeDef, TexPortDef } from '../types';
import { meshMapKey, type AnyMeshMapName } from './io';
import { NOISE_GLSL } from './noises';

/**
 * MESH-BASED WEATHERING
 *
 * Masks of wear and grime built on the maps baked from a model: curvature (edges stand out), cavity,
 * occlusion, position and world normal. Each reads a map wired into its pin, else the model's baked
 * map (in Paint's fills, and on the Materials tab's model or shape), else a stand-in (open, facing
 * up), as the Mesh map node does. With no curvature map at all, stand-in panels give edges to wear,
 * and the node says so on itself and in its 2D view. Breakup noise runs in the model's own space where there is
 * a position map, so it runs across UV seams unbroken, and as tiling noise on the picture where there
 * is none, so a material made with stand-ins still tiles. The CPU twins (WEATHERING_REFERENCES) give
 * each node's mask from map values, as the shaders do with stand-ins, for the tests.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);

/** The maps weathering reads: the node's pin, the baked map, and what stands in for it. */
const MAPS: ReadonlyArray<{ name: string; map: AnyMeshMapName; fallback: 'mid' | 'white' }> = [
    { name: 'curvature', map: 'curvature', fallback: 'mid' },
    { name: 'occlusion', map: 'ambientOcclusion', fallback: 'white' },
    { name: 'cavity', map: 'cavity', fallback: 'mid' },
    { name: 'position', map: 'position', fallback: 'mid' },
    { name: 'worldNormal', map: 'worldNormal', fallback: 'mid' },
    { name: 'thickness', map: 'thickness', fallback: 'mid' },
];

const PIN_LABELS: Record<string, string> = { curvature: 'Curvature', occlusion: 'Occlusion', cavity: 'Cavity', position: 'Position', worldNormal: 'World normal', thickness: 'Thickness' };
const pins = (...names: string[]): TexPortDef[] => names.map((name) => (name === 'position' || name === 'worldNormal' ? colorIn(name, PIN_LABELS[name]) : grayIn(name, PIN_LABELS[name], name === 'occlusion' ? 'white' : 'mid')));

/** Each map bound for the shader (`m_name`), with `m_has_name` saying whether a real one is there. */
const bindMaps = (context: NodeRunContext): { inputs: Record<string, GpuImage | THREE.Texture>; uniforms: Record<string, unknown> } => {
    const inputs: Record<string, GpuImage | THREE.Texture> = {};
    const uniforms: Record<string, unknown> = {};
    for (const { name, map, fallback } of MAPS) {
        const source = context.input(name) ?? context.external(meshMapKey(map));
        inputs[`m_${name}`] = source ?? context.gpu.constant(fallback);
        uniforms[`m_has_${name}`] = source ? 1 : 0;
    }
    return { inputs, uniforms };
};

/** Stand-in panels a picture across, how wide their seams are and the map values they give (shaders and twins alike). */
const PANELS = 3;
const PANEL_SEAM = '0.03';

const WEATHER_GLSL = `${NOISE_GLSL}
uniform sampler2D m_curvature;
uniform sampler2D m_occlusion;
uniform sampler2D m_cavity;
uniform sampler2D m_position;
uniform sampler2D m_worldNormal;
uniform sampler2D m_thickness;
uniform int m_has_curvature;
uniform int m_has_occlusion;
uniform int m_has_cavity;
uniform int m_has_position;
uniform int m_has_worldNormal;
uniform int m_has_thickness;
vec4 grey(float v) { return vec4(vec3(v), 1.0); }
// With no curvature map at all, stand-in panels give the edges something to wear: a grid of panels,
// their rims standing out and the seams between them sunk and shut in (see standInPanels).
float panelEdge() { vec2 c = fract(vUv * ${PANELS.toFixed(1)}) - 0.5; return 0.5 - max(abs(c.x), abs(c.y)); }
float panelSeam() { return 1.0 - smoothstep(0.0, ${PANEL_SEAM}, panelEdge()); }
float panelRim() { float x = (panelEdge() - ${PANEL_SEAM} - 0.02) / 0.025; return exp(-x * x); }
float curvatureAt() { return m_has_curvature == 1 ? texture(m_curvature, vUv).r : 0.5 + 0.5 * panelRim() - 0.4 * panelSeam(); }
float edgeTerm() { return clamp((curvatureAt() - 0.5) * 2.0, 0.0, 1.0); }
// Crevices from the cavity map, else from the hollow half of the curvature (a bake may not keep a cavity map).
float concaveTerm() { return clamp((0.5 - (m_has_cavity == 1 ? texture(m_cavity, vUv).r : curvatureAt())) * 2.0, 0.0, 1.0); }
float openTerm() { return m_has_occlusion == 1 || m_has_curvature == 1 ? texture(m_occlusion, vUv).r : 1.0 - 0.5 * (1.0 - smoothstep(0.0, ${PANEL_SEAM} + 0.05, panelEdge())); }
float thinTerm() { return 1.0 - texture(m_thickness, vUv).r; }
vec3 placeAt() { return m_has_position == 1 ? texture(m_position, vUv).rgb : vec3(vUv, 0.5); }
vec3 facingAt() { return m_has_worldNormal == 1 ? normalize(texture(m_worldNormal, vUv).rgb * 2.0 - 1.0) : vec3(0.0, 1.0, 0.0); }
float noise3(vec3 p, float seed) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(hash1(i, seed), hash1(i + ivec3(1, 0, 0), seed), u.x), mix(hash1(i + ivec3(0, 1, 0), seed), hash1(i + ivec3(1, 1, 0), seed), u.x), u.y);
    float b = mix(mix(hash1(i + ivec3(0, 0, 1), seed), hash1(i + ivec3(1, 0, 1), seed), u.x), mix(hash1(i + ivec3(0, 1, 1), seed), hash1(i + ivec3(1, 1, 1), seed), u.x), u.y);
    return mix(a, b, u.z);
}
// Breakup: in the model's space where there is a position map, else tiling noise on the picture.
int cellsOf(float scale) { return max(1, int(scale + 0.5)); }
float breakup(float scale, int octaves, float seed) {
    if (m_has_position == 0) return fbmNoise(vUv, cellsOf(scale), octaves, 0.5, seed) * 0.5 + 0.5;
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    vec3 p = placeAt() * scale;
    for (int o = 0; o < 8; o++) {
        if (o >= octaves) break;
        sum += noise3(p, seed + float(o) * 13.17) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        p *= 2.0;
    }
    return sum / total;
}
float fineNoise(float scale, float seed) {
    if (m_has_position == 0) return valueNoise(vUv * float(cellsOf(scale)), tilePeriod(ivec2(cellsOf(scale))), seed);
    return noise3(placeAt() * scale, seed);
}
float streaks(float across, float along, float seed) {
    vec3 p = placeAt();
    vec2 q = m_has_position == 1 ? vec2(p.x + p.z, p.y) : vUv;
    ivec2 cells = ivec2(cellsOf(across), cellsOf(along));
    return pow(valueNoise(q * vec2(cells), tilePeriod(cells), seed), 3.0);
}`;

/**
 * The maps the shaders stand in when there is no curvature map at all: panels whose rims stand out
 * (curvature up), with seams between them sunk (curvature and cavity down) and shut in (occlusion down).
 */
export const standInPanels = (u: number, v: number): WeatherMaps => {
    const fract = (x: number) => x - Math.floor(x);
    const edge = 0.5 - Math.max(Math.abs(fract(u * PANELS) - 0.5), Math.abs(fract(v * PANELS) - 0.5));
    const seam = 1 - smoothstep(0, Number(PANEL_SEAM), edge);
    const x = (edge - Number(PANEL_SEAM) - 0.02) / 0.025;
    const curvature = 0.5 + 0.5 * Math.exp(-x * x) - 0.4 * seam;
    return { curvature, occlusion: 1 - 0.5 * (1 - smoothstep(0, Number(PANEL_SEAM) + 0.05, edge)), thickness: 0.5, facing: [0, 1, 0] };
};

/** The stand-in terms the CPU twins read: as the shaders read them with no model (flat, open, facing up). */
export interface WeatherMaps { curvature: number; cavity?: number; occlusion: number; thickness: number; facing: [number, number, number] }
export const STAND_IN_MAPS: WeatherMaps = { curvature: 0.5, cavity: 0.5, occlusion: 1, thickness: 0.5, facing: [0, 1, 0] };

const edgeTerm = (maps: WeatherMaps) => saturate((maps.curvature - 0.5) * 2);
const concaveTerm = (maps: WeatherMaps) => saturate((0.5 - (maps.cavity ?? maps.curvature)) * 2);
/** The shaders' cellsOf: a noise scale as whole cells (half up), so the noise repeats with the picture. */
const cellsOf = (scale: number): number => Math.max(1, Math.trunc(scale + 0.5));
const breakup = (u: number, v: number, scale: number, octaves: number, s: number) => fbm(u, v, cellsOf(scale), octaves, 0.5, s) * 0.5 + 0.5;
const fineNoise = (u: number, v: number, scale: number, s: number) => valueNoise(u * cellsOf(scale), v * cellsOf(scale), cellsOf(scale), cellsOf(scale), Math.fround(s));
const streaks = (u: number, v: number, across: number, along: number, s: number) => Math.pow(valueNoise(u * cellsOf(across), v * cellsOf(along), cellsOf(across), cellsOf(along), Math.fround(s)), 3);

/** A weathering node: a pass over the shared parts with the maps bound. */
const weathering = (definition: Omit<TexNodeDef, 'run' | 'sizeFrom' | 'outputs' | 'category'> & { glsl: string; cost?: number }): TexNodeDef => {
    const { glsl, cost, ...rest } = definition;
    return {
        ...rest,
        category: 'Weathering',
        outputs: [out('gray')],
        sizeFrom: 'graph',
        bypass: false,
        settingsInShader: true,
        async run(context) {
            const image = context.image('gray');
            const bound = bindMaps(context);
            if (bound.uniforms.m_has_curvature === 0 && rest.inputs.some((port) => port.key === 'curvature')) {
                context.note?.('No curvature map: none is wired in and the model has none baked, so this shows stand-in panel edges. Wire in a curvature map, or use the graph on a baked model.');
            }
            await context.pass(image, `${WEATHER_GLSL}\n${glsl}`, { inputs: bound.inputs, uniforms: bound.uniforms, cost: cost ?? 12 });
            return { out: image };
        },
    };
};

const amount = (fallback = 0.5) => float('amount', 'Amount', fallback, 0, 1);
const breakupAmount = (fallback = 0.5) => float('breakup', 'Breakup', fallback, 0, 1, { hint: 'How much noise breaks the mask\'s edge up.' });
const noiseScale = (fallback = 6) => float('scale', 'Noise scale', fallback, 1, 64, { softMax: 32 });

export const WEATHERING_NODES: TexNodeDef[] = [
    weathering({
        type: 'edgeWear',
        label: 'Edge wear',
        description: 'Wear along the model\'s sharp outer edges, where paint rubs off first, broken up by noise.',
        keywords: ['edge wear', 'worn edges', 'paint wear', 'chipped edges', 'scuffs'],
        inputs: pins('curvature'),
        params: [amount(), float('sharpness', 'Sharpness', 0.6, 0, 1), breakupAmount(), noiseScale(8), seed()],
        glsl: `void main() {
    float t = 1.0 - p_amount;
    float s = max((1.0 - p_sharpness) * 0.25, 0.005);
    outColor = grey(smoothstep(t - s, t + s, edgeTerm() - (breakup(p_scale, 5, uSeed) - 0.5) * p_breakup));
}`,
    }),
    weathering({
        type: 'damage',
        label: 'Damage',
        description: 'Chips knocked out of the edges with hard ragged outlines, and small dents scattered over the faces.',
        keywords: ['damage', 'chips', 'dents', 'chipped', 'impacts', 'battle damage'],
        inputs: pins('curvature'),
        params: [amount(0.4), float('dents', 'Dents', 0.3, 0, 1), noiseScale(10), seed()],
        glsl: `void main() {
    float ragged = edgeTerm() + (breakup(p_scale, 5, uSeed) - 0.5) * 0.8 + (fineNoise(p_scale * 4.0, uSeed + 1.0) - 0.5) * 0.4;
    float chips = step(1.0 - p_amount, ragged);
    float dents = step(1.0 - p_dents * 0.15, fineNoise(p_scale * 8.0, uSeed + 2.0)) * (1.0 - edgeTerm());
    outColor = grey(max(chips, dents * 0.6));
}`,
    }),
    weathering({
        type: 'notches',
        label: 'Notches',
        description: 'Small nicks along the sharpest edges, as from knocks and blades.',
        keywords: ['notches', 'nicks', 'edge chips', 'cuts', 'dings'],
        inputs: pins('curvature'),
        params: [float('density', 'How many', 0.3, 0, 1), noiseScale(24), seed()],
        glsl: `void main() {
    outColor = grey(smoothstep(0.6, 0.8, edgeTerm()) * step(1.0 - p_density, fineNoise(p_scale, uSeed + 3.0)));
}`,
    }),
    weathering({
        type: 'meshDirt',
        label: 'Dirt (in crevices)',
        description: 'Dirt gathered in crevices and hidden corners, where the model is hollow or shut in from light.',
        keywords: ['dirt', 'grime', 'crevices', 'cavity dirt', 'occlusion dirt', 'gunk'],
        inputs: pins('occlusion', 'cavity'),
        params: [amount(), float('occlusionWeight', 'Hidden corners', 0.7, 0, 2), float('cavityWeight', 'Crevices', 0.6, 0, 2), breakupAmount(), noiseScale(6), seed()],
        glsl: `void main() {
    float dirt = (1.0 - openTerm()) * p_occlusionWeight + concaveTerm() * p_cavityWeight;
    float t = 1.0 - p_amount;
    outColor = grey(smoothstep(t - 0.15, t + 0.15, dirt + (breakup(p_scale, 5, uSeed) - 0.5) * p_breakup));
}`,
    }),
    weathering({
        type: 'clothWear',
        label: 'Cloth wear',
        description: 'Cloth rubbed thin on its edges and raised parts, the wear frayed along the threads.',
        keywords: ['cloth wear', 'fabric wear', 'frayed', 'threadbare', 'fuzz', 'pilling'],
        inputs: pins('curvature', 'occlusion'),
        params: [amount(0.4), float('threads', 'Thread scale', 24, 4, 128), noiseScale(6), seed()],
        glsl: `void main() {
    float fibres = streaks(p_threads, 2.0, uSeed + 4.0);
    float worn = edgeTerm() + (openTerm() - 0.5) * 0.3 + (breakup(p_scale, 4, uSeed) - 0.5) * 0.3;
    float t = 1.0 - p_amount;
    outColor = grey(smoothstep(t - 0.1, t + 0.1, worn) * (0.4 + 0.6 * clamp(fibres * 3.0, 0.0, 1.0)));
}`,
    }),
    weathering({
        type: 'leatherWear',
        label: 'Leather wear',
        description: 'Leather creased in its hollows and rubbed pale along its edges.',
        keywords: ['leather wear', 'creases', 'worn leather', 'scuffed', 'wrinkles'],
        inputs: pins('curvature', 'occlusion', 'cavity'),
        params: [amount(0.4), float('creases', 'Creases', 0.7, 0, 1), noiseScale(6), seed()],
        glsl: `void main() {
    int cells = cellsOf(p_scale * 4.0);
    vec3 w = worley(disorderAt(vUv, 0.7) * float(cells), tilePeriod(ivec2(cells)), 1.0, 0, uSeed + 5.0);
    float crease = (1.0 - smoothstep(0.0, 0.05, w.y - w.x)) * clamp(concaveTerm() + (1.0 - openTerm()), 0.0, 1.0) * p_creases;
    float t = 1.0 - p_amount;
    float rub = smoothstep(t - 0.1, t + 0.1, edgeTerm() + (breakup(p_scale, 4, uSeed) - 0.5) * 0.4);
    outColor = grey(max(rub * 0.8, crease));
}`,
    }),
    weathering({
        type: 'metalWear',
        label: 'Metal wear',
        description: 'Metal polished bright along its edges and covered in fine scratches running two ways.',
        keywords: ['metal wear', 'polished edges', 'scratches', 'brushed', 'worn metal'],
        inputs: pins('curvature'),
        params: [amount(0.4), float('scratches', 'Scratches', 0.5, 0, 1), noiseScale(6), seed()],
        glsl: `void main() {
    float t = 1.0 - p_amount;
    float polish = smoothstep(t - 0.1, t + 0.1, edgeTerm() + (breakup(p_scale, 4, uSeed) - 0.5) * 0.5);
    int across = cellsOf(p_scale) * 2;
    int along = cellsOf(p_scale) * 12;
    float a = scratchField(vUv * vec2(float(across), float(along)), tilePeriod(ivec2(across, along)), p_scratches * 0.6, 2.0, 0.15, 0.5, uSeed + 6.0);
    float b = scratchField(vUv.yx * vec2(float(across), float(along)), tilePeriod(ivec2(across, along)), p_scratches * 0.4, 2.0, 0.15, 0.5, uSeed + 7.0);
    outColor = grey(max(polish, max(a, b) * p_scratches));
}`,
    }),
    weathering({
        type: 'meshDust',
        label: 'Dust',
        description: 'Dust settled on the faces that look up and are open to the air, thinner on slopes, lying in drifts with a fine grain.',
        keywords: ['dust', 'dusty', 'settled dust', 'top dust', 'powder'],
        inputs: pins('worldNormal', 'occlusion'),
        params: [amount(), breakupAmount(0.4), noiseScale(8), seed()],
        glsl: `void main() {
    float up = clamp(facingAt().y, 0.0, 1.0);
    float t = 1.0 - p_amount;
    float cover = smoothstep(t - 0.1, t + 0.1, up * (0.6 + 0.4 * openTerm()) + (breakup(p_scale, 5, uSeed) - 0.5) * p_breakup);
    // Dust lies unevenly: thicker in drifts, with a fine grain.
    float drift = breakup(p_scale * 0.5, 4, uSeed + 14.0);
    float grain = fineNoise(p_scale * 16.0, uSeed + 15.0);
    outColor = grey(cover * clamp(0.7 + (drift - 0.5) * p_breakup * 1.5 + (grain - 0.5) * 0.3, 0.0, 1.0));
}`,
    }),
    weathering({
        type: 'grease',
        label: 'Grease',
        description: 'Dark greasy smears gathered in the hollows and hidden corners, wiped and smudged.',
        keywords: ['grease', 'oil', 'smudges', 'grime', 'stains', 'machine oil'],
        inputs: pins('occlusion', 'cavity'),
        params: [amount(0.4), noiseScale(4), seed()],
        glsl: `void main() {
    vec2 at = disorderAt(vUv, 0.8);
    float smear = m_has_position == 1 ? breakup(p_scale * 2.0, 4, uSeed + 8.0) : fbmNoise(at, cellsOf(p_scale * 2.0), 4, 0.5, uSeed + 8.0) * 0.5 + 0.5;
    float t = 1.0 - p_amount;
    outColor = grey(smoothstep(t - 0.1, t + 0.1, (1.0 - openTerm()) + concaveTerm() * 0.8 + (smear - 0.5) * 0.8));
}`,
    }),
    weathering({
        type: 'meshLeaks',
        label: 'Leaks',
        description: 'Streaks running down the model\'s sides, thicker under overhangs, as rain leaves.',
        keywords: ['leaks', 'streaks', 'rain streaks', 'drips', 'water marks', 'run off'],
        inputs: pins('position', 'worldNormal', 'occlusion'),
        params: [amount(), float('across', 'Streaks across', 48, 4, 256), float('along', 'Breaks along', 3, 1, 32), noiseScale(3), seed()],
        glsl: `void main() {
    float sides = m_has_worldNormal == 1 ? 1.0 - abs(facingAt().y) : 1.0;
    float gate = smoothstep(0.4, 0.7, breakup(p_scale, 3, uSeed + 9.0));
    outColor = grey(clamp(streaks(p_across, p_along, uSeed + 10.0) * 4.0 * gate * sides * (0.5 + 0.5 * (1.0 - openTerm())) * p_amount * 2.0, 0.0, 1.0));
}`,
    }),
    weathering({
        type: 'drippingRust',
        label: 'Dripping rust',
        description: 'Rust breaking out along edges and in crevices, with rusty drips running down below it.',
        keywords: ['dripping rust', 'rust streaks', 'rust', 'corrosion', 'drips', 'stains'],
        inputs: pins('curvature', 'cavity', 'position', 'worldNormal'),
        params: [amount(0.4), float('drips', 'Drips', 0.5, 0, 1), noiseScale(8), seed()],
        glsl: `void main() {
    float rusty = edgeTerm() * 0.7 + concaveTerm() * 0.5 + (fineNoise(p_scale * 6.0, uSeed + 11.0) - 0.5) * 0.3 + (breakup(p_scale, 5, uSeed) - 0.5) * 0.3;
    float rust = step(1.0 - p_amount, rusty);
    float sides = m_has_worldNormal == 1 ? 1.0 - abs(facingAt().y) : 1.0;
    float drips = streaks(64.0, 4.0, uSeed + 12.0) * 4.0 * smoothstep(0.45, 0.7, breakup(p_scale * 0.5, 3, uSeed + 13.0)) * sides * p_drips;
    outColor = grey(max(rust, clamp(drips, 0.0, 1.0) * 0.8));
}`,
    }),
    weathering({
        type: 'sunBleach',
        label: 'Sun bleach',
        description: 'Colour faded on the faces turned toward the sun and open to it, more in some places than others.',
        keywords: ['sun bleach', 'faded', 'sun damage', 'uv fade', 'weathered colour'],
        inputs: pins('worldNormal', 'occlusion'),
        params: [amount(), float('azimuth', 'Sun from (degrees round)', 30, -180, 180, { step: 1 }), float('elevation', 'Sun height (degrees)', 60, 0, 90, { step: 1 }), breakupAmount(0.3), noiseScale(4), seed()],
        glsl: `void main() {
    float az = radians(p_azimuth);
    float el = radians(p_elevation);
    vec3 sun = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
    float facing = clamp(dot(facingAt(), sun), 0.0, 1.0) * openTerm();
    float t = 1.0 - p_amount;
    float cover = smoothstep(t - 0.15, t + 0.15, facing + (breakup(p_scale, 4, uSeed) - 0.5) * p_breakup);
    outColor = grey(cover * clamp(0.8 + (breakup(p_scale * 0.5, 3, uSeed + 16.0) - 0.5) * p_breakup * 2.0, 0.0, 1.0));
}`,
    }),
    weathering({
        type: 'maskBuilder',
        label: 'Mask builder',
        description: 'Builds a mask from the model\'s maps without wiring: how much edges, crevices, hidden corners, thin parts, faces looking up or down, and noise each count, then a level and contrast.',
        keywords: ['mask builder', 'smart mask', 'mask generator', 'weathering mask', 'combine mesh maps'],
        inputs: pins('curvature', 'cavity', 'occlusion', 'thickness', 'worldNormal'),
        params: [
            float('edges', 'Edges', 1, -1, 1), float('cavities', 'Crevices', 0, -1, 1), float('hidden', 'Hidden corners', 0, -1, 1), float('thin', 'Thin parts', 0, -1, 1),
            float('up', 'Facing up', 0, -1, 1), float('down', 'Facing down', 0, -1, 1), float('noise', 'Noise', 0.3, -1, 1), noiseScale(6),
            float('level', 'Level', 0.5, 0, 1), float('contrast', 'Contrast', 4, 0.1, 32, { softMax: 16 }), bool('invert', 'Invert', false), seed(),
        ],
        glsl: `void main() {
    float up = facingAt().y * 0.5 + 0.5;
    float total = abs(p_edges) + abs(p_cavities) + abs(p_hidden) + abs(p_thin) + abs(p_up) + abs(p_down) + abs(p_noise);
    float v = (p_edges * edgeTerm() + p_cavities * concaveTerm() + p_hidden * (1.0 - openTerm()) + p_thin * thinTerm() + p_up * up + p_down * (1.0 - up) + p_noise * breakup(p_scale, 5, uSeed)) / max(total, 1e-3);
    v = clamp((v - p_level) * p_contrast + 0.5, 0.0, 1.0);
    outColor = grey(p_invert == 1 ? 1.0 - v : v);
}`,
    }),
];

/** The CPU twins: each mask at a place from map values (with the picture's own tiling noise, as with stand-ins). */
export const WEATHERING_REFERENCES: Record<string, (u: number, v: number, maps: WeatherMaps, params: Params, seed: number) => number> = {
    edgeWear: (u, v, maps, params, s) => {
        const t = 1 - num(params, 'amount', 0.5);
        const soft = Math.max((1 - num(params, 'sharpness', 0.6)) * 0.25, 0.005);
        return smoothstep(t - soft, t + soft, edgeTerm(maps) - (breakup(u, v, num(params, 'scale', 8), 5, s) - 0.5) * num(params, 'breakup', 0.5));
    },
    damage: (u, v, maps, params, s) => {
        const scale = num(params, 'scale', 10);
        const ragged = edgeTerm(maps) + (breakup(u, v, scale, 5, s) - 0.5) * 0.8 + (fineNoise(u, v, scale * 4, s + 1) - 0.5) * 0.4;
        const dents = step(1 - num(params, 'dents', 0.3) * 0.15, fineNoise(u, v, scale * 8, s + 2)) * (1 - edgeTerm(maps));
        return Math.max(step(1 - num(params, 'amount', 0.4), ragged), dents * 0.6);
    },
    notches: (u, v, maps, params, s) => smoothstep(0.6, 0.8, edgeTerm(maps)) * step(1 - num(params, 'density', 0.3), fineNoise(u, v, num(params, 'scale', 24), s + 3)),
    meshDirt: (u, v, maps, params, s) => {
        const dirt = (1 - maps.occlusion) * num(params, 'occlusionWeight', 0.7) + concaveTerm(maps) * num(params, 'cavityWeight', 0.6);
        const t = 1 - num(params, 'amount', 0.5);
        return smoothstep(t - 0.15, t + 0.15, dirt + (breakup(u, v, num(params, 'scale', 6), 5, s) - 0.5) * num(params, 'breakup', 0.5));
    },
    clothWear: (u, v, maps, params, s) => {
        const fibres = streaks(u, v, num(params, 'threads', 24), 2, s + 4);
        const worn = edgeTerm(maps) + (maps.occlusion - 0.5) * 0.3 + (breakup(u, v, num(params, 'scale', 6), 4, s) - 0.5) * 0.3;
        const t = 1 - num(params, 'amount', 0.4);
        return smoothstep(t - 0.1, t + 0.1, worn) * (0.4 + 0.6 * saturate(fibres * 3));
    },
    leatherWear: (u, v, maps, params, s) => {
        const scale = num(params, 'scale', 6);
        const [du, dv] = disorderAt(u, v, 0.7, s);
        const cells = cellsOf(scale * 4);
        const w = worley(du * cells, dv * cells, cells, cells, 1, 0, Math.fround(s + 5));
        const crease = (1 - smoothstep(0, 0.05, w[1] - w[0])) * saturate(concaveTerm(maps) + (1 - maps.occlusion)) * num(params, 'creases', 0.7);
        const t = 1 - num(params, 'amount', 0.4);
        return Math.max(smoothstep(t - 0.1, t + 0.1, edgeTerm(maps) + (breakup(u, v, scale, 4, s) - 0.5) * 0.4) * 0.8, crease);
    },
    metalWear: (u, v, maps, params, s) => {
        const scale = num(params, 'scale', 6);
        const t = 1 - num(params, 'amount', 0.4);
        const polish = smoothstep(t - 0.1, t + 0.1, edgeTerm(maps) + (breakup(u, v, scale, 4, s) - 0.5) * 0.5);
        const across = cellsOf(scale) * 2;
        const along = cellsOf(scale) * 12;
        const amountOf = num(params, 'scratches', 0.5);
        const a = scratchField(u * across, v * along, across, along, amountOf * 0.6, 2, 0.15, 0.5, s + 6);
        const b = scratchField(v * across, u * along, across, along, amountOf * 0.4, 2, 0.15, 0.5, s + 7);
        return Math.max(polish, Math.max(a, b) * amountOf);
    },
    meshDust: (u, v, maps, params, s) => {
        const up = saturate(maps.facing[1]);
        const t = 1 - num(params, 'amount', 0.5);
        const scale = num(params, 'scale', 8);
        const rough = num(params, 'breakup', 0.4);
        const cover = smoothstep(t - 0.1, t + 0.1, up * (0.6 + 0.4 * maps.occlusion) + (breakup(u, v, scale, 5, s) - 0.5) * rough);
        return cover * saturate(0.7 + (breakup(u, v, scale * 0.5, 4, s + 14) - 0.5) * rough * 1.5 + (fineNoise(u, v, scale * 16, s + 15) - 0.5) * 0.3);
    },
    grease: (u, v, maps, params, s) => {
        const [du, dv] = disorderAt(u, v, 0.8, s);
        const smear = fbm(du, dv, cellsOf(num(params, 'scale', 4) * 2), 4, 0.5, s + 8) * 0.5 + 0.5;
        const t = 1 - num(params, 'amount', 0.4);
        return smoothstep(t - 0.1, t + 0.1, (1 - maps.occlusion) + concaveTerm(maps) * 0.8 + (smear - 0.5) * 0.8);
    },
    meshLeaks: (u, v, maps, params, s) => {
        const gate = smoothstep(0.4, 0.7, breakup(u, v, num(params, 'scale', 3), 3, s + 9));
        return saturate(streaks(u, v, num(params, 'across', 48), num(params, 'along', 3), s + 10) * 4 * gate * (0.5 + 0.5 * (1 - maps.occlusion)) * num(params, 'amount', 0.5) * 2);
    },
    drippingRust: (u, v, maps, params, s) => {
        const scale = num(params, 'scale', 8);
        const rusty = edgeTerm(maps) * 0.7 + concaveTerm(maps) * 0.5 + (fineNoise(u, v, scale * 6, s + 11) - 0.5) * 0.3 + (breakup(u, v, scale, 5, s) - 0.5) * 0.3;
        const drips = streaks(u, v, 64, 4, s + 12) * 4 * smoothstep(0.45, 0.7, breakup(u, v, scale * 0.5, 3, s + 13)) * num(params, 'drips', 0.5);
        return Math.max(step(1 - num(params, 'amount', 0.4), rusty), saturate(drips) * 0.8);
    },
    sunBleach: (u, v, maps, params, s) => {
        const az = num(params, 'azimuth', 30) * Math.PI / 180;
        const el = num(params, 'elevation', 60) * Math.PI / 180;
        const sun = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
        const facing = saturate(maps.facing[0] * sun[0] + maps.facing[1] * sun[1] + maps.facing[2] * sun[2]) * maps.occlusion;
        const t = 1 - num(params, 'amount', 0.5);
        const scale = num(params, 'scale', 4);
        const rough = num(params, 'breakup', 0.3);
        const cover = smoothstep(t - 0.15, t + 0.15, facing + (breakup(u, v, scale, 4, s) - 0.5) * rough);
        return cover * saturate(0.8 + (breakup(u, v, scale * 0.5, 3, s + 16) - 0.5) * rough * 2);
    },
    maskBuilder: (u, v, maps, params, s) => {
        const up = maps.facing[1] * 0.5 + 0.5;
        const weights = ['edges', 'cavities', 'hidden', 'thin', 'up', 'down', 'noise'].map((key, index) => num(params, key, [1, 0, 0, 0, 0, 0, 0.3][index]));
        const terms = [edgeTerm(maps), concaveTerm(maps), 1 - maps.occlusion, 1 - maps.thickness, up, 1 - up, breakup(u, v, num(params, 'scale', 6), 5, s)];
        const total = weights.reduce((sum, w) => sum + Math.abs(w), 0);
        const value = saturate((weights.reduce((sum, w, i) => sum + w * terms[i], 0) / Math.max(total, 1e-3) - num(params, 'level', 0.5)) * num(params, 'contrast', 4) + 0.5);
        return params.invert ? 1 - value : value;
    },
};

/** The node types that read the model's maps. */
export const WEATHERING_TYPES: readonly string[] = WEATHERING_NODES.map((node) => node.type);
