import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { LevelObject } from '../types';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { collectNavGeometry, navGeometrySignature, type NavGeometryOptions } from './navGeometry';
import { resolveNavSettings } from './navSettings';
import { LevelNavMesh, recastReady, type NavBakeInput } from './navMesh';
import type { BakeResponse } from '../workers/navBake.worker';

/**
 * NAVIGATION
 *
 * Each level gets a navmesh (runtime/navMesh.ts) baked from its static shapes
 * (runtime/navGeometry.ts) when play starts, in a worker, and baked again when something it is
 * baked from changes. Agents under NavMeshContext plan paths over it and keep to it.
 */

export { advanceWaypoint, LevelNavMesh, type FindPathOptions, type NavPathResult, type NavPoint } from './navMesh';
export { DEFAULT_NAV_SETTINGS, resolveNavSettings, type NavSettings } from './navSettings';

/** The level's navmesh for AI under it; null (still baking, or none) keeps straight-line steering. */
export const NavMeshContext = createContext<LevelNavMesh | null>(null);

export const useNavMeshContext = (): LevelNavMesh | null => useContext(NavMeshContext);

/** Shortest time between re-bakes while baked objects keep changing (a script moving a platform every frame, bursts of spawns). */
export const NAV_REBAKE_INTERVAL_MS = 500;

let worker: Worker | null = null;
let nextBake = 1;
const pending = new Map<number, { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>();

/** Bakes in the shared worker, or in this thread where there are no workers. */
const bakeData = async (input: NavBakeInput): Promise<Uint8Array> => {
    if (typeof Worker === 'undefined') {
        const { bakeNavMeshData } = await import('./navMesh');
        await recastReady();
        return bakeNavMeshData(input);
    }
    if (!worker) {
        worker = new Worker(new URL('../workers/navBake.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<BakeResponse>) => {
            const job = pending.get(event.data.id);
            if (!job) return;
            pending.delete(event.data.id);
            if ('error' in event.data) job.reject(new Error(event.data.error));
            else job.resolve(event.data.data);
        };
    }
    const id = nextBake++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Copies, so the caller's geometry survives; the worker's own copy is transferred back as the result.
        worker!.postMessage({ id, input });
    });
};

/** Bakes the navmesh for these level objects (geometry gathered here, baked in a worker). */
export const bakeLevelNavMesh = async (levelObjects: readonly LevelObject[], options: NavGeometryOptions = {}): Promise<LevelNavMesh> => {
    const settings = resolveNavSettings(options.settings);
    const geometry = collectNavGeometry(levelObjects, options);
    const input: NavBakeInput = { positions: geometry.positions, indices: geometry.indices, links: geometry.links, settings };
    const data = await bakeData(input);
    await recastReady();
    return LevelNavMesh.fromData(data, input, geometry.groundHeight);
};

interface BakedNavMesh {
    key: string | null;
    shapeGeometry: NavGeometryOptions['shapeGeometry'];
    splineGeometry: NavGeometryOptions['splineGeometry'];
    propRadius: NavGeometryOptions['propRadius'];
    navMesh: LevelNavMesh | null;
}

/**
 * The navmesh for these level objects, baked when they first arrive and again when something it
 * is baked from changes, at most once every NAV_REBAKE_INTERVAL_MS. Until a bake finishes, agents
 * keep the previous navmesh (and their paths); null until the first one is ready.
 */
export function useLevelNavMesh(levelObjects: readonly LevelObject[] | null | undefined, options?: NavGeometryOptions): LevelNavMesh | null {
    // levelObjects/options are keyed by signature and settings, so identity churn alone does not re-bake.
    const key = levelObjects ? `${navGeometrySignature(levelObjects)}#${JSON.stringify(resolveNavSettings(options?.settings))}` : null;
    const shapeGeometry = options?.shapeGeometry;
    const splineGeometry = options?.splineGeometry;
    const propRadius = options?.propRadius;
    const latest = useRef({ levelObjects, options });
    useEffect(() => {
        latest.current = { levelObjects, options };
    });
    const [baked, setBaked] = useState<BakedNavMesh>({ key: null, shapeGeometry: undefined, splineGeometry: undefined, propRadius: undefined, navMesh: null });
    const lastBakeStart = useRef(-Infinity);
    // Bakes are numbered as they start; one that finishes after a newer one is thrown away.
    const bakes = useRef({ started: 0, applied: 0, mounted: true });
    useEffect(() => {
        bakes.current.mounted = true;
        return () => {
            bakes.current.mounted = false;
        };
    }, []);
    const stale = baked.key !== key || baked.shapeGeometry !== shapeGeometry || baked.splineGeometry !== splineGeometry || baked.propRadius !== propRadius;

    useEffect(() => {
        if (!stale || key === null) return undefined;
        const timer = setTimeout(() => {
            const current = latest.current;
            if (!current.levelObjects) return;
            lastBakeStart.current = Date.now();
            const bake = ++bakes.current.started;
            // A bake that finishes after the level changed again still replaces an older navmesh; the
            // change then bakes once more (the key differs, so this effect runs again).
            bakeLevelNavMesh(current.levelObjects, current.options).then((navMesh) => {
                if (!bakes.current.mounted || bake < bakes.current.applied) {
                    navMesh.dispose();
                    return;
                }
                bakes.current.applied = bake;
                setBaked({ key, shapeGeometry, splineGeometry, propRadius, navMesh });
            }, (error: unknown) => {
                frontendDiagnostics.failure('navmesh_bake_failed', error);
                // Keep the previous navmesh; this key is marked done so it is not retried every render.
                if (bakes.current.mounted && bake >= bakes.current.applied) setBaked(previous => ({ ...previous, key, shapeGeometry, splineGeometry, propRadius }));
            });
        }, Math.max(0, lastBakeStart.current + NAV_REBAKE_INTERVAL_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [stale, key, shapeGeometry, splineGeometry, propRadius]);

    // A replaced navmesh is freed once nothing renders with it.
    const navMesh = baked.navMesh;
    useEffect(() => () => navMesh?.dispose(), [navMesh]);
    return key === null ? null : navMesh;
}
