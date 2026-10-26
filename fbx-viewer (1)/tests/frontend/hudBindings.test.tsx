import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUDEditor } from '../../components/HUDEditor/HUDEditor';
import { HUDRenderer } from '../../components/HUDEditor/HUDRenderer';
import type { HUDElement } from '../../components/HUDEditor/types';
import { gameState } from '../../runtime/gameState';
import { localization, LOCALIZATION_DOCUMENT_ID } from '../../runtime/localization';

type StoredDocument = { id: string; elements?: HUDElement[]; settings?: unknown };

const { documents, defaults } = vi.hoisted(() => ({
    documents: new Map<string, StoredDocument>(),
    defaults: new Map<string, StoredDocument>(),
}));

vi.mock('../../context/LevelContext', () => ({ useLevel: () => ({ levels: [] }) }));

// An in-memory project: each domain/document id is stored separately, like the native project.
vi.mock('../../utils/useNativeProjectDocument', async () => {
    const { useReducer } = await import('react');
    return {
        useNativeProjectDocument: <T extends { id: string }>(domain: string, documentId: string, createDefault: () => T) => {
            const [, rerender] = useReducer((count: number) => count + 1, 0);
            const key = `${domain}/${documentId}`;
            if (!defaults.has(key)) defaults.set(key, createDefault() as unknown as StoredDocument);
            return {
                document: (documents.get(key) ?? defaults.get(key)) as unknown as T,
                hydrated: true,
                error: null,
                replace: async (next: T) => {
                    documents.set(key, next as unknown as StoredDocument);
                    rerender();
                },
                refresh: () => undefined,
            };
        },
    };
});

const storedElements = (documentId: string): HUDElement[] => documents.get(`hud/${documentId}`)?.elements ?? [];
const storedProps = (documentId = 'hud-main', index = 0) => storedElements(documentId)[index]?.props;

const selectOnCanvas = (container: HTMLElement, elementId: string) => {
    const target = container.querySelector(`[data-hud-element="${elementId}"]`) as HTMLElement;
    fireEvent.pointerDown(target);
    fireEvent.pointerUp(target);
};

const pickSource = (value: string) => fireEvent.change(screen.getByLabelText('Source'), { target: { value } });

beforeEach(() => {
    documents.clear();
    defaults.clear();
});

afterEach(() => {
    localization.reset();
    act(() => gameState.reset());
});

describe('HUD element bindings', () => {
    it('writes and removes the bind entry, one undo step per change', () => {
        render(<HUDEditor />);
        fireEvent.click(screen.getByRole('button', { name: 'Text Block' }));
        expect(storedProps()).not.toHaveProperty('bind');
        expect(screen.getByLabelText('Prop')).toHaveValue('text');
        expect(screen.getByLabelText('Source')).toHaveValue('');
        // Every known game-state path is offered.
        for (const path of ['player.health', 'player.maxHealth', 'player.stamina', 'player.isAiming', 'level.id']) {
            expect(screen.getByLabelText('Source').querySelector(`option[value="${path}"]`)).not.toBeNull();
        }

        pickSource('player.health');
        expect(storedProps()?.bind).toEqual({ text: 'player.health' });
        expect(screen.getByText('Bound to player.health; shows the live value while playing.')).toBeInTheDocument();
        // The binding map is edited here, never as a raw attribute.
        expect(screen.queryByLabelText('bind')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(storedProps()).not.toHaveProperty('bind');
        expect(screen.getByLabelText('Source')).toHaveValue('');
        fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
        expect(storedProps()?.bind).toEqual({ text: 'player.health' });

        // A level variable is typed; picking the option alone writes nothing until a name exists.
        pickSource('__variable__');
        expect(storedProps()).not.toHaveProperty('bind');
        const name = screen.getByLabelText('Variable name');
        fireEvent.change(name, { target: { value: 'sc' } });
        fireEvent.change(name, { target: { value: 'score ' } });
        expect(storedProps()?.bind).toEqual({ text: 'vars.score' });
        expect(screen.getByLabelText('Variable name')).toHaveValue('score ');

        // The typed name is one undo step.
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(storedProps()).not.toHaveProperty('bind');
        expect(screen.getByLabelText('Variable name')).toHaveValue('');
        fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
        expect(storedProps()?.bind).toEqual({ text: 'vars.score' });

        fireEvent.click(screen.getByRole('button', { name: 'Clear binding' }));
        expect(storedProps()).not.toHaveProperty('bind');
        expect(storedProps()?.text).toBe('HUD ELEMENT');
        expect(screen.queryByLabelText('Variable name')).toBeNull();
    });

    it('keeps several bound props on one element and removes only the cleared one', () => {
        render(<HUDEditor />);
        fireEvent.click(screen.getByRole('button', { name: 'Health Widget' }));
        expect(screen.getByLabelText('Prop')).toHaveValue('value');

        pickSource('player.health');
        fireEvent.change(screen.getByLabelText('Prop'), { target: { value: 'max' } });
        expect(screen.getByLabelText('Source')).toHaveValue('');
        pickSource('player.maxHealth');
        expect(storedProps()?.bind).toEqual({ value: 'player.health', max: 'player.maxHealth' });

        fireEvent.change(screen.getByLabelText('Prop'), { target: { value: 'value' } });
        expect(screen.getByLabelText('Source')).toHaveValue('player.health');
        pickSource('');
        expect(storedProps()?.bind).toEqual({ max: 'player.maxHealth' });
    });

    it('renders a bound Text with the live value when live values are on', () => {
        const editor = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('button', { name: 'Text Block' }));
        pickSource('__variable__');
        fireEvent.change(screen.getByLabelText('Variable name'), { target: { value: 'score' } });
        const elements = storedElements('hud-main');
        const id = elements[0].id;
        editor.unmount();

        act(() => gameState.update({ vars: { score: 42 } }));
        const { container, rerender } = render(<HUDRenderer document={{ id: 'hud-main', elements }} bindings />);
        const text = () => container.querySelector(`[data-hud-element="${id}"]`) as HTMLElement;
        expect(text()).toHaveTextContent('42');

        act(() => gameState.update({ vars: { score: 43 } }));
        expect(text()).toHaveTextContent('43');

        rerender(<HUDRenderer document={{ id: 'hud-main', elements }} />);
        expect(text()).toHaveTextContent('HUD ELEMENT');
    });
});

describe('HUD editor localization preview', () => {
    it('loads the project string tables and shows the key props with a hint', () => {
        documents.set(`metadata/${LOCALIZATION_DOCUMENT_ID}`, {
            id: LOCALIZATION_DOCUMENT_ID,
            settings: { defaultLocale: 'en', locales: { en: { 'menu.title': 'Welcome back', 'menu.play': 'Start' } } },
        });
        const { container } = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));

        // The default title has no textKey yet; the field is offered anyway.
        selectOnCanvas(container, 'menu-title-title');
        const textKey = screen.getByLabelText('text Key');
        expect(textKey).toHaveValue('');
        expect(textKey).toHaveAccessibleDescription('String key from Localization; overrides the text unless it is bound.');

        fireEvent.change(textKey, { target: { value: 'menu.title' } });
        expect(storedElements('menu-title').find(element => element.id === 'menu-title-title')?.props.textKey).toBe('menu.title');
        // Resolved from the loaded table, not shown as the raw key.
        expect(screen.getByText('Welcome back')).toBeInTheDocument();
        expect(screen.queryByText('menu.title')).toBeNull();

        selectOnCanvas(container, 'menu-title-play');
        const labelKey = screen.getByLabelText('label Key');
        expect(labelKey).toHaveAccessibleDescription('String key from Localization; overrides the label unless it is bound.');
        fireEvent.change(labelKey, { target: { value: 'menu.play' } });
        expect(container.querySelector('[data-hud-element="menu-title-play"]')).toHaveTextContent('Start');
    });
});
