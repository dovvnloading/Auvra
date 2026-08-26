
import React, { useEffect } from 'react';
import * as THREE from 'three';
import { AnimationGraphData } from '../../types';
import { useGraphRuntime } from './hooks/useGraphRuntime';

export interface GraphRuntimeAPI {
    setVariable: (name: string, value: number | boolean) => void;
    getVariable: (name: string) => number | boolean | undefined;
    getVariables: () => Record<string, number | boolean>;
}

interface GraphRuntimeProps {
    modelObject: THREE.Group;
    graph: AnimationGraphData;
    allClips: THREE.AnimationClip[];
    enableInputs: boolean;
    onActiveStateChange?: (id: string) => void;
    apiRef?: React.MutableRefObject<GraphRuntimeAPI | undefined>;
}

export const GraphRuntime: React.FC<GraphRuntimeProps> = ({ 
    modelObject, 
    graph, 
    allClips,
    enableInputs,
    onActiveStateChange,
    apiRef
}) => {
    
    const { setVariable, getVariable, getVariables } = useGraphRuntime(
        modelObject,
        graph,
        allClips,
        enableInputs,
        onActiveStateChange
    );

    // Expose API
    useEffect(() => {
        if (apiRef) {
            apiRef.current = { setVariable, getVariable, getVariables };
        }
    }, [apiRef, setVariable, getVariable, getVariables]);

    return null;
};
