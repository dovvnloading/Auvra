import * as THREE from 'three';
import { blendModeIndex } from '../gpu/glslLibrary';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { graphContentKey, hashText } from '../graph/document';
import { TextureGraphEvaluator, type ExternalImage } from '../graph/evaluator';
import { MESH_MAPS, OUTPUT_NODE_TYPE, meshMapKey, type MeshMapName } from '../graph/nodes/io';
import { jumpFlood } from '../graph/nodes/distance';
import type { GraphResolver } from '../graph/registry';
import { BAKE_VERSION, padImage, releaseTileBake, spaceOfBox, type PositionSpace, type TileBake } from '../bake/meshBaker';
import { UvRaster } from '../bake/uvRaster';
import type { PartMesh } from '../mesh/partMesh';
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

/**
 * A PAINTED TEXTURE SET AT WORK
 *
 * Holds a texture set's pictures on the GPU (painted pixels, painted masks, baked mesh maps) and
 * puts its layers together into one picture per channel per tile:
 *   - each layer's value comes from its painted pixels (value and coverage) or its fill;
 *   - its mask is worked out from its effects;
 *   - it is blended over what is below by its channel's mode and opacity (normals are laid over one
 *     another, keeping both);
 *   - folders put their own layers together first and are laid over by their mask and opacity.
 * Finished channels are padded past the islands so filtering never shows a seam. The normal the model
 * draws with is the baked normal with the painted normal detail and the slopes of painted height laid
 * over it.
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

const COMPOSE = /* glsl */ `
uniform int uGrayAcc;
uniform int uSrcKind;
uniform vec3 uValue;
uniform int uHasMask;
uniform float uOpacity;
uniform int uMode;
uniform int uNormal;
vec3 rnm(vec3 base, vec3 detail) {
    vec3 t = base + vec3(0.0, 0.0, 1.0);
    vec3 u = detail * vec3(-1.0, -1.0, 1.0);
    return t * dot(t, u) / max(t.z, 1e-4) - u;
}
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 a = texelFetch(acc, p, 0);
    if (uGrayAcc == 1) a = vec4(a.rrr, 1.0);
    // 0: a painted picture (value and coverage), 1: a colour image, 2: a grey image, 3: one value.
    vec4 s = uSrcKind == 3 ? vec4(uValue, 1.0) : texelFetch(src, p, 0);
    if (uSrcKind == 2) s = vec4(s.rrr, 1.0);
    if (uSrcKind == 1) s.a = 1.0;
    float m = uHasMask == 1 ? texelFetch(mask, p, 0).r : 1.0;
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

const MASK_STEP = /* glsl */ `
uniform int uKind;
uniform int uBlend;
uniform float uOpacity;
uniform float uValue;
uniform vec3 uLevels;
uniform int uSrcGray;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float m = texelFetch(acc, p, 0).r;
    if (uKind == 3) { // levels: low, high, mid
        float t = saturate((m - uLevels.x) / max(uLevels.y - uLevels.x, 1e-5));
        outColor = vec4(mix(m, pow(t, log(0.5) / log(clamp(uLevels.z, 0.01, 0.99))), uOpacity));
        return;
    }
    if (uKind == 5) { outColor = vec4(mix(m, 1.0 - m, uOpacity)); return; }
    float e = uKind == 1 ? uValue : texelFetch(src, p, 0).r;
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

const MASK_KINDS = { paint: 0, fill: 1, generator: 2, levels: 3, blur: 4, invert: 5 } as const;
const MASK_BLENDS = { multiply: 0, add: 1, subtract: 2, replace: 3, max: 4, min: 5 } as const;

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

interface Cached { signature: string; image: GpuImage }

export class PaintStack {
    readonly size: number;
    readonly raster: UvRaster;
    readonly tiles: number[];
    document: PaintDocument;
    bake: Map<number, TileBake> | null = null;
    /** The size (power of two) the baked maps were made at, when it differs from the set's. */
    bakeSize: number | null = null;
    /** Why the layers could not be put together last time, or null. */
    problem: string | null = null;
    /** Coverage and nearest-covered maps per tile, for padding (from the bake, or worked out on opening). */
    private padding = new Map<number, { coverage: GpuImage; nearest: GpuImage }>();
    /** Painted pictures by key, then tile. */
    readonly pictures = new Map<string, Map<number, GpuImage>>();
    /** Pictures changed since they were last kept, as `key|tile`. */
    readonly unsaved = new Set<string>();
    readonly outputs = new Map<number, TileOutputs>();
    private readonly fills = new Map<string, Cached>();
    /** Graph pictures copied with smaller versions of themselves, for casting. */
    private readonly castCopies = new Map<string, { signature: string; target: THREE.WebGLRenderTarget }>();
    private readonly masks = new Map<string, Cached>();
    private readonly evaluators = new Map<string, TextureGraphEvaluator>();
    private readonly listeners = new Set<() => void>();
    version = 0;
    /** Channels to put together again on the next compose (all when null). */
    private stale: Set<PaintChannel> | null = null;
    private composing: Promise<void> | null = null;
    private again = false;
    /** Bumped when a fill or mask source outside the document changes (a re-bake, a picture loading). */
    sourcesVersion = 0;

    private constructor(readonly host: StackHost, readonly part: PartMesh, document: PaintDocument) {
        this.document = document;
        this.size = 2 ** document.size;
        this.tiles = part.tiles;
        this.raster = new UvRaster(host.gpu, part);
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

    // -----------------------------------------------------------------------
    // Pictures
    // -----------------------------------------------------------------------

    private async loadPictures(): Promise<void> {
        const load = async (key: string, pictures: TilePictures | undefined) => {
            for (const [tileName, picture] of Object.entries(pictures ?? {})) {
                const tile = Number(tileName);
                if (!this.tiles.includes(tile) || !picture?.assetId) continue;
                try {
                    const blob = await this.host.fetchPicture(picture.assetId);
                    let texture: THREE.Texture;
                    let width: number;
                    let height: number;
                    let bitmap: ImageBitmap | null = null;
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
                    const image = this.picture(key, tile);
                    // Kept at another size (the set was resized): scaled with the colour of see-through
                    // pixels left out, so stroke edges do not darken.
                    const fragment = width === this.size && height === this.size ? 'void main() { outColor = texture(source, vUv); }' : RESAMPLE;
                    this.gpu.passNow(image, { fragment, inputs: { source: texture } });
                    texture.dispose();
                    bitmap?.close();
                } catch {
                    // A picture that will not read leaves the layer empty rather than the set unopenable.
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

    /** The picture for `key` on `tile`, made empty (or filled with `fill`) the first time. */
    picture(key: string, tile: number, fill: [number, number, number, number] = [0, 0, 0, 0]): GpuImage {
        let byTile = this.pictures.get(key);
        if (!byTile) this.pictures.set(key, byTile = new Map());
        let image = byTile.get(tile);
        if (!image) {
            image = this.gpu.image(this.size, this.size, 'color', picturePrecision(key));
            this.gpu.clear(image, fill);
            byTile.set(tile, image);
        }
        return image;
    }

    hasPicture(key: string, tile: number): boolean {
        return Boolean(this.pictures.get(key)?.get(tile));
    }

    /** Lets go of a picture (its layer or effect is gone and out of the undo history). */
    dropPictures(key: string): void {
        const byTile = this.pictures.get(key);
        if (!byTile) return;
        for (const image of byTile.values()) this.gpu.release(image);
        this.pictures.delete(key);
    }

    /** A mask effect painted fully white or black to start with. */
    startMaskPicture(effectId: string, white: boolean): void {
        for (const tile of this.tiles) this.picture(pictureKey(effectId), tile, white ? [1, 1, 1, 1] : [0, 0, 0, 1]);
        for (const tile of this.tiles) this.unsaved.add(`${pictureKey(effectId)}|${tile}`);
    }

    /**
     * Keeps every changed picture as an asset and returns the document naming them. Pictures are
     * written bottom row first, as they are drawn, and read back the same way.
     */
    async keepPictures(): Promise<PaintDocument> {
        const stored = new Map<string, string>();
        for (const entry of [...this.unsaved]) {
            const [key, tileName] = entry.split('|');
            const image = this.pictures.get(key)?.get(Number(tileName));
            // Marked kept as its pixels are read: a stroke landing while they are stored marks it again.
            this.unsaved.delete(entry);
            if (!image) continue;
            // Half-float pictures are kept as 16-bit PNGs, the rest at 8 bits.
            const encoded = image.precision === 8
                ? encodePng(this.gpu.readRgba8(image, this.size, this.size, 'raw', false), this.size, this.size)
                : encodePng16(this.gpu.readUint16(image, this.size, this.size, 'color', false), this.size, this.size, 4);
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
                let blob: Blob;
                if (FINE_MAPS.has(name as MeshMapName)) {
                    // 8 bits would step these in 1/255ths: noise and triplanar masks read from them would turn
                    // blocky, and normals and occlusion would band once lit. Read a strip at a time.
                    const gray = image.kind === 'gray';
                    blob = await encodePng16(this.gpu.readUint16(image, image.width, image.height, gray ? 'gray' : 'color', false), image.width, image.height, gray ? 1 : 4);
                } else {
                    blob = await encodePng(this.gpu.readRgba8(image, this.size, this.size, image.kind === 'gray' ? 'gray' : 'raw', false), this.size, this.size);
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

    /** Marks channels (all when none are named) to be put together again, and does so soon. */
    invalidate(channels?: readonly PaintChannel[]): void {
        if (!channels) this.stale = null;
        else if (this.stale) for (const channel of channels) this.stale.add(channel);
        // A failure is shown through `problem`.
        this.compose().catch(() => undefined);
    }

    /** Puts the stale channels together; calls made meanwhile run once more afterwards. */
    compose(): Promise<void> {
        if (this.composing) {
            this.again = true;
            return this.composing;
        }
        this.composing = (async () => {
            try {
                do {
                    this.again = false;
                    this.prune();
                    const channels = this.stale ? [...this.stale] : [...PAINT_CHANNELS];
                    this.stale = new Set();
                    for (const tile of this.tiles) await this.composeTile(tile, channels);
                    this.problem = null;
                    this.emit();
                } while (this.again);
            } catch (error) {
                // Put together in full next time, once whatever failed (a graph a fill draws from, say) is put right.
                this.stale = null;
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
        for (const [key, cached] of this.masks) if (!live.has(owner(key))) { this.gpu.release(cached.image); this.masks.delete(key); }
        for (const [key, copy] of this.castCopies) if (!live.has(owner(key))) { copy.target.dispose(); this.castCopies.delete(key); }
    }

    private async composeTile(tile: number, channels: readonly PaintChannel[]): Promise<void> {
        const outputs = this.outputs.get(tile) ?? {};
        this.outputs.set(tile, outputs);
        const enabled = this.document.channels;
        // Normal comes last: it is built on the height just made.
        const ordered = [...channels].sort((a, b) => Number(a === 'normal') - Number(b === 'normal'));
        for (const channel of ordered) {
            if (!enabled.includes(channel) && channel !== 'normal') {
                this.gpu.release(outputs[channel]);
                delete outputs[channel];
                continue;
            }
            const result = await this.composeChannel(tile, channel);
            const padding = this.padding.get(tile)!;
            const padded = padImage(this.gpu, result, padding.coverage, padding.nearest);
            this.gpu.release(result);
            if (channel === 'normal') {
                const finished = this.finalNormal(tile, padded, outputs.height ?? null);
                this.gpu.release(padded);
                this.gpu.release(outputs.normal);
                outputs.normal = finished;
            } else {
                this.gpu.release(outputs[channel]);
                outputs[channel] = padded;
            }
            if (channel === 'height' && !channels.includes('normal')) await this.composeTile(tile, ['normal']);
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

    /** One channel of one tile: every visible layer touching it, blended bottom up. */
    private async composeChannel(tile: number, channel: PaintChannel): Promise<GpuImage> {
        const gray = !CHANNEL_IS_COLOR[channel];
        let acc = this.gpu.image(this.size, this.size, gray ? 'gray' : 'color', 16);
        const base = CHANNEL_DEFAULT[channel];
        this.gpu.clear(acc, [base[0], base[1], base[2], 1]);
        acc = await this.composeLayers(this.document.layers, tile, channel, acc);
        return acc;
    }

    private async composeLayers(layers: readonly PaintLayer[], tile: number, channel: PaintChannel, acc: GpuImage): Promise<GpuImage> {
        const gray = !CHANNEL_IS_COLOR[channel];
        for (const layer of layers) {
            if (!layer.visible) continue;
            if (layer.kind === 'folder') {
                if (!allLayers(layer.layers ?? []).some((inner) => inner.visible && inner.channels[channel])) continue;
                const start = this.gpu.image(acc.width, acc.height, acc.kind, 16);
                this.gpu.copy(acc, start);
                const inside = await this.composeLayers(layer.layers ?? [], tile, channel, start);
                const mask = await this.maskOf(layer, tile);
                const next = this.gpu.image(acc.width, acc.height, acc.kind, 16);
                this.gpu.passNow(next, {
                    fragment: `uniform int uHasMask;\nuniform float uOpacity;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy); float m = (uHasMask == 1 ? texelFetch(mask, p, 0).r : 1.0) * uOpacity; outColor = mix(texelFetch(below, p, 0), texelFetch(above, p, 0), m); }`,
                    inputs: { below: acc, above: inside, mask: mask ?? this.gpu.constant('white') },
                    uniforms: { uHasMask: mask ? 1 : 0, uOpacity: layer.opacity ?? 1 },
                });
                this.gpu.release(acc);
                this.gpu.release(inside);
                acc = next;
                continue;
            }
            const blend = layer.channels[channel];
            if (!blend || blend.opacity <= 0) continue;
            let source: { image: GpuImage | THREE.Texture | null; kind: number; value: [number, number, number] } | null = null;
            if (layer.kind === 'paint') {
                const picture = this.pictures.get(pictureKey(layer.id, channel))?.get(tile);
                if (!picture) continue;
                source = { image: picture, kind: 0, value: [0, 0, 0] };
            } else {
                const fill = layer.fill?.[channel];
                if (!fill) continue;
                source = await this.fillOf(layer.id, channel, fill, tile);
                if (!source) continue;
            }
            const mask = await this.maskOf(layer, tile);
            const next = this.gpu.image(acc.width, acc.height, acc.kind, 16);
            this.gpu.passNow(next, {
                fragment: COMPOSE,
                inputs: { acc, src: source.image ?? this.gpu.constant('black'), mask: mask ?? this.gpu.constant('white') },
                uniforms: {
                    uGrayAcc: gray ? 1 : 0,
                    uSrcKind: source.kind,
                    uValue: new THREE.Vector3(...source.value),
                    uHasMask: mask ? 1 : 0,
                    uOpacity: blend.opacity,
                    uMode: blend.mode === 'normalCombine' ? 1 : blendModeIndex(blend.mode),
                    uNormal: channel === 'normal' ? 1 : 0,
                },
            });
            this.gpu.release(acc);
            acc = next;
        }
        return acc;
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

    private async fillOf(layerId: string, channel: PaintChannel, fill: FillSource, tile: number): Promise<{ image: GpuImage | THREE.Texture | null; kind: number; value: [number, number, number] } | null> {
        if (fill.kind === 'value') return { image: null, kind: 3, value: fill.value };
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
        if (fill.kind === 'current') {
            // Carried onto this layout when the surface was laid out afresh: read as it is.
            const carried = this.pictures.get(pictureKey(BEFORE, channel))?.get(tile);
            if (carried) {
                const stale = this.fills.get(key);
                if (stale) { this.gpu.release(stale.image); this.fills.delete(key); }
                return { image: carried, kind: 1, value: [0, 0, 0] };
            }
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

    /** A layer's mask on a tile, worked out from its effects; null when it has none. */
    async maskOf(layer: PaintLayer, tile: number): Promise<GpuImage | null> {
        const effects = (layer.mask ?? []).filter((effect) => effect.enabled);
        if (!effects.length) return null;
        const key = `${layer.id}:${tile}`;
        const pictureVersions = effects.map((effect) => (effect.kind === 'paint' ? this.pictureVersion(pictureKey(effect.id), tile) : 0));
        // A smart mask's graph (one of the project's, say) changing redraws the mask too.
        const graphs = effects.map((effect) => {
            if (effect.kind !== 'generator' || !effect.graphId) return '';
            const entry = this.host.resolveGraph(effect.graphId);
            return entry ? graphContentKey(entry.graph, this.host.resolveGraph, (id) => Boolean(this.host.texture(id))) : 'missing';
        });
        const signature = hashText(JSON.stringify([effects.map(({ pictures: _pictures, ...rest }) => rest), pictureVersions, graphs, this.sourcesVersion]));
        const cached = this.masks.get(key);
        if (cached?.signature === signature) return cached.image;
        let m = this.gpu.image(this.size, this.size, 'gray', 16);
        this.gpu.clear(m, [1, 1, 1, 1]);
        for (const effect of effects) m = await this.applyMaskEffect(layer, effect, tile, m);
        if (cached) this.gpu.release(cached.image);
        this.masks.set(key, { signature, image: m });
        return m;
    }

    /** A layer's mask on a tile as last worked out (for showing it), without working it out again. */
    cachedMask(layerId: string, tile: number): GpuImage | null {
        return this.masks.get(`${layerId}:${tile}`)?.image ?? null;
    }

    private readonly versions = new Map<string, number>();

    /** Marks a picture as changed (by painting), so masks and composites built on it are redone. */
    touch(key: string, tile: number): void {
        this.versions.set(`${key}|${tile}`, (this.versions.get(`${key}|${tile}`) ?? 0) + 1);
        this.unsaved.add(`${key}|${tile}`);
    }

    private pictureVersion(key: string, tile: number): number {
        return this.versions.get(`${key}|${tile}`) ?? 0;
    }

    private async applyMaskEffect(layer: PaintLayer, effect: MaskEffect, tile: number, m: GpuImage): Promise<GpuImage> {
        if (effect.kind === 'blur') {
            const { gaussianBlur } = await import('../graph/nodes/transform');
            const blurred = await gaussianBlur({ gpu: this.gpu }, m, (effect.radius ?? 0.005) * this.size / 3);
            const mixed = this.gpu.image(this.size, this.size, 'gray', 16);
            this.gpu.passNow(mixed, { fragment: 'uniform float uOpacity;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy); outColor = vec4(mix(texelFetch(a, p, 0).r, texelFetch(b, p, 0).r, uOpacity)); }', inputs: { a: m, b: blurred }, uniforms: { uOpacity: effect.opacity } });
            this.gpu.release(blurred);
            this.gpu.release(m);
            return mixed;
        }
        let src: GpuImage | null = null;
        if (effect.kind === 'paint') src = this.pictures.get(pictureKey(effect.id))?.get(tile) ?? null;
        if (effect.kind === 'generator' && effect.graphId) {
            try {
                src = await this.graphOutput(effect.graphId, effect.output ?? 'custom', effect.values ?? {}, tile, `${layer.id}:${effect.id}`);
            } catch {
                src = null;
            }
        }
        if ((effect.kind === 'paint' || effect.kind === 'generator') && !src) return m;
        const next = this.gpu.image(this.size, this.size, 'gray', 16);
        this.gpu.passNow(next, {
            fragment: MASK_STEP,
            inputs: { acc: m, src: src ?? this.gpu.constant('black') },
            uniforms: {
                uKind: MASK_KINDS[effect.kind],
                uBlend: MASK_BLENDS[effect.blend] ?? 0,
                uOpacity: effect.opacity,
                uValue: effect.value ?? 1,
                uLevels: new THREE.Vector3(effect.low ?? 0, effect.high ?? 1, effect.mid ?? 0.5),
                uSrcGray: src?.kind === 'gray' ? 1 : 0,
            },
        });
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
        for (const byTile of this.pictures.values()) for (const image of byTile.values()) this.gpu.release(image);
        for (const cached of [...this.fills.values(), ...this.masks.values()]) this.gpu.release(cached.image);
        for (const evaluator of this.evaluators.values()) evaluator.dispose();
        for (const copy of this.castCopies.values()) copy.target.dispose();
        this.castCopies.clear();
        for (const padding of this.padding.values()) { this.gpu.release(padding.coverage); this.gpu.release(padding.nearest); }
        if (this.bake) for (const result of this.bake.values()) releaseTileBake(this.gpu, result);
        this.raster.dispose();
        this.outputs.clear();
        this.pictures.clear();
        this.listeners.clear();
    }
}
