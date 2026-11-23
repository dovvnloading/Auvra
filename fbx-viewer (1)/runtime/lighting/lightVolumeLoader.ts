import { frontendDiagnostics } from '../../diagnostics/runtime';
import { decodeLightVolume, SH_FLOATS_PER_PROBE, type BakedProbeVolume } from './bakedLighting';

/**
 * Reads baked light volumes (see bakedLighting.ts) from wherever the game's assets are: the open
 * project in the editor, the game pack in a build. Each asset is read once and kept for the few
 * levels a session moves between.
 */

type UrlResolver = (assetId: string) => Promise<string>;

let resolveUrl: UrlResolver | null = null;
let releaseUrl: ((assetId: string) => void) | null = null;
let sourceGeneration = 0;
type CachedVolume = { pending: Promise<Float32Array>; counts: readonly number[] | null };
const cache = new Map<string, CachedVolume>();
/** Volumes kept after their level is left. */
const CACHE_LIMIT = 6;

/** Where volume assets are read from; set when a project or game pack loads. */
export const setLightVolumeSource = (resolve: UrlResolver | null, release?: (assetId: string) => void): void => {
    resolveUrl = resolve;
    releaseUrl = release ?? null;
    sourceGeneration++;
    cache.clear();
};

const keep = (assetId: string, pending: Promise<Float32Array>, counts: readonly number[] | null = null): void => {
    cache.delete(assetId);
    cache.set(assetId, { pending, counts });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
};

/** Keeps a volume just baked, so showing it does not read it back. */
export const rememberLightVolume = (assetId: string, sh: Float32Array): void => keep(assetId, Promise.resolve(sh));

/** The probes of a stored volume; rejects when they cannot be read or do not match the level's record. */
export const loadLightVolume = async (probes: BakedProbeVolume): Promise<Float32Array> => {
    const cached = cache.get(probes.assetId);
    if (cached) {
        // A previously validated volume is only valid for the grid topology
        // that was decoded. Equal probe counts in a different order are not
        // interchangeable, even when the SH buffer length matches.
        if (cached.counts?.some((count, axis) => count !== probes.counts[axis])) {
            throw new Error('Light volume does not match its level');
        }
        const sh = await cached.pending;
        if (!cached.counts && sh.length !== probes.counts.reduce((product, count) => product * count, 1) * SH_FLOATS_PER_PROBE) {
            throw new Error('Light volume does not match its level');
        }
        return sh;
    }
    let pending: Promise<Float32Array>;
    const resolve = resolveUrl;
    const release = releaseUrl;
    const generation = sourceGeneration;
    pending = (async () => {
        if (!resolve) throw new Error('No project or game is loaded');
        // Keep resolution and release ownership together across project
        // switches, including failures after an asset URL was obtained.
        let acquired = false;
        try {
            const url = await resolve(probes.assetId);
            acquired = true;
            const response = await fetch(url, { method: 'GET' });
            if (!response.ok) throw new Error(`Light volume download failed (${response.status})`);
            const { counts, sh } = decodeLightVolume(await response.arrayBuffer());
            if (generation !== sourceGeneration) throw new Error('Light volume source changed during load');
            if (counts.some((count, axis) => count !== probes.counts[axis])) throw new Error('Light volume does not match its level');
            return sh;
        } finally {
            if (acquired) release?.(probes.assetId);
        }
    })();
    keep(probes.assetId, pending, probes.counts);
    pending.catch((error: unknown) => {
        if (cache.get(probes.assetId)?.pending === pending) cache.delete(probes.assetId);
        frontendDiagnostics.failure('light_volume_load_failed', error);
    });
    return pending;
};
