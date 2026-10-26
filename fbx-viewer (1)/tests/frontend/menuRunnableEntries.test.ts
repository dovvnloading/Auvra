import { describe, expect, it } from 'vitest';
import {
    findMenuDocument,
    menuActionRunnable,
    PAUSE_MENU_DOCUMENT_ID,
    PAUSE_MENU_REQUIRED_ACTIONS,
    TITLE_MENU_DOCUMENT_ID,
    TITLE_MENU_REQUIRED_ACTIONS,
} from '../../player/menus';

const button = (id: string, action: string) => ({
    id, type: 'Button', name: id, position: { x: 0, y: 0 }, size: { width: 200, height: 40 }, props: { label: id, action },
});

const titleMenu = (...buttons: ReturnType<typeof button>[]) => [{ id: TITLE_MENU_DOCUMENT_ID, elements: buttons }];

const noop = () => undefined;

describe('authored menus only replace the built-in menu when an entry can run', () => {
    it('without canRun keeps the static check', () => {
        expect(findMenuDocument(titleMenu(button('continue', 'continue')), TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS)).not.toBeNull();
    });

    it('falls back when the only entry is Continue and no save exists yet', () => {
        // 'start' is a typo the parser rejects, so it renders as decoration.
        const documents = titleMenu(button('continue', 'continue'), button('new-game', 'start'));
        const firstLaunch = menuActionRunnable({ play: noop, openLevel: noop });
        expect(findMenuDocument(documents, TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS, firstLaunch)).toBeNull();
        const withSave = menuActionRunnable({ play: noop, continue: noop, openLevel: noop });
        expect(findMenuDocument(documents, TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS, withSave)).not.toBeNull();
    });

    it('falls back when the only entry opens a level left out of the build', () => {
        const documents = titleMenu(button('intro', 'openLevel:lvl-intro'));
        const handlers = { play: noop, openLevel: noop };
        expect(findMenuDocument(documents, TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS, menuActionRunnable(handlers, new Set(['lvl-other'])))).toBeNull();
        expect(findMenuDocument(documents, TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS, menuActionRunnable(handlers, new Set(['lvl-intro'])))).not.toBeNull();
    });

    it('keeps a pause menu whose Resume can run', () => {
        const documents = [{ id: PAUSE_MENU_DOCUMENT_ID, elements: [button('resume', 'resume')] }];
        expect(findMenuDocument(documents, PAUSE_MENU_DOCUMENT_ID, PAUSE_MENU_REQUIRED_ACTIONS, menuActionRunnable({ resume: noop }))).not.toBeNull();
        expect(findMenuDocument(documents, PAUSE_MENU_DOCUMENT_ID, PAUSE_MENU_REQUIRED_ACTIONS, menuActionRunnable({}))).toBeNull();
    });
});
