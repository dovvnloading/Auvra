import React, { useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData, GraphState } from '../../../types';
import { animationEvents } from '../../../runtime/animationEvents';
import { blendWeights1D, blendWeights2D, clampAnimationDelta, DEFAULT_BLEND_SECONDS, stepWeight } from '../utils/blending';
import type { MontagePlayer } from '../utils/montage';
import { crossedNotifies } from '../utils/notifies';
import { rootMotionDelta, type RootMotion } from '../utils/rootMotion';

/**
 * Animation runs before every other frame callback (priority -1), so IK, sockets and attachments
 * that read bones in the same frame see this frame's pose. A negative priority keeps R3F's own
 * render loop.
 */
export const ANIMATION_FRAME_PRIORITY = -1;

/**
 * Steps every action's weight linearly toward its target, then rescales the results so they add
 * up to the targets' total. Stepping each weight on its own lets the sum drop below 1 when several
 * clips fade out at once (an interrupted crossfade, or a Blend2D whose weights shift unevenly), and
 * three's PropertyMixer fills that shortfall with the bind pose. A state with no clips (target
 * total 0) is not rescaled, so it still fades out to rest.
 */
export const stepActionWeights = (
    current: Record<string, number>,
    targets: Record<string, number>,
    delta: number,
    blend: number
): Record<string, number> => {
    const next: Record<string, number> = {};
    let total = 0;
    let targetTotal = 0;
    Object.keys(current).forEach((name) => {
        const target = targets[name] || 0;
        next[name] = stepWeight(current[name], target, delta, blend);
        total += next[name];
        targetTotal += target;
    });
    if (targetTotal > 0 && total > 1e-6) {
        const scale = targetTotal / total;
        Object.keys(next).forEach((name) => { next[name] *= scale; });
    }
    return next;
};

const finiteNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * A state's playback speed: its play rate (default 1) times the value of its play-rate variable
 * when it has one. A boolean variable counts as 1 or 0.
 */
export const statePlayRate = (state: Pick<GraphState, 'playRate' | 'playRateParam'>, variables: Record<string, number | boolean>): number => {
    const base = finiteNumber(state.playRate, 1);
    if (!state.playRateParam) return base;
    const value = variables[state.playRateParam];
    const factor = typeof value === 'boolean' ? (value ? 1 : 0) : finiteNumber(value, 1);
    return base * factor;
};

/** Target weight per clip name for a state, given the graph variables. */
export const stateTargetWeights = (
    state: GraphState,
    variables: Record<string, number | boolean>,
    hasClip: (name: string) => boolean
): Record<string, number> => {
    const targets: Record<string, number> = {};
    if (state.stateType === 'Single') {
        if (state.clipName && hasClip(state.clipName)) targets[state.clipName] = 1;
        return targets;
    }
    const x = finiteNumber(variables[state.blendParamX], 0);
    const weights = state.stateType === 'Blend1D'
        ? blendWeights1D(state.blendSamples, x)
        : blendWeights2D(state.blendSamples, x, finiteNumber(variables[state.blendParamY], 0));
    state.blendSamples.forEach((sample, index) => {
        if (sample.clipName && hasClip(sample.clipName)) targets[sample.clipName] = (targets[sample.clipName] || 0) + (weights[index] || 0);
    });
    return targets;
};

/** Optional per-character systems the animator drives alongside the base state machine. */
export interface AnimatorExtras {
    montage?: React.MutableRefObject<MontagePlayer | null>;
    rootMotions?: Record<string, RootMotion>;
    /** World-space root travel waiting for the character controller (or the preview) to apply. */
    rootMotionOut?: React.MutableRefObject<THREE.Vector3>;
    /** Who raises this character's notifies (a level object id, 'player', or null). */
    eventSource?: string | null;
}

const _rootDelta = new THREE.Vector3();
const _rootBasis = new THREE.Matrix3();

const rootBoneParent = (modelObject: THREE.Object3D, motion: RootMotion): THREE.Object3D | null => {
    const { nodeName } = THREE.PropertyBinding.parseTrackName(motion.track.name);
    return modelObject.getObjectByName(nodeName)?.parent ?? null;
};

export const useGraphAnimator = (
    mixer: THREE.AnimationMixer | null,
    actionsMap: Record<string, THREE.AnimationAction>,
    graph: AnimationGraphData,
    activeStateRef: React.MutableRefObject<string | null>,
    previousStateRef: React.MutableRefObject<string | null>,
    variablesRef: React.MutableRefObject<Record<string, number | boolean>>,
    blendDurationRef?: React.MutableRefObject<number>,
    modelObject?: THREE.Object3D | null,
    extras: AnimatorExtras = {}
) => {

    // -- LIVE EDIT WATCHER --
    // When the user changes the clip or loop setting of the state that is playing, restart it so
    // the change shows immediately.
    const activeStateId = activeStateRef.current;
    const activeState = graph.states.find(s => s.id === activeStateId);
    const activeClipName = activeState?.stateType === 'Single' ? activeState.clipName : null;
    const activeLoop = activeState?.loop;
    const activeStateType = activeState?.stateType;

    useEffect(() => {
        if (!activeClipName || !actionsMap[activeClipName]) return;
        const action = actionsMap[activeClipName];
        action.reset();
        action.fadeIn(DEFAULT_BLEND_SECONDS);
        action.setLoop(activeLoop ? THREE.LoopRepeat : THREE.LoopOnce, activeLoop ? Infinity : 1);
        action.play();
    }, [activeClipName, activeLoop, activeStateType, actionsMap]);


    // -- FRAME LOOP --
    useFrame((_state, rawDelta) => {
        if (!mixer) return;
        const delta = clampAnimationDelta(rawDelta);
        const blend = blendDurationRef?.current ?? DEFAULT_BLEND_SECONDS;
        const variables = variablesRef.current;

        // 1. State entry: restart the entering state's clips with the transition's crossfade.
        if (activeStateRef.current !== previousStateRef.current) {
            const enteringState = graph.states.find(s => s.id === activeStateRef.current);
            if (enteringState) {
                const initClip = (name: string, loop: boolean) => {
                    const action = actionsMap[name];
                    if (action) {
                        action.reset();
                        action.fadeIn(blend);
                        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
                        action.play();
                    }
                };

                if (enteringState.stateType === 'Single' && enteringState.clipName) {
                    initClip(enteringState.clipName, enteringState.loop);
                } else if (enteringState.stateType !== 'Single') {
                    enteringState.blendSamples.forEach(sample => {
                        if (sample.clipName) initClip(sample.clipName, true);
                    });
                }
            }
            previousStateRef.current = activeStateRef.current;
        }

        // 2. Target weights and playback speed of the current state.
        const currentState = graph.states.find(s => s.id === activeStateRef.current);
        const targetWeights = currentState ? stateTargetWeights(currentState, variables, name => !!actionsMap[name]) : {};
        if (currentState) {
            const rate = statePlayRate(currentState, variables);
            Object.keys(targetWeights).forEach(name => { actionsMap[name].timeScale = rate; });
        }

        // 3. Crossfade the weights (frame-rate independent, summing to 1 so the bind pose never
        // bleeds through) and run the mixer.
        const currentWeights: Record<string, number> = {};
        Object.keys(actionsMap).forEach((name) => {
            currentWeights[name] = actionsMap[name].getEffectiveWeight();
        });
        const nextWeights = stepActionWeights(currentWeights, targetWeights, delta, blend);

        Object.keys(actionsMap).forEach((name) => {
            const action = actionsMap[name];
            const target = targetWeights[name] || 0;
            const next = nextWeights[name];
            action.setEffectiveWeight(next);
            if (next > 0.001 || target > 0) {
                action.enabled = true;
                if (!action.isRunning()) action.play();
            } else {
                action.enabled = false;
            }
        });

        // A Single state's clip is followed across the update for notifies and root motion.
        const tracked = currentState?.stateType === 'Single' && currentState.clipName ? actionsMap[currentState.clipName] : undefined;
        const before = tracked ? tracked.time : 0;

        extras.montage?.current?.update(delta);
        mixer.update(delta);

        if (!currentState || !tracked) return;
        const clipName = currentState.clipName as string;
        const duration = tracked.getClip().duration;
        const after = tracked.time;

        if (currentState.notifies?.length && duration > 0) {
            crossedNotifies(currentState.notifies, before, after, duration, currentState.loop, tracked.timeScale).forEach(notify => {
                animationEvents.emit({ objectId: extras.eventSource ?? null, stateName: currentState.name, name: notify.name });
            });
        }

        const motion = currentState.rootMotion ? extras.rootMotions?.[clipName] : undefined;
        if (motion && extras.rootMotionOut && modelObject) {
            rootMotionDelta(motion, before, after, currentState.loop, _rootDelta);
            const parent = rootBoneParent(modelObject, motion);
            if (parent) {
                parent.updateWorldMatrix(true, false);
                _rootDelta.applyMatrix3(_rootBasis.setFromMatrix4(parent.matrixWorld));
            }
            _rootDelta.y = 0;
            extras.rootMotionOut.current.addScaledVector(_rootDelta, tracked.getEffectiveWeight());
        }
    }, ANIMATION_FRAME_PRIORITY);
};
