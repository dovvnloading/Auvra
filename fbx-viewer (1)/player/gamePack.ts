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

// These bounds apply to decoded response bytes, not the (possibly compressed) Content-Length.
// The streamed-byte check below holds every response to its manifest size, so
// reservations of those sizes bound aggregate in-flight payloads, even if a server lies.
export const MAX_GAME_PACK_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_GAME_PACK_IN_FLIGHT_BYTES = 512 * 1024 * 1024;

const assetAbortError = (): DOMException => new DOMException('Game pack asset download cancelled', 'AbortError');

// Shared across GamePackSource instances. Queued downloads have not fetched or retained a body.
let reservedAssetBytes = 0;
const waitingAssetDownloads: { bytes: number; grant: () => void }[] = [];
const admitWaitingDownloads = () => {
    while (waitingAssetDownloads.length && reservedAssetBytes + waitingAssetDownloads[0].bytes <= MAX_GAME_PACK_IN_FLIGHT_BYTES) {
        waitingAssetDownloads.shift()?.grant();
    }
};
const acquireAssetDownload = (bytes: number, signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(assetAbortError()); return; }
    const release = () => {
        reservedAssetBytes -= bytes;
        // FIFO: once space is available, admit as many waiting assets as fit.
        admitWaitingDownloads();
    };
    const grant = () => {
        signal.removeEventListener('abort', onAbort);
        reservedAssetBytes += bytes;
        resolve(release);
    };
    const onAbort = () => {
        const index = waitingAssetDownloads.findIndex(waiter => waiter.grant === grant);
        if (index !== -1) {
            waitingAssetDownloads.splice(index, 1);
            admitWaitingDownloads();
        }
        signal.removeEventListener('abort', onAbort);
        reject(assetAbortError());
    };
    if (reservedAssetBytes + bytes <= MAX_GAME_PACK_IN_FLIGHT_BYTES && waitingAssetDownloads.length === 0) grant();
    else {
        waitingAssetDownloads.push({ bytes, grant });
        signal.addEventListener('abort', onAbort, { once: true });
    }
});

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
    const urls = new Map<string, { promise: Promise<string>; abort: () => void }>();
    const created = new Set<string>();
    let disposed = false;

    const resolveAssetUrl = (assetId: string): Promise<string> => {
        if (disposed) return Promise.reject(assetAbortError());
        const cached = urls.get(assetId);
        if (cached) return cached.promise;
        const asset = assets.get(assetId);
        if (!asset) return Promise.reject(new Error(`Asset ${assetId} is not in this game pack`));
        // The builder records the exact decoded byte length. Reject unusable declarations
        // before fetching or allocating any response data; do not trust HTTP headers alone.
        if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
            return Promise.reject(new Error(`Invalid game-pack asset size for ${asset.file}`));
        }
        if (asset.size > MAX_GAME_PACK_ASSET_BYTES) {
            return Promise.reject(new Error(`Game-pack asset ${asset.file} exceeds the ${MAX_GAME_PACK_ASSET_BYTES}-byte limit`));
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) controller.abort();

        const pending = (async () => {
            let release: (() => void) | undefined;
            try {
                release = await acquireAssetDownload(asset.size, controller.signal);
                if (controller.signal.aborted) throw assetAbortError();
                const response = await fetch(new URL(`assets/${asset.file}`, root).href, { signal: controller.signal });
                if (!response.ok) throw new Error(`Could not load asset ${asset.file} (${response.status})`);
                const header = response.headers.get('Content-Length');
                if (header !== null && /^\d+$/.test(header.trim()) && Number(header) > MAX_GAME_PACK_ASSET_BYTES) {
                    throw new Error(`Game-pack asset ${asset.file} exceeds the ${MAX_GAME_PACK_ASSET_BYTES}-byte response limit`);
                }
                if (!response.body) throw new Error(`Game-pack asset ${asset.file} has no readable response body`);

                let received = 0;
                const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, stream) {
                        received += chunk.byteLength;
                        if (received > asset.size || received > MAX_GAME_PACK_ASSET_BYTES) {
                            throw new Error(`Game-pack asset ${asset.file} exceeds its declared size or download limit`);
                        }
                        stream.enqueue(chunk);
                    },
                }), { signal: controller.signal });
                // Response.blob() consumes the bounded stream directly. Unlike arrayBuffer() +
                // new Blob([buffer]), this never holds a full JS buffer alongside a Blob copy.
                const blob = await new Response(bounded).blob();
                if (controller.signal.aborted) throw assetAbortError();
                if (received !== asset.size) throw new Error(`Game-pack asset ${asset.file} size does not match its manifest`);
                // Blob.slice sets the manifest MIME without copying the asset into an ArrayBuffer.
                const url = URL.createObjectURL(blob.slice(0, blob.size, asset.mime));
                if (controller.signal.aborted || disposed) {
                    URL.revokeObjectURL(url);
                    throw assetAbortError();
                }
                created.add(url);
                return url;
            } catch (error) {
                // Also cancel responses rejected by Content-Length before a stream was read.
                controller.abort();
                throw error;
            } finally {
                release?.();
                signal?.removeEventListener('abort', onAbort);
            }
        })();
        const request = { promise: pending, abort: () => controller.abort() };
        urls.set(assetId, request);
        void pending.catch(() => {
            if (urls.get(assetId) === request) urls.delete(assetId);
        });
        return pending;
    };

    const releaseAssetUrl = (assetId: string): void => {
        const request = urls.get(assetId);
        if (!request) return;
        urls.delete(assetId);
        request.abort();
        void request.promise.then(url => {
            if (created.delete(url)) URL.revokeObjectURL(url);
        }, () => undefined);
    };

    return {
        manifest,
        domains,
        resolveAssetUrl,
        releaseAssetUrl,
        dispose: () => {
            disposed = true;
            for (const request of urls.values()) request.abort();
            urls.clear();
            for (const url of created) URL.revokeObjectURL(url);
            created.clear();
        },
    };
};
