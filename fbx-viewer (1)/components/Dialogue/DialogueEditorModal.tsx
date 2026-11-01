import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Flag, MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { DIALOGUE_LIMITS, dialogueProblems, type DialogueData } from '../../runtime/dialogue';
import { addChoice, addLine, lineLabel, moveLine, removeChoice, removeLine, updateChoice, updateLine } from './dialogueEditing';

interface DialogueEditorModalProps {
    /** The dialogue to edit, as normalizeDialogue returns it; the editor works on a copy until Save. */
    dialogue: DialogueData;
    /** Level variable names offered for Requires and Sets. */
    variableNames?: string[];
    subtitle?: string;
    /** Receives the edited dialogue when Save is pressed with changes; onClose follows. */
    onSave: (dialogue: DialogueData) => void;
    onClose: () => void;
}

const INPUT = 'w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-sky-500';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <label className="block space-y-1">
        <span className="text-[10px] text-gray-400">{label}</span>
        {children}
    </label>
);

/** Choosing where a line or choice goes: the end of the conversation or any line. */
const NextSelect: React.FC<{ data: DialogueData; value: string | null; label: string; onChange: (next: string | null) => void }> = ({ data, value, label, onChange }) => (
    <select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} className={INPUT}>
        <option value="">End conversation</option>
        {value && !data.lines.some(line => line.id === value) && <option value={value}>Missing line</option>}
        {data.lines.map(line => <option key={line.id} value={line.id}>{lineLabel(data, line.id)}</option>)}
    </select>
);

/**
 * Edits a Dialogue component's conversation: the list of lines on the left, the selected line and its
 * choices on the right. Nothing reaches the level until Save.
 */
export const DialogueEditorModal: React.FC<DialogueEditorModalProps> = ({ dialogue, variableNames = [], subtitle, onSave, onClose }) => {
    const [draft, setDraft] = useState(dialogue);
    const [selectedId, setSelectedId] = useState(dialogue.startId || dialogue.lines[0]?.id || '');
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const variableListId = useId();
    const dirty = draft !== dialogue;
    const problems = useMemo(() => dialogueProblems(draft), [draft]);
    const line = draft.lines.find(item => item.id === selectedId);

    const add = () => {
        const result = addLine(draft);
        if (!result.id) return;
        setDraft(result.data);
        setSelectedId(result.id);
    };
    const remove = (id: string) => {
        const index = draft.lines.findIndex(item => item.id === id);
        const next = removeLine(draft, id);
        setDraft(next);
        setSelectedId(next.lines[Math.min(index, next.lines.length - 1)]?.id ?? '');
    };

    const requestClose = () => {
        if (dirty) setConfirmDiscard(true);
        else onClose();
    };
    const save = () => {
        if (dirty) onSave(draft);
        onClose();
    };
    const keepEditing = () => {
        setConfirmDiscard(false);
        rootRef.current?.focus({ preventScroll: true });
    };

    const handleKey = (event: { key: string; preventDefault(): void }) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (confirmDiscard) keepEditing();
        else requestClose();
    };
    const handleKeyRef = useRef(handleKey);
    handleKeyRef.current = handleKey;

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        rootRef.current?.focus({ preventScroll: true });
        // Keys whose target fell outside the editor stay away from the world editor's hotkeys behind it.
        const guard = (event: KeyboardEvent) => {
            const root = rootRef.current;
            if (!root || (event.target instanceof Node && root.contains(event.target))) return;
            event.stopPropagation();
            root.focus({ preventScroll: true });
            handleKeyRef.current(event);
        };
        window.addEventListener('keydown', guard, true);
        return () => {
            window.removeEventListener('keydown', guard, true);
            previous?.focus({ preventScroll: true });
        };
    }, []);

    const stop = (event: React.SyntheticEvent) => event.stopPropagation();

    return createPortal(
        <div
            ref={rootRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Dialogue editor"
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 outline-none"
            onKeyDown={(event) => {
                event.stopPropagation();
                handleKey(event);
            }}
            onPointerDown={stop}
            onClick={stop}
            onDoubleClick={stop}
            onContextMenu={stop}
        >
            <div className="relative flex w-full max-w-5xl h-[85vh] flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
                <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <MessageSquare size={18} className="text-sky-400 shrink-0" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-bold text-white">Dialogue</h2>
                            <p className="text-[10px] text-gray-500 truncate">
                                {subtitle ? `${subtitle} · ` : ''}A line continues to the next one, or offers choices that each lead somewhere
                            </p>
                        </div>
                    </div>
                    <button type="button" onClick={requestClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close dialogue editor"><X size={16} /></button>
                </div>

                <div className="flex min-h-0 flex-1">
                    <div className="flex w-72 shrink-0 flex-col border-r border-gray-800 bg-gray-950/40">
                        <ul className="flex-1 overflow-y-auto p-2 space-y-1" aria-label="Lines">
                            {draft.lines.map(item => (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedId(item.id)}
                                        aria-current={item.id === selectedId}
                                        className={`w-full rounded px-2 py-1.5 text-left text-xs flex items-center gap-2 ${item.id === selectedId ? 'bg-sky-600/20 text-sky-100 border border-sky-500/40' : 'text-gray-300 hover:bg-gray-800 border border-transparent'}`}
                                    >
                                        {item.id === draft.startId && <Flag size={10} className="text-emerald-400 shrink-0" aria-label="Start line" />}
                                        <span className="truncate">{lineLabel(draft, item.id)}</span>
                                        {item.choices?.length ? <span className="ml-auto shrink-0 text-[10px] text-gray-500">{item.choices.length} choices</span> : null}
                                    </button>
                                </li>
                            ))}
                            {!draft.lines.length && <li className="px-2 py-4 text-center text-[11px] text-gray-500">No lines yet.</li>}
                        </ul>
                        <div className="border-t border-gray-800 p-2">
                            <button
                                type="button"
                                onClick={add}
                                disabled={draft.lines.length >= DIALOGUE_LIMITS.maxLines}
                                className="w-full py-1.5 text-xs bg-sky-600/20 hover:bg-sky-600/30 disabled:opacity-40 border border-sky-500/40 rounded text-sky-200 flex items-center justify-center gap-2"
                            >
                                <Plus size={12} /> Add Line
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {line ? (
                            <>
                                <div className="flex items-center gap-2">
                                    <h3 className="text-xs font-bold text-white">Line {draft.lines.indexOf(line) + 1}</h3>
                                    {line.id === draft.startId
                                        ? <span className="flex items-center gap-1 text-[10px] text-emerald-400"><Flag size={10} /> Start line</span>
                                        : <button type="button" onClick={() => setDraft({ ...draft, startId: line.id })} className="text-[10px] text-gray-400 hover:text-emerald-300">Start here</button>}
                                    <div className="ml-auto flex items-center gap-1">
                                        <button type="button" aria-label="Move line up" onClick={() => setDraft(moveLine(draft, line.id, -1))} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white"><ArrowUp size={12} /></button>
                                        <button type="button" aria-label="Move line down" onClick={() => setDraft(moveLine(draft, line.id, 1))} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white"><ArrowDown size={12} /></button>
                                        <button type="button" aria-label="Delete line" onClick={() => remove(line.id)} className="rounded p-1 text-gray-500 hover:bg-red-900/40 hover:text-red-300"><Trash2 size={12} /></button>
                                    </div>
                                </div>
                                <Field label="Speaker">
                                    <input value={line.speaker} maxLength={DIALOGUE_LIMITS.maxSpeaker} onChange={(event) => setDraft(updateLine(draft, line.id, { speaker: event.target.value }))} className={INPUT} placeholder="e.g. Innkeeper" />
                                </Field>
                                <Field label="Text">
                                    <textarea value={line.text} maxLength={DIALOGUE_LIMITS.maxText} onChange={(event) => setDraft(updateLine(draft, line.id, { text: event.target.value }))} className={`${INPUT} h-24 resize-none`} placeholder="What they say" />
                                </Field>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Sets variable (on) when shown">
                                        <input list={variableListId} value={line.setVariable ?? ''} onChange={(event) => setDraft(updateLine(draft, line.id, { setVariable: event.target.value }))} className={INPUT} placeholder="none" />
                                    </Field>
                                    <Field label="Raises event when shown">
                                        <input value={line.event ?? ''} onChange={(event) => setDraft(updateLine(draft, line.id, { event: event.target.value }))} className={INPUT} placeholder="none" />
                                    </Field>
                                </div>
                                <Field label={line.choices?.length ? 'Then (when no choice can be offered)' : 'Then'}>
                                    <NextSelect data={draft} value={line.next} label="Next line" onChange={(next) => setDraft(updateLine(draft, line.id, { next }))} />
                                </Field>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Choices</h4>
                                        <button
                                            type="button"
                                            onClick={() => setDraft(addChoice(draft, line.id))}
                                            disabled={(line.choices?.length ?? 0) >= DIALOGUE_LIMITS.maxChoices}
                                            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-sky-300 hover:bg-sky-900/30 disabled:opacity-40"
                                        >
                                            <Plus size={10} /> Add Choice
                                        </button>
                                    </div>
                                    {!line.choices?.length && <p className="text-[10px] text-gray-500">No choices: the player continues to the next line.</p>}
                                    {line.choices?.map((choice, index) => (
                                        <div key={choice.id} className="space-y-2 rounded border border-gray-700/60 bg-gray-950/40 p-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] font-mono text-gray-500">{index + 1}</span>
                                                <input aria-label={`Choice ${index + 1} text`} value={choice.text} maxLength={DIALOGUE_LIMITS.maxChoiceText} onChange={(event) => setDraft(updateChoice(draft, line.id, choice.id, { text: event.target.value }))} className={INPUT} placeholder="What the player says" />
                                                <button type="button" aria-label={`Delete choice ${index + 1}`} onClick={() => setDraft(removeChoice(draft, line.id, choice.id))} className="rounded p-1 text-gray-500 hover:bg-red-900/40 hover:text-red-300"><Trash2 size={12} /></button>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <Field label="Leads to">
                                                    <NextSelect data={draft} value={choice.next} label={`Choice ${index + 1} leads to`} onChange={(next) => setDraft(updateChoice(draft, line.id, choice.id, { next }))} />
                                                </Field>
                                                <Field label="Offered only while variable is on">
                                                    <input list={variableListId} value={choice.requires ?? ''} onChange={(event) => setDraft(updateChoice(draft, line.id, choice.id, { requires: event.target.value }))} className={INPUT} placeholder="always" />
                                                </Field>
                                                <Field label="Sets variable (on)">
                                                    <input list={variableListId} value={choice.setVariable ?? ''} onChange={(event) => setDraft(updateChoice(draft, line.id, choice.id, { setVariable: event.target.value }))} className={INPUT} placeholder="none" />
                                                </Field>
                                                <Field label="Raises event">
                                                    <input value={choice.event ?? ''} onChange={(event) => setDraft(updateChoice(draft, line.id, choice.id, { event: event.target.value }))} className={INPUT} placeholder="none" />
                                                </Field>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <p className="py-12 text-center text-xs text-gray-500">Add a line to start the conversation.</p>
                        )}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-3 text-[11px]">
                        <span className={dirty ? 'text-amber-400' : 'text-gray-500'}>{dirty ? 'Unsaved changes' : 'No changes'}</span>
                        {problems.length > 0 && (
                            <span className="flex items-center gap-1 text-amber-300 truncate" title={problems.join('\n')}>
                                <AlertTriangle size={12} /> {problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={requestClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
                        <button type="button" onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-blue-500">Save</button>
                    </div>
                </div>

                {confirmDiscard && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
                        <div role="alertdialog" aria-modal="true" aria-label="Discard changes" className="w-80 space-y-3 rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-2xl">
                            <div className="flex items-center gap-2 text-sm font-bold text-white"><AlertTriangle size={14} className="text-amber-400" /> Discard changes?</div>
                            <p className="text-[11px] text-gray-400">The edits made to this dialogue have not been saved.</p>
                            <div className="flex justify-end gap-2">
                                <button type="button" autoFocus onClick={keepEditing} className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">Keep Editing</button>
                                <button type="button" onClick={onClose} className="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500">Discard</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <datalist id={variableListId}>
                {variableNames.map(variable => <option key={variable} value={variable} />)}
            </datalist>
        </div>,
        document.body,
    );
};
