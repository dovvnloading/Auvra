import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorSession } from '../../utils/editorSession';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';

interface TestDocument { id: string; value: string; }

const { host } = vi.hoisted(() => {
    type Status = { projectId: string | null; revision: number; readOnly: boolean };
    const host = {
        status: { projectId: 'project-1', revision: 1, readOnly: false } as Status,
        documents: {} as Record<string, unknown[]>,
        /** While true, snapshot reads wait for release(), like a slow host. */
        hold: false,
        held: [] as Array<() => void>,
        listeners: new Set<(status: Status) => void>(),
        /** Every read decodes fresh objects, like documents arriving from the native host. */
        snapshot(domain: string) {
            const documents = JSON.parse(JSON.stringify(host.documents[domain] ?? [])) as unknown[];
            return { projectId: host.status.projectId ?? undefined, revision: host.status.revision, domains: { [domain]: documents } };
        },
        release() {
            const pending = host.held.splice(0);
            pending.forEach(resolve => resolve());
        },
        publish() {
            host.listeners.forEach(listener => listener(host.getStatus()));
        },
        getStatus() {
            return { name: 'Test', dirty: false, busy: false, progress: null, recoveryAvailable: false, recoveryPoints: [], recentProjects: [], ...host.status };
        },
    };
    return { host };
});

vi.mock('../../utils/projectService', () => ({
    projectService: {
        getStatus: () => host.getStatus(),
        subscribe: (listener: (status: unknown) => void) => {
            host.listeners.add(listener);
            listener(host.getStatus());
            return () => { host.listeners.delete(listener); };
        },
        getSnapshotAll: async (domain: string) => {
            if (host.hold) await new Promise<void>(resolve => { host.held.push(resolve); });
            return host.snapshot(domain);
        },
        assertWritable: () => undefined,
        applyChanges: async () => undefined,
    },
}));

const createDefault = (): TestDocument => ({ id: 'doc', value: 'default' });
const createOtherDefault = (): TestDocument => ({ id: 'other', value: 'default' });

/** Opens a ready editor session for the host's current project and revision. */
const openSession = () => {
    const transition = editorSession.beginTransition();
    editorSession.complete(transition, host.status.projectId as string, null, host.status.revision);
};

/** A host write elsewhere: the stored documents and the project revision change together. */
const bumpRevision = (documents?: unknown[]) => {
    act(() => {
        if (documents) host.documents.hud = documents;
        host.status = { ...host.status, revision: host.status.revision + 1 };
        editorSession.advanceRevision(host.status.projectId, host.status.revision);
        host.publish();
    });
};

const mount = (documentId = 'doc', factory = createDefault) => {
    const seen: string[] = [];
    const view = renderHook(({ id, create }) => {
        const state = useNativeProjectDocument<TestDocument>('hud', id, create);
        seen.push(state.document.value);
        return state;
    }, { initialProps: { id: documentId, create: factory } });
    return { ...view, seen };
};

beforeEach(() => {
    host.status = { projectId: 'project-1', revision: 1, readOnly: false };
    host.documents = { hud: [{ id: 'doc', value: 'saved' }, { id: 'other', value: 'other saved' }] };
    host.hold = false;
    host.held = [];
    host.listeners.clear();
    openSession();
});

describe('useNativeProjectDocument re-hydration', () => {
    it('keeps returning the current document while a revision change re-hydrates it', async () => {
        const { result, seen } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('saved');

        host.hold = true;
        const before = seen.length;
        bumpRevision([{ id: 'doc', value: 'saved twice' }]);
        expect(result.current.hydrated).toBe(false);
        expect(result.current.document.value).toBe('saved');

        await act(async () => { host.release(); });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('saved twice');
        // No render during the re-hydrate handed out the default placeholder.
        expect(seen.slice(before)).not.toContain('default');
    });

    it('keeps the same document object when a re-hydrate loads equal content', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        const loaded = result.current.document;

        bumpRevision();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document).toBe(loaded);

        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document).toBe(loaded);
    });

    it('keeps the document through a same-project session re-lease (level switch)', async () => {
        const { result, seen } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));

        host.hold = true;
        const before = seen.length;
        act(() => { openSession(); });
        expect(result.current.document.value).toBe('saved');
        await act(async () => { host.release(); });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(seen.slice(before)).not.toContain('default');
    });

    it('still starts from the default for a different document or project', async () => {
        const { result, rerender } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));

        host.hold = true;
        rerender({ id: 'other', create: createOtherDefault });
        expect(result.current.document).toEqual({ id: 'other', value: 'default' });
        await act(async () => { host.release(); });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('other saved');

        act(() => {
            host.status = { projectId: 'project-2', revision: 1, readOnly: false };
            host.documents = { hud: [{ id: 'other', value: 'project two' }] };
            openSession();
            host.publish();
        });
        expect(result.current.document).toEqual({ id: 'other', value: 'default' });
        await act(async () => { host.release(); });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('project two');
    });

    it('falls back to the default when a re-hydrate finds the document removed', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));

        bumpRevision([]);
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('default');
    });
});
