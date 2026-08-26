
import React from 'react';
import { useScene } from '../../context/SceneContext';
import { EnvironmentSidebar } from './EnvironmentSidebar';
import { EnvironmentViewport } from './EnvironmentViewport';
import { LevelGameLoop } from './LevelGameLoop';
import { EnvironmentToolbar } from './layout/EnvironmentToolbar';
import { EnvironmentInspector } from './layout/EnvironmentInspector';
import { useEnvironmentState } from './hooks/useEnvironmentState';
import { useEnvironmentHotkeys } from './hooks/useEnvironmentHotkeys';
import { LevelBlueprintEditor } from '../LevelBlueprint/LevelBlueprintEditor';

export const EnvironmentEditor: React.FC = () => {
    const { 
        levelObjects, models, removeLevelObject, updateLevelObject, 
        undo, redo, canUndo, canRedo, snapshotHistory 
    } = useScene();
    
    // --- State Hook ---
    const { state, actions } = useEnvironmentState();

    // --- Hotkeys Hook ---
    useEnvironmentHotkeys({
        state,
        actions: {
            ...actions,
            deleteSelected: () => {
                if(state.selectedObjectId) removeLevelObject(state.selectedObjectId);
                actions.setSelectedObjectId(null);
            },
            clearSelection: () => {
                actions.setSelectedBrushId(null);
                actions.setSelectedObjectId(null);
                actions.setInteractionMode('select');
            },
            undo, redo
        },
        history: { undo, redo }
    });

    const activeBrush = models.find(m => m.id === state.selectedBrushId);
    const selectedObject = levelObjects.find(o => o.id === state.selectedObjectId);

    // --- Render Game Mode ---
    if (state.isPlaying) {
        return (
            <LevelGameLoop 
                onExit={actions.handlePlayStop} 
                spawnPosition={state.editorCameraPos.current}
            />
        );
    }

    // --- Render Editor Mode ---
    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden relative">
            <EnvironmentSidebar 
                selectedModelId={state.selectedBrushId} 
                onSelectModel={(id) => {
                    actions.setSelectedBrushId(id);
                    actions.setSelectedObjectId(null);
                    if (state.interactionMode === 'select') actions.setInteractionMode('place');
                }} 
                selectedObjectId={state.selectedObjectId}
                onSelectObject={(id) => {
                    actions.setSelectedObjectId(id);
                    actions.setSelectedBrushId(null);
                    actions.setInteractionMode('select');
                }}
            />

            <div className="flex-1 flex flex-col min-w-0 bg-[#111]">
                <EnvironmentToolbar 
                    state={state}
                    actions={actions}
                    history={{ undo, redo, canUndo, canRedo }}
                    hasActiveBrush={!!activeBrush}
                />

                <EnvironmentViewport 
                    activeModelId={state.selectedBrushId}
                    onSelectObject={actions.handleViewportSelect}
                    interactionMode={state.interactionMode === 'mask' ? 'select' : state.interactionMode} 
                    paintMode={state.paintMode}
                    transformSettings={state.transformSettings}
                    paintSettings={state.paintSettings}
                    sculptSettings={state.sculptSettings}
                    layout={state.layout}
                    cameraSpeed={state.cameraSpeed}
                    isMuted={state.isMuted}
                />
            </div>

            {/* Right Inspector Overlay */}
            <EnvironmentInspector 
                state={state}
                selectedObject={selectedObject}
                actions={{
                    setPaintMode: actions.setPaintMode,
                    setPaintSettings: actions.setPaintSettings,
                    setSelectedObjectId: actions.setSelectedObjectId,
                    updateLevelObject,
                    removeLevelObject,
                    setSculptSettings: actions.setSculptSettings
                }}
            />

            {/* Level Blueprint Overlay */}
            {state.interactionMode === 'blueprint' && (
                <LevelBlueprintEditor 
                    onClose={() => actions.setInteractionMode('select')} 
                    selectedObjectId={state.selectedObjectId}
                />
            )}
        </div>
    );
};
