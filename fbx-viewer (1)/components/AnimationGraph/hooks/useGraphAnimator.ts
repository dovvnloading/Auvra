
import React, { useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData } from '../../../types';

export const useGraphAnimator = (
    mixer: THREE.AnimationMixer | null,
    actionsMap: Record<string, THREE.AnimationAction>,
    graph: AnimationGraphData,
    activeStateRef: React.MutableRefObject<string | null>,
    previousStateRef: React.MutableRefObject<string | null>,
    variablesRef: React.MutableRefObject<Record<string, number | boolean>>
) => {
    
    // -- LIVE EDIT WATCHER --
    // This effect ensures that if the user changes the clip or loop setting 
    // for the CURRENTLY active state in the UI, the animation updates immediately.
    const activeStateId = activeStateRef.current;
    // We must find the state from the latest graph prop
    const activeState = graph.states.find(s => s.id === activeStateId);
    
    // Extract stable primitives for dependency array to prevent unnecessary resets
    const activeClipName = activeState?.stateType === 'Single' ? activeState.clipName : null;
    const activeLoop = activeState?.loop;
    const activeStateType = activeState?.stateType;

    useEffect(() => {
        if (!activeClipName || !actionsMap[activeClipName]) return;

        const action = actionsMap[activeClipName];
        
        // Force reset and play because the user explicitly changed the configuration
        // of the state we are currently looking at.
        action.reset();
        action.fadeIn(0.2);
        action.setLoop(activeLoop ? THREE.LoopRepeat : THREE.LoopOnce, activeLoop ? Infinity : 1);
        action.play();
        
    }, [activeClipName, activeLoop, activeStateType, actionsMap]);


    // -- FRAME LOOP --
    useFrame((state, delta) => {
        if (!mixer) return;

        // 1. Handle State Entry (Transition Logic)
        if (activeStateRef.current !== previousStateRef.current) {
            const enteringState = graph.states.find(s => s.id === activeStateRef.current);
            if (enteringState) {
                const initClip = (name: string, loop: boolean) => {
                    const action = actionsMap[name];
                    if (action) {
                        action.reset();
                        action.fadeIn(0.2); 
                        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
                        action.play();
                    }
                };

                if (enteringState.stateType === 'Single' && enteringState.clipName) {
                    initClip(enteringState.clipName, enteringState.loop);
                } else if (enteringState.stateType === 'Blend2D') {
                    enteringState.blendSamples.forEach(sample => {
                        if (sample.clipName) initClip(sample.clipName, true);
                    });
                }
            }
            previousStateRef.current = activeStateRef.current;
        }

        // 2. Calculate Target Weights
        const currentState = graph.states.find(s => s.id === activeStateRef.current);
        const targetWeights: Record<string, number> = {};

        if (currentState) {
            if (currentState.stateType === 'Single' && currentState.clipName) {
                if (actionsMap[currentState.clipName]) {
                    targetWeights[currentState.clipName] = 1.0;
                    
                    // Timescale Logic (Reverse walk if moving backwards)
                    const action = actionsMap[currentState.clipName];
                    const vInputY = graph.variables.find(v => v.name.toLowerCase() === 'inputy');
                    const inputY = vInputY ? (variablesRef.current[vInputY.id] as number) : 0;
                    const stateNameLower = currentState.name.toLowerCase();

                    if (inputY < 0 && (stateNameLower.includes('walk') || stateNameLower.includes('run'))) {
                        action.timeScale = -1;
                    } else {
                        action.timeScale = 1;
                    }
                }
            } else if (currentState.stateType === 'Blend2D') {
                const valX = variablesRef.current[currentState.blendParamX] as number || 0;
                const valY = variablesRef.current[currentState.blendParamY] as number || 0;
                
                let totalWeight = 0;
                const sampleWeights: number[] = [];

                // IDW (Inverse Distance Weighting)
                currentState.blendSamples.forEach(sample => {
                    const dist = Math.sqrt(Math.pow(sample.position[0] - valX, 2) + Math.pow(sample.position[1] - valY, 2));
                    const weight = 1 / (Math.pow(dist, 2) + 0.0001);
                    sampleWeights.push(weight);
                    totalWeight += weight;
                });

                currentState.blendSamples.forEach((sample, idx) => {
                    if (sample.clipName && actionsMap[sample.clipName]) {
                        targetWeights[sample.clipName] = sampleWeights[idx] / totalWeight;
                        actionsMap[sample.clipName].timeScale = 1;
                    }
                });
            }
        }

        // 3. Apply Weights & Update Mixer
        Object.keys(actionsMap).forEach((name) => {
            const action = actionsMap[name];
            const target = targetWeights[name] || 0;
            const current = action.getEffectiveWeight();
            
            const next = THREE.MathUtils.lerp(current, target, 10 * delta);
            action.setEffectiveWeight(next);
            
            // Optimization & Playback Management
            if (next > 0.001 || target > 0) {
                action.enabled = true;
                if (!action.isRunning()) action.play();
            } else {
                action.enabled = false;
            }
        });

        mixer.update(delta);
    });
};
