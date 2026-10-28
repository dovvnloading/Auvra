import { frontendDiagnostics } from '../../diagnostics/runtime';
import { decodeLightVolume, type BakedProbeVolume } from './bakedLighting';

/**
 * Reads baked light volumes (see bakedLighting.ts) from wherever the game's assets are: the open
 * project in the editor, the game pack in a build. Each asset is read once and kept for the few
 * levels a session moves between.
 */

type UrlResolver = (assetId: string) => Promise<string>;

let resolveUrl: UrlResolver | null = null;
const cache = new Map<string, Promise<Float32Array>>();
/** Volumes kept after their level is left. */
const CACHE_LIMIT = 6;

/** Where volume assets are read from; set when a project or game pack loads. */
export const setLightVolumeSource = (resolve: UrlResolver | null): void => {
    resolveUrl = resolve;
    cache.clear();
};

const keep = (assetId: string, pending: Promise<Float32Array>): void => {
    cache.delete(assetId);
    cache.set(assetId, pending);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
};

/** Keeps a volume just baked, so showing it does not read it back. */
export const rememberLightVolume = (assetId: string, sh: Float32Array): void => keep(assetId, Promise.resolve(sh));

/** The probes of a stored volume; rejects when they cannot be read or do not match the level's record. */
export const loadLightVolume = async (probes: BakedProbeVolume): Promise<Float32Array> => {
    let pending = cache.get(probes.assetId);
    if (!pending) {
        const resolve = resolveUrl;
        pending = (async () => {
            if (!resolve) throw new Error('No project or game is loaded');
            const response = await fetch(await resolve(probes.assetId), { method: 'GET' });
            if (!response.ok) throw new Error(`Light volume download failed (${response.status})`);
            const { counts, sh } = decodeLightVolume(await response.arrayBuffer());
            if (counts.some((count, axis) => count !== probes.counts[axis])) throw new Error('Light volume does not match its level');
            return sh;
        })();
        keep(probes.assetId, pending);
        pending.catch((error: unknown) => {
            if (cache.get(probes.assetId) === pending) cache.delete(probes.assetId);
            frontendDiagnostics.failure('light_volume_load_failed', error);
        });
    }
    return pending;
};
