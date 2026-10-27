import type { AnimationGraphData, BlendSample, GraphState, UpperBodySettings } from '../../../types';

/** What a state or blend sample is for, read from its name or position. */
export type ClipRole = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' | 'attack' | 'death'
    | 'strafe' | 'strafeLeft' | 'strafeRight' | 'back' | 'shoot' | 'aim';

const words = (name: string) => name.toLowerCase().replace(/[_\-.|:]+/g, ' ');

/** The role a state's name asks for ("Chase" runs, "Ready (Combat)" idles), or null for names it does not know. */
export const stateRole = (name: string): ClipRole | null => {
    const n = words(name);
    if (/\b(death|dead|die|dying)\b/.test(n)) return 'death';
    if (/\bland(ing)?\b/.test(n)) return 'land';
    if (/\bfall(ing)?\b|\bin air\b|\bairborne\b/.test(n)) return 'fall';
    if (/\bjump/.test(n)) return 'jump';
    if (/\b(attack|punch|melee|swing|slash|strike|kick)/.test(n)) return 'attack';
    if (/\b(shoot|fire|firing)/.test(n)) return 'shoot';
    if (/\bstrafe/.test(n)) return 'strafe';
    if (/\b(run|chase|sprint)/.test(n)) return 'run';
    if (/\bwalk/.test(n)) return 'walk';
    if (/\b(idle|ready|stand)/.test(n)) return 'idle';
    return null;
};

/** The role of a 2D blend sample, from where it sits: centre idles, ahead walks, behind backs up, sideways strafes. */
const sampleRole2D = ([x, y]: [number, number]): ClipRole => {
    if (Math.abs(x) < 0.25 && Math.abs(y) < 0.25) return 'idle';
    if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'strafeLeft' : 'strafeRight';
    return y < 0 ? 'back' : 'walk';
};

/** Clip-name tests for each role, best first; a clip that only passes a later test is a fallback. */
const CLIP_TESTS: Record<ClipRole, RegExp[]> = {
    idle: [/^(?!.*\b(fight|combat|aim|aiming|kneel|kneeling|sit|sitting|crouch|crouched|to)\b).*\bidle\b/, /\bidle\b/, /\bbreathing\b/],
    walk: [/^(?!.*\b(back|backward|backwards|left|right|strafe|turn|start|stop|to)\b).*\bwalk(ing)?\b/],
    run: [/^(?!.*\b(back|backward|backwards|left|right|strafe|turn|start|stop|to|slide)\b).*\b(run|running|sprint)\b/],
    jump: [/^(?!.*\b(down|back|backward|backwards)\b).*\bjump(ing)?\b/, /\bjump/],
    fall: [/^(?!.*\bland).*\bfall(ing)?\b/],
    land: [/\bland(ing)?\b/],
    attack: [/\b(attack|punch|swip(e|ing)|slash|strike|kick|melee)\w*/],
    death: [/\b(death|dying|die|dead)\b/],
    strafe: [/\bstrafe\b/],
    strafeLeft: [/\bleft\b.*\bstrafe\b|\bstrafe\b.*\bleft\b/],
    strafeRight: [/\bright\b.*\bstrafe\b|\bstrafe\b.*\bright\b/],
    back: [/\b(walk(ing)?\s+)?back(ward|wards)?\b/],
    shoot: [/\b(shoot(ing)?|fir(e|ing)|gunplay)\b/],
    aim: [/^(?!.*\b(walk|walking|run|running|strafe|back|backward|backwards)\b).*\b(aim|aiming)\b/],
};

/** When a model has no clip for a role, the one standing in for it. */
const FALLBACK_ROLE: Partial<Record<ClipRole, ClipRole>> = {
    strafe: 'walk', strafeLeft: 'walk', strafeRight: 'walk', back: 'walk', run: 'walk', walk: 'run',
};

/** The best of `clips` for `role`: the first test any clip passes, then the shortest name ("Idle" before "Idle 2"). */
export const findClipForRole = (role: ClipRole, clips: readonly string[], fallback = true): string | null => {
    for (const test of CLIP_TESTS[role]) {
        const matches = clips.filter(clip => test.test(words(clip)));
        if (matches.length) return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    }
    const stand = fallback ? FALLBACK_ROLE[role] : undefined;
    return stand ? findClipForRole(stand, clips, false) : null;
};

export interface ClipAssignment {
    /** The state, or "state: sample" for a blend sample. */
    target: string;
    clip: string;
}

/**
 * Fills in clips for `graph` from a model's `clips`, matching state names (and blend sample
 * positions) to clip names. Only states and samples with no clip, or with a clip the model does
 * not have, change; a choice that already plays on this model is kept.
 */
export const matchGraphClips = (
    graph: AnimationGraphData,
    clips: readonly string[],
): { graph: AnimationGraphData; assigned: ClipAssignment[] } => {
    const own = new Set(clips);
    const needs = (clip: string | null | undefined) => !clip || !own.has(clip);
    const assigned: ClipAssignment[] = [];

    const matchState = (state: GraphState): GraphState => {
        if (state.stateType === 'StateMachine') {
            const sub = state.subGraph;
            if (!sub) return state;
            const inner = sub.states.map(matchState);
            return inner.some((next, index) => next !== sub.states[index]) ? { ...state, subGraph: { ...sub, states: inner } } : state;
        }
        if (state.stateType === 'Single' || !state.stateType) {
            if (!needs(state.clipName)) return state;
            const role = stateRole(state.name);
            const clip = role ? findClipForRole(role, clips) : null;
            if (!clip) return state;
            assigned.push({ target: state.name, clip });
            return { ...state, clipName: clip };
        }
        const xs = state.blendSamples.map(sample => sample.position[0]);
        const maxX = Math.max(...xs);
        const blendSamples = state.blendSamples.map((sample): BlendSample => {
            if (!needs(sample.clipName)) return sample;
            const role: ClipRole = state.stateType === 'Blend2D'
                ? sampleRole2D(sample.position)
                : sample.position[0] <= 0 ? 'idle' : sample.position[0] >= maxX && xs.length > 2 ? 'run' : 'walk';
            const clip = findClipForRole(role, clips);
            if (!clip) return sample;
            assigned.push({ target: `${state.name}: ${sample.clipName || role}`, clip });
            return { ...sample, clipName: clip };
        });
        return blendSamples.some((sample, index) => sample !== state.blendSamples[index]) ? { ...state, blendSamples } : state;
    };
    const states = graph.states.map(matchState);

    return { graph: assigned.length ? { ...graph, states } : graph, assigned };
};

/**
 * Fills in a player's fire and aim clips from a model's `clips` by name ("Shooting", "Rifle Aiming
 * Idle"), where none is set or the model lacks the one that is. There is no stand-in: without a
 * fitting clip the upper body follows the graph.
 */
export const matchUpperBodyClips = (
    settings: UpperBodySettings | undefined,
    clips: readonly string[],
): { settings: UpperBodySettings | undefined; assigned: ClipAssignment[] } => {
    const own = new Set(clips);
    const assigned: ClipAssignment[] = [];
    let next = settings;
    for (const [key, role, target] of [['fireClip', 'shoot', 'Fire'], ['aimClip', 'aim', 'Aim']] as const) {
        const current = next?.[key];
        if (current && own.has(current)) continue;
        const clip = findClipForRole(role, clips, false);
        if (!clip) continue;
        next = { ...next, [key]: clip };
        assigned.push({ target, clip });
    }
    return { settings: next, assigned };
};
