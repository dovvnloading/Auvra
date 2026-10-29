import React, { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { ANIMATION_FRAME_PRIORITY } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelComponent } from '../../types';
import { cinematics, PlayerClipsContext } from '../cinematics';
import { useGameContent } from '../GameContentContext';
import { IKPoseGuard } from '../ik';
import { levelVariables } from '../levelVariables';
import { SpatialPositionalAudio } from '../spatialAudio';
import {
    crossedTimelineEvents,
    crossedTimelineSounds,
    evaluateTimeline,
    INITIAL_TIMELINE_PLAYBACK,
    isTimelinePlayValue,
    normalizeTimeline,
    stepTimelinePlayback,
    TIMELINE_COMPONENT_TYPE,
    timelineTargetIds,
    type TimelineEvaluation,
    type TimelinePlayback,
    type TimelineSoundStart,
} from '../timeline/evaluate';
import { timelineEvents } from '../timeline/events';
import { timelinePreview } from '../timeline/preview';
import { ClipPoser, poseLayers, type PoseLayer } from '../timeline/poser';
import { TIMELINE_PLAYER_TARGET } from '../timeline/types';
import { cameraDirector } from '../cameraDirector';
import { acquireAudioListener, findAudioAsset, isAudioBus, releaseSound, routeSoundToBus, useRuntimeMixer, type Sound } from './audioComponents';
import { ComponentHostContext } from './builtins';
import { IKPlayerTargetContext, useRestoreBeforeAnimation } from './ikComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/** Longest step playback takes in one frame, so resuming from a pause or a stalled tab does not jump. */
const MAX_FRAME_STEP = 0.1;

/** Fastest playback rate the inspector offers. */
const MAX_TIMELINE_SPEED = 10;

/** Seconds between scene searches for targets that are still missing (destroyed, or not drawn as their own group). */
const TARGET_RETRY_INTERVAL = 0.5;

/**
 * Timelines run after the characters' animation (so their clips lie over its pose) and before IK and
 * the procedural rig (which work on the result).
 */
export const TIMELINE_FRAME_PRIORITY = ANIMATION_FRAME_PRIORITY + 0.5;

const TIMELINE_DEFAULTS = { autoplay: true, loop: false, speed: 1, playVariable: '', cinematic: false, skippable: true, holdEnd: false };

export interface TimelineSettings {
    autoplay: boolean;
    loop: boolean;
    /** Playback rate, 0..MAX_TIMELINE_SPEED. */
    speed: number;
    /** Trimmed level variable name; empty when playback follows autoplay instead. */
    playVariable: string;
    /** While it plays: letterbox, HUD hidden, the player's controls taken. */
    cinematic: boolean;
    /** A cinematic the player can skip to its end. */
    skippable: boolean;
    /** Once finished, characters keep the timeline's last pose instead of going back to their own animation. */
    holdEnd: boolean;
}

const readNumber = (component: LevelComponent, key: string, fallback: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const readString = (component: LevelComponent, key: string, fallback: string): string => {
    const value = component.props[key];
    return typeof value === 'string' ? value : fallback;
};

/** A timeline component's playback settings, with stored values checked and clamped. */
export const readTimelineSettings = (component: LevelComponent): TimelineSettings => ({
    autoplay: readBoolean(component, 'autoplay', TIMELINE_DEFAULTS.autoplay),
    loop: readBoolean(component, 'loop', TIMELINE_DEFAULTS.loop),
    speed: Math.min(MAX_TIMELINE_SPEED, Math.max(0, readNumber(component, 'speed', TIMELINE_DEFAULTS.speed))),
    playVariable: readString(component, 'playVariable', TIMELINE_DEFAULTS.playVariable).trim(),
    cinematic: readBoolean(component, 'cinematic', TIMELINE_DEFAULTS.cinematic),
    skippable: readBoolean(component, 'skippable', TIMELINE_DEFAULTS.skippable),
    holdEnd: readBoolean(component, 'holdEnd', TIMELINE_DEFAULTS.holdEnd),
});

/** The end as characters hold it: a hair before the last instant, where a clip running to the end still plays. */
const holdTime = (duration: number) => Math.max(0, duration - 1e-4);

/** Localization key of a subtitle line: the timeline's object, its track and the key's time in milliseconds. */
export const timelineLineKey = (objectId: string, trackId: string, at: number): string => `timeline.${objectId}.${trackId}.${at}`;

const isInScene = (node: THREE.Object3D, scene: THREE.Object3D): boolean => {
    for (let current: THREE.Object3D | null = node; current; current = current.parent) {
        if (current === scene) return true;
    }
    return false;
};

/**
 * Adds to `found` the transform group of each id in `ids` it does not hold yet: the outermost node whose
 * userData.levelObjectId is that id, which in a play session is the group the object is drawn in.
 */
const findTargets = (scene: THREE.Object3D, ids: readonly string[], found: Map<string, THREE.Object3D>) => {
    const wanted = new Set(ids.filter(id => !found.has(id)));
    if (wanted.size === 0) return;
    // traverse visits parents before their children, so the first match is the outermost one.
    scene.traverse(node => {
        const id: unknown = node.userData?.levelObjectId;
        if (typeof id === 'string' && wanted.has(id)) {
            wanted.delete(id);
            found.set(id, node);
        }
    });
};

/** Writes one evaluation to the session: transforms and visibility on the targets' groups, variables to the level store. */
const applyTimeline = (evaluation: TimelineEvaluation, resolve: (objectId: string) => THREE.Object3D | null) => {
    for (const sample of evaluation.transforms) {
        const target = resolve(sample.objectId);
        if (!target) continue;
        if (sample.position) target.position.fromArray(sample.position);
        if (sample.rotation) target.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2]);
        if (sample.scale) target.scale.fromArray(sample.scale);
    }
    for (const { objectId, visible } of evaluation.visibility) {
        const target = resolve(objectId);
        if (target) target.visible = visible;
    }
    for (const { name, value } of evaluation.variables) levelVariables.set(name, value);
};

/** A character's model inside its group (the group's child that is not a nested level object), else the group. */
export const characterRoot = (group: THREE.Object3D): THREE.Object3D =>
    group.children.find(child => child.userData.levelObjectId === undefined && child.type !== 'Audio' && child.type !== 'PositionalAudio') ?? group;

/**
 * Poses characters from an evaluation's clips, through one pose guard: bones are given back their own
 * pose before the next frame's animation, and bones no clip moves any more keep theirs.
 */
export class TimelineCharacters {
    private readonly posers = new WeakMap<THREE.Object3D, ClipPoser>();
    readonly guard = new IKPoseGuard();

    pose(evaluation: TimelineEvaluation, resolve: (objectId: string) => { root: THREE.Object3D; clips: readonly THREE.AnimationClip[] } | null): void {
        const jobs: Array<{ poser: ClipPoser; layers: PoseLayer[] }> = [];
        const bones: THREE.Object3D[] = [];
        for (const sample of evaluation.animations) {
            const character = resolve(sample.objectId);
            if (!character) continue;
            const layers = poseLayers(character.clips, sample.clips);
            if (layers.length === 0) continue;
            let poser = this.posers.get(character.root);
            if (!poser) {
                poser = new ClipPoser(character.root);
                this.posers.set(character.root, poser);
            }
            bones.push(...poser.nodes(layers));
            jobs.push({ poser, layers });
        }
        this.guard.begin(bones);
        for (const job of jobs) job.poser.apply(job.layers);
        this.guard.commit();
    }

    /** Hands every bone back to its own animation. */
    release(): void {
        this.guard.release();
    }
}

interface PlayingSound {
    sound: Sound;
    /** Timeline seconds left before it stops. */
    left: number;
    release: () => void;
}

/** Decoded sounds by url, shared by every timeline. */
const buffers = new Map<string, Promise<AudioBuffer>>();
const loadBuffer = (url: string): Promise<AudioBuffer> => {
    let buffer = buffers.get(url);
    if (!buffer) {
        buffer = new THREE.AudioLoader().loadAsync(url);
        buffers.set(url, buffer);
        buffer.catch(() => buffers.delete(url));
    }
    return buffer;
};

/**
 * Plays the timeline in a play session. Targets are moved and hidden through the transform groups the
 * session draws them in (the owner through its host group), like Mover and Rotator move their owner, so
 * the project and the session's object list are never written. Characters play its clips over their own
 * animation, its sounds play from their objects, and its subtitles, fades and cinematic state go to the
 * cinematics store for the overlay. A paused timeline holds its characters' pose; a finished one gives
 * them back to their own animation and leaves its other targets where it last put them.
 */
const TimelinePlayer: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const host = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const playerClips = useContext(PlayerClipsContext);
    const { models, audioAssets } = useGameContent();
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const mixer = useRuntimeMixer();
    const stored = component.props.timeline;
    const data = useMemo(() => normalizeTimeline(stored), [stored]);
    const targetIds = useMemo(() => timelineTargetIds(data), [data]);
    const { autoplay, loop, speed, playVariable, cinematic, skippable, holdEnd } = readTimelineSettings(component);

    const playback = useRef<Readonly<TimelinePlayback>>(INITIAL_TIMELINE_PLAYBACK);
    const groups = useRef(new Map<string, THREE.Object3D>());
    const sinceSearch = useRef(Number.POSITIVE_INFINITY);
    const reportedMissing = useRef(new Set<string>());
    const last = useRef<TimelineEvaluation | null>(null);
    const sounds = useRef<PlayingSound[]>([]);
    // Skips asked for before this timeline started are not for it.
    const skipsSeen = useRef(0);
    const [characters] = useState(() => new TimelineCharacters());
    useRestoreBeforeAnimation(characters.guard);
    // The camera this timeline cut to, given back to the gameplay camera when the timeline goes away.
    const shot = useRef<string | null>(null);

    const stopSounds = () => {
        for (const playing of sounds.current) {
            releaseSound(playing.sound);
            playing.sound.removeFromParent();
            playing.release();
        }
        sounds.current = [];
    };

    useEffect(() => () => {
        if (shot.current && cameraDirector.activeId() === shot.current) cameraDirector.setActive(null, 0);
        stopSounds();
        characters.release();
        cinematics.set(object.id, null);
    // Runs once, when the timeline goes away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const resolve = (id: string): THREE.Object3D | null => {
        const owner = host?.current ?? null;
        if (owner && id === object.id) return owner;
        if (id === TIMELINE_PLAYER_TARGET) return playerRef?.current ?? null;
        return groups.current.get(id) ?? null;
    };

    const resolveCharacter = (id: string) => {
        if (id === TIMELINE_PLAYER_TARGET) {
            const player = playerRef?.current;
            return player ? { root: player, clips: playerClips } : null;
        }
        const group = resolve(id);
        if (!group) return null;
        const modelId = group.userData?.modelId;
        const clips = typeof modelId === 'string' ? models.find(model => model.id === modelId)?.animations ?? [] : [];
        return { root: characterRoot(group), clips };
    };

    const startSound = (start: TimelineSoundStart, now: number) => {
        const url = findAudioAsset(audioAssets, start.sound)?.url;
        if (!url) {
            frontendDiagnostics.warning('runtime_timeline_sound_missing');
            return;
        }
        const parent = start.objectId ? resolve(start.objectId) : null;
        const { listener, release } = acquireAudioListener(camera);
        const sound: Sound = parent ? new SpatialPositionalAudio(listener) : new THREE.Audio(listener);
        parent?.add(sound);
        sound.setVolume(start.volume);
        routeSoundToBus(sound, mixer, isAudioBus(start.bus) ? start.bus : 'sfx');
        const playing: PlayingSound = { sound, left: start.until - now, release };
        sounds.current.push(playing);
        const requested = performance.now();
        loadBuffer(url).then(buffer => {
            if (!sounds.current.includes(playing)) return;
            // The time spent loading counts, so a sound that loads late is still in step.
            const offset = start.from + (performance.now() - requested) / 1000;
            if (offset >= buffer.duration) return;
            sound.setBuffer(buffer);
            sound.offset = offset;
            sound.play();
        }).catch(error => frontendDiagnostics.failure('runtime_timeline_sound_failed', error));
    };

    /**
     * At the end (reached or skipped to): sounds stop, characters hold the end or go back to their own
     * animation, and a cinematic gives the view back to the gameplay camera with the controls.
     */
    const finish = () => {
        stopSounds();
        if (cinematic && shot.current && cameraDirector.activeId() === shot.current) {
            cameraDirector.setActive(null, 0);
            shot.current = '';
        }
        if (holdEnd) {
            last.current = evaluateTimeline(data, holdTime(data.duration));
            characters.pose(last.current, resolveCharacter);
        } else {
            characters.release();
        }
    };

    const publish = (evaluation: TimelineEvaluation | null, finished: boolean) => {
        const line = evaluation?.subtitle;
        cinematics.set(object.id, {
            cinematic: cinematic && !finished,
            skippable: cinematic && skippable && !finished,
            fade: evaluation?.fade && evaluation.fade.amount > 0 ? evaluation.fade : null,
            subtitle: line && !finished ? { speaker: line.speaker, text: line.text, key: timelineLineKey(object.id, line.trackId, line.at) } : null,
        });
    };

    const cut = (evaluation: TimelineEvaluation) => {
        // Camera keys cut the view; a cut to the shot already showing does nothing.
        if (evaluation.camera && evaluation.camera.objectId !== shot.current) {
            shot.current = evaluation.camera.objectId;
            cameraDirector.setActive(shot.current || null, evaluation.camera.blend);
        }
    };

    const findMissingTargets = (stale: boolean) => {
        const owner = host?.current ?? null;
        const found = groups.current;
        const searchable = targetIds.filter(id => !(owner && id === object.id));
        const missing = searchable.some(id => !found.has(id));
        if (!missing || !(stale || sinceSearch.current >= TARGET_RETRY_INTERVAL)) return;
        sinceSearch.current = 0;
        findTargets(scene, searchable, found);
        for (const id of searchable) {
            if (found.has(id) || reportedMissing.current.has(id)) continue;
            reportedMissing.current.add(id);
            frontendDiagnostics.warning('runtime_timeline_target_missing');
        }
    };

    useFrame((_state, delta) => {
        const step = Math.min(delta, MAX_FRAME_STEP);
        sinceSearch.current += step;

        // A skip ends a cinematic at once: its last state, its remaining events, its sounds stopped.
        const current = playback.current;
        if (cinematic && skippable && current.started && !current.finished && cinematics.skipCount() !== skipsSeen.current) {
            skipsSeen.current = cinematics.skipCount();
            const events = crossedTimelineEvents(data, current.time, data.duration, false);
            playback.current = { time: data.duration, started: true, finished: true };
            stopSounds();
            const evaluation = evaluateTimeline(data, data.duration);
            applyTimeline(evaluation, resolve);
            cut(evaluation);
            finish();
            publish(evaluation, true);
            for (const name of events) timelineEvents.emit({ timelineObjectId: object.id, name });
            return;
        }

        const playing = playVariable ? isTimelinePlayValue(levelVariables.get(playVariable)) : autoplay;
        const advanced = playing ? stepTimelinePlayback(data, current, step * speed, loop) : null;
        if (!advanced || !advanced.moved) {
            // Paused (or at speed 0), or finished holding its end: characters keep the pose, which their own
            // animation would otherwise take back.
            if (current.started && (!current.finished || holdEnd) && last.current) characters.pose(last.current, resolveCharacter);
            return;
        }
        playback.current = advanced.playback;
        if (!current.started) skipsSeen.current = cinematics.skipCount();

        // Groups are cached; a group the session unmounted (a destroyed actor, a re-planned hierarchy) is looked up again.
        let stale = false;
        for (const [id, node] of groups.current) {
            if (isInScene(node, scene)) continue;
            groups.current.delete(id);
            stale = true;
        }
        findMissingTargets(stale);

        const time = advanced.playback.time;
        const finished = advanced.playback.finished;
        const evaluation = evaluateTimeline(data, time);
        applyTimeline(evaluation, resolve);
        cut(evaluation);

        // Sounds: those running count down; those whose start was passed begin.
        const advance = step * speed;
        sounds.current = sounds.current.filter(playingSound => {
            playingSound.left -= advance;
            if (playingSound.left > 0) return true;
            releaseSound(playingSound.sound);
            playingSound.sound.removeFromParent();
            playingSound.release();
            return false;
        });
        const wrapped = current.started && time < current.time;
        if (!finished) {
            for (const start of crossedTimelineSounds(data, current.started ? current.time : -1, time, wrapped)) startSound(start, time);
        }

        if (finished) finish();
        else {
            characters.pose(evaluation, resolveCharacter);
            last.current = evaluation;
        }
        publish(evaluation, finished);
        for (const name of advanced.events) timelineEvents.emit({ timelineObjectId: object.id, name });
    }, TIMELINE_FRAME_PRIORITY);

    return null;
};

interface SavedNode {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    visible: boolean;
}

/**
 * In the editor, while the Timeline editor shows this timeline: the level as play would have it at the
 * playhead, its objects moved and hidden and its characters posed, in the viewport. Each frame starts
 * from the objects as the level has them, and everything is put back when the preview ends.
 */
const TimelineEditorPreview: React.FC<ComponentRenderProps> = ({ object }) => {
    const scene = useThree(state => state.scene);
    const invalidate = useThree(state => state.invalidate);
    const { models } = useGameContent();
    const preview = useSyncExternalStore(timelinePreview.subscribe, timelinePreview.get, timelinePreview.get);
    const active = preview && preview.ownerId === object.id ? preview : null;
    const [characters] = useState(() => new TimelineCharacters());
    const saved = useRef(new Map<THREE.Object3D, SavedNode>());
    const nodes = useRef(new Map<string, THREE.Object3D>());

    const restore = () => {
        for (const [node, original] of saved.current) {
            node.position.copy(original.position);
            node.quaternion.copy(original.quaternion);
            node.scale.copy(original.scale);
            node.visible = original.visible;
        }
        saved.current.clear();
        nodes.current.clear();
        characters.release();
    };

    useEffect(() => {
        if (!active) restore();
        invalidate();
    // restore reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, invalidate]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => () => restore(), []);

    useFrame(() => {
        if (!active) return;
        // Back to the level's own placement and pose, then the timeline at the playhead over it.
        for (const [node, original] of saved.current) {
            node.position.copy(original.position);
            node.quaternion.copy(original.quaternion);
            node.scale.copy(original.scale);
            node.visible = original.visible;
        }
        characters.release();
        const ids = [...new Set([object.id, ...timelineTargetIds(active.data)])];
        for (const [id, node] of nodes.current) if (!isInScene(node, scene)) nodes.current.delete(id);
        findTargets(scene, ids, nodes.current);
        const resolve = (id: string): THREE.Object3D | null => {
            const node = nodes.current.get(id) ?? null;
            if (node && !saved.current.has(node)) {
                saved.current.set(node, { position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(), visible: node.visible });
            }
            return node;
        };
        const evaluation = evaluateTimeline(active.data, active.time);
        // Level variables belong to play; the preview leaves them alone.
        applyTimeline({ ...evaluation, variables: [] }, resolve);
        characters.pose(evaluation, id => {
            const group = id === TIMELINE_PLAYER_TARGET ? null : resolve(id);
            if (!group) return null;
            const modelId = group.userData?.modelId;
            const clips = typeof modelId === 'string' ? models.find(model => model.id === modelId)?.animations ?? [] : [];
            return { root: characterRoot(group), clips };
        });
    });

    return null;
};

const TimelineRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <TimelinePlayer {...props} /> : <TimelineEditorPreview {...props} />
);

export const TIMELINE_COMPONENT: ComponentDefinition = {
    type: TIMELINE_COMPONENT_TYPE,
    label: 'Timeline',
    description: 'Plays keyed tracks during play: moves, shows and hides objects, writes level variables, raises named events, cuts cameras, '
        + 'and plays clips on characters, sounds, subtitles and fades. As a Cinematic it letterboxes the view, hides the HUD and takes the '
        + "player's controls while it plays, and can be skipped with Enter. With a Play Variable it plays only while that level variable "
        + 'is true or non-zero; otherwise Autoplay starts it when play begins.',
    props: [
        { key: 'autoplay', label: 'Autoplay', type: 'boolean', default: TIMELINE_DEFAULTS.autoplay },
        { key: 'loop', label: 'Loop', type: 'boolean', default: TIMELINE_DEFAULTS.loop },
        { key: 'speed', label: 'Speed', type: 'number', default: TIMELINE_DEFAULTS.speed, min: 0, max: MAX_TIMELINE_SPEED, step: 0.05 },
        { key: 'playVariable', label: 'Play Variable', type: 'string', default: TIMELINE_DEFAULTS.playVariable },
        { key: 'cinematic', label: 'Cinematic', type: 'boolean', default: TIMELINE_DEFAULTS.cinematic },
        { key: 'skippable', label: 'Can Be Skipped', type: 'boolean', default: TIMELINE_DEFAULTS.skippable },
        { key: 'holdEnd', label: 'Hold End Pose', type: 'boolean', default: TIMELINE_DEFAULTS.holdEnd },
    ],
    Render: TimelineRender
};
