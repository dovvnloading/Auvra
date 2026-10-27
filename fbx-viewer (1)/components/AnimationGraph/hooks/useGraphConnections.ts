
import { useMemo } from 'react';
import { AnimationGraphData, GraphState, GraphTransition } from '../../../types';

export interface ConnectionGroup {
    key: string;
    nodeA: GraphState;
    nodeB: GraphState;
    transitions: GraphTransition[];
}

/** Any-state transitions grouped by the state they lead to (only states that exist). */
export const anyStateTransitionsByTarget = (graph: AnimationGraphData): Map<string, GraphTransition[]> => {
    const byTarget = new Map<string, GraphTransition[]>();
    const stateIds = new Set(graph.states.map(state => state.id));
    for (const transition of graph.transitions ?? []) {
        if (!transition.anyState || !stateIds.has(transition.toStateId)) continue;
        const list = byTarget.get(transition.toStateId);
        if (list) list.push(transition);
        else byTarget.set(transition.toStateId, [transition]);
    }
    return byTarget;
};

export const useGraphConnections = (graph: AnimationGraphData) => {
    
    const connectionGroups = useMemo(() => {
        const groups: Record<string, ConnectionGroup> = {};

        if (graph.transitions) {
            graph.transitions.forEach(t => {
                // Any-state transitions have no source node; the canvas tags their target instead.
                if (t.anyState) return;
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
