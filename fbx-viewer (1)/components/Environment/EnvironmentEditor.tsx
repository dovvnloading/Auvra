
import React, { useEffect, useSyncExternalStore } from 'react';
import { useScene } from '../../context/SceneContext';
import { EnvironmentSidebar } from './EnvironmentSidebar';
import { EnvironmentViewport } from './EnvironmentViewport';
import { LevelGameLoop } from './LevelGameLoop';
import { EnvironmentToolbar } from './layout/EnvironmentToolbar';
import { EnvironmentInspector } from './layout/EnvironmentInspector';
import { useEnvironmentState } from './hooks/useEnvironmentState';
import { useEnvironmentHotkeys } from './hooks/useEnvironmentHotkeys';
import { LevelBlueprintEditor } from '../LevelBlueprint/LevelBlueprintEditor';
import { editorSession } from '../../utils/editorSession';

export const EnvironmentEditor: React.FC = () => {
    const session = useSyncExternalStore(editorSession.subscribe, editorSession.getSnapshot, editorSession.getSnapshot);
    const sessionReady = session.phase === 'ready';
    const isReadyNow = () => editorSession.captureReady() !== null;
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
                if (!isReadyNow()) return;
                if(state.selectedObjectId) removeLevelObject(state.selectedObjectId);
                actions.setSelectedObjectId(null);
            },
            clearSelection: () => {
                if (!isReadyNow()) return;
                actions.setSelectedBrushId(null);
                actions.setSelectedObjectId(null);
                actions.setInteractionMode('select');
            },
            undo: () => { if (isReadyNow()) void undo(); },
            redo: () => { if (isReadyNow()) void redo(); },
            setInteractionMode: (mode) => { if (isReadyNow()) actions.setInteractionMode(mode); },
            updateTransformSettings: (updates) => { if (isReadyNow()) actions.updateTransformSettings(updates); },
        },
        history: {
            undo: () => { if (isReadyNow()) void undo(); },
            redo: () => { if (isReadyNow()) void redo(); },
        }
    });

    useEffect(() => {
        if (!sessionReady && state.isPlaying) actions.handlePlayStop();
    }, [actions, sessionReady, state.isPlaying]);

    const guardedUpdateLevelObject = (id: string, updates: Parameters<typeof updateLevelObject>[1]) => {
        if (isReadyNow()) updateLevelObject(id, updates);
    };
    const guardedRemoveLevelObject = (id: string) => {
        if (isReadyNow()) void removeLevelObject(id);
    };

    const activeBrush = models.find(m => m.id === state.selectedBrushId);
    const selectedObject = levelObjects.find(o => o.id === state.selectedObjectId);

    // --- Render Game Mode ---
    if (state.isPlaying && sessionReady) {
        return (
            <LevelGameLoop 
                onExit={actions.handlePlayStop} 
                spawnPosition={state.editorCameraPos.current}
            />
        );
    }

    // --- Render Editor Mode ---
    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden relative" aria-busy={!sessionReady}>
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
                    updateLevelObject: guardedUpdateLevelObject,
                    removeLevelObject: guardedRemoveLevelObject,
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
            {!sessionReady && (
                <div
                    className="absolute inset-0 z-[100] flex cursor-wait items-center justify-center bg-gray-950/60 text-sm text-gray-200"
                    role="status"
                    onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                >
                    {session.phase === 'transitioning' ? 'Switching World Editor session…' : 'Open a project to edit the world.'}
                </div>
            )}
        </div>
    );
};
