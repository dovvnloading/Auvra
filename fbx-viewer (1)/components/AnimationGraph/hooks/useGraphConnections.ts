
import { useMemo } from 'react';
import { AnimationGraphData, GraphState, GraphTransition } from '../../../types';

export interface ConnectionGroup {
    key: string;
    nodeA: GraphState;
    nodeB: GraphState;
    transitions: GraphTransition[];
}

export const useGraphConnections = (graph: AnimationGraphData) => {
    
    const connectionGroups = useMemo(() => {
        const groups: Record<string, ConnectionGroup> = {};

        if (graph.transitions) {
            graph.transitions.forEach(t => {
                const s1 = graph.states.find(s => s.id === t.fromStateId);
                const s2 = graph.states.find(s => s.id === t.toStateId);
                if (!s1 || !s2) return;

                let nodeA = s1;
                let nodeB = s2;
                
                // Normalize direction to group A->B and B->A together visually
                if (s1.position.x > s2.position.x + 10) { 
                    nodeA = s2;
                    nodeB = s1;
                } else if (Math.abs(s1.position.x - s2.position.x) <= 10 && s1.position.y > s2.position.y) {
                    nodeA = s2;
                    nodeB = s1;
                }

                const key = `${nodeA.id}-${nodeB.id}`;
                if (!groups[key]) {
                    groups[key] = { key, nodeA, nodeB, transitions: [] };
                }
                groups[key].transitions.push(t);
            });
        }
        
        return Object.values(groups);
    }, [graph.transitions, graph.states]);

    return connectionGroups;
};
