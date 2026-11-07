import type { GpuImage } from '../gpu/textureGpu';
import type { PinKind, PortKind, TexPortDef } from './types';

/**
 * MATERIAL WIRES
 *
 * A material wire carries a whole surface: one image per channel (base colour, normal, roughness...).
 * A node's results keep a material output `out` as one image per channel it carries, under
 * 'out:baseColor', 'out:normal' and so on; a channel it does not carry reads as that channel's
 * default (flat normal, mid height, no metal...). Blending works channel by channel, normals as
 * directions so they stay one unit long, and a height blend works out where the top shows once and
 * uses it for every channel.
 *
 * The maths here is the reference the nodes' shaders follow, and what the tests check.
 */

export const MATERIAL_CHANNELS = ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ambientOcclusion', 'emissive', 'opacity'] as const;
export type MaterialChannelName = typeof MATERIAL_CHANNELS[number];

export const MATERIAL_CHANNEL_LABELS: Record<MaterialChannelName, string> = {
    baseColor: 'Base colour', normal: 'Normal', roughness: 'Roughness', metallic: 'Metallic', height: 'Height',
    ambientOcclusion: 'Ambient occlusion', emissive: 'Emissive', opacity: 'Opacity',
};

export const MATERIAL_CHANNEL_KINDS: Record<MaterialChannelName, PortKind> = {
    baseColor: 'color', normal: 'color', roughness: 'gray', metallic: 'gray', height: 'gray', ambientOcclusion: 'gray', emissive: 'color', opacity: 'gray',
};

/** What a channel a material does not carry reads as. */
export const MATERIAL_DEFAULTS: Record<MaterialChannelName, [number, number, number, number]> = {
    baseColor: [0.5, 0.5, 0.5, 1], normal: [0.5, 0.5, 1, 1], roughness: [0.5, 0.5, 0.5, 1], metallic: [0, 0, 0, 1],
    height: [0.5, 0.5, 0.5, 1], ambientOcclusion: [1, 1, 1, 1], emissive: [0, 0, 0, 1], opacity: [1, 1, 1, 1],
};

/** Bits a channel keeps: colours 8, normals and the greys 16 (fine steps for heights and blends). */
export const MATERIAL_PRECISION: Record<MaterialChannelName, 8 | 16> = {
    baseColor: 8, normal: 16, roughness: 16, metallic: 16, height: 16, ambientOcclusion: 16, emissive: 8, opacity: 16,
};

export type MaterialImages = Partial<Record<MaterialChannelName, GpuImage>>;

export const materialKey = (port: string, channel: MaterialChannelName): string => `${port}:${channel}`;

/** The channel a result key of a material output names ('out:normal' is 'normal'), or null. */
export const channelOfKey = (key: string): MaterialChannelName | null => {
    const at = key.lastIndexOf(':');
    const channel = at < 0 ? '' : key.slice(at + 1);
    return (MATERIAL_CHANNELS as readonly string[]).includes(channel) ? channel as MaterialChannelName : null;
};

/** The channels the material output `port` of a node's results carries, or null when it carries none. */
export const materialOf = (outputs: Readonly<Record<string, GpuImage>>, port: string): MaterialImages | null => {
    const found: MaterialImages = {};
    let carries = false;
    for (const channel of MATERIAL_CHANNELS) {
        const image = outputs[materialKey(port, channel)];
        if (image) { found[channel] = image; carries = true; }
    }
    return carries ? found : null;
};

/** A material's channels as a node's results for its material output `port`, in channel order. */
export const materialResults = (port: string, images: MaterialImages): Record<string, GpuImage> => {
    const results: Record<string, GpuImage> = {};
    for (const channel of MATERIAL_CHANNELS) {
        const image = images[channel];
        if (image) results[materialKey(port, channel)] = image;
    }
    return results;
};

/**
 * The type rules of wires. A material wire goes only into a material input, or into an image input
 * that also takes one (an Output, which keeps its own channel of it). An image goes into any image
 * input (grey reads as grey colour, colour as its brightness), never into a material input.
 */
export const wireFits = (from: PinKind, to: Pick<TexPortDef, 'kind' | 'material'>): boolean => {
    if (from === 'material') return to.kind === 'material' || to.material === true;
    return to.kind !== 'material';
};

/** The channel an Output keeps of a material wired into it: its own, or for a named image base colour (grey: height). */
export const outputChannelOf = (channel: string, kind: PortKind): MaterialChannelName =>
    ((MATERIAL_CHANNELS as readonly string[]).includes(channel) ? channel as MaterialChannelName : kind === 'gray' ? 'height' : 'baseColor');

// ---- the maths, for one pixel ----

export type Vec3 = [number, number, number];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A tangent-space normal stored as a colour, as a direction. */
export const decodeNormal = (colour: Vec3): Vec3 => [colour[0] * 2 - 1, colour[1] * 2 - 1, colour[2] * 2 - 1];
export const encodeNormal = (normal: Vec3): Vec3 => [normal[0] * 0.5 + 0.5, normal[1] * 0.5 + 0.5, normal[2] * 0.5 + 0.5];
const unit = (v: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length > 1e-5 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
};

/** Two normals (stored as colours) mixed `t` of the way from `a` to `b`, as directions: the result stays one unit long. */
export const mixNormals = (a: Vec3, b: Vec3, t: number): Vec3 => {
    const da = decodeNormal(a);
    const db = decodeNormal(b);
    return encodeNormal(unit([lerp(da[0], db[0], t), lerp(da[1], db[1], t), lerp(da[2], db[2], t)]));
};

/**
 * How much of the top shows (0 to 1) in a height blend: where the top's height (times the mask, raised
 * by the offset) stands above the bottom's, softened by the contrast. The same weight blends every
 * channel.
 */
export const heightWeight = (top: number, bottom: number, mask: number, offset: number, contrast: number): number => {
    const raised = top * mask + (offset - 0.5) * 2;
    const soft = Math.max(1 - contrast, 0.002);
    return clamp01((raised - bottom) / soft + 0.5);
};

/** The height a height blend gives: the bottom's where it wins, the taller of the two where the top shows. */
export const blendedHeight = (top: number, bottom: number, weight: number): number => lerp(bottom, Math.max(top, bottom), weight);

/** A height made `strength` times as deep round its middle (0.5 stays where it is). */
export const scaleHeight = (height: number, strength: number): number => clamp01(0.5 + (height - 0.5) * strength);

/** A normal made `strength` times as steep: 0 flattens it, 1 leaves it. */
export const scaleNormal = (colour: Vec3, strength: number): Vec3 => {
    const n = decodeNormal(colour);
    return encodeNormal(unit([n[0] * strength, n[1] * strength, Math.max(n[2], 1e-4)]));
};

/** Roughness moved by `amount` (-1 to 1): towards rough above 0, towards smooth below. */
export const adjustRoughness = (roughness: number, amount: number): number =>
    clamp01(amount >= 0 ? lerp(roughness, 1, amount) : roughness * (1 + amount));

/**
 * A normal turned with its picture: when a material's pictures turn by `degrees` (and mirror where a
 * repeat is negative), the slopes its normal map describes turn with them.
 */
export const turnNormal = (colour: Vec3, degrees: number, mirror: [number, number] = [1, 1]): Vec3 => {
    const n = decodeNormal(colour);
    const x = n[0] * Math.sign(mirror[0] || 1);
    const y = n[1] * Math.sign(mirror[1] || 1);
    const a = (-degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return encodeNormal([x * c - y * s, x * s + y * c, n[2]]);
};

/**
 * A material transform's repeats and turn, kept so the material still tiles when asked: whole repeats
 * (at least one, keeping a mirror's sign) and quarter turns.
 */
export const tilingTransform = (repeats: [number, number], degrees: number, keep: boolean): { repeats: [number, number]; degrees: number } => {
    if (!keep) return { repeats, degrees };
    const whole = (value: number) => Math.max(1, Math.round(Math.abs(value))) * (value < 0 ? -1 : 1);
    return { repeats: [whole(repeats[0]), whole(repeats[1])], degrees: Math.round(degrees / 90) * 90 };
};

// ---- the same maths, for the nodes' shaders ----

export const MATERIAL_GLSL = `vec3 decodeNormal(vec3 c) { return c * 2.0 - 1.0; }
vec3 encodeNormal(vec3 n) { return n * 0.5 + 0.5; }
vec3 unitNormal(vec3 n) { float l = length(n); return l > 1e-5 ? n / l : vec3(0.0, 0.0, 1.0); }
vec4 mixNormals(vec4 a, vec4 b, float t) { return vec4(encodeNormal(unitNormal(mix(decodeNormal(a.rgb), decodeNormal(b.rgb), t))), 1.0); }
float heightWeight(float top, float bottom, float mask, float offset, float contrast) {
    float raised = top * mask + (offset - 0.5) * 2.0;
    float soft = max(1.0 - contrast, 0.002);
    return saturate((raised - bottom) / soft + 0.5);
}
float blendedHeight(float top, float bottom, float weight) { return mix(bottom, max(top, bottom), weight); }
vec4 scaleNormal(vec4 c, float strength) { vec3 n = decodeNormal(c.rgb); return vec4(encodeNormal(unitNormal(vec3(n.xy * strength, max(n.z, 1e-4)))), 1.0); }
float adjustRoughness(float r, float amount) { return saturate(amount >= 0.0 ? mix(r, 1.0, amount) : r * (1.0 + amount)); }
vec4 turnNormal(vec4 c, float degrees, vec2 mirror) {
    vec3 n = decodeNormal(c.rgb);
    vec2 xy = n.xy * sign(mirror + 1e-9);
    return vec4(encodeNormal(vec3(rotate2(radians(-degrees)) * xy, n.z)), 1.0);
}`;
