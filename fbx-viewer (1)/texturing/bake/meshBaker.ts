import * as THREE from 'three';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { jumpFlood } from '../graph/nodes/distance';
import type { MeshMapName } from '../graph/nodes/io';
import type { PartMesh } from '../mesh/partMesh';
import { MeshTracer, TRACE_MESH_GLSL } from './meshTracer';
import { UvRaster } from './uvRaster';

/**
 * MESH MAP BAKING
 *
 * Maps of a texture set's surface, drawn texel by texel in UV space:
 *   - position (in the surface's box, 0..1), world normal, IDs (by mesh, UV island or vertex colour);
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
};

export interface BakeSources {
    part: PartMesh;
    /** What casts occlusion and blocks thickness: usually the whole model. */
    occluder: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
    /** A detailed model in the same place, whose surface details are carried onto this one. */
    highPoly?: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
    /** The surface's own normal map, used for its details when there is no high-poly model. */
    normalMap?: THREE.Texture | null;
}

/** Baked maps for one tile, plus what painting needs to pad its own pictures the same way. */
export interface TileBake {
    maps: Partial<Record<MeshMapName, GpuImage>>;
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

export const bakeMeshMaps = async (gpu: TextureGpu, sources: BakeSources, settings: BakeSettings, progress: BakeProgress = () => undefined, signal?: AbortSignal): Promise<Map<number, TileBake>> => {
    const { part } = sources;
    const size = 2 ** settings.size;
    const raster = new UvRaster(gpu, part);
    const occluder = new MeshTracer(sources.occluder.positions, sources.occluder.normals, sources.occluder.indices);
    const high = sources.highPoly ? new MeshTracer(sources.highPoly.positions, sources.highPoly.normals, sources.highPoly.indices) : null;
    const box = part.bounds.clone();
    const occluderBox = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(sources.occluder.positions, 3));
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
            const position = gpu.image(size, size, 'color', 32);
            raster.draw(position, tile, 'void main() { outColor = vec4(vPos, 1.0); }', { clear: [0, 0, 0, 0] });
            const lowNormal = gpu.image(size, size, 'color', 16);
            raster.draw(lowNormal, tile, 'void main() { outColor = vec4(normalize(vNormal), 1.0); }', { clear: [0, 0, 1, 0] });
            const coverage = gpu.image(size, size, 'gray', 8);
            gpu.passNow(coverage, { fragment: 'void main() { outColor = vec4(texelFetch(source, ivec2(gl_FragCoord.xy), 0).a); }', inputs: { source: position } });
            const nearest = await jumpFlood(gpu, coverage, size, size, 'm.r >= 0.5');
            step('Laying out the surface');

            // Detail: the high-poly surface (or the surface's own normal map) as world and tangent normals, and height.
            const worldNormal = gpu.image(size, size, 'color', 16);
            const tangentNormal = gpu.image(size, size, 'color', 8);
            const height = gpu.image(size, size, 'gray', 16);
            const front = settings.frontDistance * diagonal;
            const rear = settings.rearDistance * diagonal;
            if (high) {
                const detail = `${TRACE_MESH_GLSL}
uniform float uFront;
uniform float uRear;
uniform int uMode;
void main() {
    vec3 n = normalize(vNormal);
    vec3 world = n;
    float offset = 0.0;
    TraceHit hit;
    // From the outside of the cage inwards: the first surface met is the one the eye would see.
    if (traceMesh(vPos + n * uFront, -n, 0.0, uFront + uRear, hit)) {
        world = hitNormal(hit);
        if (dot(world, n) < 0.0) world = -world;
        offset = uFront - hit.t;
    }
    if (uMode == 0) { outColor = vec4(world, 1.0); return; }
    if (uMode == 1) {
        mat3 frame = surfaceFrame(n);
        vec3 t = inverse(frame) * world;
        outColor = vec4(normalize(t) * 0.5 + 0.5, 1.0);
        return;
    }
    outColor = vec4(0.5 + 0.5 * offset / max(max(uFront, uRear), 1e-9));
}`;
                const uniforms = { tTris: high.triangles, tNodes: high.nodes, uFront: front, uRear: rear };
                raster.draw(worldNormal, tile, detail, { uniforms: { ...uniforms, uMode: 0 }, clear: [0, 0, 1, 0] });
                raster.draw(tangentNormal, tile, detail, { uniforms: { ...uniforms, uMode: 1 }, clear: [0.5, 0.5, 1, 1] });
                raster.draw(height, tile, detail, { uniforms: { ...uniforms, uMode: 2 }, clear: [0.5, 0.5, 0.5, 1] });
            } else {
                const map = sources.normalMap ?? null;
                const own = `uniform sampler2D uNormalMap;\nuniform int uHasMap;\nuniform vec2 uTile;\nuniform int uMode;
void main() {
    vec3 n = normalize(vNormal);
    vec3 t = vec3(0.0, 0.0, 1.0);
    if (uHasMap == 1) {
        // Normal maps may be kept as two channels (BC5): the third is rebuilt, as the renderer does.
        vec2 xy = texture(uNormalMap, vSourceUv).xy * 2.0 - 1.0;
        t = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
    }
    if (uMode == 0) { outColor = vec4(normalize(surfaceFrame(n) * t), 1.0); return; }
    outColor = vec4(t * 0.5 + 0.5, 1.0);
}`;
                const uniforms = { uNormalMap: map ?? gpu.constant('normal'), uHasMap: map ? 1 : 0 };
                raster.draw(worldNormal, tile, own, { uniforms: { ...uniforms, uMode: 0 }, clear: [0, 0, 1, 0] });
                raster.draw(tangentNormal, tile, own, { uniforms: { ...uniforms, uMode: 1 }, clear: [0.5, 0.5, 1, 1] });
                gpu.clear(height, [0.5, 0.5, 0.5, 1]);
            }
            step('Carrying over detail');
            const maps: TileBake['maps'] = {};

            // Ambient occlusion: cosine-weighted rays round the detailed normal, from just off the surface.
            if (want.has('ambientOcclusion')) {
                const sum = gpu.image(size, size, 'color', 32);
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
    outColor = vec4(hits, float(uRays), 0.0, 0.0);
}`,
                        inputs: { gPos: position, gLow: lowNormal, gWorld: worldNormal, tTris: occluder.triangles, tNodes: occluder.nodes },
                        uniforms: { uDistance: settings.occlusionDistance * diagonal, uBias: bias, uBatch: b, uRays: Math.min(batch, settings.samples - b * batch) },
                        blend: 'add',
                        cost: 16 * 60,
                    });
                    if (b % Math.ceil(batches / 4) === 0) step('Gathering occlusion');
                }
                const ao = gpu.image(size, size, 'gray', 16);
                gpu.passNow(ao, { fragment: 'void main() { vec4 s = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4(s.g > 0.0 ? 1.0 - s.r / s.g : 1.0); }', inputs: { source: sum } });
                gpu.release(sum);
                maps.ambientOcclusion = ao;
            }

            // Thickness: how far rays into the surface travel before leaving it.
            if (want.has('thickness')) {
                const thickness = gpu.image(size, size, 'gray', 16);
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
                    cost: 32 * 60,
                });
                maps.thickness = thickness;
                step('Measuring thickness');
            }

            // Curvature: how fast the normal turns towards (bright) or away from (dark) neighbouring texels of the same surface.
            if (want.has('curvature')) {
                const curvature = gpu.image(size, size, 'gray', 16);
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
                const smooth = gpu.image(size, size, 'gray', 16);
                gpu.passNow(smooth, {
                    fragment: `void main() { ivec2 p = ivec2(gl_FragCoord.xy); float c = texelFetch(source, p, 0).r; if (texelFetch(cover, p, 0).r < 0.5) { outColor = vec4(c); return; }
    float sum = c * 2.0; float w = 2.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { if (x == 0 && y == 0) continue; ivec2 q = p + ivec2(x, y); if (texelFetch(cover, q, 0).r < 0.5) continue; sum += texelFetch(source, q, 0).r; w += 1.0; }
    outColor = vec4(sum / w); }`,
                    inputs: { source: curvature, cover: coverage },
                });
                gpu.release(curvature);
                maps.curvature = smooth;
                step('Reading curvature');
            }

            if (want.has('position')) {
                const positionMap = gpu.image(size, size, 'color', 16);
                gpu.passNow(positionMap, {
                    fragment: 'uniform vec3 uMin;\nuniform vec3 uSize3;\nvoid main() { vec4 p = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4((p.xyz - uMin) / max(uSize3, vec3(1e-9)), 1.0); }',
                    inputs: { source: position },
                    uniforms: { uMin: box.min.clone(), uSize3: box.getSize(new THREE.Vector3()) },
                });
                maps.position = positionMap;
            }
            if (want.has('id')) {
                const id = gpu.image(size, size, 'color', 8);
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
                const encoded = gpu.image(size, size, 'color', 8);
                gpu.passNow(encoded, { fragment: 'void main() { vec4 n = texelFetch(source, ivec2(gl_FragCoord.xy), 0); outColor = vec4(n.a > 0.5 ? normalize(n.xyz) * 0.5 + 0.5 : vec3(0.5, 0.5, 1.0), 1.0); }', inputs: { source: worldNormal } });
                maps.worldNormal = encoded;
            }
            if (want.has('normal')) maps.normal = gpu.retain(tangentNormal);
            if (want.has('height')) maps.height = gpu.retain(height);
            step('Finishing maps');

            // Pad every map past its islands.
            for (const key of Object.keys(maps) as MeshMapName[]) {
                const padded = padImage(gpu, maps[key]!, coverage, nearest);
                gpu.release(maps[key]);
                padded.target.texture.wrapS = padded.target.texture.wrapT = THREE.ClampToEdgeWrapping;
                maps[key] = padded;
            }
            gpu.release(position);
            gpu.release(lowNormal);
            gpu.release(worldNormal);
            gpu.release(tangentNormal);
            gpu.release(height);
            results.set(tile, { maps, coverage, nearest });
            step('Done');
        }
        return results;
    } catch (error) {
        for (const result of results.values()) releaseTileBake(gpu, result);
        throw error;
    } finally {
        raster.dispose();
        occluder.dispose();
        high?.dispose();
    }
};

export const releaseTileBake = (gpu: TextureGpu, bake: TileBake): void => {
    for (const image of Object.values(bake.maps)) gpu.release(image);
    gpu.release(bake.coverage);
    gpu.release(bake.nearest);
};
