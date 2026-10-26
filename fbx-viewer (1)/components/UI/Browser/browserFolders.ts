/**
 * Pure helpers for the content browser: folder paths, asset renames, model
 * file types and drag payloads. Folder paths are '/'-separated with no
 * leading or trailing slash; the empty string is the root ("Content").
 */

export const ROOT_FOLDER = '';
export const ROOT_FOLDER_LABEL = 'Content';
/** Matches the `folder` maxLength in the project v1 asset schemas. */
export const FOLDER_PATH_MAX_LENGTH = 256;
/** Matches the `name` maxLength in the project v1 asset schemas. */
export const ASSET_NAME_MAX_LENGTH = 256;

export const MODEL_FILE_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj'] as const;
export const MODEL_MIME_TYPES: Readonly<Record<string, string>> = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj': 'model/obj',
    '.fbx': 'model/fbx',
};
/** `accept` value for model file pickers (extensions first; MIME types help pickers that filter by type). */
export const MODEL_FILE_ACCEPT = [...MODEL_FILE_EXTENSIONS, ...Object.values(MODEL_MIME_TYPES)].join(',');

/** Shared contract: dropping this on the viewport places the model whose id is the payload. */
export const MODEL_DRAG_TYPE = 'application/x-auvra-model';
/** Browser-internal payload used to move assets between folders. */
export const ASSET_DRAG_TYPE = 'application/x-auvra-asset';

export type BrowserAssetKind = 'model' | 'texture' | 'audio';

export interface AssetDragPayload {
    kind: BrowserAssetKind;
    id: string;
}

const ASSET_KINDS: readonly BrowserAssetKind[] = ['model', 'texture', 'audio'];
const INVALID_SEGMENT = /[\\/]/;

/** Canonical form of a stored folder value: trims segments, drops empty ones, '' for root. */
export const normalizeFolderPath = (path: string | null | undefined): string => {
    if (typeof path !== 'string') return ROOT_FOLDER;
    return path
        .split(/[\\/]+/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
        .join('/');
};

export const joinFolderPath = (parent: string, name: string): string =>
    normalizeFolderPath(parent ? `${parent}/${name}` : name);

export const parentFolderPath = (path: string): string => {
    const normalized = normalizeFolderPath(path);
    const index = normalized.lastIndexOf('/');
    return index < 0 ? ROOT_FOLDER : normalized.slice(0, index);
};

export const folderLeafName = (path: string): string => {
    const normalized = normalizeFolderPath(path);
    if (!normalized) return ROOT_FOLDER_LABEL;
    return normalized.slice(normalized.lastIndexOf('/') + 1);
};

export const folderDepth = (path: string): number => {
    const normalized = normalizeFolderPath(path);
    return normalized ? normalized.split('/').length : 0;
};

/** Every non-root folder on the way to `path`, outermost first, including `path` itself. */
export const folderAncestors = (path: string): string[] => {
    const segments = normalizeFolderPath(path).split('/').filter(Boolean);
    return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
};

/** Unique, sorted, non-root folder paths, including every ancestor of each input. */
export const collectFolderPaths = (folders: Iterable<string | null | undefined>): string[] => {
    const paths = new Set<string>();
    for (const folder of folders) {
        for (const ancestor of folderAncestors(normalizeFolderPath(folder))) paths.add(ancestor);
    }
    return [...paths].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
};

export const childFolderPaths = (paths: readonly string[], parent: string): string[] => {
    const normalizedParent = normalizeFolderPath(parent);
    return paths.filter((path) => path !== normalizedParent && parentFolderPath(path) === normalizedParent);
};

/** Folders in tree order (each parent directly followed by its subtree), for flat indented lists. */
export const depthFirstFolderOrder = (paths: readonly string[]): string[] => {
    const result: string[] = [];
    const visit = (parent: string) => {
        for (const child of childFolderPaths(paths, parent)) {
            result.push(child);
            visit(child);
        }
    };
    visit(ROOT_FOLDER);
    return result;
};

/** True when `assetFolder` is `folder` itself, or (recursive) anywhere below it. */
export const isWithinFolder = (assetFolder: string | null | undefined, folder: string, recursive: boolean): boolean => {
    const asset = normalizeFolderPath(assetFolder);
    const target = normalizeFolderPath(folder);
    if (asset === target) return true;
    if (!recursive) return false;
    return target === ROOT_FOLDER || asset.startsWith(`${target}/`);
};

export type FolderNameResult =
    | { ok: true; path: string; existed: boolean }
    | { ok: false; error: string };

/** Validates a new folder name under `parent`; an existing sibling (any case) is returned rather than duplicated. */
export const validateNewFolderName = (name: string, parent: string, existing: readonly string[]): FolderNameResult => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Folder name is required.' };
    if (INVALID_SEGMENT.test(trimmed)) return { ok: false, error: 'Folder names cannot contain / or \\.' };
    if (trimmed === '.' || trimmed === '..') return { ok: false, error: 'That folder name is reserved.' };
    const path = joinFolderPath(parent, trimmed);
    if (path.length > FOLDER_PATH_MAX_LENGTH) return { ok: false, error: `Folder paths are limited to ${FOLDER_PATH_MAX_LENGTH} characters.` };
    const match = existing.find((candidate) => candidate.toLowerCase() === path.toLowerCase());
    return match ? { ok: true, path: match, existed: true } : { ok: true, path, existed: false };
};

/** Splits a file-style asset name into stem and extension ('.glb'); names without one (or 'v1.2') get ''. */
export const splitAssetName = (name: string): { stem: string; extension: string } => {
    const match = /^(.+?)(\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10})$/.exec(name);
    return match ? { stem: match[1], extension: match[2] } : { stem: name, extension: '' };
};

export type AssetRenameResult = { ok: true; name: string; changed: boolean } | { ok: false; error: string };

/**
 * Renames keep the source extension: project hydration reloads the stored
 * file under its asset name, and the loader picks the parser from it.
 */
export const validateAssetRename = (currentName: string, nextStem: string, siblingNames: readonly string[]): AssetRenameResult => {
    const { extension } = splitAssetName(currentName);
    let stem = nextStem.trim();
    if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, -extension.length).trim();
    if (!stem) return { ok: false, error: 'Name is required.' };
    if (INVALID_SEGMENT.test(stem)) return { ok: false, error: 'Names cannot contain / or \\.' };
    const name = `${stem}${extension}`;
    if (name.length > ASSET_NAME_MAX_LENGTH) return { ok: false, error: `Names are limited to ${ASSET_NAME_MAX_LENGTH} characters.` };
    if (name === currentName) return { ok: true, name, changed: false };
    const lowered = name.toLowerCase();
    if (siblingNames.some((sibling) => sibling !== currentName && sibling.toLowerCase() === lowered)) {
        return { ok: false, error: `An asset named "${name}" already exists.` };
    }
    return { ok: true, name, changed: true };
};

export const isModelFileName = (name: string): boolean => {
    const lowered = name.toLowerCase();
    return MODEL_FILE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
};

export const encodeAssetDrag = (payload: AssetDragPayload): string => JSON.stringify(payload);

export const decodeAssetDrag = (raw: string): AssetDragPayload | null => {
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object') return null;
        const { kind, id } = value as { kind?: unknown; id?: unknown };
        if (typeof id !== 'string' || !id) return null;
        if (typeof kind !== 'string' || !(ASSET_KINDS as readonly string[]).includes(kind)) return null;
        return { kind: kind as BrowserAssetKind, id };
    } catch {
        return null;
    }
};

export const hasAssetDrag = (types: readonly string[]): boolean => types.includes(ASSET_DRAG_TYPE);
