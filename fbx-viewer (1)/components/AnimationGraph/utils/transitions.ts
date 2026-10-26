import type { GraphCondition, GraphTransition } from '../../../types';

export const conditionMet = (condition: GraphCondition, variables: Record<string, number | boolean>): boolean => {
    const current = variables[condition.variableId];
    if (current === undefined) return false;
    switch (condition.operator) {
        case '>': return (current as number) > (condition.value as number);
        case '<': return (current as number) < (condition.value as number);
        case '>=': return (current as number) >= (condition.value as number);
        case '<=': return (current as number) <= (condition.value as number);
        case '==': return current === condition.value;
        case '!=': return current !== condition.value;
        default: return false;
    }
};

/**
 * First transition out of `activeStateId` whose conditions all hold and whose exit time (if any)
 * has been reached. `exitTime` is a fraction of the source clip (0..1); a transition with an exit
 * time and no conditions fires on its own when the clip gets there, so one-shot states (attack,
 * jump) return without a variable. `normalizedTime` is null when the state has no single clip.
 */
export const selectTransition = (
    transitions: GraphTransition[],
    activeStateId: string,
    variables: Record<string, number | boolean>,
    normalizedTime: number | null,
): GraphTransition | null => {
    for (const transition of transitions) {
        if (transition.fromStateId !== activeStateId) continue;
        const exitTime = transition.exitTime;
        if (typeof exitTime === 'number' && Number.isFinite(exitTime)) {
            if (normalizedTime === null || normalizedTime < exitTime) continue;
        } else if (!transition.conditions.length) {
            // Without an exit time, an unconditional transition would fire every frame it is checked.
            continue;
        }
        if (transition.conditions.every(condition => conditionMet(condition, variables))) return transition;
    }
    return null;
};
