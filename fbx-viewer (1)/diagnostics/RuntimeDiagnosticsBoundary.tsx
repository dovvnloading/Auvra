import React from 'react';
import { diagnosticErrorType, frontendDiagnostics } from './runtime';

interface RuntimeDiagnosticsBoundaryState {
  failed: boolean;
}

/** Last-resort React boundary. It records only stable failure metadata. */
export class RuntimeDiagnosticsBoundary extends React.Component<React.PropsWithChildren, RuntimeDiagnosticsBoundaryState> {
  state: RuntimeDiagnosticsBoundaryState = { failed: false };

  static getDerivedStateFromError(): RuntimeDiagnosticsBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    frontendDiagnostics.record('frontend', 'frontend.global_error', {
      code: 'react_render_failure',
      errorType: diagnosticErrorType(error),
    }, frontendDiagnostics.currentContext(), true);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <main className="flex h-screen w-screen items-center justify-center bg-gray-950 p-8 text-gray-100">
          <section className="max-w-lg rounded-lg border border-red-500/40 bg-gray-900 p-6">
            <h1 className="text-lg font-semibold">The editor encountered a runtime error</h1>
            <p className="mt-2 text-sm text-gray-400">
              Diagnostic details were recorded locally. Restart the editor or export a support bundle from Diagnostics.
            </p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export const RuntimeDiagnosticsProfiler: React.FC<React.PropsWithChildren<{ subsystem: string }>> = ({
  subsystem,
  children,
}) => (
  <React.Profiler
    id={subsystem}
    onRender={(_id, _phase, actualDuration) => frontendDiagnostics.recordRenderCommit(subsystem, actualDuration)}
  >
    {children}
  </React.Profiler>
);
