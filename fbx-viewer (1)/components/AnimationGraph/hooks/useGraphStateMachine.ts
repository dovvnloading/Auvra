
import React, { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { AnimationGraphData } from '../../../types';
import { frontendDiagnostics } from '../../../diagnostics/runtime';

export const useGraphStateMachine = (
    graph: AnimationGraphData,
    variablesRef: React.MutableRefObject<Record<string, number | boolean>>,
    onActiveStateChange?: (id: string) => void
) => {
    const activeStateRef = useRef<string | null>(graph.activeStateId || null);
    const previousStateRef = useRef<string | null>(null);

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
        const transitions = graph.transitions.filter(t => t.fromStateId === activeStateRef.current);
        
        for (const t of transitions) {
            const allMet = t.conditions.every(c => {
                const currVal = variablesRef.current[c.variableId];
                if (currVal === undefined) return false;
                
                if (c.operator === '>') return (currVal as number) > (c.value as number);
                if (c.operator === '<') return (currVal as number) < (c.value as number);
                if (c.operator === '>=') return (currVal as number) >= (c.value as number);
                if (c.operator === '<=') return (currVal as number) <= (c.value as number);
                if (c.operator === '==') return currVal === c.value;
                if (c.operator === '!=') return currVal !== c.value;
                return false;
            });

            if (allMet) {
                const span = frontendDiagnostics.startSpan('animation_runtime', 'state_transition', {
                    category: 'runtime_transition',
                });
                activeStateRef.current = t.toStateId;
                if (onActiveStateChange) onActiveStateChange(t.toStateId);
                span.finish('success');
                break; // Take first valid transition
            }
        }
    });

    return {
        activeStateRef,
        previousStateRef
    };
};
