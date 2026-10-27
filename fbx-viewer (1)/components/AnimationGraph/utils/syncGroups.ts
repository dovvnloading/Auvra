import type * as THREE from 'three';

/** Where an action is in its cycle, from 0 to 1. */
export const actionPhase = (action: THREE.AnimationAction): number => {
    const duration = action.getClip().duration;
    if (!(duration > 0)) return 0;
    const phase = action.time / duration;
    return Math.min(Math.max(phase, 0), 1);
};

/** The clip the others in a blend follow: the heaviest one. */
export const syncLeader = (weights: Record<string, number>): string | null => {
    let leader: string | null = null;
    let best = 0;
    Object.keys(weights).forEach((name) => {
        if (weights[name] > best) {
            best = weights[name];
            leader = name;
        }
    });
    return leader;
};

/**
 * Time scales that keep a blend's clips on one phase: each clip runs at its own length over the
 * blend's weighted cycle length, so a 1 s walk and a 0.6 s run blended half and half both loop
 * every 0.8 s and their feet land together.
 */
export const syncedTimeScales = (
    durations: Record<string, number>,
    weights: Record<string, number>,
    rate: number
): Record<string, number> => {
    let total = 0;
    let weighted = 0;
    Object.keys(weights).forEach((name) => {
        const weight = weights[name];
        const duration = durations[name];
        if (weight > 0 && duration > 0) {
            total += weight;
            weighted += weight * duration;
        }
    });
    const cycle = total > 0 ? weighted / total : 0;
    const scales: Record<string, number> = {};
    Object.keys(weights).forEach((name) => {
        const duration = durations[name];
        scales[name] = cycle > 0 && duration > 0 ? (rate * duration) / cycle : rate;
    });
    return scales;
};

/**
 * Runs a blend state's clips in step: they share the cycle length of the blend and every clip is
 * put at the heaviest one's phase, so samples of different lengths never drift apart.
 */
export const syncBlendActions = (
    actions: Record<string, THREE.AnimationAction>,
    weights: Record<string, number>,
    rate: number
): void => {
    const durations: Record<string, number> = {};
    Object.keys(weights).forEach((name) => { durations[name] = actions[name].getClip().duration; });
    const scales = syncedTimeScales(durations, weights, rate);
    const leader = syncLeader(weights);
    const phase = leader ? actionPhase(actions[leader]) : 0;
    Object.keys(weights).forEach((name) => {
        const action = actions[name];
        action.timeScale = scales[name];
        if (leader && name !== leader) action.time = phase * durations[name];
    });
};
