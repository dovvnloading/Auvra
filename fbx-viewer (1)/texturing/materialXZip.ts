import { materialXPictures } from './materialX';
import { openZip } from './zip';

/**
 * Read a published MaterialX ZIP without extracting paths to disk or decoding
 * unrelated files. openZip validates the complete archive's central directory,
 * safe member names, expansion budgets and (on read) each member's CRC.
 */
const MAX_MTLX_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff',
    tga: 'image/x-tga', psd: 'image/vnd.adobe.photoshop',
    exr: 'image/x-exr', hdr: 'image/vnd.radiance',
};

const imageType = (name: string): string | null => {
    const match = /\.([^.]+)$/.exec(name);
    return match ? CONTENT_TYPES[match[1].toLowerCase()] ?? null : null;
};

/**
 * Resolve a reference relative to the MTLX member's folder, staying strictly
 * within the ZIP root. This permits ordinary ../ shared-textures layouts but
 * never resolves filesystem paths, URLs or path traversal outside the archive.
 */
export const materialXZipPictureMember = (documentName: string, reference: string): string | null => {
    if (!reference || reference.startsWith('/') || reference.startsWith('\\')
        || /^[a-z][a-z0-9+.-]*:/i.test(reference) || /[\x00-\x1f\x7f]/.test(reference)
        || reference.includes('?') || reference.includes('#')) return null;
    const parts = documentName.split('/').slice(0, -1);
    for (const token of reference.replace(/\\/g, '/').split('/')) {
        if (token === '' || token === '.') continue;
        if (token === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else {
            parts.push(token);
        }
    }
    return parts.length ? parts.join('/') : null;
};

export interface MaterialXZipImport {
    documentName: string;
    xml: string;
    /** Project-import-ready pictures, indexed by their original XML paths. */
    pictures: Array<{ path: string; file: File }>;
    /** Referenced images absent, unsafe or in an unsupported image format. */
    missing: string[];
}

/**
 * Validate/parse the XML and every referenced image before the caller adds
 * project textures. On a corrupt referenced member, throw with no changes
 * committed. Never inflate unreferenced archive members.
 */
export const readMaterialXZip = async (archive: Blob | Uint8Array): Promise<MaterialXZipImport> => {
    const zip = await openZip(archive);
    const names = zip.names();
    const documents = names.filter((name) => /\.mtlx$/i.test(name));
    if (documents.length !== 1) {
        throw new Error(documents.length ? 'The MaterialX ZIP has multiple .mtlx files; choose a package with one material document.'
            : 'The MaterialX ZIP contains no .mtlx file.');
    }
    const documentName = documents[0];
    // Reject by validated ZIP metadata *before* invoking deflate/read. Otherwise
    // a 128 MB compressed XML member could consume memory just to be rejected
    // against the tighter 4 MB MaterialX document budget.
    const documentInfo = zip.memberInfo(documentName);
    if (!documentInfo || documentInfo.size > MAX_MTLX_BYTES) {
        throw new Error('The MaterialX document is missing or exceeds the 4 MB safety limit.');
    }
    const documentBytes = await zip.read(documentName);
    if (!documentBytes || documentBytes.byteLength > MAX_MTLX_BYTES) {
        throw new Error('The MaterialX document is missing or exceeds the 4 MB safety limit.');
    }
    let xml: string;
    try {
        xml = new TextDecoder('utf-8', { fatal: true }).decode(documentBytes);
    } catch {
        throw new Error('The MaterialX document is not valid UTF-8.');
    }

    // Parsing the XML first rejects invalid documents before any picture upload.
    const referenced = materialXPictures(xml);
    const known = new Set(names);
    const insensitive = new Map<string, string[]>();
    for (const name of names) {
        const key = name.toLowerCase();
        const candidates = insensitive.get(key) ?? [];
        candidates.push(name);
        insensitive.set(key, candidates);
    }
    const loaded = new Map<string, File>();
    const pictures: MaterialXZipImport['pictures'] = [];
    const missing: string[] = [];
    for (const picture of referenced) {
        const requested = materialXZipPictureMember(documentName, picture.path);
        const candidates = requested ? insensitive.get(requested.toLowerCase()) ?? [] : [];
        // Do not guess if two entries differ only in case and exact spelling
        // does not match the document. The same archive may be used on Windows.
        if (requested && !known.has(requested) && candidates.length > 1) {
            throw new Error('MaterialX image path "' + picture.path + '" is ambiguous in the ZIP.');
        }
        const member = requested && (known.has(requested) ? requested : candidates[0]);
        const mime = member ? imageType(member) : null;
        if (!member || !mime) {
            missing.push(picture.path);
            continue;
        }
        let file = loaded.get(member);
        if (!file) {
            const contents = await zip.read(member); // CRC and bounds checked here.
            if (!contents) {
                missing.push(picture.path);
                continue;
            }
            const basename = member.slice(member.lastIndexOf('/') + 1);
            file = new File([contents as BlobPart], basename, { type: mime });
            loaded.set(member, file);
        }
        pictures.push({ path: picture.path, file });
    }
    return { documentName, xml, pictures, missing };
};
