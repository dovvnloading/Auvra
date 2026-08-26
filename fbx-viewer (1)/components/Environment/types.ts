
import * as THREE from 'three';

export type InteractionMode = 'select' | 'place' | 'paint' | 'mask' | 'blueprint' | 'sculpt';
export type PaintMode = 'add' | 'erase';
export type SculptTool = 'raise' | 'lower' | 'flatten' | 'smooth';
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
    layout: ViewportLayout;
    cameraSpeed: number;
    isMuted: boolean;
}
