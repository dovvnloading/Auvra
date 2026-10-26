

import { useEffect, useRef, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { AnimationGraphData } from '../../../types';
import { useAnimationMixer } from './useAnimationMixer';
import { useInputHandler } from './useInputHandler';
import { useGraphStateMachine } from './useGraphStateMachine';
import { useGraphLocomotion } from './useGraphLocomotion';
import { useGraphAnimator } from './useGraphAnimator';

/**
 * Returns a reader for a Single state's normalized clip time (0..1), or null when the state has no
 * clip. three wraps a looping action's time back into [0, duration), so on its own it never reports
 * 1 and an exit time of 1 would never fire. When the clip has wrapped forward since the previous
 * read of the same state, the read returns 1 instead, so an exit time of 1 (or one a single frame
 * stepped over) fires at the end of each cycle. Only a drop of more than half the clip counts as a
 * wrap, which leaves a reset just after entering the state and reversed playback alone. The reader
 * follows one state at a time; reading a different state starts over.
 */
export const createNormalizedTimeReader = (
    states: AnimationGraphData['states'],
    actionsMap: Record<string, THREE.AnimationAction>
) => {
    let lastStateId: string | null = null;
    let lastTime: number | null = null;
    return (stateId: string): number | null => {
        const state = states.find(item => item.id === stateId);
        const action = state?.stateType === 'Single' && state.clipName ? actionsMap[state.clipName] : undefined;
        const duration = action?.getClip().duration ?? 0;
        const time = action && duration > 0 ? Math.min(1, Math.max(0, action.time / duration)) : null;
        const wrapped = !!action && time !== null && lastTime !== null && stateId === lastStateId
            && action.loop !== THREE.LoopOnce && action.timeScale > 0 && lastTime - time > 0.5;
        lastStateId = stateId;
        lastTime = time;
        return wrapped ? 1 : time;
    };
};

export const useGraphRuntime = (
    modelObject: THREE.Group,
    graph: AnimationGraphData,
    allClips: THREE.AnimationClip[],
    enableInputs: boolean,
    onActiveStateChange?: (id: string) => void,
    driveLocomotion: boolean = true
) => {
    
    // 1. Central Data Store for Variables
    const variablesRef = useRef<Record<string, number | boolean>>({});
    
    // Sync initial variables from graph definition
    useEffect(() => {
        graph.variables.forEach(v => {
            if (variablesRef.current[v.id] === undefined) {
                variablesRef.current[v.id] = v.value;
            }
        });
    }, [graph.variables]);

    // Setter API
    const setVariable = useCallback((nameOrId: string, value: number | boolean) => {
        // Try to resolve Name -> ID
        const variableByName = graph.variables.find(v => v.name === nameOrId);
        
        if (variableByName) {
            // It's a graph variable, store by ID
            variablesRef.current[variableByName.id] = value;
        } else {
            // It's a Virtual Variable (Stat/External), store by Name
            variablesRef.current[nameOrId] = value;
        }
    }, [graph.variables]);

    const getVariable = useCallback((name: string) => {
        // 1. Try Graph Variable (ID lookup)
        const variable = graph.variables.find(v => v.name === name);
        if (variable) {
            return variablesRef.current[variable.id];
        }
        // 2. Try Virtual Variable (Direct Name lookup)
        return variablesRef.current[name];
    }, [graph.variables]);
    
    const getVariables = useCallback(() => ({ ...variablesRef.current }), []);

    // 2. Sub-System Hooks (Separation of Concerns)
    
    // -- Graphics: Handles Three.js resources
    const { mixer, actionsMap } = useAnimationMixer(modelObject, allClips);

    // -- Logic: Handles State Machine Transitions
    // A fresh reader whenever the states or clips change, so a live edit's clip reset is not read as a loop wrap.
    const getNormalizedTime = useMemo(() => createNormalizedTimeReader(graph.states, actionsMap), [graph.states, actionsMap]);
    const { activeStateRef, previousStateRef, blendDurationRef } = useGraphStateMachine(graph, variablesRef, onActiveStateChange, getNormalizedTime);

    // -- Inputs: Handles Keyboard -> Variable Mapping
    useInputHandler(graph, enableInputs, setVariable);

    // -- Physics: Handles Mesh Movement
    useGraphLocomotion(modelObject, graph, variablesRef, driveLocomotion);

    // -- Animation: Handles Weight Blending & Playback
    useGraphAnimator(mixer, actionsMap, graph, activeStateRef, previousStateRef, variablesRef, blendDurationRef);

    return { setVariable, getVariable, getVariables };
};
