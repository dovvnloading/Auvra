import { useSyncExternalStore } from 'react';
import type { TerrainBrushFalloff, TerrainBrushShape } from './terrainBrush';
import type { TerrainClip, FlattenMode, MirrorOperation, NoiseMode, PasteMode } from './terrainSculptTools';

/**
 * TERRAIN TOOL SETTINGS
 *
 * What the Terrain panel and the brush in the viewport share: which tool is up, its settings, and the
 * few things a tool holds between clicks (a ramp's two ends, a copied clip).
 */

export type TerrainTab = 'manage' | 'sculpt' | 'paint';

export type SculptToolName = 'sculpt' | 'smooth' | 'flatten' | 'ramp' | 'erosion' | 'hydro' | 'noise' | 'terrace' | 'holes' | 'mirror' | 'copy';
export type PaintToolName = 'paint' | 'smooth' | 'flatten' | 'noise';

export interface TerrainToolSettings {
  tab: TerrainTab;
  tool: SculptToolName;
  paintTool: PaintToolName;
  /** World metres from the brush's centre to its edge. */
  radius: number;
  /** 0: full strength out to the edge. 1: fades from the very centre. */
  falloff: number;
  falloffType: TerrainBrushFalloff;
  /** 0-1. */
  strength: number;
  shape: TerrainBrushShape;
  /** The texture a stamp or pattern brush reads its strength from. */
  pictureTextureId?: string;
  pictureRotation: number;
  /** World metres one tile of a pattern brush covers. */
  patternSize: number;

  smoothKernel: number;

  flattenMode: FlattenMode;
  /** Level to `flattenHeight` rather than the height under the first click. */
  flattenUseHeight: boolean;
  /** World height. */
  flattenHeight: number;
  /** Level along the slope under the first click, not to a flat plane. */
  flattenAlongSlope: boolean;
  /** Take the height again every moment of the stroke, so it follows the ground. */
  flattenEachMoment: boolean;

  rampWidth: number;
  rampSideFalloff: number;

  erosionThreshold: number;
  erosionThickness: number;
  erosionIterations: number;

  hydroRain: number;
  hydroSediment: number;
  hydroIterations: number;

  noiseScale: number;
  noiseMode: NoiseMode;

  terraceHeight: number;
  terraceSharpness: number;

  mirrorOperation: MirrorOperation;
  mirrorOffset: number;
  mirrorBlend: number;

  pasteRotation: number;
  pasteMode: PasteMode;
  pasteEdge: number;
  /** Keep the clip's own height rather than sit it on the ground under the click. */
  pasteKeepHeight: boolean;

  /** Layer the paint tools work on. */
  paintLayer: number;
  /** The weight (0-1) painting moves a layer towards. */
  paintTarget: number;
  paintNoiseScale: number;
}

export const DEFAULT_TERRAIN_TOOL_SETTINGS: TerrainToolSettings = {
  tab: 'sculpt',
  tool: 'sculpt',
  paintTool: 'paint',
  radius: 8,
  falloff: 0.5,
  falloffType: 'smooth',
  strength: 0.3,
  shape: 'circle',
  pictureRotation: 0,
  patternSize: 16,

  smoothKernel: 3,

  flattenMode: 'both',
  flattenUseHeight: false,
  flattenHeight: 0,
  flattenAlongSlope: false,
  flattenEachMoment: false,

  rampWidth: 8,
  rampSideFalloff: 0.4,

  erosionThreshold: 0.15,
  erosionThickness: 0.15,
  erosionIterations: 6,

  hydroRain: 1,
  hydroSediment: 0.4,
  hydroIterations: 16,

  noiseScale: 12,
  noiseMode: 'both',

  terraceHeight: 4,
  terraceSharpness: 0.6,

  mirrorOperation: 'x-to-plus',
  mirrorOffset: 0,
  mirrorBlend: 4,

  pasteRotation: 0,
  pasteMode: 'both',
  pasteEdge: 0.15,
  pasteKeepHeight: false,

  paintLayer: 0,
  paintTarget: 1,
  paintNoiseScale: 8,
};

/** A world point a tool has marked. */
export interface TerrainToolPoint {
  x: number;
  y: number;
  z: number;
}

/** A ground rectangle picked for copying, in world metres. */
export interface TerrainRegion {
  terrainId: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface TerrainToolState {
  rampStart: TerrainToolPoint | null;
  rampEnd: TerrainToolPoint | null;
  region: TerrainRegion | null;
  clip: TerrainClip | null;
  /** What Paste does on a click: off until a clip is picked up. */
  pasting: boolean;
}

/** One-off actions the panel asks of the tool in the viewport, which holds the live terrains. */
export type TerrainToolCommand =
  | { kind: 'ramp' }
  | { kind: 'mirror'; terrainId: string }
  | { kind: 'copy' };

let state: TerrainToolState = { rampStart: null, rampEnd: null, region: null, clip: null, pasting: false };
const listeners = new Set<() => void>();
let commandHandler: ((command: TerrainToolCommand) => void) | null = null;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const terrainToolStore = {
  get: (): TerrainToolState => state,
  set: (changes: Partial<TerrainToolState>): void => {
    state = { ...state, ...changes };
    listeners.forEach(listener => listener());
  },
  /** The brush tool takes commands while it is mounted. */
  handleCommands: (handler: ((command: TerrainToolCommand) => void) | null): void => {
    commandHandler = handler;
  },
  command: (command: TerrainToolCommand): void => {
    commandHandler?.(command);
  },
};

export const useTerrainToolState = (): TerrainToolState => useSyncExternalStore(subscribe, terrainToolStore.get);

/** Plain names for the panel and the brush's hint line. */
export const SCULPT_TOOL_LABELS: Record<SculptToolName, string> = {
  sculpt: 'Sculpt',
  smooth: 'Smooth',
  flatten: 'Flatten',
  ramp: 'Ramp',
  erosion: 'Erosion',
  hydro: 'Hydro Erosion',
  noise: 'Noise',
  terrace: 'Terrace',
  holes: 'Holes',
  mirror: 'Mirror',
  copy: 'Copy / Paste',
};
