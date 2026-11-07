import { frontendDiagnostics } from '../../diagnostics/runtime';
import { createGraphCooker, deviceCanCook } from './graphCooker';
import { MaterialCookPlanner, type CookCache, type CookMode, type CookedPictures } from './materialCooking';
import { materialLibrary, type MaterialAsset } from './materialLibrary';
import { setTextureSettings } from '../../texturing/textureSettings';

/**
 * Switches cooked pictures on for the open project or built game, by its setting (materialCooking.ts): always, when
 * this device can, or never. Cooked sets are kept in the browser's own store under their signature, so the game's
 * next run loads them rather than cooking again.
 */

const DATABASE = 'auvra-cooked-pictures';
const STORE = 'sets';
/** Sets kept before the oldest go. */
const KEPT_SETS = 192;

/** The game's cache of cooked sets, in this browser's IndexedDB (nothing kept where there is none). */
export const indexedDbCookCache = (): CookCache | null => {
    if (typeof indexedDB === 'undefined') return null;
    let opened: Promise<IDBDatabase> | null = null;
    const database = () => {
        opened ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => { opened = null; reject(request.error); };
        });
        return opened;
    };
    const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
    return {
        get: async (key) => {
            const db = await database();
            return new Promise((resolve) => {
                const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                request.onsuccess = () => resolve((request.result as { pictures: CookedPictures } | undefined)?.pictures ?? null);
                request.onerror = () => resolve(null);
            });
        },
        put: async (key, pictures) => {
            const db = await database();
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE);
            store.put({ pictures, at: Date.now() }, key);
            // The oldest go once there are more than the cache keeps.
            const all = store.getAll();
            const keys = store.getAllKeys();
            all.onsuccess = () => {
                keys.onsuccess = () => {
                    const entries = (all.result as Array<{ at: number }>).map((entry, index) => ({ at: entry.at, key: keys.result[index] }));
                    entries.sort((a, b) => a.at - b.at).slice(0, Math.max(0, entries.length - KEPT_SETS)).forEach(entry => store.delete(entry.key));
                };
            };
            await done(transaction);
        },
    };
};

/** A graph's content for a cooked set's signature, with every graph it uses as a node. */
const graphContent = (asset: MaterialAsset): string => {
    const seen = new Set<string>();
    const parts: string[] = [];
    const visit = (from: MaterialAsset) => {
        const graph = (from.textureGraph as { graph?: unknown } | undefined)?.graph;
        parts.push(JSON.stringify(graph ?? null));
        const text = parts[parts.length - 1];
        for (const match of text.matchAll(/"graph":"([^"]+)"/g)) {
            const id = match[1];
            const used = seen.has(id) ? undefined : materialLibrary.get(id);
            seen.add(id);
            if (used) visit(used);
        }
    };
    visit(asset);
    return parts.join('|');
};

let planner: MaterialCookPlanner | null = null;

/** Turns cooking on or off for the open project or game, by its setting; returns whether it is on. */
export const setUpMaterialCooking = (mode: CookMode): boolean => {
    const on = mode === 'always' || (mode === 'capable' && deviceCanCook());
    if (!on) {
        planner = null;
        materialLibrary.setPictureSource(null);
        return false;
    }
    planner = new MaterialCookPlanner(
        materialLibrary,
        createGraphCooker({ material: (id) => materialLibrary.get(id), textureUrl: (id) => materialLibrary.textureUrl(id) }),
        indexedDbCookCache(),
        { content: graphContent, setSettings: setTextureSettings, onFailure: (error) => frontendDiagnostics.failure('material_cook_failed', error) },
    );
    materialLibrary.setPictureSource(planner);
    return true;
};

/** The planner cooking for the open project or game, when cooking is on. */
export const materialCookPlanner = (): MaterialCookPlanner | null => planner;
