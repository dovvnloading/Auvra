

import type { FoliageToolSettings } from './Foliage/foliageSettings';
import type { TerrainToolSettings } from './Terrain/terrainTool';

export type InteractionMode = 'select' | 'place' | 'paint' | 'mask' | 'blueprint' | 'sculpt';
export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';
export type ViewportLayout = 'single' | 'quad';

export interface TransformSettings {
    tool: TransformTool;
    space: TransformSpace;
    snapEnabled: boolean;
    snapGrid: number;
    snapAngle: number;
}

export interface EditorState {
    interactionMode: InteractionMode;
    transformSettings: TransformSettings;
    foliageSettings: FoliageToolSettings;
    sculptSettings: TerrainToolSettings;
    selectedBrushId: string | null;
    selectedObjectId: string | null;
    isPlaying: boolean;
    /** Play started with "Play from here": the player starts under the editor camera, not at the Player Start. */
    playFromCamera: boolean;
    layout: ViewportLayout;
    cameraSpeed: number;
    isMuted: boolean;
    /** The level's navmesh is drawn over the scene. */
    showNavigation: boolean;
}
