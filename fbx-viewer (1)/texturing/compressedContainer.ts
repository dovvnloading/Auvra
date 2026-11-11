import type { EncodedLevel, MaterialTextureFormat } from '../utils/textureCompression/materialTextureEncoder';
import type { CompressionSupport, TextureRole, TextureSettings } from './textureSettings';

/**
 * COMPRESSED TEXTURES KEPT IN THE PROJECT
 *
 * A texture compressed once is kept in the project (and so in built games), found again by its signature:
 * the file's hash and everything that decides what it was compressed into (its role, settings, which way
 * up, what the graphics card takes). Reopening the project, or playing a built game, then loads the blocks
 * as they are instead of compressing again.
 *
 * The container is the engine's own: "ATX1", a little-endian length, a JSON header (format, size, each
 * mip level's place), then the levels' blocks one after another.
 */

export interface CompressedPicture {
    format: MaterialTextureFormat;
    width: number;
    height: number;
    levels: EncodedLevel[];
}

const MAGIC = [0x41, 0x54, 0x58, 0x31];
/** Changes when what compression writes changes, so older blocks are made again. */
const CONTAINER_VERSION = 1;

/** The signature a texture's compressed blocks are kept under. */
export const compressionSignature = (
    sourceAssetId: string,
    role: TextureRole,
    settings: TextureSettings | undefined,
    flipY: boolean,
    support: CompressionSupport,
): string => [
    `v${CONTAINER_VERSION}`, sourceAssetId, role, flipY ? 'up' : 'down',
    settings?.compression ?? 'auto', settings?.maxSize ?? 0, settings?.mips === false ? 'nomips' : 'mips', settings?.flipGreen ? 'dx' : 'gl',
    deviceToken(support),
].join('|');

/**
 * What a graphics card takes, in a signature: "br" for one with BC (as before phones' formats came, so blocks
 * kept then are still found), else its BC, ASTC and ETC2 support, so a phone's blocks are kept apart.
 */
const deviceToken = (support: CompressionSupport): string => (support.bptc && support.rgtc
    ? 'br'
    : `${support.bptc ? 'b' : '-'}${support.rgtc ? 'r' : '-'}${support.astc ? 'a' : '-'}${support.etc2 ? 'e' : '-'}`);

/** Packs compressed levels into the container. */
export const packCompressed = (picture: CompressedPicture): Uint8Array => {
    let offset = 0;
    const header = JSON.stringify({
        format: picture.format, width: picture.width, height: picture.height,
        levels: picture.levels.map((level) => {
            const place = { width: level.width, height: level.height, offset, length: level.data.length };
            offset += level.data.length;
            return place;
        }),
    });
    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(8 + head.length + offset);
    out.set(MAGIC);
    new DataView(out.buffer).setUint32(4, head.length, true);
    out.set(head, 8);
    let at = 8 + head.length;
    for (const level of picture.levels) {
        out.set(level.data, at);
        at += level.data.length;
    }
    return out;
};

/** Each format uses 4×4 GPU blocks; a partial block still occupies a whole block. */
const BLOCK_BYTES: Record<MaterialTextureFormat, number> = {
    bc7: 16, bc5: 16, bc4: 8, astc: 16, etc2: 8, etc2a: 16,
};
const MAX_TEXTURE_DIMENSION = 16384;
const MAX_HEADER_BYTES = 64 * 1024;

const validDimension = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_TEXTURE_DIMENSION;

const validFormat = (value: unknown): value is MaterialTextureFormat =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(BLOCK_BYTES, value);

/** Reads the container back; never hand malformed cached blocks to the GPU. */
export const unpackCompressed = (bytes: Uint8Array): CompressedPicture | null => {
    if (bytes.length < 8 || !MAGIC.every((value, at) => bytes[at] === value)) return null;
    try {
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
        if (length === 0 || length > MAX_HEADER_BYTES || length > bytes.length - 8) return null;
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as {
            format?: unknown; width?: unknown; height?: unknown; levels?: unknown;
        };
        if (!header || !validFormat(header.format) || !validDimension(header.width) || !validDimension(header.height)
            || !Array.isArray(header.levels) || header.levels.length === 0
            || header.levels.length > Math.floor(Math.log2(Math.max(header.width, header.height))) + 1) return null;

        const start = 8 + length;
        const payloadLength = bytes.length - start;
        const spans: Array<{ width: number; height: number; offset: number; length: number }> = [];
        let width = header.width;
        let height = header.height;
        let offset = 0;
        for (const entry of header.levels) {
            if (!entry || typeof entry !== 'object') return null;
            const level = entry as Record<string, unknown>;
            const levelLength = Math.ceil(width / 4) * Math.ceil(height / 4) * BLOCK_BYTES[header.format];
            // packCompressed writes tightly packed, ordered mip levels. Check every span before slicing.
            if (level.width !== width || level.height !== height || level.offset !== offset
                || level.length !== levelLength || offset + levelLength > payloadLength) return null;
            spans.push({ width, height, offset, length: levelLength });
            offset += levelLength;
            width = Math.max(1, Math.floor(width / 2));
            height = Math.max(1, Math.floor(height / 2));
        }
        if (offset !== payloadLength) return null;
        const levels = spans.map(level => ({
            width: level.width, height: level.height,
            data: bytes.subarray(start + level.offset, start + level.offset + level.length),
        }));
        return { format: header.format, width: header.width, height: header.height, levels };
    } catch {
        return null;
    }
};
