import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { projectService } from './projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession } from './editorSession';

/**
 * A small React adapter for one authored project document.
 *
 * The host is the only authority. This hook deliberately has no browser
 * persistence fallback: an unopened project has an in-memory editing value,
 * while every mutation requires the native project to be writable.
 */
export interface NativeProjectDocumentState<T extends { id: string }> {
  document: T;
  hydrated: boolean;
  error: Error | null;
  replace: (next: T) => Promise<void>;
  refresh: () => void;
}

export function useNativeProjectDocument<T extends { id: string }>(
  domain: string,
  documentId: string,
  createDefault: () => T,
): NativeProjectDocumentState<T> {
  const [document, setDocument] = useState<T>(() => createDefault());
  const [projectId, setProjectId] = useState<string | null>(() => projectService.getStatus().projectId);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const sessionSnapshot = useSyncExternalStore(
    editorSession.subscribe,
    editorSession.getSnapshot,
    editorSession.getSnapshot,
  );
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const writeSequence = useRef(0);

  useEffect(() => projectService.subscribe((status) => {
    setProjectId(status.projectId);
  }), []);

  useEffect(() => {
    const controller = new AbortController();
    let finished = false;
    const lease = projectId
      ? (sessionSnapshot.phase === 'ready' ? sessionSnapshot : null)
      : null;
    const generation = sessionSnapshot.generation;
    const isCurrent = () => {
      const status = projectService.getStatus();
      const session = editorSession.getSnapshot();
      return status.projectId === projectId
        && status.revision === (lease?.revision ?? status.revision)
        && session.generation === generation
        && (!projectId || (Boolean(lease) && editorSession.isCurrent(lease)));
    };
    const span = frontendDiagnostics.startSpan('project_document', 'hydrate', {
      category: 'project_read', detailedOnly: true,
    });
    const unsubscribeSession = editorSession.subscribe(() => {
      if (!isCurrent()) controller.abort();
    });
    const unsubscribeProject = projectService.subscribe((status) => {
      if (status.projectId !== projectId || (lease && status.revision !== lease.revision)) controller.abort();
    });
    const finish = (outcome: 'success' | 'failure' | 'cancelled') => {
      if (finished) return;
      finished = true;
      span.finish(outcome);
    };
    setHydrated(false);
    setError(null);
    setDocument(createDefault());

    if (!projectId) {
      setHydrated(true);
      finish('success');
      return () => { controller.abort(); unsubscribeSession(); unsubscribeProject(); };
    }

    if (!lease) {
      finish('cancelled');
      return () => { controller.abort(); unsubscribeSession(); unsubscribeProject(); };
    }

    void projectService.getSnapshotAll(domain, span.context).then((snapshot) => {
      if (controller.signal.aborted || !isCurrent()) return;
      if (!snapshot || snapshot.projectId !== lease.projectId || snapshot.revision !== lease.revision) {
        controller.abort();
        return;
      }
      const values = snapshot?.domains?.[domain];
      const documents = Array.isArray(values)
        ? values
        : values && typeof values === 'object' && Array.isArray((values as { documents?: unknown[] }).documents)
          ? (values as { documents: unknown[] }).documents
          : [];
      const loaded = documents.find((candidate): candidate is T => (
        Boolean(candidate) && typeof candidate === 'object' &&
        (candidate as { id?: unknown }).id === documentId
      ));
      if (controller.signal.aborted || !isCurrent()) return;
      setDocument(loaded ? loaded : createDefault());
      setHydrated(true);
      finish('success');
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || !isCurrent()) return;
      setError(cause instanceof Error ? cause : new Error('Project document could not be hydrated'));
      setHydrated(true);
      span.fail(cause);
      finish('failure');
    });

    return () => {
      controller.abort();
      unsubscribeSession();
      unsubscribeProject();
      finish('cancelled');
    };
  }, [domain, documentId, projectId, createDefault, refreshToken, sessionSnapshot]);

  const replace = useCallback(async (next: T): Promise<void> => {
    const span = frontendDiagnostics.startSpan('project_document', 'replace', { category: 'project_write' });
    try {
      projectService.assertWritable();
      if (next.id !== documentId) throw new Error(`The ${domain} document id is immutable`);
      const lease = editorSession.captureReady();
      const statusAtStart = projectService.getStatus();
      if (!statusAtStart.projectId || !lease || !editorSession.isCurrent(lease)) {
        throw new Error('A native project document requires a current ready editor session.');
      }
      editorSession.requireWritable(lease, statusAtStart);
      setError(null);
      // Update in place so the editor remains responsive while the host commits.
      const previous = document;
      const sequence = ++writeSequence.current;
      const generation = editorSession.getSnapshot().generation;
      const isCurrent = () => {
        const status = projectService.getStatus();
        const session = editorSession.getSnapshot();
        return status.projectId === projectId
          && status.projectId === lease.projectId
          && status.revision === lease.revision
          && session.generation === generation
          && editorSession.isCurrent(lease);
      };
      setDocument(next);
      const write = writeQueue.current.then(async () => {
        if (!isCurrent()) throw new DOMException('Project document write was superseded.', 'AbortError');
        await projectService.applyChanges(
          [{ domain, operation: 'upsert', id: documentId, value: next }],
          span.context,
        );
        const afterWrite = projectService.getStatus();
        if (afterWrite.projectId !== lease.projectId || !editorSession.isSameSession(lease)) {
          throw new DOMException('Project document write was superseded.', 'AbortError');
        }
      });
      // Keep the queue alive after a failed write so a later user edit can
      // recover instead of inheriting a rejected promise forever.
      writeQueue.current = write.catch(() => undefined);
      try { await write; }
      catch (cause: unknown) {
        const failure = cause instanceof Error ? cause : new Error('Project document could not be saved');
        if (isCurrent() && sequence === writeSequence.current) {
          setDocument(previous);
          setError(failure);
        }
        throw failure;
      }
      span.finish('success');
    } catch (cause) {
      span.fail(cause);
      span.finish('failure');
      throw cause;
    }
  }, [document, domain, documentId, projectId, sessionSnapshot]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  return { document, hydrated, error, replace, refresh };
}
