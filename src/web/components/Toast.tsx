import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Spinner } from './ui.tsx';

/**
 * Toasts.
 *
 * Why this exists: every save in this app used to be a silent success or an
 * inline `ErrorNote` that only appears on failure. That is a genuinely bad
 * contract — the user cannot tell "saved" from "the request never left", and
 * the failure case is the only one that gets any attention at all. A toast
 * confirms the boring outcome and leaves the error path for errors.
 *
 * Deliberately not a library: the whole thing is ~150 lines and a context, and
 * adding a dependency for it would cost more bundle than it saves.
 */

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
  /** Optional single action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /** ms. Errors stay longer — they carry something to read. */
  duration: number;
}

interface ToastApi {
  success: (message: string, action?: Toast['action']) => void;
  error: (message: string, action?: Toast['action']) => void;
  info: (message: string, action?: Toast['action']) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, action?: Toast['action']) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const duration = tone === 'error' ? 7000 : tone === 'info' ? 4000 : 3000;

      setToasts((current) => {
        // Cap the stack. Three is enough to see; more just covers the UI, and
        // an unattended burst of failures is usually one root cause reported
        // repeatedly rather than three separate things going wrong.
        const next = [...current, { id, tone, message, action, duration }];
        return next.slice(-3);
      });

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  // Clear any pending timers if the provider unmounts mid-flight, or they will
  // fire against an unmounted tree.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, action) => push('success', message, action),
      error: (message, action) => push('error', message, action),
      info: (message, action) => push('info', message, action),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    // Throwing here would mean the app is blank with no explanation, which is a
    // worse failure than a silently missing confirmation.
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}

/**
 * `ring` rather than a border.
 *
 * An inset ring sits *inside* the shape, so it reads as a coloured edge on the
 * clay rather than a line drawn around it — which is how a real clay object
 * would be tinted at the rim.
 */
const TONE_STYLE: Record<ToastTone, { ring: string; icon: ReactNode }> = {
  success: { ring: 'color-mix(in srgb, var(--color-up) 26%, transparent)', icon: <CheckIcon /> },
  error: { ring: 'color-mix(in srgb, var(--color-down) 30%, transparent)', icon: <AlertIcon /> },
  info: { ring: 'color-mix(in srgb, var(--color-accent) 24%, transparent)', icon: <Spinner size={14} /> },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      // `aria-live="polite"` rather than `assertive`: a success confirmation
      // should not interrupt a screen reader mid-sentence. Errors are frequent
      // enough that they would make the app unusable at that priority.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[1000] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className="toast-enter pointer-events-auto flex items-start gap-3 rounded-[var(--radius-tile)] bg-[var(--color-surface-1)] px-4 py-3 text-sm font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-pop)]"
          style={{ boxShadow: 'var(--shadow-pop), inset 0 0 0 2px ' + TONE_STYLE[toast.tone].ring }}
        >
          <span className="mt-0.5 shrink-0">{TONE_STYLE[toast.tone].icon}</span>

          <span className="min-w-0 flex-1">{toast.message}</span>

          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="pressable shrink-0 text-xs font-medium text-[var(--color-accent-text)] hover:opacity-80"
            >
              {toast.action.label}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            className="pressable shrink-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--color-up)' }} aria-hidden="true">
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--color-down)' }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}