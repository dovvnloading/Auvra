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

/** Reads the container back; null for anything else (or a damaged one). */
export const unpackCompressed = (bytes: Uint8Array): CompressedPicture | null => {
    if (bytes.length < 8 || !MAGIC.every((value, at) => bytes[at] === value)) return null;
    try {
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as {
            format: MaterialTextureFormat; width: number; height: number; levels: Array<{ width: number; height: number; offset: number; length: number }>;
        };
        const start = 8 + length;
        const levels = header.levels.map(level => ({ width: level.width, height: level.height, data: bytes.slice(start + level.offset, start + level.offset + level.length) }));
        if (levels.some(level => level.data.length === 0)) return null;
        return { format: header.format, width: header.width, height: header.height, levels };
    } catch {
        return null;
    }
};
