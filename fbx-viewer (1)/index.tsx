import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { bootstrapHostTransport } from './host/bootstrap';
import { frontendDiagnostics } from './diagnostics/runtime';
import { RuntimeDiagnosticsBoundary, RuntimeDiagnosticsProfiler } from './diagnostics/RuntimeDiagnosticsBoundary';

// The host boundary is established before React can mount any UI. Production
// pages fail closed when they are opened outside the native frame; development
// uses the explicit FakeHost fallback in bootstrap.ts for diagnostics only.
frontendDiagnostics.start();
export const hostTransport = bootstrapHostTransport();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <RuntimeDiagnosticsBoundary>
      <RuntimeDiagnosticsProfiler subsystem="editor">
        <App />
      </RuntimeDiagnosticsProfiler>
    </RuntimeDiagnosticsBoundary>
  </React.StrictMode>
);
