import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { InstancedLevelLayer } from '../components/Environment/InstancedLevelLayer';
import { frontendDiagnostics } from '../diagnostics/runtime';
import type { LevelObject, LoadedModelData } from '../types';
import type { GameContent } from './types';
import { nextActiveCells, partitionIntoCells, type WorldGridSettings } from './worldGrid';

/** The camera is checked against the cells this many frames apart. */
const CHECK_INTERVAL = 15;
const NO_CELLS: ReadonlySet<string> = new Set();
const _camera = new THREE.Vector3();

/**
 * Draws a level's static objects cell by cell, only the cells near the camera. A cell is one group
 * of instances, culled as a whole, so what is out of view costs nothing. Models a cell needs that
 * the level did not load up front are asked for when it comes near; until they arrive it draws
 * what it can.
 */
export const WorldGridLayer: React.FC<{
    settings: WorldGridSettings;
    foliage: readonly LevelObject[];
    props: readonly LevelObject[];
    models: LoadedModelData[];
    cellModels: GameContent['cellModels'];
    /** Where the game starts, so the first frame already has the cells around it. */
    start: readonly [number, number, number];
}> = ({ settings, foliage, props, models, cellModels, start }) => {
    const cells = useMemo(() => partitionIntoCells(foliage, props, settings.cellSize), [foliage, props, settings.cellSize]);
    const [active, setActive] = useState<ReadonlySet<string>>(() => nextActiveCells(cells, NO_CELLS, start[0], start[2], settings));
    const [fetched, setFetched] = useState<readonly LoadedModelData[]>([]);
    const frame = useRef(0);

    useFrame(({ camera }) => {
        if (frame.current++ % CHECK_INTERVAL !== 0) return;
        camera.getWorldPosition(_camera);
        const next = nextActiveCells(cells, active, _camera.x, _camera.z, settings);
        if (next !== active) setActive(next);
    });

    const allModels = useMemo(() => {
        if (!fetched.length) return models;
        const known = new Set(models.map(model => model.id));
        return [...models, ...fetched.filter(model => !known.has(model.id))];
    }, [models, fetched]);

    // The models the cells in play need, whether or not they are here yet.
    const wanted = useMemo(() => {
        const ids = new Set<string>();
        for (const key of active) cells.get(key)?.modelIds.forEach(id => ids.add(id));
        return ids;
    }, [active, cells]);

    // Asked for and not answered yet, and those that failed, which are not asked for again.
    const asked = useRef(new Set<string>());
    const failed = useRef(new Set<string>());
    const mounted = useRef(true);
    useEffect(() => {
        if (!cellModels) return;
        cellModels.setInUse(wanted);
        const present = new Set(allModels.map(model => model.id));
        for (const id of wanted) {
            if (present.has(id) || asked.current.has(id) || failed.current.has(id)) continue;
            asked.current.add(id);
            // One at a time, so a level ending or the camera moving on can cut in between them.
            cellModels.request([id]).then((loaded) => {
                asked.current.delete(id);
                if (mounted.current) setFetched(loaded);
            }, (error: unknown) => {
                asked.current.delete(id);
                failed.current.add(id);
                frontendDiagnostics.failure('world_grid_models_failed', error);
            });
        }
    }, [cellModels, allModels, wanted]);

    // The world's models stay out of the session's list, which is fixed: changing it mid-game would restart
    // every character's animation and bake the navmesh again. Nothing is in use once the level has gone.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            cellModels?.setInUse(new Set());
        };
    }, [cellModels]);

    return (
        <>
            {[...active].map((key) => {
                const cell = cells.get(key);
                if (!cell) return null;
                return (
                    <group key={key}>
                        {cell.foliage.length > 0 && <InstancedLevelLayer models={allModels} levelObjects={cell.foliage} interactive={false} />}
                        {cell.props.length > 0 && <InstancedLevelLayer models={allModels} levelObjects={cell.props} interactive={false} />}
                    </group>
                );
            })}
        </>
    );
};
