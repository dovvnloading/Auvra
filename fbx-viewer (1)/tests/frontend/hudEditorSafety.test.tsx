import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUDEditor, HUD_DOCUMENTS, type HUDDocument } from '../../components/HUDEditor/HUDEditor';
import type { HUDElement } from '../../components/HUDEditor/types';

type StoredDocument = { id: string; elements?: HUDElement[] };

const { documents, defaults, project } = vi.hoisted(() => ({
    documents: new Map<string, StoredDocument>(),
    defaults: new Map<string, StoredDocument>(),
    project: {
        // Like the native hook: after a write the revision rises and the document is reset to its
        // default while the stored copy loads again.
        rehydrateAfterWrite: false,
        rehydrating: new Map<string, StoredDocument>(),
        listeners: new Set<() => void>(),
    },
}));

vi.mock('../../context/LevelContext', () => ({ useLevel: () => ({ levels: [] }) }));

vi.mock('../../utils/useNativeProjectDocument', async () => {
    const { useEffect, useReducer } = await import('react');
    return {
        useNativeProjectDocument: <T extends { id: string }>(domain: string, documentId: string, createDefault: () => T) => {
            const [, rerender] = useReducer((count: number) => count + 1, 0);
            useEffect(() => {
                project.listeners.add(rerender);
                return () => { project.listeners.delete(rerender); };
            }, []);
            const key = `${domain}/${documentId}`;
            if (!defaults.has(key)) defaults.set(key, createDefault() as unknown as StoredDocument);
            const placeholder = project.rehydrating.get(key);
            return {
                document: (placeholder ?? documents.get(key) ?? defaults.get(key)) as unknown as T,
                hydrated: !placeholder,
                error: null,
                replace: async (next: T) => {
                    documents.set(key, next as unknown as StoredDocument);
                    if (project.rehydrateAfterWrite) project.rehydrating.set(key, createDefault() as unknown as StoredDocument);
                    rerender();
                },
                refresh: () => undefined,
            };
        },
    };
});

const stored = (documentId: string) => documents.get(`hud/${documentId}`);
const storedElement = (documentId: string, elementId: string) => stored(documentId)?.elements?.find(element => element.id === elementId);

const finishRehydrate = () => act(() => {
    project.rehydrating.clear();
    project.listeners.forEach(listener => listener());
});

const selectOnCanvas = (container: HTMLElement, elementId: string) => {
    const target = container.querySelector(`[data-hud-element="${elementId}"]`) as HTMLElement;
    fireEvent.pointerDown(target);
    fireEvent.pointerUp(target);
};

const textElement = (id: string, props: Record<string, unknown>): HUDElement => ({
    id, name: id, type: 'Text', props,
    position: { x: 100, y: 100 }, size: { width: 300, height: 60 },
    zIndex: 1, isVisible: true, isLocked: false,
});

/** A customised title menu: renamed title, no Quit button and an extra Version text. */
const customTitleMenu = (): HUDDocument => {
    const base = HUD_DOCUMENTS.find(descriptor => descriptor.id === 'menu-title')!.createDefault();
    return {
        ...base,
        elements: [
            ...base.elements
                .filter(element => element.id !== 'menu-title-quit')
                .map(element => (element.id === 'menu-title-title' ? { ...element, props: { ...element.props, text: 'MY GAME' } } : element)),
            textElement('menu-title-version', { text: 'v1.2', textKey: '', color: '#ffffff', fontSize: 16 }),
        ],
    };
};

beforeAll(() => {
    // jsdom has no layout; the AI panel scrolls its message list into view.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
    documents.clear();
    defaults.clear();
    project.rehydrateAfterWrite = false;
    project.rehydrating.clear();
});

describe('HUD editor writes while a document re-hydrates', () => {
    it('drops edits made while the default template stands in, so a menu is never reset', () => {
        documents.set('hud/menu-title', customTitleMenu());
        const { container } = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));
        selectOnCanvas(container, 'menu-title-play');
        project.rehydrateAfterWrite = true;

        fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Start' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props.label).toBe('Start');
        // The hook now holds the default title menu, whose ids match the stored one.
        expect(screen.getByText('Loading HUD…')).toBeInTheDocument();
        expect(screen.getByLabelText('label')).toHaveValue('Play');

        fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Start!' } });
        fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Start!!' } });
        const afterTyping = stored('menu-title');
        expect(afterTyping?.elements?.map(element => element.id)).toContain('menu-title-version');
        expect(afterTyping?.elements?.map(element => element.id)).not.toContain('menu-title-quit');
        expect(storedElement('menu-title', 'menu-title-title')?.props.text).toBe('MY GAME');
        expect(storedElement('menu-title', 'menu-title-play')?.props.label).toBe('Start');

        project.rehydrateAfterWrite = false;
        finishRehydrate();
        expect(screen.queryByText('Loading HUD…')).toBeNull();
        expect(screen.getByLabelText('label')).toHaveValue('Start');

        fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Begin' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props.label).toBe('Begin');
        expect(storedElement('menu-title', 'menu-title-version')).toBeDefined();

        // The only undo step is the customised menu, never the default template.
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(storedElement('menu-title', 'menu-title-play')?.props.label).toBe('Play');
        expect(storedElement('menu-title', 'menu-title-version')).toBeDefined();
        expect(storedElement('menu-title', 'menu-title-quit')).toBeUndefined();
    });

    it('drops canvas drag moves that arrive during the re-hydrate', () => {
        documents.set('hud/menu-title', customTitleMenu());
        const { container } = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));
        project.rehydrateAfterWrite = true;

        const play = container.querySelector('[data-hud-element="menu-title-play"]') as HTMLElement;
        const canvas = play.closest('.select-none') as HTMLElement;
        fireEvent.pointerDown(play, { clientX: 760, clientY: 460, pointerId: 1 });
        fireEvent.pointerMove(canvas, { clientX: 800, clientY: 500, pointerId: 1 });
        const firstMove = storedElement('menu-title', 'menu-title-play')?.position;
        expect(firstMove).toBeDefined();

        fireEvent.pointerMove(canvas, { clientX: 900, clientY: 600, pointerId: 1 });
        fireEvent.pointerUp(canvas, { clientX: 900, clientY: 600, pointerId: 1 });
        expect(storedElement('menu-title', 'menu-title-play')?.position).toEqual(firstMove);
        expect(storedElement('menu-title', 'menu-title-version')).toBeDefined();
        expect(storedElement('menu-title', 'menu-title-quit')).toBeUndefined();
        expect(storedElement('menu-title', 'menu-title-title')?.props.text).toBe('MY GAME');
    });
});

describe('HUD editor AI Coder', () => {
    it('is offered on the game HUD only and falls back to Properties on a menu', () => {
        render(<HUDEditor />);
        const aiTab = () => screen.getByRole('button', { name: /AI Coder/ });
        expect(aiTab()).toBeEnabled();
        fireEvent.click(aiTab());
        expect(screen.getByText(/Describe a HUD change/)).toBeInTheDocument();
        expect(screen.queryByText('Select an element to edit properties.')).toBeNull();

        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));
        expect(aiTab()).toBeDisabled();
        expect(aiTab()).toHaveAttribute('title', 'AI Coder edits the Game HUD only');
        expect(screen.queryByText(/Describe a HUD change/)).toBeNull();
        expect(screen.getByText('Select an element to edit properties.')).toBeInTheDocument();
        fireEvent.click(aiTab());
        expect(screen.getByText('Select an element to edit properties.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('tab', { name: 'Game HUD' }));
        expect(aiTab()).toBeEnabled();
        expect(screen.getByText('Select an element to edit properties.')).toBeInTheDocument();
    });
});

describe('HUD editor attributes from project data', () => {
    it('edits props named like Object.prototype members as plain fields', () => {
        documents.set('hud/hud-main', {
            id: 'hud-main',
            elements: [textElement('odd', { text: 'Hi', textAlign: 'left', toString: 'x', constructor: 'y' })],
        });
        const { container } = render(<HUDEditor />);
        selectOnCanvas(container, 'odd');

        expect(screen.getByLabelText('to String')).toHaveValue('x');
        expect(screen.getByLabelText('constructor')).toHaveValue('y');
        expect(screen.getByLabelText('text Align').tagName).toBe('SELECT');

        fireEvent.change(screen.getByLabelText('to String'), { target: { value: 'z' } });
        expect(storedElement('hud-main', 'odd')?.props.toString).toBe('z');
    });
});

describe('HUD editor binding hints with a string key', () => {
    it('says the live value of a bound text wins over its string key while playing', () => {
        documents.set('hud/hud-main', {
            id: 'hud-main',
            elements: [textElement('score', { text: '0', textKey: 'hud.score', color: '#ffffff', bind: { text: 'vars.score' } })],
        });
        const { container } = render(<HUDEditor />);
        selectOnCanvas(container, 'score');

        expect(screen.getByLabelText('text')).toHaveAccessibleDescription('Bound to vars.score; shows the live value while playing.');
        expect(screen.getByLabelText('text Key')).toHaveAccessibleDescription(
            'String key from Localization; overrides the text unless it is bound. While playing, the live value of vars.score is shown instead.',
        );

        fireEvent.change(screen.getByLabelText('text Key'), { target: { value: '' } });
        expect(screen.getByLabelText('text')).toHaveAccessibleDescription('Bound to vars.score; shows the live value while playing.');
        expect(screen.getByLabelText('text Key')).toHaveAccessibleDescription('String key from Localization; overrides the text unless it is bound.');
    });
});
