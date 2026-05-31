/**
 * Renderer entry point. Mounts the React tree into the Electron BrowserWindow.
 * `StrictMode` is intentional even though it double-invokes effects in dev —
 * the IPC subscription helpers in preload.ts return idempotent unsubscribe
 * functions, so it surfaces leak bugs before they hit users.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Inter — self-hosted via @fontsource. Same family the landing site uses so
// the app and marketing site share typographic feel.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
