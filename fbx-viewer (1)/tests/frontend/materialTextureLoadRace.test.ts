import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { materialLibrary } from '../../runtime/materials/materialLibrary';

const TEXTURE_ID = 'texture-race';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
};

const pairOfLoads = () => {
    const old = deferred<THREE.Texture>();
    const fresh = deferred<THREE.Texture>();
    const requests = [old.promise, fresh.promise];
    const urls: string[] = [];
    materialLibrary.setTextureSource(() => 'blob:texture', (url) => {
        urls.push(url);
        const pending = requests.shift();
        if (!pending) throw new Error('unexpected texture load');
        return pending;
    });
    return { old, fresh, urls };
};

afterEach(() => {
    materialLibrary.setTextureSource(() => undefined, async () => new THREE.Texture());
    materialLibrary.replaceAll([]);
});

describe('material texture loads', () => {
    it('disposes an old completion without replacing a newer cached texture', async () => {
        const { old, fresh } = pairOfLoads();
        const lookup = materialLibrary.textureLookup();
        const loadedBefore = materialLibrary.texturesLoaded;

        const oldDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        materialLibrary.reloadTexture(TEXTURE_ID);
        const freshDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);

        const current = new THREE.Texture();
        fresh.resolve(current);
        await freshDone;
        expect(lookup(TEXTURE_ID, 'map')).toBe(current);

        const stale = new THREE.Texture();
        const disposeStale = vi.spyOn(stale, 'dispose');
        old.resolve(stale);
        await oldDone;
        expect(disposeStale).toHaveBeenCalledOnce();
        expect(lookup(TEXTURE_ID, 'map')).toBe(current);
        expect(materialLibrary.texturesLoaded - loadedBefore).toBe(1);
    });

    it('keeps the new readiness promise when the old request finishes first', async () => {
        const { old, fresh } = pairOfLoads();
        const oldDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        materialLibrary.reloadTexture(TEXTURE_ID);
        const freshDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        expect(freshDone).not.toBe(oldDone);

        let latestSettled = false;
        void freshDone.then(() => { latestSettled = true; });
        const stale = new THREE.Texture();
        const disposeStale = vi.spyOn(stale, 'dispose');
        old.resolve(stale);
        await oldDone;
        expect(disposeStale).toHaveBeenCalledOnce();
        expect(latestSettled).toBe(false);
        expect(materialLibrary.preloadTexture(TEXTURE_ID, 'map', true)).toBe(freshDone);

        const current = new THREE.Texture();
        fresh.resolve(current);
        await freshDone;
        expect(latestSettled).toBe(true);
        expect(materialLibrary.textureLookup()(TEXTURE_ID, 'map')).toBe(current);
    });

    it('does not let a failed obsolete load drop the current request', async () => {
        const { old, fresh } = pairOfLoads();
        const oldDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        materialLibrary.releaseTexture(TEXTURE_ID);
        const freshDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);

        old.reject(new Error('old texture missing'));
        await oldDone;
        expect(materialLibrary.preloadTexture(TEXTURE_ID, 'map', true)).toBe(freshDone);

        const current = new THREE.Texture();
        fresh.resolve(current);
        await freshDone;
        expect(materialLibrary.textureLookup()(TEXTURE_ID, 'map')).toBe(current);
    });

    it('ignores an outstanding load after the texture source and project switch', async () => {
        const stale = deferred<THREE.Texture>();
        const current = deferred<THREE.Texture>();
        const urls: string[] = [];
        materialLibrary.setTextureSource(() => 'blob:project-a', (url) => {
            urls.push(url);
            return stale.promise;
        });
        const staleDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);

        materialLibrary.setTextureSource(() => 'blob:project-b', (url) => {
            urls.push(url);
            return current.promise;
        });
        materialLibrary.replaceAll([]);
        const currentDone = materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        expect(urls).toEqual(['blob:project-a', 'blob:project-b']);

        const oldTexture = new THREE.Texture();
        const disposeStale = vi.spyOn(oldTexture, 'dispose');
        stale.resolve(oldTexture);
        await staleDone;
        expect(disposeStale).toHaveBeenCalledOnce();
        expect(materialLibrary.preloadTexture(TEXTURE_ID, 'map', true)).toBe(currentDone);

        const newTexture = new THREE.Texture();
        current.resolve(newTexture);
        await currentDone;
        expect(materialLibrary.textureLookup()(TEXTURE_ID, 'map')).toBe(newTexture);
    });

    it('drops already cached pixels when their source changes', async () => {
        const first = new THREE.Texture();
        const firstDisposed = vi.spyOn(first, 'dispose');
        const second = new THREE.Texture();
        materialLibrary.setTextureSource(() => 'blob:old', async () => first);
        await materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        expect(materialLibrary.textureLookup()(TEXTURE_ID, 'map')).toBe(first);

        materialLibrary.setTextureSource(() => 'blob:new', async () => second);
        expect(firstDisposed).toHaveBeenCalledOnce();
        await materialLibrary.preloadTexture(TEXTURE_ID, 'map', true);
        expect(materialLibrary.textureLookup()(TEXTURE_ID, 'map')).toBe(second);
    });
});
