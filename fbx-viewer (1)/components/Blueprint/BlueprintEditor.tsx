import React, { useMemo } from 'react';
import { FileCode } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { BlueprintListPanel } from './BlueprintListPanel';
import { BlueprintViewport } from './BlueprintViewport';
import { BlueprintInspectorPanel } from './BlueprintInspectorPanel';

interface BlueprintEditorProps {
    visible: boolean;
}

export const BlueprintEditor: React.FC<BlueprintEditorProps> = ({ visible }) => {
    const { 
        blueprints, 
        addBlueprint, 
        updateBlueprint, 
        removeBlueprint, 
        selectedBlueprintId, 
        selectBlueprint, 
        models 
    } = useScene();
    
    const selectedBlueprint = blueprints.find(bp => bp.id === selectedBlueprintId);
    
    // Derived state for linked model
    const linkedModel = useMemo(() => 
        models.find(m => m.id === selectedBlueprint?.linkedModelId), 
    [models, selectedBlueprint]);

    // Aggregate animations for the preview
    const allSceneClips = useMemo(() => {
        return models.flatMap(m => 
            (m.animations || []).map(clip => ({
                name: clip.name,
                source: m.name,
                clip: clip
            }))
        );
    }, [models]);

    // Memoize the array of raw clips to prevent mixer churn
    const rawClips = useMemo(() => allSceneClips.map(c => c.clip), [allSceneClips]);

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden">
            
            {/* LEFT: File Manager */}
            <BlueprintListPanel 
                blueprints={blueprints}
                selectedId={selectedBlueprintId}
                onSelect={selectBlueprint}
                onAdd={addBlueprint}
                onRemove={removeBlueprint}
            />

            {/* CENTER & RIGHT: Editor Content */}
            {selectedBlueprint ? (
                <div className="flex-1 flex min-w-0 bg-gray-900 relative">
                    
                    {/* CENTER: 3D View & Setup */}
                    <BlueprintViewport 
                        blueprint={selectedBlueprint}
                        linkedModel={linkedModel}
                        models={models}
                        allClips={rawClips}
                        onUpdate={updateBlueprint}
                        onRemove={removeBlueprint}
                        visible={visible}
                    />

                    {/* RIGHT: Properties */}
                    <BlueprintInspectorPanel 
                        blueprint={selectedBlueprint}
                        onUpdate={updateBlueprint}
                    />
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-500 bg-gray-950">
                    <div className="w-16 h-16 rounded-full bg-gray-900 flex items-center justify-center mb-4">
                            <FileCode size={32} className="opacity-50" />
                    </div>
                    <h2 className="text-lg font-bold text-gray-300">No Blueprint Selected</h2>
                    <p className="text-sm mt-2 max-w-xs text-center">Select a blueprint from the list on the left or create a new one to start editing your character.</p>
                </div>
            )}
        </div>
    );
};