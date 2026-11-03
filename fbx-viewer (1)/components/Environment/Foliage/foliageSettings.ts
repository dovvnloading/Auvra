import { useSyncExternalStore } from 'react';

/**
 * FOLIAGE TOOL SETTINGS
 *
 * What the Foliage panel and the brush in the viewport share: which tool is up, the brush, what it paints
 * on, and the instances selected.
 */

export type FoliageToolName = 'select' | 'lasso' | 'paint' | 'erase' | 'reapply' | 'single' | 'fill';

export interface FoliageToolSettings {
  tool: FoliageToolName;
  /** World metres from the brush's centre to its edge. */
  radius: number;
  /** Multiplies every type's density while painting: 1 is each type's own. */
  paintDensity: number;
  /** The share of each type's density erasing leaves behind: 0 removes everything. */
  eraseDensity: number;
  onTerrain: boolean;
  onMeshes: boolean;
  onFoliage: boolean;
  onTranslucent: boolean;
}

export const DEFAULT_FOLIAGE_TOOL_SETTINGS: FoliageToolSettings = {
  tool: 'paint',
  radius: 8,
  paintDensity: 1,
  eraseDensity: 0,
  onTerrain: true,
  onMeshes: true,
  onFoliage: false,
  onTranslucent: true,
};

export type FoliageToolCommand =
  | { kind: 'select-all' }
  | { kind: 'deselect' }
  | { kind: 'select-invalid' }
  | { kind: 'remove-selected' };

export interface FoliageToolState {
  /** Selected instances, by type. */
  selection: ReadonlyMap<string, ReadonlySet<number>>;
  /** The palette entry whose settings the panel shows. */
  focusedTypeId: string | null;
}

const EMPTY_SELECTION: ReadonlyMap<string, ReadonlySet<number>> = new Map();

let state: FoliageToolState = { selection: EMPTY_SELECTION, focusedTypeId: null };
const listeners = new Set<() => void>();
let commandHandler: ((command: FoliageToolCommand) => void) | null = null;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const foliageToolStore = {
  get: (): FoliageToolState => state,
  set: (changes: Partial<FoliageToolState>): void => {
    state = { ...state, ...changes };
    listeners.forEach(listener => listener());
  },
  clearSelection: (): void => {
    if (state.selection.size > 0) foliageToolStore.set({ selection: EMPTY_SELECTION });
  },
  /** The tool in the viewport takes commands while it is mounted. */
  handleCommands: (handler: ((command: FoliageToolCommand) => void) | null): void => {
    commandHandler = handler;
  },
  command: (command: FoliageToolCommand): void => {
    commandHandler?.(command);
  },
};

export const useFoliageToolState = (): FoliageToolState => useSyncExternalStore(subscribe, foliageToolStore.get);

export const selectedInstanceCount = (selection: ReadonlyMap<string, ReadonlySet<number>>): number => {
  let total = 0;
  for (const ids of selection.values()) total += ids.size;
  return total;
};
