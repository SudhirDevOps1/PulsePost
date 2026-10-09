import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { watchSystemTheme } from './theme.ts';
import './styles/tokens.css';

/**
 * Client entry point.
 *
 * The frontend is a single-page app served from the same Worker as the API, so
 * there is no cross-origin request and no CORS preflight in the normal path.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

/**
 * Keeps `data-theme` in sync with the OS.
 *
 * Mounted at the root rather than inside a page so it also covers the public
 * status page, which renders outside the authenticated shell.
 */
function SystemThemeWatcher() {
  useEffect(() => watchSystemTheme(), []);
  return null;
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <SystemThemeWatcher />
      <App />
    </ToastProvider>
  </StrictMode>,
);