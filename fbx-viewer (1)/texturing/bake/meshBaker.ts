import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { jumpFlood } from '../graph/nodes/distance';
import type { MeshMapName } from '../graph/nodes/io';
import type { PartMesh } from '../mesh/partMesh';
import { MeshTracer, TRACE_MESH_GLSL } from './meshTracer';
import { UvRaster } from './uvRaster';
import { BAKE_MEMORY_BUDGET, TABLE_WIDTH, autoCage, averagedNormals, bakeBytesPerTexel, bakeGroups, bandRanges, bandRows, planStrips, stripOffsets, supersampled, traceSteps, transferTables, type BakeStrip, type CageMode, type NamedBox, type Supersample, type TransferMaterial } from './bakeSetup';

/** Work one banded draw may do (ray steps): well inside what a GPU does before a driver resets it. */
const BAND_BUDGET = 24_000_000;

/** The next frame (or, while the window is hidden and frames stop, the next turn of the event loop). */
const nextFrame = (): Promise<void> => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden' && typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 34);
});

/** A bake the graphics card gave up on: said plainly. */
export class BakeLostError extends Error {
    constructor() {
        super('The graphics card stopped responding while baking, so the bake was stopped and nothing was kept. Try a smaller bake size or less supersampling.');
    }
}

const assertAlive = (gpu: TextureGpu): void => {
    if (gpu.renderer.getContext().isContextLost()) throw new BakeLostError();
};

/** Maps a bake can make besides the mesh maps graphs read. */
export const EXTRA_MAPS = ['cavity', 'bentNormal', 'color', 'opacity', 'material'] as const;
export type ExtraBakeMap = typeof EXTRA_MAPS[number];
export const EXTRA_MAP_LABELS: Record<ExtraBakeMap, string> = {
    cavity: 'Cavity', bentNormal: 'Bent normal', color: 'Colour (from the high-poly model)', opacity: 'Opacity (from the high-poly model)', material: 'Materials (from the high-poly model)',
};

/**
 * MESH MAP BAKING
 *
 * Maps of a texture set's surface, drawn texel by texel in UV space:
 *   - position (in a cube round the whole model, centred and scaled evenly by its longest side, so 3D
 *     noise keeps its shape on long or flat parts and lines up across the model's texture sets), world
 *     normal, IDs (by mesh, UV island or vertex colour);
 *   - from a high-poly model when one is given (else the surface itself): the tangent-space normal in the
 *     very frame the renderer uses, and height (how far out or in the detail is);
 *   - ambient occlusion and thickness, by rays against the whole model, many per texel, gathered over
 *     several frames so the editor stays responsive;
 *   - curvature, from how the world normal turns across neighbouring texels of the same surface.
 * Every map is padded past the islands' edges with its nearest texel, so filtering never pulls in
 * empty space and no seam shows.
 */

export interface BakeSettings {
    /** Picture size, a power of two. */
    size: number;
    maps: readonly MeshMapName[];
    /** Rays per texel for occlusion and thickness. */
    samples: number;
    /** How far occlusion looks, as a share of the model's size. */
    occlusionDistance: number;
    /** How far in front of and behind the surface a high-poly model is looked for, as a share of the model's size. */
    frontDistance: number;
    rearDistance: number;
    /** How strongly curvature shows. */
    curvatureStrength: number;
    idSource: 'mesh' | 'island' | 'vertexColor';
    /** Where high-poly rays start: a set distance out, a distance found from the models, or a cage mesh. */
    cage?: CageMode;
    /** Rays along normals averaged across hard edges, so they leave no gaps there. */
    averagedNormals?: boolean;
    /** The normal map's frame: as the renderer works it out (the mesh's tangents when it has them), or always from the UVs. */
    tangentSpace?: 'renderer' | 'uvs';
    /** Green pointing up the picture (OpenGL) or down it (DirectX). */
    normalConvention?: 'openGl' | 'directX';
    /** Texels baked per texel kept, along each side. */
    supersample?: Supersample;
    /** High-poly meshes matched to low-poly ones by name (_low / _high), else by where they are. */
    matchByName?: boolean;
    extras?: readonly ExtraBakeMap[];
}

export const DEFAULT_BAKE_SETTINGS: BakeSettings = {
    size: 11,
    maps: ['normal', 'worldNormal', 'ambientOcclusion', 'curvature', 'position', 'thickness', 'id', 'height'],
    samples: 128,
    occlusionDistance: 0.12,
    frontDistance: 0.01,
    rearDistance: 0.01,
    curvatureStrength: 1,
    idSource: 'island',
    cage: 'distance',
    averagedNormals: true,
    tangentSpace: 'renderer',
    normalConvention: 'openGl',
    supersample: 1,
    matchByName: true,
    extras: ['cavity'],
};

/**
 * Where 3D placement is measured from: a centre and the length of the longest side of a box. The position
 * map holds (place − centre) / extent + 0.5, and fills cast from three sides read the same.
 */
export interface PositionSpace { centre: [number, number, number]; extent: number }

/** The space of a box: its middle, and its longest side. */
export const spaceOfBox = (box: THREE.Box3): PositionSpace => {
    if (box.isEmpty()) return { centre: [0, 0, 0], extent: 1 };
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    return { centre: [centre.x, centre.y, centre.z], extent: Math.max(size.x, size.y, size.z, 1e-6) };
};

/**
 * Bakes are marked with the version they were made by. 2: position in an even space, normals,
 * occlusion and thickness at 16 bits. Older bakes keep their look until baked again.
 */
export const BAKE_VERSION = 2;

export interface BakeSources {
    part: PartMesh;
    /** The space the position map is measured in (a cube round the whole model by default). */
    space?: PositionSpace;
    /** What casts occlusion and blocks thickness: usually the whole model. */
    occluder: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
    /**
     * A detailed model in the same place, whose surface details are carried onto this one; with its meshes'
     * names and each triangle's mesh, for matching, and each triangle's material, for carrying colour over.
     */
    highPoly?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; triangleMesh?: ArrayLike<number>; meshNames?: string[]; triangleMaterial?: ArrayLike<number>; materials?: TransferMaterial[] };
    /** A cage mesh: per part vertex, the unit way out to its cage vertex and the distance (bakeSetup.meshCage). */
    cage?: Float32Array | null;
    /** The surface's own normal map, used for its details when there is no high-poly model. */
    normalMap?: THREE.Texture | null;
}

/** Baked maps for one tile, plus what painting needs to pad its own pictures the same way. */
export interface TileBake {
    maps: Partial<Record<MeshMapName, GpuImage>>;
    /** Cavity, bent normals and what was carried over from the high-poly model. */
    extras?: Partial<Record<ExtraBakeMap, GpuImage>>;
    /** Texels the surface covers (1) and does not (0). */
    coverage: GpuImage;
    /** For every texel, the place of the nearest covered texel (from jump flooding). */
    nearest: GpuImage;
}

const PAD = /* glsl */ `void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    if (texelFetch(coverage, p, 0).r > 0.5) { outColor = texelFetch(source, p, 0); return; }
    vec4 q = texelFetch(nearest, p, 0);
    outColor = q.z > 0.0 ? texelFetch(source, ivec2(q.xy), 0) : texelFetch(source, p, 0);
}`;

/** Pads `image` past its islands (using `bake.nearest`), returning a new image. */
export const padImage = (gpu: TextureGpu, image: GpuImage, coverage: GpuImage, nearest: GpuImage): GpuImage => {
    const padded = gpu.image(image.width, image.height, image.kind, image.precision);
    gpu.passNow(padded, { fragment: PAD, inputs: { source: image, coverage, nearest } });
    return padded;
};

export type BakeProgress = (fraction: number, step: string) => void;

const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
};

/**
 * Bakes the set's maps at `settings.size`, supersampled by its factor (within what the GPU takes), kept
 * at `outputSize` (the set's size; the bake's own when not given), each block of baked texels averaged
 * down by how much the surface covers it. A bake too large for the graphics memory it may take is baked
 * in strips of rows, each with a margin for maps that read neighbours, and averaged down strip by strip.
 */
export const bakeMeshMaps = async (gpu: TextureGpu, sources: BakeSources, settings: BakeSettings, progress: BakeProgress = () => undefined, signal?: AbortSignal, outputSize = settings.size): Promise<Map<number, TileBake>> => {
    const bytes = bakeBytesPerTexel(settings.maps, settings.extras ?? [], Boolean(sources.highPoly));
    const plan = supersampled(settings.size, settings.supersample ?? 1, gpu.maxSize);
    try {
        if (plan.size < outputSize) {
            // Baked smaller than the set and blended up.
            const baked = await bakeAtSize(gpu, sources, { ...settings, size: plan.size }, (fraction, step) => progress(fraction * 0.97, step), signal, true);
            try {
                assertAlive(gpu);
                return await resampleBake(gpu, sources.part, baked, outputSize);
            } finally {
                for (const result of baked.values()) releaseTileBake(gpu, result);
            }
        }
        const size = 2 ** plan.size;
        const strips = planStrips(size, 2 ** (plan.size - outputSize), bytes, stripBudget(outputSize), stripMargin(size));
        if (plan.size === outputSize && strips.length === 1) return await bakeAtSize(gpu, sources, { ...settings, size: plan.size }, progress, signal, false);
        return await bakeInStrips(gpu, sources, { ...settings, size: plan.size }, strips, outputSize, progress, signal);
    } catch (error) {
        // A lost context makes every later step fail ("did not compile"...): say what happened instead.
        if (gpu.renderer.getContext().isContextLost()) throw new BakeLostError();
        throw error;
    }
};

/** Memory a strip may take: the budget, less the set-sized maps it is averaged into. */
const stripBudget = (outputPower: number): number => Math.max(BAKE_MEMORY_BUDGET / 4, BAKE_MEMORY_BUDGET - (2 ** outputPower) ** 2 * 48);

/** Rows baked either side of a strip, for maps that read neighbours (curvature rings, its smoothing). */
export const stripMargin = (size: number): number => 16 * Math.max(1, size / 1024) + 4;

/** The strips a bake will be made in (for the panel to say), as bakeMeshMaps plans them. */
export const bakeStrips = (settings: BakeSettings, highPoly: boolean, maxSize: number, outputSize: number): { size: number; strips: number } => {
    const plan = supersampled(settings.size, settings.supersample ?? 1, maxSize);
    if (plan.size < outputSize) return { size: plan.size, strips: 1 };
    const size = 2 ** plan.size;
    return { size: plan.size, strips: planStrips(size, 2 ** (plan.size - outputSize), bakeBytesPerTexel(settings.maps, settings.extras ?? [], highPoly), stripBudget(outputSize), stripMargin(size)).length };
};

/** Baked maps scaled to `size`: blocks averaged by coverage (normals kept unit length, IDs not blended), or blended up. */
const RESAMPLE_BAKE = /* glsl */ `
uniform int uFactor;
uniform int uMode;
uniform vec2 uSourceAt;
uniform vec2 uTargetAt;
void main() {
    ivec2 base = (ivec2(gl_FragCoord.xy) - ivec2(uTargetAt)) * uFactor + ivec2(uSourceAt);
    if (uFactor <= 0) { outColor = texture(source, vUv); return; }
    if (uMode == 2) { outColor = texelFetch(source, base + ivec2(uFactor / 2), 0); return; }
    vec4 sum = vec4(0.0);
    float weight = 0.0;
    for (int y = 0; y < 16; y++) {
        if (y >= uFactor) break;
        for (int x = 0; x < 16; x++) {
            if (x >= uFactor) break;
            ivec2 q = base + ivec2(x, y);
            float c = texelFetch(cover, q, 0).r;
            sum += texelFetch(source, q, 0) * c;
            weight += c;
        }
    }
    vec4 v = weight > 0.0 ? sum / weight : texelFetch(source, base, 0);
    if (uMode == 1) v = vec4(normalize(v.xyz * 2.0 - 1.0) * 0.5 + 0.5, 1.0);
    outColor = v;
}`;

const resampleMode = (name: string): number => (name === 'normal' || name === 'worldNormal' || name === 'bentNormal' ? 1 : name === 'id' || name === 'material' ? 2 : 0);

/** Coverage and nearest-covered maps of a tile at `size`, for padding. */
const paddingAt = async (gpu: TextureGpu, raster: UvRaster, tile: number, size: number): Promise<{ coverage: GpuImage; nearest: GpuImage }> => {
    const coverage = gpu.image(size, size, 'gray', 8);
    raster.draw(coverage, tile, 'void main() { outColor = vec4(1.0); }', { clear: [0, 0, 0, 1] });
    return { coverage, nearest: await jumpFlood(gpu, coverage, size, size, 'm.r >= 0.5') };
};

const resampleBake = async (gpu: TextureGpu, part: PartMesh, baked: ReadonlyMap<number, TileBake>, power: number): Promise<Map<number, TileBake>> => {
    const size = 2 ** power;
    const raster = new UvRaster(gpu, part);
    const results = new Map<number, TileBake>();
    try {
        for (const [tile, from] of baked) {
            const { coverage, nearest } = await paddingAt(gpu, raster, tile, size);
            const scaled = (name: string, image: GpuImage): GpuImage => {
                const factor = image.width > size ? Math.round(image.width / size) : 0;
                const out = gpu.image(size, size, image.kind, image.precision);
                gpu.passNow(out, { fragment: RESAMPLE_BAKE, inputs: { source: image, cover: from.coverage }, uniforms: { uFactor: factor, uMode: resampleMode(name), uSourceAt: new THREE.Vector2(0, 0), uTargetAt: new THREE.Vector2(0, 0) } });
                const padded = padImage(gpu, out, coverage, nearest);
                gpu.release(out);
                return padded;
            };
            const maps: TileBake['maps'] = {};
            for (const [name, image] of Object.entries(from.maps)) if (image) maps[name as MeshMapName] = scaled(name, image);
            const extras: NonNullable<TileBake['extras']> = {};
            for (const [name, image] of Object.entries(from.extras ?? {})) if (image) extras[name as ExtraBakeMap] = scaled(name, image);
            results.set(tile, { maps, extras, coverage, nearest });
        }
        return results;
    } catch (error) {
        for (const result of results.values()) releaseTileBake(gpu, result);
        throw error;
    } finally {
        raster.dispose();
    }
};

/**
 * A bake in strips: each strip baked at the large size (with its margins), its own rows averaged into the
 * set-sized maps, and let go of before the next; the maps are padded once all strips are in.
 */
const bakeInStrips = async (gpu: TextureGpu, sources: BakeSources, settings: BakeSettings, strips: readonly BakeStrip[], outputPower: number, progress: BakeProgress, signal?: AbortSignal): Promise<Map<number, TileBake>> => {
    const out = 2 ** outputPower;
    const factor = Math.max(1, Math.round(2 ** settings.size / out));
    const kept = new Map<number, { maps: Partial<Record<string, GpuImage>>; extras: Partial<Record<string, GpuImage>> }>();
    // Worked out once, in the first strip, for the whole tile.
    const memo = new Map<number, { front: number; rear: number }>();
    const release = () => { for (const tile of kept.values()) for (const image of [...Object.values(tile.maps), ...Object.values(tile.extras)]) gpu.release(image); };
    try {
        for (let k = 0; k < strips.length; k++) {
            throwIfAborted(signal);
            const strip = strips[k];
            const label = strips.length > 1 ? ` (strip ${k + 1} of ${strips.length})` : '';
            const baked = await bakeAtSize(gpu, sources, settings, (fraction, step) => progress(((k + fraction) / strips.length) * 0.95, step + label), signal, true, strip, memo);
            try {
                assertAlive(gpu);
                const { sourceRow, targetRow } = stripOffsets(strip);
                for (const [tile, result] of baked) {
                    let into = kept.get(tile);
                    if (!into) kept.set(tile, into = { maps: {}, extras: {} });
                    const average = (store: Partial<Record<string, GpuImage>>, name: string, image: GpuImage) => {
                        let target = store[name];
                        if (!target) {
                            target = store[name] = gpu.image(out, out, image.kind, image.precision);
                            gpu.clear(target, [0, 0, 0, 1]);
                        }
                        gpu.passNow(target, {
                            fragment: RESAMPLE_BAKE,
                            inputs: { source: image, cover: result.coverage },
                            uniforms: { uFactor: factor, uMode: resampleMode(name), uSourceAt: new THREE.Vector2(0, sourceRow), uTargetAt: new THREE.Vector2(0, targetRow) },
                            scissor: { x: 0, y: strip.keep0, width: out, height: strip.keep1 - strip.keep0 },
                        });
                    };
                    for (const [name, image] of Object.entries(result.maps)) if (image) average(into.maps, name, image);
                    for (const [name, image] of Object.entries(result.extras ?? {})) if (image) average(into.extras, name, image);
                }
            } finally {
                for (const result of baked.values()) releaseTileBake(gpu, result);
            }
        }
        progress(0.97, 'Padding the maps');
        const raster = new UvRaster(gpu, sources.part);
        const results = new Map<number, TileBake>();
        try {
            for (const [tile, maps] of kept) {
                const { coverage, nearest } = await paddingAt(gpu, raster, tile, out);
                const pad = (store: Partial<Record<string, GpuImage>>) => Object.fromEntries(Object.entries(store).map(([name, image]) => [name, padImage(gpu, image!, coverage, nearest)]));
                results.set(tile, { maps: pad(maps.maps) as TileBake['maps'], extras: pad(maps.extras) as TileBake['extras'], coverage, nearest });
            }
        } finally {
            raster.dispose();
        }
        return results;
    } finally {
        release();
    }
};

const bakeAtSize = async (gpu: TextureGpu, sources: BakeSources, settings: BakeSettings, progress: BakeProgress, signal?: AbortSignal, scaledAfter = false,
    strip?: Pick<BakeStrip, 'from' | 'to'>, memo?: Map<number, { front: number; rear: number }>): Promise<Map<number, TileBake>> => {
    const { part } = sources;
    const size = 2 ** settings.size;
    // A strip bakes its rows (and margins) of the whole square: as tall as they are, as wide as the square.
    const tall = strip ? strip.to - strip.from : size;
    const raster = new UvRaster(gpu, part);
    raster.window = strip ? [0, strip.from / size, 1, strip.to / size] : null;
    const occluder = new MeshTracer(sources.occluder.positions, sources.occluder.normals, sources.occluder.indices);
    const highPoly = sources.highPoly;
    const extrasWanted = new Set<ExtraBakeMap>(settings.extras ?? []);
    // Cage rays: towards a cage mesh, or along normals averaged across hard edges.
    const cageRays = (settings.cage === 'mesh' && sources.cage) ? sources.cage : (settings.averagedNormals ?? true) ? (() => {
        const averaged = averagedNormals(part.positions, part.indices);
        const rays = new Float32Array(averaged.length / 3 * 4);
        for (let v = 0; v < averaged.length / 3; v++) rays.set([averaged[v * 3], averaged[v * 3 + 1], averaged[v * 3 + 2], -1], v * 4);
        return rays;
    })() : null;
    raster.setCage(cageRays);
    // Which high-poly triangles each low-poly mesh bakes from: one tracer for each different set of them.
    const boxesOf = (positions: ArrayLike<number>, indices: ArrayLike<number>, triangleMesh: ArrayLike<number>, names: readonly string[]): NamedBox[] => names.map((name, mesh) => {
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let t = 0; t < triangleMesh.length; t++) {
            if (triangleMesh[t] !== mesh) continue;
            for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
                const value = positions[indices[t * 3 + k] * 3 + a];
                min[a] = Math.min(min[a], value);
                max[a] = Math.max(max[a], value);
            }
        }
        return { name, min, max };
    });
    const groups: Array<{ lowMesh: number; tracer: MeshTracer; surface: THREE.DataTexture | null; material: THREE.DataTexture | null }> = [];
    const tracerOf = (triangles: number[] | null) => {
        if (!highPoly) return null;
        const pick = triangles ?? Array.from({ length: highPoly.indices.length / 3 }, (_, t) => t);
        const indices = new Uint32Array(pick.length * 3);
        pick.forEach((t, i) => indices.set(highPoly.indices.subarray(t * 3, t * 3 + 3), i * 3));
        const tracer = new MeshTracer(highPoly.positions, highPoly.normals, indices);
        let surface: THREE.DataTexture | null = null;
        let material: THREE.DataTexture | null = null;
        if (highPoly.triangleMaterial && highPoly.materials) {
            const tables = transferTables(pick.map((t) => highPoly.triangleMaterial![t]), highPoly.materials);
            surface = new THREE.DataTexture(tables.surface, tables.width, tables.height, THREE.RGBAFormat, THREE.FloatType);
            material = new THREE.DataTexture(tables.material, tables.width, tables.height, THREE.RGBAFormat, THREE.FloatType);
            surface.needsUpdate = material.needsUpdate = true;
        }
        return { tracer, surface, material };
    };
    if (highPoly) {
        const occluderBox = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(sources.occluder.positions, 3));
        const margin = Math.max(settings.frontDistance, settings.rearDistance) * occluderBox.getSize(new THREE.Vector3()).length() * 2;
        const lowBoxes = part.meshNames.length > 1 && highPoly.triangleMesh && highPoly.meshNames && highPoly.meshNames.length > 1
            ? boxesOf(part.positions, part.indices, part.triangleMesh, part.meshNames) : null;
        const highBoxes = lowBoxes ? boxesOf(highPoly.positions, highPoly.indices, highPoly.triangleMesh!, highPoly.meshNames!) : null;
        const matched = lowBoxes && highBoxes ? bakeGroups(lowBoxes, highBoxes, margin, settings.matchByName ?? true) : null;
        if (!matched || matched.every((list) => list.length === highBoxes!.length)) groups.push({ lowMesh: -1, ...tracerOf(null)! });
        else {
            matched.forEach((meshes, lowMesh) => {
                const wanted = new Set(meshes);
                const triangles: number[] = [];
                for (let t = 0; t < highPoly.triangleMesh!.length; t++) if (wanted.has(highPoly.triangleMesh![t])) triangles.push(t);
                groups.push({ lowMesh, ...tracerOf(triangles)! });
            });
        }
    }
    const high = groups[0]?.tracer ?? null;
    const occluderBox = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(sources.occluder.positions, 3));
    const space = sources.space ?? spaceOfBox(occluderBox);
    const diagonal = Math.max(1e-6, occluderBox.getSize(new THREE.Vector3()).length());
    const bias = diagonal * 2e-4;
    const want = new Set(settings.maps);
    const results = new Map<number, TileBake>();
    const tiles = part.tiles;
    const steps = tiles.length * (4 + (want.has('ambientOcclusion') ? 4 : 0) + (want.has('thickness') ? 2 : 0));
    let done = 0;
    const step = (label: string) => progress(Math.min(1, ++done / steps), label);
    try {
        for (const tile of tiles) {
            throwIfAborted(signal);
            // Everything this tile takes, so a cancel or a failure part way through gives it all back.
            const own: GpuImage[] = [];
            const take = (image: GpuImage): GpuImage => { own.push(image); return image; };
            const maps: TileBake['maps'] = {};
            try {
                // Texture-space area of the tile's triangles, for the size of a texel on the model.
                let uvArea = 0;
                let worldArea = 0;
                for (let t = 0; t < part.triangleTile.length; t++) {
                    if (part.triangleTile[t] !== tile) continue;
                    const [a, b, c] = [0, 1, 2].map((k) => part.indices[t * 3 + k]);
                    uvArea += Math.abs((part.uvs[b * 2] - part.uvs[a * 2]) * (part.uvs[c * 2 + 1] - part.uvs[a * 2 + 1]) - (part.uvs[c * 2] - part.uvs[a * 2]) * (part.uvs[b * 2 + 1] - part.uvs[a * 2 + 1])) / 2;
                    const ab = new THREE.Vector3().fromArray(part.positions, b * 3).sub(new THREE.Vector3().fromArray(part.positions, a * 3));
                    const ac = new THREE.Vector3().fromArray(part.positions, c * 3).sub(new THREE.Vector3().fromArray(part.positions, a * 3));
                    worldArea += ab.cross(ac).length() / 2;
                }
                const texelWorld = Math.sqrt(worldArea / Math.max(1e-9, uvArea * size * size));

                // Where each texel is on the model, and its smooth normal.
                const position = take(gpu.image(size, tall, 'color', 32));
                raster.draw(position, tile, 'void main() { outColor = vec4(vPos, 1.0); }', { clear: [0, 0, 0, 0] });
                const lowNormal = take(gpu.image(size, tall, 'color', 16));
                raster.draw(lowNormal, tile, 'void main() { outColor = vec4(normalize(vNormal), 1.0); }', { clear: [0, 0, 1, 0] });
                const coverage = take(gpu.image(size, tall, 'gray', 8));
                gpu.passNow(coverage, { fragment: 'void main() { outColor = vec4(texelFetch(source, ivec2(gl_FragCoord.xy), 0).a); }', inputs: { source: position } });
                // Padding needs the nearest covered texel; a bake scaled afterwards is padded at the set's size instead.
                const nearest = scaledAfter ? take(gpu.retain(coverage)) : take(await jumpFlood(gpu, coverage, size, tall, 'm.r >= 0.5'));
                const occluderSteps = traceSteps(sources.occluder.indices.length / 3);
                step('Laying out the surface');

                // Detail: the high-poly surface (or the surface's own normal map) as world and tangent normals, and height.
                const worldNormal = take(gpu.image(size, tall, 'color', 16));
                // Normals at 8 bits show steps across smooth curves once lit: kept in half floats.
                const tangentNormal = take(gpu.image(size, tall, 'color', 16));
                const height = take(gpu.image(size, tall, 'gray', 16));
                let front = settings.frontDistance * diagonal;
                let rear = settings.rearDistance * diagonal;
                const frame = { uFrameFromUvs: settings.tangentSpace === 'uvs' ? 1 : 0, uDirectX: settings.normalConvention === 'directX' ? 1 : 0 };
                const extras: NonNullable<TileBake['extras']> = {};
                if (high) {
                    const known = memo?.get(tile);
                    if (known) ({ front, rear } = known);
                    else if (settings.cage === 'auto') {
                        // How far the high-poly surface lies from this one, on a coarse grid of texels, both ways.
                        const probeSize = Math.min(size, 128);
                        const probe = gpu.image(probeSize, probeSize, 'color', 32);
                        // The whole tile, whatever strip this is.
                        const window = raster.window;
                        raster.window = null;
                        raster.draw(probe, tile, `${TRACE_MESH_GLSL}
    uniform float uReach;
    uniform int uCageRays;
    void main() {
        vec3 n = normalize(vNormal);
        vec3 dir = uCageRays == 1 && dot(vCage.xyz, vCage.xyz) > 1e-12 ? normalize(vCage.xyz) : n;
        TraceHit outward;
        TraceHit inward;
        bool o = traceMesh(vPos, dir, 0.0, uReach, outward);
        bool i = traceMesh(vPos, -dir, 0.0, uReach, inward);
        float gap = o && (!i || outward.t <= inward.t) ? outward.t : i ? -inward.t : 0.0;
        outColor = vec4(gap, o || i ? 1.0 : 0.0, 0.0, 1.0);
    }`, { uniforms: { tTris: high.triangles, tNodes: high.nodes, uReach: diagonal * 0.1, uCageRays: cageRays ? 1 : 0 }, clear: [0, 0, 0, 0], edges: false });
                        raster.window = window;
                        const read = gpu.readFloat(probe);
                        gpu.release(probe);
                        const gaps: number[] = [];
                        for (let i = 0; i < read.length; i += 4) if (read[i + 1] > 0.5) gaps.push(read[i]);
                        ({ front, rear } = autoCage(gaps, front));
                        memo?.set(tile, { front, rear });
                    }
                    const detail = `${TRACE_MESH_GLSL}
    uniform float uFront;
    uniform float uRear;
    uniform int uMode;
    uniform int uCageRays;
    uniform int uOnlyMesh;
    uniform int uDirectX;
    uniform sampler2D uSurfaceTable;
    uniform sampler2D uMaterialTable;
    void main() {
        if (uOnlyMesh >= 0 && int(vIds.y + 0.5) != uOnlyMesh) discard;
        vec3 n = normalize(vNormal);
        // Along the cage ray (an averaged normal, or towards the cage mesh) or the texel's own normal.
        vec3 dir = uCageRays == 1 && dot(vCage.xyz, vCage.xyz) > 1e-12 ? normalize(vCage.xyz) : n;
        float front = uCageRays == 1 && vCage.w >= 0.0 ? vCage.w : uFront;
        vec3 world = n;
        float offset = 0.0;
        TraceHit hit;
        // From the outside of the cage inwards: the first surface met is the one the eye would see.
        bool found = traceMesh(vPos + dir * front, -dir, 0.0, front + uRear, hit);
        if (found) {
            world = hitNormal(hit);
            if (dot(world, n) < 0.0) world = -world;
            offset = front - hit.t;
        }
        if (uMode == 0) { outColor = vec4(world, 1.0); return; }
        if (uMode == 1) {
            vec3 t = normalize(inverse(surfaceFrame(n)) * world);
            if (uDirectX == 1) t.y = -t.y;
            outColor = vec4(t * 0.5 + 0.5, 1.0);
            return;
        }
        if (uMode == 2) { outColor = vec4(0.5 + 0.5 * offset / max(max(front, uRear), 1e-9)); return; }
        ivec2 at = ivec2(hit.tri % ${TABLE_WIDTH}, hit.tri / ${TABLE_WIDTH});
        if (uMode == 3) { outColor = found ? vec4(texelFetch(uSurfaceTable, at, 0).rgb, 1.0) : vec4(0.5, 0.5, 0.5, 1.0); return; }
        if (uMode == 4) { outColor = vec4(found ? texelFetch(uSurfaceTable, at, 0).a : 1.0); return; }
        outColor = found ? vec4(texelFetch(uMaterialTable, at, 0).rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
    }`;
                    const targets: Array<{ image: GpuImage; mode: number; clear: [number, number, number, number] }> = [
                        { image: worldNormal, mode: 0, clear: [0, 0, 1, 0] },
                        { image: tangentNormal, mode: 1, clear: [0.5, 0.5, 1, 1] },
                        { image: height, mode: 2, clear: [0.5, 0.5, 0.5, 1] },
                    ];
                    const transfers = Boolean(highPoly?.triangleMaterial && highPoly.materials);
                    if (transfers && extrasWanted.has('color')) targets.push({ image: extras.color = take(gpu.image(size, tall, 'color', 8)), mode: 3, clear: [0.5, 0.5, 0.5, 1] });
                    if (transfers && extrasWanted.has('opacity')) targets.push({ image: extras.opacity = take(gpu.image(size, tall, 'gray', 16)), mode: 4, clear: [1, 1, 1, 1] });
                    if (transfers && extrasWanted.has('material')) targets.push({ image: extras.material = take(gpu.image(size, tall, 'color', 8)), mode: 5, clear: [0, 0, 0, 1] });
                    // Each draw traces a ray per texel: drawn in bands of rows, a frame apart, so none runs long.
                    const rows = bandRows(size, size, traceSteps((highPoly?.indices.length ?? 3) / 3) * groups.length, BAND_BUDGET);
                    for (const target of targets) {
                        for (const [y0, y1] of bandRanges(tall, rows)) {
                            throwIfAborted(signal);
                            groups.forEach((group, g) => {
                                raster.draw(target.image, tile, detail, {
                                    uniforms: {
                                        tTris: group.tracer.triangles, tNodes: group.tracer.nodes, uFront: front, uRear: rear, uMode: target.mode, uCageRays: cageRays ? 1 : 0,
                                        uOnlyMesh: group.lowMesh, ...frame, uSurfaceTable: group.surface ?? gpu.constant('white'), uMaterialTable: group.material ?? gpu.constant('black'),
                                    },
                                    clear: g === 0 ? target.clear : null,
                                    scissor: { x0: 0, y0, x1: size, y1 },
                                });
                            });
                            assertAlive(gpu);
                            await nextFrame();
                        }
                    }
                } else {
                    const map = sources.normalMap ?? null;
                    const own = `uniform sampler2D uNormalMap;\nuniform int uHasMap;\nuniform vec2 uTile;\nuniform int uMode;
    uniform int uDirectX;
    void main() {
        vec3 n = normalize(vNormal);
        vec3 t = vec3(0.0, 0.0, 1.0);
        if (uHasMap == 1) {
            // Normal maps may be kept as two channels (BC5): the third is rebuilt, as the renderer does.
            vec2 xy = texture(uNormalMap, vSourceUv).xy * 2.0 - 1.0;
            t = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
        }
        if (uMode == 0) { outColor = vec4(normalize(surfaceFrame(n) * t), 1.0); return; }
        if (uDirectX == 1) t.y = -t.y;
        outColor = vec4(t * 0.5 + 0.5, 1.0);
    }`;
                    const uniforms = { uNormalMap: map ?? gpu.constant('normal'), uHasMap: map ? 1 : 0, ...frame };
                    raster.draw(worldNormal, tile, own, { uniforms: { ...uniforms, uMode: 0 }, clear: [0, 0, 1, 0] });
                    raster.draw(tangentNormal, tile, own, { uniforms: { ...uniforms, uMode: 1 }, clear: [0.5, 0.5, 1, 1] });
                    gpu.clear(height, [0.5, 0.5, 0.5, 1]);
                }
                step('Carrying over detail');

                // Ambient occlusion: cosine-weighted rays round the detailed normal, from just off the surface.
                if (want.has('ambientOcclusion')) {
                    // The share of each batch's rays that met something, added up batch by batch.
                    const sum = take(gpu.image(size, tall, 'gray', 32));
                    gpu.clear(sum, [0, 0, 0, 0]);
                    const batch = 16;
                    const batches = Math.max(1, Math.ceil(settings.samples / batch));
                    for (let b = 0; b < batches; b++) {
                        throwIfAborted(signal);
                        await gpu.pass(sum, {
                            fragment: `${TRACE_MESH_GLSL}
    uniform float uDistance;
    uniform float uBias;
    uniform float uBatch;
    uniform int uRays;
    void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 pos = texelFetch(gPos, p, 0);
        if (pos.a < 0.5) { outColor = vec4(0.0); return; }
        vec3 low = normalize(texelFetch(gLow, p, 0).xyz);
        vec3 n = normalize(texelFetch(gWorld, p, 0).xyz);
        if (dot(n, low) < 0.05) n = low;
        vec3 helper = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 tx = normalize(cross(helper, n));
        vec3 ty = cross(n, tx);
        vec3 origin = pos.xyz + low * uBias;
        float hits = 0.0;
        for (int i = 0; i < 16; i++) {
            if (i >= uRays) break;
            vec2 xi = vec2(hash1(p, uBatch * 16.0 + float(i)), hash1(p, uBatch * 16.0 + float(i) + 0.5));
            float r = sqrt(xi.x);
            float a = TAU * xi.y;
            vec3 d = normalize(tx * r * cos(a) + ty * r * sin(a) + n * sqrt(max(0.0, 1.0 - xi.x)));
            if (dot(d, low) < 0.0) d = reflect(d, low);
            TraceHit hit;
            if (traceMesh(origin, d, uBias, uDistance, hit)) hits += 1.0;
        }
        outColor = vec4(hits / float(uRays));
    }`,
                            inputs: { gPos: position, gLow: lowNormal, gWorld: worldNormal, tTris: occluder.triangles, tNodes: occluder.nodes },
                            uniforms: { uDistance: settings.occlusionDistance * diagonal, uBias: bias, uBatch: b, uRays: Math.min(batch, settings.samples - b * batch) },
                            blend: 'add',
                            cost: 16 * occluderSteps,
                        });
                        assertAlive(gpu);
                        if (b % Math.ceil(batches / 4) === 0) step('Gathering occlusion');
                    }
                    const ao = take(gpu.image(size, tall, 'gray', 16));
                    gpu.passNow(ao, { fragment: 'uniform float uBatches;\nvoid main() { outColor = vec4(1.0 - texelFetch(source, ivec2(gl_FragCoord.xy), 0).r / uBatches); }', inputs: { source: sum }, uniforms: { uBatches: batches } });
                    gpu.release(sum);
                    maps.ambientOcclusion = ao;
                }

                // Thickness: how far rays into the surface travel before leaving it.
                if (want.has('thickness')) {
                    const thickness = take(gpu.image(size, tall, 'gray', 16));
                    await gpu.pass(thickness, {
                        fragment: `${TRACE_MESH_GLSL}
    uniform float uDistance;
    uniform float uBias;
    uniform int uRays;
    void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 pos = texelFetch(gPos, p, 0);
        if (pos.a < 0.5) { outColor = vec4(1.0); return; }
        vec3 n = -normalize(texelFetch(gLow, p, 0).xyz);
        vec3 helper = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 tx = normalize(cross(helper, n));
        vec3 ty = cross(n, tx);
        float total = 0.0;
        for (int i = 0; i < 32; i++) {
            if (i >= uRays) break;
            vec2 xi = vec2(hash1(p, float(i) + 101.0), hash1(p, float(i) + 101.5));
            // Within about 60 degrees of straight in.
            float r = sqrt(xi.x) * 0.85;
            float a = TAU * xi.y;
            vec3 d = normalize(tx * r * cos(a) + ty * r * sin(a) + n * sqrt(max(0.0, 1.0 - r * r)));
            TraceHit hit;
            total += traceMesh(pos.xyz + n * uBias, d, uBias, uDistance, hit) ? hit.t / uDistance : 1.0;
        }
        outColor = vec4(total / float(uRays));
    }`,
                        inputs: { gPos: position, gLow: lowNormal, tTris: occluder.triangles, tNodes: occluder.nodes },
                        uniforms: { uDistance: settings.occlusionDistance * diagonal * 2, uBias: bias, uRays: Math.min(32, Math.max(8, settings.samples >> 2)) },
                        cost: 32 * occluderSteps,
                    });
                    assertAlive(gpu);
                    maps.thickness = thickness;
                    step('Measuring thickness');
                }

                // Bent normals: the average open direction of occlusion rays round each texel, in the model's space.
                if (extrasWanted.has('bentNormal')) {
                    const open = take(gpu.image(size, tall, 'color', 16));
                    gpu.clear(open, [0, 0, 0, 0]);
                    const rays = Math.min(64, Math.max(16, settings.samples >> 1));
                    for (let b = 0; b < Math.ceil(rays / 16); b++) {
                        throwIfAborted(signal);
                        await gpu.pass(open, {
                            fragment: `${TRACE_MESH_GLSL}
    uniform float uDistance;
    uniform float uBias;
    uniform float uBatch;
    void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 pos = texelFetch(gPos, p, 0);
        if (pos.a < 0.5) { outColor = vec4(0.0); return; }
        vec3 low = normalize(texelFetch(gLow, p, 0).xyz);
        vec3 n = normalize(texelFetch(gWorld, p, 0).xyz);
        if (dot(n, low) < 0.05) n = low;
        vec3 helper = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 tx = normalize(cross(helper, n));
        vec3 ty = cross(n, tx);
        vec3 sum = vec3(0.0);
        for (int i = 0; i < 16; i++) {
            vec2 xi = vec2(hash1(p, 300.0 + uBatch * 16.0 + float(i)), hash1(p, 300.5 + uBatch * 16.0 + float(i)));
            float r = sqrt(xi.x);
            float a = TAU * xi.y;
            vec3 d = normalize(tx * r * cos(a) + ty * r * sin(a) + n * sqrt(max(0.0, 1.0 - xi.x)));
            if (dot(d, low) < 0.0) d = reflect(d, low);
            TraceHit hit;
            if (!traceMesh(pos.xyz + low * uBias, d, uBias, uDistance, hit)) sum += d;
        }
        outColor = vec4(sum, 0.0);
    }`,
                            inputs: { gPos: position, gLow: lowNormal, gWorld: worldNormal, tTris: occluder.triangles, tNodes: occluder.nodes },
                            uniforms: { uDistance: settings.occlusionDistance * diagonal, uBias: bias, uBatch: b },
                            blend: 'add',
                            cost: 16 * occluderSteps,
                        });
                        assertAlive(gpu);
                    }
                    const bent = take(gpu.image(size, tall, 'color', 16));
                    gpu.passNow(bent, { fragment: 'void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec3 s = texelFetch(source, p, 0).xyz; vec3 n = normalize(texelFetch(low, p, 0).xyz); outColor = vec4((dot(s, s) > 1e-12 ? normalize(s) : n) * 0.5 + 0.5, 1.0); }', inputs: { source: open, low: lowNormal } });
                    gpu.release(open);
                    extras.bentNormal = bent;
                }

                // Curvature: how fast the normal turns towards (bright) or away from (dark) neighbouring texels of the same surface.
                if (want.has('curvature') || extrasWanted.has('cavity')) {
                    const curvature = take(gpu.image(size, tall, 'gray', 16));
                    await gpu.pass(curvature, {
                        fragment: `uniform float uTexel;
    uniform float uStrength;
    uniform float uRings;
    void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 pos = texelFetch(gPos, p, 0);
        if (pos.a < 0.5) { outColor = vec4(0.5); return; }
        vec3 n = normalize(texelFetch(gWorld, p, 0).xyz);
        float total = 0.0;
        float weight = 0.0;
        // How far the normal turns towards (out, bright) or away from (in, dark) neighbours in rings of
        // growing size: a sharp edge lights a band as wide as the largest ring, fading away from it.
        for (int ring = 0; ring < 5; ring++) {
            float r = pow(2.0, float(ring)) * uRings;
            float ringTotal = 0.0;
            float ringCount = 0.0;
            for (int k = 0; k < 8; k++) {
                float a = float(k) * PI * 0.25 + float(ring) * 0.39;
                ivec2 q = p + ivec2(round(vec2(cos(a), sin(a)) * r));
                vec4 qp = texelFetch(gPos, q, 0);
                if (qp.a < 0.5) continue;
                vec3 d = qp.xyz - pos.xyz;
                float len = length(d);
                // Across a seam the neighbouring texel is somewhere else on the model: skip it.
                if (len < 1e-9 || len > uTexel * r * 3.0) continue;
                vec3 m = normalize(texelFetch(gWorld, q, 0).xyz);
                ringTotal += dot(m - n, d / len);
                ringCount += 1.0;
            }
            if (ringCount > 0.0) {
                float w = 1.0 / (1.0 + float(ring) * 0.5);
                total += ringTotal / ringCount * w;
                weight += w;
            }
        }
        float c = weight > 0.0 ? total / weight : 0.0;
        outColor = vec4(saturate(0.5 + c * uStrength * 1.5));
    }`,
                        inputs: { gPos: position, gWorld: worldNormal },
                        uniforms: { uTexel: texelWorld, uStrength: settings.curvatureStrength, uRings: Math.max(1, size / 1024) },
                        cost: 48,
                    });
                    // A light blur keeps texel noise out.
                    const smooth = take(gpu.image(size, tall, 'gray', 16));
                    gpu.passNow(smooth, {
                        fragment: `void main() { ivec2 p = ivec2(gl_FragCoord.xy); float c = texelFetch(source, p, 0).r; if (texelFetch(cover, p, 0).r < 0.5) { outColor = vec4(c); return; }
        float sum = c * 2.0; float w = 2.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { if (x == 0 && y == 0) continue; ivec2 q = p + ivec2(x, y); if (texelFetch(cover, q, 0).r < 0.5) continue; sum += texelFetch(source, q, 0).r; w += 1.0; }
        outColor = vec4(sum / w); }`,
                        inputs: { source: curvature, cover: coverage },
                    });
                    gpu.release(curvature);
                    if (extrasWanted.has('cavity')) {
                        // Cavity: mid-grey where the surface is even, darker in crevices, lighter on raised edges.
                        const cavity = take(gpu.image(size, tall, 'gray', 16));
                        gpu.passNow(cavity, { fragment: 'void main() { outColor = vec4(saturate(0.5 + (texelFetch(source, ivec2(gl_FragCoord.xy), 0).r - 0.5) * 1.5)); }', inputs: { source: smooth } });
                        extras.cavity = cavity;
                    }
                    if (want.has('curvature')) maps.curvature = smooth;
                    else gpu.release(smooth);
                    step('Reading curvature');
                }

                if (want.has('position')) {
                    // Scaled evenly (by the space's longest side) and centred: scaling each axis on its own
                    // would stretch noise read from it on long or flat parts.
                    const positionMap = take(gpu.image(size, tall, 'color', 16));
                    gpu.passNow(positionMap, {
                        fragment: 'uniform vec3 uCentre;\nuniform float uExtent;\nvoid main() { vec4 p = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4((p.xyz - uCentre) / uExtent + 0.5, 1.0); }',
                        inputs: { source: position },
                        uniforms: { uCentre: new THREE.Vector3(...space.centre), uExtent: Math.max(space.extent, 1e-9) },
                    });
                    maps.position = positionMap;
                }
                if (want.has('id')) {
                    const id = take(gpu.image(size, tall, 'color', 8));
                    const mode = settings.idSource === 'mesh' ? 1 : settings.idSource === 'vertexColor' ? 2 : 0;
                    raster.draw(id, tile, `uniform int uMode;\nvoid main() {
        if (uMode == 2) { outColor = vec4(vColor, 1.0); return; }
        float key = uMode == 1 ? vIds.y : vIds.x;
        // Golden-ratio steps round the hue wheel keep neighbouring ids apart.
        outColor = vec4(hslToRgb(vec3(fract(key * 0.618034 + 0.13), 0.65, 0.55)), 1.0);
    }`, { uniforms: { uMode: mode }, clear: [0, 0, 0, 1] });
                    maps.id = id;
                }
                if (want.has('worldNormal')) {
                    const encoded = take(gpu.image(size, tall, 'color', 16));
                    gpu.passNow(encoded, { fragment: 'void main() { vec4 n = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4(n.a > 0.5 ? normalize(n.xyz) * 0.5 + 0.5 : vec3(0.5, 0.5, 1.0), 1.0); }', inputs: { source: worldNormal } });
                    maps.worldNormal = encoded;
                }
                if (want.has('normal')) maps.normal = gpu.retain(tangentNormal);
                if (want.has('height')) maps.height = gpu.retain(height);
                step('Finishing maps');

                // Pad every map past its islands (a bake scaled afterwards is padded once scaled).
                for (const key of scaledAfter ? [] : Object.keys(maps) as MeshMapName[]) {
                    const padded = take(padImage(gpu, maps[key]!, coverage, nearest));
                    gpu.release(maps[key]);
                    maps[key] = padded;
                }
                for (const key of scaledAfter ? [] : Object.keys(extras) as ExtraBakeMap[]) {
                    const padded = take(padImage(gpu, extras[key]!, coverage, nearest));
                    gpu.release(extras[key]);
                    extras[key] = padded;
                }
                gpu.release(position);
                gpu.release(lowNormal);
                gpu.release(worldNormal);
                gpu.release(tangentNormal);
                gpu.release(height);
                results.set(tile, { maps, extras, coverage, nearest });
                step('Done');
            } catch (error) {
                for (const image of Object.values(maps)) gpu.release(image);
                for (const image of own) gpu.release(image);
                throw error;
            }
        }
        return results;
    } catch (error) {
        for (const result of results.values()) releaseTileBake(gpu, result);
        throw error;
    } finally {
        raster.dispose();
        occluder.dispose();
        for (const group of groups) {
            group.tracer.dispose();
            group.surface?.dispose();
            group.material?.dispose();
        }
    }
};

export const releaseTileBake = (gpu: TextureGpu, bake: TileBake): void => {
    for (const image of Object.values(bake.maps)) gpu.release(image);
    for (const image of Object.values(bake.extras ?? {})) gpu.release(image);
    gpu.release(bake.coverage);
    gpu.release(bake.nearest);
};
