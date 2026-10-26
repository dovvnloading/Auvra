import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSettingsPanel } from '../../components/Settings/GameSettingsPanel';
import {
    DEFAULT_GAME_SETTINGS,
    GAME_SETTINGS_DOCUMENT_ID,
    normalizeGameSettings,
    type GameSettings,
} from '../../runtime/types';

interface GameSettingsDocument { id: string; settings: GameSettings; }

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
    return {
        project,
        scene: { levels: [] as unknown[], blueprints: [] as unknown[], projectStatus: { projectId: 'project-1' as string | null, readOnly: false } },
    };
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

const documentWith = (patch: Partial<GameSettings>): GameSettingsDocument => ({
    id: GAME_SETTINGS_DOCUMENT_ID,
    settings: normalizeGameSettings({ ...DEFAULT_GAME_SETTINGS, ...patch }),
});
const defaultDocument = () => documentWith({});

const nameField = () => screen.getByLabelText('Name');
const typeName = (name: string) => fireEvent.change(nameField(), { target: { value: name } });
const revertButton = () => screen.getByRole('button', { name: /Revert/ });

/** Clicks Save and lets the optimistic write render before the host answers. */
const save = async (outcome: 'ok' | Error = 'ok') => {
    act(() => { fireEvent.click(screen.getByRole('button', { name: /^Save/ })); });
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

describe('Game settings panel draft', () => {
    it('keeps an edited draft while a revision change re-hydrates the document', () => {
        project.document = documentWith({ name: 'Arena' });
        render(<GameSettingsPanel onClose={() => undefined} />);
        typeName('Arena Deluxe');

        // A placeholder while loading, then the stored copy again.
        act(() => project.set(defaultDocument(), false));
        act(() => project.set(documentWith({ name: 'Arena' })));
        expect(nameField()).toHaveValue('Arena Deluxe');
        expect(revertButton()).toBeEnabled();
    });

    it('keeps an edited draft when another writer changes the stored settings, until the user reverts', () => {
        project.document = documentWith({ name: 'Arena' });
        render(<GameSettingsPanel onClose={() => undefined} />);
        typeName('Arena Deluxe');

        act(() => project.set(documentWith({ name: 'Arena', quality: { ...DEFAULT_GAME_SETTINGS.quality, fov: 90 } })));
        expect(nameField()).toHaveValue('Arena Deluxe');

        fireEvent.click(revertButton());
        expect(nameField()).toHaveValue('Arena');
        expect(screen.getByLabelText('Field of view')).toHaveValue(90);

        // Unedited again, so the draft follows the store.
        act(() => project.set(documentWith({ name: 'Arena II' })));
        expect(nameField()).toHaveValue('Arena II');
    });

    it('keeps typed settings when a save fails, then shows the saved values', async () => {
        project.document = documentWith({ name: 'Arena' });
        render(<GameSettingsPanel onClose={() => undefined} />);
        typeName('  Arena Deluxe  ');

        await save(new Error('Revision conflict'));
        expect(screen.getByText('Revision conflict')).toBeInTheDocument();
        expect(nameField()).toHaveValue('  Arena Deluxe  ');

        await save();
        expect(project.writes).toHaveLength(1);
        expect((project.writes[0] as GameSettingsDocument).settings.name).toBe('Arena Deluxe');
        expect(nameField()).toHaveValue('Arena Deluxe');
        expect(revertButton()).toBeDisabled();

        // The re-hydrate that follows the write leaves the saved draft alone.
        const saved = project.document;
        act(() => project.set(defaultDocument(), false));
        act(() => project.set(saved));
        expect(nameField()).toHaveValue('Arena Deluxe');
        expect(screen.getByText('Game settings saved to the project.')).toBeInTheDocument();
    });

    it('follows the first load and discards edits on a project switch', () => {
        project.document = defaultDocument();
        project.hydrated = false;
        const view = render(<GameSettingsPanel onClose={() => undefined} />);
        act(() => project.set(documentWith({ name: 'Arena' })));
        expect(nameField()).toHaveValue('Arena');

        typeName('Arena Deluxe');
        scene.projectStatus = { projectId: 'project-2', readOnly: false };
        view.rerender(<GameSettingsPanel onClose={() => undefined} />);
        expect(nameField()).toHaveValue('Arena');

        act(() => project.set(defaultDocument(), false));
        act(() => project.set(documentWith({ name: 'Second Project' })));
        expect(nameField()).toHaveValue('Second Project');
    });
});
