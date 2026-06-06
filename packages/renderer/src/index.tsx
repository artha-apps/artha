/**
 * Renderer entry point. Mounts the React tree into the Electron BrowserWindow.
 * `StrictMode` is intentional even though it double-invokes effects in dev —
 * the IPC subscription helpers in preload.ts return idempotent unsubscribe
 * functions, so it surfaces leak bugs before they hit users.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

// Inter — self-hosted via @fontsource. Same family the landing site uses so
// the app and marketing site share typographic feel.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

// Marcellus — thin, wide-tracked Roman caps used ONLY for the brand wordmark,
// matching the landing site's lockup (landing/app/layout.tsx).
import '@fontsource/marcellus/400.css';

import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
