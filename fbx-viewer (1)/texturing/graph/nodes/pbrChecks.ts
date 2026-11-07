import * as THREE from 'three';
import type { GpuImage } from '../../gpu/textureGpu';
import { bool, colorIn, float, grayIn, out, select } from '../nodeKit';
import type { NodeRunContext, TexNodeDef } from '../types';

/**
 * PBR CHECKS
 *
 * Checks that a material's maps hold values real surfaces have, shown as stripes over the picture in
 * the 2D view and as a mask, with how much of the picture each finding covers said on the node:
 * base colours outside the range real non-metals fall in, metal and roughness values no real surface
 * has (half-metal, metal too dark, mirror-smooth), and a node of measured reflectances at facing angle
 * (F0) for common metals and other materials, to pick a colour from or compare a map with. Colours
 * are read as they are kept (sRGB) and measured as light (linear).
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);

/** An sRGB value (0 to 1) as light (linear). */
export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** How bright a linear colour is. */
export const luminance = (rgb: readonly number[]): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/**
 * Measured reflectance at facing angle (F0), as light (linear RGB). Metals tint their reflection;
 * other materials reflect the same in every colour.
 */
export const MEASURED_F0: ReadonlyArray<{ key: string; label: string; metal: boolean; f0: [number, number, number] }> = [
    { key: 'iron', label: 'Iron', metal: true, f0: [0.562, 0.565, 0.578] },
    { key: 'steel', label: 'Steel', metal: true, f0: [0.56, 0.57, 0.58] },
    { key: 'aluminium', label: 'Aluminium', metal: true, f0: [0.913, 0.922, 0.924] },
    { key: 'silver', label: 'Silver', metal: true, f0: [0.972, 0.96, 0.915] },
    { key: 'gold', label: 'Gold', metal: true, f0: [1.0, 0.782, 0.344] },
    { key: 'copper', label: 'Copper', metal: true, f0: [0.955, 0.638, 0.538] },
    { key: 'brass', label: 'Brass', metal: true, f0: [0.91, 0.778, 0.423] },
    { key: 'chromium', label: 'Chromium', metal: true, f0: [0.549, 0.556, 0.554] },
    { key: 'nickel', label: 'Nickel', metal: true, f0: [0.66, 0.609, 0.526] },
    { key: 'titanium', label: 'Titanium', metal: true, f0: [0.542, 0.497, 0.449] },
    { key: 'platinum', label: 'Platinum', metal: true, f0: [0.673, 0.637, 0.585] },
    { key: 'zinc', label: 'Zinc', metal: true, f0: [0.664, 0.824, 0.85] },
    { key: 'cobalt', label: 'Cobalt', metal: true, f0: [0.662, 0.655, 0.634] },
    { key: 'water', label: 'Water', metal: false, f0: [0.02, 0.02, 0.02] },
    { key: 'skin', label: 'Skin', metal: false, f0: [0.028, 0.028, 0.028] },
    { key: 'plastic', label: 'Plastic and glass', metal: false, f0: [0.04, 0.04, 0.04] },
    { key: 'quartz', label: 'Quartz', metal: false, f0: [0.045, 0.045, 0.045] },
    { key: 'ruby', label: 'Ruby', metal: false, f0: [0.077, 0.077, 0.077] },
    { key: 'diamond', label: 'Diamond', metal: false, f0: [0.172, 0.172, 0.172] },
];

/** The reflectance as a base colour (sRGB), as a metal's base colour is set in a metal-roughness material. */
export const f0AsBaseColour = (key: string): [number, number, number] => {
    const entry = MEASURED_F0.find((item) => item.key === key) ?? MEASURED_F0[0];
    return entry.f0.map(linearToSrgb) as [number, number, number];
};

/** The finding at a pixel of the albedo check: -1 too dark, 1 too bright, 0 fine (sRGB colour; limits as sRGB 0 to 255). */
export const albedoFinding = (rgb: readonly number[], darkest: number, brightest: number): number => {
    const light = luminance(rgb.map(srgbToLinear));
    if (light < srgbToLinear(darkest / 255)) return -1;
    if (light > srgbToLinear(brightest / 255)) return 1;
    return 0;
};

/**
 * The finding at a pixel of the metal and roughness check: 'half' (neither metal nor not), 'darkMetal'
 * (a metal darker than any real one), 'mirror' (smoother than real surfaces are), or null.
 */
export const pbrFinding = (rgb: readonly number[], metallic: number, roughness: number, limits: { halfLow: number; halfHigh: number; darkestMetal: number; smoothest: number }): 'half' | 'darkMetal' | 'mirror' | null => {
    if (metallic > limits.halfLow && metallic < limits.halfHigh) return 'half';
    if (metallic >= limits.halfHigh && luminance(rgb.map(srgbToLinear)) < srgbToLinear(limits.darkestMetal / 255)) return 'darkMetal';
    if (roughness < limits.smoothest) return 'mirror';
    return null;
};

/** Stripes over a colour where a finding is (its tint), for the 2D view. */
const STRIPES = `vec3 striped(vec3 c, vec3 tint, float on) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
    return mix(c, tint, on * (0.25 + 0.6 * stripe));
}
vec3 asLight(vec3 c) { return srgbToLinear(clamp(c, 0.0, 1.0)); }`;

/** The share of the picture each channel of a findings image covers (its average, read back). */
const shares = async (context: NodeRunContext, findings: GpuImage): Promise<Float32Array | null> => {
    let level = context.gpu.retain(findings);
    while (level.width > 1 || level.height > 1) {
        const next = context.gpu.image(Math.max(1, level.width >> 1), Math.max(1, level.height >> 1), 'color', 32);
        await context.gpu.pass(next, {
            fragment: `void main() { ivec2 size = textureSize(source, 0); ivec2 base = ivec2(gl_FragCoord.xy) * 2; vec4 sum = vec4(0.0);
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) sum += texelFetch(source, min(base + ivec2(x, y), size - 1), 0);
    outColor = sum * 0.25; }`,
            inputs: { source: level },
        });
        context.gpu.release(level);
        level = next;
    }
    const value = await context.gpu.readPixelLater(level, 0, 0);
    context.gpu.release(level);
    return value;
};

const percent = (share: number): string => (share < 0.001 ? 'none' : share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`);

export const PBR_CHECK_NODES: TexNodeDef[] = [
    {
        type: 'albedoCheck',
        label: 'Albedo-safe check',
        category: 'Checks',
        description: 'Stripes the base colours darker or brighter than real non-metals are (blue too dark, red too bright), and says how much of the picture each covers. Metal is left out when a metallic map is wired.',
        keywords: ['albedo check', 'albedo safe', 'pbr validate', 'base colour range', 'too dark', 'too bright', 'srgb range'],
        inputs: [colorIn('in', 'Base colour'), grayIn('metallic', 'Metallic', 'black')],
        outputs: [out('color', 'out', 'Highlighted'), out('gray', 'mask', 'Out of range')],
        params: [
            float('darkest', 'Darkest (0 to 255)', 30, 0, 255, { step: 1, hint: 'The darkest base colour (sRGB) a real non-metal has: charcoal is about 30, fresh asphalt about 50.' }),
            float('brightest', 'Brightest (0 to 255)', 240, 0, 255, { step: 1, hint: 'The brightest base colour (sRGB) a real non-metal has: fresh snow is about 240.' }),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const highlighted = context.image('color');
            const mask = context.image('gray');
            const findings = context.image('color', undefined, undefined, 16);
            const glsl = `${STRIPES}
uniform int uWhat;
void main() {
    vec4 c = c_in(vUv);
    float metal = w_metallic == 1 ? g_metallic(vUv) : 0.0;
    float light = luma(asLight(c.rgb));
    float dark = light < srgbToLinear(vec3(p_darkest / 255.0)).r && metal < 0.5 ? 1.0 : 0.0;
    float bright = light > srgbToLinear(vec3(p_brightest / 255.0)).r && metal < 0.5 ? 1.0 : 0.0;
    if (uWhat == 1) { outColor = vec4(vec3(max(dark, bright)), 1.0); return; }
    if (uWhat == 2) { outColor = vec4(dark, bright, 0.0, 1.0); return; }
    vec3 shown = striped(c.rgb, vec3(0.2, 0.4, 1.0), dark);
    outColor = vec4(striped(shown, vec3(1.0, 0.25, 0.2), bright), 1.0);
}`;
            await context.pass(highlighted, glsl, { uniforms: { uWhat: 0 } });
            await context.pass(mask, glsl, { uniforms: { uWhat: 1 } });
            await context.pass(findings, glsl, { uniforms: { uWhat: 2 } });
            const found = context.input('in') ? await shares(context, findings) : null;
            context.gpu.release(findings);
            if (found) {
                const total = found[0] + found[1];
                context.note?.(total < 0.001 ? 'In range: every base colour is within the range real non-metals have.' : `Out of range: ${percent(found[0])} of the picture is too dark and ${percent(found[1])} too bright for a real non-metal.`);
            }
            return { out: highlighted, mask };
        },
    },
    {
        type: 'pbrRangeCheck',
        label: 'Metal and roughness check',
        category: 'Checks',
        description: 'Stripes metallic values between metal and not (yellow), metal darker than real metals are (purple) and surfaces smoother than real ones (cyan), and says how much of the picture each covers.',
        keywords: ['pbr check', 'pbr validate', 'metallic range', 'roughness range', 'half metal', 'metal too dark', 'validate material'],
        inputs: [colorIn('in', 'Base colour'), grayIn('metallic', 'Metallic', 'black'), grayIn('roughness', 'Roughness', 'mid')],
        outputs: [out('color', 'out', 'Highlighted'), out('gray', 'mask', 'Findings')],
        params: [
            float('halfLow', 'Half-metal from', 0.1, 0, 0.5), float('halfHigh', 'Half-metal to', 0.9, 0.5, 1),
            float('darkestMetal', 'Darkest metal (0 to 255)', 180, 0, 255, { step: 1, hint: 'Real metals reflect at least about half the light: about 180 as a base colour (sRGB).' }),
            float('smoothest', 'Smoothest roughness', 0.03, 0, 0.5, { step: 0.005, hint: 'Rougher than this is what real surfaces are, short of mirrors and polished glass.' }),
            bool('checkSmooth', 'Check roughness', true),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const highlighted = context.image('color');
            const mask = context.image('gray');
            const findings = context.image('color', undefined, undefined, 16);
            const glsl = `${STRIPES}
uniform int uWhat;
void main() {
    vec4 c = c_in(vUv);
    float metal = g_metallic(vUv);
    float rough = g_roughness(vUv);
    float halfMetal = metal > p_halfLow && metal < p_halfHigh ? 1.0 : 0.0;
    float darkMetal = halfMetal < 0.5 && metal >= p_halfHigh && luma(asLight(c.rgb)) < srgbToLinear(vec3(p_darkestMetal / 255.0)).r ? 1.0 : 0.0;
    float mirror = p_checkSmooth == 1 && w_roughness == 1 && halfMetal < 0.5 && darkMetal < 0.5 && rough < p_smoothest ? 1.0 : 0.0;
    if (uWhat == 1) { outColor = vec4(vec3(max(halfMetal, max(darkMetal, mirror))), 1.0); return; }
    if (uWhat == 2) { outColor = vec4(halfMetal, darkMetal, mirror, 1.0); return; }
    vec3 shown = striped(c.rgb, vec3(1.0, 0.85, 0.15), halfMetal);
    shown = striped(shown, vec3(0.7, 0.3, 1.0), darkMetal);
    outColor = vec4(striped(shown, vec3(0.2, 0.9, 1.0), mirror), 1.0);
}`;
            await context.pass(highlighted, glsl, { uniforms: { uWhat: 0 } });
            await context.pass(mask, glsl, { uniforms: { uWhat: 1 } });
            await context.pass(findings, glsl, { uniforms: { uWhat: 2 } });
            const found = await shares(context, findings);
            context.gpu.release(findings);
            if (found) {
                const parts = [found[0] >= 0.001 ? `${percent(found[0])} half-metal` : '', found[1] >= 0.001 ? `${percent(found[1])} metal too dark` : '', found[2] >= 0.001 ? `${percent(found[2])} smoother than real surfaces` : ''].filter(Boolean);
                context.note?.(parts.length ? `Findings: ${parts.join(', ')}.` : 'No findings: metal and roughness are in the ranges real surfaces have.');
            }
            return { out: highlighted, mask };
        },
    },
    {
        type: 'measuredF0',
        label: 'Measured F0 reference',
        category: 'Checks',
        description: 'The measured reflectance at facing angle (F0) of a real material (metals such as iron, gold or copper; water, plastic, diamond) as a colour to use, or compared with a base colour map: what strays from it is striped.',
        keywords: ['f0', 'measured reflectance', 'metal colour', 'reference', 'specular reference', 'iron', 'gold', 'copper', 'aluminium', 'ior'],
        inputs: [colorIn('in', 'Base colour (to compare)'), grayIn('metallic', 'Metallic', 'white')],
        outputs: [out('color', 'out', 'Colour or highlighted'), out('gray', 'mask', 'Strays')],
        params: [
            select('material', 'Material', 'iron', MEASURED_F0.map((entry) => [entry.key, entry.label] as [string, string])),
            float('tolerance', 'Tolerance', 0.08, 0.005, 0.5, { step: 0.005, hint: 'How far (as light) a base colour may be from the reference before it is striped, when one is wired in.' }),
        ],
        sizeFrom: 'input',
        settingsInShader: true,
        async run(context) {
            const entry = MEASURED_F0.find((item) => item.key === context.params.material) ?? MEASURED_F0[0];
            const reference = new THREE.Vector3(...entry.f0);
            const picture = context.image('color');
            const mask = context.image('gray');
            const glsl = `${STRIPES}
uniform vec3 uF0;
uniform int uWhat;
void main() {
    if (w_in == 0) {
        if (uWhat == 1) { outColor = vec4(vec3(0.0), 1.0); return; }
        outColor = vec4(linearToSrgb(uF0), 1.0);
        return;
    }
    vec4 c = c_in(vUv);
    float metal = g_metallic(vUv);
    float strays = metal >= 0.5 && length(asLight(c.rgb) - uF0) > p_tolerance ? 1.0 : 0.0;
    if (uWhat == 1) { outColor = vec4(vec3(strays), 1.0); return; }
    outColor = vec4(striped(c.rgb, vec3(1.0, 0.3, 0.7), strays), 1.0);
}`;
            await context.pass(picture, glsl, { uniforms: { uF0: reference, uWhat: 0 } });
            await context.pass(mask, glsl, { uniforms: { uF0: reference, uWhat: 1 } });
            const base = f0AsBaseColour(entry.key).map((value) => Math.round(value * 255));
            context.note?.(`${entry.label}: F0 ${entry.f0.map((value) => value.toFixed(3)).join(', ')} as light; ${base.join(', ')} as a base colour (sRGB)${entry.metal ? '' : ', the same in every colour (not a metal)'}.`);
            return { out: picture, mask };
        },
    },
];

/** Kept for the tests: the limits the metal and roughness check reads from its settings. */
export const pbrLimits = (params: Params) => ({
    halfLow: num(params, 'halfLow', 0.1), halfHigh: num(params, 'halfHigh', 0.9), darkestMetal: num(params, 'darkestMetal', 180), smoothest: num(params, 'smoothest', 0.03),
});
