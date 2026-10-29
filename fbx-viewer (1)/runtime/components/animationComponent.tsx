import React, { useContext, useEffect, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ANIMATION_FRAME_PRIORITY } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import { useGameContent } from '../GameContentContext';
import { findTimelineClip } from '../timeline/poser';
import { ComponentHostContext } from './builtins';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

export const ANIMATION_COMPONENT_TYPE = 'animation';

export interface AnimationSettings {
    /** The model's clip to play; empty plays nothing. */
    clip: string;
    loop: boolean;
    /** Playback speed; negative plays backwards. */
    speed: number;
    /** Where in the clip playback starts, 0 to 1, so several copies of one character are not in step. */
    startAt: number;
}

export const ANIMATION_DEFAULTS: AnimationSettings = { clip: '', loop: true, speed: 1, startAt: 0 };

/** Largest frame step the mixer takes, so a resumed or backgrounded tab does not jump the clip. */
const MAX_FRAME_STEP = 0.1;

export const readAnimationSettings = (component: LevelComponent): AnimationSettings => {
    const { clip, loop, speed, startAt } = component.props;
    return {
        clip: typeof clip === 'string' ? clip.trim() : ANIMATION_DEFAULTS.clip,
        loop: typeof loop === 'boolean' ? loop : ANIMATION_DEFAULTS.loop,
        speed: typeof speed === 'number' && Number.isFinite(speed) ? Math.min(10, Math.max(-10, speed)) : ANIMATION_DEFAULTS.speed,
        startAt: typeof startAt === 'number' && Number.isFinite(startAt) ? Math.min(1, Math.max(0, startAt)) : ANIMATION_DEFAULTS.startAt,
    };
};

/** The clip `name` asks for: the exact name, else the same name without an `Armature|` style prefix, ignoring case. */
export const findAnimationClip = findTimelineClip;

const AnimationRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const hostRef = useContext(ComponentHostContext);
    const { models } = useGameContent();
    const settings = readAnimationSettings(component);
    const clip = findAnimationClip(models.find(model => model.id === object.modelId)?.animations ?? [], settings.clip);
    const [mixer, setMixer] = useState<THREE.AnimationMixer | null>(null);

    useEffect(() => {
        // The object's model is the host's child that is not a nested level object.
        const model = hostRef?.current?.children.find(child => child.userData.levelObjectId === undefined);
        if (!model || !clip) return undefined;
        const created = new THREE.AnimationMixer(model);
        const action = created.clipAction(clip);
        action.setLoop(settings.loop ? THREE.LoopRepeat : THREE.LoopOnce, settings.loop ? Infinity : 1);
        action.clampWhenFinished = true;
        action.timeScale = settings.speed;
        action.time = settings.startAt * clip.duration;
        action.play();
        created.update(0);
        setMixer(created);
        return () => {
            created.stopAllAction();
            created.uncacheRoot(model);
            setMixer(null);
        };
    }, [hostRef, clip, settings.loop, settings.speed, settings.startAt]);

    // Before the frame's other callbacks, like the characters' graphs, so IK on this object sees the pose.
    useFrame((_state, delta) => {
        mixer?.update(Math.min(delta, MAX_FRAME_STEP));
    }, ANIMATION_FRAME_PRIORITY);

    return null;
};

const AnimationRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <AnimationRuntime {...props} /> : null
);

export const ANIMATION_COMPONENT: ComponentDefinition = {
    type: ANIMATION_COMPONENT_TYPE,
    label: 'Animation',
    description: "Plays one of the model's clips on a placed character during play: an NPC idling, waving or working.",
    props: [
        { key: 'clip', label: 'Clip', type: 'string', default: ANIMATION_DEFAULTS.clip },
        { key: 'loop', label: 'Loop', type: 'boolean', default: ANIMATION_DEFAULTS.loop },
        { key: 'speed', label: 'Speed', type: 'number', default: ANIMATION_DEFAULTS.speed, min: -10, max: 10, step: 0.1 },
        { key: 'startAt', label: 'Start At (0-1)', type: 'number', default: ANIMATION_DEFAULTS.startAt, min: 0, max: 1, step: 0.05 },
    ],
    Render: AnimationRender,
};
