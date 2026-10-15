import type { PricingConfig } from '@arhip/core';

export interface BotConfig { token: string; sqlitePath: string; pricing: PricingConfig; adminIds: number[] }

export function loadBotConfig(env = process.env): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  return {
    token,
    sqlitePath: env.SQLITE_PATH ?? 'data/app.db',
    pricing: {
      // Default RUB cost = (priceJPY + 400) × 0.68 (no extra markup).
      rubPerJpy: Number(env.RUB_PER_JPY ?? '0.68'),
      markup: Number(env.MARKUP ?? '0'),
      planFeeJpy: Number(env.PLAN_FEE_JPY ?? '400'),
    },
    adminIds: (env.TELEGRAM_ADMIN_IDS ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean),
  };
}
