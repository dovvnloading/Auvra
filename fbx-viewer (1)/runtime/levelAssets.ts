import { mirroredClipName } from '../utils/animationBinding';
import type { AssetSelection } from '../utils/projectHydration';

/**
 * WHAT A LEVEL NEEDS
 *
 * A built game loads a level's assets when the level starts, not the whole project's at boot, so
 * what a level needs is worked out here from the project's documents alone. The walk follows every
 * string in the level's objects and blueprint that names something, and then what that names in
 * turn: a prefab brings its models, a model its textures and attachments. Scripts name things in
 * their source, so quoted text counts as names too. When in doubt an asset counts as needed, since
 * an extra one costs memory and a missing one breaks the level. A name a script builds while it runs
 * cannot be found this way: a game that does that turns off Game Settings' Load assets by level.
 */

type Document = Record<string, any>;
type Domains = Record<string, unknown>;
type AssetKind = 'models' | 'textures' | 'audio' | 'attachments';

/** Something the walk can arrive at: an asset to load, or a document to read on through. */
interface Entry {
    kind: AssetKind | 'document';
    document: Document;
}

export type LevelAssetNeeds = Required<AssetSelection>;

/** Level Streaming volumes add their level's objects to the session, so that level's assets count. */
const LEVEL_STREAMING_TYPE = 'levelStreaming';
/** Documents of these domains are reached by level, or always read, rather than by being named. */
const NOT_NAMED_DOMAINS: ReadonlySet<string> = new Set(['objects', 'levels', 'animations', 'metadata', 'hud']);
const ASSET_DOMAINS: Readonly<Record<string, AssetKind>> = { models: 'models', textures: 'textures', audio: 'audio', attachments: 'attachments' };
/** Quoted text in a longer string, such as a script's source, read as names. */
const QUOTED = /(['"`])((?:(?!\1)[^\n]){2,200})\1/g;
const MIN_NAME_LENGTH = 2;

const documentsOf = (domains: Domains, key: string): Document[] => {
    const documents = domains[key];
    return Array.isArray(documents) ? documents.filter(document => document && typeof document === 'object') : [];
};

export interface LevelAssetIndex {
    /** Everything `levelId` can need, whichever level it is entered from. An unknown level needs what every level does. */
    needsOf(levelId: string): LevelAssetNeeds;
}

/** Every asset and level in a project, for a game that loads it all. */
export const everyAssetIn = (domains: Domains): LevelAssetNeeds => {
    const ids = (key: string) => new Set<string>(documentsOf(domains, key).map(document => document.id));
    return { models: ids('models'), textures: ids('textures'), audio: ids('audio'), attachments: ids('attachments'), levels: ids('levels') };
};

export const createLevelAssetIndex = (domains: Domains): LevelAssetIndex => {
    const named = new Map<string, Entry[]>();
    const nameEntry = (name: unknown, entry: Entry) => {
        if (typeof name !== 'string' || name.length < MIN_NAME_LENGTH) return;
        const entries = named.get(name);
        if (entries) entries.push(entry);
        else named.set(name, [entry]);
    };
    const nameDocument = (entry: Entry) => {
        const { id, name } = entry.document;
        nameEntry(id, entry);
        nameEntry(name, entry);
        // Scripts and nodes may give a model's name without its file extension.
        if (typeof name === 'string') nameEntry(name.replace(/\.[a-z0-9]{2,5}$/i, ''), entry);
    };

    for (const key of Object.keys(domains)) {
        if (NOT_NAMED_DOMAINS.has(key)) continue;
        const kind = ASSET_DOMAINS[key] ?? 'document';
        for (const document of documentsOf(domains, key)) nameDocument({ kind, document });
    }

    const modelEntries = documentsOf(domains, 'models').map((document): Entry => ({ kind: 'models', document }));
    const modelById = new Map(modelEntries.map(entry => [entry.document.id, entry]));
    // Clips are found by name across models, so naming a clip needs every model that holds one of that
    // name: the first in the project wins, and leaving it out would play another model's instead.
    const clipsUnknown = new Set<Entry>();
    for (const entry of modelEntries) {
        const { category, clipNames, mirroredClips } = entry.document;
        if (Array.isArray(clipNames)) clipNames.forEach((clip: unknown) => nameEntry(clip, entry));
        else if (category === 'Character') clipsUnknown.add(entry);
        if (category === 'Animation') clipsUnknown.add(entry);
        if (Array.isArray(mirroredClips)) {
            mirroredClips.forEach((clip: unknown) => { if (typeof clip === 'string') nameEntry(mirroredClipName(clip), entry); });
        }
    }
    for (const animation of documentsOf(domains, 'animations')) {
        const owner = modelById.get(animation.modelId);
        if (!owner) continue;
        nameEntry(animation.name, owner);
        if (Array.isArray(animation.clipNames)) animation.clipNames.forEach((clip: unknown) => nameEntry(clip, owner));
        else clipsUnknown.add(owner);
    }

    const attachmentsByModel = new Map<string, Entry[]>();
    for (const document of documentsOf(domains, 'attachments')) {
        const entries = attachmentsByModel.get(document.parentModelId);
        const entry: Entry = { kind: 'attachments', document };
        if (entries) entries.push(entry);
        else attachmentsByModel.set(document.parentModelId, [entry]);
    }
    const socketsByModel = new Map<string, Document[]>();
    for (const document of documentsOf(domains, 'sockets')) {
        const sockets = socketsByModel.get(document.parentModelId);
        if (sockets) sockets.push(document);
        else socketsByModel.set(document.parentModelId, [document]);
    }

    const objectsByLevel = new Map<string, Document[]>();
    for (const document of documentsOf(domains, 'objects')) {
        const objects = objectsByLevel.get(document.levelId);
        if (objects) objects.push(document);
        else objectsByLevel.set(document.levelId, [document]);
    }
    const levelById = new Map(documentsOf(domains, 'levels').map(document => [document.id, document]));

    const walk = (levelId: string): LevelAssetNeeds => {
        const needs = {
            models: new Set<string>(),
            textures: new Set<string>(),
            audio: new Set<string>(),
            attachments: new Set<string>(),
            levels: new Set<string>(),
        };
        const entered = new Set<Document>();

        const enter = (entry: Entry) => {
            if (entered.has(entry.document)) return;
            entered.add(entry.document);
            if (entry.kind !== 'document') needs[entry.kind].add(entry.document.id);
            if (entry.kind === 'models') {
                attachmentsByModel.get(entry.document.id)?.forEach(enter);
                socketsByModel.get(entry.document.id)?.forEach(read);
            }
            read(entry.document);
        };
        const readName = (name: string) => named.get(name)?.forEach(enter);
        const readString = (text: string) => {
            readName(text);
            // Some fields say what an id is first, as a particle sprite's `texture:<id>`.
            const colon = text.indexOf(':');
            if (colon > 0) readName(text.slice(colon + 1));
            if (!/['"`]/.test(text)) return;
            for (const match of text.matchAll(QUOTED)) readName(match[2]);
        };
        const read = (value: unknown) => {
            if (typeof value === 'string') {
                readString(value);
            } else if (Array.isArray(value)) {
                // Heights and the like: long runs of numbers name nothing.
                if (typeof value[0] !== 'number') value.forEach(read);
            } else if (value && typeof value === 'object') {
                const record = value as Document;
                if (record.type === LEVEL_STREAMING_TYPE && typeof record.props?.levelId === 'string') enterLevel(record.props.levelId);
                Object.values(record).forEach(read);
            }
        };
        const enterLevel = (id: string) => {
            if (needs.levels.has(id) || !levelById.has(id)) return;
            needs.levels.add(id);
            read(levelById.get(id));
            objectsByLevel.get(id)?.forEach(read);
        };

        // What every level can need: the game's settings and HUD, the characters it plays with, and
        // the models whose clips are not recorded, which characters may find by a name only those hold.
        documentsOf(domains, 'metadata').forEach(read);
        documentsOf(domains, 'hud').forEach(read);
        const blueprints = documentsOf(domains, 'blueprints');
        for (const type of ['Player Character', 'Enemy Controller']) {
            const blueprint = blueprints.find(candidate => candidate.type === type);
            if (blueprint) enter({ kind: 'document', document: blueprint });
        }
        clipsUnknown.forEach(enter);
        enterLevel(levelId);
        return needs;
    };

    const known = new Map<string, LevelAssetNeeds>();
    return {
        needsOf: (levelId) => {
            const existing = known.get(levelId);
            if (existing) return existing;
            const needs = walk(levelId);
            known.set(levelId, needs);
            return needs;
        },
    };
};
