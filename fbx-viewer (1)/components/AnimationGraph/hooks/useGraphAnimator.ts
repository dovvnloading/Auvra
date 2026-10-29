import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData, GraphState } from '../../../types';
import { animationEvents } from '../../../runtime/animationEvents';
import { blendWeights1D, blendWeights2D, clampAnimationDelta, DEFAULT_BLEND_SECONDS, stepWeight } from '../utils/blending';
import type { MontagePlayer } from '../utils/montage';
import { crossedNotifies } from '../utils/notifies';
import { rootMotionDelta, type RootMotion } from '../utils/rootMotion';
import { actionPhase, syncBlendActions, syncLeader } from '../utils/syncGroups';
import { curveVariableValue } from '../utils/curves';
import { clipGroundSpeed, groundSpeedRate } from '../utils/groundSpeed';
import { MotionMatcher } from '../../../runtime/motionMatching';
import { motionDatabaseFor } from '../../../runtime/motionDatabase';

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

/**
 * Target weight per clip name for a state, given the graph variables. A Motion Match state plays the
 * clip its matcher chose (`matched`), else its first.
 */
export const stateTargetWeights = (
    state: GraphState,
    variables: Record<string, number | boolean>,
    hasClip: (name: string) => boolean,
    matched: string | null = null,
): Record<string, number> => {
    const targets: Record<string, number> = {};
    if (state.stateType === 'Single') {
        if (state.clipName && hasClip(state.clipName)) targets[state.clipName] = 1;
        return targets;
    }
    if (state.stateType === 'MotionMatch') {
        const name = matched && hasClip(matched) ? matched : state.blendSamples.find(sample => sample.clipName && hasClip(sample.clipName))?.clipName;
        if (name) targets[name] = 1;
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

/**
 * Where a state is in its cycle (0..1): its clip's phase, or the heaviest blend sample's. 0 when
 * none of its clips is loaded.
 */
export const statePhase = (
    state: GraphState,
    variables: Record<string, number | boolean>,
    actionsMap: Record<string, THREE.AnimationAction>
): number => {
    const lead = state.stateType === 'Single'
        ? state.clipName
        : syncLeader(stateTargetWeights(state, variables, name => !!actionsMap[name]));
    return lead && actionsMap[lead] ? actionPhase(actionsMap[lead]) : 0;
};

/** Optional per-character systems the animator drives alongside the base state machine. */
export interface AnimatorExtras {
    montage?: React.MutableRefObject<MontagePlayer | null>;
    rootMotions?: Record<string, RootMotion>;
    /** World-space root travel waiting for the character controller (or the preview) to apply. */
    rootMotionOut?: React.MutableRefObject<THREE.Vector3>;
    /** Who raises this character's notifies (a level object id, 'player', or null). */
    eventSource?: string | null;
    /** Pose less often when far from the camera or out of view (see animationUpdateInterval). */
    lod?: boolean;
}

/** Roughly a character's size, for telling whether it is on screen. */
const LOD_VIEW_RADIUS = 4;

/**
 * Every how many frames a character is posed: every frame up close, less often with distance (in
 * world units, where characters are about 5 tall), and every 8th frame when off screen.
 */
export const animationUpdateInterval = (distance: number, inView: boolean): number => {
    if (!inView) return 8;
    if (distance < 30) return 1;
    if (distance < 60) return 2;
    if (distance < 120) return 3;
    return 4;
};

const _lodPosition = new THREE.Vector3();
const _lodSphere = new THREE.Sphere();
const _lodFrustum = new THREE.Frustum();
const _lodMatrix = new THREE.Matrix4();

const _rootDelta = new THREE.Vector3();
const _groundAt = new THREE.Vector3();
const _modelScale = new THREE.Vector3();
/** How quickly the measured ground speed follows the character's movement, per second. */
const GROUND_SPEED_RATE = 10;
/** Seconds a Motion Match state crossfades over when it jumps to another clip. */
export const MOTION_MATCH_BLEND = 0.2;
const _groundVelocity = new THREE.Vector3();
const _modelQuaternion = new THREE.Quaternion();
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


    // Time not yet given to the mixer by a character posed less often (extras.lod).
    const lodPending = useRef({ delta: 0, frames: 0 });
    // How fast the character is moving over the ground (world units a second), for states that match it.
    const ground = useRef({ speed: 0, last: null as THREE.Vector3 | null, velocity: new THREE.Vector3() });
    // A Motion Match state's matcher, made for its clips on this model when it is first played.
    const matching = useRef({ stateId: null as string | null, key: '', matcher: null as MotionMatcher | null });

    // -- FRAME LOOP --
    useFrame((state, rawDelta) => {
        if (!mixer) return;
        let delta = clampAnimationDelta(rawDelta);
        if (extras.lod && modelObject) {
            // A distant or off-screen character skips frames; the time it skipped is played on the
            // next one, so its clips keep their pace and its transitions still fire.
            modelObject.getWorldPosition(_lodPosition);
            const camera = state.camera;
            _lodFrustum.setFromProjectionMatrix(_lodMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
            const inView = _lodFrustum.intersectsSphere(_lodSphere.set(_lodPosition, LOD_VIEW_RADIUS));
            const interval = animationUpdateInterval(_lodPosition.distanceTo(camera.position), inView);
            const pending = lodPending.current;
            pending.delta += delta;
            pending.frames += 1;
            if (pending.frames < interval) return;
            delta = pending.delta;
            pending.delta = 0;
            pending.frames = 0;
        }
        const blend = blendDurationRef?.current ?? DEFAULT_BLEND_SECONDS;
        const variables = variablesRef.current;

        // 1. State entry: restart the entering state's clips with the transition's crossfade. A
        // state in the leaving state's sync group starts at its phase (a run picks up the walk's
        // stride where it was) instead of at the beginning.
        if (activeStateRef.current !== previousStateRef.current) {
            // Entering a Motion Match state searches afresh.
            if (matching.current.matcher) matching.current.matcher.clip = -1;
            const enteringState = graph.states.find(s => s.id === activeStateRef.current);
            const leavingState = graph.states.find(s => s.id === previousStateRef.current);
            if (enteringState) {
                const synced = !!enteringState.syncGroup && enteringState.syncGroup === leavingState?.syncGroup;
                const startPhase = synced && leavingState ? statePhase(leavingState, variables, actionsMap) : 0;
                const initClip = (name: string, loop: boolean) => {
                    const action = actionsMap[name];
                    if (action) {
                        action.reset();
                        action.time = startPhase * action.getClip().duration;
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

        // 2. Target weights and playback speed of the current state; a blend's samples run in step.
        const currentState = graph.states.find(s => s.id === activeStateRef.current);
        if (modelObject) {
            modelObject.getWorldPosition(_groundAt);
            const last = ground.current.last;
            if (last && delta > 0) {
                const moved = Math.hypot(_groundAt.x - last.x, _groundAt.z - last.z) / delta;
                const ease = 1 - Math.exp(-GROUND_SPEED_RATE * delta);
                ground.current.speed += (moved - ground.current.speed) * ease;
                _groundVelocity.set((_groundAt.x - last.x) / delta, 0, (_groundAt.z - last.z) / delta);
                ground.current.velocity.lerp(_groundVelocity, ease);
                last.copy(_groundAt);
            } else {
                ground.current.last = _groundAt.clone();
            }
        }
        // A Motion Match state picks the moment of its clips that best carries on the character's movement.
        let matched: string | null = null;
        let matchedScale = 1;
        if (currentState?.stateType === 'MotionMatch' && modelObject) {
            const names = currentState.blendSamples.map(sample => sample.clipName).filter((name): name is string => !!name && !!actionsMap[name]);
            const key = `${currentState.id}|${names.join('|')}`;
            const match = matching.current;
            if (match.key !== key) {
                match.key = key;
                match.stateId = currentState.id;
                const database = names.length ? motionDatabaseFor(modelObject, names.map(name => actionsMap[name].getClip())) : null;
                match.matcher = database ? new MotionMatcher(database) : null;
            }
            if (match.matcher) {
                // The character's velocity in its own space and in its model's units (the database's).
                modelObject.getWorldQuaternion(_modelQuaternion).invert();
                matchedScale = modelObject.getWorldScale(_modelScale).x / (modelObject.scale.x || 1) || 1;
                _groundVelocity.copy(ground.current.velocity).applyQuaternion(_modelQuaternion).divideScalar(matchedScale);
                const velocity = { x: _groundVelocity.x, z: _groundVelocity.z };
                const choice = match.matcher.step(delta, velocity, velocity, 0);
                matched = choice.clip >= 0 ? match.matcher.database.clips[choice.clip].name : null;
                const action = matched ? actionsMap[matched] : undefined;
                if (action && choice.jumped) {
                    // A clip fading back in starts where the match is; one already showing moves there.
                    if (action.getEffectiveWeight() < 0.01) action.reset();
                    action.setLoop(THREE.LoopRepeat, Infinity);
                    action.time = choice.time;
                    action.play();
                }
            }
        }
        const targetWeights = currentState ? stateTargetWeights(currentState, variables, name => !!actionsMap[name], matched) : {};
        if (currentState) {
            let rate = statePlayRate(currentState, variables);
            if (currentState.matchSpeed && !currentState.rootMotion && modelObject) {
                // Played at the rate that carries the character at the speed it is really moving.
                const scale = modelObject.getWorldScale(_modelScale).x;
                // A Motion Match state has its clips' speeds in its database, where a clip standing still has none.
                const database = matched ? matching.current.matcher?.database : undefined;
                rate *= groundSpeedRate(ground.current.speed, targetWeights, name => (database
                    ? database.clipSpeed(name) * matchedScale
                    : clipGroundSpeed(modelObject, actionsMap[name].getClip()) * scale));
            }
            if (currentState.stateType === 'Single' || currentState.stateType === 'MotionMatch') {
                Object.keys(targetWeights).forEach(name => { actionsMap[name].timeScale = rate; });
            } else {
                syncBlendActions(actionsMap, targetWeights, rate);
            }
        }

        // 3. Crossfade the weights (frame-rate independent, summing to 1 so the bind pose never
        // bleeds through) and run the mixer.
        const currentWeights: Record<string, number> = {};
        Object.keys(actionsMap).forEach((name) => {
            currentWeights[name] = actionsMap[name].getEffectiveWeight();
        });
        const nextWeights = stepActionWeights(currentWeights, targetWeights, delta, matched ? MOTION_MATCH_BLEND : blend);

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
        extras.montage?.current?.applyMeshSpaceRotation();
        // The matcher keeps to the time the chosen clip has really reached.
        if (matched && matching.current.matcher && actionsMap[matched]) matching.current.matcher.time = actionsMap[matched].time;

        if (!currentState || !tracked) return;
        const clipName = currentState.clipName as string;
        const duration = tracked.getClip().duration;
        const after = tracked.time;

        // Curves drive their variables from the clip's time, ready for this frame's transitions.
        currentState.curves?.forEach(curve => {
            if (!curve.variableId || !curve.keys.length) return;
            const type = graph.variables.find(variable => variable.id === curve.variableId)?.type;
            variables[curve.variableId] = curveVariableValue(curve, after, type);
        });

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
