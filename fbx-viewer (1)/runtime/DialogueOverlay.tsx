import React, { useEffect } from 'react';
import { dialogueStore, startDialogue, useDialogueState, type DialogueStore } from './dialogue';
import { interactKeyLabel } from './components/dialogueComponent';
import type { InputState } from './input';
import { useTranslation, useUiText } from './localization';

/**
 * Localization keys for a conversation's text, scoped to the object that holds it. A key a locale
 * does not translate shows the authored text.
 */
export const dialogueTextKey = (objectId: string, lineId: string, part: 'speaker' | 'text' | string): string => `dialogue.${objectId}.${lineId}.${part}`;

/**
 * The play session's conversation on screen: who speaks, what they say and the choices, plus the
 * Interact prompt near a speaker. Keys 1-9 take a choice, a click or tap continues or picks one; the
 * DialogueDriver in the scene handles the mapped actions (Interact, Move forward/back).
 */
export const DialogueOverlay: React.FC<{ input: InputState | null; store?: DialogueStore }> = ({ input, store = dialogueStore }) => {
    const state = useDialogueState(store);
    const translate = useTranslation();
    const ui = useUiText();
    const active = state.active;

    useEffect(() => {
        if (!active?.choices.length) return undefined;
        const pick = (event: KeyboardEvent) => {
            const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
            const choice = match ? active.choices[Number(match[1]) - 1] : undefined;
            if (!choice) return;
            event.preventDefault();
            store.advance(choice.id);
        };
        window.addEventListener('keydown', pick);
        return () => window.removeEventListener('keydown', pick);
    }, [active, store]);

    const key = input ? interactKeyLabel(input) : '';

    if (!active) {
        if (!state.prompt) return null;
        const { objectId, text } = state.prompt;
        return (
            <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
                <button
                    type="button"
                    onClick={() => startDialogue(objectId, store)}
                    className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm text-white shadow-lg backdrop-blur"
                >
                    {key && <kbd className="rounded border border-white/40 bg-white/10 px-1.5 py-0.5 font-mono text-xs">{key}</kbd>}
                    <span>{text}</span>
                </button>
            </div>
        );
    }

    const { objectId, line, choices } = active;
    const speaker = line.speaker ? translate(dialogueTextKey(objectId, line.id, 'speaker'), undefined, line.speaker) : '';
    const text = translate(dialogueTextKey(objectId, line.id, 'text'), undefined, line.text);

    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-30 flex justify-center px-4">
            <div
                role="dialog"
                aria-label={speaker || ui('ui.dialogue.title')}
                className="pointer-events-auto w-full max-w-2xl rounded-xl border border-white/15 bg-black/80 p-5 text-white shadow-2xl backdrop-blur"
                onClick={choices.length ? undefined : () => store.advance()}
            >
                {speaker && <div className="mb-1 text-xs font-bold uppercase tracking-wider text-sky-300">{speaker}</div>}
                <p className="whitespace-pre-wrap text-base leading-relaxed">{text}</p>
                {choices.length > 0 ? (
                    <ol className="mt-4 space-y-1.5">
                        {choices.map((choice, index) => (
                            <li key={choice.id}>
                                <button
                                    type="button"
                                    aria-current={index === state.selected}
                                    onMouseEnter={() => store.select(index)}
                                    onClick={() => store.advance(choice.id)}
                                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${index === state.selected ? 'border-sky-400/70 bg-sky-500/20' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                                >
                                    <span className="font-mono text-xs text-white/50">{index + 1}</span>
                                    <span>{translate(dialogueTextKey(objectId, line.id, choice.id), undefined, choice.text)}</span>
                                </button>
                            </li>
                        ))}
                    </ol>
                ) : (
                    <div className="mt-3 flex justify-end text-xs text-white/50">
                        {key && <kbd className="mr-1.5 rounded border border-white/30 px-1 font-mono">{key}</kbd>}
                        {ui(line.next ? 'ui.dialogue.continue' : 'ui.dialogue.end')}
                    </div>
                )}
            </div>
        </div>
    );
};
