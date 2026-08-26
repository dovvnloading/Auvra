
import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { SceneContextType } from '../types';
import { useNotification } from './NotificationContext';
import { dbOperations } from '../utils/db';
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

    // --- Scene Reset (SPA-Friendly) ---
    const resetScene = useCallback(async () => {
        setIsLoading(true);
        try {
            console.log("[SceneContext] Resetting scene...");

            // 1. Dispose Three.js Resources
            assets.models.forEach(m => disposeModel(m));
            assets.attachments.forEach(a => {
                if (a.url) URL.revokeObjectURL(a.url);
                disposeObject(a.object);
            });
            assets.textures.forEach(t => URL.revokeObjectURL(t.url));
            assets.audioAssets.forEach(a => URL.revokeObjectURL(a.url));

            // 2. Clear Database
            await dbOperations.clearDatabase();

            // 3. Reset State in Contexts
            assets.setModels([]);
            assets.setAttachments([]);
            assets.setSockets([]);
            assets.setTextures([]);
            assets.setAudioAssets([]);
            assets.setBlueprints(DEFAULT_BLUEPRINTS);
            assets.resetGraphs(); 
            level.setLevelObjects([]); 

            // 4. Reset UI State
            selection.selectModel(null);
            selection.selectBlueprint(null);
            viewport.setCameraState({ position: [4, 4, 8], target: [0, 1, 0] });

            addNotification({ message: "New Project Started.", type: 'success' });
            
            // Re-init default level implicitly via hook mount or manual reload if needed
            window.location.reload(); 

        } catch(e) {
            console.error("Error resetting scene:", e);
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
        setLevelObjects: level.setLevelObjects,
        setSelectedModelId: selection.selectModel,
        setIsLoading,
        defaultBlueprints: DEFAULT_BLUEPRINTS
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
        resetScene
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
        loadProject: projectManager.loadProject,
        createNewProject: projectManager.createNewProject,
    };

    return (
        <SceneContext.Provider value={value}>
            {children}
        </SceneContext.Provider>
    );
};

// Root Provider
export const SceneProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [isLoading, setIsLoading] = useState(false);

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
