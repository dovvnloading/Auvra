import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalizationPanel } from '../../components/Settings/LocalizationPanel';
import {
    createDefaultLocalizationDocument,
    localization,
    LOCALIZATION_DOCUMENT_ID,
    type LocalizationDocument,
    type LocalizationSettings,
} from '../../runtime/localization';

const { project, scene } = vi.hoisted(() => {
    const project = {
        document: null as unknown,
        hydrated: true,
        writes: [] as unknown[],
        /** Settles the write in flight, like the host answering after the UI has rendered. */
        settle: null as null | { resolve: () => void; reject: (cause: Error) => void },
        listeners: new Set<() => void>(),
        set(document: unknown, hydrated = true) {
            project.document = document;
            project.hydrated = hydrated;
            project.listeners.forEach(listener => listener());
        },
    };
    return { project, scene: { projectStatus: { projectId: 'project-1' as string | null, readOnly: false } } };
});

vi.mock('../../context/SceneContext', () => ({ useScene: () => scene }));

// Like the native hook: replace() updates the document optimistically and rolls it back when the write fails.
vi.mock('../../utils/useNativeProjectDocument', async () => {
    const { useEffect, useReducer } = await import('react');
    return {
        useNativeProjectDocument: <T extends { id: string }>(_domain: string, _documentId: string, createDefault: () => T) => {
            const [, rerender] = useReducer((count: number) => count + 1, 0);
            useEffect(() => {
                project.listeners.add(rerender);
                return () => { project.listeners.delete(rerender); };
            }, []);
            if (!project.document) project.document = createDefault();
            return {
                document: project.document as T,
                hydrated: project.hydrated,
                error: null,
                replace: async (next: T) => {
                    const previous = project.document;
                    project.set(next);
                    try {
                        await new Promise<void>((resolve, reject) => { project.settle = { resolve, reject }; });
                    } catch (cause) {
                        project.set(previous);
                        throw cause;
                    } finally {
                        project.settle = null;
                    }
                    project.writes.push(next);
                },
                refresh: () => undefined,
            };
        },
    };
});

const documentWith = (settings: LocalizationSettings): LocalizationDocument => ({ id: LOCALIZATION_DOCUMENT_ID, settings });

const twoLocales = () => documentWith({ defaultLocale: 'en', locales: { en: { 'menu.play': 'Play' }, fr: { 'menu.play': '' } } });

const cell = (key: string, locale: string) => screen.getByLabelText(`${key} in ${locale}`);

const type = (key: string, locale: string, text: string) => fireEvent.change(cell(key, locale), { target: { value: text } });

/** Clicks Save and lets the optimistic write render before the host answers. */
const save = async (outcome: 'ok' | Error = 'ok') => {
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Save/ })); });
    expect(project.settle).not.toBeNull();
    await act(async () => {
        if (outcome === 'ok') project.settle?.resolve();
        else project.settle?.reject(outcome);
    });
};

beforeEach(() => {
    project.document = null;
    project.hydrated = true;
    project.settle = null;
    project.writes = [];
    scene.projectStatus = { projectId: 'project-1', readOnly: false };
});

afterEach(() => {
    localization.reset();
});

describe('Localization panel draft', () => {
    it('keeps typed translations when a save fails, so it can be retried', async () => {
        project.document = twoLocales();
        render(<LocalizationPanel onClose={() => undefined} />);
        type('menu.play', 'fr', 'Jouer');

        await save(new Error('Revision conflict'));
        expect(screen.getByText('Revision conflict')).toBeInTheDocument();
        expect(cell('menu.play', 'fr')).toHaveValue('Jouer');

        await save();
        expect(project.writes).toHaveLength(1);
        expect((project.writes[0] as LocalizationDocument).settings.locales.fr['menu.play']).toBe('Jouer');
        expect(screen.getByText('Localization saved to the project.')).toBeInTheDocument();
    });

    it('keeps an edited draft while another write re-hydrates the document', () => {
        project.document = twoLocales();
        render(<LocalizationPanel onClose={() => undefined} />);
        type('menu.play', 'fr', 'Jouer');

        // A revision bump resets the hook to the default document, then loads the stored copy again.
        act(() => project.set(createDefaultLocalizationDocument(), false));
        act(() => project.set(twoLocales()));
        expect(cell('menu.play', 'fr')).toHaveValue('Jouer');
        expect(screen.getByRole('button', { name: /Revert/ })).toBeEnabled();
    });

    it('follows the stored document while unedited, and a project switch discards edits', () => {
        project.document = twoLocales();
        const view = render(<LocalizationPanel onClose={() => undefined} />);

        act(() => project.set(createDefaultLocalizationDocument(), false));
        act(() => project.set(documentWith({ defaultLocale: 'en', locales: { en: { 'menu.play': 'Play' }, fr: { 'menu.play': 'Salut' } } })));
        expect(cell('menu.play', 'fr')).toHaveValue('Salut');

        type('menu.play', 'fr', 'Jouer');
        scene.projectStatus = { projectId: 'project-2', readOnly: false };
        view.rerender(<LocalizationPanel onClose={() => undefined} />);
        expect(cell('menu.play', 'fr')).toHaveValue('Salut');

        // After a revert the draft is unedited again and keeps following the store.
        type('menu.play', 'fr', 'Jouer');
        fireEvent.click(screen.getByRole('button', { name: /Revert/ }));
        act(() => project.set(documentWith({ defaultLocale: 'en', locales: { en: { 'menu.play': 'Play' }, fr: { 'menu.play': 'Bonjour' } } })));
        expect(cell('menu.play', 'fr')).toHaveValue('Bonjour');
    });

    it('keeps the saved draft through the re-hydrate that follows a successful save', async () => {
        project.document = twoLocales();
        render(<LocalizationPanel onClose={() => undefined} />);
        type('menu.play', 'fr', 'Jouer');
        await save();

        const saved = project.document;
        act(() => project.set(createDefaultLocalizationDocument(), false));
        act(() => project.set(saved));
        expect(cell('menu.play', 'fr')).toHaveValue('Jouer');
        expect(screen.getByRole('button', { name: /Revert/ })).toBeDisabled();
    });
});

describe('Localization panel string keys', () => {
    it('treats keys named like Object.prototype members as plain keys', () => {
        project.document = documentWith({
            defaultLocale: 'en',
            locales: { en: { toString: 'Text', 'menu.play': 'Play' }, fr: { 'menu.play': 'Jouer' } },
        });
        render(<LocalizationPanel onClose={() => undefined} />);
        expect(cell('toString', 'fr')).toHaveValue('');
        expect(screen.getByText(/1 untranslated/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Filter strings'), { target: { value: 'pl' } });
        expect(cell('menu.play', 'fr')).toHaveValue('Jouer');
        expect(screen.queryByLabelText('toString in fr')).toBeNull();

        fireEvent.change(screen.getByLabelText('Filter strings'), { target: { value: 'text' } });
        expect(cell('toString', 'en')).toHaveValue('Text');
    });
});
