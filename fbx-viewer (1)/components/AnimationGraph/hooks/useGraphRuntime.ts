import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData } from '../../../types';
import { MontagePlayer, type MontageOptions } from '../utils/montage';
import { useAnimationMixer } from './useAnimationMixer';
import { useInputHandler } from './useInputHandler';
import { useGraphStateMachine } from './useGraphStateMachine';
import { useGraphLocomotion } from './useGraphLocomotion';
import { useGraphAnimator } from './useGraphAnimator';
import { flattenStateMachines } from '../utils/stateMachines';

/**
 * Returns a reader for a Single state's normalized clip time (0..1), or null when the state has no
 * clip. three wraps a looping action's time back into [0, duration), so on its own it never reports
 * 1 and an exit time of 1 would never fire. When the clip has wrapped forward since the previous
 * read of the same state, the read returns 1 instead, so an exit time of 1 (or one a single frame
 * stepped over) fires at the end of each cycle. Only a drop of more than half the clip counts as a
 * wrap, which leaves a reset just after entering the state and reversed playback alone. The reader
 * follows one state at a time; reading a different state starts over.
 */
export const createNormalizedTimeReader = (
    states: AnimationGraphData['states'],
    actionsMap: Record<string, THREE.AnimationAction>
) => {
    let lastStateId: string | null = null;
    let lastTime: number | null = null;
    return (stateId: string): number | null => {
        const state = states.find(item => item.id === stateId);
        const single = !!state && (state.stateType ?? 'Single') === 'Single';
        const action = single && state.clipName ? actionsMap[state.clipName] : undefined;
        // A single state with no clip to play (none chosen, or not in this model) counts as finished,
        // so its exit-time transitions still fire instead of leaving the character stuck in it.
        if (single && !action) {
            lastStateId = stateId;
            lastTime = null;
            return 1;
        }
        const duration = action?.getClip().duration ?? 0;
        const time = action && duration > 0 ? Math.min(1, Math.max(0, action.time / duration)) : null;
        const wrapped = !!action && time !== null && lastTime !== null && stateId === lastStateId
            && action.loop !== THREE.LoopOnce && action.timeScale > 0 && lastTime - time > 0.5;
        lastStateId = stateId;
        lastTime = time;
        return wrapped ? 1 : time;
    };
};

/**
 * Maps a graph variable's id or name to the key its value is stored under (the id). Anything
 * else, such as a stat or another external value, is stored under its own name.
 */
export const createVariableResolver = (variables: AnimationGraphData['variables']) => {
    const keys = new Map<string, string>();
    // Names first, so a variable whose id equals another's name still resolves to itself by id.
    variables.forEach(variable => { if (!keys.has(variable.name)) keys.set(variable.name, variable.id); });
    variables.forEach(variable => keys.set(variable.id, variable.id));
    return (nameOrId: string): string => keys.get(nameOrId) ?? nameOrId;
};

/** Options for a one-shot animation layered over the graph (see MontagePlayer). */
export type PlayMontageOptions = MontageOptions;

export const useGraphRuntime = (
    modelObject: THREE.Group,
    authoredGraph: AnimationGraphData,
    allClips: THREE.AnimationClip[],
    enableInputs: boolean,
    onActiveStateChange?: (id: string) => void,
    driveLocomotion: boolean = true,
    eventSource: string | null = null,
    /** Pose less often when far from the camera or out of view (characters other than the player). */
    lod: boolean = false
) => {
    // State machines nested in states play as one flat graph of their states.
    const graph = useMemo(() => flattenStateMachines(authoredGraph), [authoredGraph]);

    // 1. Central Data Store for Variables, keyed by variable id.
    const variablesRef = useRef<Record<string, number | boolean>>({});
    const resolve = useMemo(() => createVariableResolver(graph.variables), [graph.variables]);
    const resolveRef = useRef(resolve);
    resolveRef.current = resolve;
    const knownIdsRef = useRef<Set<string>>(new Set());

    // Seed new variables with their initial value and forget deleted ones.
    useEffect(() => {
        const ids = new Set(graph.variables.map(v => v.id));
        knownIdsRef.current.forEach(id => { if (!ids.has(id)) delete variablesRef.current[id]; });
        graph.variables.forEach(v => {
            if (variablesRef.current[v.id] === undefined) variablesRef.current[v.id] = v.value;
        });
        knownIdsRef.current = ids;
    }, [graph.variables]);

    const setVariable = useCallback((nameOrId: string, value: number | boolean) => {
        variablesRef.current[resolveRef.current(nameOrId)] = value;
    }, []);

    const getVariable = useCallback((nameOrId: string) => variablesRef.current[resolveRef.current(nameOrId)], []);

    const getVariables = useCallback(() => ({ ...variablesRef.current }), []);

    // 2. Sub-System Hooks (Separation of Concerns)

    // -- Graphics: Handles Three.js resources
    const rootMotionClipNames = useMemo(
        () => graph.states.filter(state => state.rootMotion && state.stateType === 'Single' && state.clipName).map(state => state.clipName as string),
        [graph.states]
    );
    const { mixer, actionsMap, clipsByName, rootMotions } = useAnimationMixer(modelObject, allClips, rootMotionClipNames);

    // -- One-shot layered animations
    const montageRef = useRef<MontagePlayer | null>(null);
    useEffect(() => {
        if (!mixer || !modelObject) return;
        const player = new MontagePlayer(mixer, modelObject);
        montageRef.current = player;
        return () => {
            player.dispose();
            if (montageRef.current === player) montageRef.current = null;
        };
    }, [mixer, modelObject]);

    const clipsByNameRef = useRef(clipsByName);
    clipsByNameRef.current = clipsByName;
    const playMontage = useCallback((clipName: string, options: PlayMontageOptions = {}): boolean => {
        const clip = clipsByNameRef.current[clipName];
        if (!clip || !montageRef.current) return false;
        montageRef.current.play(clip, options);
        return true;
    }, []);
    const stopMontage = useCallback((blendOut?: number) => { montageRef.current?.stop(blendOut); }, []);

    // -- Root motion: travel accumulates until the owner of the transform consumes it.
    const rootMotionRef = useRef(new THREE.Vector3());
    const consumeRootMotion = useCallback((out: THREE.Vector3 = new THREE.Vector3()) => {
        out.copy(rootMotionRef.current);
        rootMotionRef.current.set(0, 0, 0);
        return out;
    }, []);

    // -- Logic: Handles State Machine Transitions
    // A fresh reader whenever the states or clips change, so a live edit's clip reset is not read as a loop wrap.
    const getNormalizedTime = useMemo(() => createNormalizedTimeReader(graph.states, actionsMap), [graph.states, actionsMap]);
    const { activeStateRef, previousStateRef, blendDurationRef } = useGraphStateMachine(graph, variablesRef, onActiveStateChange, getNormalizedTime);

    // -- Inputs: Handles Keyboard -> Variable Mapping
    useInputHandler(graph, enableInputs, setVariable);

    // -- Physics: Handles Mesh Movement
    useGraphLocomotion(modelObject, graph, variablesRef, driveLocomotion);

    // -- Animation: Handles Weight Blending & Playback
    useGraphAnimator(mixer, actionsMap, graph, activeStateRef, previousStateRef, variablesRef, blendDurationRef, modelObject, {
        montage: montageRef,
        rootMotions,
        rootMotionOut: rootMotionRef,
        eventSource,
        lod,
    });

    // Without a character controller (the editor preview) the graph applies its own root motion.
    useFrame(() => {
        if (!driveLocomotion || !modelObject || rootMotionRef.current.lengthSq() === 0) return;
        const parent = modelObject.parent;
        const travel = consumeRootMotion();
        if (parent) {
            const start = parent.worldToLocal(modelObject.getWorldPosition(new THREE.Vector3()));
            const end = parent.worldToLocal(modelObject.getWorldPosition(new THREE.Vector3()).add(travel));
            modelObject.position.add(end.sub(start));
        } else {
            modelObject.position.add(travel);
        }
    });

    const getActiveState = useCallback(() => {
        const id = activeStateRef.current;
        return graph.states.find(state => state.id === id) ?? null;
    }, [activeStateRef, graph.states]);

    return { setVariable, getVariable, getVariables, playMontage, stopMontage, consumeRootMotion, getActiveState };
};
