import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { Overview } from '../types.ts';
import { Button, StatusDot, statusColor, statusLabel } from './ui.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { usePolling } from '../hooks/usePolling.ts';

/**
 * Authenticated app shell: header, nav, live status pill, and the routed view.
 *
 * The overall status pill polls on a timer because a wall-mounted dashboard is
 * often watched, not interacted with — it has to be right without anyone
 * reloading.
 */

const POLL_MS = 30_000;

export function AppShell({ onSignOut }: { onSignOut: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  /**
   * One fetch, shared by the initial paint and the poll.
   *
   * Declared with `useCallback` so it has a stable identity: `usePolling` holds
   * the callback in a ref precisely so it can be an inline arrow, and hoisting it
   * out of the effect is what lets both the first load and the interval use the
   * same function instead of two copies that could drift.
   */
  const load = useCallback(async () => {
    try {
      const { overview: next } = await api.overview();
      setOverview(next);
    } catch {
      // A failed poll must not blank the dashboard; keep the last good value
      // and let the next tick recover.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The status pill renders on every page, so this is the most frequently
  // triggered poll in the app. `usePolling` suspends it while the tab is hidden
  // rather than quietly spending the free allowance overnight.
  usePolling(load, POLL_MS);

  const overall = overallStatus(overview);

  /**
   * Sign out.
   *
   * Clearing the server session is not enough on its own: the app-level auth
   * state must flip too, otherwise the shell stays mounted and keeps polling an
   * endpoint that now answers 401 forever.
   */
  async function signOut() {
    await api.logout().catch(() => undefined);
    onSignOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 bg-[var(--color-surface-0)]/85 backdrop-blur-xl">
        {/* Clay: the header is one continuous bar with a soft underside, not a
            bordered strip. The shadow replaces the border so it still separates
            from content scrolling underneath. */}
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6" style={{ boxShadow: '0 6px 18px -12px rgb(146 162 197 / 0.5)' }}>
          <NavLink to="/" className="flex shrink-0 items-center gap-2.5">
            <Logo />
            <span className="hidden text-base font-extrabold tracking-tight sm:inline">PulsePost</span>
          </NavLink>

          {/*
            The desktop nav is `lg:` and not `sm:`.

            With eight items it needs roughly 640px of its own; showing it from
            640px up pushed the header past the viewport and made the whole page
            scroll sideways. Everything below `lg` uses the Menu button instead,
            which is also the honest breakpoint for eight targets.
          */}
          <nav className="hidden items-center gap-0.5 lg:flex xl:gap-1" aria-label="Main">
            <NavItem to="/">Dashboard</NavItem>
            <NavItem to="/monitors/new">Add monitor</NavItem>
            <NavItem to="/groups">Groups</NavItem>
            <NavItem to="/incidents">Incidents</NavItem>
            <NavItem to="/channels">Alerts</NavItem>
            <NavItem to="/team">Team</NavItem>
            <NavItem to="/settings">Settings</NavItem>
            <NavItem to="/status">Status page</NavItem>
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {/*
              The overview pill waits for `xl`, not `lg`.

              At exactly 1024 the nav comes online at the same moment this pill
              would, and the two together overrun the header by ~18px -- which
              pushes the whole document into horizontal scroll on every page.
              The pill is the right thing to give up: it is a summary of what
              /incidents and /status already say in full, and its title
              attribute keeps the counts reachable on hover.
            */}
            {overview ? (
              <span
                className="hidden items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--color-surface-1)] px-3.5 py-2 text-xs font-bold xl:inline-flex"
                style={{ color: statusColor(overall), boxShadow: 'var(--shadow-pill)' }}
                title={`${overview.up} up · ${overview.degraded} degraded · ${overview.down} down`}
              >
                <StatusDot status={overall} size={9} pulse={false} />
                <span>{statusLabel(overall)}</span>
              </span>
            ) : null}

            <ThemeToggle />

            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="pressable rounded-md px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] lg:hidden"
              aria-expanded={menuOpen}
            >
              Menu
            </button>

            <Button size="sm" variant="ghost" onClick={signOut} className="hidden lg:inline-flex">
              Sign out
            </Button>
          </div>
        </div>

        {menuOpen ? (
          <nav className="flex flex-col gap-1 border-t border-[var(--color-border-subtle)] px-4 py-2 lg:hidden">
            <NavItem to="/">Dashboard</NavItem>
            <NavItem to="/monitors/new">Add monitor</NavItem>
            <NavItem to="/groups">Groups</NavItem>
            <NavItem to="/incidents">Incidents</NavItem>
            <NavItem to="/channels">Alerts</NavItem>
            <NavItem to="/team">Team</NavItem>
            <NavItem to="/settings">Settings</NavItem>
            <NavItem to="/status">Status page</NavItem>
            <button
              type="button"
              onClick={signOut}
              className="rounded-lg px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              Sign out
            </button>
          </nav>
        ) : null}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>

      <Footer />
    </div>
  );
}

/**
 * Where the code is, and who wrote it.
 *
 * An open-source project that is deployed under someone else's `workers.dev`
 * should say so on the running product, not only in the repository. This is the
 * only surface every authenticated user is guaranteed to see, and it is what
 * makes the licence and the source reachable from a deployment that has no
 * other link back.
 */
function Footer() {
  return (
    <footer className="mt-4 border-t border-[var(--color-border-subtle)] px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 text-xs text-[var(--color-text-tertiary)] sm:flex-row sm:items-center">
        <p>
          <span className="font-bold text-[var(--color-text-secondary)]">PulsePost</span>
          {' — '}self-hosted uptime monitoring on Cloudflare Workers.{' '}
          <span className="ml-1">MIT licensed.</span>
        </p>

        <nav aria-label="Project links" className="flex items-center gap-4">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="pressable inline-flex items-center gap-1.5 font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-accent-text)]"
          >
            <GitHubIcon />
            Source
          </a>
          <a
            href={`${REPO_URL}/issues`}
            target="_blank"
            rel="noreferrer noopener"
            className="pressable font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-accent-text)]"
          >
            Report an issue
          </a>
        </nav>
      </div>
    </footer>
  );
}

const REPO_URL = 'https://github.com/SudhirDevOps1/PulsePost';

function GitHubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `pressable rounded-[var(--radius-pill)] px-3.5 py-1.5 text-sm transition-all ${
          isActive
            ? 'bg-[var(--color-surface-1)] font-bold text-[var(--color-text-primary)] shadow-[var(--shadow-pill)]'
            : 'font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * Logo mark: three edge nodes converging on a pulse line.
 * Inline SVG so it needs no network request and inherits currentColor.
 */
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="4" cy="6" r="2" fill="var(--color-up)" />
      <circle cx="4" cy="18" r="2" fill="var(--color-up)" />
      <circle cx="20" cy="12" r="2" fill="var(--color-accent)" />
      <path
        d="M6 6.5h3a2 2 0 0 1 2 2v7a2 2 0 0 0 2 2h3.5M6 17.5h3a2 2 0 0 0 2-2v-7a2 2 0 0 1 2-2h3.5"
        stroke="var(--color-text-tertiary)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function overallStatus(overview: Overview | null) {
  if (!overview) return null;
  if (overview.down > 0) return 'down' as const;
  if (overview.degraded > 0) return 'degraded' as const;
  if (overview.total === 0) return null;
  return 'up' as const;
}

export { ApiError };