import { useEffect, useRef } from 'react';

/**
 * Interval polling that stops while the tab is in the background.
 *
 * Why
 * ---
 * A timer keeps firing in a hidden tab, and every tick is a real request with a
 * real D1 read behind it. Someone who leaves a dashboard open overnight in a
 * background tab has generated ~1,200 requests and ~1.2M rows read for a page
 * nobody looked at -- against a free allowance of 100,000 requests and 5M rows
 * *per day*. The dashboard, the app shell's status pill, and the public status
 * page all polled unconditionally.
 *
 * Browsers already throttle timers in background tabs, to roughly once a
 * minute, but they do not stop them. Only the visibility state tells us whether
 * anyone is watching.
 *
 * Behaviour
 * ---------
 * - Poll immediately on mount, and again whenever the tab becomes visible, so
 *   returning to a stale tab shows current data rather than waiting a full
 *   interval.
 * - While hidden, no timers run at all.
 * - A tick that is already in flight when the tab hides is left to finish; it
 *   was already paid for, and cancelling the fetch mid-flight just wastes the
 *   request.
 */
export function usePolling(
  tick: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  // Held in a ref so that changing the callback identity does not restart the
  // timer on every render. An inline arrow in the caller is the normal case,
  // and re-arming the interval each render would make the interval meaningless.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      void tickRef.current();
    };

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      stop();
      timer = setInterval(run, intervalMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Catch up immediately; the alternative is showing numbers that were
        // correct when the tab was hidden.
        run();
        start();
      } else {
        stop();
      }
    };

    // A document that is already hidden on mount (a prerender, or a tab
    // restored from the background cache) must not start a timer at all.
    if (document.visibilityState !== 'hidden') {
      run();
      start();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}