
import React, { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { AnimationGraphData } from '../../../types';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { blendSeconds, DEFAULT_BLEND_SECONDS } from '../utils/blending';
import { selectTransition } from '../utils/transitions';
import { ANIMATION_FRAME_PRIORITY } from './useGraphAnimator';

export const useGraphStateMachine = (
    graph: AnimationGraphData,
    variablesRef: React.MutableRefObject<Record<string, number | boolean>>,
    onActiveStateChange?: (id: string) => void,
    /** Normalized playback time (0..1) of a state's clip, or null when it has none. */
    getNormalizedTime?: (stateId: string) => number | null
) => {
    const activeStateRef = useRef<string | null>(graph.activeStateId || null);
    const previousStateRef = useRef<string | null>(null);
    // Crossfade length of the most recent transition, read by the animator on state entry.
    const blendDurationRef = useRef<number>(DEFAULT_BLEND_SECONDS);

    // Initialize active state if missing
    useEffect(() => {
        if (!activeStateRef.current && graph.states.length > 0) {
            const root = graph.states.find(s => s.isRoot);
            activeStateRef.current = root ? root.id : graph.states[0].id;
        }
    }, [graph.states]);

    useFrame(() => {
        // Safety: If active state was deleted, fallback to root or first
        if (activeStateRef.current && !graph.states.find(s => s.id === activeStateRef.current)) {
             const root = graph.states.find(s => s.isRoot);
             activeStateRef.current = root ? root.id : (graph.states[0]?.id || null);
             previousStateRef.current = null; // Force re-entry
        }

        if (!activeStateRef.current) return;

        // Check transitions for current state
        const activeId = activeStateRef.current;
        const transition = selectTransition(graph.transitions, activeId, variablesRef.current, getNormalizedTime ? getNormalizedTime(activeId) : null);
        if (transition) {
            const span = frontendDiagnostics.startSpan('animation_runtime', 'state_transition', {
                category: 'runtime_transition',
            });
            blendDurationRef.current = blendSeconds(transition.duration);
            activeStateRef.current = transition.toStateId;
            if (onActiveStateChange) onActiveStateChange(transition.toStateId);
            span.finish('success');
        }
    }, ANIMATION_FRAME_PRIORITY);

    return {
        activeStateRef,
        previousStateRef,
        blendDurationRef
    };
};
