/**
 * Theme resolution.
 *
 * Three states, and the distinction matters: `light`/`dark` are explicit user
 * choices, `system` follows the OS. Everything downstream reads `resolved`, so
 * no component ever has to ask "what does the user prefer?" — only "what is
 * showing now?".
 *
 * The initial value is applied by an inline script in `index.html` before first
 * paint. Without that, a light-mode user gets a dark flash on every navigation:
 * React has not hydrated yet, so the only thing standing between the user and
 * a black screen is a CSS variable that has to be set by *something* before the
 * stylesheet renders. `applyTheme()` is duplicated in that script deliberately —
 * it must not depend on this module having loaded.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'pulsepost.theme';

const listeners = new Set<(theme: ResolvedTheme) => void>();

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Mirror of the inline bootstrap in `index.html`. Kept byte-compatible in
 * behaviour: it must work before any module in this bundle has executed.
 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

export function readPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    // Safari in private mode throws on localStorage access. A theme that does
    // not persist is a far smaller problem than a page that will not render.
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    // `data-theme` drives the token overrides in tokens.css.
    root.setAttribute('data-theme', resolved);
    // Tells the UA to render native widgets (scrollbars, form controls) to
    // match, instead of us overriding each one by hand.
    root.style.colorScheme = resolved;
  }
  for (const listener of listeners) listener(resolved);
  return resolved;
}

export function currentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function onThemeChange(listener: (theme: ResolvedTheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Non-fatal — see readPreference().
  }
  applyTheme(preference);
}

/**
 * Begin following the OS.
 *
 * Only does anything while the preference is `system`: an explicit choice is
 * meant to outrank the OS, and quietly overriding it would be the kind of bug
 * that makes a theme toggle feel haunted.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (readPreference() === 'system') applyTheme('system');
  };
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}