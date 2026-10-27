import { useSyncExternalStore, type RefObject } from 'react';
import type * as THREE from 'three';
import { frontendDiagnostics } from '../diagnostics/runtime';
import type { LevelVariableValue } from './levelVariables';

/**
 * DIALOGUE
 *
 * A Dialogue component holds a conversation: lines spoken by someone, each leading to the next line
 * or offering choices. A line or a choice can switch a level variable on and raise a named event
 * (the Dialogue Event level event and scripts' onDialogueEvent hear it); a choice can require a level
 * variable to be on before it is offered. One conversation runs at a time; the player's controls
 * stop while it is open.
 */

export interface DialogueChoice {
    id: string;
    text: string;
    /** The line it leads to; null (or a missing id) ends the conversation. */
    next: string | null;
    /** Offered only while this level variable is on (true or non-zero). */
    requires?: string;
    /** Switched on (true) when chosen. */
    setVariable?: string;
    /** Raised when chosen. */
    event?: string;
}

export interface DialogueLine {
    id: string;
    speaker: string;
    text: string;
    /** Followed when the line has no choices to offer; null ends the conversation. */
    next: string | null;
    choices?: DialogueChoice[];
    /** Switched on when the line is shown. */
    setVariable?: string;
    /** Raised when the line is shown. */
    event?: string;
}

export interface DialogueData {
    startId: string;
    lines: DialogueLine[];
}

export const DIALOGUE_LIMITS = { maxLines: 256, maxChoices: 8, maxSpeaker: 128, maxText: 2048, maxChoiceText: 512, maxName: 128 };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const id = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, DIALOGUE_LIMITS.maxName) : null);
const optionalName = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, DIALOGUE_LIMITS.maxName) : undefined);

/** Variable and event names a line or choice carries, left out when empty. */
const effects = (raw: Record<string, unknown>, keys: readonly ('requires' | 'setVariable' | 'event')[]) => {
    const out: { requires?: string; setVariable?: string; event?: string } = {};
    for (const key of keys) {
        const name = optionalName(raw[key]);
        if (name) out[key] = name;
    }
    return out;
};

/** A clean copy of stored dialogue (component.props.dialogue): malformed lines and choices are dropped. */
export const normalizeDialogue = (value: unknown): DialogueData => {
    if (!isRecord(value) || !Array.isArray(value.lines)) return { startId: '', lines: [] };
    const seen = new Set<string>();
    const lines: DialogueLine[] = [];
    for (const raw of value.lines) {
        const lineId = isRecord(raw) ? id(raw.id) : null;
        if (!isRecord(raw) || !lineId || seen.has(lineId) || lines.length >= DIALOGUE_LIMITS.maxLines) continue;
        seen.add(lineId);
        const choiceIds = new Set<string>();
        const choices: DialogueChoice[] = [];
        for (const choice of Array.isArray(raw.choices) ? raw.choices : []) {
            const choiceId = isRecord(choice) ? id(choice.id) : null;
            if (!isRecord(choice) || !choiceId || choiceIds.has(choiceId) || choices.length >= DIALOGUE_LIMITS.maxChoices) continue;
            choiceIds.add(choiceId);
            choices.push({ id: choiceId, text: text(choice.text, DIALOGUE_LIMITS.maxChoiceText), next: id(choice.next), ...effects(choice, ['requires', 'setVariable', 'event']) });
        }
        lines.push({
            id: lineId,
            speaker: text(raw.speaker, DIALOGUE_LIMITS.maxSpeaker),
            text: text(raw.text, DIALOGUE_LIMITS.maxText),
            next: id(raw.next),
            ...(choices.length ? { choices } : {}),
            ...effects(raw, ['setVariable', 'event']),
        });
    }
    const startId = typeof value.startId === 'string' && seen.has(value.startId) ? value.startId : lines[0]?.id ?? '';
    return { startId, lines };
};

/** Authoring problems worth showing: links to lines that do not exist and lines nothing reaches. */
export const dialogueProblems = (data: DialogueData): string[] => {
    const ids = new Set(data.lines.map(line => line.id));
    // Lines are named by their number in the list, as the editor shows them.
    const number = new Map(data.lines.map((line, index) => [line.id, index + 1]));
    const problems: string[] = [];
    const reached = new Set<string>();
    const visit = (lineId: string | null) => {
        if (!lineId || reached.has(lineId) || !ids.has(lineId)) return;
        reached.add(lineId);
        const line = data.lines.find(item => item.id === lineId)!;
        visit(line.next);
        line.choices?.forEach(choice => visit(choice.next));
    };
    visit(data.startId);
    for (const line of data.lines) {
        const name = `Line ${number.get(line.id)}`;
        if (line.next && !ids.has(line.next)) problems.push(`${name} continues to a line that no longer exists.`);
        (line.choices ?? []).forEach((choice, index) => {
            if (choice.next && !ids.has(choice.next)) problems.push(`Choice ${index + 1} on ${name.toLowerCase()} leads to a line that no longer exists.`);
        });
        if (!reached.has(line.id)) problems.push(`${name} is never reached from the start line.`);
    }
    return problems;
};

const isOn = (value: LevelVariableValue | undefined): boolean => value === true || (typeof value === 'number' && value !== 0);

/** A line's choices that can be taken now. */
export const availableChoices = (line: DialogueLine, readVariable: (name: string) => LevelVariableValue | undefined): DialogueChoice[] =>
    (line.choices ?? []).filter(choice => !choice.requires || isOn(readVariable(choice.requires)));

export interface DialogueEvent {
    /** The object whose Dialogue component holds the conversation. */
    objectId: string;
    name: string;
}

export interface ActiveDialogue {
    objectId: string;
    data: DialogueData;
    line: DialogueLine;
    /** The line's choices that were available when it was shown. */
    choices: DialogueChoice[];
}

/** The conversation the player can open by pressing Interact. */
export interface DialoguePrompt {
    objectId: string;
    text: string;
    /** The Interact binding, for the on-screen hint. */
    key: string;
}

export interface DialogueState {
    active: ActiveDialogue | null;
    /** Index into the active line's choices. */
    selected: number;
    /** Shown while no conversation is open. */
    prompt: DialoguePrompt | null;
}

export interface DialogueHooks {
    readVariable(name: string): LevelVariableValue | undefined;
    setVariable(name: string, value: LevelVariableValue): void;
}

export interface DialogueStore {
    /** Replaced on every change, so it is safe as a snapshot. */
    state(): DialogueState;
    /** Opens a conversation at its start line; false when another is open or it has no lines. */
    start(objectId: string, data: DialogueData): boolean;
    /** Continues a line without choices, or takes a choice: `choiceId`, or the selected one. */
    advance(choiceId?: string): void;
    /** Moves the choice selection, wrapping around. */
    select(index: number): void;
    setPrompt(prompt: DialoguePrompt | null): void;
    close(): void;
    /** Ends the play session's conversation and prompt. */
    reset(): void;
    subscribe(listener: () => void): () => void;
    onEvent(listener: (event: DialogueEvent) => void): () => void;
    /** Where variables are read and written (the level variables during play). */
    setHooks(hooks: DialogueHooks | null): void;
}

const EMPTY_STATE: DialogueState = { active: null, selected: 0, prompt: null };

const samePrompt = (a: DialoguePrompt | null, b: DialoguePrompt | null) =>
    a === b || (!!a && !!b && a.objectId === b.objectId && a.text === b.text && a.key === b.key);

export const createDialogueStore = (): DialogueStore => {
    let state = EMPTY_STATE;
    let hooks: DialogueHooks | null = null;
    // Bumped whenever a conversation opens or closes, so an event listener that does either wins.
    let generation = 0;
    const listeners = new Set<() => void>();
    const eventListeners = new Set<(event: DialogueEvent) => void>();

    const commit = (next: DialogueState) => {
        state = next;
        [...listeners].forEach(listener => listener());
    };
    const emit = (event: DialogueEvent) => [...eventListeners].forEach(listener => {
        try {
            listener(event);
        } catch (error) {
            frontendDiagnostics.failure('runtime_dialogue_event_listener_failed', error);
        }
    });
    const apply = (objectId: string, effect: { setVariable?: string; event?: string }) => {
        if (effect.setVariable) hooks?.setVariable(effect.setVariable, true);
        if (effect.event) emit({ objectId, name: effect.event });
    };
    const show = (objectId: string, data: DialogueData, lineId: string | null) => {
        const line = lineId ? data.lines.find(item => item.id === lineId) : undefined;
        if (!line) {
            commit({ ...state, active: null, selected: 0 });
            return;
        }
        // The line's own variable is set first, so a choice requiring it is offered right away.
        const at = generation;
        apply(objectId, line);
        if (generation !== at) return;
        const choices = availableChoices(line, name => hooks?.readVariable(name));
        commit({ ...state, active: { objectId, data, line, choices }, selected: 0 });
    };

    return {
        state: () => state,
        start(objectId, data) {
            if (state.active || !data.lines.length) return false;
            generation += 1;
            show(objectId, data, data.startId || data.lines[0].id);
            return state.active !== null;
        },
        advance(choiceId) {
            const active = state.active;
            if (!active) return;
            if (!active.choices.length) {
                show(active.objectId, active.data, active.line.next);
                return;
            }
            const choice = choiceId === undefined ? active.choices[state.selected] : active.choices.find(item => item.id === choiceId);
            if (!choice) return;
            const at = generation;
            apply(active.objectId, choice);
            if (generation !== at) return;
            show(active.objectId, active.data, choice.next);
        },
        select(index) {
            const count = state.active?.choices.length ?? 0;
            if (!count || !Number.isFinite(index)) return;
            const selected = ((Math.trunc(index) % count) + count) % count;
            if (selected !== state.selected) commit({ ...state, selected });
        },
        setPrompt(prompt) {
            if (!samePrompt(prompt, state.prompt)) commit({ ...state, prompt });
        },
        close() {
            generation += 1;
            if (state.active) commit({ ...state, active: null, selected: 0 });
        },
        reset() {
            generation += 1;
            if (state !== EMPTY_STATE) commit(EMPTY_STATE);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        onEvent(listener) {
            eventListeners.add(listener);
            return () => { eventListeners.delete(listener); };
        },
        setHooks(next) { hooks = next; },
    };
};

/** The play session's conversations. */
export const dialogueStore = createDialogueStore();

export const useDialogueState = (store: DialogueStore = dialogueStore): DialogueState =>
    useSyncExternalStore(store.subscribe, store.state, store.state);

/** A Dialogue component in the running session. */
export interface DialogueSpeaker {
    data: DialogueData;
    /** Interact reach in metres; 0: only Start Dialogue (blueprint or script) opens it. */
    radius: number;
    prompt: string;
    host: RefObject<THREE.Object3D | null>;
}

/** Dialogue components by object id: the Interact prompt finds the nearest, Start Dialogue opens one by id. */
export const dialogueSpeakers = new Map<string, DialogueSpeaker>();

/** Opens the conversation on object `objectId`; false when it has none or one is already open. */
export const startDialogue = (objectId: string, store: DialogueStore = dialogueStore): boolean => {
    const speaker = dialogueSpeakers.get(objectId);
    return !!speaker && store.start(objectId, speaker.data);
};
