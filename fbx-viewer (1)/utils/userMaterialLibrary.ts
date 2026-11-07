import { materialAssetDocument, readMaterialAsset, withRenamedTextures, type MaterialAsset } from '../runtime/materials/materialLibrary';
import { normalizeTextureSettings, type TextureSettings } from '../texturing/textureSettings';

/**
 * MY LIBRARY: MATERIALS ACROSS PROJECTS
 *
 * The user's own materials, kept outside any one project (in the editor's storage on this machine), each
 * with the pictures it draws with and a ball rendered on the engine's material path. Entries have a plain
 * name, a folder and tags; they can be searched, duplicated and deleted (with undo), and brought into the
 * open project, which takes its own copy of the material and its pictures. Each entry remembers where it
 * was brought in (where-used).
 *
 * Storage is behind LibraryStorage (IndexedDB in the editor, memory in tests).
 */

/** A picture an entry draws with, as kept in the library (its file, and an 8-bit preview of a deep one). */
export interface LibraryPicture {
    /** The id the entry's material names it by. */
    id: string;
    name: string;
    file: Blob;
    dimensions: { width: number; height: number };
    /** How it is drawn (colour or data, normal map, compression...), without anything one project kept for it. */
    settings?: TextureSettings;
    preview?: Blob;
}

/** A project an entry was brought into. */
export interface LibraryUse {
    projectId: string;
    projectName: string;
    /** The material it became there. */
    materialId: string;
    at: number;
}

export interface LibraryEntry {
    id: string;
    name: string;
    /** Where it sits: '' at the top, or a path such as "Metals/Painted". */
    folder: string;
    tags: string[];
    /** The material document (as a project keeps it), naming its pictures by their ids. */
    material: unknown;
    /** Ids of the pictures kept with it. */
    pictureIds: string[];
    /** Its ball, rendered on the engine's material path (PNG). */
    thumbnail?: Blob;
    /** The project material it was added from, so adding it again updates it. */
    source?: { projectId: string; materialId: string };
    uses: LibraryUse[];
    added: number;
    updated: number;
}

/** Where entries and their pictures are kept. */
export interface LibraryStorage {
    entries(): Promise<LibraryEntry[]>;
    /** Keeps an entry; with pictures, they replace the ones it had. */
    put(entry: LibraryEntry, pictures?: readonly LibraryPicture[]): Promise<void>;
    /** Deletes an entry and its pictures. */
    remove(id: string): Promise<void>;
    pictures(entryId: string): Promise<LibraryPicture[]>;
}

/** An entry deleted, with everything needed to put it back. */
export interface RemovedLibraryEntry {
    entry: LibraryEntry;
    pictures: LibraryPicture[];
}

const MAX_NAME = 128;
const MAX_TAG = 32;
const MAX_TAGS = 16;
const MAX_FOLDER = 256;

/** A folder path made tidy: parts trimmed, empty parts dropped, joined by "/". */
export const tidyFolder = (folder: string): string => folder.split('/').map(part => part.trim()).filter(Boolean).join('/').slice(0, MAX_FOLDER);

/** Tags made tidy: trimmed, lower case, no repeats. */
export const tidyTags = (tags: readonly string[]): string[] => [...new Set(tags.map(tag => tag.trim().toLowerCase().slice(0, MAX_TAG)).filter(Boolean))].slice(0, MAX_TAGS);

/** A picture's settings without what one project kept for it (its preview and compressed blocks). */
export const portableSettings = (settings: TextureSettings | undefined): TextureSettings | undefined => {
    const normal = normalizeTextureSettings(settings);
    if (!normal) return undefined;
    const { preview: _preview, compressed: _compressed, ...rest } = normal;
    return Object.keys(rest).length ? rest : undefined;
};

/** The entry's material, or null when what is kept cannot be read. */
export const libraryMaterial = (entry: LibraryEntry): MaterialAsset | null => {
    const asset = readMaterialAsset(entry.material);
    if (!asset) return null;
    const { owner: _owner, ...shared } = asset;
    return shared;
};

/** What a search, folder and tag pick out. */
export interface LibraryFilter {
    query?: string;
    /** A folder and everything inside it; '' or absent for all. */
    folder?: string;
    tag?: string;
}

/** The entries a filter picks, by name: every word of the search found in the name, tags or folder. */
export const filterLibrary = (entries: readonly LibraryEntry[], filter: LibraryFilter): LibraryEntry[] => {
    const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const folder = tidyFolder(filter.folder ?? '');
    return entries.filter((entry) => {
        if (folder && entry.folder !== folder && !entry.folder.startsWith(`${folder}/`)) return false;
        if (filter.tag && !entry.tags.includes(filter.tag)) return false;
        const text = `${entry.name} ${entry.tags.join(' ')} ${entry.folder}`.toLowerCase();
        return words.every(word => text.includes(word));
    }).sort((a, b) => a.name.localeCompare(b.name));
};

/** Every folder in use, with the folders above them, in order. */
export const libraryFolders = (entries: readonly LibraryEntry[]): string[] => {
    const folders = new Set<string>();
    for (const entry of entries) {
        const parts = entry.folder ? entry.folder.split('/') : [];
        for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join('/'));
    }
    return [...folders].sort((a, b) => a.localeCompare(b));
};

/** Every tag in use, most used first. */
export const libraryTags = (entries: readonly LibraryEntry[]): string[] => {
    const counts = new Map<string, number>();
    for (const entry of entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
};

/** A name not yet taken among `taken`: the name, else "Name 2", "Name 3"... */
export const uniqueName = (name: string, taken: Iterable<string>): string => {
    const used = new Set(taken);
    const base = name.trim().slice(0, MAX_NAME) || 'Material';
    let unique = base;
    for (let n = 2; used.has(unique); n++) unique = `${base} ${n}`;
    return unique;
};

/**
 * The material an entry becomes in a project: a new id, a name not taken there, and its pictures renamed to
 * the ids the project gave them (a picture the project did not take is cleared).
 */
export const materialFromLibrary = (
    entry: LibraryEntry,
    textureIds: ReadonlyMap<string, string>,
    id: string,
    takenNames: Iterable<string>,
): MaterialAsset | null => {
    const asset = libraryMaterial(entry);
    if (!asset) return null;
    return { ...withRenamedTextures(asset, (textureId) => textureIds.get(textureId) ?? ''), id, name: uniqueName(entry.name, takenNames) };
};

export class UserMaterialLibrary {
    /** Counts changes, for subscribers. */
    version = 0;
    private list: LibraryEntry[] = [];
    private loading: Promise<void> | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly storage: LibraryStorage, private readonly now: () => number = () => Date.now(), private readonly newId: () => string = () => crypto.randomUUID()) {}

    /** Reads what is kept (once; later calls wait for the same read). */
    load(): Promise<void> {
        if (!this.loading) {
            this.loading = this.storage.entries().then((entries) => {
                this.list = entries;
                this.emit();
            });
        }
        return this.loading;
    }

    entries(): readonly LibraryEntry[] {
        return this.list;
    }

    get(id: string): LibraryEntry | undefined {
        return this.list.find(entry => entry.id === id);
    }

    /** The entry added from this project material, if any. */
    addedFrom(projectId: string, materialId: string): LibraryEntry | undefined {
        return this.list.find(entry => entry.source?.projectId === projectId && entry.source.materialId === materialId);
    }

    pictures(id: string): Promise<LibraryPicture[]> {
        return this.storage.pictures(id);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Adds a material with its pictures and ball. */
    async add(input: { asset: MaterialAsset; pictures: readonly LibraryPicture[]; thumbnail?: Blob; source?: LibraryEntry['source']; folder?: string; tags?: readonly string[] }): Promise<LibraryEntry> {
        await this.load();
        const at = this.now();
        const { owner: _owner, ...asset } = input.asset;
        const entry: LibraryEntry = {
            id: this.newId(),
            name: uniqueName(asset.name, this.list.map(other => other.name)),
            folder: tidyFolder(input.folder ?? ''),
            tags: tidyTags(input.tags ?? []),
            material: materialAssetDocument(asset),
            pictureIds: input.pictures.map(picture => picture.id),
            ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
            ...(input.source ? { source: input.source } : {}),
            uses: [],
            added: at,
            updated: at,
        };
        await this.storage.put(entry, input.pictures);
        this.list = [...this.list, entry];
        this.emit();
        return entry;
    }

    /** Puts a newer version of its material, pictures and ball into an entry, keeping its name, folder, tags and uses. */
    async replaceMaterial(id: string, input: { asset: MaterialAsset; pictures: readonly LibraryPicture[]; thumbnail?: Blob }): Promise<LibraryEntry> {
        const entry = this.require(id);
        const { owner: _owner, ...asset } = input.asset;
        const next: LibraryEntry = {
            ...entry,
            material: materialAssetDocument(asset),
            pictureIds: input.pictures.map(picture => picture.id),
            ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
            updated: this.now(),
        };
        await this.storage.put(next, input.pictures);
        this.swap(next);
        return next;
    }

    /** Renames, moves or tags an entry. */
    async change(id: string, changes: Partial<Pick<LibraryEntry, 'name' | 'folder' | 'tags' | 'thumbnail'>>): Promise<LibraryEntry> {
        const entry = this.require(id);
        const next: LibraryEntry = {
            ...entry,
            ...(changes.name !== undefined ? { name: changes.name.trim().slice(0, MAX_NAME) || entry.name } : {}),
            ...(changes.folder !== undefined ? { folder: tidyFolder(changes.folder) } : {}),
            ...(changes.tags !== undefined ? { tags: tidyTags(changes.tags) } : {}),
            ...(changes.thumbnail !== undefined ? { thumbnail: changes.thumbnail } : {}),
            updated: this.now(),
        };
        await this.storage.put(next);
        this.swap(next);
        return next;
    }

    /** A copy of an entry, with its own pictures, in the same folder: not yet used anywhere. */
    async duplicate(id: string): Promise<LibraryEntry> {
        const entry = this.require(id);
        const pictures = await this.storage.pictures(id);
        const at = this.now();
        const copy: LibraryEntry = {
            ...entry,
            id: this.newId(),
            name: uniqueName(`${entry.name} copy`, this.list.map(other => other.name)),
            tags: [...entry.tags],
            uses: [],
            added: at,
            updated: at,
        };
        delete copy.source;
        await this.storage.put(copy, pictures);
        this.list = [...this.list, copy];
        this.emit();
        return copy;
    }

    /** Deletes an entry; what is returned puts it back (restore). */
    async remove(id: string): Promise<RemovedLibraryEntry> {
        const entry = this.require(id);
        const pictures = await this.storage.pictures(id);
        await this.storage.remove(id);
        this.list = this.list.filter(other => other.id !== id);
        this.emit();
        return { entry, pictures };
    }

    /** Puts a deleted entry back as it was. */
    async restore(removed: RemovedLibraryEntry): Promise<void> {
        await this.storage.put(removed.entry, removed.pictures);
        this.list = [...this.list.filter(other => other.id !== removed.entry.id), removed.entry];
        this.emit();
    }

    /** Remembers that an entry was brought into a project (the latest use per project). */
    async recordUse(id: string, use: Omit<LibraryUse, 'at'>): Promise<void> {
        const entry = this.require(id);
        const next: LibraryEntry = { ...entry, uses: [...entry.uses.filter(other => other.projectId !== use.projectId), { ...use, at: this.now() }] };
        await this.storage.put(next);
        this.swap(next);
    }

    private require(id: string): LibraryEntry {
        const entry = this.get(id);
        if (!entry) throw new Error('That material is no longer in your library.');
        return entry;
    }

    private swap(next: LibraryEntry): void {
        this.list = this.list.map(entry => (entry.id === next.id ? next : entry));
        this.emit();
    }

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }
}

/** Storage in memory (tests, and where the editor's storage cannot be had). */
export const memoryLibraryStorage = (): LibraryStorage => {
    const entries = new Map<string, LibraryEntry>();
    const pictures = new Map<string, LibraryPicture[]>();
    return {
        entries: async () => [...entries.values()],
        put: async (entry, kept) => {
            entries.set(entry.id, entry);
            if (kept) pictures.set(entry.id, [...kept]);
        },
        remove: async (id) => {
            entries.delete(id);
            pictures.delete(id);
        },
        pictures: async (entryId) => [...(pictures.get(entryId) ?? [])],
    };
};

const DATABASE = 'auvra-material-library';
const ENTRIES = 'entries';
const PICTURES = 'pictures';

const requestDone = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Your library could not be written.'));
});

/** Storage in the editor's own IndexedDB: kept on this machine, whichever project is open. */
export const indexedDbLibraryStorage = (): LibraryStorage => {
    let opened: Promise<IDBDatabase> | null = null;
    const database = (): Promise<IDBDatabase> => {
        opened ??= new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(ENTRIES, { keyPath: 'id' });
                request.result.createObjectStore(PICTURES, { keyPath: ['entryId', 'id'] }).createIndex('entry', 'entryId');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => { opened = null; reject(request.error ?? new Error('Your library could not be opened.')); };
        });
        return opened;
    };
    /** The entry's pictures replaced by `kept` (none: deleted), in order: its old ones go before the new ones are put. */
    const replacePictures = (store: IDBObjectStore, entryId: string, kept: readonly LibraryPicture[] = []): void => {
        const keys = store.index('entry').getAllKeys(IDBKeyRange.only(entryId));
        keys.onsuccess = () => {
            for (const key of keys.result) store.delete(key);
            for (const picture of kept) store.put({ ...picture, entryId });
        };
    };
    return {
        entries: async () => requestDone((await database()).transaction(ENTRIES, 'readonly').objectStore(ENTRIES).getAll() as IDBRequest<LibraryEntry[]>),
        put: async (entry, kept) => {
            const transaction = (await database()).transaction([ENTRIES, PICTURES], 'readwrite');
            transaction.objectStore(ENTRIES).put(entry);
            if (kept) replacePictures(transaction.objectStore(PICTURES), entry.id, kept);
            await transactionDone(transaction);
        },
        remove: async (id) => {
            const transaction = (await database()).transaction([ENTRIES, PICTURES], 'readwrite');
            transaction.objectStore(ENTRIES).delete(id);
            replacePictures(transaction.objectStore(PICTURES), id);
            await transactionDone(transaction);
        },
        pictures: async (entryId) => {
            const kept = await requestDone((await database()).transaction(PICTURES, 'readonly').objectStore(PICTURES).index('entry').getAll(IDBKeyRange.only(entryId)) as IDBRequest<Array<LibraryPicture & { entryId: string }>>);
            return kept.map(({ entryId: _entry, ...picture }) => picture);
        },
    };
};

let shared: UserMaterialLibrary | null = null;

/** The user's library in the editor. */
export const userMaterialLibrary = (): UserMaterialLibrary => {
    shared ??= new UserMaterialLibrary(typeof indexedDB === 'undefined' ? memoryLibraryStorage() : indexedDbLibraryStorage());
    return shared;
};
