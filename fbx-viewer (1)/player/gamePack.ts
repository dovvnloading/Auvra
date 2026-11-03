import { GAME_PACK_FORMAT, type GamePackManifest } from '../runtime/types';
import { PREPARED_MODEL_VERSION } from '../utils/preparedModels/format';

/** A game pack served next to the player: game/game.json, game/content/<domain>.json, game/assets/<file>. */
export interface GamePackSource {
    manifest: GamePackManifest;
    domains: Record<string, unknown[]>;
    /** Returns a blob URL typed with the manifest MIME, so static hosts that send octet-stream still work. */
    resolveAssetUrl(assetId: string): Promise<string>;
    /** Lets go of an asset's copy once it has been read, so it does not stay in memory for the rest of the game. */
    releaseAssetUrl(assetId: string): void;
    dispose(): void;
}

const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
    return response.json();
};

const isManifest = (value: unknown): value is GamePackManifest => {
    const manifest = value as Partial<GamePackManifest> | null;
    return !!manifest && manifest.format === GAME_PACK_FORMAT && manifest.schema === 1
        && typeof manifest.gameId === 'string' && typeof manifest.startupLevelId === 'string'
        && Array.isArray(manifest.domains) && Array.isArray(manifest.assets);
};

/**
 * The prepared asset of each source asset, for a game this device can use them in. A pack of an
 * unknown version, or with BC textures on a GPU that cannot sample them, loads its sources.
 */
export const usablePreparedModels = (manifest: GamePackManifest, blockCompression: { colour: boolean; normal: boolean }): ReadonlyMap<string, string> => {
    const prepared = manifest.prepared;
    const usable = new Map<string, string>();
    if (prepared?.version !== PREPARED_MODEL_VERSION || !Array.isArray(prepared.models)) return usable;
    const textures = prepared.textures === 'none' || (prepared.textures === 'bc' && blockCompression.colour && blockCompression.normal);
    if (!textures) return usable;
    const held = new Set(manifest.assets.map(asset => asset.id));
    for (const model of prepared.models) if (held.has(model?.asset)) usable.set(model.source, model.asset);
    return usable;
};

export const loadGamePack = async (baseUrl: string, signal?: AbortSignal): Promise<GamePackSource> => {
    const root = new URL('game/', baseUrl);
    const manifest = await fetchJson(new URL('game.json', root).href, signal);
    if (!isManifest(manifest)) throw new Error('game/game.json is not an Auvra game pack');

    const domains: Record<string, unknown[]> = {};
    await Promise.all(manifest.domains.map(async domain => {
        const content = await fetchJson(new URL(`content/${encodeURIComponent(domain)}.json`, root).href, signal) as { documents?: unknown[] };
        domains[domain] = Array.isArray(content.documents) ? content.documents : [];
    }));

    const assets = new Map(manifest.assets.map(asset => [asset.id, asset]));
    const urls = new Map<string, Promise<string>>();
    const created: string[] = [];

    const resolveAssetUrl = (assetId: string): Promise<string> => {
        const cached = urls.get(assetId);
        if (cached) return cached;
        const asset = assets.get(assetId);
        if (!asset) return Promise.reject(new Error(`Asset ${assetId} is not in this game pack`));
        const pending = (async () => {
            const response = await fetch(new URL(`assets/${asset.file}`, root).href, { signal });
            if (!response.ok) throw new Error(`Could not load asset ${asset.file} (${response.status})`);
            const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: asset.mime }));
            created.push(url);
            return url;
        })();
        urls.set(assetId, pending);
        pending.catch(() => urls.delete(assetId));
        return pending;
    };

    const releaseAssetUrl = (assetId: string): void => {
        const pending = urls.get(assetId);
        if (!pending) return;
        urls.delete(assetId);
        void pending.then(url => {
            URL.revokeObjectURL(url);
            created.splice(created.indexOf(url), 1);
        }, () => undefined);
    };

    return {
        manifest,
        domains,
        resolveAssetUrl,
        releaseAssetUrl,
        dispose: () => created.splice(0).forEach(url => URL.revokeObjectURL(url)),
    };
};
