import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationGraphData, GraphState } from '../../../types';
import { animationEvents } from '../../../runtime/animationEvents';
import { blendWeights1D, blendWeights2D, clampAnimationDelta, DEFAULT_BLEND_SECONDS, stepWeight } from '../utils/blending';
import type { MontagePlayer } from '../utils/montage';
import { crossedNotifies } from '../utils/notifies';
import { extractRootMotion, rootMotionDelta, type RootMotion } from '../utils/rootMotion';
import { actionPhase, syncBlendActions, syncLeader } from '../utils/syncGroups';
import { curveVariableValue } from '../utils/curves';
import { clipGroundSpeed, groundSpeedRate } from '../utils/groundSpeed';
import { HISTORY_TIMES, MotionMatcher, TRAJECTORY_TIMES, type MotionTrajectory, type Vec2 } from '../../../runtime/motionMatching';
import { motionDatabaseWhenReady } from '../../../runtime/motionDatabase';
import { findCharacterMotion, toCharacterSpace, type TrajectoryPoint } from '../../../runtime/locomotion/characterMotion';
import { DEFAULT_INERTIAL_HALF_LIFE, Inertializer } from '../../../runtime/locomotion/inertialization';
import { findBone } from '../../../runtime/ik';

/**
 * Animation runs before every other frame callback (priority -1), so IK, sockets and attachments
 * that read bones in the same frame see this frame's pose. A negative priority keeps R3F's own
 * render loop.
 */
export const ANIMATION_FRAME_PRIORITY = -1;
/**
 * Character controllers (input, movement, the graph variables they set) run before animation, so a
 * frame's pose answers that frame's input rather than the last one's.
 */
export const LOCOMOTION_FRAME_PRIORITY = ANIMATION_FRAME_PRIORITY - 0.5;
/**
 * Character IK runs after animation and timelines (TIMELINE_FRAME_PRIORITY), and before anything at the
 * default priority that reads the posed bones (a shot leaving the muzzle).
 */
export const CHARACTER_IK_FRAME_PRIORITY = ANIMATION_FRAME_PRIORITY + 0.75;

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
    /** The model's own clips by name (the mixer plays copies), so characters made from one model share what is built from them. */
    sourceClips?: Record<string, THREE.AnimationClip>;
    /** How the transition just taken meets its state (beside blendDurationRef); crossfade when left out. */
    blendModeRef?: React.MutableRefObject<'crossfade' | 'inertial'>;
    /**
     * The turn a Motion Match state's turn-in-place clip has made since last taken (radians, left
     * positive), for the character to turn by on the spot; null while none is turning it.
     */
    matchedTurnOut?: React.MutableRefObject<number | null>;
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
/** An inertial transition's offset fades over this share of its duration (a spring half-life). */
const INERTIAL_SHARE = 1 / 3;
/** The furthest orientation warping turns the hips from the clip's way of travel (radians). */
const MAX_WARP = THREE.MathUtils.degToRad(60);
/** Below this speed (in hips heights a second) a clip or a character is not going anywhere to warp toward. */
const WARP_SPEED = 0.2;
/** How quickly the warp follows a change in the angle, a second. */
const WARP_RATE = 12;
const UP = new THREE.Vector3(0, 1, 0);
const _warpBone = new THREE.Quaternion();
const _warpTurn = new THREE.Quaternion();
const _warpParent = new THREE.Quaternion();

/** Turns `bone` by `angle` radians about the world's up axis, its parent staying where it is. */
const turnAboutUp = (bone: THREE.Object3D, angle: number) => {
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_warpBone).premultiply(_warpTurn.setFromAxisAngle(UP, angle));
    if (bone.parent) bone.parent.getWorldQuaternion(_warpParent).invert();
    else _warpParent.identity();
    bone.quaternion.copy(_warpParent.multiply(_warpBone));
    bone.updateMatrixWorld(true);
};
const _groundVelocity = new THREE.Vector3();
const _modelQuaternion = new THREE.Quaternion();
const _future: TrajectoryPoint = { x: 0, z: 0, facing: 0 };
const _past: TrajectoryPoint = { x: 0, z: 0, facing: 0 };
const _trajectory: Required<MotionTrajectory> = {
    positions: TRAJECTORY_TIMES.map((): Vec2 => ({ x: 0, z: 0 })),
    facings: TRAJECTORY_TIMES.map(() => 0),
    past: HISTORY_TIMES.map((): Vec2 => ({ x: 0, z: 0 })),
};

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
    // `mirrored` are the database's mirrored clips; `actions` the action list their actions were added to.
    const matching = useRef({
        stateId: null as string | null,
        key: '',
        matcher: null as MotionMatcher | null,
        own: [] as THREE.AnimationClip[],
        mirrored: [] as THREE.AnimationClip[],
        actions: null as Record<string, THREE.AnimationAction> | null,
    });
    // Switches without a crossfade (motion matching's jumps, inertial transitions) fade out offsets on the model's bones.
    const inertia = useRef<{ model: THREE.Object3D | null; inertializer: Inertializer | null }>({ model: null, inertializer: null });
    // Seconds since the current state was entered, and whether it was entered by crossfading.
    const entry = useRef({ seconds: 0, crossfade: true });
    // Orientation warping: the hips and spine it turns, and the angle it turns them by now.
    const warp = useRef({ model: null as THREE.Object3D | null, hips: null as THREE.Object3D | null, spine: [] as THREE.Object3D[], angle: 0 });
    // The hips a matched clip's own turn is taken out of (see takeOutClipFacing below), found once per model.
    const facingHips = useRef({ model: null as THREE.Object3D | null, hips: null as THREE.Object3D | null });

    const blendModeRef = () => extras.blendModeRef?.current ?? 'crossfade';

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
        if (modelObject && inertia.current.model !== modelObject) {
            inertia.current.model = modelObject;
            inertia.current.inertializer = new Inertializer(modelObject);
        }
        const inertializer = inertia.current.inertializer;
        // Bones no clip moves would keep last frame's offset: they go back to the animation's own pose first.
        inertializer?.restore();
        // A switch this frame that the inertializer eases (none crossfades), and over how long.
        let switchHalfLife = 0;
        entry.current.seconds += delta;

        // 1. State entry: restart the entering state's clips with the transition's crossfade. A
        // state in the leaving state's sync group starts at its phase (a run picks up the walk's
        // stride where it was) instead of at the beginning.
        if (activeStateRef.current !== previousStateRef.current) {
            // Entering a Motion Match state searches afresh.
            if (matching.current.matcher) matching.current.matcher.clip = -1;
            const inertial = blendModeRef() === 'inertial' && !!inertializer && previousStateRef.current !== null;
            entry.current = { seconds: 0, crossfade: !inertial };
            if (inertial) switchHalfLife = Math.max(1e-3, blend * INERTIAL_SHARE);
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
                        if (!switchHalfLife) action.fadeIn(blend);
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
        // A character a controller moves knows its own velocity and where it is going.
        const locomotion = modelObject ? findCharacterMotion(modelObject) : undefined;
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
            if (locomotion) {
                // Exact rather than measured: no lag, and no jitter from uneven frames.
                ground.current.speed = locomotion.speed;
                ground.current.velocity.set(locomotion.body.vx, 0, locomotion.body.vz);
            }
        }
        // A Motion Match state picks the moment of its clips that best carries on the character's movement.
        let matched: string | null = null;
        if (locomotion) locomotion.matched = null;
        let matchedScale = 1;
        // Set when the action list was made anew under a playing match: its clip starts again where the matcher is.
        let resumeMatched = false;
        if (currentState?.stateType === 'MotionMatch' && modelObject) {
            const names = currentState.blendSamples.map(sample => sample.clipName).filter((name): name is string => !!name && !!actionsMap[name]);
            const key = `${currentState.id}|${names.join('|')}`;
            const match = matching.current;
            if (match.key !== key) {
                match.key = key;
                match.stateId = currentState.id;
                match.matcher = null;
                match.mirrored = [];
                match.actions = null;
                // Read from the model's own clips: the mixer plays copies with their travel taken out.
                match.own = names.map(name => extras.sourceClips?.[name] ?? actionsMap[name].getClip());
            }
            if (!match.matcher && match.own.length) {
                // Built in the background with each clip's mirrored copy; until then the state plays its first clip.
                const built = motionDatabaseWhenReady(modelObject, match.own);
                if (built?.database) {
                    match.mirrored = built.mirrored;
                    match.matcher = new MotionMatcher(built.database);
                }
            }
            if (match.matcher && match.actions !== actionsMap) {
                // A mirrored clip plays in place like the state's own clips. The action list is made anew when
                // the character's clips change (another model loading during play), so its mirrored actions are
                // added again, and the playing clip picks up where the matcher has got to.
                for (const clip of match.mirrored) {
                    if (actionsMap[clip.name]) continue;
                    const action = mixer.clipAction(extractRootMotion(clip, { root: modelObject })?.clip ?? clip);
                    action.enabled = false;
                    action.setEffectiveWeight(0);
                    actionsMap[clip.name] = action;
                }
                resumeMatched = match.actions !== null;
                match.actions = actionsMap;
            }
            if (match.matcher) {
                // The character's velocity in its own space and in its model's units (the database's).
                modelObject.getWorldQuaternion(_modelQuaternion).invert();
                matchedScale = modelObject.getWorldScale(_modelScale).x / (modelObject.scale.x || 1) || 1;
                _groundVelocity.copy(ground.current.velocity).applyQuaternion(_modelQuaternion).divideScalar(matchedScale);
                const velocity = { x: _groundVelocity.x, z: _groundVelocity.z };
                // Where the character's movement says it is going, seen from where it stands and faces now.
                let trajectory: typeof _trajectory | undefined;
                if (locomotion) {
                    TRAJECTORY_TIMES.forEach((time, i) => {
                        locomotion.predict(time, _future);
                        const at = toCharacterSpace(_future.x, _future.z, locomotion.body.x, locomotion.body.z, locomotion.facing.x, matchedScale);
                        _trajectory.positions[i].x = at.x;
                        _trajectory.positions[i].z = at.z;
                        _trajectory.facings[i] = _future.facing - locomotion.facing.x;
                    });
                    HISTORY_TIMES.forEach((time, i) => {
                        locomotion.past(time, _past);
                        const at = toCharacterSpace(_past.x, _past.z, locomotion.body.x, locomotion.body.z, locomotion.facing.x, matchedScale);
                        _trajectory.past[i].x = at.x;
                        _trajectory.past[i].z = at.z;
                    });
                    trajectory = _trajectory;
                }
                const wasClip = match.matcher.clip, wasTime = match.matcher.time;
                const choice = match.matcher.step(delta, velocity, velocity, 0, trajectory);
                // A clip turning on the spot turns the character by its own turn, so its feet step round with it
                // (just after a jump, by the turn the new clip made over this step).
                if (extras.matchedTurnOut && choice.clip >= 0) {
                    const db = match.matcher.database;
                    const travel = db.travelAt(choice.clip, choice.time);
                    const from = !choice.jumped && choice.clip === wasClip ? wasTime : Math.max(0, choice.time - delta);
                    if (Math.hypot(travel.x, travel.z) < WARP_SPEED * db.body) {
                        let turn = db.facingAt(choice.clip, choice.time) - db.facingAt(choice.clip, from);
                        // Across a loop's end the facing goes back to the start: that step is not turned.
                        if (Math.abs(turn) > Math.PI / 2) turn = 0;
                        extras.matchedTurnOut.current = (extras.matchedTurnOut.current ?? 0) + turn;
                    }
                }
                const clipName = choice.clip >= 0 ? match.matcher.database.clips[choice.clip].name : null;
                if (clipName && actionsMap[clipName]) {
                    matched = clipName;
                    if (locomotion) locomotion.matched = clipName;
                    if (choice.jumped || resumeMatched) {
                        // The jump cuts to the match at once; the inertializer eases the pose across (or,
                        // without one, it shows as a cut). A new action list starts the same way.
                        const action = actionsMap[clipName];
                        // A clip that plays once (a start, a stop, a turn round) holds its last pose until the next search.
                        const loops = match.matcher.database.loops(clipName);
                        action.reset();
                        action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, loops ? Infinity : 1);
                        action.clampWhenFinished = !loops;
                        action.time = choice.time;
                        action.play();
                        switchHalfLife = DEFAULT_INERTIAL_HALF_LIFE;
                    }
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
                // A clip that plays once (a start, a stop) keeps its own pace: its speed changes along it.
                rate *= groundSpeedRate(ground.current.speed, targetWeights, name => (database
                    ? (database.loops(name) ? database.clipSpeed(name) * matchedScale : 0)
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
        // A Motion Match state's clips take over at once (once a crossfade into the state has run), as does
        // a switch the inertializer eases.
        const instant = switchHalfLife > 0 || (currentState?.stateType === 'MotionMatch' && !!inertializer
            && (!entry.current.crossfade || entry.current.seconds >= blend));
        const nextWeights = stepActionWeights(currentWeights, targetWeights, delta, instant ? 0 : blend);

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

        // A matched clip plays with its travel taken out, and its turn is taken out the same way: the movement
        // turns the character, so a clip that turns round (or drifts off its line) would otherwise turn the body
        // a second time, away from where the character faces. Its steps and the sway of its hips stay. Done
        // after every pose the mixer makes, so the inertializer only ever sees the turned-back pose.
        const matchedAction = matched ? actionsMap[matched] : undefined;
        const matchedClip = matched ? matching.current.matcher?.clip ?? -1 : -1;
        const takeOutClipFacing = () => {
            const matcher = matching.current.matcher;
            if (!matchedAction || !matcher || matchedClip < 0 || !modelObject) return;
            const f = facingHips.current;
            if (f.model !== modelObject) {
                f.model = modelObject;
                f.hips = findBone(modelObject, 'Hips');
            }
            const weight = matchedAction.getEffectiveWeight();
            const facing = matcher.database.facingAt(matchedClip, matchedAction.time) * weight;
            if (f.hips && Math.abs(facing) > 1e-4) turnAboutUp(f.hips, -facing);
        };

        extras.montage?.current?.update(delta);
        mixer.update(delta);
        extras.montage?.current?.applyMeshSpaceRotation();
        takeOutClipFacing();
        if (inertializer) {
            if (switchHalfLife > 0) {
                // How fast the new pose moves: the clips a moment earlier, then back to now.
                if (delta > 0) {
                    const playing = Object.values(actionsMap).filter(action => action.enabled && action.getEffectiveWeight() > 0);
                    const times = playing.map(action => action.time);
                    playing.forEach(action => { action.time -= delta * action.timeScale; });
                    mixer.update(0);
                    extras.montage?.current?.applyMeshSpaceRotation();
                    takeOutClipFacing();
                    inertializer.noteBefore(delta);
                    playing.forEach((action, i) => { action.time = times[i]; });
                    mixer.update(0);
                    extras.montage?.current?.applyMeshSpaceRotation();
                    takeOutClipFacing();
                }
                inertializer.halfLife = switchHalfLife;
                inertializer.switchNow(delta);
            }
            inertializer.apply(delta);
        }

        // Orientation warping: a matched clip travelling another way than the character (a forward walk
        // played while moving diagonally) has its hips and legs turned toward the way the character goes,
        // and its spine turned back, so the steps fall where the character goes and the chest keeps its facing.
        if (modelObject) {
            const w = warp.current;
            if (w.model !== modelObject) {
                w.model = modelObject;
                w.hips = findBone(modelObject, 'Hips');
                w.spine = ['Spine', 'Spine1', 'Spine2'].map(name => findBone(modelObject, name)).filter((bone): bone is THREE.Object3D => !!bone);
                w.angle = 0;
            }
            let wanted = 0;
            const matcher = matching.current.matcher;
            // Only while the character faces somewhere other than its way (aiming): turning, it faces where it goes.
            if (currentState?.stateType === 'MotionMatch' && locomotion?.strafing && matcher && matcher.clip >= 0) {
                const clipWay = matcher.database.travelAt(matcher.clip, matcher.time);
                const body = matcher.database.body * matchedScale;
                const going = toCharacterSpace(locomotion.body.x + locomotion.body.vx, locomotion.body.z + locomotion.body.vz, locomotion.body.x, locomotion.body.z, locomotion.facing.x);
                if (Math.hypot(clipWay.x, clipWay.z) * matchedScale > WARP_SPEED * body && Math.hypot(going.x, going.z) > WARP_SPEED * body) {
                    const turn = Math.atan2(going.x, going.z) - Math.atan2(clipWay.x, clipWay.z);
                    wanted = THREE.MathUtils.clamp(Math.atan2(Math.sin(turn), Math.cos(turn)), -MAX_WARP, MAX_WARP);
                }
            }
            w.angle += (wanted - w.angle) * (1 - Math.exp(-WARP_RATE * delta));
            if (w.hips && Math.abs(w.angle) > 1e-4) {
                turnAboutUp(w.hips, w.angle);
                for (const bone of w.spine) turnAboutUp(bone, -w.angle / w.spine.length);
            }
        }
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
