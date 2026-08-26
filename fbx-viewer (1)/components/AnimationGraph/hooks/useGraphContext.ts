
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useScene } from '../../../context/SceneContext';
import { AnimationGraphData, LoadedModelData, Blueprint } from '../../../types';

export type ContextType = 'model' | 'blueprint';

export interface GraphContextState {
    contextType: ContextType;
    setContextType: (type: ContextType) => void;
    selectedContextId: string | null;
    setSelectedContextId: (id: string | null) => void;
    currentGraph: AnimationGraphData;
    previewModel: LoadedModelData | undefined;
    handleUpdateGraph: (idIgnored: string, partialData: Partial<AnimationGraphData>) => void;
    allSceneClips: { name: string; source: string; clip: any }[];
    contextOptions: { label: string; value: string }[];
}

export const useGraphContext = (): GraphContextState => {
    const { 
        models, 
        selectedModelId, 
        graphData, 
        updateGraph, 
        blueprints, 
        updateBlueprint, 
        selectedBlueprintId 
    } = useScene();

    const [contextType, setContextType] = useState<ContextType>('model');
    const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
    const [hasInitialized, setHasInitialized] = useState(false);

    // --- 1. Smart Initialization ---
    // Runs when data becomes available to sync with global app state.
    useEffect(() => {
        if (hasInitialized) return;

        // If data isn't loaded yet, wait.
        if (models.length === 0 && blueprints.length === 0) return;

        setHasInitialized(true);

        // Priority A: Sync with Global Selection (Scene Tab)
        if (selectedModelId && models.some(m => m.id === selectedModelId)) {
            setContextType('model');
            setSelectedContextId(selectedModelId);
            return;
        }
        
        if (selectedBlueprintId && blueprints.some(bp => bp.id === selectedBlueprintId)) {
            setContextType('blueprint');
            setSelectedContextId(selectedBlueprintId);
            return;
        }

        // Priority B: Default Fallbacks
        if (models.length > 0) {
            setContextType('model');
            setSelectedContextId(models[0].id);
        } else if (blueprints.length > 0) {
            setContextType('blueprint');
            setSelectedContextId(blueprints[0].id);
        }
    }, [models, blueprints, selectedModelId, selectedBlueprintId, hasInitialized]);

    // --- 2. Robust Auto-Selection ---
    // Handles cases where selection is deleted or context needs to switch automatically.
    useEffect(() => {
        // Only run if we have passed the initial data wait
        if (!hasInitialized) return;

        if (!selectedContextId) {
            // Attempt to select within current context type
            if (contextType === 'model') {
                if (models.length > 0) {
                    setSelectedContextId(models[0].id);
                } else if (blueprints.length > 0) {
                    // Fallback to blueprints if models are empty
                    setContextType('blueprint');
                    setSelectedContextId(blueprints[0].id);
                }
            } else { // contextType === 'blueprint'
                if (blueprints.length > 0) {
                    setSelectedContextId(blueprints[0].id);
                } else if (models.length > 0) {
                    // Fallback to models if blueprints are empty
                    setContextType('model');
                    setSelectedContextId(models[0].id);
                }
            }
        } else {
            // Verify current selection still exists (e.g. if item was deleted)
            const exists = contextType === 'model' 
                ? models.some(m => m.id === selectedContextId)
                : blueprints.some(bp => bp.id === selectedContextId);
            
            if (!exists) {
                setSelectedContextId(null); // Triggers re-run to find new default
            }
        }
    }, [contextType, selectedContextId, models, blueprints, hasInitialized]);

    // 1. Derive Current Graph Data
    const currentGraph: AnimationGraphData = useMemo(() => {
        const emptyGraph: AnimationGraphData = { variables: [], inputs: [], states: [], transitions: [], activeStateId: null };

        if (contextType === 'model' && selectedContextId) {
            return graphData[selectedContextId] || emptyGraph;
        } else if (contextType === 'blueprint' && selectedContextId) {
            const bp = blueprints.find(b => b.id === selectedContextId);
            return bp ? bp.animationGraph : emptyGraph;
        }
        return emptyGraph;
    }, [contextType, selectedContextId, graphData, blueprints]);

    // 2. Derive Preview Model
    const previewModel = useMemo(() => {
        if (contextType === 'model') {
            return models.find(m => m.id === selectedContextId);
        } else if (contextType === 'blueprint') {
            const bp = blueprints.find(b => b.id === selectedContextId);
            if (bp && bp.linkedModelId) {
                return models.find(m => m.id === bp.linkedModelId);
            }
        }
        return undefined;
    }, [contextType, selectedContextId, models, blueprints]);

    // 3. Unified Update Handler
    const handleUpdateGraph = useCallback((_idIgnored: string, partialData: Partial<AnimationGraphData>) => {
        if (!selectedContextId) return;

        if (contextType === 'model') {
            updateGraph(selectedContextId, partialData);
        } else {
            const bp = blueprints.find(b => b.id === selectedContextId);
            if (bp) {
                updateBlueprint(selectedContextId, { animationGraph: { ...bp.animationGraph, ...partialData } });
            }
        }
    }, [contextType, selectedContextId, updateGraph, blueprints, updateBlueprint]);

    // 4. Aggregate Animations
    const allSceneClips = useMemo(() => {
        return models.flatMap(m => 
            (m.animations || []).map(clip => ({
                name: clip.name,
                source: m.name,
                clip: clip
            }))
        );
    }, [models]);

    // 5. Options for Dropdown
    const contextOptions = useMemo(() => {
        return contextType === 'model' 
        ? (models.length === 0 
            ? [{ label: 'No Models', value: '' }] 
            : models.map(m => ({ label: m.name, value: m.id })))
        : (blueprints.length === 0
            ? [{ label: 'No Blueprints', value: '' }]
            : blueprints.map(bp => ({ label: `${bp.name} (${bp.type})`, value: bp.id })));
    }, [contextType, models, blueprints]);

    return {
        contextType,
        setContextType,
        selectedContextId,
        setSelectedContextId,
        currentGraph,
        previewModel,
        handleUpdateGraph,
        allSceneClips,
        contextOptions
    };
};
