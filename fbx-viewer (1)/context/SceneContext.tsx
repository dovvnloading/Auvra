
import React, { createContext, useContext, useState, ReactNode, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { SceneContextType } from '../types';
import { useNotification } from './NotificationContext';
import { disposeModel, disposeObject } from '../utils/processing/ModelLifecycle';
import { DEFAULT_BLUEPRINTS } from '../data/blueprints';

// Sub-Contexts
import { ViewportProvider, useViewport } from './ViewportContext';
import { SelectionProvider, useSelection } from './SelectionContext';
import { AssetProvider, useAssets } from './AssetContext';
import { LevelProvider, useLevel } from './LevelContext';

// Logic
import { useScenePersistence } from '../hooks/useScenePersistence';
import { useProjectManager } from '../hooks/useProjectManager';
import { useOperationBusy } from './OperationContext';
import { frontendDiagnostics } from '../diagnostics/runtime';
import type { DetachedHydration } from '../hooks/useScenePersistence';

// Export granular hooks for high-performance consumption
export { useViewport, useSelection, useAssets, useLevel };

const SceneContext = createContext<SceneContextType | undefined>(undefined);

export const useScene = () => {
  const context = useContext(SceneContext);
  if (!context) {
    throw new Error('useScene must be used within a SceneProvider');
  }
  return context;
};

// Internal component that has access to all sub-providers to compose the legacy object
const SceneContextComposer: React.FC<{ children: ReactNode, isLoading: boolean, setIsLoading: (v: boolean) => void }> = ({ 
    children, isLoading, setIsLoading 
}) => {
    const { addNotification } = useNotification();
    
    // Consume Sub-Contexts
    const viewport = useViewport();
    const selection = useSelection();
    const assets = useAssets();
    const level = useLevel();

    const hydrationCommitRef = useRef({ assets, level, selection, viewport });
    hydrationCommitRef.current = { assets, level, selection, viewport };
    const publishedResourcesRef = useRef({
        models: assets.models,
        attachments: assets.attachments,
        textures: assets.textures,
        audioAssets: assets.audioAssets,
    });
    publishedResourcesRef.current = {
        models: assets.models,
        attachments: assets.attachments,
        textures: assets.textures,
        audioAssets: assets.audioAssets,
    };

    const commitHydration = useCallback((state: DetachedHydration) => {
        // Dispose the currently published project immediately before the one
        // explicit React commit. If hydration fails or goes stale this path is
        // never entered, so the old project remains fully usable.
        const previous = publishedResourcesRef.current;
        previous.models.forEach((model) => disposeModel(model));
        previous.attachments.forEach((attachment) => {
            if (attachment.url) URL.revokeObjectURL(attachment.url);
            disposeObject(attachment.object);
        });
        previous.textures.forEach((texture) => URL.revokeObjectURL(texture.url));
        previous.audioAssets.forEach((audio) => URL.revokeObjectURL(audio.url));
        publishedResourcesRef.current = {
            models: state.models,
            attachments: state.attachments,
            textures: state.textures,
            audioAssets: state.audioAssets,
        };
        const targets = hydrationCommitRef.current;
        flushSync(() => {
            targets.assets.setModels(state.models);
            targets.assets.setAttachments(state.attachments);
            targets.assets.setSockets(state.sockets);
            targets.assets.setBlueprints(state.blueprints);
            targets.assets.setTextures(state.textures);
            targets.assets.setAudioAssets(state.audioAssets);
            targets.level.hydrateProjectState(state.levels, state.levelObjects, state.currentLevelId);
            targets.assets.hydrateGraphs(state.graphs);
            targets.viewport.setCameraState(state.cameraState);
            if (state.selectedModelId) {
                targets.selection.selectModel(state.selectedModelId);
            } else if (state.selectedBlueprintId) {
                targets.selection.selectBlueprint(state.selectedBlueprintId);
            } else {
                targets.selection.selectModel(null);
                targets.selection.selectBlueprint(null);
            }
        });
    }, []);

    // --- Scene Reset (SPA-Friendly) ---
    const resetScene = useCallback(async () => {
        setIsLoading(true);
        try {
            // 1. Dispose Three.js Resources
            assets.models.forEach(m => disposeModel(m));
            assets.attachments.forEach(a => {
                if (a.url) URL.revokeObjectURL(a.url);
                disposeObject(a.object);
            });
            assets.textures.forEach(t => URL.revokeObjectURL(t.url));
            assets.audioAssets.forEach(a => URL.revokeObjectURL(a.url));

            // The native repository is authoritative. Reset only in-memory
            // editor state; legacy browser storage is a read-only migration
            // source and must never be cleared automatically.
            // 2. Reset State in Contexts
            assets.setModels([]);
            assets.setAttachments([]);
            assets.setSockets([]);
            assets.setTextures([]);
            assets.setAudioAssets([]);
            assets.setBlueprints(DEFAULT_BLUEPRINTS);
            assets.resetGraphs(); 
            level.hydrateProjectState([], [], null);

            // 3. Reset UI State
            selection.selectModel(null);
            selection.selectBlueprint(null);
            viewport.setCameraState({ position: [4, 4, 8], target: [0, 1, 0] });

        } catch(e) {
            frontendDiagnostics.failure('scene_reset_failed', e);
            addNotification({ message: "Failed to reset scene.", type: 'error' });
        } finally {
            setIsLoading(false);
        }
    }, [assets, level, selection, viewport, addNotification, setIsLoading]);

    // --- Persistence & System Operations ---
    const { restoreSession } = useScenePersistence({
        setModels: assets.setModels,
        setAttachments: assets.setAttachments,
        setSockets: assets.setSockets,
        setBlueprints: assets.setBlueprints,
        setTextures: assets.setTextures,
        setAudioAssets: assets.setAudioAssets,
        setCameraState: viewport.setCameraState,
        setSelectedModelId: selection.selectModel,
        setSelectedBlueprintId: selection.selectBlueprint,
        setIsLoading,
        defaultBlueprints: DEFAULT_BLUEPRINTS
        ,hydrateProjectState: level.hydrateProjectState
        ,hydrateGraphs: assets.hydrateGraphs
        ,getCurrentLevelId: level.getCurrentLevelId
        ,commitHydration
    });

    const projectManager = useProjectManager({
        setIsLoading,
        cameraState: viewport.cameraState,
        setCameraState: viewport.setCameraState,
        selectedModelId: selection.selectedModelId,
        selectedBlueprintId: selection.selectedBlueprintId,
        selectModel: selection.selectModel,
        selectBlueprint: selection.selectBlueprint,
        restoreSession,
        resetScene,
        getCurrentLevelId: level.getCurrentLevelId,
    });

    // --- Compose Unified Context ---
    const value: SceneContextType = {
        isLoading,
        
        // Viewport
        cameraState: viewport.cameraState,
        setCameraState: viewport.setCameraState,

        // Selection
        selectedModelId: selection.selectedModelId,
        selectedBlueprintId: selection.selectedBlueprintId,
        selectModel: selection.selectModel,
        selectBlueprint: selection.selectBlueprint,

        // Assets
        models: assets.models,
        addModel: assets.addModel,
        removeModel: assets.removeModel,
        placeInScene: assets.placeInScene,
        removeFromScene: assets.removeFromScene,
        addAnimations: assets.addAnimations,
        retextureModel: assets.retextureModel,
        previewTexture: assets.previewTexture,
        resetModelTexture: assets.resetModelTexture,
        
        attachments: assets.attachments,
        addAttachment: assets.addAttachment,
        addAttachmentFromLibrary: assets.addAttachmentFromLibrary,
        updateAttachment: assets.updateAttachment,
        removeAttachment: assets.removeAttachment,

        sockets: assets.sockets,
        addSocket: assets.addSocket,
        updateSocket: assets.updateSocket,
        removeSocket: assets.removeSocket,
        triggerSocketFlash: assets.triggerSocketFlash,
        flashTriggers: assets.flashTriggers,

        textures: assets.textures,
        addTexture: assets.addTexture,
        saveTextureToLibrary: assets.saveTextureToLibrary,
        removeTexture: assets.removeTexture,

        audioAssets: assets.audioAssets,
        addAudio: assets.addAudio,
        removeAudio: assets.removeAudio,

        blueprints: assets.blueprints,
        isCreatingPlayerBlueprint: assets.isCreatingPlayerBlueprint,
        addBlueprint: assets.addBlueprint,
        updateBlueprint: assets.updateBlueprint,
        removeBlueprint: assets.removeBlueprint,
        setBlueprints: assets.setBlueprints,

        graphData: assets.graphData,
        updateGraph: assets.updateGraph,
        resetGraphs: assets.resetGraphs,

        characterFireTriggers: assets.characterFireTriggers,
        triggerCharacterFire: assets.triggerCharacterFire,

        debugProjectile: assets.debugProjectile,
        triggerDebugProjectile: assets.triggerDebugProjectile,

        // Level
        levels: level.levels,
        currentLevelId: level.currentLevelId,
        levelObjects: level.levelObjects,
        createLevel: level.createLevel,
        loadLevel: level.loadLevel,
        deleteLevel: level.deleteLevel,
        addLevelObject: level.addLevelObject,
        removeLevelObject: level.removeLevelObject,
        removeLevelObjects: level.removeLevelObjects,
        updateLevelObject: level.updateLevelObject,
        activeLevelBlueprint: level.activeLevelBlueprint,
        updateLevelBlueprint: level.updateLevelBlueprint,
        undo: level.undo,
        redo: level.redo,
        canUndo: level.canUndo,
        canRedo: level.canRedo,
        snapshotHistory: level.snapshotHistory,

        // Project
        saveProject: projectManager.saveProject,
        saveProjectAs: projectManager.saveProjectAs,
        exportProject: projectManager.exportProject,
        importProject: projectManager.importProject,
        importLegacyProject: projectManager.importLegacyProject,
        migrateLegacyBrowserProject: projectManager.migrateLegacyBrowserProject,
        loadProject: projectManager.loadProject,
        openRecentProject: projectManager.openRecentProject,
        recoverProject: projectManager.recoverProject,
        closeProject: projectManager.closeProject,
        createNewProject: projectManager.createNewProject,
        projectStatus: projectManager.projectStatus,
    };

    return (
        <SceneContext.Provider value={value}>
            {children}
        </SceneContext.Provider>
    );
};

// Root Provider
export const SceneProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [localLoading, setIsLoading] = useState(false);
    const operationBusy = useOperationBusy();
    const isLoading = localLoading || operationBusy;

    return (
        <ViewportProvider>
            <SelectionProvider>
                <AssetProvider setIsLoading={setIsLoading}>
                    <LevelProvider>
                        <SceneContextComposer isLoading={isLoading} setIsLoading={setIsLoading}>
                            {children}
                        </SceneContextComposer>
                    </LevelProvider>
                </AssetProvider>
            </SelectionProvider>
        </ViewportProvider>
    );
};
