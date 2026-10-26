
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
    /**
     * When true (default) the graph translates the model from its InputX/InputY
     * variables (editor preview). Pass false when a character controller already
     * owns the transform so the model is not moved twice.
     */
    driveLocomotion?: boolean;
}

export const GraphRuntime: React.FC<GraphRuntimeProps> = ({
    modelObject,
    graph,
    allClips,
    enableInputs,
    onActiveStateChange,
    apiRef,
    driveLocomotion = true
}) => {

    const { setVariable, getVariable, getVariables } = useGraphRuntime(
        modelObject,
        graph,
        allClips,
        enableInputs,
        onActiveStateChange,
        driveLocomotion
    );

    // Expose API
    useEffect(() => {
        if (apiRef) {
            apiRef.current = { setVariable, getVariable, getVariables };
        }
    }, [apiRef, setVariable, getVariable, getVariables]);

    return null;
};
