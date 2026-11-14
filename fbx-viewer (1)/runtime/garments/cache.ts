/** Display-only, fixed-topology fit bake. Version 1 uses little-endian integers and IEEE floats. */
export interface GarmentCacheFrame { positions: Float32Array; torso: [number, number, number] }

export const GARMENT_CACHE_LIMITS = Object.freeze({ vertices: 8192, frames: 3600, fps: 240, bytes: 64 * 1024 * 1024 });
const MAGIC = 0x43565541; // ASCII "AUVC"
const HEADER = 48;
const LEVELS = 65535;

export interface GarmentCache {
    readonly vertexCount: number;
    readonly frameCount: number;
    readonly fps: number;
    /** Endpoint-inclusive. Frame zero is t=0. */
    readonly duration: number;
    readonly minimum: readonly [number, number, number];
    readonly quantum: readonly [number, number, number];
    readonly torsoCenters: Float32Array;
    readonly positionCodes: Uint16Array;
}

function requireCache(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error('Garment cache: ' + reason);
}

function layout(vertices: number, frames: number, fps: number): number {
    requireCache(Number.isSafeInteger(vertices) && vertices >= 1 && vertices <= GARMENT_CACHE_LIMITS.vertices, 'vertex count outside supported range.');
    requireCache(Number.isSafeInteger(frames) && frames >= 1 && frames <= GARMENT_CACHE_LIMITS.frames, 'frame count outside supported range.');
    requireCache(Number.isSafeInteger(fps) && fps >= 1 && fps <= GARMENT_CACHE_LIMITS.fps, 'frame rate must be a whole number from 1 to 240.');
    const bytes = HEADER + frames * 12 + vertices * frames * 6;
    requireCache(bytes <= GARMENT_CACHE_LIMITS.bytes, 'bake exceeds the 64 MiB data limit.');
    return bytes;
}

/**
 * Header: magic u32, version u16, header bytes u16, vertices u32, frames u32, fps u16,
 * flags u16, total bytes u32, local xyz min and max as 6 f32. Payload contains the
 * contiguous torso-center f32 triples followed by frame-major quantized vertex triples.
 */
export function encodeGarmentCache(frames: readonly GarmentCacheFrame[], fps: number): ArrayBuffer {
    requireCache(Array.isArray(frames) && frames.length >= 1 && frames.length <= GARMENT_CACHE_LIMITS.frames, 'frame count outside supported range.');
    requireCache(frames[0]?.positions instanceof Float32Array, 'each frame needs Float32 positions.');
    const vertices = frames[0].positions.length / 3, total = layout(vertices, frames.length, fps);
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (const frame of frames) {
        requireCache(frame?.positions instanceof Float32Array && frame.positions.length === vertices * 3, 'all frames must have the same vertex count.');
        requireCache(Array.isArray(frame.torso) && frame.torso.length === 3, 'torso center must contain three coordinates.');
        for (let axis = 0; axis < 3; axis++) {
            const value: unknown = frame.torso[axis];
            requireCache(typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)), 'torso center must contain three finite Float32 coordinates.');
        }
        for (let i = 0; i < frame.positions.length; i++) {
            const value = frame.positions[i], axis = i % 3;
            requireCache(Number.isFinite(value), 'positions must be finite.');
            minimum[axis] = Math.min(minimum[axis], value);
            maximum[axis] = Math.max(maximum[axis], value);
        }
    }
    const bytes = new ArrayBuffer(total), view = new DataView(bytes);
    view.setUint32(0, MAGIC, true);
    view.setUint16(4, 1, true);
    view.setUint16(6, HEADER, true);
    view.setUint32(8, vertices, true);
    view.setUint32(12, frames.length, true);
    view.setUint16(16, fps, true);
    view.setUint32(20, total, true);
    const scale = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        view.setFloat32(24 + k * 4, minimum[k], true);
        view.setFloat32(36 + k * 4, maximum[k], true);
        if (maximum[k] > minimum[k]) scale[k] = LEVELS / (maximum[k] - minimum[k]);
    }
    let torsoOffset = HEADER, xyzOffset = HEADER + frames.length * 12;
    for (const frame of frames) {
        for (const center of frame.torso) {
            view.setFloat32(torsoOffset, center, true);
            torsoOffset += 4;
        }
        for (let i = 0; i < frame.positions.length; i++) {
            const k = i % 3;
            const q = Math.round((frame.positions[i] - minimum[k]) * scale[k]);
            view.setUint16(xyzOffset, q, true);
            xyzOffset += 2;
        }
    }
    return bytes;
}

/** Validate all sizes and metadata before allocating. The code arrays own their bytes. */
export function decodeGarmentCache(bytes: ArrayBuffer | Uint8Array, expectedVertexCount: number): GarmentCache {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    requireCache(input.byteLength >= HEADER && input.byteLength <= GARMENT_CACHE_LIMITS.bytes, 'invalid payload size.');
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    requireCache(view.getUint32(0, true) === MAGIC, 'unrecognized signature.');
    requireCache(view.getUint16(4, true) === 1 && view.getUint16(6, true) === HEADER && view.getUint16(18, true) === 0, 'unsupported version, header or flags.');
    const vertexCount = view.getUint32(8, true), frameCount = view.getUint32(12, true), fps = view.getUint16(16, true);
    const size = layout(vertexCount, frameCount, fps);
    requireCache(vertexCount === expectedVertexCount, 'vertex count differs from the current cook.');
    requireCache(view.getUint32(20, true) === size && input.byteLength === size, 'payload length differs from its dimensions.');
    const minimum: [number, number, number] = [0, 0, 0], quantum: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const lo = view.getFloat32(24 + i * 4, true), hi = view.getFloat32(36 + i * 4, true);
        requireCache(Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi, 'invalid axis bounds.');
        minimum[i] = lo;
        quantum[i] = (hi - lo) / LEVELS;
    }
    const torsoCenters = new Float32Array(frameCount * 3);
    let offset = HEADER;
    for (let i = 0; i < torsoCenters.length; i++) {
        const v = view.getFloat32(offset, true);
        requireCache(Number.isFinite(v), 'non-finite torso center.');
        torsoCenters[i] = v;
        offset += 4;
    }
    const positionCodes = new Uint16Array(frameCount * vertexCount * 3);
    for (let i = 0; i < positionCodes.length; i++, offset += 2) positionCodes[i] = view.getUint16(offset, true);
    return { vertexCount, frameCount, fps, duration: (frameCount - 1) / fps, minimum, quantum, torsoCenters, positionCodes };
}

/** Decode and interpolate only the two surrounding frames into caller-owned buffers. */
export function sampleGarmentCache(cache: GarmentCache, time: number, out: Float32Array, torsoOut: [number, number, number]): void {
    requireCache(Number.isFinite(time), 'sample time must be finite.');
    const stride = cache.vertexCount * 3;
    requireCache(out.length === stride && torsoOut.length === 3, 'output dimensions differ from the bake.');
    const t = Math.min(cache.frameCount - 1, Math.max(0, time * cache.fps));
    const before = Math.floor(t), after = Math.min(before + 1, cache.frameCount - 1), blend = t - before;
    const first = before * stride, second = after * stride;
    for (let i = 0; i < stride; i++) {
        const axis = i % 3, a = cache.positionCodes[first + i], b = cache.positionCodes[second + i];
        out[i] = cache.minimum[axis] + (a + (b - a) * blend) * cache.quantum[axis];
    }
    for (let axis = 0; axis < 3; axis++) {
        const a = cache.torsoCenters[before * 3 + axis], b = cache.torsoCenters[after * 3 + axis];
        torsoOut[axis] = a + (b - a) * blend;
    }
}
