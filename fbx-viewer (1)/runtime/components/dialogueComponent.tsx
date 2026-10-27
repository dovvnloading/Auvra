import React, { useContext, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { dialogueSpeakers, dialogueStore, normalizeDialogue, type DialogueData, type DialogueSpeaker } from '../dialogue';
import { describeBinding, type InputState } from '../input';
import { useRuntimeServices } from '../RuntimeServicesContext';
import { IKPlayerTargetContext } from './ikComponents';
import { ComponentHostContext } from './builtins';
import type { LevelComponent } from '../../types';
import type { ComponentDefinition, ComponentRenderProps } from './types';

export const DIALOGUE_COMPONENT_TYPE = 'dialogue';

export interface DialogueSettings {
    /** Interact reach in metres; 0: only Start Dialogue opens it. */
    radius: number;
    prompt: string;
    data: DialogueData;
}

export const DIALOGUE_DEFAULTS = { radius: 3, prompt: 'Talk' };

export const resolveDialogueSettings = (component: LevelComponent): DialogueSettings => {
    const { radius, prompt, dialogue } = component.props;
    return {
        radius: typeof radius === 'number' && Number.isFinite(radius) ? Math.min(100, Math.max(0, radius)) : DIALOGUE_DEFAULTS.radius,
        prompt: typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 64) : DIALOGUE_DEFAULTS.prompt,
        data: normalizeDialogue(dialogue),
    };
};

/** Actions that continue a line or take the selected choice: Interact, and Jump or a click for convenience. */
export const DIALOGUE_CONFIRM_ACTIONS = ['Interact', 'Jump', 'Fire'] as const;

/** The Interact binding as the prompt shows it, keyboard first. */
export const interactKeyLabel = (input: InputState): string => {
    const bindings = input.findAction('Interact')?.bindings ?? [];
    const binding = bindings.find(item => item.device === 'keyboard') ?? bindings[0];
    return binding ? describeBinding(binding) : '';
};

const _player = new THREE.Vector3();
const _speaker = new THREE.Vector3();

/** The speaker nearest `point` within its own reach, or null. */
export const nearestSpeaker = (speakers: ReadonlyMap<string, DialogueSpeaker>, point: THREE.Vector3): { objectId: string; speaker: DialogueSpeaker } | null => {
    let best: { objectId: string; speaker: DialogueSpeaker } | null = null;
    let bestDistance = Infinity;
    for (const [objectId, speaker] of speakers) {
        const host = speaker.host.current;
        if (!host || speaker.radius <= 0 || !speaker.data.lines.length) continue;
        host.getWorldPosition(_speaker);
        const distance = _speaker.distanceTo(point);
        if (distance <= speaker.radius && distance < bestDistance) {
            best = { objectId, speaker };
            bestDistance = distance;
        }
    }
    return best;
};

/**
 * Runs the session's conversations: shows the Interact prompt near a speaker, opens the conversation
 * on Interact, then moves the choice selection (Move forward/back) and continues it. Mount once per
 * play session inside RuntimeServicesProvider; `enabled` false hides the prompt and ignores input.
 */
export const DialogueDriver: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const { input } = useRuntimeServices();
    const playerRef = useContext(IKPlayerTargetContext);

    useFrame(() => {
        const state = dialogueStore.state();
        if (!enabled) {
            dialogueStore.setPrompt(null);
            return;
        }
        if (state.active) {
            if (state.active.choices.length) {
                if (input.wasPressed('MoveForward')) dialogueStore.select(state.selected - 1);
                if (input.wasPressed('MoveBack')) dialogueStore.select(state.selected + 1);
            }
            if (DIALOGUE_CONFIRM_ACTIONS.some(action => input.wasPressed(action))) dialogueStore.advance();
            return;
        }
        const player = playerRef?.current;
        const nearest = player ? nearestSpeaker(dialogueSpeakers, player.getWorldPosition(_player)) : null;
        dialogueStore.setPrompt(nearest ? { objectId: nearest.objectId, text: nearest.speaker.prompt, key: interactKeyLabel(input) } : null);
        if (nearest && input.wasPressed('Interact')) dialogueStore.start(nearest.objectId, nearest.speaker.data);
    });

    return null;
};

const DialogueRuntime: React.FC<{ objectId: string; settings: DialogueSettings }> = ({ objectId, settings }) => {
    const host = useContext(ComponentHostContext);
    useEffect(() => {
        if (!host) return undefined;
        const speaker: DialogueSpeaker = { data: settings.data, radius: settings.radius, prompt: settings.prompt, host };
        dialogueSpeakers.set(objectId, speaker);
        return () => {
            if (dialogueSpeakers.get(objectId) === speaker) dialogueSpeakers.delete(objectId);
            // A speaker that goes away (destroyed, streamed out) ends its conversation.
            if (dialogueStore.state().active?.objectId === objectId) dialogueStore.close();
        };
    }, [host, objectId, settings]);
    return null;
};

const DialoguePreview: React.FC<{ radius: number }> = ({ radius }) => (radius > 0 ? (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(0, radius - 0.06), radius, 64]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.45} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
) : null);

const DialogueRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => resolveDialogueSettings(component), [component]);
    return mode === 'runtime' ? <DialogueRuntime objectId={object.id} settings={settings} /> : <DialoguePreview radius={settings.radius} />;
};

export const DIALOGUE_COMPONENT: ComponentDefinition = {
    type: DIALOGUE_COMPONENT_TYPE,
    label: 'Dialogue',
    description: 'A conversation the player opens with Interact when within reach (or a Start Dialogue node or script). Lines lead to the next line or offer choices; lines and choices can switch level variables on and raise Dialogue Events.',
    props: [
        { key: 'radius', label: 'Reach (m)', type: 'number', default: DIALOGUE_DEFAULTS.radius, min: 0, max: 100, step: 0.5 },
        { key: 'prompt', label: 'Prompt', type: 'string', default: DIALOGUE_DEFAULTS.prompt },
    ],
    Render: DialogueRender,
};
