import type { GraphCondition, GraphTransition } from '../../../types';

/** Tolerance for numeric `==` / `!=` conditions, so float variables still match after arithmetic. */
export const CONDITION_EPSILON = 1e-4;

/**
 * Whether one condition holds for the current variables. A missing variable never matches.
 * `==` / `!=` compare numbers within CONDITION_EPSILON and anything else strictly; `>`, `<`,
 * `>=`, `<=` only compare numbers, so they are false against a boolean variable or value.
 */
export const conditionMet = (condition: GraphCondition, variables: Record<string, number | boolean>): boolean => {
    const current = variables[condition.variableId];
    if (current === undefined) return false;
    const target = condition.value;
    switch (condition.operator) {
        case '==':
            return typeof current === 'number' && typeof target === 'number'
                ? Math.abs(current - target) <= CONDITION_EPSILON
                : current === target;
        case '!=':
            return typeof current === 'number' && typeof target === 'number'
                ? !(Math.abs(current - target) <= CONDITION_EPSILON)
                : current !== target;
    }
    if (typeof current !== 'number' || typeof target !== 'number') return false;
    switch (condition.operator) {
        case '>': return current > target;
        case '<': return current < target;
        case '>=': return current >= target;
        case '<=': return current <= target;
        default: return false;
    }
};

/**
 * Whether a transition's conditions pass under its `conditionMode`: every condition for 'all'
 * (the default), at least one for 'any'. An empty list passes; selectTransition requires an exit
 * time for those.
 */
export const conditionsMet = (transition: GraphTransition, variables: Record<string, number | boolean>): boolean => {
    const conditions = transition.conditions;
    if (!conditions.length) return true;
    const any = transition.conditionMode === 'any';
    for (let i = 0; i < conditions.length; i++) {
        if (conditionMet(conditions[i], variables) === any) return any;
    }
    return !any;
};

/** Whether `transition` is checked while `activeStateId` plays: its source state, or any state but its target. */
export const transitionAppliesTo = (transition: GraphTransition, activeStateId: string): boolean =>
    transition.anyState ? transition.toStateId !== activeStateId : transition.fromStateId === activeStateId;

const priorityOf = (transition: GraphTransition): number => {
    const priority = transition.priority;
    return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
};

/**
 * The transition to take out of `activeStateId`, or null. A transition is checked when it leaves
 * the active state, or when it is an any-state transition whose target is not the active state.
 * It is ready once its conditions pass (see conditionsMet) and its exit time (if any) has been
 * reached. `exitTime` is a fraction of the source clip (0..1); a transition with an exit time and
 * no conditions fires on its own when the clip gets there, so one-shot states (attack, jump)
 * return without a variable. `normalizedTime` is null when the state has no single clip. Among
 * ready transitions the highest `priority` (default 0) wins; ties keep array order.
 */
export const selectTransition = (
    transitions: GraphTransition[],
    activeStateId: string,
    variables: Record<string, number | boolean>,
    normalizedTime: number | null,
): GraphTransition | null => {
    let best: GraphTransition | null = null;
    let bestPriority = 0;
    for (let i = 0; i < transitions.length; i++) {
        const transition = transitions[i];
        if (!transitionAppliesTo(transition, activeStateId)) continue;
        const priority = priorityOf(transition);
        // A ready transition earlier in the list already wins ties.
        if (best !== null && priority <= bestPriority) continue;
        const exitTime = transition.exitTime;
        if (typeof exitTime === 'number' && Number.isFinite(exitTime)) {
            if (normalizedTime === null || normalizedTime < exitTime) continue;
        } else if (!transition.conditions.length) {
            // Without an exit time, an unconditional transition would fire every frame it is checked.
            continue;
        }
        if (!conditionsMet(transition, variables)) continue;
        best = transition;
        bestPriority = priority;
    }
    return best;
};
