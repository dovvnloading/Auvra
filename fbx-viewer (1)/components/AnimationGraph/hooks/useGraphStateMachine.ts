
import React, { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { AnimationGraphData, GraphTransition } from '../../../types';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { blendSeconds, DEFAULT_BLEND_SECONDS } from '../utils/blending';
import { selectTransition, throughConduits } from '../utils/transitions';
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
    const conduits = useMemo(
        () => new Set(graph.states.filter(state => state.stateType === 'Conduit').map(state => state.id)),
        [graph.states],
    );

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
        const variables = variablesRef.current;
        const normalizedTime = getNormalizedTime ? getNormalizedTime(activeId) : null;
        let transition: GraphTransition | null;
        if (conduits.size) {
            // A transition into a conduit is taken only with a way on, and goes straight through to it.
            const arrivals = new Map<GraphTransition, GraphTransition>();
            const isConduit = (stateId: string) => conduits.has(stateId);
            const chosen = selectTransition(graph.transitions, activeId, variables, normalizedTime, (candidate) => {
                const arrived = throughConduits(candidate, graph.transitions, isConduit, variables);
                if (arrived) arrivals.set(candidate, arrived);
                return arrived !== null;
            });
            transition = chosen ? arrivals.get(chosen) ?? chosen : null;
        } else {
            transition = selectTransition(graph.transitions, activeId, variables, normalizedTime);
        }
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
