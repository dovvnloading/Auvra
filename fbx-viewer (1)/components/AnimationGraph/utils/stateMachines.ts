import type { AnimationGraphData, GraphState, GraphTransition, SubStateMachine } from '../../../types';

/** Joins a nested state's id to its parents' in the runtime's flat graph (`machine/state`). */
export const STATE_PATH_SEPARATOR = '/';

/** Joins an expanded transition's id to the state it leaves from (`transition@state`). */
const EXPANDED_TRANSITION_SEPARATOR = '@';

const hasInnerStates = (state: GraphState): boolean =>
    state.stateType === 'StateMachine' && !!state.subGraph?.states.length;

const entryOf = (states: readonly GraphState[]): GraphState | undefined => states.find(state => state.isRoot) ?? states[0];

interface FlatLevel {
    /** Flat ids of the playable states in this level, nested ones included. */
    leaves: string[];
    /** Flat id of the state each of this level's states is entered at. */
    entries: Map<string, string>;
    transitions: GraphTransition[];
}

const flattenLevel = (
    states: readonly GraphState[],
    transitions: readonly GraphTransition[],
    prefix: string,
    out: GraphState[],
): FlatLevel => {
    const leavesOf = new Map<string, string[]>();
    const entries = new Map<string, string>();
    const inner: GraphTransition[] = [];
    states.forEach((state) => {
        const id = prefix + state.id;
        if (hasInnerStates(state)) {
            const sub = state.subGraph as SubStateMachine;
            const level = flattenLevel(sub.states, sub.transitions, id + STATE_PATH_SEPARATOR, out);
            const entry = entryOf(sub.states);
            leavesOf.set(state.id, level.leaves);
            if (entry && level.entries.has(entry.id)) entries.set(state.id, level.entries.get(entry.id) as string);
            inner.push(...level.transitions);
        } else {
            out.push(prefix ? { ...state, id } : state);
            leavesOf.set(state.id, [id]);
            entries.set(state.id, id);
        }
    });

    const leaves = [...leavesOf.values()].flat();
    const own: GraphTransition[] = [];
    transitions.forEach((transition) => {
        const to = entries.get(transition.toStateId);
        if (!to) return;
        // An any-state transition fires from every state of its machine except the one it enters.
        const from = transition.anyState
            ? leaves.filter(leaf => !(leavesOf.get(transition.toStateId) ?? []).includes(leaf))
            : leavesOf.get(transition.fromStateId) ?? [];
        const kept = !transition.anyState && from.length === 1;
        from.forEach((leaf) => {
            own.push({
                ...transition,
                id: kept ? transition.id : transition.id + EXPANDED_TRANSITION_SEPARATOR + leaf,
                fromStateId: leaf,
                toStateId: to,
                anyState: false,
            });
        });
    });
    // A machine's own transitions come before those inside its states, so leaving it wins ties.
    return { leaves, entries, transitions: [...own, ...inner] };
};

/**
 * The graph a runtime plays: every State Machine state is replaced by the states inside it, so the
 * animator and the transition logic only see playable states. A nested state's id is its path
 * (`machine/state`); top-level ids stay as they are, and a graph with no state machines comes back
 * unchanged. A transition into a machine enters its entry state; a transition out of one is checked
 * from each state inside it, ahead of the transitions inside; an any-state transition fires from
 * every state of its own machine, nested ones included, except the state (or machine) it enters.
 * Only the entry state of the whole graph stays marked as root.
 */
export const flattenStateMachines = (graph: AnimationGraphData): AnimationGraphData => {
    if (!graph.states.some(hasInnerStates)) return graph;
    const states: GraphState[] = [];
    const level = flattenLevel(graph.states, graph.transitions, '', states);
    const root = entryOf(graph.states);
    const entry = root ? level.entries.get(root.id) ?? null : null;
    const active = graph.activeStateId ? level.entries.get(graph.activeStateId) ?? null : null;
    return {
        ...graph,
        states: states.map(state => (!!state.isRoot === (state.id === entry) ? state : { ...state, isRoot: state.id === entry })),
        transitions: level.transitions,
        activeStateId: active,
    };
};

/** The transition id the editor shows for one the runtime fired (expanded copies share it). */
export const authoredTransitionId = (id: string): string => id.split(EXPANDED_TRANSITION_SEPARATOR)[0];

/**
 * Which state of the level at `path` the runtime's flat `activeId` is in: the state itself, or
 * the machine holding it. Null when the runtime is outside that level.
 */
export const levelActiveStateId = (activeId: string | null, path: readonly string[]): string | null => {
    if (!activeId) return null;
    const parts = activeId.split(STATE_PATH_SEPARATOR);
    if (parts.length <= path.length || path.some((id, index) => parts[index] !== id)) return null;
    return parts[path.length];
};

/** The states and transitions shown at `path` (State Machine ids from the top), or null when the path no longer exists. */
export const graphLevel = (graph: AnimationGraphData, path: readonly string[]): SubStateMachine | null => {
    let level: SubStateMachine = { states: graph.states, transitions: graph.transitions };
    for (const id of path) {
        const machine = level.states.find(state => state.id === id);
        if (!machine || machine.stateType !== 'StateMachine' || !machine.subGraph) return null;
        level = machine.subGraph;
    }
    return level;
};

/**
 * Turns an edit of the level at `path` into an edit of the whole graph: new `states` or
 * `transitions` for that level are written into its machine; other fields pass through.
 */
export const writeGraphLevel = (
    graph: AnimationGraphData,
    path: readonly string[],
    data: Partial<AnimationGraphData>,
): Partial<AnimationGraphData> => {
    if (!path.length || (data.states === undefined && data.transitions === undefined)) return data;
    const { states, transitions, ...rest } = data;
    const write = (level: GraphState[], depth: number): GraphState[] => level.map((state) => {
        if (state.id !== path[depth] || !state.subGraph) return state;
        const sub = state.subGraph;
        const subGraph = depth === path.length - 1
            ? { states: states ?? sub.states, transitions: transitions ?? sub.transitions }
            : { ...sub, states: write(sub.states, depth + 1) };
        return { ...state, subGraph };
    });
    return { ...rest, states: write(graph.states, 0) };
};

/** The inside of a new State Machine state: one entry state playing `clipName`. */
export const newSubStateMachine = (clipName: string | null): SubStateMachine => ({
    states: [{
        id: crypto.randomUUID(),
        name: 'Entry',
        position: { x: 0, y: 0 },
        loop: true,
        isRoot: true,
        stateType: 'Single',
        clipName,
        blendSamples: [],
        blendParamX: '',
        blendParamY: '',
    }],
    transitions: [],
});

/** Number of playable states inside a State Machine state, nested machines counted by their states. */
export const innerStateCount = (state: GraphState): number =>
    (state.subGraph?.states ?? []).reduce((count, inner) => count + (inner.stateType === 'StateMachine' ? innerStateCount(inner) : 1), 0);
