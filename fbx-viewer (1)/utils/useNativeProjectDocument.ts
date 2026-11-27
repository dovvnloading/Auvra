import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { projectService } from './projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, type EditorSessionLease } from './editorSession';

/**
 * A small React adapter for one authored project document.
 *
 * The host is the only authority. This hook deliberately has no browser
 * persistence fallback: an unopened project has an in-memory editing value,
 * while every mutation requires the native project to be writable.
 */
export interface NativeProjectDocumentState<T extends { id: string }> {
  document: T;
  /** True only after a confirmed read, or for the non-persistable no-project preview. */
  hydrated: boolean;
  error: Error | null;
  replace: (next: T) => Promise<void>;
  refresh: () => void;
}

/** Which stored document a value belongs to. Revisions are not part of it. */
const documentIdentity = (domain: string, documentId: string, projectId: string | null): string => (
  JSON.stringify([domain, documentId, projectId])
);

interface DocumentReadAttempt {
  identity: string;
  session: EditorSessionLease;
  refreshToken: number;
}

interface ConfirmedDocumentRead {
  attempt: DocumentReadAttempt;
  kind: 'loaded' | 'absent' | 'unopened';
}

const sameContent = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};

export function useNativeProjectDocument<T extends { id: string }>(
  domain: string,
  documentId: string,
  createDefault: () => T,
): NativeProjectDocumentState<T> {
  const [document, setDocument] = useState<T>(() => createDefault());
  const [projectId, setProjectId] = useState<string | null>(() => projectService.getStatus().projectId);
  const [confirmedRead, setConfirmedRead] = useState<ConfirmedDocumentRead | null>(null);
  const activeRead = useRef<DocumentReadAttempt | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const sessionSnapshot = useSyncExternalStore(
    editorSession.subscribe,
    editorSession.getSnapshot,
    editorSession.getSnapshot,
  );
  const identity = documentIdentity(domain, documentId, projectId);
  const hydrated = confirmedRead !== null
    && confirmedRead.attempt.identity === identity
    && confirmedRead.attempt.session === sessionSnapshot
    && confirmedRead.attempt.refreshToken === refreshToken;
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const writeSequence = useRef(0);
  // The identity `document` currently describes. A revision bump, session
  // re-lease or refresh re-hydrates the same document, and the hook keeps
  // returning it meanwhile: editors copy `document` into drafts, so a
  // placeholder default here would wipe the user's data. Only the first load
  // or a project/document switch starts from the default.
  const shownIdentity = useRef(documentIdentity(domain, documentId, projectId));

  useEffect(() => projectService.subscribe((status) => {
    setProjectId(status.projectId);
  }), []);

  // Invalidate old callbacks at commit, before the newly selected editor can accept input.
  useLayoutEffect(() => {
    const attempt: DocumentReadAttempt = { identity, session: sessionSnapshot, refreshToken };
    activeRead.current = attempt;
    const controller = new AbortController();
    const invalidate = () => {
      if (activeRead.current === attempt) activeRead.current = null;
      controller.abort();
    };
    let finished = false;
    const lease = projectId
      ? (sessionSnapshot.phase === 'ready' ? sessionSnapshot : null)
      : null;
    const generation = sessionSnapshot.generation;
    const isCurrent = () => {
      const status = projectService.getStatus();
      const session = editorSession.getSnapshot();
      return activeRead.current === attempt
        && status.projectId === projectId
        && status.revision === (lease?.revision ?? status.revision)
        && session.generation === generation
        && (!projectId || (Boolean(lease) && editorSession.isCurrent(lease)));
    };
    const span = frontendDiagnostics.startSpan('project_document', 'hydrate', {
      category: 'project_read', detailedOnly: true,
    });
    const unsubscribeSession = editorSession.subscribe(() => {
      if (!isCurrent()) invalidate();
    });
    const unsubscribeProject = projectService.subscribe((status) => {
      if (status.projectId !== projectId || (lease && status.revision !== lease.revision)) invalidate();
    });
    const finish = (outcome: 'success' | 'failure' | 'cancelled') => {
      if (finished) return;
      finished = true;
      span.finish(outcome);
    };
    setConfirmedRead(null);
    setError(null);
    if (shownIdentity.current !== identity) {
      shownIdentity.current = identity;
      setDocument(createDefault());
    }

    if (!projectId) {
      setConfirmedRead({ attempt, kind: 'unopened' });
      finish('success');
      return () => { invalidate(); unsubscribeSession(); unsubscribeProject(); };
    }

    if (!lease || lease.projectId !== projectId || !isCurrent()) {
      finish('cancelled');
      return () => { invalidate(); unsubscribeSession(); unsubscribeProject(); };
    }

    void projectService.getSnapshotAll(domain, span.context).then((snapshot) => {
      if (controller.signal.aborted || !isCurrent()) return;
      if (!snapshot || snapshot.projectId !== lease.projectId || snapshot.revision !== lease.revision || snapshot.hasMore === true) {
        throw new Error('The project document snapshot was unavailable, incomplete or out of date. Reload before editing.');
      }
      const values = snapshot.domains?.[domain];
      // getSnapshotAll normalizes native domain pages and the in-memory host's
      // domain-filtered flat pages. A missing or malformed list is not absence.
      const documents = Array.isArray(values)
        ? values
        : values && typeof values === 'object' && Array.isArray((values as { documents?: unknown[] }).documents)
          ? (values as { documents: unknown[] }).documents
          : (!snapshot.domains || Object.keys(snapshot.domains).length === 0) && Array.isArray(snapshot.documents)
            ? snapshot.documents
            : null;
      if (!documents || documents.some(candidate => !candidate || typeof candidate !== 'object'
        || typeof (candidate as { id?: unknown }).id !== 'string')) {
        throw new Error('The project document list could not be read. Reload before editing.');
      }
      const loaded = documents.find((candidate): candidate is T => (
        Boolean(candidate) && typeof candidate === 'object' &&
        (candidate as { id?: unknown }).id === documentId
      ));
      if (controller.signal.aborted || !isCurrent()) return;
      const value = loaded ? loaded : createDefault();
      // Equal content keeps the current object, so the re-hydrate after every
      // write does not hand consumers a new document they would re-sync to.
      setDocument((current) => (sameContent(current, value) ? current : value));
      setConfirmedRead({ attempt, kind: loaded ? 'loaded' : 'absent' });
      finish('success');
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || !isCurrent()) return;
      setError(cause instanceof Error ? cause : new Error('Project document could not be hydrated'));
      // Retain the last available value, but never authorize a write after a failed read.
      setConfirmedRead(null);
      span.fail(cause);
      finish('failure');
    });

    return () => {
      invalidate();
      unsubscribeSession();
      unsubscribeProject();
      finish('cancelled');
    };
  }, [domain, documentId, projectId, identity, createDefault, refreshToken, sessionSnapshot]);

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
      // A stale callback must not borrow permission from a newer document or retry.
      if (!hydrated || !confirmedRead || confirmedRead.kind === 'unopened'
        || activeRead.current !== confirmedRead.attempt || !editorSession.isCurrent(confirmedRead.attempt.session)
        || statusAtStart.projectId !== projectId || statusAtStart.revision !== lease.revision) {
        throw new Error('The project document must be loaded successfully before it can be saved. Reload and try again.');
      }
      setError(null);
      // Update in place so the editor remains responsive while the host commits.
      const previous = document;
      const sequence = ++writeSequence.current;
      const generation = editorSession.getSnapshot().generation;
      const isCurrent = () => {
        const status = projectService.getStatus();
        const session = editorSession.getSnapshot();
        return activeRead.current === confirmedRead.attempt
          && status.projectId === projectId
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
  }, [document, domain, documentId, projectId, hydrated, confirmedRead]);

  const refresh = useCallback(() => {
    // Revocation is synchronous, including calls made before React renders.
    activeRead.current = null;
    setConfirmedRead(null);
    setRefreshToken((value) => value + 1);
  }, []);
  return { document, hydrated, error, replace, refresh };
}
