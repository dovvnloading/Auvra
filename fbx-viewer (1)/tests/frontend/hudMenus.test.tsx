import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUDEditor, HUD_DOCUMENTS } from '../../components/HUDEditor/HUDEditor';
import { HUDRenderer } from '../../components/HUDEditor/HUDRenderer';
import { AVAILABLE_COMPONENTS } from '../../components/HUDEditor/componentRegistry';
import { findMenuDocument, parseMenuAction } from '../../player/menus';
import type { HUDElement } from '../../components/HUDEditor/types';

type StoredDocument = { id: string; elements: HUDElement[] };

const { documents, defaults, scene } = vi.hoisted(() => ({
    documents: new Map<string, StoredDocument>(),
    defaults: new Map<string, StoredDocument>(),
    scene: { levels: [{ id: 'level-1', name: 'Docks', createdAt: 0 }, { id: 'level-2', name: 'Harbor', createdAt: 0 }] },
}));

vi.mock('../../context/LevelContext', () => ({ useLevel: () => scene }));

// An in-memory 'hud' domain: each document id is stored separately, like the native project.
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

const stored = (id: string) => documents.get(`hud/${id}`);
const storedElement = (documentId: string, elementId: string) => stored(documentId)?.elements.find(element => element.id === elementId);

const selectOnCanvas = (container: HTMLElement, elementId: string) => {
    const target = container.querySelector(`[data-hud-element="${elementId}"]`) as HTMLElement;
    fireEvent.pointerDown(target);
    fireEvent.pointerUp(target);
};

beforeEach(() => {
    documents.clear();
    defaults.clear();
});

describe('HUD editor menu documents', () => {
    it('keeps separate elements and undo history per document when switching', () => {
        const { container } = render(<HUDEditor />);
        expect(screen.getByRole('tab', { name: 'Game HUD' })).toHaveAttribute('aria-selected', 'true');

        fireEvent.click(screen.getByRole('button', { name: 'Text Block' }));
        expect(stored('hud-main')?.elements).toHaveLength(1);
        expect(screen.getByText('HUD ELEMENT')).toBeInTheDocument();
        // Any element can carry an action; a fresh Text has none.
        expect(screen.getByLabelText('Action')).toHaveValue('');

        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));
        expect(screen.getByRole('tab', { name: 'Title menu' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.queryByText('HUD ELEMENT')).toBeNull();
        // A new menu starts from the default layout, with no history from the other document.
        for (const action of ['play', 'continue', 'options', 'quit']) {
            expect(container.querySelector(`[data-hud-element="menu-title-${action}"]`)).not.toBeNull();
        }
        expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Button' }));
        expect(stored('menu-title')?.elements).toHaveLength(6);
        expect(stored('hud-main')?.elements).toHaveLength(1);

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(stored('menu-title')?.elements).toHaveLength(5);
        expect(stored('hud-main')?.elements).toHaveLength(1);

        fireEvent.click(screen.getByRole('tab', { name: 'Game HUD' }));
        expect(screen.getByText('HUD ELEMENT')).toBeInTheDocument();
        expect(container.querySelector('[data-hud-element="menu-title-play"]')).toBeNull();
        expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

        fireEvent.click(screen.getByRole('tab', { name: 'Pause menu' }));
        for (const action of ['resume', 'save', 'load', 'options', 'quit']) {
            expect(container.querySelector(`[data-hud-element="menu-pause-${action}"]`)).not.toBeNull();
        }
        expect(stored('menu-pause')).toBeUndefined();
    });

    it('writes the chosen action, including an open-level target, to props.action', () => {
        const { container } = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('tab', { name: 'Title menu' }));
        selectOnCanvas(container, 'menu-title-play');

        const action = screen.getByLabelText('Action');
        expect(action).toHaveValue('play');

        fireEvent.change(action, { target: { value: 'quit' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props.action).toBe('quit');

        fireEvent.change(action, { target: { value: 'openLevel' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props.action).toBe('openLevel:level-1');
        const level = screen.getByLabelText('Level');
        expect(level).toHaveValue('level-1');
        expect(screen.getByRole('option', { name: 'Harbor' })).toBeInTheDocument();

        fireEvent.change(level, { target: { value: 'level-2' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props.action).toBe('openLevel:level-2');
        expect(parseMenuAction(storedElement('menu-title', 'menu-title-play')?.props.action)).toEqual({ kind: 'openLevel', levelId: 'level-2' });

        fireEvent.change(action, { target: { value: '' } });
        expect(storedElement('menu-title', 'menu-title-play')?.props).not.toHaveProperty('action');
        expect(screen.queryByLabelText('Level')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(storedElement('menu-title', 'menu-title-play')?.props.action).toBe('openLevel:level-2');
    });

    it('warns while a menu offers none of the actions the player requires', () => {
        const { container } = render(<HUDEditor />);
        fireEvent.click(screen.getByRole('tab', { name: 'Pause menu' }));
        expect(screen.queryByRole('status')).toBeNull();

        selectOnCanvas(container, 'menu-pause-resume');
        fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'save' } });
        expect(screen.getByRole('status')).toHaveTextContent('Resume');
    });
});

describe('HUD Button component', () => {
    it('is offered in the library with label, action and variant props', () => {
        const definition = AVAILABLE_COMPONENTS.find(component => component.type === 'Button');
        expect(definition?.defaultProps).toMatchObject({ label: 'Button', action: '', variant: 'primary' });
        expect(definition?.propOptions?.variant).toContain('outline');
    });

    it('renders its label as a styled button face', () => {
        const { container } = render(
            <HUDRenderer
                document={{
                    id: 'menu',
                    elements: [{
                        id: 'start', name: 'Start', type: 'Button',
                        props: { label: 'Start Game', action: 'play', variant: 'outline', fontSize: 30 },
                        position: { x: 10, y: 10 }, size: { width: 300, height: 60 },
                        zIndex: 1, isVisible: true, isLocked: false,
                    }],
                }}
            />,
        );
        expect(screen.getByText('Start Game')).toBeInTheDocument();
        const face = container.querySelector('[data-hud-button]') as HTMLElement;
        expect(face).toHaveAttribute('data-hud-button', 'outline');
        expect(face.style.fontSize).toBe('30px');
    });

    it('ships default menus the player accepts', () => {
        for (const descriptor of HUD_DOCUMENTS) {
            const document = descriptor.createDefault();
            expect(document.id).toBe(descriptor.id);
            if (descriptor.requiredActions) {
                expect(findMenuDocument([document], descriptor.id, descriptor.requiredActions)).not.toBeNull();
                for (const element of document.elements.filter(candidate => candidate.type === 'Button')) {
                    expect(parseMenuAction(element.props.action)).not.toBeNull();
                }
            }
        }
    });
});
