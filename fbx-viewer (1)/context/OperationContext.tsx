import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { diagnosticErrorType, frontendDiagnostics, type DiagnosticAttributes } from '../diagnostics/runtime';

export type OperationOutcome = 'success' | 'failure' | 'cancelled';

export interface OperationView {
  id: string;
  traceId: string;
  spanId: string;
  kind: string;
  phase: string;
  label: string;
  detail: string;
  progress: number | null;
  cancellable: boolean;
  cancelling: boolean;
}

interface OperationStart {
  kind: string;
  phase: string;
  label: string;
  detail?: string;
  progress?: number | null;
  cancellable?: boolean;
  diagnostic?: DiagnosticAttributes;
}

interface OperationUpdate {
  phase?: string;
  label?: string;
  detail?: string;
  progress?: number | null;
  diagnostic?: DiagnosticAttributes;
}

export interface OperationHandle {
  readonly id: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly signal: AbortSignal;
  update: (update: OperationUpdate) => void;
  lockCancellation: () => void;
  finish: (outcome: OperationOutcome, error?: unknown) => void;
}

interface OperationActions {
  startOperation: (input: OperationStart) => OperationHandle;
  cancelOperation: (id: string) => void;
}

const OperationActionsContext = createContext<OperationActions | null>(null);
const OperationViewsContext = createContext<OperationView[] | null>(null);
const OperationBusyContext = createContext(false);

const clampProgress = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
};

const progressBucket = (value: number | null): 0 | 25 | 50 | 75 | 100 | null => {
  if (value === null) return null;
  if (value >= 1) return 100;
  if (value >= 0.75) return 75;
  if (value >= 0.5) return 50;
  if (value >= 0.25) return 25;
  return 0;
};

export const OperationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [operations, setOperations] = useState<OperationView[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const startOperation = useCallback((input: OperationStart): OperationHandle => {
    const id = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const controller = new AbortController();
    const rootSpan = frontendDiagnostics.startSpan('operation', input.kind, {
      context: { traceId }, operationId: id, category: 'user_operation', detailedOnly: true,
    });
    const spanId = rootSpan.context.spanId!;
    const startedAt = performance.now();
    let currentPhase = input.phase;
    let currentProgress = clampProgress(input.progress);
    let currentBucket = progressBucket(currentProgress);
    if (input.cancellable) controllers.current.set(id, controller);
    setOperations((current) => [...current, {
      id,
      traceId,
      spanId,
      kind: input.kind,
      phase: input.phase,
      label: input.label,
      detail: input.detail || '',
      progress: clampProgress(input.progress),
      cancellable: Boolean(input.cancellable),
      cancelling: false,
    }]);
    frontendDiagnostics.record('operation', 'operation.started', {
      operationKind: input.kind,
      phase: input.phase,
      queueState: 'frontend_active',
      ...(currentBucket === null ? {} : { progressBucket: currentBucket }),
      ...(input.diagnostic ?? {}),
    }, rootSpan.context);
    let finished = false;
    return {
      id,
      traceId,
      spanId,
      signal: controller.signal,
      update: (update) => {
        if (finished) return;
        const nextPhase = update.phase ?? currentPhase;
        const nextProgress = update.progress === undefined ? currentProgress : clampProgress(update.progress);
        const nextBucket = progressBucket(nextProgress);
        if (nextPhase !== currentPhase) {
          currentPhase = nextPhase;
          currentBucket = nextBucket;
          frontendDiagnostics.record('operation', 'operation.phase', {
            operationKind: input.kind,
            phase: currentPhase,
            queueState: 'frontend_active',
            ...(currentBucket === null ? {} : { progressBucket: currentBucket }),
            ...(update.diagnostic ?? {}),
          }, rootSpan.context);
        } else if (nextBucket !== null && nextBucket !== currentBucket) {
          currentBucket = nextBucket;
          frontendDiagnostics.record('operation', 'operation.progress', {
            operationKind: input.kind,
            phase: currentPhase,
            queueState: 'frontend_active',
            progressBucket: currentBucket,
            ...(update.diagnostic ?? {}),
          }, rootSpan.context);
        }
        currentProgress = nextProgress;
        setOperations((current) => current.map((operation) => operation.id === id ? {
          ...operation,
          phase: nextPhase,
          ...(update.label === undefined ? {} : { label: update.label }),
          ...(update.detail === undefined ? {} : { detail: update.detail }),
          ...(update.progress === undefined ? {} : { progress: clampProgress(update.progress) }),
        } : operation));
      },
      lockCancellation: () => {
        if (finished) return;
        controllers.current.delete(id);
        setOperations((current) => current.map((operation) => operation.id === id
          ? { ...operation, cancellable: false, cancelling: false }
          : operation));
      },
      finish: (outcome, error) => {
        if (finished) return;
        finished = true;
        controllers.current.delete(id);
        frontendDiagnostics.record('operation', outcome === 'success'
          ? 'operation.completed'
          : outcome === 'cancelled' ? 'operation.cancelled' : 'operation.failed', {
          operationKind: input.kind,
          phase: currentPhase,
          queueState: 'completed',
          outcome,
          durationMs: performance.now() - startedAt,
          ...(outcome === 'failure' ? { code: 'operation_failed', errorType: diagnosticErrorType(error) } : {}),
        }, rootSpan.context, true);
        if (outcome === 'failure') rootSpan.fail(error);
        rootSpan.finish(outcome);
        setOperations((current) => current.filter((operation) => operation.id !== id));
      },
    };
  }, []);

  const cancelOperation = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setOperations((current) => current.map((operation) => operation.id === id
      ? { ...operation, cancellable: false, cancelling: true, detail: 'Cancelling safely…' }
      : operation));
  }, []);

  useEffect(() => {
    frontendDiagnostics.setActiveOperations(operations.length);
  }, [operations.length]);

  const actions = useMemo(() => ({ startOperation, cancelOperation }), [startOperation, cancelOperation]);
  return (
    <OperationActionsContext.Provider value={actions}>
      <OperationBusyContext.Provider value={operations.length > 0}>
        <OperationViewsContext.Provider value={operations}>{children}</OperationViewsContext.Provider>
      </OperationBusyContext.Provider>
    </OperationActionsContext.Provider>
  );
};

export const useOperationActions = (): OperationActions => {
  const value = useContext(OperationActionsContext);
  if (!value) throw new Error('useOperationActions must be used within OperationProvider');
  return value;
};

export const useOperationViews = (): OperationView[] => {
  const value = useContext(OperationViewsContext);
  if (!value) throw new Error('useOperationViews must be used within OperationProvider');
  return value;
};

export const useOperationBusy = (): boolean => useContext(OperationBusyContext);

export const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
) || (error instanceof Error && error.name === 'AbortError');
