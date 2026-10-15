CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  balance_rub INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_txns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
  delta_rub   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref         TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  mercari_url TEXT NOT NULL,
  price_jpy   INTEGER NOT NULL,
  cost_rub    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  run_id      TEXT,
  created_at  TEXT NOT NULL
);
-- idempotency only on SUCCESSFUL purchases; failed attempts may be retried
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_bought
  ON purchases(mercari_url) WHERE status = 'bought';
-- runtime-tunable key/value config (e.g. pricing overrides: rate/markup/fee)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Per-user pricing overrides. Same keys as `settings` (rate/markup/fee) but
-- scoped to one telegram_id: absence of a row means "inherit the global value".
-- Layered on top of the global effective pricing (see SettingsRepo.getPricingFor).
CREATE TABLE IF NOT EXISTS user_settings (
  telegram_id INTEGER NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (telegram_id, key)
);
-- Refund requests: a failed/ambiguous buy does NOT auto-refund. The hold stays
-- debited and a pending request is created; an admin approves (→ refund) or
-- rejects (→ money kept). reconcileHolds must NOT sweep a hold retained by a
-- pending/rejected request here, or it would undo the admin gate.
CREATE TABLE IF NOT EXISTS refund_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  mercari_url TEXT NOT NULL,
  kopecks     INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  run_id      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_refund_requests_pending
  ON refund_requests(status) WHERE status = 'pending';
