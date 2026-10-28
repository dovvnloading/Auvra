import { useCallback, useMemo } from 'react';
import type * as THREE from 'three';
import type { LevelObject, LoadedModelData } from '../../../types';
import { useLevelNavMesh, type LevelNavMesh } from '../../../runtime/navigation';
import { modelTriangles } from '../../../runtime/navGeometry';
import type { HostGeometry } from '../../../runtime/components/physicsComponents';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_DOCUMENT_ID, normalizeGameSettings, type GameSettings } from '../../../runtime/types';
import { useNativeProjectDocument } from '../../../utils/useNativeProjectDocument';

interface GameSettingsDocument {
    id: string;
    settings: GameSettings;
}

// Module scoped so the document hook sees a stable factory.
const createDefaultGameSettingsDocument = (): GameSettingsDocument => ({ id: GAME_SETTINGS_DOCUMENT_ID, settings: DEFAULT_GAME_SETTINGS });

const modelTriangleCache = new WeakMap<THREE.Object3D, HostGeometry | null>();

/**
 * The navmesh play bakes for the level open in the editor, with the project's navigation settings;
 * null while `levelObjects` is null (Show navigation off) or the first bake runs. Edits re-bake it.
 */
export const useEditorNavMesh = (levelObjects: readonly LevelObject[] | null, models: readonly LoadedModelData[]): LevelNavMesh | null => {
    const { document } = useNativeProjectDocument<GameSettingsDocument>('metadata', GAME_SETTINGS_DOCUMENT_ID, createDefaultGameSettingsDocument);
    const navigation = useMemo(() => normalizeGameSettings(document.settings).navigation, [document]);
    const shapeGeometry = useCallback((object: LevelObject) => {
        const model = models.find(m => m.id === object.modelId);
        if (!model) return null;
        if (!modelTriangleCache.has(model.object)) modelTriangleCache.set(model.object, modelTriangles(model.object));
        return modelTriangleCache.get(model.object) ?? null;
    }, [models]);
    const options = useMemo(() => ({ settings: navigation, shapeGeometry }), [navigation, shapeGeometry]);
    return useLevelNavMesh(levelObjects, options);
};
