import type { Db } from '../connection.ts';

/** Structurally compatible with @arhip/core's PricingConfig (no cross-dep). */
export interface PricingValues {
  rubPerJpy: number;
  markup: number;
  planFeeJpy: number;
}

/** The three tunable pricing keys, shared by the global and per-user stores. */
export type PricingKey = 'rate' | 'markup' | 'fee';
/** Per-user overrides that are actually set (absent keys inherit the global). */
export type UserOverrides = Partial<Record<PricingKey, number>>;

/**
 * Small key/value store for runtime-tunable config. Pricing overrides live
 * under the keys `rate`, `markup`, `fee`; `getPricing` layers them over the
 * env-derived defaults so admins can retune prices without a redeploy.
 */
export class SettingsRepo {
  constructor(private db: Db, private now: () => string) {}

  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return r ? (r.value as string) : null;
  }

  set(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, this.now());
  }

  /** Effective pricing = stored overrides layered over `defaults`. */
  getPricing(defaults: PricingValues): PricingValues {
    const num = (key: string, def: number): number => {
      const v = this.get(key);
      if (v === null) return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    return {
      rubPerJpy: num('rate', defaults.rubPerJpy),
      markup: num('markup', defaults.markup),
      planFeeJpy: num('fee', defaults.planFeeJpy),
    };
  }

  /** Set a per-user pricing override (rate/markup/fee) for one telegram_id. */
  setUser(telegramId: number, key: PricingKey, value: string): void {
    this.db.prepare(
      `INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(telegramId, key, value, this.now());
  }

  /** Drop a per-user override so the user falls back to the global value. */
  clearUser(telegramId: number, key: PricingKey): void {
    this.db.prepare('DELETE FROM user_settings WHERE telegram_id = ? AND key = ?').run(telegramId, key);
  }

  /** The per-user overrides actually set (non-numeric values are ignored). */
  getUserOverrides(telegramId: number): UserOverrides {
    const rows = this.db
      .prepare('SELECT key, value FROM user_settings WHERE telegram_id = ?')
      .all(telegramId) as { key: PricingKey; value: string }[];
    const out: UserOverrides = {};
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n)) out[r.key] = n;
    }
    return out;
  }

  /** Effective pricing for one user = global effective ⊕ that user's overrides. */
  getPricingFor(telegramId: number, defaults: PricingValues): PricingValues {
    const global = this.getPricing(defaults);
    const ov = this.getUserOverrides(telegramId);
    return {
      rubPerJpy: ov.rate ?? global.rubPerJpy,
      markup: ov.markup ?? global.markup,
      planFeeJpy: ov.fee ?? global.planFeeJpy,
    };
  }
}
