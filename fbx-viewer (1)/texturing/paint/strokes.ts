import * as THREE from 'three';
import { UvSurfaceLookup } from './uvSurface';
import { DEFAULT_PARTICLES, throwParticles, type ParticleSettings } from './particles';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import type { TileBake } from '../bake/meshBaker';
import { NO_MIRROR, type Mirror } from '../mesh/picker';
import { CHANNEL_IS_COLOR, PAINT_CHANNELS, type PaintChannel, type PaintDocument } from './paintTypes';
import { GpuResetError, pictureKey, type PaintStack } from './paintStack';
import { DirtyRegion, clampRect, expandRect, intersectRect, isEmptyRect, rectOfUvBox, scissorOf, unionRect, type Rect } from './regions';
import { pageRect, type SparsePicture } from './sparsePicture';
import { SELECTION_WIDTH, encodeTriangles, selectionBytes } from './selection';

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
/**
 * How a dab is laid on: cast from the screen, as a disc lying on the surface, flat along one axis through
 * whatever lies under it (a decal cast straight through), or from three sides blended by how the surface faces.
 */
export type BrushProjection = 'screen' | 'surface' | 'planar' | 'triplanar';
/** The axis a flat brush is cast along: the view's (as the stroke starts) or one of the model's. */
export type PlanarAxis = 'view' | 'x' | 'y' | 'z';

/** How far along its axis a flat or three-sided dab reaches, either side of where it lands, in its radii. */
export const PLANAR_DEPTH = 3;
/**
 * What a stroke does: lays the brush's values on, or works on what is painted already: blurs or sharpens
 * it, pushes it along the stroke, or copies it from elsewhere on the same picture.
 */
export type BrushMode = 'paint' | 'blur' | 'sharpen' | 'smudge' | 'clone';
export type SymmetryAxis = 'x' | 'y' | 'z';

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
    /** How pen pressure turns into size or flow: a curve from 0,0 to 1,1 through two control points. */
    pressureCurve: [number, number, number, number];
    /** The brush turns with the way the pen leans. */
    tiltAngle: boolean;
    /** Lazy mouse: the stroke trails the pointer on a string this many pixels long, for smooth lines. */
    lazy: number;
    mode: BrushMode;
    /** Dabs build up on one another within a stroke, as an airbrush does, instead of stopping at the opacity. */
    buildUp: boolean;
    shape: BrushShape;
    /** A picture from the library for the 'picture' shape (its brightness). */
    alphaTexture: string;
    projection: BrushProjection;
    planarAxis?: PlanarAxis;
    /** Texels facing away by more than this many degrees are not painted. */
    facingLimit: number;
    /**
     * Mirrored across any of the model's X, Y and Z middles, moved by `offset` (a share of the model's
     * size along each axis), so the mirror can be any plane square to an axis.
     */
    symmetry: { x: boolean; y: boolean; z: boolean; offset?: [number, number, number] };
    /** Copies turned round an axis through the mirror's middle (1 is none). */
    radial: { count: number; axis: SymmetryAxis };
    stencil: { enabled: boolean; textureId: string; scale: number; rotation: number; offsetX: number; offsetY: number; opacity: number };
    /** What the brush lays down on each channel. */
    values: Record<PaintChannel, [number, number, number]>;
    /** Channels the brush paints on. */
    channels: PaintChannel[];
    /** For masks: the grey painted. */
    maskValue: number;
    /** Particles each dab throws (drips, leaks, dust, splashes); left out by brushes saved before them. */
    particles?: ParticleSettings;
}

/** The largest brush radius, in screen pixels: the size sliders and the ] key stop here. */
export const MAX_BRUSH_SIZE = 600;

/** A picture's width over its height (1 when not known yet). */
export const pictureAspect = (texture: THREE.Texture | null): number => {
    const image = texture?.image as { width?: number; height?: number } | undefined;
    return image?.width && image.height ? image.width / image.height : 1;
};

/**
 * Where the stencil lies on a view of `width` × `height` pixels: its middle (from the top left), its size
 * (a share of the view's height tall, as wide as its picture's proportions make it) and its turn in degrees.
 */
export const stencilPlace = (stencil: BrushSettings['stencil'], aspect: number, width: number, height: number): { x: number; y: number; width: number; height: number; angle: number } => {
    const tall = height * stencil.scale;
    return { x: width / 2 + stencil.offsetX * width, y: height / 2 + stencil.offsetY * height, width: tall * aspect, height: tall, angle: stencil.rotation };
};

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
    pressureCurve: [0.25, 0.25, 0.75, 0.75],
    tiltAngle: false,
    lazy: 0,
    mode: 'paint',
    buildUp: false,
    shape: 'round',
    alphaTexture: '',
    projection: 'screen',
    facingLimit: 85,
    symmetry: { x: false, y: false, z: false, offset: [0, 0, 0] },
    radial: { count: 1, axis: 'y' },
    stencil: { enabled: false, textureId: '', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, opacity: 1 },
    values: {
        baseColor: [0.72, 0.18, 0.12], roughness: [0.45, 0.45, 0.45], metallic: [0, 0, 0], height: [0.6, 0.6, 0.6],
        normal: [0.5, 0.5, 1], emissive: [1, 0.5, 0.1], opacity: [1, 1, 1],
    },
    channels: ['baseColor', 'roughness', 'metallic'],
    maskValue: 1,
    particles: DEFAULT_PARTICLES,
};

/**
 * Pen pressure through a curve from 0,0 to 1,1 with control points (x1, y1) and (x2, y2), as easing curves
 * are drawn: the curve's height where it is `pressure` across.
 */
export const curvePressure = (pressure: number, [x1, y1, x2, y2]: readonly number[]): number => {
    const p = Math.min(1, Math.max(0, pressure));
    const along = (t: number, a: number, b: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        if (along(mid, x1, x2) < p) low = mid;
        else high = mid;
    }
    return Math.min(1, Math.max(0, along((low + high) / 2, y1, y2)));
};

/**
 * Lazy mouse: where the stroke's end goes when the pointer moves to `pointer`, trailing it on a string
 * `length` long (it stays put while the pointer is within reach, then is pulled straight after it).
 */
export const lazyFollow = (anchor: { x: number; y: number }, pointer: { x: number; y: number }, length: number): { x: number; y: number } => {
    const dx = pointer.x - anchor.x;
    const dy = pointer.y - anchor.y;
    const distance = Math.hypot(dx, dy);
    if (length <= 0) return { x: pointer.x, y: pointer.y };
    if (distance <= length) return { x: anchor.x, y: anchor.y };
    const pull = (distance - length) / distance;
    return { x: anchor.x + dx * pull, y: anchor.y + dy * pull };
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
    /** Smudge and clone: where the dab lies in its tile's texels, and the tile. */
    texel?: [number, number];
    tile?: number;
    /** Surface dabs laid along a path: the way across the dab (its shape's x), instead of the screen's. */
    across?: THREE.Vector3;
}

/** Where the pointer meets the surface, for surface dabs (and the texel under smudge and clone dabs). */
export type SurfaceProbe = (x: number, y: number) => { point: THREE.Vector3; normal: THREE.Vector3; distance: number; uv?: THREE.Vector2; triangle?: number } | null;

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
    /**
     * Painting on the UV layout in 2D: the tile shown, where a place on the view lies on it (tile UVs), and
     * the view's pixels per UV unit. Dabs are then laid in UV space, on the texels the surface covers.
     */
    uvView?: { tile: number; toUv: (x: number, y: number) => [number, number]; pixelsPerUv: number };
}

const MAX_DABS = 16;
/** The most dabs the particles of one pointer move leave. */
const MAX_PARTICLE_DABS = 1500;

/** The most copies a brush paints with: mirrored and turned, the brush itself included. */
export const MAX_COPIES = 16;

const DAB_SHADER = /* glsl */ `
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform sampler2D uDepth;
uniform int uHasDepth;
uniform vec3 uCamera;
uniform vec4 uDabs[${MAX_DABS}];
uniform vec4 uDabs2[${MAX_DABS}];
uniform vec4 uDabs3[${MAX_DABS}];
// The 2D view: the UV at its top left (xy) and its pixels per UV unit (z).
uniform vec3 uUvOrigin;
// The 2D view's copies, painted as surface dabs: each dab's place on the layout, its UV middle (xy), its
// UV radius signed by the island's handedness (z) and its turn (w), so the stencil is read where it lay.
uniform int uStencilFromUv;
uniform vec4 uDabsUv[${MAX_DABS}];
// Leave the brush itself out, drawing only its copies.
uniform int uSkipPlain;
uniform int uCount;
uniform int uProjection;
uniform int uShape;
uniform float uHardness;
uniform sampler2D uAlpha;
uniform int uAlphaSrgb;
uniform float uFacing;
uniform mat4 uCopies[${MAX_COPIES}];
uniform int uCopyCount;
uniform sampler2D uStencil;
uniform int uHasStencil;
uniform vec4 uStencilPlace;
uniform float uStencilAngle;
uniform float uStencilOpacity;
uniform int uStencilSrgb;
uniform int uStencilFlip;
uniform vec3 uPlanarAxis;
uniform int uSelecting;
uniform sampler2D uSelection;

// How much the stencil lets through at a place on the screen (pixels from the top left): its picture's
// brightness inside it, nothing outside it, eased by its strength.
float stencilAt(vec2 screen) {
    vec2 sp = rotate2(-uStencilAngle) * ((screen - uStencilPlace.xy) / uStencilPlace.zw) + 0.5;
    // The picture's top row at the top of its place on the screen, however the texture was uploaded.
    if (uStencilFlip == 1) sp.y = 1.0 - sp.y;
    vec4 c = texture(uStencil, sp);
    if (uStencilSrgb == 1) c.rgb = linearToSrgb(c.rgb);
    float inside = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
    return mix(1.0, luma(c.rgb) * c.a * inside, uStencilOpacity);
}

// The stencil cast from the screen onto a place on the model, as a slide is cast through the model
// (a surface brush can reach places the eye cannot see; they take the stencil where they fall on the screen).
float stencilOnModel(vec3 p) {
    vec4 clip = uViewProj * vec4(p, 1.0);
    if (clip.w <= 0.0) return 1.0 - uStencilOpacity;
    vec3 ndc = clip.xyz / clip.w;
    return stencilAt(vec2((ndc.x * 0.5 + 0.5) * uViewport.x, (0.5 - ndc.y * 0.5) * uViewport.y));
}

// A place on the UV layout, on the 2D view (pixels from the top left).
vec2 uvScreen(vec2 uv) { return vec2((uv.x - uUvOrigin.x) * uUvOrigin.z, (uUvOrigin.y - uv.y) * uUvOrigin.z); }

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

// A dab cast flat along an axis: its shape on the plane square to the axis (turned by the angle), within reach along it.
float planarAt(vec3 d, vec3 axis, float radius, float angle, float radiusPixels) {
    float depth = dot(d, axis);
    if (abs(depth) > radius * ${PLANAR_DEPTH.toFixed(1)}) return 0.0;
    vec3 helper = abs(axis.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t = normalize(cross(helper, axis));
    vec3 b = cross(axis, t);
    vec2 local = rotate2(-angle) * vec2(dot(d, t), dot(d, b)) / radius;
    return shapeAt(local, radiusPixels);
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
        if (uHasStencil == 1) a *= stencilAt(screen);
        return a * smoothstep(uFacing, uFacing + 0.15, facing);
    }
    if (uProjection == 4) {
        // On the UV layout: each dab a shape in the tile's UVs (xy, radius z, turn w), on the texels drawn.
        float a = 0.0;
        for (int i = 0; i < ${MAX_DABS}; i++) {
            if (i >= uCount) break;
            vec4 d = uDabs[i];
            vec2 local = rotate2(-d.w) * (vUv - d.xy) / d.z;
            float s = shapeAt(local, d.z * uDabs3[i].w) * uDabs2[i].x;
            a = 1.0 - (1.0 - a) * (1.0 - s);
        }
        if (uHasStencil == 1 && a > 0.0) a *= stencilAt(uvScreen(vUv));
        return a;
    }
    if (uProjection >= 2) {
        float a = 0.0;
        for (int i = 0; i < ${MAX_DABS}; i++) {
            if (i >= uCount) break;
            vec3 d = p - uDabs[i].xyz;
            float radius = uDabs[i].w;
            float s = 0.0;
            if (uProjection == 2) {
                // Flat along the axis, through everything within reach either side, facing it or not past the limit.
                // Through the model both ways, as a decal is cast: surfaces turned edge on to the axis (past the limit) are left alone.
                if (abs(dot(n, uPlanarAxis)) >= uFacing) s = planarAt(d, uPlanarAxis, radius, uDabs3[i].x, radius * uDabs3[i].w);
            } else {
                vec3 w = pow(abs(n), vec3(4.0));
                w /= max(w.x + w.y + w.z, 1e-5);
                s = planarAt(d, vec3(1.0, 0.0, 0.0), radius, uDabs3[i].x, radius * uDabs3[i].w) * w.x
                    + planarAt(d, vec3(0.0, 1.0, 0.0), radius, uDabs3[i].x, radius * uDabs3[i].w) * w.y
                    + planarAt(d, vec3(0.0, 0.0, 1.0), radius, uDabs3[i].x, radius * uDabs3[i].w) * w.z;
            }
            a = 1.0 - (1.0 - a) * (1.0 - s * uDabs2[i].x);
        }
        if (uHasStencil == 1 && a > 0.0) a *= stencilOnModel(p);
        return a;
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
        if (uHasStencil == 1 && uStencilFromUv == 1 && s > 0.0) {
            vec4 q = uDabsUv[i];
            s *= stencilAt(uvScreen(q.xy + rotate2(q.w) * vec2(local.x, q.z < 0.0 ? -local.y : local.y) * abs(q.z)));
        }
        a = 1.0 - (1.0 - a) * (1.0 - s);
    }
    if (uHasStencil == 1 && uStencilFromUv == 0 && a > 0.0) a *= stencilOnModel(p);
    return a;
}

void main() {
    // Filling picked triangles: each of them whole, nothing else.
    if (uSelecting == 1) {
        int t = int(vIds.z + 0.5);
        outColor = vec4(texelFetch(uSelection, ivec2(t % ${SELECTION_WIDTH}, t / ${SELECTION_WIDTH}), 0).r > 0.5 ? 1.0 : 0.0);
        return;
    }
    vec3 n = normalize(vNormal);
    float a = uSkipPlain == 1 ? 0.0 : coverageAt(vPos, n);
    // Copies, mirrored and turned: the texel is painted where its copy would be.
    for (int i = 1; i < ${MAX_COPIES}; i++) {
        if (i >= uCopyCount) break;
        float b = coverageAt((uCopies[i] * vec4(vPos, 1.0)).xyz, normalize(mat3(uCopies[i]) * n));
        a = 1.0 - (1.0 - a) * (1.0 - b);
    }
    outColor = vec4(a);
}`;

/** One batch's coverage laid over what the stroke has gathered so far (blended: batch + mask × (1 − batch)). */
const GATHER_SHADER = /* glsl */ `
void main() { outColor = vec4(texelFetch(batch, ivec2(gl_FragCoord.xy), 0).r); }`;

/**
 * The brush laid onto one page of a picture through the stroke mask, from the page as it was before the
 * stroke (or the picture's fill, for a page the stroke made). The stroke mask covers the whole tile: it is
 * read from where the page lies (`uAt`).
 */
const APPLY_SHADER = /* glsl */ `
uniform int uErase;
uniform int uMask;
uniform vec3 uValue;
uniform float uOpacity;
uniform vec2 uAt;
uniform int uHasBefore;
uniform vec4 uFill;
uniform int uSource;
uniform vec2 uSourceAt;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 b = uHasBefore == 1 ? texelFetch(before, p, 0) : uFill;
    float c = clamp(texelFetch(stroke, p + ivec2(uAt), 0).r * uOpacity, 0.0, 1.0);
    // Blur, sharpen, smudge and clone lay on what is painted already, worked out round the area
    // (colour weighted by coverage, a mask as it is), read where this texel takes it from.
    if (uSource == 1 && uErase == 0) {
        vec4 s = texelFetch(source, p + ivec2(uAt) - ivec2(uSourceAt), 0);
        if (uMask == 1) { outColor = vec4(vec3(mix(b.r, s.r, c)), 1.0); return; }
        vec4 o = mix(vec4(b.rgb * b.a, b.a), s, c);
        outColor = o.a > 1e-5 ? vec4(o.rgb / o.a, o.a) : vec4(0.0);
        return;
    }
    if (uMask == 1) {
        outColor = vec4(vec3(mix(b.r, uErase == 1 ? 0.0 : uValue.x, c)), 1.0);
        return;
    }
    if (uErase == 1) { outColor = vec4(b.rgb, b.a * (1.0 - c)); return; }
    float alpha = b.a + c * (1.0 - b.a);
    vec3 value = alpha > 0.0 ? (b.rgb * b.a * (1.0 - c) + uValue * c) / alpha : uValue;
    outColor = vec4(value, alpha);
}`;

/** A picture's colour weighted by its coverage (so blurring see-through texels adds no colour). */
const PREMULTIPLY = /* glsl */ `
void main() { vec4 c = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4(c.rgb * c.a, c.a); }`;

/** A gaussian blur one way (uDir), out to three times uSigma texels. */
const BLUR_LINE = /* glsl */ `
uniform vec2 uDir;
uniform float uSigma;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 last = textureSize(source, 0) - 1;
    int reach = int(ceil(uSigma * 3.0));
    vec4 sum = vec4(0.0);
    float weights = 0.0;
    for (int i = -24; i <= 24; i++) {
        if (i < -reach || i > reach) continue;
        float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
        sum += texelFetch(source, clamp(p + ivec2(uDir) * i, ivec2(0), last), 0) * w;
        weights += w;
    }
    outColor = sum / weights;
}`;

/** Sharpened: pushed away from its blurred copy. */
const SHARPEN_FROM = /* glsl */ `
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(source, p, 0);
    outColor = clamp(c + (c - texelFetch(blurred, p, 0)), 0.0, 1.0);
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
    /** When the step was made (ms since 1970), for the history list. */
    at?: number;
    document?: { before: PaintDocument; after: PaintDocument };
    pixels?: PixelPatch[];
    /** A bake: the maps before and after it, held on the GPU so undo and redo can put either back. */
    bakeMaps?: { before: Map<number, TileBake> | null; after: Map<number, TileBake> };
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

/** Reads a block of a page. Half-float pages are read as 32-bit floats (which every GPU allows) and kept as half floats. */
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

/** A block holding one value everywhere (a picture's fill, where no page was kept). */
const filledBlock = (precision: 8 | 16, fill: readonly number[], width: number, height: number): BlockPixels => {
    const count = width * height;
    if (precision === 8) {
        const pixels = new Uint8Array(count * 4);
        for (let i = 0; i < count * 4; i++) pixels[i] = Math.round(Math.min(1, Math.max(0, fill[i & 3])) * 255);
        return pixels;
    }
    const halves = new Uint16Array(count * 4);
    const values = fill.map((value) => THREE.DataUtils.toHalfFloat(value));
    for (let i = 0; i < count * 4; i++) halves[i] = values[i & 3];
    return halves;
};

/** Puts a block read by readBlock back into its page. */
const writeBlock = (gpu: TextureGpu, image: GpuImage, pixels: BlockPixels, region: { x: number; y: number; width: number; height: number }): void => {
    if (pixels instanceof Uint8Array) {
        gpu.write(image, pixels, region);
        return;
    }
    const floats = new Float32Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) floats[i] = THREE.DataUtils.fromHalfFloat(pixels[i]);
    gpu.write(image, floats, region);
};

/** Undo keeps blocks of this many texels a side (a page holds a whole number of them). */
const BLOCK = 32;

/** Texels round a triangle's box that a dab reaching it may still change (its edge lines, filtering). */
const FOOTPRINT_MARGIN = 2;

/**
 * Every mirrored copy a brush paints with: the model's middle, and a sign per axis for each copy (the
 * plain one first). Mirroring across X and Y also paints the copy mirrored across both, and so on.
 */
export const mirrorsOf = (symmetry: BrushSettings['symmetry'], centre: THREE.Vector3): Mirror[] => {
    const axes = [symmetry.x, symmetry.y, symmetry.z];
    const mirrors: Mirror[] = [];
    for (let mask = 0; mask < 8; mask++) {
        // Only combinations of mirrored axes that are on.
        if ([0, 1, 2].some((axis) => (mask >> axis) & 1 && !axes[axis])) continue;
        const signs = [0, 1, 2].map((axis) => ((mask >> axis) & 1 ? -1 : 1)) as [number, number, number];
        mirrors.push(mask === 0 ? NO_MIRROR : { signs, centre: [centre.x, centre.y, centre.z] });
    }
    return mirrors;
};

/**
 * Every copy a brush paints with, the brush itself first: mirrored across the planes that are on (square
 * to an axis, through the model's middle moved by the symmetry offset), each turned round the radial axis
 * through that point the radial count of times. At most MAX_COPIES.
 */
export const copiesOf = (brush: Pick<BrushSettings, 'symmetry' | 'radial'>, bounds: THREE.Box3): Mirror[] => {
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1e-6);
    const offset = brush.symmetry.offset ?? [0, 0, 0];
    const pivot = new THREE.Vector3(centre.x + offset[0] * extent, centre.y + offset[1] * extent, centre.z + offset[2] * extent);
    const about = (change: THREE.Matrix4) => new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(change).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    const axes = [brush.symmetry.x, brush.symmetry.y, brush.symmetry.z];
    const reflections: THREE.Matrix4[] = [];
    for (let mask = 0; mask < 8; mask++) {
        if ([0, 1, 2].some((axis) => (mask >> axis) & 1 && !axes[axis])) continue;
        reflections.push(about(new THREE.Matrix4().makeScale(mask & 1 ? -1 : 1, mask & 2 ? -1 : 1, mask & 4 ? -1 : 1)));
    }
    const count = Math.max(1, Math.min(MAX_COPIES, Math.round(brush.radial?.count ?? 1)));
    const axis = brush.radial?.axis ?? 'y';
    const around = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const copies: Mirror[] = [];
    for (let k = 0; k < count; k++) {
        const turn = about(new THREE.Matrix4().makeRotationAxis(around, (k * 2 * Math.PI) / count));
        reflections.forEach((reflection, r) => {
            if (copies.length >= MAX_COPIES) return;
            copies.push(k === 0 && r === 0 ? NO_MIRROR : { signs: [1, 1, 1], centre: [0, 0, 0], matrix: new THREE.Matrix4().multiplyMatrices(turn, reflection).elements.slice() });
        });
    }
    return copies;
};

/**
 * The texels a batch of dabs (or picked triangles) can change, per tile: the boxes of the triangles the
 * dabs reach (found through the surface's tree of boxes), with a small margin, as a few rectangles.
 */
export const footprint = (stack: PaintStack, dabs: readonly Dab[], view: StrokeView, brush: BrushSettings, picked: readonly number[] | null = null): Map<number, Rect[]> => {
    const part = stack.part;
    const boxes = stack.uvBoxes();
    const regions = new Map<number, DirtyRegion>();
    const reach = (triangle: number) => {
        const tile = part.triangleTile[triangle];
        let region = regions.get(tile);
        if (!region) regions.set(tile, region = new DirtyRegion(stack.size, 12));
        region.add(rectOfUvBox(boxes[triangle * 4], boxes[triangle * 4 + 1], boxes[triangle * 4 + 2], boxes[triangle * 4 + 3], stack.size, FOOTPRINT_MARGIN));
    };
    if (picked) {
        for (const triangle of picked) if (triangle >= 0 && triangle < part.triangleTile.length) reach(triangle);
    } else {
        const mirrors = copiesOf(brush, part.bounds);
        const seen = new Uint8Array(part.indices.length / 3);
        const once = (triangle: number) => { if (!seen[triangle]) { seen[triangle] = 1; reach(triangle); } };
        for (const dab of dabs) {
            for (const mirror of mirrors) {
                if (brush.projection !== 'screen' && dab.point) {
                    // The disc lies within its radius of the surface and its radius across: √2 of it from the middle.
                    stack.picker.trianglesNear(dab.point, (dab.worldRadius ?? 0) * (brush.projection === 'surface' ? Math.SQRT2 : Math.hypot(PLANAR_DEPTH, Math.SQRT2)), mirror, once);
                } else {
                    // A square brush's corners reach √2 of its radius.
                    const r = dab.radius * Math.SQRT2 + 1;
                    stack.picker.trianglesOnScreen(view.viewProjection, view.width, view.height, { x0: dab.x - r, y0: dab.y - r, x1: dab.x + r, y1: dab.y + r }, mirror, once);
                }
            }
        }
    }
    return new Map([...regions].map(([tile, region]): [number, Rect[]] => [tile, [...region.rects]]));
};

/** The texels dabs laid on the UV layout can change: each dab's box on its tile, as a few rectangles. */
export const uvFootprint = (size: number, uvView: NonNullable<StrokeView['uvView']>, dabs: readonly Dab[], shape: BrushShape): Map<number, Rect[]> => {
    const region = new DirtyRegion(size, 12);
    for (const dab of dabs) {
        const [u, v] = uvView.toUv(dab.x, dab.y);
        // A square (or picture) brush's corners reach a root two of its radius.
        const r = (dab.radius / uvView.pixelsPerUv) * (shape === 'round' ? 1 : Math.SQRT2);
        region.add(rectOfUvBox(u - r, v - r, u + r, v + r, size, FOOTPRINT_MARGIN));
    }
    return region.rects.length ? new Map([[uvView.tile, [...region.rects]]]) : new Map();
};

export class Stroke {
    private readonly masks = new Map<number, GpuImage>();
    /**
     * One batch of dabs before it joins the stroke. A texel can be drawn more than once in a batch (by its
     * triangle and by the lines along that triangle's edges and its neighbours', drawn so thin slivers are
     * covered), so the batch is drawn here keeping the largest value, then laid over the stroke once.
     */
    private readonly batch: GpuImage;
    /** Dabs that have thrown particles in this stroke (each throw its own seed). */
    private particleCount = 0;
    /** The 2D view's tile, looked up by UV (for its dabs' copies on the model). */
    private uvSurface: UvSurfaceLookup | null = null;
    /**
     * Pages as they were before the stroke, kept as the stroke first reaches them (by `key|tile`, then page):
     * a copy, or null for a page the stroke made (it held the picture's fill).
     */
    private readonly before = new Map<string, Map<number, GpuImage | null>>();
    /** Everything the stroke changed so far, per tile. */
    private readonly changed = new Map<number, Rect>();
    private last: { x: number; y: number } | null = null;
    /** Smudge: the texel the last dab lay on; the push of the last move, in texels. */
    private lastTexel: { tile: number; at: [number, number] } | null = null;
    private smudgeShift: [number, number] | null = null;
    /** Clone: the texel copied from, and how far (in texels) from the stroke's first dab it lies. */
    private cloneFrom: { tile: number; at: [number, number] } | null = null;
    private cloneShift: [number, number] | null = null;
    private travelled = 0;
    private dabIndex = 0;
    /** An alpha for the dabs being stamped (a letter, a stitch), instead of the brush's. */
    private stampAlpha: THREE.Texture | null | undefined = undefined;
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
        // Painting on pictures a lost GPU context left blank would save blank-based pictures over kept work.
        if (!stack.usable) throw new GpuResetError();
        const gpu = stack.host.gpu;
        this.batch = gpu.image(stack.size, stack.size, 'gray', 16);
        for (const tile of stack.tiles) {
            const mask = gpu.image(stack.size, stack.size, 'gray', 16);
            gpu.clear(mask, [0, 0, 0, 0]);
            this.masks.set(tile, mask);
        }
    }

    private keys(): string[] {
        return this.target.kind === 'mask' ? [pictureKey(this.target.effectId)] : this.target.channels.map((channel) => pictureKey(this.target.kind === 'layer' ? this.target.layerId : '', channel));
    }

    /** The picture a key paints on (made, empty or holding its mask's value, the first time). */
    private pictureOf(key: string, tile: number): SparsePicture {
        return this.target.kind === 'mask' ? this.stack.picture(key, tile, this.stack.maskFill(this.target.effectId)) : this.stack.picture(key, tile);
    }

    /** The channels a change to this stroke's pictures puts together again. */
    private channels(): PaintChannel[] {
        if (this.target.kind === 'mask') return this.stack.channelsOfEffect(this.target.effectId);
        return [...this.target.channels];
    }

    /** Clone: where on the surface (its triangle and texture coordinates) the stroke copies from. */
    /** Clone, on the UV layout: the place on a tile (its UVs) the stroke copies from. */
    cloneSourceAt(tile: number, u: number, v: number): void {
        this.cloneFrom = { tile, at: [u * this.stack.size, v * this.stack.size] };
    }

    cloneSource(triangle: number, uv: THREE.Vector2): void {
        const part = this.stack.part;
        this.cloneFrom = { tile: part.triangleTile[triangle], at: [(uv.x - part.triangleShift[triangle * 2]) * this.stack.size, (uv.y - part.triangleShift[triangle * 2 + 1]) * this.stack.size] };
    }

    /** Dabs from the last point to this one, spaced along the way. */
    moveTo(x: number, y: number, pressure: number, hit: SurfaceProbe, tilt?: { x: number; y: number }): void {
        const brush = this.brush;
        // Pressure through the brush's curve; the way the pen leans, as a turn on the screen.
        const pushed = curvePressure(pressure, brush.pressureCurve ?? [0.25, 0.25, 0.75, 0.75]);
        const lean = brush.tiltAngle && tilt && (tilt.x || tilt.y) ? Math.atan2(tilt.y, tilt.x) : 0;
        const radiusFor = (p: number) => Math.max(0.5, brush.size * (brush.pressureSize ? Math.max(0.05, curvePressure(p, brush.pressureCurve ?? [0.25, 0.25, 0.75, 0.75])) : 1));
        const dabs: Dab[] = [];
        const place = (px: number, py: number, direction: number) => {
            const n = this.dabIndex++;
            const r = random(this.seed + n * 7);
            const radius = radiusFor(pressure) * (1 - brush.sizeJitter * r);
            const scatterAngle = random(this.seed + n * 7 + 1) * Math.PI * 2;
            const scatter = brush.scatter * radius * 2 * random(this.seed + n * 7 + 2);
            const sx = px + Math.cos(scatterAngle) * scatter;
            const sy = py + Math.sin(scatterAngle) * scatter;
            const angle = (brush.angle * Math.PI) / 180 + (brush.followStroke ? direction : 0) + lean + (random(this.seed + n * 7 + 3) - 0.5) * Math.PI * 2 * brush.angleJitter;
            const flow = brush.flow * (brush.pressureFlow ? pushed : 1) * (1 - brush.flowJitter * random(this.seed + n * 7 + 4));
            const dab: Dab = { x: sx, y: sy, radius, angle, flow };
            // On the UV layout dabs need no place on the model.
            if (brush.projection !== 'screen' && !this.view.uvView) {
                const found = hit(sx, sy);
                if (!found) return;
                dab.point = found.point;
                dab.normal = found.normal;
                // A screen radius in pixels as a distance on the model where it meets the surface.
                dab.worldRadius = (radius * found.distance) / this.view.perspective;
            }
            if ((brush.mode === 'smudge' || brush.mode === 'clone') && !this.view.uvView) {
                // The texel under the dab: what the push of a smudge and the copy of a clone are measured by.
                const found = hit(sx, sy);
                if (found?.uv && found.triangle !== undefined) {
                    const part = this.stack.part;
                    dab.tile = part.triangleTile[found.triangle];
                    dab.texel = [(found.uv.x - part.triangleShift[found.triangle * 2]) * this.stack.size, (found.uv.y - part.triangleShift[found.triangle * 2 + 1]) * this.stack.size];
                }
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
        const particles = brush.particles;
        if (particles?.enabled && !this.view.uvView && dabs.length) {
            const thrown = this.particleDabs(dabs, particles, hit);
            if (particles.paintAtBrush) this.draw(dabs);
            if (thrown.length) this.draw(thrown, null, 'surface');
            return;
        }
        if (dabs.length) this.draw(dabs);
    }

    /**
     * The dabs the particles thrown by `dabs` leave along their paths, as surface dabs (each the size its
     * particle has then, in the same pixels to the model unit as the dab that threw it).
     */
    private particleDabs(dabs: readonly Dab[], settings: ParticleSettings, hit: SurfaceProbe): Dab[] {
        const part = this.stack.part;
        const modelSize = Math.max(1e-6, part.bounds.getSize(new THREE.Vector3()).length());
        const picker = this.stack.picker;
        const surface = { cast: (origin: THREE.Vector3, direction: THREE.Vector3) => picker.cast(origin, direction), nearest: (point: THREE.Vector3, reach: number) => picker.nearest(point, reach) };
        const out: Dab[] = [];
        for (const dab of dabs) {
            let { point, normal, worldRadius } = dab;
            if (!point || !normal || !worldRadius) {
                const found = hit(dab.x, dab.y);
                if (!found) continue;
                point = found.point;
                normal = found.normal;
                worldRadius = (dab.radius * found.distance) / this.view.perspective;
            }
            const pixelsPerUnit = dab.radius / Math.max(1e-9, worldRadius);
            const seed = this.seed + (this.particleCount += 1) * 7919;
            for (const left of throwParticles({ point, normal, worldRadius, flow: dab.flow }, settings, surface, modelSize, seed, Math.max(0, MAX_PARTICLE_DABS - out.length))) {
                out.push({ x: dab.x, y: dab.y, radius: Math.max(0.5, left.worldRadius * pixelsPerUnit), angle: random(seed + out.length) * Math.PI * 2, flow: left.flow, point: left.point, normal: left.normal, worldRadius: left.worldRadius });
            }
            if (out.length >= MAX_PARTICLE_DABS) break;
        }
        return out;
    }

    /** Lays dabs placed by the caller (along a path), with their own alpha if one is given. */
    stamp(dabs: Dab[], alpha?: THREE.Texture | null): void {
        this.stampAlpha = alpha;
        try {
            this.draw(dabs);
        } finally {
            this.stampAlpha = undefined;
        }
    }

    /** Fills a whole UV island with the brush. */
    fillIsland(island: number): void {
        const triangles: number[] = [];
        this.stack.part.triangleIsland.forEach((value, triangle) => { if (value === island) triangles.push(triangle); });
        this.fillTriangles(triangles);
    }

    /** Fills picked triangles, each whole, with the brush. */
    fillTriangles(triangles: readonly number[]): void {
        if (triangles.length) this.draw([], triangles);
    }

    /**
     * The 2D view's dabs as surface dabs where they lie on the model (for their mirrored and turned copies):
     * the point and normal under each, its radius in model units, and its "across" the tile's U direction
     * turned by the dab's angle; with each dab's place on the layout, for the stencil.
     */
    private uvCopyDabs(batch: readonly Dab[], uvView: NonNullable<StrokeView['uvView']>): { dabs: Dab[]; uv: THREE.Vector4[] } {
        if (this.uvSurface?.tile !== uvView.tile) this.uvSurface = new UvSurfaceLookup(this.stack.part, uvView.tile);
        const dabs: Dab[] = [];
        const uv = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
        for (const dab of batch) {
            const [u, v] = uvView.toUv(dab.x, dab.y);
            const hit = this.uvSurface.at(u, v);
            if (!hit) continue;
            const uvRadius = dab.radius / uvView.pixelsPerUv;
            const along = hit.alongU.clone().addScaledVector(hit.normal, -hit.alongU.dot(hit.normal));
            if (along.lengthSq() < 1e-16) continue;
            along.normalize();
            const side = new THREE.Vector3().crossVectors(hit.normal, along);
            // A mirrored island runs V the other way round the normal.
            const handed = side.dot(hit.alongV) >= 0 ? 1 : -1;
            side.multiplyScalar(handed);
            uv[dabs.length].set(u, v, uvRadius * handed, dab.angle);
            dabs.push({ ...dab, point: hit.point, normal: hit.normal, worldRadius: uvRadius * hit.scale, across: along.multiplyScalar(Math.cos(dab.angle)).addScaledVector(side, Math.sin(dab.angle)) });
        }
        return { dabs, uv };
    }

    private draw(dabs: Dab[], picked: readonly number[] | null = null, projection: BrushProjection = this.brush.projection): void {
        // Particle dabs are laid on the surface whatever the brush's own projection.
        const brush = projection === this.brush.projection ? this.brush : { ...this.brush, projection };
        const stack = this.stack;
        const gpu = stack.host.gpu;
        const view = this.view;
        // On the UV layout every dab's texel is known straight away.
        if (view.uvView) {
            for (const dab of dabs) {
                const [u, v] = view.uvView.toUv(dab.x, dab.y);
                dab.tile = view.uvView.tile;
                dab.texel = [u * stack.size, v * stack.size];
            }
        }
        // Smudge pushes by the way the brush last moved on the picture; clone copies from a fixed distance
        // away, set by the stroke's first dab.
        for (const dab of dabs) {
            if (!dab.texel || dab.tile === undefined) continue;
            if (this.brush.mode === 'smudge') {
                if (this.lastTexel && this.lastTexel.tile === dab.tile) this.smudgeShift = [Math.round(dab.texel[0] - this.lastTexel.at[0]), Math.round(dab.texel[1] - this.lastTexel.at[1])];
                this.lastTexel = { tile: dab.tile, at: dab.texel };
            } else if (this.brush.mode === 'clone' && !this.cloneShift && this.cloneFrom && this.cloneFrom.tile === dab.tile) {
                this.cloneShift = [Math.round(dab.texel[0] - this.cloneFrom.at[0]), Math.round(dab.texel[1] - this.cloneFrom.at[1])];
            }
        }
        const copies = copiesOf(this.brush, stack.part.bounds);
        // A flat brush's axis: the view's (from the camera into the scene), or one of the model's.
        const planarAxis = this.brush.planarAxis === 'x' ? new THREE.Vector3(1, 0, 0) : this.brush.planarAxis === 'y' ? new THREE.Vector3(0, 1, 0) : this.brush.planarAxis === 'z' ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3().crossVectors(view.cameraRight ?? new THREE.Vector3(1, 0, 0), view.cameraUp ?? new THREE.Vector3(0, 1, 0)).negate().normalize();
        const alpha = this.stampAlpha !== undefined ? this.stampAlpha : this.brush.shape === 'picture' ? this.alpha : null;
        const copyMatrices = Array.from({ length: MAX_COPIES }, (_, i) => (copies[i]?.matrix ? new THREE.Matrix4().fromArray(copies[i].matrix!) : new THREE.Matrix4()));
        const batches: Dab[][] = [];
        for (let i = 0; i < dabs.length; i += MAX_DABS) batches.push(dabs.slice(i, i + MAX_DABS));
        if (picked) batches.push([]);
        const bytes = picked ? selectionBytes(encodeTriangles(picked), stack.part.indices.length / 3) : null;
        const selection = bytes ? new THREE.DataTexture(bytes.data, bytes.width, bytes.height, THREE.RedFormat, THREE.UnsignedByteType) : null;
        if (selection) selection.needsUpdate = true;
        const stencil = this.brush.stencil;
        const place = stencilPlace(stencil, pictureAspect(this.stencil), view.width, view.height);
        const [u0, v0] = view.uvView ? view.uvView.toUv(0, 0) : [0, 0];
        const uvOrigin = new THREE.Vector3(u0, v0, view.uvView?.pixelsPerUv ?? 1);
        const areas = new Map<number, Rect[]>();
        const noUv = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
        /** Uniforms for surface dabs (a disc on the surface, or cast flat along an axis). */
        const surfaceDab = (dab: Dab, i: number, d1: THREE.Vector4[], d2: THREE.Vector4[], d3: THREE.Vector4[], projection: BrushSettings['projection']) => {
            d1[i].set(dab.point!.x, dab.point!.y, dab.point!.z, dab.worldRadius ?? 0.01);
            d2[i].set(dab.flow, dab.normal!.x, dab.normal!.y, dab.normal!.z);
            // The disc's "across" direction: the screen's right, turned by the dab's angle, laid on the surface.
            const right = dab.across ? dab.across.clone() : new THREE.Vector3().copy(view.cameraRight ?? new THREE.Vector3(1, 0, 0)).multiplyScalar(Math.cos(dab.angle))
                .addScaledVector(view.cameraUp ?? new THREE.Vector3(0, 1, 0), Math.sin(dab.angle));
            if (projection === 'planar' || projection === 'triplanar') d3[i].set(dab.angle, 0, 0, dab.radius / Math.max(1e-6, dab.worldRadius ?? 1));
            else d3[i].set(right.x, right.y, right.z, dab.radius / Math.max(1e-6, dab.worldRadius ?? 1));
        };
        /**
         * Draws one batch over the texels it reaches: each texel takes each dab once (the batch is drawn
         * keeping the largest value any of its draws gives a texel), then the batch is laid over the stroke.
         */
        const drawReach = (reach: Map<number, Rect[]>, dabs: { d1: THREE.Vector4[]; d2: THREE.Vector4[]; d3: THREE.Vector4[]; count: number; uv?: THREE.Vector4[] }, projection: number, copyCount: number, skipPlain: boolean) => {
            for (const [tile, rects] of reach) {
                for (const area of rects) {
                    stack.raster.draw(this.batch, tile, DAB_SHADER, {
                        blend: 'max',
                        clear: [0, 0, 0, 0],
                        scissor: area,
                        uniforms: {
                            uViewProj: view.viewProjection,
                            uViewport: new THREE.Vector2(view.width, view.height),
                            uDepth: view.depth ?? gpu.constant('white'),
                            uHasDepth: view.depth ? 1 : 0,
                            uCamera: view.cameraPosition,
                            uDabs: dabs.d1,
                            uDabs2: dabs.d2,
                            uDabs3: dabs.d3,
                            uCount: dabs.count,
                            uProjection: projection,
                            uPlanarAxis: planarAxis,
                            uShape: alpha ? 2 : this.brush.shape === 'square' ? 1 : 0,
                            uHardness: this.brush.hardness,
                            uAlpha: alpha ?? gpu.constant('white'),
                            uAlphaSrgb: alpha?.colorSpace === THREE.SRGBColorSpace ? 1 : 0,
                            uFacing: Math.cos((Math.min(179, this.brush.facingLimit) * Math.PI) / 180),
                            uCopies: copyMatrices,
                            uCopyCount: copyCount,
                            uSkipPlain: skipPlain ? 1 : 0,
                            uUvOrigin: uvOrigin,
                            uStencilFromUv: dabs.uv ? 1 : 0,
                            uDabsUv: dabs.uv ?? noUv,
                            uStencil: this.stencil ?? gpu.constant('white'),
                            uHasStencil: stencil.enabled && this.stencil ? 1 : 0,
                            uStencilPlace: new THREE.Vector4(place.x, place.y, place.width, place.height),
                            uStencilAngle: (place.angle * Math.PI) / 180,
                            uStencilOpacity: stencil.opacity,
                            uStencilSrgb: this.stencil?.colorSpace === THREE.SRGBColorSpace ? 1 : 0,
                            uStencilFlip: this.stencil?.flipY ? 1 : 0,
                            uSelecting: selection ? 1 : 0,
                            uSelection: selection ?? gpu.constant('black'),
                        },
                    });
                    gpu.passNow(this.masks.get(tile)!, { fragment: GATHER_SHADER, inputs: { batch: this.batch }, blend: 'alpha', scissor: scissorOf(area) });
                    // Building up: this batch is laid over the picture as it is now, at once.
                    if (this.brush.buildUp) this.apply(new Map([[tile, [area]]]), true);
                }
                areas.set(tile, [...(areas.get(tile) ?? []), ...rects]);
            }
        };
        for (const batch of batches) {
            // Only the texels these dabs can reach are drawn.
            const reach = view.uvView && !picked ? uvFootprint(stack.size, view.uvView, batch, this.brush.shape) : footprint(stack, batch, view, brush, picked);
            const d1 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            const d2 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            const d3 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
            if (view.uvView) {
                batch.forEach((dab, i) => {
                    const [u, v] = view.uvView!.toUv(dab.x, dab.y);
                    d1[i].set(u, v, dab.radius / view.uvView!.pixelsPerUv, dab.angle);
                    d2[i].set(dab.flow, 0, 0, 0);
                    d3[i].set(0, 0, 0, view.uvView!.pixelsPerUv);
                });
            } else {
                batch.forEach((dab, i) => {
                    if (projection === 'screen' || !dab.point) {
                        d1[i].set(dab.x, dab.y, dab.radius, dab.angle);
                        d2[i].set(dab.flow, 0, 0, 0);
                    } else surfaceDab(dab, i, d1, d2, d3, projection);
                });
            }
            if (reach.size) drawReach(reach, { d1, d2, d3, count: batch.length }, view.uvView ? 4 : { screen: 0, surface: 1, planar: 2, triplanar: 3 }[projection] ?? 0, view.uvView ? 1 : copies.length, false);
            // The 2D view's mirrored and turned copies: each dab sent to where it lies on the model and drawn
            // there as a surface dab through the copies, as the 3D view would (the brush itself is drawn above).
            if (view.uvView && !picked && copies.length > 1) {
                const copied = this.uvCopyDabs(batch, view.uvView);
                if (!copied.dabs.length) continue;
                const brush = { ...this.brush, projection: 'surface' as const };
                const copyReach = footprint(stack, copied.dabs, view, brush, null);
                const c1 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
                const c2 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
                const c3 = Array.from({ length: MAX_DABS }, () => new THREE.Vector4());
                copied.dabs.forEach((dab, i) => surfaceDab(dab, i, c1, c2, c3, 'surface'));
                if (copyReach.size) drawReach(copyReach, { d1: c1, d2: c2, d3: c3, count: copied.dabs.length, uv: copied.uv }, 1, copies.length, true);
            }
        }
        selection?.dispose();
        if (areas.size && !this.brush.buildUp) this.apply(areas);
    }

    /**
     * What blur, sharpen, smudge or clone lay on over an area of a picture: worked out from the picture as
     * it is now round the area, with the tile texel its first texel stands for; null to lay the brush's
     * values on (painting, erasing, or a smudge or clone with nowhere to take from yet).
     */
    private sourceFor(key: string, picture: SparsePicture, area: Rect): { image: GpuImage; at: [number, number] } | null {
        const mode = this.brush.mode;
        // Painting (and a brush saved before it had a mode) lays its values on; erasing always erases.
        if ((mode !== 'blur' && mode !== 'sharpen' && mode !== 'smudge' && mode !== 'clone') || this.tool === 'erase') return null;
        const shift = mode === 'smudge' ? this.smudgeShift : mode === 'clone' ? this.cloneShift : [0, 0] as [number, number];
        if (!shift) return null;
        const gpu = this.stack.host.gpu;
        const sigma = Math.max(1, this.stack.size / 1024 * 2);
        const reach = mode === 'blur' || mode === 'sharpen' ? Math.ceil(sigma * 3) + 1 : 0;
        // The texels the area reads: the area moved back by the shift, and as far round as the blur reaches.
        const region = clampRect(expandRect({ x0: area.x0 - shift[0], y0: area.y0 - shift[1], x1: area.x1 - shift[0], y1: area.y1 - shift[1] }, reach), this.stack.size);
        if (isEmptyRect(region)) return null;
        const width = region.x1 - region.x0;
        const height = region.y1 - region.y0;
        const raw = gpu.image(width, height, 'color', 16);
        picture.drawInto(raw, region, [region.x0, region.y0]);
        let image = raw;
        // A layer's colour is weighted by its coverage; a mask is a value alone.
        if (key.includes(':')) {
            image = gpu.image(width, height, 'color', 16);
            gpu.passNow(image, { fragment: PREMULTIPLY, inputs: { source: raw } });
            gpu.release(raw);
        }
        if (mode === 'blur' || mode === 'sharpen') {
            const across = gpu.image(width, height, 'color', 16);
            gpu.passNow(across, { fragment: BLUR_LINE, inputs: { source: image }, uniforms: { uDir: new THREE.Vector2(1, 0), uSigma: sigma } });
            const blurred = gpu.image(width, height, 'color', 16);
            gpu.passNow(blurred, { fragment: BLUR_LINE, inputs: { source: across }, uniforms: { uDir: new THREE.Vector2(0, 1), uSigma: sigma } });
            gpu.release(across);
            if (mode === 'blur') {
                gpu.release(image);
                image = blurred;
            } else {
                const sharpened = gpu.image(width, height, 'color', 16);
                gpu.passNow(sharpened, { fragment: SHARPEN_FROM, inputs: { source: image, blurred } });
                gpu.release(blurred);
                gpu.release(image);
                image = sharpened;
            }
        }
        return { image, at: [region.x0 + shift[0], region.y0 + shift[1]] };
    }

    /**
     * Lays the brush onto the pictures through the stroke mask, page by page within the areas just painted
     * (from the pages as they were before the stroke); building up, through the batch just drawn, over the
     * pages as they are now.
     */
    private apply(areas: ReadonlyMap<number, readonly Rect[]>, buildUp = false): void {
        const stack = this.stack;
        const gpu = stack.host.gpu;
        for (const [tile, rects] of areas) {
            for (const area of rects) this.changed.set(tile, this.changed.has(tile) ? unionRect(this.changed.get(tile)!, area) : area);
            for (const key of this.keys()) {
                const picture = this.pictureOf(key, tile);
                const channel = this.target.kind === 'layer' ? key.split(':')[1] as PaintChannel : null;
                const value = this.target.kind === 'mask' ? [this.brush.maskValue, 0, 0] : this.brush.values[channel!];
                let kept = this.before.get(`${key}|${tile}`);
                if (!kept) this.before.set(`${key}|${tile}`, kept = new Map());
                for (const area of rects) {
                    const source = this.sourceFor(key, picture, area);
                    for (const [px, py] of pagesOfArea(area, picture)) {
                        const index = py * picture.columns + px;
                        if (!kept.has(index)) {
                            // The page as the stroke found it: copied once, before anything is laid on it.
                            const existing = picture.pageAt(px, py);
                            if (existing) {
                                const copy = gpu.image(picture.page, picture.page, 'color', picture.precision);
                                gpu.copy(existing, copy);
                                kept.set(index, copy);
                            } else kept.set(index, null);
                        }
                        const page = picture.pageAt(px, py, true)!;
                        const bounds = pageRect(px, py, picture.page);
                        const within = intersectRect(area, bounds);
                        if (isEmptyRect(within)) continue;
                        let before = kept.get(index) ?? null;
                        // Building up lays each batch over the page as it is now (copied, as a page is not read while drawn on).
                        let now: GpuImage | null = null;
                        if (buildUp) {
                            now = gpu.image(picture.page, picture.page, 'color', picture.precision);
                            gpu.copy(page, now);
                            before = now;
                        }
                        gpu.passNow(page, {
                            fragment: APPLY_SHADER,
                            inputs: { before: before ?? gpu.constant('clear'), stroke: buildUp ? this.batch : this.masks.get(tile)!, source: source?.image ?? gpu.constant('clear') },
                            uniforms: {
                                uErase: this.tool === 'erase' ? 1 : 0,
                                uMask: this.target.kind === 'mask' ? 1 : 0,
                                uValue: new THREE.Vector3(...(channel && !CHANNEL_IS_COLOR[channel] ? [value[0], value[0], value[0]] : value)),
                                uOpacity: this.brush.opacity,
                                uAt: new THREE.Vector2(bounds.x0, bounds.y0),
                                uHasBefore: before ? 1 : 0,
                                uFill: new THREE.Vector4(...picture.fill),
                                uSource: source ? 1 : 0,
                                uSourceAt: new THREE.Vector2(...(source?.at ?? [0, 0])),
                            },
                            scissor: scissorOf({ x0: within.x0 - bounds.x0, y0: within.y0 - bounds.y0, x1: within.x1 - bounds.x0, y1: within.y1 - bounds.y0 }),
                        });
                        gpu.release(now);
                    }
                    gpu.release(source?.image);
                }
                stack.touch(key, tile);
                if (key.startsWith('bake:')) stack.noteBakeFix(tile, rects);
            }
        }
        stack.invalidate(this.channels(), areas);
    }

    /** Ends the stroke: what it changed goes into the undo history. */
    finish(label: string): HistoryEntry {
        const stack = this.stack;
        const gpu = stack.host.gpu;
        const patches: PixelPatch[] = [];
        for (const [tile, changed] of this.changed) {
            const mask = this.masks.get(tile)!;
            // The largest coverage in each block the stroke reached, read back small.
            const bx0 = Math.floor(changed.x0 / BLOCK), by0 = Math.floor(changed.y0 / BLOCK);
            const columns = Math.ceil(changed.x1 / BLOCK) - bx0, rows = Math.ceil(changed.y1 / BLOCK) - by0;
            if (columns <= 0 || rows <= 0) continue;
            const reduced = gpu.image(columns, rows, 'color', 32);
            gpu.passNow(reduced, {
                fragment: `uniform vec2 uFirst;
void main() { ivec2 base = (ivec2(gl_FragCoord.xy) + ivec2(uFirst)) * ${BLOCK}; ivec2 size = textureSize(source, 0); float m = 0.0;
    for (int y = 0; y < ${BLOCK}; y++) for (int x = 0; x < ${BLOCK}; x++) { ivec2 q = base + ivec2(x, y); if (q.x < size.x && q.y < size.y) m = max(m, texelFetch(source, q, 0).r); }
    outColor = vec4(m); }`,
                inputs: { source: mask },
                uniforms: { uFirst: new THREE.Vector2(bx0, by0) },
            });
            const values = gpu.readFloat(reduced);
            gpu.release(reduced);
            const touched: Array<[number, number]> = [];
            for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) if (values[(row * columns + column) * 4] > 0) touched.push([bx0 + column, by0 + row]);
            if (!touched.length) continue;
            for (const key of this.keys()) {
                const picture = this.pictureOf(key, tile);
                const kept = this.before.get(`${key}|${tile}`);
                const rects: PixelPatch['rects'] = [];
                for (const [bx, by] of touched) {
                    const x = bx * BLOCK;
                    const y = by * BLOCK;
                    const width = Math.min(stack.size, x + BLOCK) - x;
                    const height = Math.min(stack.size, y + BLOCK) - y;
                    const px = Math.floor(x / picture.page);
                    const py = Math.floor(y / picture.page);
                    const index = py * picture.columns + px;
                    // A block of a page the stroke never reached holds what the page holds still.
                    if (!kept?.has(index)) continue;
                    const before = kept.get(index) ?? null;
                    const pixels = before ? readBlock(gpu, before, x - px * picture.page, y - py * picture.page, width, height) : filledBlock(picture.precision, picture.fill, width, height);
                    rects.push({ x, y, width, height, before: pixels, after: null });
                }
                if (rects.length) patches.push({ key, tile, rects });
            }
        }
        this.release();
        return { label, pixels: patches };
    }

    /** Leaves the pictures as they were before the stroke (a stroke given up on). */
    cancel(): void {
        const areas = new Map<number, Rect[]>();
        for (const [entry, kept] of this.before) {
            const [key, tileName] = entry.split('|');
            const tile = Number(tileName);
            const picture = this.pictureOf(key, tile);
            for (const [index, before] of kept) {
                const px = index % picture.columns;
                const py = Math.floor(index / picture.columns);
                if (before) this.stack.host.gpu.copy(before, picture.pageAt(px, py, true)!);
                else picture.drop(px, py);
            }
            this.stack.touch(key, tile);
        }
        for (const [tile, changed] of this.changed) areas.set(tile, [changed]);
        this.release();
        if (areas.size) this.stack.invalidate(this.channels(), areas);
    }

    private release(): void {
        const gpu = this.stack.host.gpu;
        for (const image of this.masks.values()) gpu.release(image);
        for (const kept of this.before.values()) for (const image of kept.values()) gpu.release(image);
        gpu.release(this.batch);
        this.masks.clear();
        this.before.clear();
        this.changed.clear();
    }
}

/** The pages of a picture an area reaches. */
const pagesOfArea = (area: Rect, picture: SparsePicture): Array<[number, number]> => {
    const pages: Array<[number, number]> = [];
    const px0 = Math.max(0, Math.floor(area.x0 / picture.page)), py0 = Math.max(0, Math.floor(area.y0 / picture.page));
    const px1 = Math.min(picture.columns - 1, Math.floor((area.x1 - 1) / picture.page)), py1 = Math.min(picture.columns - 1, Math.floor((area.y1 - 1) / picture.page));
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) pages.push([px, py]);
    return pages;
};

/** Puts back (or forward) the pixels an entry changed, and puts their areas together again. */
export const applyPixelHistory = (stack: PaintStack, patches: readonly PixelPatch[], direction: 'undo' | 'redo'): void => {
    if (!stack.usable) throw new GpuResetError();
    const gpu = stack.host.gpu;
    const byChannels = new Map<string, { channels: PaintChannel[]; areas: Map<number, Rect[]> }>();
    for (const patch of patches) {
        const channel = patch.key.includes(':') ? patch.key.slice(patch.key.indexOf(':') + 1) as PaintChannel : null;
        const picture = channel ? stack.picture(patch.key, patch.tile) : stack.picture(patch.key, patch.tile, stack.maskFill(patch.key));
        for (const rect of patch.rects) {
            const px = Math.floor(rect.x / picture.page);
            const py = Math.floor(rect.y / picture.page);
            const page = picture.pageAt(px, py, true)!;
            const local = { x: rect.x - px * picture.page, y: rect.y - py * picture.page, width: rect.width, height: rect.height };
            if (direction === 'undo' && !rect.after) rect.after = readBlock(gpu, page, local.x, local.y, local.width, local.height);
            const pixels = direction === 'undo' ? rect.before : rect.after;
            if (pixels) writeBlock(gpu, page, pixels, local);
        }
        stack.touch(patch.key, patch.tile);
        if (patch.key.startsWith('bake:')) stack.noteBakeFix(patch.tile, patch.rects.map((rect) => ({ x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height })));
        const channels = channel && (PAINT_CHANNELS as readonly string[]).includes(channel) ? [channel] : stack.channelsOfEffect(patch.key);
        const group = channels.join(',');
        let entry = byChannels.get(group);
        if (!entry) byChannels.set(group, entry = { channels, areas: new Map() });
        const area = patch.rects.reduce<Rect | null>((sum, rect) => {
            const next = { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height };
            return sum ? unionRect(sum, next) : next;
        }, null);
        if (area) entry.areas.set(patch.tile, [...(entry.areas.get(patch.tile) ?? []), area]);
    }
    for (const { channels, areas } of byChannels.values()) stack.invalidate(channels, areas);
};
