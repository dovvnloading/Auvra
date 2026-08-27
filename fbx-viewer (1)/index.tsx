import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { bootstrapHostTransport } from './host/bootstrap';

// The host boundary is established before React can mount any UI. Production
// pages fail closed when they are opened outside the native frame; development
// uses the explicit FakeHost fallback in bootstrap.ts for diagnostics only.
export const hostTransport = bootstrapHostTransport();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
