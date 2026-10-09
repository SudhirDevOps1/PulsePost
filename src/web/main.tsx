import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';
import './styles/tokens.css';

/**
 * Client entry point.
 *
 * The frontend is a single-page app served from the same Worker as the API, so
 * there is no cross-origin request and no CORS preflight in the normal path.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);