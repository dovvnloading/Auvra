/**
 * TERRAIN CHUNKS
 *
 * Level-of-detail rendering for a terrain built as THREE.PlaneGeometry(width, depth, segments,
 * segments): vertex (ix, iy) sits at index iy * (segments + 1) + ix. The grid is split into square
 * chunks; each chunk draws the full-resolution vertices it needs through its own index buffer, every
 * 2^level-th vertex at level `level`, so all chunks share one position/normal buffer. Neighbouring
 * chunks at different levels meet with T-junctions; a skirt (a strip hanging down from the chunk's
 * edge) hides the gaps they would show.
 */

export interface TerrainChunk {
    /** Chunk column and row. */
    cx: number;
    cy: number;
    /** First and last vertex column/row it covers (inclusive). */
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Cells along one side of a chunk at full resolution. */
export const CHUNK_CELLS = 32;
/** Levels 0..MAX_LOD_LEVEL: full, 1/2, 1/4, 1/8 of the vertices per side. */
export const MAX_LOD_LEVEL = 3;

/** The chunks covering a grid of `segments` x `segments` cells, row by row. */
export const chunkLayout = (segments: number, chunkCells: number = CHUNK_CELLS): TerrainChunk[] => {
    const chunks: TerrainChunk[] = [];
    const count = Math.max(1, Math.ceil(segments / chunkCells));
    for (let cy = 0; cy < count; cy++) {
        for (let cx = 0; cx < count; cx++) {
            chunks.push({
                cx, cy,
                x0: cx * chunkCells, y0: cy * chunkCells,
                x1: Math.min(segments, (cx + 1) * chunkCells), y1: Math.min(segments, (cy + 1) * chunkCells),
            });
        }
    }
    return chunks;
};

/**
 * Vertex columns (or rows) from `start` to `end` every `step`, always ending exactly at `end`, so a
 * chunk's edge vertices are drawn at every level.
 */
const stops = (start: number, end: number, step: number): number[] => {
    const values: number[] = [];
    for (let value = start; value < end; value += step) values.push(value);
    values.push(end);
    return values;
};

/** The vertex step of a level. */
export const lodStep = (level: number): number => 1 << Math.max(0, Math.min(MAX_LOD_LEVEL, Math.floor(level)));

/** Triangle indices for `chunk` at `level`, wound like PlaneGeometry's own faces. */
export const chunkIndices = (segments: number, chunk: TerrainChunk, level: number): Uint32Array => {
    const step = lodStep(level);
    const columns = stops(chunk.x0, chunk.x1, step);
    const rows = stops(chunk.y0, chunk.y1, step);
    const stride = segments + 1;
    const indices = new Uint32Array((columns.length - 1) * (rows.length - 1) * 6);
    let offset = 0;
    for (let r = 0; r < rows.length - 1; r++) {
        for (let c = 0; c < columns.length - 1; c++) {
            const a = columns[c] + stride * rows[r];
            const b = columns[c] + stride * rows[r + 1];
            const cc = columns[c + 1] + stride * rows[r + 1];
            const d = columns[c + 1] + stride * rows[r];
            indices[offset++] = a; indices[offset++] = b; indices[offset++] = d;
            indices[offset++] = b; indices[offset++] = cc; indices[offset++] = d;
        }
    }
    return indices;
};

/** The vertex indices around a chunk's edge at `level`, in order (closed loop, first vertex not repeated). */
export const chunkEdge = (segments: number, chunk: TerrainChunk, level: number): number[] => {
    const step = lodStep(level);
    const stride = segments + 1;
    const columns = stops(chunk.x0, chunk.x1, step);
    const rows = stops(chunk.y0, chunk.y1, step);
    const loop: number[] = [];
    for (const x of columns) loop.push(x + stride * chunk.y0);
    for (const y of rows.slice(1)) loop.push(chunk.x1 + stride * y);
    for (const x of columns.slice(0, -1).reverse()) loop.push(x + stride * chunk.y1);
    for (const y of rows.slice(1, -1).reverse()) loop.push(chunk.x0 + stride * y);
    return loop;
};

/**
 * Skirt geometry for a chunk: for each edge vertex (positions read from the shared buffer, in the
 * plane's local space where Z is the height), a copy lowered by `depth`, joined into a strip around
 * the chunk. Both faces are drawn by the terrain's double-sided material, so the winding is free.
 */
export const skirtGeometryData = (
    positions: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    segments: number,
    chunk: TerrainChunk,
    level: number,
    depth: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } => {
    const edge = chunkEdge(segments, chunk, level);
    const count = edge.length;
    const out = new Float32Array(count * 2 * 3);
    const outNormals = new Float32Array(count * 2 * 3);
    edge.forEach((vertex, i) => {
        for (let k = 0; k < 3; k++) {
            out[i * 3 + k] = positions[vertex * 3 + k];
            out[(count + i) * 3 + k] = positions[vertex * 3 + k];
            const normal = normals ? normals[vertex * 3 + k] : k === 2 ? 1 : 0;
            outNormals[i * 3 + k] = normal;
            outNormals[(count + i) * 3 + k] = normal;
        }
        out[(count + i) * 3 + 2] -= depth;
    });
    const indices = new Uint32Array(count * 6);
    for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        const top = i, topNext = next, bottom = count + i, bottomNext = count + next;
        indices.set([top, bottom, topNext, bottom, bottomNext, topNext], i * 6);
    }
    return { positions: out, normals: outNormals, indices };
};

/**
 * The level for a chunk `distance` world units from the camera: one level coarser for every doubling
 * of distance beyond `nearDistance`. Switching back to a finer level waits until the camera is
 * `hysteresis` (fraction) closer than the switch point, so a chunk on a boundary does not flicker.
 */
export const chooseChunkLevel = (distance: number, nearDistance: number, previous: number | null, hysteresis = 0.15): number => {
    if (!(distance > 0) || !(nearDistance > 0)) return 0;
    const raw = Math.max(0, Math.min(MAX_LOD_LEVEL, Math.floor(Math.log2(distance / nearDistance) + 1)));
    if (previous === null || raw >= previous) return raw;
    // Finer than before: only once clearly inside the finer level's range.
    const finerLimit = nearDistance * Math.pow(2, previous - 1);
    return distance < finerLimit * (1 - hysteresis) ? raw : previous;
};

/** Local-space bounds (x, y over the plane, z the height) of a chunk's full-resolution vertices. */
export const chunkBounds = (positions: ArrayLike<number>, segments: number, chunk: TerrainChunk): { min: [number, number, number]; max: [number, number, number] } => {
    const stride = segments + 1;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let y = chunk.y0; y <= chunk.y1; y++) {
        for (let x = chunk.x0; x <= chunk.x1; x++) {
            const index = (x + stride * y) * 3;
            for (let k = 0; k < 3; k++) {
                const value = positions[index + k];
                if (value < min[k]) min[k] = value;
                if (value > max[k]) max[k] = value;
            }
        }
    }
    return { min, max };
};
