import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * MESH LEVEL OF DETAIL
 *
 * Every mesh with enough triangles gets a chain of simpler versions of itself, made by
 * meshoptimizer's simplifier. Each level is an index buffer over the full mesh's own vertices, so a
 * level costs only its indices, keeps the mesh's skinning and morph attributes (a skinned character
 * swaps levels like a prop), and keeps its material groups. A mesh draws the coarsest level whose
 * simplification error, projected to the screen at its distance, stays under a pixel.
 */

export interface MeshLodLevel {
    geometry: THREE.BufferGeometry;
    /** The farthest the level's surface strays from the full mesh, in the geometry's own units. */
    error: number;
    triangles: number;
}

/** Share of the full mesh's triangles each level aims for. */
const LOD_RATIOS = [0.5, 0.25, 0.12, 0.05];
/** Meshes with fewer triangles keep just their full level. */
export const MIN_LOD_TRIANGLES = 300;
/** A level is dropped below this many triangles. */
const MIN_LEVEL_TRIANGLES = 32;
/** A level must cut the triangles of the one before to at most this share, else the chain ends. */
const MIN_REDUCTION = 0.85;
/** How far the simplifier may move the surface for the coarsest levels, as a share of the mesh's size. */
const MAX_SIMPLIFY_ERROR = 0.25;
/** A level is drawn while its error covers at most this many pixels on the screen. */
export const LOD_PIXEL_ERROR = 1;

let simplifierReady = false;
/** Resolves once the simplifier can run; until then every mesh has just its full level. */
export const meshLodReady: Promise<void> = MeshoptSimplifier.ready.then(() => { simplifierReady = true; });

const chains = new WeakMap<THREE.BufferGeometry, MeshLodLevel[]>();

const triangleCount = (geometry: THREE.BufferGeometry): number =>
    Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3);

/** A level geometry over `base`'s own attributes with its own indices and material groups. */
const levelGeometry = (base: THREE.BufferGeometry, indices: Uint32Array, groups: { start: number; count: number; materialIndex?: number }[]): THREE.BufferGeometry => {
    const level = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(base.attributes)) level.setAttribute(name, attribute);
    level.morphAttributes = base.morphAttributes;
    level.morphTargetsRelative = base.morphTargetsRelative;
    const vertexCount = base.attributes.position.count;
    level.setIndex(new THREE.BufferAttribute(vertexCount < 65536 ? new Uint16Array(indices) : indices, 1));
    groups.forEach(group => level.addGroup(group.start, group.count, group.materialIndex));
    if (!base.boundingSphere) base.computeBoundingSphere();
    if (!base.boundingBox) base.computeBoundingBox();
    level.boundingSphere = base.boundingSphere!.clone();
    level.boundingBox = base.boundingBox!.clone();
    level.name = `${base.name || 'mesh'} LOD`;
    return level;
};

/** How much a unit of texture-coordinate and of normal change weighs against the mesh's size. */
const UV_WEIGHT = 2;
const NORMAL_WEIGHT = 0.5;

/** The mesh's texture coordinates and normals, interleaved per vertex with their weights; null when it has neither. */
const surfaceAttributes = (geometry: THREE.BufferGeometry): { values: Float32Array; stride: number; weights: number[] } | null => {
    const uv = geometry.attributes.uv;
    const normal = geometry.attributes.normal;
    const stride = (uv ? 2 : 0) + (normal ? 3 : 0);
    if (!stride) return null;
    const count = geometry.attributes.position.count;
    const values = new Float32Array(count * stride);
    for (let vertex = 0; vertex < count; vertex++) {
        let offset = vertex * stride;
        if (uv) {
            values[offset++] = uv.getX(vertex);
            values[offset++] = uv.getY(vertex);
        }
        if (normal) {
            values[offset++] = normal.getX(vertex);
            values[offset++] = normal.getY(vertex);
            values[offset++] = normal.getZ(vertex);
        }
    }
    const weights = [...(uv ? [UV_WEIGHT, UV_WEIGHT] : []), ...(normal ? [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT] : [])];
    return { values, stride, weights };
};

/**
 * The detail levels of `geometry`, full first: each later one an index buffer over the same
 * vertices with fewer triangles, and the error it allows. A mesh under MIN_LOD_TRIANGLES, one the
 * simplifier cannot reduce, or any mesh before the simplifier is ready keeps one level. Built once
 * per geometry (once the simplifier is ready).
 */
export const meshLodChain = (geometry: THREE.BufferGeometry): MeshLodLevel[] => {
    const cached = chains.get(geometry);
    if (cached) return cached;
    const position = geometry.attributes.position;
    const full: MeshLodLevel = { geometry, error: 0, triangles: position ? triangleCount(geometry) : 0 };
    if (!position || !simplifierReady || !MeshoptSimplifier.supported) return [full];
    if (full.triangles < MIN_LOD_TRIANGLES) {
        chains.set(geometry, [full]);
        return [full];
    }

    // Shared corners are what the simplifier collapses, so a mesh of separate triangles is welded first.
    const base = geometry.index ? geometry : mergeVertices(geometry);
    const positions = new Float32Array(base.attributes.position.count * 3);
    for (let vertex = 0; vertex < base.attributes.position.count; vertex++) {
        positions[vertex * 3] = base.attributes.position.getX(vertex);
        positions[vertex * 3 + 1] = base.attributes.position.getY(vertex);
        positions[vertex * 3 + 2] = base.attributes.position.getZ(vertex);
    }
    const index = Uint32Array.from(base.index!.array as ArrayLike<number>);
    const scale = MeshoptSimplifier.getScale(positions, 3);
    // Texture coordinates and normals count as error too, so a collapse that would drag the texture
    // across a face or bend its shading is as costly as one that moves the surface.
    const surface = surfaceAttributes(base);
    const groups = base.groups.length ? base.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
    const levels: MeshLodLevel[] = [{ geometry: base, error: 0, triangles: Math.floor(index.length / 3) }];
    let previous = index.length;
    for (const ratio of LOD_RATIOS) {
        // Each material's triangles simplify apart, so the groups stay whole.
        let error = 0;
        const parts = groups.map((group) => {
            const span = index.subarray(group.start, group.start + group.count);
            const target = Math.max(3, Math.floor((span.length * ratio) / 3) * 3);
            const [simplified, partError] = surface
                ? MeshoptSimplifier.simplifyWithAttributes(span, positions, 3, surface.values, surface.stride, surface.weights, null, target, MAX_SIMPLIFY_ERROR)
                : MeshoptSimplifier.simplify(span, positions, 3, target, MAX_SIMPLIFY_ERROR);
            error = Math.max(error, partError);
            return { indices: simplified, materialIndex: group.materialIndex };
        });
        const total = parts.reduce((sum, part) => sum + part.indices.length, 0);
        if (total / 3 < MIN_LEVEL_TRIANGLES || total > previous * MIN_REDUCTION) break;
        const indices = new Uint32Array(total);
        const levelGroups: { start: number; count: number; materialIndex?: number }[] = [];
        let offset = 0;
        for (const part of parts) {
            indices.set(part.indices, offset);
            if (base.groups.length) levelGroups.push({ start: offset, count: part.indices.length, materialIndex: part.materialIndex });
            offset += part.indices.length;
        }
        levels.push({ geometry: levelGeometry(base, indices, levelGroups), error: error * scale, triangles: total / 3 });
        previous = total;
    }
    if (levels.length === 1) levels[0] = full;
    chains.set(geometry, levels);
    return levels;
};

/** Pixels one world unit covers at a distance of one unit for `camera` on a `viewportHeight`-pixel view; 0 for other cameras. */
export const lodPixelsPerUnit = (camera: THREE.Camera, viewportHeight: number): number => {
    const perspective = camera as THREE.PerspectiveCamera;
    if (!perspective.isPerspectiveCamera) return 0;
    return viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / perspective.zoom);
};

/**
 * The coarsest level of `levels` whose error, scaled into the world by `scale` and seen from
 * `distance` (pixelsPerUnit from lodPixelsPerUnit), covers at most LOD_PIXEL_ERROR pixels.
 */
export const chooseLodLevel = (levels: readonly MeshLodLevel[], scale: number, distance: number, pixelsPerUnit: number): number => {
    if (!(pixelsPerUnit > 0)) return 0;
    for (let level = levels.length - 1; level > 0; level--) {
        if ((levels[level].error * scale * pixelsPerUnit) / Math.max(distance, 1e-6) <= LOD_PIXEL_ERROR) return level;
    }
    return 0;
};
