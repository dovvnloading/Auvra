import { WORLD_GRID_COMPONENT_TYPE, WORLD_GRID_DEFAULTS } from '../worldGrid';
import type { ComponentDefinition } from './types';

/** The level reads this component's settings itself; nothing about it draws. */
const WorldGridRender = () => null;

export const WORLD_GRID_COMPONENT: ComponentDefinition = {
    type: WORLD_GRID_COMPONENT_TYPE,
    label: 'World Grid',
    description: 'Splits this level into square cells and keeps only those near the camera in the game. Props and foliage with no components, parents or children belong to the cell they stand in; in a built game their models load as their cell comes near.',
    props: [
        { key: 'cellSize', label: 'Cell size (m)', type: 'number', default: WORLD_GRID_DEFAULTS.cellSize, min: 4, max: 4096, step: 4 },
        { key: 'loadDistance', label: 'Load distance (m)', type: 'number', default: WORLD_GRID_DEFAULTS.loadDistance, min: 0, max: 100000, step: 10 },
        { key: 'unloadDistance', label: 'Unload distance (m)', type: 'number', default: WORLD_GRID_DEFAULTS.unloadDistance, min: 1, max: 100000, step: 10 },
    ],
    Render: WorldGridRender,
};
