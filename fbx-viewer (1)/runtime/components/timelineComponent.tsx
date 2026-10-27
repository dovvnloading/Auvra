import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelComponent } from '../../types';
import { levelVariables } from '../levelVariables';
import {
    evaluateTimeline,
    INITIAL_TIMELINE_PLAYBACK,
    isTimelinePlayValue,
    normalizeTimeline,
    stepTimelinePlayback,
    TIMELINE_COMPONENT_TYPE,
    timelineTargetIds,
    type TimelineEvaluation,
    type TimelinePlayback,
} from '../timeline/evaluate';
import { timelineEvents } from '../timeline/events';
import { cameraDirector } from '../cameraDirector';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/** Longest step playback takes in one frame, so resuming from a pause or a stalled tab does not jump. */
const MAX_FRAME_STEP = 0.1;

/** Fastest playback rate the inspector offers. */
const MAX_TIMELINE_SPEED = 10;

/** Seconds between scene searches for targets that are still missing (destroyed, or not drawn as their own group). */
const TARGET_RETRY_INTERVAL = 0.5;

const TIMELINE_DEFAULTS = { autoplay: true, loop: false, speed: 1, playVariable: '' };

export interface TimelineSettings {
    autoplay: boolean;
    loop: boolean;
    /** Playback rate, 0..MAX_TIMELINE_SPEED. */
    speed: number;
    /** Trimmed level variable name; empty when playback follows autoplay instead. */
    playVariable: string;
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
});

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

/**
 * Plays the timeline in a play session. Targets are moved and hidden through the transform groups the
 * session draws them in (the owner through its host group), like Mover and Rotator move their owner, so
 * the project and the session's object list are never written. A paused or finished timeline writes
 * nothing, leaving its targets where it last put them.
 */
const TimelinePlayer: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const host = useContext(ComponentHostContext);
    const scene = useThree(state => state.scene);
    const stored = component.props.timeline;
    const data = useMemo(() => normalizeTimeline(stored), [stored]);
    const targetIds = useMemo(() => timelineTargetIds(data), [data]);
    const { autoplay, loop, speed, playVariable } = readTimelineSettings(component);

    const playback = useRef<Readonly<TimelinePlayback>>(INITIAL_TIMELINE_PLAYBACK);
    const groups = useRef(new Map<string, THREE.Object3D>());
    const sinceSearch = useRef(Number.POSITIVE_INFINITY);
    const reportedMissing = useRef(new Set<string>());
    // The camera this timeline cut to, given back to the gameplay camera when the timeline goes away.
    const shot = useRef<string | null>(null);
    useEffect(() => () => {
        if (shot.current && cameraDirector.activeId() === shot.current) cameraDirector.setActive(null, 0);
    }, []);

    useFrame((_state, delta) => {
        const step = Math.min(delta, MAX_FRAME_STEP);
        sinceSearch.current += step;
        const playing = playVariable ? isTimelinePlayValue(levelVariables.get(playVariable)) : autoplay;
        if (!playing) return;
        const advanced = stepTimelinePlayback(data, playback.current, step * speed, loop);
        playback.current = advanced.playback;
        if (!advanced.moved) return;

        // Groups are cached; a group the session unmounted (a destroyed actor, a re-planned hierarchy) is looked up again.
        const owner = host?.current ?? null;
        const found = groups.current;
        let stale = false;
        for (const [id, node] of found) {
            if (isInScene(node, scene)) continue;
            found.delete(id);
            stale = true;
        }
        const searchable = targetIds.filter(id => !(owner && id === object.id));
        const missing = searchable.some(id => !found.has(id));
        if (missing && (stale || sinceSearch.current >= TARGET_RETRY_INTERVAL)) {
            sinceSearch.current = 0;
            findTargets(scene, searchable, found);
            for (const id of searchable) {
                if (found.has(id) || reportedMissing.current.has(id)) continue;
                reportedMissing.current.add(id);
                frontendDiagnostics.warning('runtime_timeline_target_missing');
            }
        }

        const evaluation = evaluateTimeline(data, advanced.playback.time);
        applyTimeline(evaluation, id => (owner && id === object.id ? owner : found.get(id) ?? null));
        // Camera keys cut the view; a cut to the shot already showing does nothing.
        if (evaluation.camera && evaluation.camera.objectId !== shot.current) {
            shot.current = evaluation.camera.objectId;
            cameraDirector.setActive(shot.current || null, evaluation.camera.blend);
        }
        for (const name of advanced.events) timelineEvents.emit({ timelineObjectId: object.id, name });
    });

    return null;
};

const TimelineRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <TimelinePlayer {...props} /> : null
);

export const TIMELINE_COMPONENT: ComponentDefinition = {
    type: TIMELINE_COMPONENT_TYPE,
    label: 'Timeline',
    description: 'Plays keyed tracks during play: moves, shows and hides objects, writes level variables and raises named events. With a Play Variable it plays only while that level variable is true or non-zero; otherwise Autoplay starts it when play begins.',
    props: [
        { key: 'autoplay', label: 'Autoplay', type: 'boolean', default: TIMELINE_DEFAULTS.autoplay },
        { key: 'loop', label: 'Loop', type: 'boolean', default: TIMELINE_DEFAULTS.loop },
        { key: 'speed', label: 'Speed', type: 'number', default: TIMELINE_DEFAULTS.speed, min: 0, max: MAX_TIMELINE_SPEED, step: 0.05 },
        { key: 'playVariable', label: 'Play Variable', type: 'string', default: TIMELINE_DEFAULTS.playVariable }
    ],
    Render: TimelineRender
};
