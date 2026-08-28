import { useCallback, useEffect, useRef, useState } from 'react';
import { projectService } from './projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';

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
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const writeSequence = useRef(0);

  useEffect(() => projectService.subscribe((status) => {
    setProjectId(status.projectId);
  }), []);

  useEffect(() => {
    let cancelled = false;
    const span = frontendDiagnostics.startSpan('project_document', 'hydrate', {
      category: 'project_read', detailedOnly: true,
    });
    setHydrated(false);
    setError(null);
    setDocument(createDefault());

    if (!projectId) {
      setHydrated(true);
      span.finish('success');
      return () => { cancelled = true; };
    }

    void projectService.getSnapshotAll(domain, span.context).then((snapshot) => {
      if (cancelled) return;
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
      setDocument(loaded ? loaded : createDefault());
      setHydrated(true);
      span.finish('success');
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause : new Error('Project document could not be hydrated'));
      setHydrated(true);
      span.fail(cause);
      span.finish('failure');
    });

    return () => {
      cancelled = true;
      span.finish('cancelled');
    };
  }, [domain, documentId, projectId, createDefault, refreshToken]);

  const replace = useCallback(async (next: T): Promise<void> => {
    const span = frontendDiagnostics.startSpan('project_document', 'replace', { category: 'project_write' });
    try {
      projectService.assertWritable();
      if (next.id !== documentId) throw new Error(`The ${domain} document id is immutable`);
      setError(null);
      // Update in place so the editor remains responsive while the host commits.
      const previous = document;
      const sequence = ++writeSequence.current;
      setDocument(next);
      const write = writeQueue.current.then(async () => {
        await projectService.applyChanges(
          [{ domain, operation: 'upsert', id: documentId, value: next }],
          span.context,
        );
      });
      // Keep the queue alive after a failed write so a later user edit can
      // recover instead of inheriting a rejected promise forever.
      writeQueue.current = write.catch(() => undefined);
      try { await write; }
      catch (cause: unknown) {
        const failure = cause instanceof Error ? cause : new Error('Project document could not be saved');
        if (sequence === writeSequence.current) setDocument(previous);
        setError(failure);
        throw failure;
      }
      span.finish('success');
    } catch (cause) {
      span.fail(cause);
      span.finish('failure');
      throw cause;
    }
  }, [document, domain, documentId]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  return { document, hydrated, error, replace, refresh };
}
