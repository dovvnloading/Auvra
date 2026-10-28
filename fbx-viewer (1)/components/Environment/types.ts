

export type InteractionMode = 'select' | 'place' | 'paint' | 'mask' | 'blueprint' | 'sculpt';
export type PaintMode = 'add' | 'erase';
export type SculptTool = 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint';
export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';
export type ViewportLayout = 'single' | 'quad';

export interface PaintSettings {
    radius: number;
    density: number;
    scaleMin: number;
    scaleMax: number;
    rotationVariation: number;
    alignToNormal: boolean;
}

export interface SculptSettings {
    tool: SculptTool;
    radius: number;
    strength: number;
    flattenHeight: number;
    /** Texture layer (0-3) the paint tool blends in. */
    paintLayer?: number;
}

export interface TransformSettings {
    tool: TransformTool;
    space: TransformSpace;
    snapEnabled: boolean;
    snapGrid: number;
    snapAngle: number;
}

export interface EditorState {
    interactionMode: InteractionMode;
    paintMode: PaintMode;
    transformSettings: TransformSettings;
    paintSettings: PaintSettings;
    sculptSettings: SculptSettings;
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
