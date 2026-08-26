

import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { AnimationGraphData } from '../../types';
import { useAnimationMixer } from './useAnimationMixer';
import { useInputHandler } from './useInputHandler';
import { useGraphStateMachine } from './useGraphStateMachine';
import { useGraphLocomotion } from './useGraphLocomotion';
import { useGraphAnimator } from './useGraphAnimator';

export const useGraphRuntime = (
    modelObject: THREE.Group,
    graph: AnimationGraphData,
    allClips: THREE.AnimationClip[],
    enableInputs: boolean,
    onActiveStateChange?: (id: string) => void
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
    const { activeStateRef, previousStateRef } = useGraphStateMachine(graph, variablesRef, onActiveStateChange);

    // -- Inputs: Handles Keyboard -> Variable Mapping
    useInputHandler(graph, enableInputs, setVariable);

    // -- Physics: Handles Mesh Movement
    useGraphLocomotion(modelObject, graph, variablesRef);

    // -- Animation: Handles Weight Blending & Playback
    useGraphAnimator(mixer, actionsMap, graph, activeStateRef, previousStateRef, variablesRef);

    return { setVariable, getVariable, getVariables };
};