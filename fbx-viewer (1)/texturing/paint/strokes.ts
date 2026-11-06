import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { CHANNEL_IS_COLOR, type PaintChannel, type PaintDocument } from './paintTypes';
import { pictureKey, type PaintStack } from './paintStack';

/**
 * BRUSH STROKES
 *
 * A stroke gathers dabs into a stroke mask per tile, then lays the brush's values onto its pictures
 * through that mask. Each dab is worked out for every texel of the surface from the texel's place on
 * the model, so a dab reaching across a UV seam paints both sides of it and no seam shows.
 *
 *   - Screen projection: the dab is a shape on the screen, cast onto what the eye sees (texels hidden
 *     behind other parts of the model, or facing away, are left alone).
 *   - Surface: the dab is a disc lying on the surface where the pointer meets it, so it wraps round
 *     edges and reaches places the eye cannot see.
 *   - Mirrored across any of the model's X, Y and Z middles.
 *
 * Dabs within one stroke build up to the stroke's opacity and no further, however often they cross.
 * Undo keeps only the 32×32 blocks of each picture the stroke touched, before and after.
 */

export type BrushShape = 'round' | 'square' | 'picture';
export type BrushProjection = 'screen' | 'surface';

export interface BrushSettings {
    /** Radius in screen pixels. */
    size: number;
    hardness: number;
    flow: number;
    opacity: number;
    /** Distance between dabs as a share of the brush's width. */
    spacing: number;
    /** Degrees. */
    angle: number;
    followStroke: boolean;
    angleJitter: number;
    sizeJitter: number;
    scatter: number;
    flowJitter: number;
    pressureSize: boolean;
    pressureFlow: boolean;
    shape: BrushShape;
    /** A picture from the library for the 'picture' shape (its brightness). */
    alphaTexture: string;
    projection: BrushProjection;
    /** Texels facing away by more than this many degrees are not painted. */
    facingLimit: number;
    symmetry: { x: boolean; y: boolean; z: boolean };
    stencil: { enabled: boolean; textureId: string; scale: number; rotation: number; offsetX: number; offsetY: number; opacity: number };
    /** What the brush lays down on each channel. */
    values: Record<PaintChannel, [number, number, number]>;
    /** Channels the brush paints on. */
    channels: PaintChannel[];
    /** For masks: the grey painted. */
    maskValue: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
    size: 40,
    hardness: 0.6,
    flow: 0.8,
    opacity: 1,
    spacing: 0.15,
    angle: 0,
    followStroke: false,
    angleJitter: 0,
    sizeJitter: 0,
    scatter: 0,
    flowJitter: 0,
    pressureSize: true,
    pressureFlow: false,
    shape: 'round',
    alphaTexture: '',
    projection: 'screen',
    facingLimit: 85,
    symmetry: { x: false, y: false, z: false },
    stencil: { enabled: false, textureId: '', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, opacity: 1 },
    values: {
        baseColor: [0.72, 0.18, 0.12], roughness: [0.45, 0.45, 0.45], metallic: [0, 0, 0], height: [0.6, 0.6, 0.6],
        normal: [0.5, 0.5, 1], emissive: [1, 0.5, 0.1], opacity: [1, 1, 1],
    },
    channels: ['baseColor', 'roughness', 'metallic'],
    maskValue: 1,
};

/** One dab: on the screen (pixels from the top left) and, for surface brushes, its place on the model. */
export interface Dab {
    x: number;
    y: number;
    radius: number;
    angle: number;
    flow: number;
    point?: THREE.Vector3;
    normal?: THREE.Vector3;
    worldRadius?: number;
}

/** What a stroke paints on. */
export type StrokeTarget =
    | { kind: 'layer'; layerId: string; channels: PaintChannel[] }
    | { kind: 'mask'; effectId: string };

export interface StrokeView {
    /** Model space to clip space. */
    viewProjection: THREE.Matrix4;
    cameraPosition: THREE.Vector3;
    /** The screen's right and up, in model space: what a surface brush's angle turns from. */
    cameraRight?: THREE.Vector3;
    cameraUp?: THREE.Vector3;
    /** Viewport size in pixels. */
    width: number;
    height: number;
    /** Each pixel's distance from the camera (from renderDepth), so hidden texels stay unpainted. */
    depth: GpuImage | null;
    /** Pixels from the camera to where the brush meets the surface, for surface brush sizes. */
    perspective: number;
}

const MAX_DABS = 16;

const DAB_SHADER = /* glsl */ `
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform sampler2D uDepth;
uniform int uHasDepth;
uniform vec3 uCamera;
uniform vec4 uDabs[${MAX_DABS}];
uniform vec4 uDabs2[${MAX_DABS}];
uniform vec4 uDabs3[${MAX_DABS}];
uniform int uCount;
uniform int uProjection;
uniform int uShape;
uniform float uHardness;
uniform sampler2D uAlpha;
uniform int uAlphaSrgb;
uniform float uFacing;
uniform vec3 uSymmetry;
uniform vec3 uCentre;
uniform sampler2D uStencil;
uniform int uHasStencil;
uniform vec4 uStencilPlace;
uniform float uStencilAngle;
uniform float uStencilOpacity;
uniform int uIsland;

float shapeAt(vec2 local, float radiusPixels) {
    float r = uShape == 1 ? max(abs(local.x), abs(local.y)) : length(local);
    if (r > 1.0) return 0.0;
    // At least a pixel and a half of soft edge, so a hard brush still has a clean rim.
    float edge = max(1.0 - uHardness, 1.5 / max(radiusPixels, 1.0));
    float a = smoothstep(1.0, 1.0 - edge, r);
    if (uShape == 2) {
        vec4 c = texture(uAlpha, local * 0.5 + 0.5);
        if (uAlphaSrgb == 1) c.rgb = linearToSrgb(c.rgb);
        a *= luma(c.rgb) * c.a;
    }
    return a;
}

float coverageAt(vec3 p, vec3 n) {
    float facing = dot(n, normalize(uCamera - p));
    if (uProjection == 0) {
        if (facing < uFacing) return 0.0;
        vec4 clip = uViewProj * vec4(p, 1.0);
        if (clip.w <= 0.0) return 0.0;
        vec3 ndc = clip.xyz / clip.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return 0.0;
        vec2 screen = vec2((ndc.x * 0.5 + 0.5) * uViewport.x, (0.5 - ndc.y * 0.5) * uViewport.y);
        if (uHasDepth == 1) {
            float seen = texture(uDepth, vec2(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5)).r;
            // A little leeway, so the visible surface itself is never taken for something in front of it.
            if (clip.w > seen * 1.004 + 1e-4) return 0.0;
        }
        float a = 0.0;
        for (int i = 0; i < ${MAX_DABS}; i++) {
            if (i >= uCount) break;
            vec4 d = uDabs[i];
            vec2 local = rotate2(-d.w) * (screen - d.xy) / d.z;
            local.y = -local.y;
            float s = shapeAt(local, d.z) * uDabs2[i].x;
            a = 1.0 - (1.0 - a) * (1.0 - s);
        }
        if (uHasStencil == 1) {
            vec2 sp = rotate2(-uStencilAngle) * ((screen - uStencilPlace.xy) / uStencilPlace.zw) + 0.5;
            vec4 c = texture(uStencil, sp);
            float inside = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
            a *= mix(1.0, luma(c.rgb) * c.a * inside, uStencilOpacity);
        }
        return a * smoothstep(uFacing, uFacing + 0.15, facing);
    }
    float a = 0.0;
    for (int i = 0; i < ${MAX_DABS}; i++) {
        if (i >= uCount) break;
        vec3 centre = uDabs[i].xyz;
        float radius = uDabs[i].w;
        vec3 dn = normalize(uDabs2[i].yzw);
        if (dot(n, dn) < 0.1) continue;
        vec3 d = p - centre;
        if (abs(dot(d, dn)) > radius) continue;
        vec3 across = uDabs3[i].xyz - dn * dot(uDabs3[i].xyz, dn);
        // Seen edge on, the screen's direction lies along the normal: any direction on the surface will do.
        if (dot(across, across) < 1e-8) across = abs(dn.x) < 0.9 ? cross(dn, vec3(1.0, 0.0, 0.0)) : cross(dn, vec3(0.0, 1.0, 0.0));
        vec3 t = normalize(across);
        vec3 b = cross(dn, t);
        vec2 local = vec2(dot(d, t), dot(d, b)) / radius;
        float s = shapeAt(local, radius * uDabs3[i].w) * uDabs2[i].x;
        a = 1.0 - (1.0 - a) * (1.0 - s);
    }
    return a;
}

void main() {
    if (uIsland >= 0 && int(vIds.x + 0.5) != uIsland) { outColor = vec4(0.0); return; }
    vec3 n = normalize(vNormal);
    float a = uIsland >= 0 ? 1.0 : coverageAt(vPos, n);
    // Mirrored copies: the texel is painted where its mirror image would be.
    for (int axis = 0; axis < 3; axis++) {
        if (uSymmetry[axis] < 0.5 || uIsland >= 0) continue;
        vec3 m = vec3(1.0);
        m[axis] = -1.0;
        float b = coverageAt(uCentre + (vPos - uCentre) * m, n * m);
        a = 1.0 - (1.0 - a) * (1.0 - b);
        for (int other = axis + 1; other < 3; other++) {
            if (uSymmetry[other] < 0.5) continue;
            vec3 mm = m;
            mm[other] = -1.0;
            float c = coverageAt(uCentre + (vPos - uCentre) * mm, n * mm);
            a = 1.0 - (1.0 - a) * (1.0 - c);
        }
    }
    // Mirrored across all three at once: the eighth copy.
    if (uIsland < 0 && uSymmetry.x > 0.5 && uSymmetry.y > 0.5 && uSymmetry.z > 0.5) {
        float e = coverageAt(uCentre - (vPos - uCentre), -n);
        a = 1.0 - (1.0 - a) * (1.0 - e);
    }
    outColor = vec4(a);
}`;

/** One batch's coverage laid over what the stroke has gathered so far (blended: batch + mask × (1 − batch)). */
const GATHER_SHADER = /* glsl */ `
void main() { outColor = vec4(texelFetch(batch, ivec2(gl_FragCoord.xy), 0).r); }`;

const APPLY_SHADER = /* glsl */ `
uniform int uErase;
uniform int uMask;
uniform vec3 uValue;
uniform float uOpacity;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 b = texelFetch(before, p, 0);
    float c = clamp(texelFetch(stroke, p, 0).r * uOpacity, 0.0, 1.0);
    if (uMask == 1) {
        outColor = vec4(vec3(mix(b.r, uErase == 1 ? 0.0 : uValue.x, c)), 1.0);
        return;
    }
    if (uErase == 1) { outColor = vec4(b.rgb, b.a * (1.0 - c)); return; }
    float alpha = b.a + c * (1.0 - b.a);
    vec3 value = alpha > 0.0 ? (b.rgb * b.a * (1.0 - c) + uValue * c) / alpha : uValue;
    outColor = vec4(value, alpha);
}`;

/** Each pixel's distance from the camera, for telling what the eye sees. */
export const renderDepth = (gpu: TextureGpu, scene: THREE.Object3D, camera: THREE.Camera, width: number, height: number, into?: GpuImage | null): GpuImage => {
    const target = into && into.width === width && into.height === height ? into : gpu.image(width, height, 'gray', 32);
    if (into && into !== target) gpu.release(into);
    const material = depthMaterial();
    const holder = new THREE.Scene();
    holder.overrideMaterial = material;
    const parent = scene.parent;
    holder.add(scene);
    const renderer = gpu.renderer;
    const previous = renderer.getRenderTarget();
    const depthTarget = depthBuffered(target);
    renderer.setRenderTarget(depthTarget);
    renderer.setClearColor(0x000000, 1);
    const color = renderer.getClearColor(new THREE.Color());
    renderer.setClearColor(new THREE.Color(1e9, 1e9, 1e9), 1);
    renderer.clear(true, true, false);
    renderer.setClearColor(color, 1);
    renderer.render(holder, camera);
    renderer.setRenderTarget(previous);
    holder.remove(scene);
    if (parent) parent.add(scene);
    gpu.passNow(target, { fragment: 'void main() { outColor = vec4(texelFetch(source, ivec2(gl_FragCoord.xy), 0).r); }', inputs: { source: depthTarget.texture } });
    return target;
};

let sharedDepthMaterial: THREE.RawShaderMaterial | null = null;
const depthMaterial = (): THREE.RawShaderMaterial => {
    if (sharedDepthMaterial) return sharedDepthMaterial;
    sharedDepthMaterial = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `precision highp float;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nin vec3 position;\nout float vDepth;\nvoid main() { vec4 view = modelViewMatrix * vec4(position, 1.0); vDepth = -view.z; gl_Position = projectionMatrix * view; }`,
        fragmentShader: `precision highp float;\nin float vDepth;\nout vec4 outColor;\nvoid main() { outColor = vec4(vDepth); }`,
        side: THREE.DoubleSide,
    });
    return sharedDepthMaterial;
};

/** A float target with a depth buffer the size of `like` (kept between strokes). */
let depthScratch: THREE.WebGLRenderTarget | null = null;
const depthBuffered = (like: GpuImage): THREE.WebGLRenderTarget => {
    if (depthScratch && depthScratch.width === like.width && depthScratch.height === like.height) return depthScratch;
    depthScratch?.dispose();
    depthScratch = new THREE.WebGLRenderTarget(like.width, like.height, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    return depthScratch;
};

/** Random in 0..1 that is the same for the same dab of the same stroke. */
const random = (seed: number): number => {
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
};

/** A block of a picture's pixels, bottom row first: bytes for 8-bit pictures, half floats for half-float ones. */
export type BlockPixels = Uint8Array | Uint16Array;

export interface PixelPatch {
    key: string;
    tile: number;
    rects: Array<{ x: number; y: number; width: number; height: number; before: BlockPixels; after: BlockPixels | null }>;
}

export interface HistoryEntry {
    label: string;
    document?: { before: PaintDocument; after: PaintDocument };
    pixels?: PixelPatch[];
}

/** Bytes of pixels an undo step holds. */
export const historyBytes = (entry: HistoryEntry): number => {
    let bytes = 0;
    for (const patch of entry.pixels ?? []) for (const rect of patch.rects) bytes += rect.before.byteLength + (rect.after?.byteLength ?? 0);
    return bytes;
};

/**
 * The past steps to keep: at most `steps` of them, and few enough that the pixels of every step kept,
 * past and future, fit in `bytes`. The oldest go first; the newest past step always stays.
 */
export const trimmedHistory = (past: readonly HistoryEntry[], future: readonly HistoryEntry[], steps: number, bytes: number): HistoryEntry[] => {
    const kept = past.length > steps ? past.slice(past.length - steps) : [...past];
    let total = 0;
    for (const entry of kept) total += historyBytes(entry);
    for (const entry of future) total += historyBytes(entry);
    let first = 0;
    while (total > bytes && kept.length - first > 1) total -= historyBytes(kept[first++]);
    return first ? kept.slice(first) : kept;
};

/** Reads a block of a picture. Half-float pictures are read as 32-bit floats (which every GPU allows) and kept as half floats. */
const readBlock = (gpu: TextureGpu, image: GpuImage, x: number, y: number, width: number, height: number): BlockPixels => {
    if (image.precision === 8) {
        const pixels = new Uint8Array(width * height * 4);
        gpu.renderer.readRenderTargetPixels(image.target, x, y, width, height, pixels);
        return pixels;
    }
    const block = gpu.image(width, height, 'color', 32);
    gpu.passNow(block, { fragment: 'uniform vec2 uAt;\nvoid main() { outColor = texelFetch(source, ivec2(gl_FragCoord.xy + uAt), 0); }', inputs: { source: image }, uniforms: { uAt: new THREE.Vector2(x, y) } });
    const floats = new Float32Array(width * height * 4);
    gpu.renderer.readRenderTargetPixels(block.target, 0, 0, width, height, floats);
    gpu.release(block);
    const halves = new Uint16Array(floats.length);
    for (let i = 0; i < floats.length; i++) halves[i] = THREE.DataUtils.toHalfFloat(floats[i]);
    return halves;
};

/** Puts a block read by readBlock back into its picture. */
const writeBlock = (gpu: TextureGpu, image: GpuImage, pixels: BlockPixels, region: { x: number; y: number; width: number; height: number }): void => {
    if (pixels instanceof Uint8Array) {
        gpu.write(image, pixels, region);
        return;
    }
    const floats = new Float32Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) floats[i] = THREE.DataUtils.fromHalfFloat(pixels[i]);
    gpu.write(image, floats, region);
};

const BLOCK = 32;

export class Stroke {
    private readonly masks = new Map<number, GpuImage>();
    /**
     * One batch of dabs before it joins the stroke. A texel can be drawn more than once in a batch (by its
     * triangle and by the lines along that triangle's edges and its neighbours', drawn so thin slivers are
     * covered), so the batch is drawn here keeping the largest value, then laid over the stroke once.
     */
    private readonly batch: GpuImage;
    private readonly before = new Map<string, GpuImage>();
    private last: { x: number; y: number } | null = null;
    private travelled = 0;
    private dabIndex = 0;
    private readonly seed = Math.floor(Math.random() * 1e9);

    constructor(
        private readonly stack: PaintStack,
        readonly target: StrokeTarget,
        private readonly tool: 'paint' | 'erase',
        private readonly brush: BrushSettings,
        private readonly view: StrokeView,
        private readonly alpha: THREE.Texture | null,
        private readonly stencil: THREE.Texture | null,
    ) {
        const gpu = stack.host.gpu;
        this.batch = gpu.image(stack.size, stack.size, 'gray', 16);
        for (const tile of stack.tiles) {
            const mask = gpu.image(stack.size, stack.size, 'gray', 16);
            gpu.clear(mask, [0, 0, 0, 0]);
            this.masks.set(tile, mask);
            for (const key of this.keys()) {
                const picture = stack.picture(key, tile, target.kind === 'mask' ? [1, 1, 1, 1] : [0, 0, 0, 0]);
                const copy = gpu.image(stack.size, stack.size, 'color', picture.precision);
                gpu.copy(picture, copy);
                this.before.set(`${key}|${tile}`, copy);
            }
        }
    }

    private keys(): string[] {
        return this.target.kind === 'mask' ? [pictureKey(this.target.effectId)] : this.target.channels.map((channel) => pictureKey(this.target.kind === 'layer' ? this.target.layerId : '', channel));
    }

    /** Dabs from the last point to this one, spaced along the way. */
    moveTo(x: number, y: number, pressure: number, hit: (x: number, y: number) => { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null): void {
        const brush = this.brush;
        const radiusFor = (p: number) => Math.max(0.5, brush.size * (brush.pressureSize ? Math.max(0.05, p) : 1));
        const dabs: Dab[] = [];
        const place = (px: number, py: number, direction: number) => {
            const n = this.dabIndex++;
            const r = random(this.seed + n * 7);
            const radius = radiusFor(pressure) * (1 - brush.sizeJitter * r);
            const scatterAngle = random(this.seed + n * 7 + 1) * Math.PI * 2;
            const scatter = brush.scatter * radius * 2 * random(this.seed + n * 7 + 2);
            const sx = px + Math.cos(scatterAngle) * scatter;
            const sy = py + Math.sin(scatterAngle) * scatter;
            const angle = (brush.angle * Math.PI) / 180 + (brush.followStroke ? direction : 0) + (random(this.seed + n * 7 + 3) - 0.5) * Math.PI * 2 * brush.angleJitter;
            const flow = brush.flow * (brush.pressureFlow ? pressure : 1) * (1 - brush.flowJitter * random(this.seed + n * 7 + 4));
            const dab: Dab = { x: sx, y: sy, radius, angle, flow };
            if (brush.projection === 'surface') {
                const found = hit(sx, sy);
                if (!found) return;
                dab.point = found.point;
                dab.normal = found.normal;
                // A screen radius in pixels as a distance on the model where it meets the surface.
                dab.worldRadius = (radius * found.distance) / this.view.perspective;
            }
            dabs.push(dab);
        };
        if (!this.last) {
            place(x, y, 0);
        } else {
            const dx = x - this.last.x;
            const dy = y - this.last.y;
            const length = Math.hypot(dx, dy);
            const direction = Math.atan2(dy, dx);
            const step = Math.max(1, radiusFor(pressure) * 2 * brush.spacing);
            let along = step - this.travelled;
            while (along <= length) {
                place(this.last.x + (dx * along) / length, this.last.y + (dy * along) / length, direction);
                along += step;
            }
            this.travelled = length - (along - step);
        }
        this.last = { x, y };
        if (dabs.length) this.draw(dabs);
    }

    /** Fills the whole UV island under the pointer (a triangle's island) with the brush. */
    fillIsland(island: number): void {
        this.draw([], island);
    }

    private draw(dabs: Dab[], island = -1): void {
        const stack = this.stack;
        const gpu = stack.host.gpu;
        const view = this.view;
        const centre = stack.part.bounds.getCenter(new THREE.Vector3());
        const batches: Dab[][] = [];
        for (let i = 0; i < dabs.length; i += MAX_DABS) batches.push(dabs.slice(i, i + MAX_DABS));
        if (island >= 0) batches.push([]);
        const stencil = this.brush.stencil;
        for (const batch of batches) {
            const d1 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            const d2 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            const d3 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            batch.forEach((dab, i) => {
                if (this.brush.projection === 'screen' || !dab.point) {
                    d1[i].set(dab.x, dab.y, dab.radius, dab.angle);
                    d2[i].set(dab.flow, 0, 0, 0);
                } else {
                    d1[i].set(dab.point.x, dab.point.y, dab.point.z, dab.worldRadius ?? 0.01);
                    d2[i].set(dab.flow, dab.normal!.x, dab.normal!.y, dab.normal!.z);
                    // The disc's "across" direction: the screen's right, turned by the dab's angle, laid on the surface.
                    const right = new THREE.Vector3().copy(view.cameraRight ?? new THREE.Vector3(1, 0, 0)).multiplyScalar(Math.cos(dab.angle))
                        .addScaledVector(view.cameraUp ?? new THREE.Vector3(0, 1, 0), Math.sin(dab.angle));
                    d3[i].set(right.x, right.y, right.z, dab.radius / Math.max(1e-6, dab.worldRadius ?? 1));
                }
            });
            for (const tile of stack.tiles) {
                // Each texel takes each dab once: the batch is drawn keeping the largest value any of its
                // draws gives a texel, then laid over the stroke.
                stack.raster.draw(this.batch, tile, DAB_SHADER, {
                    blend: 'max',
                    clear: [0, 0, 0, 0],
                    uniforms: {
                        uViewProj: view.viewProjection,
                        uViewport: new THREE.Vector2(view.width, view.height),
                        uDepth: view.depth ?? gpu.constant('white'),
                        uHasDepth: view.depth ? 1 : 0,
                        uCamera: view.cameraPosition,
                        uDabs: d1,
                        uDabs2: d2,
                        uDabs3: d3,
                        uCount: batch.length,
                        uProjection: this.brush.projection === 'screen' ? 0 : 1,
                        uShape: this.brush.shape === 'square' ? 1 : this.brush.shape === 'picture' && this.alpha ? 2 : 0,
                        uHardness: this.brush.hardness,
                        uAlpha: this.alpha ?? gpu.constant('white'),
                        uAlphaSrgb: this.alpha?.colorSpace === THREE.SRGBColorSpace ? 1 : 0,
                        uFacing: Math.cos((Math.min(179, this.brush.facingLimit) * Math.PI) / 180),
                        uSymmetry: new THREE.Vector3(this.brush.symmetry.x ? 1 : 0, this.brush.symmetry.y ? 1 : 0, this.brush.symmetry.z ? 1 : 0),
                        uCentre: centre,
                        uStencil: this.stencil ?? gpu.constant('white'),
                        uHasStencil: stencil.enabled && this.stencil ? 1 : 0,
                        uStencilPlace: new THREE.Vector4(view.width / 2 + stencil.offsetX * view.width, view.height / 2 + stencil.offsetY * view.height, view.height * stencil.scale, view.height * stencil.scale),
                        uStencilAngle: (stencil.rotation * Math.PI) / 180,
                        uStencilOpacity: stencil.opacity,
                        uIsland: island,
                    },
                });
                gpu.passNow(this.masks.get(tile)!, { fragment: GATHER_SHADER, inputs: { batch: this.batch }, blend: 'alpha' });
            }
        }
        this.apply();
    }

    /** Lays the brush onto the pictures through the stroke mask (from the pictures as they were before the stroke). */
    private apply(): void {
        const stack = this.stack;
        const gpu = stack.host.gpu;
        const channels: PaintChannel[] = [];
        for (const tile of stack.tiles) {
            for (const key of this.keys()) {
                const picture = stack.picture(key, tile);
                const channel = this.target.kind === 'layer' ? key.split(':')[1] as PaintChannel : null;
                if (channel) channels.push(channel);
                const value = this.target.kind === 'mask' ? [this.brush.maskValue, 0, 0] : this.brush.values[channel!];
                gpu.passNow(picture, {
                    fragment: APPLY_SHADER,
                    inputs: { before: this.before.get(`${key}|${tile}`)!, stroke: this.masks.get(tile)! },
                    uniforms: {
                        uErase: this.tool === 'erase' ? 1 : 0,
                        uMask: this.target.kind === 'mask' ? 1 : 0,
                        uValue: new THREE.Vector3(...(channel && !CHANNEL_IS_COLOR[channel] ? [value[0], value[0], value[0]] : value)),
                        uOpacity: this.brush.opacity,
                    },
                });
                stack.touch(key, tile);
            }
        }
        stack.invalidate(this.target.kind === 'mask' ? undefined : [...new Set(channels)]);
    }

    /** Ends the stroke: what it changed goes into the undo history. */
    finish(label: string): HistoryEntry {
        const stack = this.stack;
        const gpu = stack.host.gpu;
        const patches: PixelPatch[] = [];
        for (const tile of stack.tiles) {
            const mask = this.masks.get(tile)!;
            // The largest coverage in each block, read back small.
            const blocks = Math.ceil(stack.size / BLOCK);
            const reduced = gpu.image(blocks, blocks, 'color', 32);
            gpu.passNow(reduced, {
                fragment: `void main() { ivec2 base = ivec2(gl_FragCoord.xy) * ${BLOCK}; ivec2 size = textureSize(source, 0); float m = 0.0;
    for (int y = 0; y < ${BLOCK}; y++) for (int x = 0; x < ${BLOCK}; x++) { ivec2 q = base + ivec2(x, y); if (q.x < size.x && q.y < size.y) m = max(m, texelFetch(source, q, 0).r); }
    outColor = vec4(m); }`,
                inputs: { source: mask },
            });
            const values = gpu.readFloat(reduced);
            gpu.release(reduced);
            const touched: Array<[number, number]> = [];
            for (let by = 0; by < blocks; by++) for (let bx = 0; bx < blocks; bx++) if (values[(by * blocks + bx) * 4] > 0) touched.push([bx, by]);
            if (!touched.length) continue;
            for (const key of this.keys()) {
                const before = this.before.get(`${key}|${tile}`)!;
                const rects: PixelPatch['rects'] = [];
                // Runs of touched blocks along a row are read in one go.
                const rows = new Map<number, number[]>();
                for (const [bx, by] of touched) rows.set(by, [...(rows.get(by) ?? []), bx]);
                for (const [by, xs] of rows) {
                    xs.sort((a, b) => a - b);
                    let start = xs[0];
                    for (let i = 1; i <= xs.length; i++) {
                        if (i < xs.length && xs[i] === xs[i - 1] + 1) continue;
                        const end = xs[i - 1];
                        const x = start * BLOCK;
                        const y = by * BLOCK;
                        const width = Math.min(stack.size, (end + 1) * BLOCK) - x;
                        const height = Math.min(stack.size, y + BLOCK) - y;
                        rects.push({ x, y, width, height, before: readBlock(gpu, before, x, y, width, height), after: null });
                        if (i < xs.length) start = xs[i];
                    }
                }
                patches.push({ key, tile, rects });
            }
        }
        for (const image of this.masks.values()) gpu.release(image);
        for (const image of this.before.values()) gpu.release(image);
        gpu.release(this.batch);
        this.masks.clear();
        this.before.clear();
        return { label, pixels: patches };
    }

    /** Leaves the pictures as they were before the stroke (a stroke given up on). */
    cancel(): void {
        const gpu = this.stack.host.gpu;
        for (const tile of this.stack.tiles) {
            for (const key of this.keys()) {
                gpu.copy(this.before.get(`${key}|${tile}`)!, this.stack.picture(key, tile));
                // Masks worked out from this picture are worked out again.
                this.stack.touch(key, tile);
            }
        }
        for (const image of this.masks.values()) gpu.release(image);
        for (const image of this.before.values()) gpu.release(image);
        gpu.release(this.batch);
        this.masks.clear();
        this.before.clear();
        this.stack.invalidate();
    }
}

/** Puts back (or forward) the pixels an entry changed, and puts the set together again. */
export const applyPixelHistory = (stack: PaintStack, patches: readonly PixelPatch[], direction: 'undo' | 'redo'): void => {
    const gpu = stack.host.gpu;
    for (const patch of patches) {
        const picture = stack.picture(patch.key, patch.tile);
        for (const rect of patch.rects) {
            if (direction === 'undo' && !rect.after) rect.after = readBlock(gpu, picture, rect.x, rect.y, rect.width, rect.height);
            const pixels = direction === 'undo' ? rect.before : rect.after;
            if (pixels) writeBlock(gpu, picture, pixels, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }
        stack.touch(patch.key, patch.tile);
    }
    stack.invalidate();
};
