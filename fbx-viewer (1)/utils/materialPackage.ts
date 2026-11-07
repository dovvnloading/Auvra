import { materialAssetDocument, readMaterialAsset, type MaterialAsset } from '../runtime/materials/materialLibrary';
import { makeZip, readZip } from '../texturing/zip';
import { libraryMaterial, libraryNodeGraphs, portableSettings, usedNodeGraphs, type LibraryEntry, type LibraryPicture, type UserMaterialLibrary } from './userMaterialLibrary';
import { capturePictures, type MaterialWithParts, type ProjectPictures } from './userMaterialLibraryActions';

/**
 * A PUBLISHED MATERIAL (.auvramat)
 *
 * One file holding a material as it is published: its texture graph (with the parameters it exposes, their
 * values and its presets), the pictures it draws with (its own and the ones its graph reads), the graphs it uses
 * as nodes (and those they use), and its ball. It is written from the Materials tab and read into another
 * project or into My library, where it is an ordinary material: its parameters stay live and a game cooks its
 * graph like any other.
 *
 * The file is a ZIP archive: `auvramat.json` names the format and its version and holds the material documents;
 * the pictures sit beside it under `pictures/`. A package of a version newer than this editor reads is refused
 * plainly, never half read.
 */

export const PACKAGE_FORMAT = 'auvramat';
/** The version written; packages of this version and older are read. */
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.auvramat';
const MANIFEST = 'auvramat.json';
const MAX_PICTURE_SIDE = 16384;
const MAX_NAME = 256;

/** A material package, read or about to be written. */
export interface MaterialPackage extends MaterialWithParts {
    /** Its ball, as rendered when it was written (PNG). */
    ball?: Blob;
    /** When it was written (milliseconds since 1970). */
    made?: number;
}

/** Why a package could not be read, in words for the person who picked it. */
export class MaterialPackageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MaterialPackageError';
    }
}

interface ManifestPicture {
    id: string;
    name: string;
    file: string;
    type: string;
    width: number;
    height: number;
    settings?: unknown;
    preview?: string;
}

interface Manifest {
    format: string;
    version: number;
    name: string;
    made: string;
    material: unknown;
    nodeGraphs: unknown[];
    pictures: ManifestPicture[];
    ball?: string;
}

/** A name safe as a file name. */
export const packageFileStem = (name: string): string => name.replace(/[^\w .-]+/g, '_').trim().slice(0, 96) || 'material';

const extensionOf = (name: string, type: string): string => {
    const own = /\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1];
    if (own) return own.toLowerCase();
    const fromType = /^image\/(png|jpeg|webp|tiff|x-exr|vnd\.radiance)$/.exec(type)?.[1];
    return ({ jpeg: 'jpg', 'x-exr': 'exr', 'vnd.radiance': 'hdr' } as Record<string, string>)[fromType ?? ''] ?? fromType ?? 'png';
};

/** The material without what one project keeps for it (the model owning a painted copy). */
const shared = (asset: MaterialAsset): MaterialAsset => {
    const { owner: _owner, ...rest } = asset;
    return rest;
};

/** Writes a package as one file. */
export const writeMaterialPackage = async (pkg: MaterialPackage, now: number = Date.now()): Promise<Blob> => {
    const files: Array<{ name: string; data: Blob | Uint8Array }> = [];
    const pictures: ManifestPicture[] = pkg.pictures.map((picture, index) => {
        const stem = `pictures/${index + 1} ${packageFileStem(picture.name.replace(/\.[A-Za-z0-9]{2,5}$/, ''))}`;
        const file = `${stem}.${extensionOf(picture.name, picture.file.type)}`;
        files.push({ name: file, data: picture.file });
        const preview = picture.preview ? `${stem} preview.png` : undefined;
        if (picture.preview && preview) files.push({ name: preview, data: picture.preview });
        const settings = portableSettings(picture.settings);
        return {
            id: picture.id,
            name: picture.name,
            file,
            type: picture.file.type || 'application/octet-stream',
            width: picture.dimensions.width,
            height: picture.dimensions.height,
            ...(settings ? { settings } : {}),
            ...(preview ? { preview } : {}),
        };
    });
    if (pkg.ball) files.push({ name: 'ball.png', data: pkg.ball });
    const manifest: Manifest = {
        format: PACKAGE_FORMAT,
        version: PACKAGE_VERSION,
        name: pkg.name,
        made: new Date(pkg.made ?? now).toISOString(),
        material: materialAssetDocument(shared({ ...pkg.material, name: pkg.name })),
        nodeGraphs: pkg.nodeGraphs.map(graph => materialAssetDocument(shared(graph))),
        pictures,
        ...(pkg.ball ? { ball: 'ball.png' } : {}),
    };
    // The manifest first, so a look inside the archive shows what it is.
    files.unshift({ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return new Blob([await makeZip(files)], { type: 'application/zip' });
};

const NOT_A_PACKAGE = 'This file is not a material package (.auvramat).';
const damaged = (detail: string) => new MaterialPackageError(`This material package is damaged: ${detail}.`);

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : fallback);
const side = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PICTURE_SIDE ? value as number : null);

/** Reads a package, or says plainly why it cannot (not a package, from a newer editor, or damaged). */
export const readMaterialPackage = async (file: Blob): Promise<MaterialPackage> => {
    let files: Map<string, Uint8Array>;
    try {
        files = await readZip(file);
    } catch (failure) {
        if (failure instanceof Error && failure.message === 'not a ZIP archive') throw new MaterialPackageError(NOT_A_PACKAGE);
        throw damaged(failure instanceof Error ? failure.message : String(failure));
    }
    const manifestBytes = files.get(MANIFEST);
    if (!manifestBytes) throw new MaterialPackageError(NOT_A_PACKAGE);
    let manifest: Partial<Manifest>;
    try {
        manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Partial<Manifest>;
    } catch {
        throw damaged('its description could not be read');
    }
    if (!manifest || typeof manifest !== 'object' || manifest.format !== PACKAGE_FORMAT) throw new MaterialPackageError(NOT_A_PACKAGE);
    const version = manifest.version;
    if (!Number.isInteger(version) || (version as number) < 1) throw damaged('it does not say which version it is');
    if ((version as number) > PACKAGE_VERSION) {
        const called = text(manifest.name);
        throw new MaterialPackageError(`${called ? `"${called}" is` : 'This is'} a version ${version} material package, written by a newer editor. This editor reads packages up to version ${PACKAGE_VERSION}, so it was not opened.`);
    }
    const material = readMaterialAsset(manifest.material);
    if (!material) throw damaged('its material could not be read');
    const nodeGraphs = (Array.isArray(manifest.nodeGraphs) ? manifest.nodeGraphs : []).map((raw) => {
        const graph = readMaterialAsset(raw);
        if (!graph) throw damaged('a graph it uses as a node could not be read');
        return shared(graph);
    });
    const pictures: LibraryPicture[] = (Array.isArray(manifest.pictures) ? manifest.pictures : []).map((raw: Partial<ManifestPicture>) => {
        const id = text(raw?.id);
        const width = side(raw?.width);
        const height = side(raw?.height);
        const bytes = typeof raw?.file === 'string' ? files.get(raw.file) : undefined;
        if (!id || !width || !height || !bytes) throw damaged(`the picture "${text(raw?.name, 'without a name')}" is missing`);
        const previewBytes = typeof raw.preview === 'string' ? files.get(raw.preview) : undefined;
        const settings = portableSettings(raw.settings as LibraryPicture['settings']);
        return {
            id,
            name: text(raw.name) || id,
            file: new Blob([bytes as BlobPart], { type: typeof raw.type === 'string' ? raw.type : '' }),
            dimensions: { width, height },
            ...(settings ? { settings } : {}),
            ...(previewBytes ? { preview: new Blob([previewBytes as BlobPart], { type: 'image/png' }) } : {}),
        };
    });
    const ballBytes = typeof manifest.ball === 'string' ? files.get(manifest.ball) : undefined;
    const made = Date.parse(text(manifest.made));
    return {
        name: text(manifest.name) || material.name,
        material: shared(material),
        nodeGraphs,
        pictures,
        ...(ballBytes ? { ball: new Blob([ballBytes as BlobPart], { type: 'image/png' }) } : {}),
        ...(Number.isFinite(made) ? { made } : {}),
    };
};

/** A project material as a package: the graphs it uses as nodes and every picture they draw with come with it. */
export const packageFromProject = async (
    asset: MaterialAsset,
    project: ProjectPictures & { materialOf?: (id: string) => MaterialAsset | undefined },
    ball?: (asset: MaterialAsset, pictures: readonly LibraryPicture[]) => Promise<Blob | null>,
): Promise<MaterialPackage> => {
    const nodeGraphs = (project.materialOf ? usedNodeGraphs(asset, project.materialOf) : []).map(shared);
    const pictures = await capturePictures([asset, ...nodeGraphs], project);
    const rendered = ball ? await ball(asset, pictures).catch(() => null) : null;
    return { name: asset.name, material: shared(asset), nodeGraphs, pictures, ...(rendered ? { ball: rendered } : {}) };
};

/** A My library material as a package. */
export const packageFromLibrary = (entry: LibraryEntry, pictures: readonly LibraryPicture[]): MaterialPackage => {
    const material = libraryMaterial(entry);
    if (!material) throw new MaterialPackageError('This material could not be read.');
    return { name: entry.name, material, nodeGraphs: libraryNodeGraphs(entry), pictures, ...(entry.thumbnail ? { ball: entry.thumbnail } : {}) };
};

/** Puts a package into My library, with its pictures, node graphs and ball. */
export const packageIntoLibrary = (library: UserMaterialLibrary, pkg: MaterialPackage): Promise<LibraryEntry> =>
    library.add({ asset: { ...pkg.material, name: pkg.name }, pictures: pkg.pictures, nodeGraphs: pkg.nodeGraphs, ...(pkg.ball ? { thumbnail: pkg.ball } : {}) });
