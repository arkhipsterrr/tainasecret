export type AliveReason = 'ok' | 'logged_out' | 'waf_blocked' | 'unknown';

export interface AliveSignals {
  status: number;
  finalUrl: string;
  bodyText: string;
}

/**
 * Decide session health from a fetch of an authenticated-only page.
 *
 * The old check only asked "did we get redirected to /users/login?", so a WAF
 * (SiteGuard) 403 — which does NOT redirect — was misread as a healthy login.
 * Order matters: a WAF block masquerades as My Page, so rule it out first.
 */
export function classifyAlive(s: AliveSignals): { loggedIn: boolean; reason: AliveReason } {
  if (s.status === 403 || /forbidden access|siteguard/i.test(s.bodyText)) {
    return { loggedIn: false, reason: 'waf_blocked' };
  }
  if (s.finalUrl.includes('/users/login')) {
    return { loggedIn: false, reason: 'logged_out' };
  }
  const authenticated = s.status < 400 && /my\s*page|proxy shopping|account rank/i.test(s.bodyText);
  if (authenticated) return { loggedIn: true, reason: 'ok' };
  return { loggedIn: false, reason: 'unknown' };
}
