
import React from 'react';
import type * as THREE from 'three';
import { PointerIcon } from '../UI/Icons';
import { AnimationGraphData } from '../../types';
import { StateInspector } from './Inspectors/StateInspector';
import { TransitionInspector } from './Inspectors/TransitionInspector';
import { clipLoops } from '../../utils/clipRanges';

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
    /** Shows a State Machine state's own states on the canvas. */
    onOpenStateMachine?: (id: string) => void;
    /** The model the graph previews on, for what a Motion Match state's clips do on it. */
    previewObject?: THREE.Object3D | null;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
    selectedNodeId,
    graph,
    modelId,
    updateGraph,
    availableClips,
    onDeleteState,
    onDeleteTransition,
    onOpenStateMachine,
    previewObject = null
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
                    onOpenStateMachine={onOpenStateMachine}
                    clipDuration={availableClips.find(item => item.name === selectedNode.clipName)?.clip?.duration}
                    clipLoop={(name) => {
                        const clip = availableClips.find(item => item.name === name)?.clip;
                        return clip ? clipLoops(clip) : undefined;
                    }}
                    previewObject={previewObject}
                    clipByName={(name) => availableClips.find(item => item.name === name)?.clip ?? null}
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
                     <PointerIcon size={32} className="mx-auto mb-3 opacity-20" />
                     <p className="text-xs">Select a state or transition<br/>to edit properties.</p>
                 </div>
             )}
        </div>
    );
};
