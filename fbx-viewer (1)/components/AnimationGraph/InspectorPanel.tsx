
import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { AnimationGraphData } from '../../types';
import { StateInspector } from './Inspectors/StateInspector';
import { TransitionInspector } from './Inspectors/TransitionInspector';

interface AvailableClipInfo {
    name: string;
    source: string;
    clip: any;
}

interface InspectorPanelProps {
    selectedNodeId: string | null;
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
    availableClips: AvailableClipInfo[];
    onDeleteState: (id: string) => void;
    onDeleteTransition: (id: string) => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
    selectedNodeId,
    graph,
    modelId,
    updateGraph,
    availableClips,
    onDeleteState,
    onDeleteTransition
}) => {
    const selectedNode = graph.states.find(s => s.id === selectedNodeId);
    const selectedTransition = graph.transitions.find(t => t.id === selectedNodeId);

    // Helpers to update specific parts of the state
    const updateState = (updates: any) => {
        if (!selectedNode) return;
        const updated = graph.states.map(s => s.id === selectedNode.id ? { ...s, ...updates } : s);
        updateGraph(modelId, { states: updated });
    };

    const updateTransition = (updates: any) => {
        if (!selectedTransition) return;
        const updated = graph.transitions.map(t => t.id === selectedTransition.id ? { ...t, ...updates } : t);
        updateGraph(modelId, { transitions: updated });
    };

    const clipOptions = [
        { label: '-- Select Animation --', value: '' },
        ...availableClips.map((item) => ({
            label: `${item.name} (${item.source})`,
            value: item.name
        }))
    ];

    const blendParamOptions = [
        { label: '-- None --', value: '' },
        ...graph.variables.filter(v => v.type === 'Float').map(v => ({ label: v.name, value: v.id }))
    ];

    return (
        <div className="flex-1 flex flex-col bg-gray-900 min-h-0">
             {selectedNode ? (
                <StateInspector 
                    node={selectedNode}
                    graph={graph}
                    updateState={updateState}
                    onDelete={onDeleteState}
                    clipOptions={clipOptions}
                    blendParamOptions={blendParamOptions}
                />
             ) : selectedTransition ? (
                <TransitionInspector 
                    transition={selectedTransition}
                    graph={graph}
                    updateTransition={updateTransition}
                    onDelete={onDeleteTransition}
                />
             ) : (
                 <div className="flex-1 flex flex-col items-center justify-center text-center text-gray-500 p-6">
                     <MousePointer2 size={32} className="mx-auto mb-3 opacity-20" />
                     <p className="text-xs">Select a state or transition<br/>to edit properties.</p>
                 </div>
             )}
        </div>
    );
};
