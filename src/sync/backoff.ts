/**
 * Pure exponential-backoff helper. `nextDelay(prev)` returns the next
 * delay in ms, capped at MAX_BACKOFF_MS. The watcher uses this when an
 * IMAP or Drive operation fails inside a tick, so each retry waits a
 * little longer up to the cap.
 *
 * Pure; no setTimeout. Callers compose the delay with their own timers.
 */

export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
export const BACKOFF_FACTOR = 2;

export const nextBackoff = (prevMs: number | null): number => {
  if (prevMs === null) return INITIAL_BACKOFF_MS;
  const next = prevMs * BACKOFF_FACTOR;
  return next > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : next;
};

/**
 * Clamp a configured tick interval to the spec floor of 60s. Used by
 * the watcher; not the backoff helper itself.
 */
export const MIN_TICK_INTERVAL_MS = 60_000;
export const clampTickInterval = (ms: number): number =>
  ms < MIN_TICK_INTERVAL_MS ? MIN_TICK_INTERVAL_MS : ms;
