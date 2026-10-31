import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, FileCode2, Save, Sparkles, X } from 'lucide-react';
import { SCRIPT_LIMITS } from '../../runtime/scripting/protocol';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { ScriptAssistant } from './ScriptAssistant';

/** One indentation step in the script editor. */
export const SCRIPT_INDENT = '    ';

/** A list of project ids the API panel offers to insert at the caret, e.g. prefabs for ctx.spawn. */
export interface ScriptReferenceGroup {
    label: string;
    /** The API the ids are for, shown next to the label. */
    usage: string;
    items: { id: string; name: string }[];
}

/** Replaces [from, to) of the text with `insert`, then selects selectionStart..selectionEnd. */
export interface ScriptTextEdit {
    from: number;
    to: number;
    insert: string;
    selectionStart: number;
    selectionEnd: number;
}

interface ScriptApiSection {
    title: string;
    entries: { signature: string; description: string }[];
}

/** The callbacks and ctx API listed in the editor's reference panel (docs/scripting.md has the full text). */
export const SCRIPT_API_REFERENCE: ScriptApiSection[] = [
    {
        title: 'Callbacks',
        entries: [
            { signature: 'onStart(ctx)', description: "Once, before the script's first update." },
            { signature: 'onUpdate(ctx, dt)', description: 'Every frame; dt is the seconds since the previous frame.' },
            { signature: 'onTriggerEnter(ctx, other)', description: "Something entered this object's trigger. other is its handle, or null for the player; a third argument gives its id ('player')." },
            { signature: 'onTriggerExit(ctx, other)', description: 'Something left the trigger.' },
            { signature: 'onAnimNotify(ctx, name, source)', description: "An animation notify fired. source is 'player' for the player character; a level object's own notifies (source is its id) reach only its scripts." },
            { signature: 'onTimelineEvent(ctx, name, timelineObjectId)', description: 'A playing timeline crossed a key on one of its event tracks. Reaches every script.' },
            { signature: 'onDialogueEvent(ctx, name, objectId)', description: 'A dialogue line or choice raised an event. objectId holds the Dialogue component. Reaches every script.' },
            { signature: 'onVehicleEntered(ctx, vehicleId)', description: 'The player got into a vehicle (an object with a Vehicle component). Reaches every script.' },
            { signature: 'onVehicleExited(ctx, vehicleId)', description: 'The player got out of a vehicle. Reaches every script.' },
            { signature: 'onSpawned(ctx, requestId, objectIds)', description: "This script's ctx.spawn request was placed. objectIds start with the new root object." },
        ],
    },
    {
        title: 'Objects',
        entries: [
            { signature: 'ctx.self', description: "This script's object." },
            { signature: 'ctx.find(name)', description: 'The first object with that name, or null.' },
            { signature: 'ctx.get(id)', description: 'The object with that id, or null once it is gone.' },
            { signature: 'ctx.all()', description: 'Every object in the level.' },
        ],
    },
    {
        title: 'Object handles',
        entries: [
            { signature: 'id, name', description: "The object's id and name." },
            { signature: 'position, rotation, scale', description: '[x, y, z] copies, local to the parent, including changes made this frame. Rotation is in radians.' },
            { signature: 'exists, visible', description: 'Whether the object is still there, and whether it is shown.' },
            { signature: 'setPosition(x, y, z)', description: 'Moves the object; also takes one [x, y, z]. setRotation (radians) and setScale work the same way.' },
            { signature: 'translate(dx, dy, dz)', description: 'Moves the object by an offset.' },
            { signature: 'setVisible(visible)', description: 'Shows or hides the object.' },
            { signature: 'applyImpulse(x, y, z)', description: 'Pushes an object that has a dynamic Rigid Body. Impulses in one frame add up.' },
            { signature: 'destroy()', description: 'Removes the object for the rest of the play session.' },
        ],
    },
    {
        title: 'World',
        entries: [
            { signature: 'ctx.player', description: "The player's { position, rotation }, or null when there is no player." },
            { signature: 'ctx.time, ctx.delta, ctx.frame', description: 'Seconds since play started, seconds since the previous frame, and the frame number.' },
            { signature: 'ctx.spawn(prefabId, [x, y, z])', description: 'Places a copy of a prefab. Returns a requestId that onSpawned answers.' },
            { signature: 'ctx.raycast(origin, direction, maxDistance)', description: "Casts a ray that ignores this script's object. Returns a requestId." },
            { signature: 'ctx.raycastResult(requestId)', description: 'During the next frame: { objectId, object, point, normal, distance }, or null for a miss. undefined in any other frame.' },
            { signature: 'ctx.playSound(audioId, bus?)', description: "Plays a sound once on 'sfx' (default), 'music', 'ui' or 'master'." },
            { signature: 'ctx.playPlayerAnimation(clipName, maskBone?)', description: 'Plays a clip once on the player, optionally on one bone and the bones below it.' },
            { signature: 'ctx.openLevel(levelId)', description: 'Loads another level of the game.' },
            { signature: 'ctx.startDialogue(objectId?)', description: "Opens the conversation of the object's Dialogue component (default: this script's object). Does nothing while another is open." },
            { signature: 'ctx.spline(objectId)', description: "The object's Spline in world space and metres: { length, closed, pointAt(distance) → { position, direction, up }, closest([x, y, z]) → { distance, position } }, or null." },
            { signature: 'ctx.vehicle(objectId)', description: "The object's Vehicle: { speed (km/h), gear, playerDriving, enter(), setInput({ throttle, brake, steer, handbrake }), release() }, or null." },
            { signature: 'ctx.playerVehicle()', description: 'The id of the vehicle the player drives, or null on foot.' },
            { signature: 'ctx.exitVehicle()', description: 'Takes the player out of their vehicle at once, beside it.' },
            { signature: 'ctx.particles(objectId?)', description: "The object's particle effects (default: this script's object): { play(), stop(clear?), emit(count?) }." },
            { signature: 'ctx.timeOfDay()', description: 'The hour (0-24), how light it is after the weather (0-1) and whether it is night: { hours, light, night }.' },
            { signature: 'ctx.setTimeOfDay(hours) / ctx.setDayLength(minutes)', description: 'Moves the clock to an hour; sets how many real minutes a day takes (0 stops it).' },
            { signature: 'ctx.weather()', description: 'The weather now: { preset, clouds, rain, snow, fog, wind, wetness, snowCover }.' },
            { signature: 'ctx.explode(position, radius?, damage?, force?)', description: 'A blast: characters and breakable objects in reach take damage (less further out), loose bodies are thrown.' },
            { signature: 'ctx.breakObject(id) / ctx.damageObject(id, amount)', description: 'Breaks an object with a Destructible component at once, or takes from its health.' },
            { signature: 'ctx.objectHealth(id)', description: '{ health, maxHealth, broken } of an object that can break; null otherwise.' },
            { signature: 'ctx.abilities.use(actor, ability, target?)', description: "Uses an actor's ability (the player is 'player'): on target, or on what it aims at in range." },
            { signature: 'ctx.abilities.applyEffect(target, effect, source?) / removeEffect(actor, effect)', description: "Applies an effect to an actor or any character (looked up on source's Abilities first), or ends one." },
            { signature: 'ctx.abilities.attribute(actor, name) / maxAttribute(actor, name)', description: "An attribute's value now and its upper bound; null when the actor has none." },
            { signature: 'ctx.abilities.addAttribute(actor, name, amount) / setAttribute(actor, name, value)', description: "Changes an attribute's base value, within its bounds." },
            { signature: 'ctx.abilities.hasTag / tags / addTag / removeTag (actor, tag)', description: "An actor's tags: 'State.Stunned' counts as 'State'." },
            { signature: 'ctx.abilities.cooldown(actor, ability) / effects(actor) / actors()', description: 'Seconds of cooldown left, the lasting effects on an actor, and every actor with abilities.' },
            { signature: "ctx.setSkyPreset(name, seconds?, withHour?)", description: "Heads for a whole sky preset over seconds (default 10): 'fair-day', 'sunset', 'moonlit-night', 'thunderstorm', 'dust-world' and the rest in the sky's preset gallery. With withHour the clock moves to its hour too." },
            { signature: "ctx.setWeather(name, seconds?)", description: "Heads for a weather preset over seconds (default 10): 'clear', 'cloudy', 'overcast', 'fog', 'rain', 'storm', 'snow' or 'blizzard'." },
        ],
    },
    {
        title: 'Input, variables and state',
        entries: [
            { signature: 'ctx.input.isDown(action)', description: 'Whether an input action is held. wasPressed and wasReleased say whether it changed since the previous frame.' },
            { signature: 'ctx.input.value(action)', description: 'An axis value from -1 to 1; 1 or 0 for buttons.' },
            { signature: 'ctx.vars.get(name)', description: 'A level variable, or undefined.' },
            { signature: 'ctx.vars.set(name, value)', description: 'Writes a level variable (number, boolean or string). Every script sees it at once.' },
            { signature: 'ctx.state', description: 'An object kept between callbacks, for this script only.' },
            { signature: 'ctx.log(...), ctx.warn(...), ctx.error(...)', description: 'Prints a message in the play output, labelled with the object.' },
        ],
    },
];

const LINE_HEIGHT_PX = 20;
const PADDING_PX = 12;
const SIZE_WARNING_RATIO = 0.9;
const REFERENCE_MIN_WINDOW_WIDTH = 900;
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** UTF-8 size of `text` in bytes, the measure SCRIPT_LIMITS.maxSourceBytes applies to. */
export const utf8ByteLength = (text: string): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
            // A surrogate pair is one 4-byte code point.
            bytes += 4;
            index++;
        } else bytes += 3;
    }
    return bytes;
};

/** A byte count in KiB with one decimal, e.g. "3.2 KiB". */
export const formatScriptSize = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

/** Number of lines in `text`; an empty text has one. */
export const countLines = (text: string): number => {
    let lines = 1;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines++;
    return lines;
};

const lineStartOf = (text: string, position: number) => text.lastIndexOf('\n', position - 1) + 1;

/**
 * Tab and Shift+Tab. Tab with a bare caret inserts spaces up to the next indent stop; Tab with a
 * selection indents every line it touches (blank lines stay empty); Shift+Tab removes up to one
 * indent step from the start of each touched line. A selection ending at the start of a line
 * leaves that line alone. Returns null when nothing changes.
 */
export const indentSelection = (text: string, start: number, end: number, outdent: boolean): ScriptTextEdit | null => {
    if (!outdent && start === end) {
        const column = start - lineStartOf(text, start);
        const insert = ' '.repeat(SCRIPT_INDENT.length - (column % SCRIPT_INDENT.length));
        return { from: start, to: end, insert, selectionStart: start + insert.length, selectionEnd: start + insert.length };
    }
    const from = lineStartOf(text, start);
    const lastPosition = end > start && text[end - 1] === '\n' ? end - 1 : end;
    const lineEnd = text.indexOf('\n', lastPosition);
    const to = lineEnd === -1 ? text.length : lineEnd;
    const lines = text.slice(from, to).split('\n');
    const changed = lines.map((line) => {
        if (!outdent) return line.length === 0 ? line : SCRIPT_INDENT + line;
        if (line.startsWith('\t')) return line.slice(1);
        const spaces = /^ */.exec(line)?.[0].length ?? 0;
        return line.slice(Math.min(spaces, SCRIPT_INDENT.length));
    });
    const insert = changed.join('\n');
    if (insert === text.slice(from, to)) return null;

    // Moves an old caret position to where the same character sits after the edit.
    const map = (position: number) => {
        if (position > to) return position + insert.length - (to - from);
        let lineStart = from;
        let shift = 0;
        for (let index = 0; index < lines.length; index++) {
            const lineLength = lines[index].length;
            const delta = changed[index].length - lineLength;
            if (position <= lineStart + lineLength) {
                const column = position - lineStart;
                // A caret at the start of a line stays there when the line is indented.
                return position + shift + (delta > 0 ? (column > 0 ? delta : 0) : -Math.min(-delta, column));
            }
            shift += delta;
            lineStart += lineLength + 1;
        }
        return position + shift;
    };
    return { from, to, insert, selectionStart: map(start), selectionEnd: map(end) };
};

/** Enter: a new line with the current line's indentation, one step deeper after an opening bracket. */
export const newlineWithIndent = (text: string, start: number, end: number): ScriptTextEdit => {
    const before = text.slice(lineStartOf(text, start), start);
    const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
    const insert = `\n${indent}${/[{[(]\s*$/.test(before) ? SCRIPT_INDENT : ''}`;
    return { from: start, to: end, insert, selectionStart: start + insert.length, selectionEnd: start + insert.length };
};

/** Line and column (both from 1) of a caret position. */
const caretPosition = (text: string, position: number) => {
    const before = text.slice(0, position);
    return { line: countLines(before), column: position - lineStartOf(text, position) + 1 };
};

interface ScriptEditorModalProps {
    /** What the script belongs to, shown under the title (e.g. the object's name). */
    title: string;
    /**
     * The script as stored. The editor has unsaved changes while its text differs from this, so a
     * save the parent did not apply still shows as unsaved.
     */
    source: string;
    /** Text to start from instead of `source`, e.g. a template; it counts as unsaved until saved. */
    initialDraft?: string;
    /** Project ids the reference panel can insert (prefabs, sounds, levels). */
    references?: ScriptReferenceGroup[];
    /** Commits the text, which comes back as `source`. A throw (e.g. a read-only project) is shown in the editor. */
    onSave: (source: string) => void;
    /** Closes the editor; any unsaved changes have already been confirmed as discarded. */
    onClose: () => void;
}

/**
 * Full-window code editor for a gameplay script: a monospace text area with a line-number gutter,
 * Tab / Shift+Tab indenting, Ctrl+S to save, a size meter against SCRIPT_LIMITS.maxSourceBytes
 * (saving is refused over it), and a collapsible API reference. Closing with unsaved changes asks
 * first, inside the editor. Keys pressed in the editor never reach the World Editor's shortcuts.
 */
export const ScriptEditorModal: React.FC<ScriptEditorModalProps> = ({ title, source, initialDraft, references, onSave, onClose }) => {
    const [draft, setDraft] = useState(initialDraft ?? source);
    const [confirmingClose, setConfirmingClose] = useState(false);
    // The reference panel starts closed where it would squeeze the text too much.
    const [referenceOpen, setReferenceOpen] = useState(() => window.innerWidth >= REFERENCE_MIN_WINDOW_WIDTH);
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [tabMovesFocus, setTabMovesFocus] = useState(false);
    const [caret, setCaret] = useState({ line: 1, column: 1 });
    const [saveError, setSaveError] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const gutterRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const confirmRef = useRef<HTMLDivElement>(null);
    const keepEditingRef = useRef<HTMLButtonElement>(null);
    const baseId = useId();
    const titleId = `${baseId}-title`;
    const referenceId = `${baseId}-reference`;
    const sizeId = `${baseId}-size`;

    useEffect(() => {
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(0, 0);
        return () => { if (returnFocus?.isConnected) returnFocus.focus(); };
    }, []);

    useEffect(() => {
        if (confirmingClose) keepEditingRef.current?.focus();
    }, [confirmingClose]);

    const bytes = useMemo(() => utf8ByteLength(draft), [draft]);
    const lineCount = useMemo(() => countLines(draft), [draft]);
    const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'), [lineCount]);
    const overLimit = bytes > SCRIPT_LIMITS.maxSourceBytes;
    const nearLimit = !overLimit && bytes > SCRIPT_LIMITS.maxSourceBytes * SIZE_WARNING_RATIO;
    const dirty = draft !== source;
    const gutterWidth = `${Math.max(3, String(lineCount).length) + 2}ch`;

    const syncGutter = () => {
        const textarea = textareaRef.current;
        if (textarea && gutterRef.current) gutterRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
    };

    const updateCaret = () => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const next = caretPosition(textarea.value, textarea.selectionStart);
        setCaret(current => (current.line === next.line && current.column === next.column ? current : next));
    };

    /** Applies an edit through the browser's own text insertion so Ctrl+Z still undoes it. */
    const applyEdit = (edit: ScriptTextEdit) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const expected = textarea.value.slice(0, edit.from) + edit.insert + textarea.value.slice(edit.to);
        textarea.focus();
        textarea.setSelectionRange(edit.from, edit.to);
        let inserted = false;
        try {
            inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, edit.insert);
        } catch {
            inserted = false;
        }
        if (!inserted || textarea.value !== expected) {
            textarea.value = expected;
            setDraft(expected);
        }
        textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
        updateCaret();
        syncGutter();
    };

    /** Hands the draft to onSave; false when that threw, with the reason shown in the footer. */
    const commit = () => {
        try {
            onSave(draft);
            setSaveError(null);
            return true;
        } catch (error) {
            frontendDiagnostics.failure('script_editor_save_failed', error);
            setSaveError(error instanceof Error && error.message ? error.message : 'unknown error');
            setConfirmingClose(false);
            return false;
        }
    };

    const save = () => {
        if (!overLimit && dirty) commit();
    };

    const saveAndClose = () => {
        if (overLimit) return;
        if (!dirty || commit()) onClose();
    };

    const requestClose = () => {
        if (dirty) setConfirmingClose(true);
        else onClose();
    };

    const keepEditing = () => {
        setConfirmingClose(false);
        textareaRef.current?.focus();
    };

    const trapFocus = (event: React.KeyboardEvent) => {
        const container = confirmingClose ? confirmRef.current : panelRef.current;
        if (!container) return;
        const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const active = document.activeElement;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (active === first || !container.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !container.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleRootKeyDown = (event: React.KeyboardEvent) => {
        // The World Editor's shortcuts listen on window; none of them may act on keys typed here.
        event.stopPropagation();
        const key = event.key.toLowerCase();
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (confirmingClose) keepEditing();
            else requestClose();
        } else if ((event.ctrlKey || event.metaKey) && key === 's') {
            event.preventDefault();
            if (!confirmingClose) save();
        } else if (event.key === 'Tab' && !event.defaultPrevented) {
            trapFocus(event);
        }
    };

    const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const textarea = event.currentTarget;
        const modified = event.ctrlKey || event.metaKey;
        if (modified && !event.altKey && event.key.toLowerCase() === 'm') {
            event.preventDefault();
            setTabMovesFocus(value => !value);
            return;
        }
        if (event.key === 'Tab' && !modified && !event.altKey && !tabMovesFocus) {
            event.preventDefault();
            const edit = indentSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, event.shiftKey);
            if (edit) applyEdit(edit);
            return;
        }
        if (event.key === 'Enter' && !modified && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            applyEdit(newlineWithIndent(textarea.value, textarea.selectionStart, textarea.selectionEnd));
        }
    };

    const insertAtCaret = (text: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const { selectionStart, selectionEnd } = textarea;
        const caretAfter = selectionStart + text.length;
        applyEdit({ from: selectionStart, to: selectionEnd, insert: text, selectionStart: caretAfter, selectionEnd: caretAfter });
    };

    const replaceScript = (text: string) => {
        const textarea = textareaRef.current;
        if (textarea) applyEdit({ from: 0, to: textarea.value.length, insert: text, selectionStart: 0, selectionEnd: 0 });
    };

    const insertReference = (id: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const text = `'${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        const { selectionStart, selectionEnd } = textarea;
        const caretAfter = selectionStart + text.length;
        applyEdit({ from: selectionStart, to: selectionEnd, insert: text, selectionStart: caretAfter, selectionEnd: caretAfter });
    };

    const sizeRatio = Math.min(1, bytes / SCRIPT_LIMITS.maxSourceBytes);
    const sizeColor = overLimit ? 'bg-red-500' : nearLimit ? 'bg-amber-500' : 'bg-blue-500';
    const textStyle: React.CSSProperties = { lineHeight: `${LINE_HEIGHT_PX}px`, fontSize: 12 };

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 outline-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={handleRootKeyDown}
        >
            <div ref={panelRef} className="relative flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
                <div className="flex items-center justify-between gap-3 border-b border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <FileCode2 size={18} className="shrink-0 text-blue-400" />
                        <div className="min-w-0">
                            <h2 id={titleId} className="text-sm font-bold text-white">Edit Script</h2>
                            <p className="truncate text-[10px] text-gray-500" title={title}>{title} · JavaScript or TypeScript · runs during play</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setAssistantOpen(open => !open)}
                            aria-expanded={assistantOpen}
                            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors ${assistantOpen ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                        >
                            <Sparkles size={12} /> AI
                        </button>
                        <button
                            type="button"
                            onClick={() => setReferenceOpen(open => !open)}
                            aria-expanded={referenceOpen}
                            aria-controls={referenceId}
                            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors ${referenceOpen ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                        >
                            <BookOpen size={12} /> API Reference
                        </button>
                        <button type="button" onClick={requestClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close script editor"><X size={16} /></button>
                    </div>
                </div>

                <div className="flex min-h-0 flex-1">
                    <div className="flex min-w-0 flex-1 bg-gray-950">
                        <div className="relative shrink-0 select-none overflow-hidden border-r border-gray-800 bg-gray-950 font-mono text-gray-500" style={{ width: gutterWidth, fontSize: 12 }} aria-hidden="true">
                            <div ref={gutterRef} data-testid="script-gutter" className="absolute inset-x-0 top-0 will-change-transform">
                                <div
                                    className="absolute inset-x-0 bg-gray-800/60"
                                    style={{ top: PADDING_PX + (caret.line - 1) * LINE_HEIGHT_PX, height: LINE_HEIGHT_PX }}
                                />
                                <pre className="relative m-0 pr-2 text-right" style={{ ...textStyle, paddingTop: PADDING_PX, paddingBottom: PADDING_PX }}>{lineNumbers}</pre>
                            </div>
                        </div>
                        <textarea
                            ref={textareaRef}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={handleEditorKeyDown}
                            onScroll={syncGutter}
                            onSelect={updateCaret}
                            onKeyUp={updateCaret}
                            onMouseUp={updateCaret}
                            wrap="off"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            aria-label="Script source"
                            aria-describedby={sizeId}
                            className="min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent font-mono text-gray-100 caret-blue-400 outline-none"
                            style={{ ...textStyle, padding: PADDING_PX, tabSize: SCRIPT_INDENT.length }}
                        />
                    </div>

                    {assistantOpen && (
                        <aside aria-label="Script assistant" className="w-80 shrink-0 overflow-y-auto border-l border-gray-800 bg-gray-900 p-4 custom-scrollbar">
                            <ScriptAssistant draft={draft} reference={SCRIPT_API_REFERENCE} onReplace={replaceScript} onInsert={insertAtCaret} />
                        </aside>
                    )}

                    {referenceOpen && (
                        <aside id={referenceId} aria-label="Script API reference" className="w-80 shrink-0 space-y-4 overflow-y-auto border-l border-gray-800 bg-gray-900 p-4 custom-scrollbar">
                            {SCRIPT_API_REFERENCE.map(section => (
                                <section key={section.title} className="space-y-1.5">
                                    <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{section.title}</h3>
                                    <dl className="space-y-1.5">
                                        {section.entries.map(entry => (
                                            <div key={entry.signature}>
                                                <dt className="font-mono text-[11px] text-blue-300">{entry.signature}</dt>
                                                <dd className="text-[10px] leading-snug text-gray-400">{entry.description}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </section>
                            ))}
                            {references && references.length > 0 && (
                                <section className="space-y-2 border-t border-gray-800 pt-3">
                                    <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Insert an id</h3>
                                    <p className="text-[10px] leading-snug text-gray-500">Click a name to insert its id at the cursor, in quotes.</p>
                                    {references.map(group => (
                                        <div key={group.label} className="space-y-1">
                                            <div className="text-[10px] text-gray-400">{group.label} <span className="font-mono text-gray-600">{group.usage}</span></div>
                                            {group.items.length === 0 ? (
                                                <div className="text-[10px] italic text-gray-600">None in this project.</div>
                                            ) : (
                                                <ul className="space-y-0.5">
                                                    {group.items.map(item => (
                                                        <li key={item.id}>
                                                            <button
                                                                type="button"
                                                                onClick={() => insertReference(item.id)}
                                                                className="w-full truncate rounded px-2 py-1 text-left text-[11px] text-gray-300 hover:bg-gray-800 hover:text-white"
                                                                title={item.id}
                                                                aria-label={`Insert id of ${item.name} (${group.label})`}
                                                            >
                                                                {item.name}
                                                            </button>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    ))}
                                </section>
                            )}
                        </aside>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-4 text-[10px] text-gray-500">
                        <span>Ln {caret.line}, Col {caret.column}</span>
                        <span>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
                        <span title="Ctrl+M switches Tab between indenting and moving focus">{tabMovesFocus ? 'Tab moves focus' : 'Tab indents'}</span>
                        <div id={sizeId} className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded bg-gray-800" aria-hidden="true">
                                <div className={`h-full ${sizeColor}`} style={{ width: `${sizeRatio * 100}%` }} />
                            </div>
                            <span className={overLimit ? 'text-red-400' : nearLimit ? 'text-amber-400' : ''}>
                                {formatScriptSize(bytes)} / {formatScriptSize(SCRIPT_LIMITS.maxSourceBytes)}
                            </span>
                            {overLimit && (
                                <span role="alert" className="text-red-400">Over the size limit; shorten the script to save it.</span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {saveError && <span role="alert" className="max-w-xs truncate text-[10px] text-red-400" title={saveError}>Not saved: {saveError}</span>}
                        {dirty && !saveError && <span className="text-[10px] text-amber-400">Unsaved changes</span>}
                        <button type="button" onClick={requestClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
                        <button
                            type="button"
                            onClick={save}
                            disabled={overLimit || !dirty}
                            title="Save (Ctrl+S)"
                            className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
                        >
                            <Save size={12} /> Save
                        </button>
                        <button
                            type="button"
                            onClick={saveAndClose}
                            disabled={overLimit}
                            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                            Save &amp; Close
                        </button>
                    </div>
                </div>

                {confirmingClose && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
                        <div
                            ref={confirmRef}
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby={`${baseId}-confirm-title`}
                            aria-describedby={`${baseId}-confirm-text`}
                            className="w-full max-w-sm space-y-3 rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-2xl"
                        >
                            <h3 id={`${baseId}-confirm-title`} className="text-sm font-bold text-white">Discard unsaved changes?</h3>
                            <p id={`${baseId}-confirm-text`} className="text-[11px] text-gray-400">
                                Your changes to this script have not been saved.{overLimit ? ' The script is over the size limit, so it cannot be saved as it is.' : ''}
                            </p>
                            <div className="flex justify-end gap-2 pt-1">
                                <button ref={keepEditingRef} type="button" onClick={keepEditing} className="rounded px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white">Keep Editing</button>
                                <button type="button" onClick={onClose} className="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500">Discard</button>
                                <button type="button" onClick={saveAndClose} disabled={overLimit} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">Save &amp; Close</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default ScriptEditorModal;
