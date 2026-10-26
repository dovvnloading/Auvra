import React, { useCallback } from 'react';
import { HUDRenderer, toHUDElements } from '../components/HUDEditor/HUDRenderer';
import { COMPONENT_REGISTRY } from '../components/HUDEditor/componentRegistry';
import type { HUDElement } from '../components/HUDEditor/types';
import type { HUDDocumentData } from '../runtime/types';

/** Authored menu screens are HUD documents in the project 'hud' domain, beside 'hud-main'. */
export const TITLE_MENU_DOCUMENT_ID = 'menu-title';
export const PAUSE_MENU_DOCUMENT_ID = 'menu-pause';

const SIMPLE_ACTIONS = ['play', 'continue', 'options', 'quit', 'resume', 'save', 'load'] as const;
const OPEN_LEVEL_PREFIX = 'openLevel:';

type SimpleMenuAction = typeof SIMPLE_ACTIONS[number];
export type MenuActionKind = SimpleMenuAction | 'openLevel';
export type MenuAction = { kind: SimpleMenuAction } | { kind: 'openLevel'; levelId: string };

/** Handlers a menu screen offers; a missing handler shows its buttons disabled. */
export type MenuActionHandlers = Partial<Record<SimpleMenuAction, () => void>> & {
    openLevel?: (levelId: string) => void;
};

/** A title menu must let the player into the game; a pause menu must let them back out of it. */
export const TITLE_MENU_REQUIRED_ACTIONS: readonly MenuActionKind[] = ['play', 'continue', 'load', 'openLevel'];
export const PAUSE_MENU_REQUIRED_ACTIONS: readonly MenuActionKind[] = ['resume'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses an element's `props.action`: 'play' | 'continue' | 'options' | 'quit' | 'resume' | 'save' | 'load' | 'openLevel:<id>'. */
export function parseMenuAction(value: unknown): MenuAction | null {
    if (typeof value !== 'string') return null;
    const action = value.trim();
    if ((SIMPLE_ACTIONS as readonly string[]).includes(action)) return { kind: action as SimpleMenuAction };
    if (action.startsWith(OPEN_LEVEL_PREFIX)) {
        const levelId = action.slice(OPEN_LEVEL_PREFIX.length).trim();
        return levelId ? { kind: 'openLevel', levelId } : null;
    }
    return null;
}

/** The callback an action runs on this screen, or null when the screen cannot run it right now. */
export function resolveMenuAction(
    action: MenuAction,
    handlers: MenuActionHandlers,
    availableLevels?: { has(levelId: string): boolean },
): (() => void) | null {
    if (action.kind === 'openLevel') {
        const open = handlers.openLevel;
        if (!open || (availableLevels && !availableLevels.has(action.levelId))) return null;
        return () => open(action.levelId);
    }
    return handlers[action.kind] ?? null;
}

/** canRun for findMenuDocument: an action counts only when this screen can run it right now (see resolveMenuAction). */
export const menuActionRunnable = (handlers: MenuActionHandlers, availableLevels?: { has(levelId: string): boolean }) =>
    (action: MenuAction): boolean => resolveMenuAction(action, handlers, availableLevels) !== null;

/**
 * Finds an authored menu among the 'hud' domain documents. It is used only when it is
 * well formed and a visible element offers one of `required`, so a missing or
 * half-authored menu can never trap the player; otherwise the built-in menu shows.
 * Pass `canRun` (menuActionRunnable) so an entry that would render disabled right now, such as
 * Continue before any save exists or an openLevel to a level left out of the build, does not count.
 */
export function findMenuDocument(
    documents: readonly unknown[] | null | undefined,
    id: string,
    required: readonly MenuActionKind[],
    canRun?: (action: MenuAction) => boolean,
): HUDDocumentData | null {
    if (!Array.isArray(documents)) return null;
    const candidate = documents.find(document => isRecord(document) && document.id === id);
    if (!isRecord(candidate) || !Array.isArray(candidate.elements)) return null;
    const offersRequired = toHUDElements(candidate.elements).some(element => {
        if (!element.isVisible || !COMPONENT_REGISTRY[element.type]) return false;
        const action = parseMenuAction(element.props.action);
        return action !== null && required.includes(action.kind) && (canRun?.(action) ?? true);
    });
    return offersRequired ? (candidate as unknown as HUDDocumentData) : null;
}

const elementLabel = (element: HUDElement): string => {
    for (const value of [element.props.label, element.props.text, element.name]) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return element.id;
};

interface AuthoredMenuProps {
    document: HUDDocumentData;
    handlers: MenuActionHandlers;
    /** When given, 'openLevel:<id>' buttons for levels outside this build are disabled. */
    availableLevels?: { has(levelId: string): boolean };
}

/**
 * Renders an authored menu document full screen. Elements whose `props.action` is a
 * menu action become buttons (mouse and keyboard); everything else is decoration.
 */
export const AuthoredMenu: React.FC<AuthoredMenuProps> = ({ document, handlers, availableLevels }) => {
    const renderElement = useCallback((element: HUDElement, position: HUDElement['position'], content: React.ReactNode) => {
        const style: React.CSSProperties = {
            position: 'absolute',
            left: position.x,
            top: position.y,
            width: element.size.width,
            height: element.size.height,
            zIndex: element.zIndex,
        };
        const action = parseMenuAction(element.props.action);
        if (!action) {
            return (
                <div data-hud-element={element.id} style={{ ...style, pointerEvents: 'none' }}>
                    <div className="w-full h-full overflow-hidden">{content}</div>
                </div>
            );
        }
        const run = resolveMenuAction(action, handlers, availableLevels);
        // A div rather than a <button>: custom HUD components may render their own controls.
        return (
            <div
                role="button"
                tabIndex={run ? 0 : -1}
                aria-disabled={!run}
                aria-label={elementLabel(element)}
                data-hud-element={element.id}
                data-menu-action={String(element.props.action).trim()}
                className={`rounded outline-none focus-visible:ring-4 focus-visible:ring-white/80 transition-[filter,opacity] ${run ? 'cursor-pointer hover:brightness-125' : 'cursor-default opacity-40'}`}
                style={style}
                onClick={run ?? undefined}
                onKeyDown={run ? event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    run();
                } : undefined}
            >
                <div className="w-full h-full overflow-hidden pointer-events-none">{content}</div>
            </div>
        );
    }, [handlers, availableLevels]);

    return (
        <div className="absolute inset-0 z-50" data-menu={document.id}>
            <HUDRenderer document={document} bindings renderElement={renderElement} />
        </div>
    );
};
