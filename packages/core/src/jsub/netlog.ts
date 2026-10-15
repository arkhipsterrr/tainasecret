import type { NetworkEntry } from '../research/recorder.ts';

const BODY_LIMIT = 3000;

// Minimal subsets of Playwright's Request/Response we depend on — kept narrow so
// the builders can be unit-tested with plain fakes.
export interface ReqLike {
  method(): string;
  url(): string;
  resourceType(): string;
  postData(): string | null | undefined;
}

export interface RespLike {
  status(): number;
  statusText(): string;
  url(): string;
  request(): { method(): string; resourceType(): string };
}

export function requestEntry(ts: string, req: ReqLike): NetworkEntry {
  return {
    ts,
    kind: 'request',
    method: req.method(),
    url: req.url(),
    resType: req.resourceType(),
    post: req.postData()?.slice(0, BODY_LIMIT) ?? null,
  };
}

/**
 * Whether a response body is worth capturing: error responses (>=400) explain
 * failures, and every POST is the purchase submit whose body tells us what the
 * server decided. Ordinary 2xx/3xx GETs (assets, redirects) are skipped.
 */
export function shouldCaptureBody(status: number, method: string): boolean {
  return status >= 400 || method.toUpperCase() === 'POST';
}

export interface PageSignals {
  title: string;
  alert: string | null;
}

export interface SignalPageLike {
  title(): Promise<string>;
  evaluate<T>(fn: (sel: string) => T, sel: string): Promise<T>;
}

// Common containers a site uses to surface a user-facing error/flash message.
export const ALERT_SELECTOR = '.alert, .error, .flash, .message-error, [role="alert"]';

/**
 * Cheap, human-readable page diagnostics for a failed buy: the document title
 * and any visible alert/flash text. Surfaces "why" in the log line so triage
 * doesn't require opening the saved HTML artifact. Never throws.
 */
export async function readPageSignals(page: SignalPageLike): Promise<PageSignals> {
  const title = await page.title().catch(() => '');
  const alert = await page
    .evaluate((sel) => {
      const text = Array.from(document.querySelectorAll(sel))
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean)
        .join(' | ');
      return text || null;
    }, ALERT_SELECTOR)
    .catch(() => null);
  return { title, alert: alert ? alert.slice(0, 500) : null };
}

export function responseEntry(ts: string, resp: RespLike, body: string | null): NetworkEntry {
  const req = resp.request();
  return {
    ts,
    kind: 'response',
    method: req.method(),
    url: resp.url(),
    resType: req.resourceType(),
    post: null,
    status: resp.status(),
    statusText: resp.statusText(),
    respBody: body ? body.slice(0, BODY_LIMIT) : null,
  };
}
