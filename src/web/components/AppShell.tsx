import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api.ts';
import type { Overview } from '../types.ts';
import { Button, StatusDot, statusColor, statusLabel } from './ui.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

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

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { overview: next } = await api.overview();
        if (!cancelled) setOverview(next);
      } catch {
        // A failed poll must not blank the dashboard; keep the last good value
        // and let the next tick recover.
      }
    };

    void load();
    const timer = setInterval(load, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
    </div>
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