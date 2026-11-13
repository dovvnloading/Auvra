/**
 * A ZIP archive of files stored as they are (no compression: they are PNGs already), for handing a
 * set of pictures over as one download, and such an archive read back (a material package is one).
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

export const makeZip = async (files: ReadonlyArray<{ name: string; data: Blob | Uint8Array }>): Promise<Blob> => {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
        const data = ArrayBuffer.isView(file.data) ? file.data as Uint8Array : new Uint8Array(await (file.data as Blob).arrayBuffer());
        const name = encoder.encode(file.name);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint16(8, 0, true);
        local.setUint16(10, dosTime, true);
        local.setUint16(12, dosDate, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(new Uint8Array(local.buffer), name, data);
        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, 0x0800, true);
        entry.setUint16(10, 0, true);
        entry.setUint16(12, dosTime, true);
        entry.setUint16(14, dosDate, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, data.length, true);
        entry.setUint16(28, name.length, true);
        entry.setUint32(42, offset, true);
        central.push(new Uint8Array(entry.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
};

/** Conservative limits for an imported, untrusted material package. */
const MAX_ZIP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_MEMBERS = 256;
const MAX_ZIP_MEMBER_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_EXPANSION_RATIO = 256;

interface ZipEntry {
    name: string;
    method: number;
    crc: number;
    start: number;
    packedSize: number;
    size: number;
}

/**
 * Validate the entire central directory before inflating a single member.
 * Call read(name) only for files the consuming format actually references.
 */
export const openZip = async (archive: Blob | Uint8Array) => {
    const archiveSize = ArrayBuffer.isView(archive) ? archive.byteLength : archive.size;
    if (archiveSize > MAX_ZIP_ARCHIVE_BYTES) throw new Error('the ZIP archive exceeds the size limit');
    const bytes = ArrayBuffer.isView(archive) ? archive as Uint8Array : new Uint8Array(await archive.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: true });

    // Require the end record to end at the archive boundary (including any comment).
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) {
            end = at;
            break;
        }
    }
    if (end < 0) throw new Error('not a ZIP archive');

    const count = view.getUint16(end + 10, true);
    const centralSize = view.getUint32(end + 12, true);
    const centralStart = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
        || view.getUint16(end + 8, true) !== count || count === 0xffff
        || centralSize === 0xffffffff || centralStart === 0xffffffff) {
        throw new Error('the ZIP archive has an unsupported multipart or ZIP64 layout');
    }
    if (count > MAX_ZIP_MEMBERS) throw new Error('the ZIP archive contains too many files');
    if (centralStart + centralSize !== end) throw new Error('the ZIP archive has a damaged directory');

    const entries = new Map<string, ZipEntry>();
    const intervals: Array<{ start: number; end: number }> = [];
    let at = centralStart;
    let totalBytes = 0;
    for (let index = 0; index < count; index++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) {
            throw new Error('the ZIP archive has a damaged directory');
        }
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const packedSize = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const disk = view.getUint16(at + 34, true);
        const local = view.getUint32(at + 42, true);
        const next = at + 46 + nameLength + extraLength + commentLength;
        if (next > end || nameLength === 0 || disk !== 0 || (flags & 1)
            || packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
            throw new Error('the ZIP archive has unsafe or unsupported entries');
        }
        if (method !== 0 && method !== 8) throw new Error('the ZIP archive uses an unsupported compression method');
        const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        const parts = name.split('/');
        if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
            || /[\u0000-\u001f\u007f]/.test(name)
            || parts.some((part, i) => part === '.' || part === '..' || (!part && i !== parts.length - 1))) {
            throw new Error('the ZIP archive contains an unsafe filename');
        }
        if (entries.has(name)) throw new Error('the ZIP archive contains duplicate filenames');
        for (let offset = at + 46 + nameLength; offset < at + 46 + nameLength + extraLength;) {
            if (offset + 4 > at + 46 + nameLength + extraLength) throw new Error('the ZIP archive has damaged extra metadata');
            const tag = view.getUint16(offset, true);
            const length = view.getUint16(offset + 2, true);
            offset += 4 + length;
            if (tag === 0x0001) throw new Error('ZIP64 material packages are not supported');
            if (offset > at + 46 + nameLength + extraLength) throw new Error('the ZIP archive has damaged extra metadata');
        }
        at = next;
        if (name.endsWith('/')) continue;
        if (size > MAX_ZIP_MEMBER_BYTES || (size > 0 && (packedSize === 0 || size > packedSize * MAX_ZIP_EXPANSION_RATIO))) {
            throw new Error('a ZIP member exceeds the decompression budget');
        }
        totalBytes += size;
        if (totalBytes > MAX_ZIP_TOTAL_BYTES) throw new Error('the ZIP archive exceeds the total decompression budget');
        if (method === 0 && packedSize !== size) throw new Error('the ZIP archive has a damaged stored member');

        if (local + 30 > centralStart || view.getUint32(local, true) !== 0x04034b50
            || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) {
            throw new Error('the ZIP archive has a damaged local header');
        }
        const localNameLength = view.getUint16(local + 26, true);
        const localExtraLength = view.getUint16(local + 28, true);
        const start = local + 30 + localNameLength + localExtraLength;
        if (start + packedSize > centralStart || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) {
            throw new Error('the ZIP archive has a damaged member offset');
        }
        if (!(flags & 0x0008) && (view.getUint32(local + 14, true) !== crc
            || view.getUint32(local + 18, true) !== packedSize
            || view.getUint32(local + 22, true) !== size)) {
            throw new Error('the ZIP archive has mismatched member metadata');
        }
        intervals.push({ start: local, end: start + packedSize });
        entries.set(name, { name, method, crc, start, packedSize, size });
    }
    if (at !== end) throw new Error('the ZIP archive has a damaged directory');
    intervals.sort((a, b) => a.start - b.start);
    for (let i = 1; i < intervals.length; i++) {
        if (intervals[i].start < intervals[i - 1].end) throw new Error('the ZIP archive has overlapping members');
    }

    const cache = new Map<string, Uint8Array>();
    const read = async (name: string): Promise<Uint8Array | undefined> => {
        const entry = entries.get(name);
        if (!entry) return undefined;
        const cached = cache.get(name);
        if (cached) return cached;
        const packed = bytes.subarray(entry.start, entry.start + entry.packedSize);
        let data: Uint8Array;
        if (entry.method === 0) {
            data = packed;
        } else {
            if (typeof DecompressionStream === 'undefined') throw new Error('the ZIP compression format is unavailable');
            // Feed the existing bounded compressed view without creating another Blob copy.
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(packed);
                    controller.close();
                },
            }).pipeThrough(new DecompressionStream('deflate-raw'));
            const reader = stream.getReader();
            // Allocate at most the verified expanded size, and abort if the
            // actual stream produces a different count (even if ZIP metadata lies).
            data = new Uint8Array(entry.size);
            let written = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (written + value.byteLength > entry.size) {
                        throw new Error('a ZIP member exceeds its declared decompressed size');
                    }
                    data.set(value, written);
                    written += value.byteLength;
                }
            } catch (error) {
                try { await reader.cancel(); } catch { /* The original failure is authoritative. */ }
                throw error;
            } finally {
                reader.releaseLock();
            }
            if (written !== entry.size) throw new Error('a ZIP member is truncated');
        }
        if (crc32(data) !== entry.crc) throw new Error('"' + name + '" in the ZIP archive is damaged');
        cache.set(name, data);
        return data;
    };
    /**
     * Declared uncompressed size, without inflating the member. Callers that
     * accept smaller document formats can reject oversized members before
     * allocating their expanded bytes. Archive limits are already validated.
     */
    const memberInfo = (name: string): Readonly<{ size: number; packedSize: number; method: number }> | undefined => {
        const entry = entries.get(name);
        return entry ? { size: entry.size, packedSize: entry.packedSize, method: entry.method } : undefined;
    };
    return { names: () => [...entries.keys()], memberInfo, read };
};

/** Read every ZIP member when explicitly requested (material imports use openZip to read only referenced names). */
export const readZip = async (archive: Blob | Uint8Array): Promise<Map<string, Uint8Array>> => {
    const zip = await openZip(archive);
    const files = new Map<string, Uint8Array>();
    for (const name of zip.names()) {
        const data = await zip.read(name);
        if (data) files.set(name, data);
    }
    return files;
};

/** Hands a file to the browser as a download. */
export const download = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
