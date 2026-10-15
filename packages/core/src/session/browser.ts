// Pure helpers for the warm-browser session lifecycle. Kept free of Playwright
// so they can be unit-tested; the browser plumbing that consumes them lives in
// session.ts and is exercised by the integration suite.

/**
 * Resource types the automation never reads and that only waste the narrow
 * SOCKS tunnel. Blocking images/media/fonts is safe: we drive the purchase
 * form via field values and clicks, not visuals. Stylesheets are deliberately
 * NOT blocked (cheap over the tunnel, avoids layout-dependent selector risk).
 */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

export function shouldBlockResource(resourceType: string): boolean {
  return BLOCKED_RESOURCE_TYPES.has(resourceType);
}

export interface WarmState {
  /** browser?.isConnected() ?? false */
  connected: boolean;
  /** whether a context currently exists */
  hasContext: boolean;
  /** storageState mtime captured when the context was built, or null */
  builtMtimeMs: number | null;
}

/**
 * Decide whether the warm browser+context must be torn down and rebuilt.
 * Rebuild when the process died, when there is no context yet, or when the
 * storage state changed on disk (a session re-import via /session/import).
 */
export function needsRebuild(state: WarmState, fileMtimeMs: number): boolean {
  return !state.connected || !state.hasContext || state.builtMtimeMs !== fileMtimeMs;
}

/** Greppable one-line timing log, mirroring formatBuyLog's `timing key=val` style. */
export function formatTiming(label: string, ms: number): string {
  return `timing ${label}=${Math.round(ms)}ms`;
}

/**
 * Wrap an async operation with a wall-clock timing log. Logs on BOTH success and
 * failure (finally), so slow/failed ops are visible too. Returns the op's value
 * or rethrows its error unchanged.
 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    console.log(formatTiming(label, performance.now() - t0));
  }
}

export interface ParkedSlot {
  key: string;
  expiresAt: number;
}

/**
 * A parked preview page is reusable for a buy only when one exists, its key
 * matches, and it has not expired. Any miss falls back to a fresh navigation.
 */
export function parkedHit(parked: ParkedSlot | null, key: string, now: number): boolean {
  return parked != null && parked.key === key && parked.expiresAt > now;
}
