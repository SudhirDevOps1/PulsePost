import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { api, ApiError } from './api.ts';
import type { SessionUser } from './types.ts';
import { AppShell } from './components/AppShell.tsx';
import { AuthCard, LoginPage, type AuthState } from './pages/Auth.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { PublicStatusPage } from './pages/PublicStatus.tsx';
import { Spinner } from './components/ui.tsx';

/**
 * Routing and the session gate.
 *
 * Leaflet and Recharts are split out of the main bundle. Together they are the
 * two heaviest dependencies, and the login screen and public status page do not
 * need either — a visitor opening a shared status link should not download a
 * mapping engine.
 */
const MonitorPages = lazy(() =>
  import('./pages/Monitors.tsx').then((module) => ({
    default: module.NewMonitorPage,
  })),
);

const MonitorDetailPage = lazy(() =>
  import('./pages/Monitors.tsx').then((module) => ({
    default: module.MonitorDetailPage,
  })),
);

const GroupsPage = lazy(() =>
  import('./pages/Groups.tsx').then((module) => ({ default: module.GroupsPage })),
);

export function App() {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    void api
      .authStatus()
      .then((status) => {
        setState({
          setupComplete: status.setup_complete,
          authenticated: status.authenticated,
          user: status.user,
          appName: status.app_name,
        });
      })
      .catch((cause) => {
        // A 503 means the database is unreachable. Showing the login form would
        // be misleading, so surface the state and let the API error speak when
        // the user tries to submit.
        if (cause instanceof ApiError && cause.status === 503) {
          setState({
            setupComplete: false,
            authenticated: false,
            user: null,
            appName: 'PulsePost',
          });
        }
      });
  }, []);

  if (!state) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Public status page — deliberately outside the auth gate. */}
        <Route path="/status" element={<PublicStatusPage />} />

        <Route
          path="*"
          element={
            state.authenticated && state.user ? (
              <AppShell
                onSignOut={() =>
                  setState({ ...state, authenticated: false, user: null })
                }
              />
            ) : (
              <LoginPage
                state={state}
                onDone={(user, appName) =>
                  setState({ ...state, authenticated: true, user, appName })
                }
              />
            )
          }
        >
          <Route index element={<Dashboard />} />
          <Route
            path="monitors/new"
            element={
              <Suspense fallback={<CenteredSpinner />}>
                <MonitorPages />
              </Suspense>
            }
          />
          <Route
            path="monitors/:id"
            element={
              <Suspense fallback={<CenteredSpinner />}>
                <MonitorDetailPage />
              </Suspense>
            }
          />
          <Route
            path="groups"
            element={
              <Suspense fallback={<CenteredSpinner />}>
                <GroupsPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function CenteredSpinner() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Spinner size={22} />
    </div>
  );
}

export type { SessionUser, AuthCard };