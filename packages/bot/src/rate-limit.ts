export interface RateRule { max: number; windowMs: number }

/**
 * Per-user request budgets by command class. `buy` stays generous so a real
 * purchase is never blocked; the cheap/spammable classes are tighter.
 */
export const RATE_LIMITS = {
  buy: { max: 1, windowMs: 1_000 },      // ~1 buy/sec
  preview: { max: 1, windowMs: 5_000 },  // link → Playwright, expensive
  light: { max: 5, windowMs: 10_000 },   // /help, /balance, /orders, admin…
} as const;

export type RateClass = keyof typeof RATE_LIMITS;

/** Map an incoming update to its rate-limit class. */
export function classifyUpdate(ctx: any): RateClass {
  const data = ctx?.callbackQuery?.data;
  if (typeof data === 'string') return data.startsWith('buy:') ? 'buy' : 'light';
  const text = ctx?.message?.text;
  if (typeof text === 'string' && !text.startsWith('/')) return 'preview';
  return 'light';
}

/** In-memory sliding-window limiter keyed by `${userId}:${class}`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number) {}

  /** Records and allows the hit, or returns false when over the limit. */
  allow(key: string, rule: RateRule): boolean {
    const t = this.now();
    const cutoff = t - rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= rule.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
