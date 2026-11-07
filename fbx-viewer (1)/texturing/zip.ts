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

/** A ZIP archive's files by name, read back: stored ones as they are, deflated ones where the browser can inflate them. */
export const readZip = async (archive: Blob | Uint8Array): Promise<Map<string, Uint8Array>> => {
    const bytes = ArrayBuffer.isView(archive) ? archive as Uint8Array : new Uint8Array(await (archive as Blob).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The end record sits in the last 22 bytes, or before a comment of up to 64 KB.
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
    }
    if (end < 0) throw new Error('not a ZIP archive');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = new Map<string, Uint8Array>();
    for (let index = 0; index < count; index++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('the ZIP archive is damaged');
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const packedSize = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) continue;
        if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('the ZIP archive is damaged');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + packedSize > bytes.length) throw new Error('the ZIP archive is damaged');
        const packed = bytes.subarray(start, start + packedSize);
        let data: Uint8Array;
        if (method === 0) data = packed;
        else if (method === 8 && typeof DecompressionStream !== 'undefined') {
            const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else throw new Error(`"${name}" is packed in a way this editor does not read`);
        if (crc32(data) !== crc) throw new Error(`"${name}" in the ZIP archive is damaged`);
        files.set(name, data);
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
