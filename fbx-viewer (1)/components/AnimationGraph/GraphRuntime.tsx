import React, { useEffect } from 'react';
import * as THREE from 'three';
import { AnimationGraphData, GraphState } from '../../types';
import { useGraphRuntime, type PlayMontageOptions } from './hooks/useGraphRuntime';

export interface GraphRuntimeAPI {
    setVariable: (name: string, value: number | boolean) => void;
    getVariable: (name: string) => number | boolean | undefined;
    getVariables: () => Record<string, number | boolean>;
    /** Plays a clip once over the graph (optionally on part of the skeleton); false when the clip is unknown. */
    playMontage?: (clipName: string, options?: PlayMontageOptions) => boolean;
    stopMontage?: (blendOut?: number) => void;
    /** World-space root-motion travel since the last call; the caller moves the character by it. */
    consumeRootMotion?: (out?: THREE.Vector3) => THREE.Vector3;
    getActiveState?: () => GraphState | null;
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
    /** Reported as the source of this character's animation notifies (e.g. 'player' or an object id). */
    eventSource?: string | null;
}

export const GraphRuntime: React.FC<GraphRuntimeProps> = ({
    modelObject,
    graph,
    allClips,
    enableInputs,
    onActiveStateChange,
    apiRef,
    driveLocomotion = true,
    eventSource = null
}) => {

    const runtime = useGraphRuntime(
        modelObject,
        graph,
        allClips,
        enableInputs,
        onActiveStateChange,
        driveLocomotion,
        eventSource
    );
    const { setVariable, getVariable, getVariables, playMontage, stopMontage, consumeRootMotion, getActiveState } = runtime;

    // Expose API
    useEffect(() => {
        if (apiRef) {
            apiRef.current = { setVariable, getVariable, getVariables, playMontage, stopMontage, consumeRootMotion, getActiveState };
        }
    }, [apiRef, setVariable, getVariable, getVariables, playMontage, stopMontage, consumeRootMotion, getActiveState]);

    return null;
};
