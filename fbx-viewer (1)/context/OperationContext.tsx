import React, { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

export interface OperationView {
  id: string;
  label: string;
  detail: string;
  progress: number | null;
  cancellable: boolean;
  cancelling: boolean;
}

interface OperationStart {
  label: string;
  detail?: string;
  progress?: number | null;
  cancellable?: boolean;
}

interface OperationUpdate {
  label?: string;
  detail?: string;
  progress?: number | null;
}

export interface OperationHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  update: (update: OperationUpdate) => void;
  lockCancellation: () => void;
  finish: () => void;
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

export const OperationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [operations, setOperations] = useState<OperationView[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const startOperation = useCallback((input: OperationStart): OperationHandle => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    if (input.cancellable) controllers.current.set(id, controller);
    setOperations((current) => [...current, {
      id,
      label: input.label,
      detail: input.detail || '',
      progress: clampProgress(input.progress),
      cancellable: Boolean(input.cancellable),
      cancelling: false,
    }]);
    let finished = false;
    return {
      id,
      signal: controller.signal,
      update: (update) => {
        if (finished) return;
        setOperations((current) => current.map((operation) => operation.id === id ? {
          ...operation,
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
      finish: () => {
        if (finished) return;
        finished = true;
        controllers.current.delete(id);
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
