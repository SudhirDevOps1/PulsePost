import { useEffect, useState } from 'react';

import {
  applyTheme,
  onThemeChange,
  readPreference,
  setPreference,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '../theme.ts';

/**
 * Theme switch.
 *
 * Three-state, shown as a cycling button rather than a select: it is a control
 * most people touch once or twice ever, and a dropdown costs more space to
 * explain than it saves. The cycle order — light → dark → system — puts the
 * two explicit choices first and buries the least-used one.
 *
 * The icon reflects the *resolved* theme, not the preference. A user on
 * `system` in a dark OS should still see a sun in the button: the button
 * describes what clicking will do, not what is stored.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [preference, setLocalPreference] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    const stored = readPreference();
    setLocalPreference(stored);
    // Adopt whatever the bootstrap script already applied, rather than
    // re-applying and risking a mismatch mid-hydration.
    setResolved(
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    );

    const stopWatching = watchSystemTheme();
    const unsubscribe = onThemeChange(setResolved);
    return () => {
      stopWatching();
      unsubscribe();
    };
  }, []);

  function cycle() {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(preference) + 1) % order.length]!;
    setPreference(next);
    setLocalPreference(next);
    applyTheme(next);
  }

  const label =
    preference === 'system'
      ? `Theme: following system (${resolved})`
      : `Theme: ${preference}`;

  return (
    <button
      type="button"
      onClick={cycle}
      title={label}
      aria-label={label}
      className={`pressable inline-flex h-8 w-8 items-center justify-center rounded-[--radius-control] text-[--color-text-secondary] hover:bg-[--color-surface-2] hover:text-[--color-text-primary] ${className}`}
    >
      {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}