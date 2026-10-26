import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { PlayerApp } from './PlayerApp';

// Standalone game entry: no host transport, no editor contexts, no diagnostics bridge.
createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <PlayerApp />
    </React.StrictMode>,
);
