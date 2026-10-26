
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HUDCanvas } from './HUDCanvas';
import { HUDLibrary } from './HUDLibrary';
import { AIChatPanel } from './AIChatPanel';
import { HUDActionField, describeMenuAction } from './HUDActionField';
import { bindablePropsFor, HUDBindingField, hudBindingPath, withHUDBinding } from './HUDBindingField';
import { clampHUDPosition, HUD_REFERENCE_SIZE, HUDElement, normalizeHUDLayout } from './types';
import { AVAILABLE_COMPONENTS } from './componentRegistry';
import { Code, Settings2, Sliders, Palette, Type, Move, Scaling, Undo2, Redo2, AlertTriangle } from 'lucide-react';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import { useEditorHistory } from '../../utils/history';
import { editorSession } from '../../utils/editorSession';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { useLevel } from '../../context/LevelContext';
import {
    createDefaultLocalizationDocument,
    localization,
    LOCALIZATION_DOCUMENT_ID,
    type LocalizationDocument,
} from '../../runtime/localization';
import {
    findMenuDocument,
    PAUSE_MENU_DOCUMENT_ID,
    PAUSE_MENU_REQUIRED_ACTIONS,
    TITLE_MENU_DOCUMENT_ID,
    TITLE_MENU_REQUIRED_ACTIONS,
    type MenuActionKind,
} from '../../player/menus';

/** One authored HUD screen, stored as its own document in the project 'hud' domain. */
export interface HUDDocument {
    id: string;
    name: string;
    elements: HUDElement[];
    layout: { width: number; height: number };
    commands: unknown[];
}

const HUD_MAIN_DOCUMENT_ID = 'hud-main';

export interface HUDDocumentDescriptor {
    id: string;
    label: string;
    /** Stable per document: the project document hook re-hydrates when it changes. */
    createDefault: () => HUDDocument;
    /** A menu replaces the built-in one only when a visible element offers one of these. */
    requiredActions?: readonly MenuActionKind[];
}

const STAGE_WIDTH = HUD_REFERENCE_SIZE.width;
const BUTTON_SIZE = { width: 420, height: 72 };
const BUTTON_GAP = 20;

const element = (
    id: string,
    name: string,
    type: string,
    props: Record<string, unknown>,
    position: HUDElement['position'],
    size: HUDElement['size'],
    zIndex: number,
    isLocked = false,
): HUDElement => ({ id, name, type, props, position, size, zIndex, isVisible: true, isLocked });

const titleText = (documentId: string, text: string, top: number, fontSize: number): HUDElement => element(
    `${documentId}-title`, 'Title', 'Text',
    { text, color: '#ffffff', fontSize, fontWeight: 'bold', fontFamily: 'sans-serif', textAlign: 'center' },
    { x: (STAGE_WIDTH - 1200) / 2, y: top }, { width: 1200, height: Math.round(fontSize * 1.4) }, 2,
);

type MenuButton = { action: string; label: string; variant?: string };

/** A centred column of buttons; ids derive from the action so defaults are stable across loads. */
const buttonColumn = (documentId: string, top: number, buttons: readonly MenuButton[]): HUDElement[] => buttons.map((button, index) => element(
    `${documentId}-${button.action}`, `${button.label} Button`, 'Button',
    { label: button.label, action: button.action, variant: button.variant ?? 'secondary', fontSize: 28 },
    { x: (STAGE_WIDTH - BUTTON_SIZE.width) / 2, y: top + index * (BUTTON_SIZE.height + BUTTON_GAP) },
    { ...BUTTON_SIZE }, 10 + index,
));

const createDocument = (id: string, name: string, elements: HUDElement[]): HUDDocument => ({
    id, name, elements, layout: { ...HUD_REFERENCE_SIZE }, commands: [],
});

const createDefaultMainHUD = (): HUDDocument => createDocument(HUD_MAIN_DOCUMENT_ID, 'Main HUD', []);

const createDefaultTitleMenu = (): HUDDocument => createDocument(TITLE_MENU_DOCUMENT_ID, 'Title Menu', [
    titleText(TITLE_MENU_DOCUMENT_ID, 'GAME TITLE', 220, 96),
    ...buttonColumn(TITLE_MENU_DOCUMENT_ID, 460, [
        { action: 'play', label: 'Play', variant: 'primary' },
        { action: 'continue', label: 'Continue' },
        { action: 'options', label: 'Options' },
        { action: 'quit', label: 'Quit', variant: 'outline' },
    ]),
]);

const createDefaultPauseMenu = (): HUDDocument => createDocument(PAUSE_MENU_DOCUMENT_ID, 'Pause Menu', [
    // Locked so clicks on the dimmed game do not drag the backdrop; unlock it from Layers.
    element(
        `${PAUSE_MENU_DOCUMENT_ID}-backdrop`, 'Backdrop', 'Container',
        { backgroundColor: 'rgba(0,0,0,0.6)', borderColor: 'transparent', borderWidth: 0, borderRadius: 0 },
        { x: 0, y: 0 }, { ...HUD_REFERENCE_SIZE }, 1, true,
    ),
    titleText(PAUSE_MENU_DOCUMENT_ID, 'PAUSED', 200, 72),
    ...buttonColumn(PAUSE_MENU_DOCUMENT_ID, 360, [
        { action: 'resume', label: 'Resume', variant: 'primary' },
        { action: 'save', label: 'Save' },
        { action: 'load', label: 'Load' },
        { action: 'options', label: 'Options' },
        { action: 'quit', label: 'Quit to title', variant: 'outline' },
    ]),
]);

export const HUD_DOCUMENTS: readonly HUDDocumentDescriptor[] = [
    { id: HUD_MAIN_DOCUMENT_ID, label: 'Game HUD', createDefault: createDefaultMainHUD },
    { id: TITLE_MENU_DOCUMENT_ID, label: 'Title menu', createDefault: createDefaultTitleMenu, requiredActions: TITLE_MENU_REQUIRED_ACTIONS },
    { id: PAUSE_MENU_DOCUMENT_ID, label: 'Pause menu', createDefault: createDefaultPauseMenu, requiredActions: PAUSE_MENU_REQUIRED_ACTIONS },
];

const getHUDDocumentDescriptor = (id: string): HUDDocumentDescriptor =>
    HUD_DOCUMENTS.find(descriptor => descriptor.id === id) ?? HUD_DOCUMENTS[0];

const listActions = (kinds: readonly MenuActionKind[]): string => {
    const labels = kinds.map(describeMenuAction);
    return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels.join('');
};

// Continuous edits to the same field (typing, scrubbing) within this window
// collapse into one undo step.
const HISTORY_COALESCE_MS = 800;

/** Text and Button take a string-table key that wins over their literal text when set, unless the literal is bound. */
const LOCALIZED_KEY_PROPS: Readonly<Record<string, { literal: string; key: string; hint: string }>> = {
    Text: { literal: 'text', key: 'textKey', hint: 'String key from Localization; overrides the text unless it is bound.' },
    Button: { literal: 'label', key: 'labelKey', hint: 'String key from Localization; overrides the label unless it is bound.' },
};

/** True when the element's string key is set, matching how the components decide the key wins. */
const hasLocalizedKey = (element: HUDElement, key: string): boolean => {
    const value = element.props[key];
    return typeof value === 'string' && value.trim() !== '';
};

/**
 * The hint under one attribute. During play a live binding wins over the string key, and the key
 * still shows its translation in the editor and wherever the value is not bound.
 */
const attributeHint = (
    element: HUDElement,
    key: string,
    localized: { literal: string; key: string; hint: string } | undefined,
): string | null => {
    const boundTo = hudBindingPath(element.props.bind, key);
    if (boundTo) return `Bound to ${boundTo}; shows the live value while playing.`;
    if (!localized || key !== localized.key) return null;
    const literalBoundTo = hudBindingPath(element.props.bind, localized.literal);
    return literalBoundTo && hasLocalizedKey(element, localized.key)
        ? `${localized.hint} While playing, the live value of ${literalBoundTo} is shown instead.`
        : localized.hint;
};

/** Props the Attributes list edits, with the localized key listed right after its literal even when unset. */
const attributeKeys = (element: HUDElement): string[] => {
    // `action` and `bind` have their own fields below.
    const keys = Object.keys(element.props).filter(key => key !== 'action' && key !== 'bind');
    const localized = LOCALIZED_KEY_PROPS[element.type];
    if (localized && !keys.includes(localized.key)) {
        const after = keys.indexOf(localized.literal);
        keys.splice(after === -1 ? keys.length : after + 1, 0, localized.key);
    }
    return keys;
};

// Helper to render dynamic inputs based on prop type
const PropertyInput: React.FC<{
    label: string;
    value: any;
    onChange: (val: any) => void;
    isMultiline?: boolean;
    options?: readonly string[];
    /** Id of a hint element describing this input. */
    describedBy?: string;
}> = ({ label, value, onChange, isMultiline, options, describedBy }) => {
    const type = typeof value;
    const isColor = label.toLowerCase().includes('color');

    if (Array.isArray(options)) {
        return (
            <label className="block space-y-1">
                <span className="text-[10px] text-gray-500 font-bold uppercase">{label}</span>
                <select
                    value={String(value ?? '')}
                    aria-describedby={describedBy}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                >
                    {!options.includes(String(value ?? '')) && <option value={String(value ?? '')} disabled>{String(value ?? '') || '--'}</option>}
                    {options.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
            </label>
        );
    }

    if (isMultiline) {
        return (
            <div className="space-y-1">
                <span className="text-[10px] text-gray-500 font-bold uppercase">{label}</span>
                <textarea 
                    value={value} 
                    onChange={(e) => onChange(e.target.value)} 
                    className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-[10px] font-mono text-blue-300 focus:outline-none focus:border-blue-500 h-48 resize-y leading-tight"
                    spellCheck={false}
                />
            </div>
        );
    }

    if (isColor) {
        return (
            <div className="flex items-center justify-between bg-gray-800 p-2 rounded border border-gray-700">
                <span className="text-[10px] text-gray-400 font-medium uppercase truncate mr-2">{label}</span>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-gray-500 uppercase">{value}</span>
                    <input 
                        type="color" 
                        value={value} 
                        onChange={(e) => onChange(e.target.value)}
                        className="w-6 h-6 rounded cursor-pointer bg-transparent border-0 p-0"
                    />
                </div>
            </div>
        );
    }

    if (type === 'boolean') {
        return (
            <label className="flex items-center justify-between bg-gray-800 p-2 rounded border border-gray-700 cursor-pointer hover:border-gray-600 transition-colors">
                <span className="text-[10px] text-gray-400 font-medium uppercase">{label}</span>
                <div className={`w-8 h-4 rounded-full relative transition-colors ${value ? 'bg-blue-500' : 'bg-gray-600'}`}>
                    <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${value ? 'left-4.5' : 'left-0.5'}`} style={{ left: value ? 'calc(100% - 14px)' : '2px' }} />
                </div>
                <input 
                    type="checkbox" 
                    checked={value} 
                    onChange={(e) => onChange(e.target.checked)} 
                    className="hidden" 
                />
            </label>
        );
    }

    if (type === 'number') {
        return (
            <div className="flex items-center justify-between bg-gray-800 p-1 pl-2 rounded border border-gray-700">
                <span className="text-[10px] text-gray-400 font-medium uppercase mr-2">{label}</span>
                <div className="w-20">
                    <ScrubbableInput 
                        label="" 
                        value={value} 
                        onChange={onChange} 
                        step={label.toLowerCase().includes('opacity') ? 0.05 : 1}
                        labelWidth="w-0" 
                    />
                </div>
            </div>
        );
    }

    // Default String/Text
    return (
        <label className="block space-y-1">
            <span className="text-[10px] text-gray-500 font-bold uppercase">{label}</span>
            <input
                type="text"
                value={value ?? ''}
                aria-describedby={describedBy}
                onChange={(e) => onChange(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
            />
        </label>
    );
};

export const HUDEditor: React.FC = () => {
    // The game HUD and each menu screen are separate documents in the 'hud' domain.
    const [documentId, setDocumentId] = useState(HUD_MAIN_DOCUMENT_ID);
    const descriptor = getHUDDocumentDescriptor(documentId);
    const { document, hydrated, error, replace, refresh } = useNativeProjectDocument<HUDDocument>(
        'hud', descriptor.id, descriptor.createDefault,
    );
    // The preview resolves textKey/labelKey against the project's string tables, so load them on open
    // rather than only when the Localization panel saves.
    const { document: localizationDocument } = useNativeProjectDocument<LocalizationDocument>(
        'metadata', LOCALIZATION_DOCUMENT_ID, createDefaultLocalizationDocument,
    );
    useEffect(() => {
        localization.load(localizationDocument.settings);
    }, [localizationDocument]);
    // The granular level context, so scene edits elsewhere do not re-render the HUD editor.
    const { levels } = useLevel();
    // Right after a switch the hook still holds the previous document until it re-hydrates.
    const loading = !hydrated || document.id !== descriptor.id;
    // The host's AI commands read and write the canonical game HUD only.
    const aiAvailable = descriptor.id === HUD_MAIN_DOCUMENT_ID;
    const elements = document.elements;
    const layout = normalizeHUDLayout(document.layout);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rightPanelTab, setRightPanelTab] = useState<'ai' | 'props'>('props');
    const [canvasScale, setCanvasScale] = useState(1);
    const session = useSyncExternalStore(editorSession.subscribe, editorSession.getSnapshot, editorSession.getSnapshot);
    // Host-applied transactions (AI approve/undo) refresh the document, so local snapshots are stale.
    const [historyEpoch, setHistoryEpoch] = useState(0);
    const lastEditRef = useRef<{ key: string; at: number } | null>(null);
    const dragStartRef = useRef<HUDDocument | null>(null);

    const history = useEditorHistory<HUDDocument>({
        value: document,
        apply: (restored) => {
            lastEditRef.current = null;
            void replace(restored).catch((cause) => frontendDiagnostics.failure('hud_history_apply_failed', cause));
        },
        active: !loading,
        // Revision bumps re-hydrate after every write; only a project/session/document switch invalidates history.
        resetKey: `${session.projectId}:${session.generation}:${historyEpoch}:${descriptor.id}`,
    });

    const handleSwitchDocument = (nextId: string) => {
        if (nextId === descriptor.id) return;
        lastEditRef.current = null;
        dragStartRef.current = null;
        setSelectedId(null);
        if (nextId !== HUD_MAIN_DOCUMENT_ID) setRightPanelTab('props');
        setDocumentId(nextId);
    };

    // A menu without a visible element offering a required action is ignored by the player.
    const missingMenuActions = descriptor.requiredActions && !loading
        && !findMenuDocument([document], descriptor.id, descriptor.requiredActions)
        ? descriptor.requiredActions
        : null;

    /** Snapshot the document before a change. Rapid edits sharing `coalesceKey` become one undo step. */
    const recordChange = (coalesceKey: string | null = null) => {
        // While re-hydrating, `document` is the default template and must never become an undo step.
        if (loading) return;
        const now = Date.now();
        const last = lastEditRef.current;
        if (coalesceKey && last && last.key === coalesceKey && now - last.at < HISTORY_COALESCE_MS) {
            last.at = now;
            return;
        }
        lastEditRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
        history.record(document);
    };

    const handleRefresh = useCallback(() => {
        setHistoryEpoch((epoch) => epoch + 1);
        refresh();
    }, [refresh]);

    // Every element write goes through here. After each write the hook resets `document` to the
    // default template while the stored copy re-hydrates; writing then would save that template.
    const commitElements = useCallback((nextElements: HUDElement[]) => {
        if (loading) return Promise.resolve();
        return replace({ ...document, elements: nextElements });
    }, [document, replace, loading]);

    // Selection and editor-only tabs are transient and must not survive a
    // project switch or point at a document that was not restored.
    useEffect(() => {
        if (selectedId && !elements.some((element) => element.id === selectedId)) setSelectedId(null);
    }, [elements, selectedId]);

    const selectedElement = elements.find(el => el.id === selectedId) || null;

    const handleAddElement = (type: string, overrides: Partial<HUDElement> = {}) => {
        const def = AVAILABLE_COMPONENTS.find(c => c.type === type);
        if (!def) return;

        const newEl: HUDElement = {
            id: crypto.randomUUID(),
            name: `${def.label} ${elements.length + 1}`,
            type: def.type,
            props: { ...def.defaultProps, ...(overrides.props || {}) },
            position: clampHUDPosition(
                overrides.position || { x: (layout.width - def.defaultSize.width) / 2, y: (layout.height - def.defaultSize.height) / 2 },
                overrides.size || def.defaultSize,
                layout,
            ),
            size: overrides.size || { ...def.defaultSize },
            zIndex: elements.length + 1,
            isVisible: true,
            isLocked: false
        };

        recordChange();
        void commitElements([...elements, newEl]).catch((cause) => frontendDiagnostics.failure('hud_element_add_failed', cause));
        
        // Only select and switch tabs if triggered manually, OR if AI created it we might want to select it
        // The override ID 'ai' is a hack to detect source, but we can just check overrides
        const isAiGenerated = overrides.id === 'ai';
        
        if (!isAiGenerated) {
             setSelectedId(newEl.id);
             setRightPanelTab('props'); 
        } else {
             // If AI created it, select it but stay on AI tab
             setSelectedId(newEl.id);
        }
    };

    // Untracked write: canvas drags stream through here and are recorded once at drag end.
    const applyElementUpdate = (id: string, updates: Partial<HUDElement>) => {
        void commitElements(elements.map(el => {
            if (el.id !== id) return el;
            const next = { ...el, ...updates };
            return { ...next, position: clampHUDPosition(next.position, next.size, layout) };
        }))
            .catch((cause) => frontendDiagnostics.failure('hud_element_update_failed', cause));
    };

    // Tracked write. Pass `null` to never coalesce (discrete toggles).
    const handleUpdateElement = (
        id: string,
        updates: Partial<HUDElement>,
        coalesceKey: string | null = `${id}:${Object.keys(updates).sort().join(',')}`,
    ) => {
        recordChange(coalesceKey);
        applyElementUpdate(id, updates);
    };

    const handlePropChange = (key: string, value: any) => {
        if (!selectedElement) return;
        handleUpdateElement(selectedElement.id, {
            props: { ...selectedElement.props, [key]: value }
        }, `${selectedElement.id}:props.${key}`);
    };

    const handleActionChange = (action: string | null) => {
        if (!selectedElement) return;
        const props = { ...selectedElement.props };
        if (action === null) delete props.action;
        else props.action = action;
        handleUpdateElement(selectedElement.id, { props }, null);
    };

    /** Binds or unbinds one prop; picks are one undo step each, a typed variable name coalesces. */
    const handleBindingChange = (prop: string, path: string | null, typing: boolean) => {
        if (!selectedElement) return;
        if (hudBindingPath(selectedElement.props.bind, prop) === path) return;
        handleUpdateElement(
            selectedElement.id,
            { props: withHUDBinding(selectedElement.props, prop, path) },
            typing ? `${selectedElement.id}:props.bind.${prop}` : null,
        );
    };

    const selectedDefinition = selectedElement
        ? AVAILABLE_COMPONENTS.find(component => component.type === selectedElement.type)
        : undefined;
    const selectedPropOptions = selectedDefinition?.propOptions;
    const selectedLocalizedKey = selectedElement ? LOCALIZED_KEY_PROPS[selectedElement.type] : undefined;

    const handleDelete = (id: string) => {
        recordChange();
        void commitElements(elements.filter(el => el.id !== id))
            .catch((cause) => frontendDiagnostics.failure('hud_element_delete_failed', cause));
        if (selectedId === id) setSelectedId(null);
    };

    const handleToggleVisibility = (id: string) => {
        const el = elements.find(e => e.id === id);
        if (el) handleUpdateElement(id, { isVisible: !el.isVisible }, null);
    };

    const handleToggleLock = (id: string) => {
        const el = elements.find(e => e.id === id);
        if (el) handleUpdateElement(id, { isLocked: !el.isLocked }, null);
    };

    const handleDragStart = () => {
        dragStartRef.current = loading ? null : document;
    };

    const handleDragEnd = (id: string) => {
        const before = dragStartRef.current;
        dragStartRef.current = null;
        if (!before) return;
        const start = before.elements.find(el => el.id === id);
        const end = elements.find(el => el.id === id);
        if (start && end && start.position.x === end.position.x && start.position.y === end.position.y) return;
        lastEditRef.current = null;
        history.record(before);
    };

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden">
            {error && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 rounded border border-red-800 bg-red-950/90 px-3 py-2 text-xs text-red-200 shadow-lg">
                    {error.message}
                </div>
            )}
            {loading && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-gray-950/70 text-xs text-gray-400">
                    Loading HUD…
                </div>
            )}
            {/* Left Sidebar: Library & Layers */}
            <HUDLibrary 
                elements={elements}
                onAdd={handleAddElement}
                onSelect={setSelectedId}
                selectedId={selectedId}
                onDelete={handleDelete}
                onToggleVisibility={handleToggleVisibility}
                onToggleLock={handleToggleLock}
            />

            {/* Center: Canvas */}
            <div className="flex-1 flex flex-col min-w-0 bg-[#111111]">
                <div className="h-8 bg-[#1a1a1a] border-b border-gray-800 flex items-center px-4 justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <div role="tablist" aria-label="HUD document" className="flex items-center gap-0.5 rounded bg-gray-950 p-0.5 border border-gray-800">
                            {HUD_DOCUMENTS.map(option => (
                                <button
                                    key={option.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={option.id === descriptor.id}
                                    onClick={() => handleSwitchDocument(option.id)}
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${option.id === descriptor.id ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800'}`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={history.undo}
                                disabled={loading || !history.canUndo}
                                title="Undo (Ctrl+Z)"
                                aria-label="Undo"
                                className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30 disabled:pointer-events-none"
                            >
                                <Undo2 size={12} />
                            </button>
                            <button
                                type="button"
                                onClick={history.redo}
                                disabled={loading || !history.canRedo}
                                title="Redo (Ctrl+Y)"
                                aria-label="Redo"
                                className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30 disabled:pointer-events-none"
                            >
                                <Redo2 size={12} />
                            </button>
                        </div>
                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Canvas: {Math.round(layout.width)} x {Math.round(layout.height)}</span>
                    </div>
                    <div className="text-[10px] text-gray-600">Zoom: {Math.round(canvasScale * 100)}%</div>
                </div>
                {missingMenuActions && (
                    <div role="status" className="flex items-center gap-2 px-4 py-1.5 bg-amber-950/60 border-b border-amber-900/60 text-[10px] text-amber-200 shrink-0">
                        <AlertTriangle size={12} className="shrink-0" />
                        The player keeps its built-in {descriptor.label.toLowerCase()} until a visible element here has
                        a {listActions(missingMenuActions)} action.
                    </div>
                )}
                <HUDCanvas
                    elements={elements}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onUpdate={applyElementUpdate}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    layout={layout}
                    onScaleChange={setCanvasScale}
                />
            </div>

            {/* Right Sidebar: AI & Properties */}
            <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20">
                <div className="flex border-b border-gray-800 bg-gray-950 shrink-0">
                    <button 
                        onClick={() => setRightPanelTab('props')}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${rightPanelTab === 'props' ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Settings2 size={12} /> Properties
                    </button>
                    <button 
                        onClick={() => setRightPanelTab('ai')}
                        disabled={!aiAvailable}
                        title={aiAvailable ? undefined : 'AI Coder edits the Game HUD only'}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${rightPanelTab === 'ai' && aiAvailable ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Code size={12} /> AI Coder
                    </button>
                </div>

                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    {rightPanelTab === 'ai' && aiAvailable ? (
                        <AIChatPanel 
                            key={descriptor.id}
                            elements={elements}
                            selectedElementId={selectedId}
                            onSelectElement={setSelectedId}
                            onRefresh={handleRefresh}
                            onUpdateElement={handleUpdateElement}
                            onAgentCreate={(type, overrides) => handleAddElement(type, { ...overrides, id: 'ai' })}
                        />
                    ) : (
                        <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                            {selectedElement ? (
                                <>
                                    {/* 1. Identity */}
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="p-1.5 bg-blue-600/20 rounded text-blue-400">
                                                <Sliders size={14} />
                                            </div>
                                            <input 
                                                value={selectedElement.name}
                                                onChange={(e) => handleUpdateElement(selectedElement.id, { name: e.target.value })}
                                                className="bg-transparent border-b border-transparent hover:border-gray-600 focus:border-blue-500 text-sm font-bold text-white w-full focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                    
                                    {/* 2. Transform */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                <Move size={10} /> Position
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableInput 
                                                label="X" 
                                                value={selectedElement.position.x} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { position: { ...selectedElement.position, x: Math.round(v) } })} 
                                                step={1} 
                                            />
                                            <ScrubbableInput 
                                                label="Y" 
                                                value={selectedElement.position.y} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { position: { ...selectedElement.position, y: Math.round(v) } })} 
                                                step={1} 
                                            />
                                        </div>

                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800 mt-2">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                <Scaling size={10} /> Dimensions
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableInput 
                                                label="W" 
                                                value={selectedElement.size.width} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { size: { ...selectedElement.size, width: Math.round(v) } })} 
                                                step={1} 
                                            />
                                            <ScrubbableInput 
                                                label="H" 
                                                value={selectedElement.size.height} 
                                                onChange={(v) => handleUpdateElement(selectedElement.id, { size: { ...selectedElement.size, height: Math.round(v) } })} 
                                                step={1} 
                                            />
                                        </div>
                                    </div>

                                    {/* 3. Component Props */}
                                    <div className="space-y-3 pt-2">
                                        <div className="flex items-center justify-between pb-1 border-b border-gray-800">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                                                {selectedElement.type === 'Text' ? <Type size={10} /> : <Palette size={10} />} 
                                                {selectedElement.type === 'Custom' ? 'Source Code' : 'Attributes'}
                                            </span>
                                        </div>
                                        
                                        <div className="grid grid-cols-1 gap-3">
                                            {attributeKeys(selectedElement).map((key) => {
                                                const hint = attributeHint(selectedElement, key, selectedLocalizedKey);
                                                const hintId = `hud-prop-hint-${selectedElement.id}-${key}`;
                                                return (
                                                    <div key={key} className="space-y-1">
                                                        <PropertyInput
                                                            label={key === 'code' ? 'React JSX Body' : key.replace(/([A-Z])/g, ' $1').trim()}
                                                            value={selectedElement.props[key]}
                                                            onChange={(val) => handlePropChange(key, val)}
                                                            isMultiline={key === 'code'}
                                                            // Own keys only: prop names come from project data and may match Object.prototype members.
                                                            options={selectedPropOptions && Object.prototype.hasOwnProperty.call(selectedPropOptions, key) ? selectedPropOptions[key] : undefined}
                                                            describedBy={hint ? hintId : undefined}
                                                        />
                                                        {hint && <p id={hintId} className="text-[10px] text-gray-500 leading-snug">{hint}</p>}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* 4. Live game-state bindings */}
                                    <div className="pt-2 border-t border-gray-800">
                                        <HUDBindingField
                                            key={selectedElement.id}
                                            value={selectedElement.props.bind}
                                            bindableProps={bindablePropsFor(selectedElement.props, selectedDefinition?.bindableProps)}
                                            onChange={handleBindingChange}
                                        />
                                    </div>

                                    {/* 5. Menu action */}
                                    <div className="pt-2 border-t border-gray-800">
                                        <HUDActionField
                                            value={selectedElement.props.action}
                                            levels={levels}
                                            onChange={handleActionChange}
                                        />
                                    </div>
                                </>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
                                    <Sliders size={32} className="opacity-20" />
                                    <p className="text-xs italic">Select an element to edit properties.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
