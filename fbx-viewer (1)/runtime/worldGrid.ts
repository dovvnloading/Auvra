import type { LevelComponent, LevelObject } from '../types';

/**
 * WORLD GRID
 *
 * Splits a big level into square cells. Objects that only stand there (props and foliage with no
 * components, parents or children) belong to the cell they stand in, and only the cells near the
 * camera exist in the running game. In a built game their models load as their cell comes near, so
 * a level can hold more than fits in memory. Everything else stays loaded the whole time.
 */

export const WORLD_GRID_COMPONENT_TYPE = 'worldGrid';

export interface WorldGridSettings {
    /** Side of a cell in metres. */
    cellSize: number;
    /** A cell whose nearest edge comes this close to the camera loads. */
    loadDistance: number;
    /** A loaded cell goes once its nearest edge is this far, so walking along a line does not load and unload it. */
    unloadDistance: number;
}

export const WORLD_GRID_DEFAULTS: WorldGridSettings = { cellSize: 64, loadDistance: 150, unloadDistance: 190 };

const MIN_CELL_SIZE = 4;
/** A cell stays this much past where it loads at the least. */
const MIN_UNLOAD_MARGIN = 1;

const finiteOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export const resolveWorldGridSettings = (component: Pick<LevelComponent, 'props'>): WorldGridSettings => {
    const cellSize = Math.max(MIN_CELL_SIZE, finiteOr(component.props.cellSize, WORLD_GRID_DEFAULTS.cellSize));
    const loadDistance = Math.max(0, finiteOr(component.props.loadDistance, WORLD_GRID_DEFAULTS.loadDistance));
    const unloadDistance = Math.max(loadDistance + MIN_UNLOAD_MARGIN, finiteOr(component.props.unloadDistance, WORLD_GRID_DEFAULTS.unloadDistance));
    return { cellSize, loadDistance, unloadDistance };
};

/** The grid of a level's first enabled World Grid component, or null when it has none. */
export const worldGridSettingsOf = (objects: readonly Pick<LevelObject, 'components'>[]): WorldGridSettings | null => {
    for (const object of objects) {
        const component = object.components?.find(entry => entry.type === WORLD_GRID_COMPONENT_TYPE && entry.enabled !== false);
        if (component) return resolveWorldGridSettings(component);
    }
    return null;
};

export interface WorldGridCell {
    key: string;
    /** Which cell it is along x and z: its square runs from index * cellSize to (index + 1) * cellSize. */
    x: number;
    z: number;
    foliage: LevelObject[];
    props: LevelObject[];
    modelIds: string[];
}

/** Sorts static objects into the cells they stand in, by their world positions. */
export const partitionIntoCells = (foliage: readonly LevelObject[], props: readonly LevelObject[], cellSize: number): Map<string, WorldGridCell> => {
    const cells = new Map<string, WorldGridCell>();
    const place = (object: LevelObject, into: 'foliage' | 'props') => {
        const x = Math.floor(object.position[0] / cellSize);
        const z = Math.floor(object.position[2] / cellSize);
        const key = `${x},${z}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = { key, x, z, foliage: [], props: [], modelIds: [] };
            cells.set(key, cell);
        }
        cell[into].push(object);
        if (object.modelId && !cell.modelIds.includes(object.modelId)) cell.modelIds.push(object.modelId);
    };
    foliage.forEach(object => place(object, 'foliage'));
    props.forEach(object => place(object, 'props'));
    return cells;
};

/** How far a point is from a cell's square along the ground; 0 inside it. */
export const distanceToCell = (cell: Pick<WorldGridCell, 'x' | 'z'>, x: number, z: number, cellSize: number): number => {
    const dx = Math.max(cell.x * cellSize - x, 0, x - (cell.x + 1) * cellSize);
    const dz = Math.max(cell.z * cellSize - z, 0, z - (cell.z + 1) * cellSize);
    return Math.hypot(dx, dz);
};

/** The cells that should be loaded for a camera at (x, z) given those that are; the same set when nothing changes. */
export const nextActiveCells = (
    cells: ReadonlyMap<string, WorldGridCell>,
    active: ReadonlySet<string>,
    x: number,
    z: number,
    settings: WorldGridSettings,
): ReadonlySet<string> => {
    const next = new Set<string>();
    for (const cell of cells.values()) {
        const distance = distanceToCell(cell, x, z, settings.cellSize);
        if (distance <= settings.loadDistance || (active.has(cell.key) && distance <= settings.unloadDistance)) next.add(cell.key);
    }
    if (next.size === active.size && [...next].every(key => active.has(key))) return active;
    return next;
};

/**
 * Objects whose models a level does not need up front, because the grid will ask for them when
 * their cell comes near. Stricter than what the running level treats as static, so an object drawn
 * any other way always has its model loaded already.
 */
export const objectsLeftToTheGrid = (objects: readonly LevelObject[], timelineTargets: ReadonlySet<string>): Set<LevelObject> => {
    const left = new Set<LevelObject>();
    if (!worldGridSettingsOf(objects)) return left;
    const parents = new Set(objects.map(object => object.parentId).filter(Boolean));
    for (const object of objects) {
        if (object.type !== 'prop' && object.type !== 'foliage') continue;
        if (object.components?.length || object.parentId || parents.has(object.id) || timelineTargets.has(object.id)) continue;
        left.add(object);
    }
    return left;
};
