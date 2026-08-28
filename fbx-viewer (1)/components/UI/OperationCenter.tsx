import React from 'react';
import { Loader2, X } from 'lucide-react';
import { useOperationActions, useOperationViews } from '../../context/OperationContext';

export const OperationCenter: React.FC = () => {
  const operations = useOperationViews();
  const { cancelOperation } = useOperationActions();
  if (!operations.length) return null;

  return (
    <section
      aria-label="Background operations"
      aria-live="polite"
      className="fixed right-5 top-14 z-[120] flex w-[360px] flex-col gap-2 pointer-events-none"
    >
      {operations.map((operation) => {
        const percent = operation.progress === null ? null : Math.round(operation.progress * 100);
        return (
          <div key={operation.id} className="pointer-events-auto overflow-hidden rounded-md border border-blue-500/35 bg-[#15191f]/95 shadow-2xl backdrop-blur">
            <div className="flex items-start gap-3 px-4 py-3">
              <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-blue-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-xs font-semibold text-gray-100">{operation.label}</div>
                  {percent !== null && <div className="font-mono text-[10px] text-blue-300">{percent}%</div>}
                </div>
                <div className="mt-1 truncate text-[10px] text-gray-400">
                  {operation.cancelling ? 'Cancelling safely…' : operation.detail || 'Working…'}
                </div>
              </div>
              {operation.cancellable && (
                <button
                  type="button"
                  onClick={() => cancelOperation(operation.id)}
                  className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-white"
                  title="Cancel operation"
                  aria-label={`Cancel ${operation.label}`}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div
              className="h-1 bg-gray-800"
              role="progressbar"
              aria-label={operation.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent === null ? undefined : percent}
            >
              {operation.progress === null ? (
                <div className="h-full bg-blue-500 animate-progress-indeterminate" />
              ) : (
                <div className="h-full bg-blue-500 transition-[width] duration-200" style={{ width: `${operation.progress * 100}%` }} />
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
};
