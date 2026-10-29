import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

/**
 * FRACTURE
 *
 * Breaks a model into pieces the way a solid shatters: Voronoi cells round random seeds inside it,
 * each cell cut as a convex solid from the model's convex hull. A piece keeps the model's own
 * surface inside its cell (clipped triangles, with their normals, UVs and materials) and gains cut
 * faces where it parted from its neighbours, drawn with an interior material. Each piece comes with
 * its convex collider points, its volume (for its mass) and its centre, about which its geometry
 * is laid out. Pure geometry: nothing here touches the scene or physics.
 *
 * Cut faces follow the model's convex hull, so solid, roughly convex things (walls, crates,
 * pillars, rocks, barrels, panes) break cleanly; a deep hollow in a model is filled where it is cut.
 */

/** A model's triangles in its own space. */
export interface FractureSource {
    /** xyz per vertex. */
    positions: Float32Array;
    /** xyz per vertex, or null to use each triangle's face normal. */
    normals: Float32Array | null;
    /** uv per vertex, or null. */
    uvs: Float32Array | null;
    /** Three vertex indices per triangle. */
    indices: Uint32Array;
    /** Material slot of each triangle. */
    materials: Uint16Array;
}

export interface FractureOptions {
    /** How many pieces, 2 to MAX_FRACTURE_PIECES. */
    pieces: number;
    /** Seed of the pattern: the same seed breaks the same model the same way. */
    seed?: number;
    /** Texture repeats per unit on cut faces. */
    interiorScale?: number;
}

/** A draw range of a piece's vertices in one material slot. */
export interface FractureGroup {
    start: number;
    count: number;
    material: number;
}

export interface FracturePiece {
    /** Where the piece's centre of mass sat in the model, model space. */
    centre: [number, number, number];
    /** Non-indexed triangles about the centre: xyz, xyz and uv per vertex. */
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** The model's slots first, in order; the cut faces use slot `interiorSlot`. */
    groups: FractureGroup[];
    /** The corners of its convex solid about the centre: its collider. */
    hull: Float32Array;
    volume: number;
}

export interface FractureResult {
    pieces: FracturePiece[];
    /** The material slot cut faces use: one past the model's highest. */
    interiorSlot: number;
}

export const MAX_FRACTURE_PIECES = 64;
export const MIN_FRACTURE_PIECES = 2;

type Vec = [number, number, number];

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const lerpVec = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A seeded random source (Park-Miller). */
export const fractureRandom = (seed: number): (() => number) => {
    let state = Math.floor(Math.abs(seed) * 2147483) % 2147483646 + 1;
    return () => {
        state = (state * 48271) % 2147483647;
        return (state - 1) / 2147483646;
    };
};

// ---------------------------------------------------------------------------
// Convex solids

/** A face of a convex solid: a planar polygon (in order round it) on plane normal·x = constant, normal outwards. */
interface Face {
    points: Vec[];
    normal: Vec;
    constant: number;
    /** A cut between two cells (drawn), rather than part of the model's outside. */
    cut: boolean;
    /** For a cut, the cell on its other side. */
    neighbour?: number;
}

/** Keeps the part of a polygon where normal·x <= constant; crossing points go to `crossings`. */
const clipPoints = (points: Vec[], normal: Vec, constant: number, crossings: Vec[] | null, epsilon: number): Vec[] => {
    const out: Vec[] = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const da = dot(normal, a) - constant;
        const db = dot(normal, b) - constant;
        const aIn = da <= epsilon;
        const bIn = db <= epsilon;
        if (aIn) out.push(a);
        if (aIn !== bIn) {
            const point = lerpVec(a, b, da / (da - db));
            out.push(point);
            crossings?.push(point);
        }
    }
    return out;
};

/** Points on a plane put in order round their middle, counter-clockwise seen from the side `normal` points to. */
const orderOnPlane = (points: Vec[], normal: Vec, epsilon: number): Vec[] => {
    const unique: Vec[] = [];
    for (const point of points) {
        if (!unique.some(other => Math.abs(other[0] - point[0]) < epsilon && Math.abs(other[1] - point[1]) < epsilon && Math.abs(other[2] - point[2]) < epsilon)) unique.push(point);
    }
    if (unique.length < 3) return unique;
    const middle: Vec = [0, 0, 0];
    for (const point of unique) { middle[0] += point[0]; middle[1] += point[1]; middle[2] += point[2]; }
    middle[0] /= unique.length; middle[1] /= unique.length; middle[2] /= unique.length;
    const helper: Vec = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = cross(helper, normal);
    const ul = length(u);
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    const v = cross(normal, u);
    return unique
        .map(point => ({ point, angle: Math.atan2(dot(sub(point, middle), v), dot(sub(point, middle), u)) }))
        .sort((a, b) => a.angle - b.angle)
        .map(entry => entry.point);
};

/** Cuts a convex solid by a plane, keeping normal·x <= constant and closing the cut with a new face. */
const clipSolid = (faces: Face[], normal: Vec, constant: number, cut: boolean, epsilon: number, neighbour?: number): Face[] => {
    let outside = false;
    let inside = false;
    for (const face of faces) {
        for (const point of face.points) {
            if (dot(normal, point) - constant > epsilon) outside = true;
            else inside = true;
        }
    }
    if (!outside) return faces;
    if (!inside) return [];
    const crossings: Vec[] = [];
    const out: Face[] = [];
    for (const face of faces) {
        const points = clipPoints(face.points, normal, constant, crossings, epsilon);
        if (points.length >= 3) out.push({ ...face, points });
    }
    const cap = orderOnPlane(crossings, normal, epsilon * 4);
    if (cap.length >= 3) out.push({ points: cap, normal, constant, cut, neighbour });
    return out;
};

const boxSolid = (min: Vec, max: Vec): Face[] => {
    const corner = (x: number, y: number, z: number): Vec => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
    const face = (normal: Vec, constant: number, points: Vec[]): Face => ({ points, normal, constant, cut: false });
    return [
        face([1, 0, 0], max[0], [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)]),
        face([-1, 0, 0], -min[0], [corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 1), corner(0, 1, 0)]),
        face([0, 1, 0], max[1], [corner(0, 1, 0), corner(0, 1, 1), corner(1, 1, 1), corner(1, 1, 0)]),
        face([0, -1, 0], -min[1], [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)]),
        face([0, 0, 1], max[2], [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)]),
        face([0, 0, -1], -min[2], [corner(0, 0, 0), corner(0, 1, 0), corner(1, 1, 0), corner(1, 0, 0)]),
    ];
};

/** Every corner of every face of a solid (shared corners repeat). */
const solidPoints = (faces: Face[]): Vec[] => faces.flatMap(face => face.points);

/** Points with those within `epsilon` of one already kept dropped. */
const distinctPoints = (points: Vec[], epsilon: number): Vec[] => {
    const kept: Vec[] = [];
    const buckets = new Map<number, Vec[]>();
    const step = Math.max(epsilon, 1e-12) * 2;
    const key = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
    for (const point of points) {
        const ix = Math.floor(point[0] / step), iy = Math.floor(point[1] / step), iz = Math.floor(point[2] / step);
        let found = false;
        for (let dx = -1; dx <= 1 && !found; dx++) {
            for (let dy = -1; dy <= 1 && !found; dy++) {
                for (let dz = -1; dz <= 1 && !found; dz++) {
                    const near = buckets.get(key(ix + dx, iy + dy, iz + dz));
                    if (near?.some(other => Math.abs(other[0] - point[0]) < epsilon && Math.abs(other[1] - point[1]) < epsilon && Math.abs(other[2] - point[2]) < epsilon)) found = true;
                }
            }
        }
        if (found) continue;
        kept.push(point);
        const k = key(ix, iy, iz);
        const bucket = buckets.get(k);
        if (bucket) bucket.push(point);
        else buckets.set(k, [point]);
    }
    return kept;
};

/** A convex solid's volume and centre of mass. */
const solidMass = (faces: Face[], corners: Vec[]): { volume: number; centre: Vec } => {
    const reference: Vec = [0, 0, 0];
    for (const corner of corners) { reference[0] += corner[0]; reference[1] += corner[1]; reference[2] += corner[2]; }
    const n = Math.max(1, corners.length);
    reference[0] /= n; reference[1] /= n; reference[2] /= n;
    let volume = 0;
    const centre: Vec = [0, 0, 0];
    for (const face of faces) {
        const a = face.points[0];
        for (let i = 1; i < face.points.length - 1; i++) {
            const b = face.points[i];
            const c = face.points[i + 1];
            const tetra = Math.abs(dot(sub(a, reference), cross(sub(b, reference), sub(c, reference)))) / 6;
            volume += tetra;
            for (let k = 0; k < 3; k++) centre[k] += tetra * (reference[k] + a[k] + b[k] + c[k]) / 4;
        }
    }
    if (volume > 0) for (let k = 0; k < 3; k++) centre[k] /= volume;
    else for (let k = 0; k < 3; k++) centre[k] = reference[k];
    return { volume, centre };
};

// ---------------------------------------------------------------------------
// The model's solid

/** The model's bounds, made at least a little thick on every axis (a flat pane still has a solid to cut). */
const solidBounds = (positions: Float32Array): { min: Vec; max: Vec; size: number } => {
    const min: Vec = [Infinity, Infinity, Infinity];
    const max: Vec = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], positions[i + k]);
            max[k] = Math.max(max[k], positions[i + k]);
        }
    }
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
    for (let k = 0; k < 3; k++) {
        const thin = Math.max(size * 0.01, 1e-3) - (max[k] - min[k]);
        if (thin > 0) { min[k] -= thin / 2; max[k] += thin / 2; }
    }
    return { min, max, size };
};

/** The model's convex hull as a solid: its triangles, outward; empty when it has none (a flat model). */
const hullSolid = (positions: Float32Array): Face[] => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < positions.length; i += 3) points.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
    let hull: ConvexHull;
    try {
        hull = new ConvexHull().setFromPoints(points);
    } catch {
        return [];
    }
    const faces: Face[] = [];
    for (const face of hull.faces) {
        const normal: Vec = [face.normal.x, face.normal.y, face.normal.z];
        if (!Number.isFinite(normal[0]) || length(normal) < 0.5) continue;
        const corners: Vec[] = [];
        let edge = face.edge;
        do {
            const point = edge.head().point;
            corners.push([point.x, point.y, point.z]);
            edge = edge.next;
        } while (edge !== face.edge && corners.length < 64);
        if (corners.length >= 3) faces.push({ points: corners, normal, constant: face.constant, cut: false });
    }
    return faces.length >= 4 ? faces : [];
};

/** The model as a convex solid: its hull, or its bounds when it is flat. */
const modelSolid = (positions: Float32Array): { faces: Face[]; min: Vec; max: Vec; size: number } => {
    const { min, max, size } = solidBounds(positions);
    const hull = hullSolid(positions);
    const faces = hull.length > 0 && solidMass(hull, solidPoints(hull)).volume > size ** 3 * 1e-9 ? hull : boxSolid(min, max);
    return { faces, min, max, size };
};

const insideSolid = (faces: Face[], point: Vec, margin: number) => faces.every(face => dot(face.normal, point) - face.constant <= -margin);

/** Seeds spread through the solid, at least a little in from its faces. */
const seedPoints = (faces: Face[], min: Vec, max: Vec, size: number, count: number, random: () => number): Vec[] => {
    const seeds: Vec[] = [];
    let margin = size * 0.04;
    for (let attempt = 0; seeds.length < count && attempt < count * 400; attempt++) {
        if (attempt === count * 200) margin = 0;
        const point: Vec = [min[0] + (max[0] - min[0]) * random(), min[1] + (max[1] - min[1]) * random(), min[2] + (max[2] - min[2]) * random()];
        if (insideSolid(faces, point, margin)) seeds.push(point);
    }
    return seeds;
};

// ---------------------------------------------------------------------------
// Surface

interface Vertex {
    p: Vec;
    n: Vec;
    uv: [number, number];
}

const lerpVertex = (a: Vertex, b: Vertex, t: number): Vertex => ({
    p: lerpVec(a.p, b.p, t),
    n: lerpVec(a.n, b.n, t),
    uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t],
});

const clipVertices = (vertices: Vertex[], normal: Vec, constant: number): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        const da = dot(normal, a.p) - constant;
        const db = dot(normal, b.p) - constant;
        if (da <= 0) out.push(a);
        if ((da <= 0) !== (db <= 0)) out.push(lerpVertex(a, b, da / (da - db)));
    }
    return out;
};

interface CellPlane {
    normal: Vec;
    constant: number;
    /** The seed on its other side. */
    other: number;
}

/** The half-spaces of seed `index`'s cell: nearer it than any other seed. */
const cellPlanes = (seeds: Vec[], index: number): CellPlane[] => {
    const seed = seeds[index];
    const planes: CellPlane[] = [];
    for (let j = 0; j < seeds.length; j++) {
        if (j === index) continue;
        const towards = sub(seeds[j], seed);
        const distance = length(towards);
        if (distance < 1e-9) continue;
        const normal: Vec = [towards[0] / distance, towards[1] / distance, towards[2] / distance];
        planes.push({ normal, constant: dot(normal, lerpVec(seed, seeds[j], 0.5)), other: j });
    }
    return planes;
};

class PieceBuilder {
    /** Polygons per material slot. */
    readonly slots = new Map<number, Vertex[][]>();

    add(slot: number, polygon: Vertex[]): void {
        if (polygon.length < 3) return;
        let list = this.slots.get(slot);
        if (!list) this.slots.set(slot, (list = []));
        list.push(polygon);
    }

    get empty(): boolean {
        return this.slots.size === 0;
    }

    build(centre: Vec, hull: Vec[], volume: number): FracturePiece {
        let vertexCount = 0;
        for (const polygons of this.slots.values()) for (const polygon of polygons) vertexCount += (polygon.length - 2) * 3;
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const groups: FractureGroup[] = [];
        let at = 0;
        for (const slot of [...this.slots.keys()].sort((a, b) => a - b)) {
            const start = at;
            for (const polygon of this.slots.get(slot)!) {
                for (let i = 1; i < polygon.length - 1; i++) {
                    for (const vertex of [polygon[0], polygon[i], polygon[i + 1]]) {
                        positions[at * 3] = vertex.p[0] - centre[0];
                        positions[at * 3 + 1] = vertex.p[1] - centre[1];
                        positions[at * 3 + 2] = vertex.p[2] - centre[2];
                        const nl = length(vertex.n) || 1;
                        normals[at * 3] = vertex.n[0] / nl;
                        normals[at * 3 + 1] = vertex.n[1] / nl;
                        normals[at * 3 + 2] = vertex.n[2] / nl;
                        uvs[at * 2] = vertex.uv[0];
                        uvs[at * 2 + 1] = vertex.uv[1];
                        at++;
                    }
                }
            }
            groups.push({ start, count: at - start, material: slot });
        }
        const hullPoints = new Float32Array(hull.length * 3);
        hull.forEach((point, i) => {
            hullPoints[i * 3] = point[0] - centre[0];
            hullPoints[i * 3 + 1] = point[1] - centre[1];
            hullPoints[i * 3 + 2] = point[2] - centre[2];
        });
        return { centre: [centre[0], centre[1], centre[2]], positions, normals, uvs, groups, hull: hullPoints, volume };
    }
}

/** A cut face as a polygon with its own flat normal and UVs laid out on its plane. */
const cutPolygon = (face: Face, scale: number): Vertex[] => {
    const helper: Vec = Math.abs(face.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = cross(helper, face.normal);
    const ul = length(u) || 1;
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    const v = cross(face.normal, u);
    return face.points.map(point => ({ p: point, n: face.normal, uv: [dot(point, u) * scale, dot(point, v) * scale] }));
};

// ---------------------------------------------------------------------------

/** Breaks a model into pieces (see the top of this file). */
export const fractureMesh = (source: FractureSource, options: FractureOptions): FractureResult => {
    const triangleCount = Math.floor(source.indices.length / 3);
    let highestSlot = 0;
    for (let t = 0; t < triangleCount; t++) highestSlot = Math.max(highestSlot, source.materials[t] ?? 0);
    const interiorSlot = highestSlot + 1;
    if (source.positions.length < 9 || triangleCount === 0) return { pieces: [], interiorSlot };

    const count = Math.max(MIN_FRACTURE_PIECES, Math.min(MAX_FRACTURE_PIECES, Math.round(options.pieces)));
    const random = fractureRandom(options.seed ?? 1);
    const interiorScale = options.interiorScale ?? 1;
    const { faces: solid, min, max, size } = modelSolid(source.positions);
    const epsilon = size * 1e-6;
    const seeds = seedPoints(solid, min, max, size, count, random);
    if (seeds.length < MIN_FRACTURE_PIECES) return { pieces: [], interiorSlot };

    // Each vertex's nearest seed: a triangle whose corners share one lies wholly in that cell.
    const vertexCount = source.positions.length / 3;
    const owner = new Int32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
        const p: Vec = [source.positions[v * 3], source.positions[v * 3 + 1], source.positions[v * 3 + 2]];
        let best = 0;
        let bestDistance = Infinity;
        for (let s = 0; s < seeds.length; s++) {
            const d = (p[0] - seeds[s][0]) ** 2 + (p[1] - seeds[s][1]) ** 2 + (p[2] - seeds[s][2]) ** 2;
            if (d < bestDistance) { bestDistance = d; best = s; }
        }
        owner[v] = best;
    }

    const vertexAt = (index: number, faceNormal: Vec): Vertex => ({
        p: [source.positions[index * 3], source.positions[index * 3 + 1], source.positions[index * 3 + 2]],
        n: source.normals ? [source.normals[index * 3], source.normals[index * 3 + 1], source.normals[index * 3 + 2]] : faceNormal,
        uv: source.uvs ? [source.uvs[index * 2], source.uvs[index * 2 + 1]] : [0, 0],
    });

    // Each cell as a solid, and which cells it touches.
    const planes = seeds.map((_, index) => cellPlanes(seeds, index));
    const solids = planes.map(cell => {
        let faces = solid;
        for (const plane of cell) {
            faces = clipSolid(faces, plane.normal, plane.constant, true, epsilon, plane.other);
            if (faces.length === 0) break;
        }
        return faces;
    });
    const neighbours = solids.map(faces => {
        const set = new Set<number>();
        for (const face of faces) if (face.neighbour !== undefined) set.add(face.neighbour);
        return set;
    });
    // A triangle much smaller than a cell can only reach the cells of its corners and their neighbours.
    const cellSize = Math.cbrt(Math.max(1e-12, solidMass(solid, solidPoints(solid)).volume) / seeds.length);
    const candidates = new Set<number>();

    const builders = seeds.map(() => new PieceBuilder());
    for (let t = 0; t < triangleCount; t++) {
        const ia = source.indices[t * 3], ib = source.indices[t * 3 + 1], ic = source.indices[t * 3 + 2];
        const pa: Vec = [source.positions[ia * 3], source.positions[ia * 3 + 1], source.positions[ia * 3 + 2]];
        const pb: Vec = [source.positions[ib * 3], source.positions[ib * 3 + 1], source.positions[ib * 3 + 2]];
        const pc: Vec = [source.positions[ic * 3], source.positions[ic * 3 + 1], source.positions[ic * 3 + 2]];
        const faceNormal = cross(sub(pb, pa), sub(pc, pa));
        if (length(faceNormal) < 1e-12) continue;
        const triangle = [vertexAt(ia, faceNormal), vertexAt(ib, faceNormal), vertexAt(ic, faceNormal)];
        const slot = source.materials[t] ?? 0;
        if (owner[ia] === owner[ib] && owner[ib] === owner[ic]) {
            builders[owner[ia]].add(slot, triangle);
            continue;
        }
        // Across cells: the part of it in each it can reach.
        candidates.clear();
        const reach = Math.max(length(sub(pb, pa)), length(sub(pc, pb)), length(sub(pa, pc)));
        if (reach > cellSize * 0.5) for (let cell = 0; cell < seeds.length; cell++) candidates.add(cell);
        else {
            for (const corner of [owner[ia], owner[ib], owner[ic]]) {
                candidates.add(corner);
                for (const next of neighbours[corner]) candidates.add(next);
            }
        }
        for (const cell of candidates) {
            let polygon = triangle;
            for (const plane of planes[cell]) {
                polygon = clipVertices(polygon, plane.normal, plane.constant);
                if (polygon.length < 3) break;
            }
            builders[cell].add(slot, polygon);
        }
    }

    const pieces: FracturePiece[] = [];
    const tiny = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) * 1e-6;
    for (let cell = 0; cell < seeds.length; cell++) {
        const faces = solids[cell];
        if (faces.length < 4) continue;
        const { volume, centre } = solidMass(faces, solidPoints(faces));
        if (volume <= tiny) continue;
        const builder = builders[cell];
        for (const face of faces) if (face.cut) builder.add(interiorSlot, cutPolygon(face, interiorScale));
        if (builder.empty) continue;
        pieces.push(builder.build(centre, distinctPoints(solidPoints(faces), epsilon * 10), volume));
    }
    return { pieces, interiorSlot };
};

/** The pieces' total volume (tests and mass). */
export const fractureVolume = (result: FractureResult): number => result.pieces.reduce((sum, piece) => sum + piece.volume, 0);
