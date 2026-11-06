import * as THREE from 'three';
import { blendModeIndex } from '../gpu/glslLibrary';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { hashText } from '../graph/document';
import { TextureGraphEvaluator, type ExternalImage } from '../graph/evaluator';
import { MESH_MAPS, OUTPUT_NODE_TYPE, meshMapKey, type MeshMapName } from '../graph/nodes/io';
import { jumpFlood } from '../graph/nodes/distance';
import type { GraphResolver } from '../graph/registry';
import { BAKE_VERSION, padImage, releaseTileBake, spaceOfBox, type PositionSpace, type TileBake } from '../bake/meshBaker';
import { UvRaster } from '../bake/uvRaster';
import type { PartMesh } from '../mesh/partMesh';
import { SurfacePicker } from '../mesh/picker';
import { encodePng, encodePng16, pngBitDepth, readPicture, readPng16 } from '../png';
import type { ChannelImages } from '../materialOutput';
import {
    CHANNEL_DEFAULT,
    CHANNEL_IS_COLOR,
    PAINT_CHANNELS,
    allLayers,
    type FillProjection,
    type FillSource,
    type MaskEffect,
    type PaintChannel,
    type PaintDocument,
    type PaintLayer,
    type TilePictures,
} from './paintTypes';
import { DirtyRegion, alignRect, clampRect, expandRect, scissorOf, type Rect } from './regions';
import { SparsePicture } from './sparsePicture';

/**
 * A PAINTED TEXTURE SET AT WORK
 *
 * Holds a texture set's pictures on the GPU (painted pixels and masks, kept only where painted; baked
 * mesh maps) and puts its layers together into one picture per channel per tile:
 *   - each layer's value comes from its painted pixels (value and coverage), its fill, or what the
 *     layers below it make of a channel;
 *   - its mask is worked out from its effects (which may read the layers below it too);
 *   - it is blended over what is below by its channel's mode and opacity and its own opacity (normals
 *     are laid over one another, keeping both); a filter layer changes what is below it instead;
 *   - folders put their own layers together first and are laid over by their mask, opacity and mode.
 * Every channel of an area is put together in step, layer by layer, so a layer can read what the
 * layers below it made of any channel. A stroke changes a small area: only that area (grown by what
 * reads neighbours) is put together again. Finished channels are padded past the islands so filtering
 * never shows a seam. The normal the model draws with is the baked normal with the painted normal
 * detail and the slopes of painted height laid over it.
 */

export interface StackHost {
    gpu: TextureGpu;
    resolveGraph: GraphResolver;
    /** A project texture (fills and stencils), or null while it loads. */
    texture: (textureId: string) => THREE.Texture | null;
    /** What the surface wore before painting: a picture or a value per channel. */
    current: Partial<Record<PaintChannel, THREE.Texture | [number, number, number]>>;
    fetchPicture: (assetId: string) => Promise<Blob>;
    storePicture: (blob: Blob) => Promise<string>;
}

/** Finished pictures of one tile. */
export type TileOutputs = Partial<Record<PaintChannel | 'ambientOcclusion', GpuImage>>;

/**
 * One layer laid over what is below it, in an area. The area's own pictures (what is below, painted
 * pictures drawn for it) are read from its corner; whole-tile pictures (fills, graph masks) from `uSrcAt`
 * and `uMaskAt`, where the area lies in the tile.
 */
const COMPOSE = /* glsl */ `
uniform int uGrayAcc;
uniform int uSrcKind;
uniform vec3 uValue;
uniform int uHasMask;
uniform float uOpacity;
uniform int uMode;
uniform int uNormal;
uniform vec2 uSrcAt;
uniform vec2 uMaskAt;
vec3 rnm(vec3 base, vec3 detail) {
    vec3 t = base + vec3(0.0, 0.0, 1.0);
    vec3 u = detail * vec3(-1.0, -1.0, 1.0);
    return t * dot(t, u) / max(t.z, 1e-4) - u;
}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 a = texelFetch(acc, p, 0);
    if (uGrayAcc == 1) a = vec4(a.rrr, 1.0);
    // 0: a painted picture (value and coverage), 1: a colour image, 2: a grey image, 3: one value,
    // 4: a colour image read as grey (its brightness).
    vec4 s = uSrcKind == 3 ? vec4(uValue, 1.0) : texelFetch(src, p + ivec2(uSrcAt), 0);
    if (uSrcKind == 2) s = vec4(s.rrr, 1.0);
    if (uSrcKind == 1) s.a = 1.0;
    if (uSrcKind == 4) s = vec4(vec3(luma(s.rgb)), 1.0);
    float m = uHasMask == 1 ? texelFetch(mask, p + ivec2(uMaskAt), 0).r : 1.0;
    float w = clamp(s.a * m * uOpacity, 0.0, 1.0);
    if (uNormal == 1) {
        vec3 base = normalize(a.xyz * 2.0 - 1.0);
        vec3 detail = normalize(s.xyz * 2.0 - 1.0);
        vec3 combined = uMode == 0 ? detail : normalize(rnm(base, detail));
        outColor = vec4(normalize(mix(base, combined, w)) * 0.5 + 0.5, 1.0);
        return;
    }
    vec3 mixed = blendColor(s.rgb, a.rgb, uMode);
    outColor = vec4(mix(a.rgb, mixed, w), 1.0);
}`;

/** A folder's layers, put together, laid over what is below the folder by its mask, opacity and mode. */
const FOLDER = /* glsl */ `
uniform int uHasMask;
uniform float uOpacity;
uniform int uMode;
uniform int uNormal;
uniform vec2 uMaskAt;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 b = texelFetch(below, p, 0);
    vec4 a = texelFetch(above, p, 0);
    float m = (uHasMask == 1 ? texelFetch(mask, p + ivec2(uMaskAt), 0).r : 1.0) * uOpacity;
    if (uNormal == 1 || uMode < 0) { outColor = mix(b, a, m); return; }
    outColor = vec4(mix(b.rgb, blendColor(a.rgb, b.rgb, uMode), m), 1.0);
}`;

const MASK_STEP = /* glsl */ `
uniform int uKind;
uniform int uBlend;
uniform float uOpacity;
uniform float uValue;
uniform vec3 uLevels;
uniform vec2 uSrcAt;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float m = texelFetch(acc, p, 0).r;
    if (uKind == 3) { // levels: low, high, mid
        float t = saturate((m - uLevels.x) / max(uLevels.y - uLevels.x, 1e-5));
        outColor = vec4(mix(m, pow(t, log(0.5) / log(clamp(uLevels.z, 0.01, 0.99))), uOpacity));
        return;
    }
    if (uKind == 5) { outColor = vec4(mix(m, 1.0 - m, uOpacity)); return; }
    float e = uKind == 1 ? uValue : texelFetch(src, p + ivec2(uSrcAt), 0).r;
    float r;
    if (uBlend == 0) r = m * e;
    else if (uBlend == 1) r = m + e;
    else if (uBlend == 2) r = m - e;
    else if (uBlend == 3) r = e;
    else if (uBlend == 4) r = max(m, e);
    else r = min(m, e);
    outColor = vec4(saturate(mix(m, r, uOpacity)));
}`;

/**
 * A channel of the layers below, as a mask: its brightness, or how fast it changes (so painted height
 * gives its edges), spread over low..high.
 */
const BELOW_VALUE = /* glsl */ `
uniform int uGray;
uniform int uEdges;
uniform vec2 uRange;
uniform float uSlope;
float g(ivec2 q) {
    vec4 c = texelFetch(source, clamp(q, ivec2(0), textureSize(source, 0) - 1), 0);
    return uGray == 1 ? c.r : luma(c.rgb);
}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float v = g(p);
    if (uEdges == 1) {
        float dx = (g(p + ivec2(1, 0)) - g(p - ivec2(1, 0))) * 0.5;
        float dy = (g(p + ivec2(0, 1)) - g(p - ivec2(0, 1))) * 0.5;
        v = length(vec2(dx, dy)) * uSlope;
    }
    outColor = vec4(saturate((v - uRange.x) / max(uRange.y - uRange.x, 1e-5)));
}`;

/** Filters that work on each texel (and warp, which reads nearby): hue/saturation/lightness, levels, warp, invert. */
const FILTER = /* glsl */ `
uniform int uKind;
uniform int uGray;
uniform vec3 uHsl;
uniform vec3 uLevels;
uniform vec2 uWarp;
uniform vec2 uAt;
uniform float uTile;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(source, p, 0);
    if (uKind == 4) {
        // Swirls laid on the tile, not the area, so neighbouring areas line up.
        vec2 t = (vec2(p) + uAt + 0.5) / uTile * uWarp.y;
        ivec2 period = ivec2(max(1.0, floor(uWarp.y + 0.5)));
        vec2 push = vec2(perlin(t, period, 3.0), perlin(t + vec2(17.3, 41.9), period, 7.0)) * uWarp.x;
        outColor = texture(source, (vec2(p) + 0.5 + push) / vec2(textureSize(source, 0)));
        return;
    }
    if (uKind == 5) { outColor = uGray == 1 ? vec4(1.0 - c.r) : vec4(1.0 - c.rgb, c.a); return; }
    if (uKind == 3) {
        vec3 v = saturate((c.rgb - uLevels.x) / max(uLevels.y - uLevels.x, 1e-5));
        outColor = vec4(pow(v, vec3(log(0.5) / log(clamp(uLevels.z, 0.01, 0.99)))), c.a);
        return;
    }
    // Hue, saturation and lightness; grey channels take the lightness alone.
    if (uGray == 1) { outColor = vec4(saturate(c.r + uHsl.z * (uHsl.z > 0.0 ? 1.0 - c.r : c.r))); return; }
    vec3 hsl = rgbToHsl(c.rgb);
    hsl.x = fract(hsl.x + uHsl.x);
    hsl.y = saturate(hsl.y * (1.0 + uHsl.y));
    hsl.z = saturate(hsl.z + uHsl.z * (uHsl.z > 0.0 ? 1.0 - hsl.z : hsl.z));
    outColor = vec4(hslToRgb(hsl), c.a);
}`;

/** Sharpening: the picture pushed away from a blurred copy of itself. */
const SHARPEN = /* glsl */ `
uniform float uAmount;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(source, p, 0);
    vec4 b = texelFetch(blurred, p, 0);
    outColor = clamp(c + (c - b) * uAmount, 0.0, 1.0);
}`;

/** A filtered picture laid over the unfiltered one by the layer's mask and opacity. */
const FILTER_MIX = /* glsl */ `
uniform int uHasMask;
uniform float uOpacity;
uniform int uNormal;
uniform vec2 uMaskAt;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 a = texelFetch(below, p, 0);
    vec4 f = texelFetch(filtered, p, 0);
    float m = (uHasMask == 1 ? texelFetch(mask, p + ivec2(uMaskAt), 0).r : 1.0) * uOpacity;
    vec4 o = mix(a, f, m);
    if (uNormal == 1) o = vec4(normalize(o.xyz * 2.0 - 1.0) * 0.5 + 0.5, 1.0);
    outColor = o;
}`;

/** Texels of `source` from `uAt` on (whole texels, may be negative), drawn from this target's corner. */
const SHIFT = /* glsl */ `uniform vec2 uAt;
void main() { outColor = texelFetch(source, ivec2(gl_FragCoord.xy + uAt), 0); }`;

/**
 * A kept picture at another size scaled to this set's: averaged over each block when shrinking, blended
 * between neighbours when growing, weighting colour by coverage so see-through pixels add no black.
 */
const RESAMPLE = /* glsl */ `
vec4 weighted(ivec2 p, ivec2 last) {
    vec4 c = texelFetch(source, clamp(p, ivec2(0), last), 0);
    return vec4(c.rgb * c.a, c.a);
}
void main() {
    ivec2 size = textureSize(source, 0);
    ivec2 last = size - 1;
    float ratio = float(size.x) / uSize.x;
    vec4 sum = vec4(0.0);
    if (ratio > 1.0) {
        int n = int(ratio + 0.5);
        ivec2 base = ivec2(gl_FragCoord.xy) * n;
        for (int y = 0; y < 16; y++) {
            if (y >= n) break;
            for (int x = 0; x < 16; x++) {
                if (x >= n) break;
                sum += weighted(base + ivec2(x, y), last);
            }
        }
        sum /= float(n * n);
    } else {
        vec2 at = vUv * vec2(size) - 0.5;
        ivec2 i = ivec2(floor(at));
        vec2 f = fract(at);
        sum = mix(mix(weighted(i, last), weighted(i + ivec2(1, 0), last), f.x), mix(weighted(i + ivec2(0, 1), last), weighted(i + ivec2(1, 1), last), f.x), f.y);
    }
    outColor = sum.a > 1e-5 ? vec4(sum.rgb / sum.a, sum.a) : vec4(0.0);
}`;

/**
 * A fill's picture laid onto the texels: along the UVs, or cast along each axis and blended by how the
 * surface faces. A cast normal map is not blended as colours: each side's lean is turned into the
 * model's space, laid along the surface, and read back in the frame the renderer uses there.
 */
const CAST = /* glsl */ `
uniform sampler2D uTexture;
uniform int uProjection;
uniform float uScale;
uniform float uRotation;
uniform float uSharpness;
uniform int uSrgb;
uniform int uGray;
uniform int uRebuildNormal;
uniform int uNormalMap;
uniform int uChannel;
uniform vec3 uCentre;
uniform float uExtent;
uniform float uOffset;
vec4 read(vec2 uv) {
    vec4 c = texture(uTexture, uv);
    if (uGray == 1) c.rgb = c.rrr;
    if (uSrgb == 1) c.rgb = linearToSrgb(c.rgb);
    if (uRebuildNormal == 1) { vec2 xy = c.xy * 2.0 - 1.0; c.rgb = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy)))) * 0.5 + 0.5; }
    if (uChannel > 0) c.rgb = vec3(c[uChannel]);
    return c;
}
// How far a normal map pixel leans along the picture's two axes, as directions in the model: t and b
// are where the picture's u and v grow; r is the picture's turn.
vec3 lean(vec2 uv, mat2 r, vec3 t, vec3 b) {
    vec3 n = read(uv).xyz * 2.0 - 1.0;
    vec2 d = (n.xy / max(n.z, 0.05)) * r;
    return t * d.x + b * d.y;
}
void main() {
    if (uProjection == 0) {
        vec2 uv = vSourceUv;
        if (uScale != 1.0 || uRotation != 0.0) uv = rotate2(radians(uRotation)) * (uv * uScale);
        outColor = vec4(read(uv).rgb, 1.0);
        return;
    }
    vec3 n = normalize(vNormal);
    vec3 w = pow(abs(n), vec3(uSharpness));
    w /= max(w.x + w.y + w.z, 1e-5);
    // Where the position map puts this place (with an offset of 0.5), so a texture graph's triplanar
    // projection reading that map lays a pattern exactly where this does.
    vec3 q = ((vPos - uCentre) / uExtent + uOffset) * uScale;
    mat2 r = rotate2(radians(uRotation));
    vec2 ux = r * q.zy;
    vec2 uy = r * q.xz;
    vec2 uz = r * q.xy;
    if (uNormalMap == 0) {
        outColor = vec4((read(ux) * w.x + read(uy) * w.y + read(uz) * w.z).rgb, 1.0);
        return;
    }
    vec3 slope = lean(ux, r, vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0)) * w.x
        + lean(uy, r, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0)) * w.y
        + lean(uz, r, vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0)) * w.z;
    vec3 bent = normalize(n + slope - n * dot(n, slope));
    mat3 frame = surfaceFrame(n);
    vec3 local = abs(determinant(frame)) > 1e-8 ? inverse(frame) * bent : transpose(frame) * bent;
    outColor = vec4(normalize(local) * 0.5 + 0.5, 1.0);
}`;

const MASK_KINDS = { paint: 0, fill: 1, generator: 2, levels: 3, blur: 4, invert: 5, below: 6 } as const;
const MASK_BLENDS = { multiply: 0, add: 1, subtract: 2, replace: 3, max: 4, min: 5 } as const;
const FILTER_KINDS = { blur: 0, sharpen: 1, hsl: 2, levels: 3, warp: 4, invert: 5 } as const;

/**
 * Baked maps kept at 16 bits, on the GPU and when saved: where each texel is, normals, and smooth values
 * that steps would show in. Only the ID colours are fine at 8.
 */
const FINE_MAPS: ReadonlySet<MeshMapName> = new Set(['position', 'height', 'curvature', 'ambientOcclusion', 'thickness', 'normal', 'worldNormal']);

/** Picture keys: a layer's channel, or a mask effect. */
export const pictureKey = (owner: string, channel?: PaintChannel): string => (channel ? `${owner}:${channel}` : owner);

/** Painted height and normals are kept in half floats (8 bits would step slopes and lighting); the rest at 8 bits. */
export const picturePrecision = (key: string): 8 | 16 => (key.endsWith(':height') || key.endsWith(':normal') ? 16 : 8);

/** The owner of the pictures of what the surface wore before painting began, carried onto a new layout. */
export const BEFORE = 'before';

/** What a painted layer's picture holds where nothing is painted: no coverage. */
export const NOTHING: readonly [number, number, number, number] = [0, 0, 0, 0];

/** Whose a picture is: a layer's or a mask effect's id, or BEFORE. */
export const pictureOwner = (key: string): string => {
    const colon = key.indexOf(':');
    return colon < 0 ? key : key.slice(0, colon);
};

/** Owners of pictures the documents use: their layers, their mask effects, and what the surface wore before. */
export const pictureOwners = (documents: Iterable<PaintDocument>): Set<string> => {
    const owners = new Set<string>([BEFORE]);
    for (const document of documents) {
        for (const layer of allLayers(document.layers)) {
            owners.add(layer.id);
            for (const effect of layer.mask ?? []) owners.add(effect.id);
        }
    }
    return owners;
};

/** Channels a layer changes: its own (with some opacity), or for a folder every one its layers change. */
export const channelsTouched = (layer: PaintLayer): PaintChannel[] => (layer.kind === 'folder'
    ? [...new Set((layer.layers ?? []).flatMap(channelsTouched))]
    : (Object.keys(layer.channels) as PaintChannel[]).filter((channel) => (layer.channels[channel]?.opacity ?? 0) > 0));

/** Channels of the layers below that a layer's fills and mask read. */
export const channelsReadBelow = (layer: PaintLayer): PaintChannel[] => {
    const read = new Set<PaintChannel>();
    for (const source of Object.values(layer.fill ?? {})) if (source?.kind === 'below') read.add(source.channel);
    for (const effect of layer.mask ?? []) if (effect.enabled && effect.kind === 'below' && effect.channel) read.add(effect.channel);
    return [...read];
};

/**
 * The channels that change when `changed` do: those, and every channel of a layer whose mask reads a
 * changed one, or whose fill in that channel does (until nothing more changes).
 */
export const dependentChannels = (layers: readonly PaintLayer[], changed: readonly PaintChannel[]): PaintChannel[] => {
    const written = new Set(changed);
    for (let grew = true; grew;) {
        grew = false;
        const add = (channel: PaintChannel) => { if (!written.has(channel)) { written.add(channel); grew = true; } };
        for (const layer of allLayers(layers)) {
            if (!layer.visible) continue;
            for (const [channel, source] of Object.entries(layer.fill ?? {})) {
                if (source?.kind === 'below' && written.has(source.channel) && layer.channels[channel as PaintChannel]) add(channel as PaintChannel);
            }
            if ((layer.mask ?? []).some((effect) => effect.enabled && effect.kind === 'below' && effect.channel && written.has(effect.channel))) {
                for (const channel of channelsTouched(layer)) add(channel);
            }
        }
    }
    return [...written];
};

/** Every channel some layer reads from below (it must be put together alongside the channels that read it). */
export const channelsReadAnywhere = (layers: readonly PaintLayer[]): PaintChannel[] =>
    [...new Set(allLayers(layers).filter((layer) => layer.visible).flatMap(channelsReadBelow))];

/**
 * How far, in texels, something in the layers reads round a texel (blur, sharpen and warp filters, mask
 * blur, edges of a channel below): an area is put together with this much round it so its results hold.
 */
export const stackReach = (layers: readonly PaintLayer[], size: number): number => {
    let reach = 0;
    for (const layer of allLayers(layers)) {
        if (!layer.visible) continue;
        const filter = layer.kind === 'filter' ? layer.filter : undefined;
        if (filter && (filter.kind === 'blur' || filter.kind === 'sharpen' || filter.kind === 'warp')) reach += Math.ceil(filter.radius * size) + 2;
        for (const effect of layer.mask ?? []) {
            if (!effect.enabled) continue;
            if (effect.kind === 'blur') reach += Math.ceil((effect.radius ?? 0.005) * size) + 2;
            if (effect.kind === 'below' && effect.edges) reach += 2;
        }
    }
    return Math.min(reach, size);
};

interface Cached { signature: string; image: GpuImage }

/** The GPU context was lost or reset: the set's pictures are gone until it is opened again. */
export class GpuResetError extends Error {
    constructor() {
        super('The graphics card was reset, so painting is paused. The set opens again from its saved pictures.');
        this.name = 'GpuResetError';
    }
}

/**
 * Where layers are put together: an area of a tile (the changed texels, `inner`, grown by what reads
 * neighbours), whose work pictures are its size. Whole-tile pictures are read from `at`.
 */
interface Area {
    tile: number;
    rect: Rect;
    inner: Rect;
    width: number;
    height: number;
    at: THREE.Vector2;
}

/** What a layer lays down in a channel: an image (read from `at`), or one value. */
interface Source {
    image: GpuImage | THREE.Texture | null;
    kind: number;
    value: [number, number, number];
    at: THREE.Vector2;
    /** Made for this area: let go once used. */
    owned: boolean;
}

const ORIGIN = new THREE.Vector2(0, 0);

export class PaintStack {
    readonly size: number;
    readonly raster: UvRaster;
    readonly tiles: number[];
    /** Finds the surface under the pointer, and the triangles a dab reaches. */
    readonly picker: SurfacePicker;
    document: PaintDocument;
    bake: Map<number, TileBake> | null = null;
    /** The size (power of two) the baked maps were made at, when it differs from the set's. */
    bakeSize: number | null = null;
    /** Why the layers could not be put together last time, or null. */
    problem: string | null = null;
    /** Coverage and nearest-covered maps per tile, for padding (from the bake, or worked out on opening). */
    private padding = new Map<number, { coverage: GpuImage; nearest: GpuImage }>();
    /** Painted pictures by key, then tile, each kept only where painted. */
    readonly pictures = new Map<string, Map<number, SparsePicture>>();
    /** Pictures changed since they were last kept, as `key|tile`. */
    readonly unsaved = new Set<string>();
    readonly outputs = new Map<number, TileOutputs>();
    /** The painted normal detail of each tile, padded (the final normal is built on it). */
    private readonly detail = new Map<number, GpuImage>();
    private readonly fills = new Map<string, Cached>();
    /** Graph pictures copied with smaller versions of themselves, for casting. */
    private readonly castCopies = new Map<string, { signature: string; target: THREE.WebGLRenderTarget }>();
    private readonly evaluators = new Map<string, TextureGraphEvaluator>();
    private readonly listeners = new Set<() => void>();
    version = 0;
    /** Areas to put together again, by tile and channel. */
    private readonly dirty = new Map<number, Map<PaintChannel, DirtyRegion>>();
    private composing: Promise<void> | null = null;
    private again = false;
    /** Bumped when a fill or mask source outside the document changes (a re-bake, a picture loading). */
    sourcesVersion = 0;
    /** The GPU context the pictures were made on (TextureGpu.generation): after a reset they are blank. */
    private readonly generation: number;
    /** Set once the GPU context is lost: the pictures are gone, and nothing may be painted on or kept from them. */
    private abandoned = false;
    /** The layer whose mask is kept whole for the mask view, and that mask by tile. */
    private watched: string | null = null;
    private readonly watchedMasks = new Map<number, GpuImage>();
    /** Each triangle's box of texture coordinates within its tile: lowest u, v, highest u, v. */
    private triangleUvBoxes: Float32Array | null = null;

    private constructor(readonly host: StackHost, readonly part: PartMesh, document: PaintDocument) {
        this.document = document;
        this.size = 2 ** document.size;
        this.tiles = part.tiles;
        this.raster = new UvRaster(host.gpu, part);
        this.picker = new SurfacePicker(part);
        this.generation = host.gpu.generation;
        // Everything is put together the first time.
        this.markAll();
    }

    /**
     * Whether the pictures on the GPU are the set's: false once the GPU context is lost (and after it comes
     * back, when every picture made before is blank). Painting, saving and baking wait for the set to be
     * opened again from its kept pictures.
     */
    get usable(): boolean {
        return !this.abandoned && this.gpu.generation === this.generation && !this.gpu.renderer.getContext().isContextLost();
    }

    /**
     * Gives the set up after the GPU context was lost: its pictures died with the context, so they are let
     * go of without being handed back to the pool, and nothing is kept from them.
     */
    abandon(): void {
        this.abandoned = true;
        this.unsaved.clear();
        for (const byTile of this.pictures.values()) for (const picture of byTile.values()) picture.dispose(false);
        this.pictures.clear();
        this.outputs.clear();
        this.detail.clear();
        this.fills.clear();
        this.castCopies.clear();
        this.padding.clear();
        this.watchedMasks.clear();
        this.bake = null;
        // Evaluators stop listening for the context coming back (what they held died with it).
        for (const evaluator of this.evaluators.values()) evaluator.dispose();
        this.evaluators.clear();
        this.emit();
    }

    /** Throws when the pictures are not the set's (see usable), so nothing blank is kept over saved work. */
    private assertUsable(): void {
        if (!this.usable) throw new GpuResetError();
    }

    /** Opens a texture set: lays out its surface, reads its pictures and puts it together. */
    static async open(host: StackHost, part: PartMesh, document: PaintDocument): Promise<PaintStack> {
        const stack = new PaintStack(host, part, document);
        await stack.layOut();
        await stack.loadPictures();
        // A layer that cannot be drawn (a broken graph, say) leaves the set open, with the problem shown.
        await stack.compose().catch(() => undefined);
        return stack;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    private get gpu(): TextureGpu {
        return this.host.gpu;
    }

    /** Coverage and nearest maps for padding, before any bake exists. */
    private async layOut(): Promise<void> {
        for (const tile of this.tiles) {
            const coverage = this.gpu.image(this.size, this.size, 'gray', 8);
            this.raster.draw(coverage, tile, 'void main() { outColor = vec4(1.0); }', { clear: [0, 0, 0, 1] });
            const nearest = await jumpFlood(this.gpu, coverage, this.size, this.size, 'm.r >= 0.5');
            this.padding.set(tile, { coverage, nearest });
        }
    }

    /** Each triangle's box of texture coordinates within its tile (made the first time it is needed). */
    uvBoxes(): Float32Array {
        if (this.triangleUvBoxes) return this.triangleUvBoxes;
        const { indices, uvs, triangleShift } = this.part;
        const boxes = new Float32Array(indices.length / 3 * 4);
        for (let t = 0; t < indices.length / 3; t++) {
            let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
            for (let k = 0; k < 3; k++) {
                const v = indices[t * 3 + k];
                const u = uvs[v * 2] - triangleShift[t * 2];
                const w = uvs[v * 2 + 1] - triangleShift[t * 2 + 1];
                minU = Math.min(minU, u); maxU = Math.max(maxU, u);
                minV = Math.min(minV, w); maxV = Math.max(maxV, w);
            }
            boxes.set([minU, minV, maxU, maxV], t * 4);
        }
        this.triangleUvBoxes = boxes;
        return boxes;
    }

    // -----------------------------------------------------------------------
    // Pictures
    // -----------------------------------------------------------------------

    /** What a mask effect's painted picture holds where nothing is painted: black for a black mask, else white. */
    maskFill(effectId: string): readonly [number, number, number, number] {
        for (const layer of allLayers(this.document.layers)) {
            const effect = layer.mask?.find((candidate) => candidate.id === effectId);
            if (effect) return effect.value === 0 ? [0, 0, 0, 1] : [1, 1, 1, 1];
        }
        return [1, 1, 1, 1];
    }

    /** The channels a mask effect's layer changes. */
    channelsOfEffect(effectId: string): PaintChannel[] {
        const layer = allLayers(this.document.layers).find((candidate) => candidate.mask?.some((effect) => effect.id === effectId));
        return layer ? channelsTouched(layer) : [...PAINT_CHANNELS];
    }

    /** What a picture holds where nothing is painted (by what it is the picture of). */
    private fillOfKey(key: string): readonly [number, number, number, number] {
        return key.includes(':') ? NOTHING : this.maskFill(key);
    }

    private async loadPictures(): Promise<void> {
        const load = async (key: string, pictures: TilePictures | undefined) => {
            for (const [tileName, picture] of Object.entries(pictures ?? {})) {
                const tile = Number(tileName);
                if (!this.tiles.includes(tile) || !picture?.assetId) continue;
                let resampled: GpuImage | null = null;
                let texture: THREE.Texture | null = null;
                let bitmap: ImageBitmap | null = null;
                try {
                    const blob = await this.host.fetchPicture(picture.assetId);
                    let width: number;
                    let height: number;
                    if (await pngBitDepth(blob) === 16) {
                        // Kept at 16 bits (painted height and normals): read whole, as a browser reads it at 8.
                        const fine = await readPng16(blob);
                        texture = new THREE.DataTexture(fine.data, fine.width, fine.height, THREE.RGBAFormat, THREE.FloatType);
                        ({ width, height } = fine);
                    } else {
                        bitmap = await readPicture(blob);
                        texture = new THREE.Texture(bitmap);
                        texture.flipY = false;
                        texture.premultiplyAlpha = false;
                        ({ width, height } = bitmap);
                    }
                    texture.colorSpace = THREE.NoColorSpace;
                    texture.minFilter = texture.magFilter = THREE.NearestFilter;
                    texture.generateMipmaps = false;
                    texture.needsUpdate = true;
                    if (width !== this.size || height !== this.size) {
                        // Kept at another size (the set was resized): scaled with the colour of see-through
                        // pixels left out, so stroke edges do not darken.
                        resampled = this.gpu.image(this.size, this.size, 'color', picturePrecision(key));
                        this.gpu.passNow(resampled, { fragment: RESAMPLE, inputs: { source: texture } });
                    }
                    // Only the pages holding paint are kept.
                    this.picture(key, tile).adopt(resampled ?? texture, this.gpu);
                } catch {
                    // A picture that will not read leaves the layer empty rather than the set unopenable.
                } finally {
                    this.gpu.release(resampled);
                    texture?.dispose();
                    bitmap?.close();
                }
            }
        };
        for (const layer of allLayers(this.document.layers)) {
            for (const [channel, pictures] of Object.entries(layer.pictures ?? {})) await load(pictureKey(layer.id, channel as PaintChannel), pictures);
            for (const effect of layer.mask ?? []) if (effect.kind === 'paint') await load(pictureKey(effect.id), effect.pictures);
        }
        for (const [channel, pictures] of Object.entries(this.document.before ?? {})) await load(pictureKey(BEFORE, channel as PaintChannel), pictures);
        if (this.document.bake?.maps) {
            const bake = new Map<number, TileBake>();
            for (const tile of this.tiles) {
                const padding = this.padding.get(tile)!;
                bake.set(tile, { maps: {}, coverage: this.gpu.retain(padding.coverage), nearest: this.gpu.retain(padding.nearest) });
            }
            for (const [name, pictures] of Object.entries(this.document.bake.maps)) {
                for (const [tileName, picture] of Object.entries(pictures ?? {})) {
                    const entry = bake.get(Number(tileName));
                    if (!entry || !picture?.assetId) continue;
                    try {
                        const blob = await this.host.fetchPicture(picture.assetId);
                        const gray = ['ambientOcclusion', 'curvature', 'thickness', 'height'].includes(name);
                        const image = this.gpu.image(this.size, this.size, gray ? 'gray' : 'color', gray || FINE_MAPS.has(name as MeshMapName) ? 16 : 8);
                        if (await pngBitDepth(blob) === 16) {
                            // Kept at 16 bits: read whole (a browser would read it at 8).
                            const fine = await readPng16(blob);
                            if (fine.width !== this.size) this.bakeSize = Math.round(Math.log2(fine.width));
                            const texture = new THREE.DataTexture(fine.data, fine.width, fine.height, THREE.RGBAFormat, THREE.FloatType);
                            texture.colorSpace = THREE.NoColorSpace;
                            texture.minFilter = texture.magFilter = fine.width === this.size ? THREE.NearestFilter : THREE.LinearFilter;
                            texture.needsUpdate = true;
                            this.gpu.passNow(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: texture } });
                            texture.dispose();
                        } else {
                            const bitmap = await readPicture(blob);
                            if (bitmap.width !== this.size) this.bakeSize = Math.round(Math.log2(bitmap.width));
                            const texture = new THREE.Texture(bitmap);
                            texture.flipY = false;
                            texture.colorSpace = THREE.NoColorSpace;
                            texture.needsUpdate = true;
                            this.gpu.passNow(image, { fragment: 'void main() { outColor = texture(source, vUv); }', inputs: { source: texture } });
                            texture.dispose();
                            bitmap.close();
                        }
                        entry.maps[name as MeshMapName] = image;
                    } catch {
                        // Re-baking brings a lost map back.
                    }
                }
            }
            this.bake = bake;
        }
    }

    /**
     * The picture for `key` on `tile`, made the first time (holding `fill` everywhere: nothing for a layer,
     * the mask's own value for a mask). It keeps pages only where painted.
     */
    picture(key: string, tile: number, fill: readonly [number, number, number, number] = this.fillOfKey(key)): SparsePicture {
        let byTile = this.pictures.get(key);
        if (!byTile) this.pictures.set(key, byTile = new Map());
        let picture = byTile.get(tile);
        if (!picture) {
            picture = new SparsePicture(this.gpu, this.size, picturePrecision(key), fill);
            byTile.set(tile, picture);
        }
        return picture;
    }

    /** The picture for `key` on `tile` if there is one. */
    existing(key: string, tile: number): SparsePicture | null {
        return this.pictures.get(key)?.get(tile) ?? null;
    }

    hasPicture(key: string, tile: number): boolean {
        return Boolean(this.pictures.get(key)?.get(tile));
    }

    /** A whole-size copy of a picture (its fill where nothing is painted), for carrying it elsewhere; let it go after. */
    denseCopy(key: string, tile: number): GpuImage | null {
        const picture = this.existing(key, tile);
        if (!picture) return null;
        const image = this.gpu.image(this.size, this.size, 'color', picture.precision);
        picture.drawInto(image, { x0: 0, y0: 0, x1: this.size, y1: this.size });
        return image;
    }

    /** Makes `to` a copy of `from` on every tile it has (a duplicated layer or mask). */
    copyPictures(from: string, to: string): void {
        for (const [tile, picture] of this.pictures.get(from) ?? []) {
            this.picture(to, tile, picture.fill).copyFrom(picture);
            this.unsaved.add(`${to}|${tile}`);
        }
    }

    /** Lets go of a picture (its layer or effect is gone and out of the undo history). */
    dropPictures(key: string): void {
        const byTile = this.pictures.get(key);
        if (!byTile) return;
        for (const picture of byTile.values()) picture.dispose();
        this.pictures.delete(key);
        for (const tile of byTile.keys()) this.unsaved.delete(`${key}|${tile}`);
    }

    /** Lets go of every picture whose layer or mask effect none of `owners` is (see pictureOwners). */
    dropPicturesExcept(owners: ReadonlySet<string>): void {
        for (const key of [...this.pictures.keys()]) if (!owners.has(pictureOwner(key))) this.dropPictures(key);
    }

    /** A mask effect painted fully white or black to start with (nothing is drawn: it holds that value). */
    startMaskPicture(effectId: string, white: boolean): void {
        for (const tile of this.tiles) {
            this.picture(pictureKey(effectId), tile, white ? [1, 1, 1, 1] : [0, 0, 0, 1]);
            this.unsaved.add(`${pictureKey(effectId)}|${tile}`);
        }
    }

    /** Marks a picture as changed (by painting), to be kept with the next save. */
    touch(key: string, tile: number): void {
        this.unsaved.add(`${key}|${tile}`);
    }

    /**
     * Keeps a whole-size picture as an asset (16-bit PNG for half floats, 8-bit otherwise) and returns its
     * id. Nothing read from a lost GPU context is ever kept.
     */
    async storeImage(image: GpuImage): Promise<string> {
        this.assertUsable();
        const pixels = image.precision === 8 ? this.gpu.readRgba8(image, image.width, image.height, 'raw', false) : this.gpu.readUint16(image, image.width, image.height, 'color', false);
        this.assertUsable();
        const blob = pixels instanceof Uint16Array ? await encodePng16(pixels, image.width, image.height, 4) : await encodePng(pixels, image.width, image.height);
        return this.host.storePicture(blob);
    }

    /**
     * Keeps every changed picture as an asset and returns the document naming them. Pictures are
     * written bottom row first, as they are drawn, and read back the same way.
     */
    async keepPictures(): Promise<PaintDocument> {
        const stored = new Map<string, string>();
        // Pictures of deleted layers wait (undo may bring the layer back) rather than being kept for nothing.
        const used = pictureOwners([this.document]);
        for (const entry of [...this.unsaved]) {
            const [key, tileName] = entry.split('|');
            if (!used.has(pictureOwner(key))) continue;
            // A lost GPU reads back nothing: never keep that over the saved picture.
            this.assertUsable();
            // Marked kept as its pixels are read: a stroke landing while they are stored marks it again.
            this.unsaved.delete(entry);
            const whole = this.denseCopy(key, Number(tileName));
            if (!whole) continue;
            // Half-float pictures are kept as 16-bit PNGs, the rest at 8 bits.
            let pixels: Uint8ClampedArray | Uint16Array;
            try {
                pixels = whole.precision === 8 ? this.gpu.readRgba8(whole, this.size, this.size, 'raw', false) : this.gpu.readUint16(whole, this.size, this.size, 'color', false);
            } finally {
                this.gpu.release(whole);
            }
            if (!this.usable) {
                // Lost while being read: what came back is not the picture.
                this.unsaved.add(entry);
                throw new GpuResetError();
            }
            const encoded = pixels instanceof Uint16Array ? encodePng16(pixels, this.size, this.size, 4) : encodePng(pixels, this.size, this.size);
            try {
                stored.set(entry, await this.host.storePicture(await encoded));
            } catch (error) {
                this.unsaved.add(entry);
                throw error;
            }
        }
        if (!stored.size) return this.document;
        const name = (key: string, tile: number) => stored.get(`${key}|${tile}`);
        // The set's tiles, and any a new layout carried pictures onto.
        const tiles = [...new Set([...this.tiles, ...[...stored.keys()].map((entry) => Number(entry.split('|')[1]))])];
        const update = (layers: PaintLayer[]): PaintLayer[] => layers.map((layer) => {
            let next = layer;
            if (layer.kind === 'paint') {
                const pictures = { ...(layer.pictures ?? {}) };
                for (const channel of PAINT_CHANNELS) {
                    for (const tile of tiles) {
                        const assetId = name(pictureKey(layer.id, channel), tile);
                        if (assetId) pictures[channel] = { ...(pictures[channel] ?? {}), [String(tile)]: { assetId } };
                    }
                }
                next = { ...next, pictures };
            }
            if (layer.mask?.some((effect) => effect.kind === 'paint')) {
                next = {
                    ...next,
                    mask: layer.mask.map((effect) => {
                        if (effect.kind !== 'paint') return effect;
                        let pictures = effect.pictures ?? {};
                        for (const tile of tiles) {
                            const assetId = name(pictureKey(effect.id), tile);
                            if (assetId) pictures = { ...pictures, [String(tile)]: { assetId } };
                        }
                        return { ...effect, pictures };
                    }),
                };
            }
            if (layer.layers) next = { ...next, layers: update(layer.layers) };
            return next;
        });
        let before = this.document.before;
        for (const channel of PAINT_CHANNELS) {
            for (const tile of tiles) {
                const assetId = name(pictureKey(BEFORE, channel), tile);
                if (assetId) before = { ...before, [channel]: { ...before?.[channel], [String(tile)]: { assetId } } };
            }
        }
        this.document = { ...this.document, layers: update(this.document.layers), ...(before ? { before } : {}) };
        return this.document;
    }

    /** Takes over freshly baked maps; the stack keeps them. */
    setBake(bake: Map<number, TileBake>): void {
        if (this.bake) for (const result of this.bake.values()) releaseTileBake(this.gpu, result);
        this.bake = bake;
        this.bakeSize = null;
        this.sourcesVersion++;
        this.invalidate();
    }

    /**
     * Where 3D placement is measured from: the document's space (a cube round the whole model), whose fills
     * cast from three sides line up with a texture graph's triplanar projection (offset 0.5); a set made
     * before spaces were kept uses its own box, with its fills' old placement (offset 0).
     */
    space(): PositionSpace & { offset: number } {
        if (this.document.space) return { ...this.document.space, offset: 0.5 };
        return { ...spaceOfBox(this.part.bounds), offset: 0 };
    }

    /**
     * Keeps the baked maps as assets and returns the document naming them, marked with the bake's version
     * and the space its position map was measured in (`adopt` makes that space the set's own).
     */
    async keepBake(settings: NonNullable<PaintDocument['bake']>['settings'], space: PositionSpace, adopt = false): Promise<PaintDocument> {
        if (!this.bake) return this.document;
        const maps: NonNullable<PaintDocument['bake']>['maps'] = {};
        for (const [tile, result] of this.bake) {
            for (const [name, image] of Object.entries(result.maps)) {
                if (!image) continue;
                this.assertUsable();
                let blob: Blob;
                const gray = image.kind === 'gray';
                if (FINE_MAPS.has(name as MeshMapName)) {
                    // 8 bits would step these in 1/255ths: noise and triplanar masks read from them would turn
                    // blocky, and normals and occlusion would band once lit. Read a strip at a time.
                    const samples = this.gpu.readUint16(image, image.width, image.height, gray ? 'gray' : 'color', false);
                    this.assertUsable();
                    blob = await encodePng16(samples, image.width, image.height, gray ? 1 : 4);
                } else {
                    const pixels = this.gpu.readRgba8(image, this.size, this.size, gray ? 'gray' : 'raw', false);
                    this.assertUsable();
                    blob = await encodePng(pixels, this.size, this.size);
                }
                const assetId = await this.host.storePicture(blob);
                maps[name as MeshMapName] = { ...(maps[name as MeshMapName] ?? {}), [String(tile)]: { assetId } };
            }
        }
        this.document = { ...this.document, ...(adopt ? { space } : {}), bake: { settings, maps, at: Date.now(), version: BAKE_VERSION, space } };
        return this.document;
    }

    /** The mesh maps of a tile, for graphs and the 2D view. */
    meshMaps(tile: number): Partial<Record<MeshMapName, GpuImage>> {
        return this.bake?.get(tile)?.maps ?? {};
    }

    // -----------------------------------------------------------------------
    // Putting it together
    // -----------------------------------------------------------------------

    setDocument(document: PaintDocument): void {
        if (document === this.document) return;
        this.document = document;
        this.invalidate();
    }

    private markAll(): void {
        for (const tile of this.tiles) {
            const byChannel = new Map<PaintChannel, DirtyRegion>();
            for (const channel of PAINT_CHANNELS) {
                const region = new DirtyRegion(this.size);
                region.markFull();
                byChannel.set(channel, region);
            }
            this.dirty.set(tile, byChannel);
        }
    }

    /**
     * Marks channels (all when none are named) to be put together again, over the given areas of each tile
     * (all of every tile when none are given), and does so soon.
     */
    invalidate(channels?: readonly PaintChannel[], areas?: ReadonlyMap<number, readonly Rect[]>): void {
        const list = channels ?? PAINT_CHANNELS;
        for (const tile of this.tiles) {
            const rects = areas?.get(tile);
            if (areas && !rects?.length) continue;
            let byChannel = this.dirty.get(tile);
            if (!byChannel) this.dirty.set(tile, byChannel = new Map());
            for (const channel of list) {
                let region = byChannel.get(channel);
                if (!region) byChannel.set(channel, region = new DirtyRegion(this.size));
                if (!rects) region.markFull();
                else for (const r of rects) region.add(r);
            }
        }
        // A failure is shown through `problem`.
        this.compose().catch(() => undefined);
    }

    /** Shows (keeps whole) the mask of `layerId` for the mask view, or of none. */
    watchMask(layerId: string | null): void {
        if (layerId === this.watched) return;
        this.watched = layerId;
        for (const image of this.watchedMasks.values()) this.gpu.release(image);
        this.watchedMasks.clear();
        if (layerId) this.invalidate();
    }

    /** The watched layer's mask on a tile as last worked out (for showing it). */
    cachedMask(layerId: string, tile: number): GpuImage | null {
        return layerId === this.watched ? this.watchedMasks.get(tile) ?? null : null;
    }

    /** Puts the changed areas together; calls made meanwhile run once more afterwards. */
    compose(): Promise<void> {
        // Nothing to put together once the GPU context is lost: the set opens again.
        if (this.abandoned) return Promise.resolve();
        if (this.composing) {
            this.again = true;
            return this.composing;
        }
        this.composing = (async () => {
            try {
                do {
                    this.again = false;
                    this.prune();
                    // Taken now: changes made while this round draws wait for the next one.
                    const work: Array<[number, Map<PaintChannel, DirtyRegion>]> = [];
                    for (const [tile, byChannel] of this.dirty) {
                        const changed = new Map([...byChannel].filter(([, region]) => !region.empty));
                        if (changed.size) work.push([tile, changed]);
                    }
                    this.dirty.clear();
                    for (const [tile, byChannel] of work) {
                        if (this.abandoned) return;
                        await this.composeTile(tile, byChannel);
                    }
                    this.problem = null;
                    this.emit();
                } while (this.again);
            } catch (error) {
                // Put together in full next time, once whatever failed (a graph a fill draws from, say) is put right.
                this.markAll();
                this.problem = error instanceof Error ? error.message : 'The layers could not be put together.';
                this.emit();
                throw error;
            } finally {
                this.composing = null;
            }
        })();
        return this.composing;
    }

    /**
     * Lets go of evaluators and kept pictures of layers, channels and mask effects the document no longer
     * has (between compose rounds, when none is drawing). Undo brings a layer back drawn afresh.
     */
    private prune(): void {
        const live = new Set<string>();
        for (const layer of allLayers(this.document.layers)) {
            live.add(layer.id);
            for (const channel of PAINT_CHANNELS) live.add(`${layer.id}:${channel}`);
            for (const source of Object.values(layer.fill ?? {})) if (source?.kind === 'graph') live.add(`${layer.id}:graph:${source.graphId}`);
            for (const effect of layer.mask ?? []) live.add(`${layer.id}:${effect.id}`);
        }
        // Keys end with the tile.
        const owner = (key: string) => key.slice(0, key.lastIndexOf(':'));
        for (const [key, evaluator] of this.evaluators) if (!live.has(owner(key))) { evaluator.dispose(); this.evaluators.delete(key); }
        for (const [key, cached] of this.fills) if (!live.has(owner(key))) { this.gpu.release(cached.image); this.fills.delete(key); }
        for (const [key, copy] of this.castCopies) if (!live.has(owner(key))) { copy.target.dispose(); this.castCopies.delete(key); }
    }

    /** One tile: its changed channels (and those that read them) put together over the changed areas. */
    private async composeTile(tile: number, byChannel: ReadonlyMap<PaintChannel, DirtyRegion>): Promise<void> {
        const outputs = this.outputs.get(tile) ?? {};
        this.outputs.set(tile, outputs);
        // Normal is always drawn: the model's own normal map is built on it.
        const enabled = new Set<PaintChannel>([...this.document.channels, 'normal']);
        for (const channel of PAINT_CHANNELS) {
            if (enabled.has(channel) || !outputs[channel]) continue;
            this.gpu.release(outputs[channel]);
            delete outputs[channel];
        }
        const changed = [...byChannel.keys()].filter((channel) => enabled.has(channel));
        if (changed.length) {
            const layers = this.document.layers;
            const written = dependentChannels(layers, changed).filter((channel) => enabled.has(channel));
            const computed = [...new Set([...written, ...channelsReadAnywhere(layers).filter((channel) => enabled.has(channel))])];
            // One set of areas for the tile: every changed channel's, together.
            const region = new DirtyRegion(this.size);
            for (const channel of changed) region.merge(byChannel.get(channel)!);
            // A channel not drawn yet is drawn whole.
            if (written.some((channel) => !(channel === 'normal' ? this.detail.get(tile) : outputs[channel]))) region.markFull();
            const reach = stackReach(layers, this.size);
            for (const inner of region.rects) {
                const rect = alignRect(clampRect(expandRect(inner, reach), this.size), this.size);
                const area: Area = { tile, rect, inner, width: rect.x1 - rect.x0, height: rect.y1 - rect.y0, at: new THREE.Vector2(rect.x0, rect.y0) };
                const accs = await this.composeArea(area, computed);
                try {
                    for (const channel of written) this.keepArea(tile, channel, accs.get(channel)!, area);
                } finally {
                    for (const image of accs.values()) this.gpu.release(image);
                }
            }
            // Padded past the islands whole: cheap, and a change at an island's edge reaches far into the gaps.
            for (const channel of written) this.padChannel(tile, channel);
            if (written.includes('normal') || written.includes('height')) this.updateNormal(tile);
        }
        if (!outputs.ambientOcclusion || this.bake) {
            this.gpu.release(outputs.ambientOcclusion);
            const ao = this.meshMaps(tile).ambientOcclusion;
            if (ao) outputs.ambientOcclusion = this.gpu.retain(ao);
            else {
                const white = this.gpu.image(this.size, this.size, 'gray', 8);
                this.gpu.clear(white, [1, 1, 1, 1]);
                outputs.ambientOcclusion = white;
            }
        }
    }

    /** The channel's picture an area's result goes into (the padded output, or the normal's detail). */
    private resultOf(tile: number, channel: PaintChannel): GpuImage | undefined {
        return channel === 'normal' ? this.detail.get(tile) : this.outputs.get(tile)?.[channel];
    }

    /** Puts an area's result for a channel (its changed texels) into the channel's picture. */
    private keepArea(tile: number, channel: PaintChannel, acc: GpuImage, area: Area): void {
        let target = this.resultOf(tile, channel);
        if (!target) {
            target = this.gpu.image(this.size, this.size, CHANNEL_IS_COLOR[channel] ? 'color' : 'gray', 16);
            const base = CHANNEL_DEFAULT[channel];
            this.gpu.clear(target, [base[0], base[1], base[2], 1]);
            if (channel === 'normal') this.detail.set(tile, target);
            else this.outputs.get(tile)![channel] = target;
        }
        this.gpu.passNow(target, { fragment: SHIFT, inputs: { source: acc }, uniforms: { uAt: new THREE.Vector2(-area.rect.x0, -area.rect.y0) }, scissor: scissorOf(area.inner) });
    }

    /** Pads a channel's picture past the islands. */
    private padChannel(tile: number, channel: PaintChannel): void {
        const source = this.resultOf(tile, channel);
        if (!source) return;
        const padding = this.padding.get(tile)!;
        const padded = padImage(this.gpu, source, padding.coverage, padding.nearest);
        this.gpu.release(source);
        if (channel === 'normal') this.detail.set(tile, padded);
        else this.outputs.get(tile)![channel] = padded;
    }

    /** The normal the model draws with, built again from the detail and the height. */
    private updateNormal(tile: number): void {
        const detail = this.detail.get(tile);
        if (!detail) return;
        const outputs = this.outputs.get(tile)!;
        const finished = this.finalNormal(tile, detail, outputs.height ?? null);
        this.gpu.release(outputs.normal);
        outputs.normal = finished;
    }

    /** Baked normal, painted normal detail and painted height's slopes, laid together. */
    private finalNormal(tile: number, detail: GpuImage, height: GpuImage | null): GpuImage {
        // Half floats, so the 16-bit export holds 16 bits of detail.
        const out = this.gpu.image(this.size, this.size, 'color', 16);
        const baked = this.meshMaps(tile).normal;
        this.gpu.passNow(out, {
            fragment: `uniform int uHasHeight;\nuniform float uStrength;
vec3 rnm(vec3 base, vec3 d) { vec3 t = base + vec3(0.0, 0.0, 1.0); vec3 u = d * vec3(-1.0, -1.0, 1.0); return t * dot(t, u) / max(t.z, 1e-4) - u; }
void main() {
    vec3 n = normalize(texture(bakedMap, vUv).xyz * 2.0 - 1.0);
    n = normalize(rnm(n, normalize(texture(detailMap, vUv).xyz * 2.0 - 1.0)));
    if (uHasHeight == 1) {
        vec2 t = 1.0 / uSize;
        float dx = (texture(heightMap, vUv + vec2(t.x, 0.0)).r - texture(heightMap, vUv - vec2(t.x, 0.0)).r) * 0.5 * uSize.x / 64.0;
        float dy = (texture(heightMap, vUv + vec2(0.0, t.y)).r - texture(heightMap, vUv - vec2(0.0, t.y)).r) * 0.5 * uSize.y / 64.0;
        vec3 h = normalize(vec3(-dx * uStrength, -dy * uStrength, 1.0));
        n = normalize(rnm(n, h));
    }
    outColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
            inputs: { bakedMap: baked ?? this.gpu.constant('normal'), detailMap: detail, heightMap: height ?? this.gpu.constant('mid') },
            uniforms: { uHasHeight: height ? 1 : 0, uStrength: this.document.heightStrength },
        });
        return out;
    }

    /** An area's channels, every visible layer laid over the channel's default, all channels in step. */
    private async composeArea(area: Area, channels: readonly PaintChannel[]): Promise<Map<PaintChannel, GpuImage>> {
        const accs = new Map<PaintChannel, GpuImage>();
        for (const channel of channels) {
            const acc = this.gpu.image(area.width, area.height, CHANNEL_IS_COLOR[channel] ? 'color' : 'gray', 16);
            const base = CHANNEL_DEFAULT[channel];
            this.gpu.clear(acc, [base[0], base[1], base[2], 1]);
            accs.set(channel, acc);
        }
        try {
            await this.composeLayers(this.document.layers, area, accs);
        } catch (error) {
            for (const image of accs.values()) this.gpu.release(image);
            throw error;
        }
        return accs;
    }

    /** Lays `layers` (bottom first) over `accs`, which hold what is below them in each channel. */
    private async composeLayers(layers: readonly PaintLayer[], area: Area, accs: Map<PaintChannel, GpuImage>): Promise<void> {
        for (const layer of layers) {
            if (!layer.visible) continue;
            const opacity = layer.opacity ?? 1;
            if (opacity <= 0) continue;
            if (layer.kind === 'folder') {
                const touched = [...accs.keys()].filter((channel) => allLayers(layer.layers ?? []).some((inner) => inner.visible && inner.channels[channel]));
                if (!touched.length) continue;
                // The folder's layers start from what is below it; layers in it may read any channel.
                const inside = new Map<PaintChannel, GpuImage>();
                for (const [channel, acc] of accs) {
                    const copy = this.gpu.image(area.width, area.height, acc.kind, 16);
                    this.gpu.copy(acc, copy);
                    inside.set(channel, copy);
                }
                let mask: GpuImage | null = null;
                try {
                    await this.composeLayers(layer.layers ?? [], area, inside);
                    mask = await this.maskIn(layer, area, accs);
                    for (const channel of touched) {
                        const below = accs.get(channel)!;
                        const next = this.gpu.image(area.width, area.height, below.kind, 16);
                        this.gpu.passNow(next, {
                            fragment: FOLDER,
                            inputs: { below, above: inside.get(channel)!, mask: mask ?? this.gpu.constant('white') },
                            uniforms: { uHasMask: mask ? 1 : 0, uOpacity: opacity, uMode: layer.blend ? blendModeIndex(layer.blend) : -1, uNormal: channel === 'normal' ? 1 : 0, uMaskAt: ORIGIN },
                        });
                        this.gpu.release(below);
                        accs.set(channel, next);
                    }
                } finally {
                    for (const image of inside.values()) this.gpu.release(image);
                    this.gpu.release(mask);
                }
                continue;
            }
            const touched = [...accs.keys()].filter((channel) => (layer.channels[channel]?.opacity ?? 0) > 0);
            if (!touched.length) continue;
            // A paint layer painted nowhere in this area adds nothing here.
            if (layer.kind === 'paint' && !touched.some((channel) => this.existing(pictureKey(layer.id, channel), area.tile)?.reaches(area.rect))) continue;
            const mask = await this.maskIn(layer, area, accs);
            try {
                for (const channel of touched) {
                    const blend = layer.channels[channel]!;
                    const below = accs.get(channel)!;
                    if (layer.kind === 'filter') {
                        const next = await this.filterIn(layer, channel, area, below, mask, blend.opacity * opacity);
                        if (!next) continue;
                        this.gpu.release(below);
                        accs.set(channel, next);
                        continue;
                    }
                    const source = await this.sourceIn(layer, channel, area, accs);
                    if (!source) continue;
                    const next = this.gpu.image(area.width, area.height, below.kind, 16);
                    try {
                        this.gpu.passNow(next, {
                            fragment: COMPOSE,
                            inputs: { acc: below, src: source.image ?? this.gpu.constant('black'), mask: mask ?? this.gpu.constant('white') },
                            uniforms: {
                                uGrayAcc: below.kind === 'gray' ? 1 : 0,
                                uSrcKind: source.kind,
                                uValue: new THREE.Vector3(...source.value),
                                uHasMask: mask ? 1 : 0,
                                uOpacity: blend.opacity * opacity,
                                uMode: blend.mode === 'normalCombine' ? 1 : blendModeIndex(blend.mode),
                                uNormal: channel === 'normal' ? 1 : 0,
                                uSrcAt: source.at,
                                uMaskAt: ORIGIN,
                            },
                        });
                    } finally {
                        if (source.owned) this.gpu.release(source.image as GpuImage);
                    }
                    this.gpu.release(below);
                    accs.set(channel, next);
                }
            } finally {
                this.gpu.release(mask);
            }
        }
    }

    /** What a layer lays down in a channel over an area, or null when it lays down nothing there. */
    private async sourceIn(layer: PaintLayer, channel: PaintChannel, area: Area, accs: ReadonlyMap<PaintChannel, GpuImage>): Promise<Source | null> {
        if (layer.kind === 'paint') {
            const picture = this.existing(pictureKey(layer.id, channel), area.tile);
            if (!picture || !picture.reaches(area.rect)) return null;
            const image = this.gpu.image(area.width, area.height, 'color', picture.precision);
            picture.drawInto(image, area.rect, [area.rect.x0, area.rect.y0]);
            return { image, kind: 0, value: [0, 0, 0], at: ORIGIN, owned: true };
        }
        const fill = layer.fill?.[channel];
        if (!fill) return null;
        if (fill.kind === 'value') return { image: null, kind: 3, value: fill.value, at: ORIGIN, owned: false };
        if (fill.kind === 'below') {
            const below = accs.get(fill.channel);
            if (!below) return null;
            const fromColour = below.kind === 'color';
            return { image: below, kind: fromColour ? (CHANNEL_IS_COLOR[channel] ? 1 : 4) : 2, value: [0, 0, 0], at: ORIGIN, owned: false };
        }
        if (fill.kind === 'current') {
            // Carried onto this layout when the surface was laid out afresh: read as it is.
            const carried = this.existing(pictureKey(BEFORE, channel), area.tile);
            if (carried) {
                const image = this.gpu.image(area.width, area.height, 'color', carried.precision);
                carried.drawInto(image, area.rect, [area.rect.x0, area.rect.y0]);
                return { image, kind: 1, value: [0, 0, 0], at: ORIGIN, owned: true };
            }
        }
        const filled = await this.fillOf(layer.id, channel, fill, area.tile);
        return filled ? { ...filled, at: area.at, owned: false } : null;
    }

    /** A filter layer's work on a channel over an area, laid over what is below by its mask and opacity. */
    private async filterIn(layer: PaintLayer, channel: PaintChannel, area: Area, below: GpuImage, mask: GpuImage | null, opacity: number): Promise<GpuImage | null> {
        const filter = layer.filter;
        if (!filter || (channel === 'normal' && filter.kind !== 'blur' && filter.kind !== 'sharpen' && filter.kind !== 'warp')) return null;
        let filtered: GpuImage;
        if (filter.kind === 'blur' || filter.kind === 'sharpen') {
            const { gaussianBlur } = await import('../graph/nodes/transform');
            const blurred = await gaussianBlur({ gpu: this.gpu }, below, Math.max(0.25, filter.radius * this.size / 3));
            if (filter.kind === 'blur') filtered = blurred;
            else {
                filtered = this.gpu.image(area.width, area.height, below.kind, 16);
                this.gpu.passNow(filtered, { fragment: SHARPEN, inputs: { source: below, blurred }, uniforms: { uAmount: filter.amount } });
                this.gpu.release(blurred);
            }
        } else {
            filtered = this.gpu.image(area.width, area.height, below.kind, 16);
            this.gpu.passNow(filtered, {
                fragment: FILTER,
                inputs: { source: below },
                uniforms: {
                    uKind: FILTER_KINDS[filter.kind],
                    uGray: below.kind === 'gray' ? 1 : 0,
                    uHsl: new THREE.Vector3(filter.hue, filter.saturation, filter.lightness),
                    uLevels: new THREE.Vector3(filter.low, filter.high, filter.mid),
                    uWarp: new THREE.Vector2(filter.radius * this.size, Math.max(1, filter.amount)),
                    uAt: area.at,
                    uTile: this.size,
                },
            });
        }
        const next = this.gpu.image(area.width, area.height, below.kind, 16);
        this.gpu.passNow(next, {
            fragment: FILTER_MIX,
            inputs: { below, filtered, mask: mask ?? this.gpu.constant('white') },
            uniforms: { uHasMask: mask ? 1 : 0, uOpacity: opacity, uNormal: channel === 'normal' ? 1 : 0, uMaskAt: ORIGIN },
        });
        this.gpu.release(filtered);
        return next;
    }

    // -----------------------------------------------------------------------
    // Fills
    // -----------------------------------------------------------------------

    private externals(tile: number): Record<string, ExternalImage | null> {
        const maps = this.meshMaps(tile);
        const result: Record<string, ExternalImage | null> = {};
        for (const name of MESH_MAPS) result[meshMapKey(name)] = maps[name] ?? null;
        return result;
    }

    /** A graph's output drawn for this tile with its mesh maps; outputs are named by channel or by Output node id. */
    async graphOutput(graphId: string, output: string, values: Readonly<Record<string, unknown>>, tile: number, evaluatorKey: string): Promise<GpuImage | null> {
        return (await this.graphState(graphId, output, values, tile, evaluatorKey))?.image ?? null;
    }

    /** As graphOutput, with the signature of everything the picture came from. */
    private async graphState(graphId: string, output: string, values: Readonly<Record<string, unknown>>, tile: number, evaluatorKey: string): Promise<{ image: GpuImage; signature: string } | null> {
        const entry = this.host.resolveGraph(graphId);
        if (!entry) return null;
        const outputs = entry.graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
        const node = outputs.find((candidate) => candidate.id === output) ?? outputs.find((candidate) => candidate.params.channel === output) ?? outputs.find((candidate) => String(candidate.params.name ?? '').toLowerCase() === output.toLowerCase());
        if (!node) return null;
        let evaluator = this.evaluators.get(`${evaluatorKey}:${tile}`);
        if (!evaluator) this.evaluators.set(`${evaluatorKey}:${tile}`, evaluator = new TextureGraphEvaluator(this.gpu, this.host.resolveGraph, this.host.texture));
        const states = await evaluator.evaluate({
            graph: entry.graph,
            parameters: values,
            external: this.externals(tile),
            externalVersion: String(this.sourcesVersion),
            targets: [node.id],
            size: { w: this.document.size, h: this.document.size },
        });
        const state = states.get(node.id);
        if (state?.error) throw new Error(`${entry.name}: ${state.error}`);
        return state?.outputs.out ? { image: state.outputs.out, signature: state.signature } : null;
    }

    /** A fill drawn over the whole tile (kept until its source changes); values and below are handled by sourceIn. */
    private async fillOf(layerId: string, channel: PaintChannel, fill: FillSource, tile: number): Promise<{ image: GpuImage | THREE.Texture | null; kind: number; value: [number, number, number] } | null> {
        if (fill.kind === 'value') return { image: null, kind: 3, value: fill.value };
        if (fill.kind === 'below') return null;
        const key = `${layerId}:${channel}:${tile}`;
        if (fill.kind === 'graph') {
            // Channels drawn from the same graph share its evaluator, so the nodes they have in common are drawn once.
            const drawn = await this.graphState(fill.graphId, fill.output, fill.values, tile, `${layerId}:graph:${fill.graphId}`);
            if (!drawn) return null;
            const projection: FillProjection = { projection: fill.projection ?? 'uv', scale: fill.scale ?? 1, rotation: fill.rotation ?? 0, sharpness: fill.sharpness ?? 4 };
            if (projection.projection === 'uv' && projection.scale === 1 && projection.rotation === 0) {
                // Drawn straight along the UVs: a cast kept from earlier settings is let go.
                const stale = this.fills.get(key);
                if (stale) { this.gpu.release(stale.image); this.fills.delete(key); }
                this.castCopies.get(key)?.target.dispose();
                this.castCopies.delete(key);
                return { image: drawn.image, kind: drawn.image.kind === 'gray' ? 2 : 1, value: [0, 0, 0] };
            }
            // Cast pictures are read at many sizes on the surface: a copy with smaller versions of itself keeps them from shimmering.
            let copy = this.castCopies.get(key);
            if (copy?.signature !== drawn.signature) {
                if (!copy || copy.target.width !== drawn.image.width || copy.target.height !== drawn.image.height) {
                    copy?.target.dispose();
                    copy = {
                        signature: '',
                        target: new THREE.WebGLRenderTarget(drawn.image.width, drawn.image.height, {
                            type: drawn.image.kind === 'gray' ? THREE.HalfFloatType : THREE.UnsignedByteType,
                            format: THREE.RGBAFormat,
                            wrapS: THREE.RepeatWrapping,
                            wrapT: THREE.RepeatWrapping,
                            minFilter: THREE.LinearMipmapLinearFilter,
                            magFilter: THREE.LinearFilter,
                            generateMipmaps: true,
                            depthBuffer: false,
                            colorSpace: THREE.NoColorSpace,
                        }),
                    };
                }
                this.gpu.copy(drawn.image, copy.target);
                copy.signature = drawn.signature;
                this.castCopies.set(key, copy);
            }
            const image = this.cast(key, [drawn.signature], copy.target.texture, channel, tile, projection, { gray: drawn.image.kind === 'gray', srgb: false, rebuildNormal: false, channelRead: 0 });
            return { image, kind: 1, value: [0, 0, 0] };
        }
        const current = fill.kind === 'current' ? this.host.current[channel] : null;
        if (fill.kind === 'current' && Array.isArray(current)) return { image: null, kind: 3, value: current };
        const texture = fill.kind === 'texture' ? this.host.texture(fill.textureId) : current as THREE.Texture | null;
        if (!texture) return fill.kind === 'current' ? { image: null, kind: 3, value: CHANNEL_DEFAULT[channel] } : null;
        const projection: FillProjection = fill.kind === 'texture'
            ? { projection: fill.projection, scale: fill.scale, rotation: fill.rotation, sharpness: fill.sharpness }
            : { projection: 'uv', scale: 1, rotation: 0, sharpness: 4 };
        const image = this.cast(key, [texture.uuid, texture.version], texture, channel, tile, projection, {
            gray: false,
            srgb: texture.colorSpace === THREE.SRGBColorSpace,
            rebuildNormal: channel === 'normal' && fill.kind === 'current',
            channelRead: fill.kind === 'current' ? (channel === 'roughness' ? 1 : channel === 'metallic' ? 2 : 0) : 0,
        });
        return { image, kind: 1, value: [0, 0, 0] };
    }

    /** A picture laid onto this tile's texels along the UVs or from three sides, kept until its source or settings change. */
    private cast(key: string, source: unknown[], texture: THREE.Texture, channel: PaintChannel, tile: number, projection: FillProjection,
        read: { gray: boolean; srgb: boolean; rebuildNormal: boolean; channelRead: number }): GpuImage {
        const space = this.space();
        const signature = hashText(JSON.stringify([source, projection, read, channel, tile, this.size, space]));
        const cached = this.fills.get(key);
        if (cached?.signature === signature) return cached.image;
        if (cached) this.gpu.release(cached.image);
        // Height and normals keep their smooth steps; other channels are fine at 8 bits.
        const image = this.gpu.image(this.size, this.size, 'color', channel === 'height' || channel === 'normal' ? 16 : 8);
        this.raster.draw(image, tile, CAST, {
            uniforms: {
                uTexture: texture,
                uProjection: projection.projection === 'triplanar' ? 1 : 0,
                uScale: projection.scale,
                uRotation: projection.rotation,
                uSharpness: projection.sharpness,
                uSrgb: read.srgb ? 1 : 0,
                uGray: read.gray ? 1 : 0,
                uRebuildNormal: read.rebuildNormal ? 1 : 0,
                uNormalMap: channel === 'normal' ? 1 : 0,
                uChannel: read.channelRead,
                uCentre: new THREE.Vector3(...space.centre),
                uExtent: space.extent,
                uOffset: space.offset,
            },
            clear: [0, 0, 0, 1],
        });
        this.fills.set(key, { signature, image });
        return image;
    }

    // -----------------------------------------------------------------------
    // Masks
    // -----------------------------------------------------------------------

    /**
     * A layer's mask over an area (the area's size), worked out from its effects top to bottom; null when it
     * has none. `accs` hold what the layers below make of each channel, for effects that read them.
     */
    private async maskIn(layer: PaintLayer, area: Area, accs: ReadonlyMap<PaintChannel, GpuImage>): Promise<GpuImage | null> {
        const effects = (layer.mask ?? []).filter((effect) => effect.enabled);
        if (!effects.length) return null;
        let m = this.gpu.image(area.width, area.height, 'gray', 16);
        this.gpu.clear(m, [1, 1, 1, 1]);
        try {
            for (const effect of effects) m = await this.applyMaskEffect(layer, effect, area, accs, m);
        } catch (error) {
            this.gpu.release(m);
            throw error;
        }
        if (layer.id === this.watched) {
            // Kept whole for the mask view.
            let whole = this.watchedMasks.get(area.tile);
            if (!whole) {
                whole = this.gpu.image(this.size, this.size, 'gray', 16);
                this.gpu.clear(whole, [1, 1, 1, 1]);
                this.watchedMasks.set(area.tile, whole);
            }
            this.gpu.passNow(whole, { fragment: SHIFT, inputs: { source: m }, uniforms: { uAt: new THREE.Vector2(-area.rect.x0, -area.rect.y0) }, scissor: scissorOf(area.inner) });
        }
        return m;
    }

    private async applyMaskEffect(layer: PaintLayer, effect: MaskEffect, area: Area, accs: ReadonlyMap<PaintChannel, GpuImage>, m: GpuImage): Promise<GpuImage> {
        if (effect.kind === 'blur') {
            const { gaussianBlur } = await import('../graph/nodes/transform');
            const blurred = await gaussianBlur({ gpu: this.gpu }, m, (effect.radius ?? 0.005) * this.size / 3);
            const mixed = this.gpu.image(area.width, area.height, 'gray', 16);
            this.gpu.passNow(mixed, { fragment: 'uniform float uOpacity;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy); outColor = vec4(mix(texelFetch(a, p, 0).r, texelFetch(b, p, 0).r, uOpacity)); }', inputs: { a: m, b: blurred }, uniforms: { uOpacity: effect.opacity } });
            this.gpu.release(blurred);
            this.gpu.release(m);
            return mixed;
        }
        let src: GpuImage | null = null;
        let at = ORIGIN;
        let owned = false;
        if (effect.kind === 'paint') {
            const picture = this.existing(pictureKey(effect.id), area.tile);
            if (picture) {
                src = this.gpu.image(area.width, area.height, 'color', picture.precision);
                picture.drawInto(src, area.rect, [area.rect.x0, area.rect.y0]);
                owned = true;
            }
        }
        if (effect.kind === 'generator' && effect.graphId) {
            try {
                src = await this.graphOutput(effect.graphId, effect.output ?? 'custom', effect.values ?? {}, area.tile, `${layer.id}:${effect.id}`);
                at = area.at;
            } catch {
                src = null;
            }
        }
        if (effect.kind === 'below' && effect.channel) {
            const below = accs.get(effect.channel);
            if (below) {
                src = this.gpu.image(area.width, area.height, 'gray', 16);
                this.gpu.passNow(src, {
                    fragment: BELOW_VALUE,
                    inputs: { source: below },
                    uniforms: { uGray: below.kind === 'gray' ? 1 : 0, uEdges: effect.edges ? 1 : 0, uRange: new THREE.Vector2(effect.low ?? 0, effect.high ?? 1), uSlope: this.size / 64 },
                });
                owned = true;
            }
        }
        if ((effect.kind === 'paint' || effect.kind === 'generator' || effect.kind === 'below') && !src) return m;
        const next = this.gpu.image(area.width, area.height, 'gray', 16);
        this.gpu.passNow(next, {
            fragment: MASK_STEP,
            inputs: { acc: m, src: src ?? this.gpu.constant('black') },
            uniforms: {
                uKind: MASK_KINDS[effect.kind],
                uBlend: MASK_BLENDS[effect.blend] ?? 0,
                uOpacity: effect.opacity,
                uValue: effect.value ?? 1,
                uLevels: new THREE.Vector3(effect.low ?? 0, effect.high ?? 1, effect.mid ?? 0.5),
                uSrcAt: at,
            },
        });
        if (owned) this.gpu.release(src);
        this.gpu.release(m);
        return next;
    }

    // -----------------------------------------------------------------------
    // Results
    // -----------------------------------------------------------------------

    /** The finished channels of a tile, as a texture graph's outputs would be (for making pictures). */
    channelImages(tile: number): ChannelImages {
        const outputs = this.outputs.get(tile) ?? {};
        const images: ChannelImages = {};
        if (outputs.baseColor) images.baseColor = outputs.baseColor;
        if (outputs.normal) images.normal = outputs.normal;
        if (outputs.roughness) images.roughness = outputs.roughness;
        if (outputs.metallic) images.metallic = outputs.metallic;
        if (outputs.height) images.height = outputs.height;
        if (outputs.emissive) images.emissive = outputs.emissive;
        if (outputs.opacity) images.opacity = outputs.opacity;
        if (outputs.ambientOcclusion) images.ambientOcclusion = outputs.ambientOcclusion;
        return images;
    }

    /** Coverage of a tile: where the surface is. */
    coverage(tile: number): GpuImage | null {
        return this.padding.get(tile)?.coverage ?? null;
    }

    dispose(): void {
        for (const outputs of this.outputs.values()) for (const image of Object.values(outputs)) this.gpu.release(image);
        for (const image of this.detail.values()) this.gpu.release(image);
        for (const byTile of this.pictures.values()) for (const picture of byTile.values()) picture.dispose();
        for (const cached of this.fills.values()) this.gpu.release(cached.image);
        for (const image of this.watchedMasks.values()) this.gpu.release(image);
        for (const evaluator of this.evaluators.values()) evaluator.dispose();
        for (const copy of this.castCopies.values()) copy.target.dispose();
        this.castCopies.clear();
        for (const padding of this.padding.values()) { this.gpu.release(padding.coverage); this.gpu.release(padding.nearest); }
        if (this.bake) for (const result of this.bake.values()) releaseTileBake(this.gpu, result);
        this.raster.dispose();
        this.outputs.clear();
        this.detail.clear();
        this.pictures.clear();
        this.watchedMasks.clear();
        this.listeners.clear();
    }
}
