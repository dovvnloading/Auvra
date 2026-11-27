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
        readError: null as Error | null,
        snapshotOverride: undefined as unknown,
        writes: [] as Array<{ domain: string; id: string; value: unknown }>,
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
            if (host.readError) throw host.readError;
            return host.snapshotOverride === undefined ? host.snapshot(domain) : host.snapshotOverride;
        },
        assertWritable: () => undefined,
        applyChanges: async (changes: Array<{ domain: string; id: string; value: unknown }>) => {
            for (const change of changes) {
                host.writes.push(change);
                host.documents[change.domain] = [
                    ...(host.documents[change.domain] ?? []).filter(doc => (doc as TestDocument).id !== change.id),
                    change.value,
                ];
            }
        },
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
    host.readError = null;
    host.snapshotOverride = undefined;
    host.writes = [];
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

describe('native project document read authorization', () => {
    it('blocks writes after an initial failed read and allows retry without destroying saved content', async () => {
        host.readError = new Error('Read unavailable');
        const { result, unmount } = mount();
        const beforeRead = result.current.replace;
        await waitFor(() => expect(result.current.error?.message).toBe('Read unavailable'));
        expect(result.current.hydrated).toBe(false);
        const failedReplace = result.current.replace;
        await act(async () => {
            await expect(failedReplace({ id: 'doc', value: 'lost' })).rejects.toThrow(/loaded successfully/);
        });
        expect(host.writes).toEqual([]);
        expect(host.documents.hud[0]).toEqual({ id: 'doc', value: 'saved' });

        host.readError = null;
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.error).toBeNull();
        expect(result.current.document.value).toBe('saved');
        await act(async () => {
            await expect(beforeRead({ id: 'doc', value: 'stale' })).rejects.toThrow();
            await expect(failedReplace({ id: 'doc', value: 'stale' })).rejects.toThrow();
            await result.current.replace({ id: 'doc', value: 'edited safely' });
        });
        expect(host.writes).toHaveLength(1);
        unmount();
        const reopened = mount();
        await waitFor(() => expect(reopened.result.current.hydrated).toBe(true));
        expect(reopened.result.current.document.value).toBe('edited safely');
    });

    it('preserves the last available document on refresh failure and revokes a captured writer immediately', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        const oldReplace = result.current.replace;
        const saved = result.current.document;
        host.readError = new Error('Refresh failed');
        await act(async () => {
            result.current.refresh();
            await expect(oldReplace({ id: 'doc', value: 'stale' })).rejects.toThrow();
        });
        await waitFor(() => expect(result.current.error?.message).toBe('Refresh failed'));
        expect(result.current.hydrated).toBe(false);
        expect(result.current.document).toBe(saved);
        expect(host.writes).toEqual([]);
    });

    it('rejects a queued write invalidated before it reaches the host', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        await act(async () => {
            const write = result.current.replace({ id: 'doc', value: 'queued' });
            result.current.refresh();
            await expect(write).rejects.toThrow();
        });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(host.writes).toEqual([]);
        expect(result.current.document.value).toBe('saved');
    });

    it('cannot reuse a receipt after switching documents and returning at the same revision', async () => {
        const { result, rerender } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        const oldReplace = result.current.replace;
        host.readError = new Error('Read unavailable');
        rerender({ id: 'other', create: createOtherDefault });
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.hydrated).toBe(false);
        await act(async () => {
            await expect(result.current.replace({ id: 'other', value: 'lost' })).rejects.toThrow();
            await expect(oldReplace({ id: 'doc', value: 'lost' })).rejects.toThrow();
        });
        host.readError = null;
        rerender({ id: 'doc', create: createDefault });
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        await act(async () => {
            await expect(oldReplace({ id: 'doc', value: 'stale' })).rejects.toThrow();
        });
        expect(host.writes).toEqual([]);
    });

    it('isolates a failed read in a replacement project even when the document id and revision match', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        const oldReplace = result.current.replace;
        host.readError = new Error('Second project read unavailable');
        act(() => {
            host.status = { projectId: 'project-2', revision: 1, readOnly: false };
            host.documents = { hud: [{ id: 'doc', value: 'second project authored' }] };
            openSession();
            host.publish();
        });
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.hydrated).toBe(false);
        await act(async () => {
            await expect(oldReplace({ id: 'doc', value: 'first project' })).rejects.toThrow();
            await expect(result.current.replace({ id: 'doc', value: 'default edit' })).rejects.toThrow();
        });
        expect(host.writes).toEqual([]);
        host.readError = null;
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('second project authored');
        expect(host.documents.hud).toEqual([{ id: 'doc', value: 'second project authored' }]);
    });

    it.each([
        ['null snapshot', null],
        ['wrong project', { projectId: 'other', revision: 1, domains: { hud: [] } }],
        ['wrong revision', { projectId: 'project-1', revision: 0, domains: { hud: [] } }],
        ['incomplete snapshot', { projectId: 'project-1', revision: 1, hasMore: true, domains: { hud: [] } }],
        ['missing domain', { projectId: 'project-1', revision: 1, domains: { metadata: [] }, documents: [] }],
        ['malformed domain', { projectId: 'project-1', revision: 1, domains: { hud: {} } }],
        ['unidentified entry', { projectId: 'project-1', revision: 1, domains: { hud: [{ value: 'unknown' }] } }],
    ])('does not infer absence from a %s', async (_label, snapshot) => {
        host.snapshotOverride = snapshot;
        const { result } = mount();
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.hydrated).toBe(false);
        await act(async () => {
            await expect(result.current.replace({ id: 'doc', value: 'lost' })).rejects.toThrow();
        });
        expect(host.writes).toEqual([]);
    });

    it.each([
        { projectId: 'project-1', revision: 1, domains: { hud: [] } },
        { projectId: 'project-1', revision: 1, domains: { hud: { documents: [] } } },
        { projectId: 'project-1', revision: 1, domains: {}, documents: [] },
    ])('allows creation only after a valid empty document list', async (snapshot) => {
        host.documents.hud = [];
        host.snapshotOverride = snapshot;
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('default');
        await act(async () => {
            await result.current.replace({ id: 'doc', value: 'new document' });
        });
        expect(host.writes).toHaveLength(1);
        expect(host.documents.hud).toEqual([{ id: 'doc', value: 'new document' }]);
    });

    it('loads an existing document from a valid flat host snapshot rather than treating it as absent', async () => {
        host.snapshotOverride = { projectId: 'project-1', revision: 1, domains: {}, documents: host.documents.hud };
        const { result } = mount();
        await waitFor(() => expect(result.current.hydrated).toBe(true));
        expect(result.current.document.value).toBe('saved');
    });
});
